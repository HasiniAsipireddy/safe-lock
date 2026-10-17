import type { Prisma } from '@prisma/client';
import { WHATSAPP_CONSENT_VERSION, maskPhone, toE164 } from '@safelock/shared';
import { env } from '../../config/env';
import { logger } from '../logger';
import { prisma, type PrismaTransaction } from '../prisma';
import { whatsAppClient } from './index';
import { WhatsAppError, type WhatsAppErrorCategory } from './client';

/**
 * The one place that decides whether a WhatsApp message may be sent, and sends
 * it.
 *
 * Every send in the product goes through {@link sendWhatsApp}. The client
 * itself knows nothing about users, consent or caps — it takes a destination
 * and a template — so this module is where eligibility lives:
 *
 * 1. **A verified phone.** An unverified number is a number nobody has proved
 *    they control, and messaging it would mean sending someone else's unlock
 *    code to whoever was typed in at signup.
 * 2. **Consent, at a known version.** Meta requires an explicit opt-in.
 * 3. **The daily cap.** Messages cost money and land on a real phone, so an
 *    uncapped send endpoint is both a billing risk and a way to use this
 *    product to harass someone.
 *
 * A refusal is a {@link SendSkipped} outcome, not an exception: most callers
 * (alerts) should carry on regardless, and only the two that *depend* on
 * delivery (an unlock code, a verification code) turn it into an error.
 */

export type MessageKind =
  | 'UNLOCK_OTP'
  | 'PHONE_OTP'
  | 'PASSWORD_RESET'
  | 'UNLOCK_ALERT'
  | 'FAILED_ATTEMPTS_ALERT'
  // Rental lifecycle. Scheduled rather than immediate, and the only kinds
  // that carry a booking id. See `OutboundMessageKind` in the schema.
  | 'BOOKING_CONFIRMED'
  | 'BOOKING_ENDING_SOON'
  | 'OVERSTAY_STARTED'
  | 'OVERSTAY_SETTLED'
  | 'COLLECTION_CLOSING';

/**
 * The kinds that belong to a booking rather than to a device event.
 *
 * One list, used for three decisions that must not disagree: which rows are
 * re-validated before sending, which are subject to the staleness tolerance,
 * and which draw on the booking send budget instead of the user one.
 */
export const BOOKING_MESSAGE_KINDS = [
  'BOOKING_CONFIRMED',
  'BOOKING_ENDING_SOON',
  'OVERSTAY_STARTED',
  'OVERSTAY_SETTLED',
  'COLLECTION_CLOSING',
] as const satisfies readonly MessageKind[];

export type BookingMessageKind = (typeof BOOKING_MESSAGE_KINDS)[number];

export function isBookingMessageKind(kind: MessageKind): kind is BookingMessageKind {
  return (BOOKING_MESSAGE_KINDS as readonly MessageKind[]).includes(kind);
}

export type SkipReason = 'NO_VERIFIED_PHONE' | 'NO_CONSENT' | 'CAP_REACHED';

export type SendOutcome =
  | { status: 'SENT'; providerMessageId: string }
  | { status: 'SKIPPED'; reason: SkipReason }
  | { status: 'FAILED'; category: WhatsAppErrorCategory };

/** The template name configured for each kind. */
export function templateFor(kind: MessageKind): string {
  switch (kind) {
    case 'UNLOCK_OTP':
      return env.WHATSAPP_TEMPLATE_UNLOCK_OTP;
    case 'PHONE_OTP':
      return env.WHATSAPP_TEMPLATE_PHONE_OTP;
    case 'PASSWORD_RESET':
      return env.WHATSAPP_TEMPLATE_PASSWORD_RESET;
    case 'UNLOCK_ALERT':
      return env.WHATSAPP_TEMPLATE_UNLOCK_ALERT;
    case 'FAILED_ATTEMPTS_ALERT':
      return env.WHATSAPP_TEMPLATE_FAILED_ATTEMPTS;
    case 'BOOKING_CONFIRMED':
      return env.WHATSAPP_TEMPLATE_BOOKING_CONFIRMED;
    case 'BOOKING_ENDING_SOON':
      return env.WHATSAPP_TEMPLATE_BOOKING_ENDING_SOON;
    case 'OVERSTAY_STARTED':
      return env.WHATSAPP_TEMPLATE_OVERSTAY_STARTED;
    case 'OVERSTAY_SETTLED':
      return env.WHATSAPP_TEMPLATE_OVERSTAY_SETTLED;
    case 'COLLECTION_CLOSING':
      return env.WHATSAPP_TEMPLATE_COLLECTION_CLOSING;
  }
}

