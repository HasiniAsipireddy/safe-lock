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
  options: { now?: Date } = {},
): Promise<SkipReason | null> {
  if (!recipient.phoneVerifiedAt || !recipient.phone) return 'NO_VERIFIED_PHONE';
  if (!recipient.whatsappConsentAt) return 'NO_CONSENT';
  if (await isCapReached(recipient.userId, options.now)) return 'CAP_REACHED';
  return null;
}

/**
 * Whether the user's rolling 24-hour send allowance is spent.
 *
 * Counts rows that were actually **attempted** (`SENT` or `FAILED`), not
 * `SKIPPED` ones: a skip sent nothing, cost nothing, and must not consume an
 * allowance. A `PENDING` row is counted too — it is a message we have
 * committed to sending, and not counting it would let a burst slip past the
 * cap before the worker caught up.
 *
 * Rolling rather than calendar-day, so the cap cannot be reset by waiting for
 * midnight in a timezone we did not choose.
 */
export async function isCapReached(userId: string, now = new Date()): Promise<boolean> {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const used = await prisma.outboundMessage.count({
    where: {
      userId,
      createdAt: { gte: since },
      status: { in: ['PENDING', 'SENT', 'FAILED'] },
    },
  });

  return used >= env.WHATSAPP_DAILY_SEND_CAP;
}

/** How many sends remain in the current window, for user-facing copy. */
export async function remainingSends(userId: string, now = new Date()): Promise<number> {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const used = await prisma.outboundMessage.count({
    where: {
      userId,
      createdAt: { gte: since },
      status: { in: ['PENDING', 'SENT', 'FAILED'] },
    },
  });

  return Math.max(0, env.WHATSAPP_DAILY_SEND_CAP - used);
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
    where: {
      userId,
      createdAt: { gte: since },
      status: { in: ['PENDING', 'SENT', 'FAILED'] },
    },
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
  if (!input.ignoreCap && (await isCapReached(recipient.userId))) return 'CAP_REACHED';

  return null;
}

/**
 * Records the consent version the user agreed to, for an audit trail.
 *
 * Exported for the verification flow to call. Kept here beside the consent
 * check so the write and the read cannot drift.
 */
export const CURRENT_CONSENT_VERSION = WHATSAPP_CONSENT_VERSION;