/** The recipient's state, as far as sending is concerned. */
export interface Recipient {
  userId: string;
  /** National or E.164; normalised here. Null when the user has no number. */
  phone: string | null;
  phoneVerifiedAt: Date | null;
  whatsappConsentAt: Date | null;
}

const RECIPIENT_SELECT = {
  id: true,
  phone: true,
  phoneVerifiedAt: true,
  whatsappConsentAt: true,
} as const;

export async function loadRecipient(
  userId: string,
  client: PrismaTransaction | typeof prisma = prisma,
): Promise<Recipient | null> {
  const user = await client.user.findUnique({
    where: { id: userId },
    select: RECIPIENT_SELECT,
  });

  if (!user) return null;

  return {
    userId: user.id,
    phone: user.phone,
    phoneVerifiedAt: user.phoneVerifiedAt,
    whatsappConsentAt: user.whatsappConsentAt,
  };
}

/**
 * Whether this user may be messaged, without sending anything.
 *
 * Exported so a caller that needs to refuse *before* doing work — issuing an
 * unlock code, say — can check first rather than generating a code and
 * throwing it away. Returns null when there is no reason to refuse.
 */
export async function reasonNotToSend(
  recipient: Recipient,
  options: { now?: Date; scope?: CapScope } = {},
): Promise<SkipReason | null> {
  if (!recipient.phoneVerifiedAt || !recipient.phone) return 'NO_VERIFIED_PHONE';
  if (!recipient.whatsappConsentAt) return 'NO_CONSENT';
  if (await isCapReached(recipient.userId, options.now, options.scope ?? 'USER')) {
    return 'CAP_REACHED';
  }
  return null;
}

/**
 * Which budget a kind draws on.
 *
 * Two budgets, not one pool and not an exemption. Booking traffic is created
 * by server-side state changes a user does not control directly, so letting it
 * share the user allowance would mean somebody's own extensions dropping their
 * own verification code. Splitting them makes the abuse protection on the
 * user-triggered half *sharper*: it now counts only what a user's action
 * produced.
 */
export type CapScope = 'USER' | 'BOOKING';

export function capScopeFor(kind: MessageKind): CapScope {
  return isBookingMessageKind(kind) ? 'BOOKING' : 'USER';
}

/**
 * What each scope counts, as a Prisma filter.
 *
 * The asymmetry is deliberate.
 *
 * **User scope** counts rows that were *attempted or committed to* — `PENDING`
 * included — because these are user-triggered and a burst must not slip past
 * the cap before the worker catches up. `SKIPPED` never counts: nothing was
 * sent and nothing cost anything.
 *
 * **Booking scope** counts only what was actually `SENT`. A rental's reminders
 * are cancelled and re-created every time the booking is extended, and a user
 * who extends four times should not find their overstay notice dropped by the
 * ghosts of reminders that were never delivered. The looseness is affordable
 * because nothing a client can call creates one of these rows.
 */
function capFilter(scope: CapScope): Prisma.OutboundMessageWhereInput {
  const kinds = [...BOOKING_MESSAGE_KINDS];

  return scope === 'BOOKING'
    ? { kind: { in: kinds }, status: 'SENT' }
    : { kind: { notIn: kinds }, status: { in: ['PENDING', 'SENT', 'FAILED'] } };
}

function capLimit(scope: CapScope): number {
  return scope === 'BOOKING' ? env.WHATSAPP_BOOKING_SEND_CAP : env.WHATSAPP_DAILY_SEND_CAP;
}

/**
 * Whether the user's rolling 24-hour allowance for this scope is spent.
 *
 * Rolling rather than calendar-day, so the cap cannot be reset by waiting for
 * midnight in a timezone we did not choose.
 */
export async function isCapReached(
  userId: string,
  now = new Date(),
  scope: CapScope = 'USER',
): Promise<boolean> {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const used = await prisma.outboundMessage.count({
    where: { userId, createdAt: { gte: since }, ...capFilter(scope) },
  });

  return used >= capLimit(scope);
}

/**
 * How many sends remain in the current window, for user-facing copy.
 *
 * The **user** budget only. This number is shown to someone waiting for a
 * verification code, and booking reminders are not theirs to spend.
 */
export async function remainingSends(userId: string, now = new Date()): Promise<number> {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const used = await prisma.outboundMessage.count({
    where: { userId, createdAt: { gte: since }, ...capFilter('USER') },
  });

  return Math.max(0, capLimit('USER') - used);
}

/**
 * When the oldest counted send in the window falls out of it — i.e. the
 * earliest time a capped user can try again.
 *
 * Returned to the user so "try later" has a number attached to it.
 */
export async function capResetsAt(userId: string, now = new Date()): Promise<Date | null> {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const oldest = await prisma.outboundMessage.findFirst({
    // The user budget, for the same reason as `remainingSends`: this is the
    // "try again at" shown to someone waiting for a code.
    where: { userId, createdAt: { gte: since }, ...capFilter('USER') },
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true },
  });

  if (!oldest) return null;
  return new Date(oldest.createdAt.getTime() + 24 * 60 * 60 * 1000);
}

export interface SendInput {
  recipient: Recipient;
  kind: MessageKind;
  /**
   * Template body parameters, in order.
   *
   * May contain a one-time code. Never logged, never stored, never attached to
   * an error — built by the caller immediately before the send and discarded
   * after it.
   */
  params: readonly string[];
  /**
   * The dynamic URL button's variable, for a template that has one.
   *
   * Built from a booking id, never from user input, and bounded by the base
   * URL Meta approved into the template. See `SendTemplateInput`.
   */
  urlButtonSuffix?: string;
  /** Skip the cap check. Only for a message the product must not drop. */
  ignoreCap?: boolean;
}

/**
 * Sends one message, subject to the three eligibility rules.
 *
 * Never throws for an ordinary failure: the outcome is returned so a caller
 * can decide what a failure means to it. A truly unexpected error (a bug)
 * still propagates.
 */
export async function sendWhatsApp(input: SendInput): Promise<SendOutcome> {
  const skip = await eligibility(input);
  if (skip) {
    logger.info(
      { kind: input.kind, userId: input.recipient.userId, reason: skip },
      'Skipped a WhatsApp message',
    );
    return { status: 'SKIPPED', reason: skip };
  }

  const to = toE164(input.recipient.phone!);
  if (!to) {
    // A stored number that no longer normalises. Not retryable.
    logger.error(
      { kind: input.kind, userId: input.recipient.userId },
      'Stored phone number is not a valid Indian mobile',
    );
    return { status: 'FAILED', category: 'INVALID_NUMBER' };
  }

  try {
    const { providerMessageId } = await whatsAppClient.sendTemplate({
      to,
      templateName: templateFor(input.kind),
      language: env.WHATSAPP_LANGUAGE,
      params: input.params,
      ...(input.urlButtonSuffix === undefined
        ? {}
        : { urlButtonSuffix: input.urlButtonSuffix }),
    });

    logger.info(
      {
        kind: input.kind,
        userId: input.recipient.userId,
        templateName: templateFor(input.kind),
        maskedPhone: maskPhone(to),
        provider: whatsAppClient.name,
      },
      'Sent a WhatsApp message',
    );

    return { status: 'SENT', providerMessageId };
  } catch (cause) {
    const category = cause instanceof WhatsAppError ? cause.category : 'UNKNOWN';

    logger.error(
      {
        kind: input.kind,
        userId: input.recipient.userId,
        category,
        maskedPhone: maskPhone(to),
      },
      'WhatsApp send failed',
    );

    return { status: 'FAILED', category };
  }
}

async function eligibility(input: SendInput): Promise<SkipReason | null> {
  const { recipient } = input;

  if (!recipient.phoneVerifiedAt || !recipient.phone) return 'NO_VERIFIED_PHONE';
  if (!recipient.whatsappConsentAt) return 'NO_CONSENT';

  // The kind picks the budget. A booking reminder can therefore never consume
  // the allowance a verification code needs, and vice versa.
  if (
    !input.ignoreCap &&
    (await isCapReached(recipient.userId, new Date(), capScopeFor(input.kind)))
  ) {
    return 'CAP_REACHED';
  }

  return null;
}

/**
 * Records the consent version the user agreed to, for an audit trail.
 *
 * Exported for the verification flow to call. Kept here beside the consent
 * check so the write and the read cannot drift.
 */
export const CURRENT_CONSENT_VERSION = WHATSAPP_CONSENT_VERSION;
