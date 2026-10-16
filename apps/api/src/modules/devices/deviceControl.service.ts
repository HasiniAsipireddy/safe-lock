import {
  ERROR_CODES,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_SECONDS,
  OTP_TTL_MS,
  type DeviceSummary,
  type LockResponse,
  type UnlockConfirmResponse,
  type UnlockFailureReason as StoredUnlockFailureReason,
  type UnlockRequestResponse,
} from '@safelock/shared';
import { prisma, type PrismaTransaction } from '../../lib/prisma';
import { HttpError, conflict } from '../../lib/httpError';
import type { SendOutcome } from '../../lib/whatsapp/send';
import { deviceGateway } from '../../lib/deviceGateway';
import { logger } from '../../lib/logger';
import { notifier } from '../../lib/notifier';
import { userHasPaid } from '../users/user.mapper';
import { DEVICE_SUMMARY_SELECT, toDeviceSummary } from './device.mapper';
import { deliverOtp, generateOtp, hashOtp, verifyOtp } from './otp.service';

/**
 * Lock and unlock.
 *
 * Three invariants hold throughout this module:
 *
 * 1. **Eligibility is re-derived on every call** by {@link assertCanOperate},
 *    never trusted from the client and never cached. Paid and allocated are
 *    independent facts and both are required — a refunded user can still be
 *    holding hardware, and a paid user may be waiting for one.
 * 2. **Unlocking always costs a valid OTP.** There is no flag, no environment
 *    variable and no admin override in this file that skips it.
 * 3. **The stored lock state only moves on an ack.** A sent command that is
 *    not acknowledged leaves the state alone, so the dashboard never tells
 *    someone their safe is locked when the bolt did not move.
 */

// --- Errors ------------------------------------------------------------------

const notPaid = () =>
  new HttpError({
    status: 402,
    code: ERROR_CODES.NOT_PAID,
    message: 'Complete your payment to activate your safe.',
  });

const refunded = () =>
  new HttpError({
    status: 403,
    code: ERROR_CODES.REFUNDED_CONTACT_SUPPORT,
    message:
      'Your payment was refunded, so remote access is disabled. Please contact support about returning your safe.',
  });

const noDevice = () =>
  conflict(
    ERROR_CODES.NO_DEVICE,
    'No safe is allocated to your account yet. You will be notified once one is assigned.',
  );

/**
 * Unlock needs a verified number because that is where the code goes.
 *
 * **403, not 402**: this is not about money. A distinct code too — the
 * dashboard shows a "verify your phone" prompt for it, which is useless for
 * `NOT_PAID` or `NO_DEVICE`.
 */
const phoneNotVerified = () =>
  new HttpError({
    status: 403,
    code: ERROR_CODES.PHONE_NOT_VERIFIED,
    message:
      'Verify your phone number before unlocking your safe — that is where your one-time code is sent.',
  });

const stateUnknown = () =>
  conflict(
    ERROR_CODES.DEVICE_STATE_UNKNOWN,
    'Your safe is not reporting its state. Please contact support.',
  );

/**
 * Every OTP failure is a 400 carrying a distinct code.
 *
 * Not 429 for the attempt limit, even though it is a lockout: the client
 * already treats 429 as "the rate limiter, back off and retry later", and a
 * burned challenge is not retryable — it needs a new code. The `code` is what
 * the UI switches on.
 */
const otpFailure = (code: string, message: string) =>
  new HttpError({ status: 400, code, message });

const commandFailed = () =>
  new HttpError({
    status: 502,
    code: ERROR_CODES.DEVICE_COMMAND_FAILED,
    message: 'Your safe did not respond. Please try again in a moment.',
  });

/**
 * A code was generated but could not be delivered.
 *
 * **502, not 500**: the failure is in an upstream service, and the status is
 * what tells the rate limiter to refund this attempt (see
 * `requestWasSuccessful` on the unlock limiters) so a WhatsApp outage does not
 * also burn the user's three-codes-per-ten-minutes allowance. A wrong code is
 * a 4xx and still counts.
 *
 * A spent send cap is the one case that is the *user's* situation rather than
 * ours, so it keeps its own code and a 429 — the one place in the OTP flow
 * where "back off and retry later" is literally the right advice.
 */
function deliveryFailed(outcome: SendOutcome): HttpError {
  if (outcome.status === 'SKIPPED' && outcome.reason === 'CAP_REACHED') {
    return new HttpError({
      status: 429,
      code: ERROR_CODES.WHATSAPP_SEND_CAP_REACHED,
      message:
        'You have reached today’s limit for WhatsApp messages. Please try again later, or contact support if you are locked out.',
    });
  }

  if (outcome.status === 'SKIPPED' && outcome.reason === 'NO_VERIFIED_PHONE') {
    // Should be unreachable: assertCanOperate checks this first. Kept so the
    // answer is still accurate if that order ever changes.
    return new HttpError({
      status: 403,
      code: ERROR_CODES.PHONE_NOT_VERIFIED,
      message: 'Verify your phone number before unlocking your safe.',
    });
  }

  if (outcome.status === 'SKIPPED' && outcome.reason === 'NO_CONSENT') {
    return new HttpError({
      status: 403,
      code: ERROR_CODES.CONSENT_REQUIRED,
      message:
        'We need your permission to send WhatsApp messages before we can send an unlock code.',
    });
  }

  return new HttpError({
    status: 502,
    code: ERROR_CODES.OTP_DELIVERY_FAILED,
    message: 'We could not send your unlock code. Please try again in a moment.',
  });
}

// --- Eligibility -------------------------------------------------------------

/** What a caller is allowed to do, and the device it concerns. */
export interface OperableDevice {
  deviceId: string;
  serialNumber: string;
  lockState: 'LOCKED' | 'UNLOCKED' | 'UNKNOWN';
}

/**
 * Resolves the device this user may operate, or throws.
 *
 * Checked in this order, which matters:
 * - **refunded while holding hardware** first, so that state gets its own
 *   message instead of being flattened into "you have not paid". It is a real
 *   state (see docs/decisions.md) and paying again is not the remedy.
 * - then unpaid,
 * - then — for unlock only — **an unverified phone**,
 * - then no device allocated.
 *
 * Why the phone check sits where it does: paid and refunded are facts about
 * the account that the user may be unable to change right now, so they come
 * first. An unverified number is something they can fix in a minute, and
 * telling them so is more useful than "no safe is allocated yet" — which they
 * can do nothing about. It is also checked before the device lookup so a user
 * waiting on allocation still learns they should verify in the meantime.
 *
 * This is why the lock/unlock routes do **not** mount `requirePaid`: that
 * middleware answers 402 PAYMENT_REQUIRED for both the never-paid and the
 * refunded user, and the two need different answers here.
 */
export async function assertCanOperate(
  userId: string,
  client: PrismaTransaction | typeof prisma = prisma,
  options: { requirePhoneVerified?: boolean } = {},
): Promise<OperableDevice> {
  const [paid, user, device] = await Promise.all([
    userHasPaid(userId, client),
    client.user.findUnique({
      where: { id: userId },
      select: { phoneVerifiedAt: true },
    }),
    client.device.findUnique({
      where: { ownerId: userId },
      select: { id: true, serialNumber: true, lockState: true, status: true },
    }),
  ]);

  if (!paid) throw device ? refunded() : notPaid();

  /**
   * **Unlock requires a verified number; lock does not.**
   *
   * Unlocking needs somewhere to send the one-time code, so without a
   * verified number the flow cannot complete at all — better to say so up
   * front than to generate a code that goes nowhere.
   *
   * Locking is deliberately left open. It is the safe direction, needs no
   * code, and blocking it would mean an unverified user could not secure
   * their own safe — which would make the gate actively harmful.
   */
  if (options.requirePhoneVerified && !user?.phoneVerifiedAt) throw phoneNotVerified();

  if (!device || device.status !== 'ASSIGNED') throw noDevice();

  // Should be unreachable: allocation sets LOCKED and only unassign sets
  // UNKNOWN, which also clears ownerId. Refusing rather than guessing — the
  // alternative is sending a bolt command on a state we cannot reason about.
  if (device.lockState === 'UNKNOWN') throw stateUnknown();

  return {
    deviceId: device.id,
    serialNumber: device.serialNumber,
    lockState: device.lockState,
  };
}

// --- Shared helpers ----------------------------------------------------------

/**
 * Takes an exclusive row lock on a device for the rest of the transaction.
 *
 * This is what stops two tabs racing: a second request for the same device
 * blocks here until the first has committed, then reads the state the first
 * one left. Without it both could read "LOCKED", both send a command, and
 * both write a DeviceEvent for one physical movement.
 *
 * Raw SQL because Prisma has no row-locking API. The only interpolated value
 * is a device id we just read from our own database, and it is a bound
 * parameter, not string concatenation.
 */
async function lockDeviceRow(tx: PrismaTransaction, deviceId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "Device" WHERE "id" = ${deviceId} FOR UPDATE`;
}

/**
 * Records a user-visible device event. Never carries a code or a hash.
 *
 * Returns the new row's id so a notification can point at it in the same
 * transaction.
 */
async function recordEvent(
  tx: PrismaTransaction | typeof prisma,
  input: {
    deviceId: string;
    userId: string;
    type: 'LOCK' | 'UNLOCK_REQUESTED' | 'UNLOCK_CONFIRMED' | 'UNLOCK_FAILED';
    requestId: string | null;
    failureReason?: StoredUnlockFailureReason | undefined;
  },
): Promise<string> {
  const event = await tx.deviceEvent.create({
    data: {
      deviceId: input.deviceId,
      userId: input.userId,
      type: input.type,
      source: 'WEB',
      requestId: input.requestId,
      ...(input.failureReason ? { failureReason: input.failureReason } : {}),
    },
    select: { id: true },
  });

  return event.id;
}

/** Reads the owner-facing view of a device. */
async function readSummary(
  client: PrismaTransaction | typeof prisma,
  deviceId: string,
): Promise<DeviceSummary> {
  const device = await client.device.findUniqueOrThrow({
    where: { id: deviceId },
    select: DEVICE_SUMMARY_SELECT,
  });
  return toDeviceSummary(device);
}

// --- Lock --------------------------------------------------------------------

export interface LockInput {
  userId: string;
  requestId: string | null;
}

/**
 * Locks the safe. Idempotent: an already-locked safe is a success, no command
 * is sent and no event is written — there was no state change to record.
 *
 * The gateway call happens **inside** the transaction, while the device row is
 * locked. That holds a row lock across the gateway round trip, which is
 * acceptable while the gateway is an in-process mock and is the simplest thing
 * that makes two concurrent taps correct. The real MQTT gateway must not do
 * this: it needs a claim-then-ack model with a `Command` row and a timeout,
 * which is exactly what that deferred table is for (see docs/decisions.md).
 */
export async function lockDevice(input: LockInput): Promise<LockResponse> {
  const target = await assertCanOperate(input.userId);

  return prisma.$transaction(async (tx) => {
    await lockDeviceRow(tx, target.deviceId);

    // Re-read under the lock: another tab may have moved it since
    // assertCanOperate ran.
    const current = await tx.device.findUniqueOrThrow({
      where: { id: target.deviceId },
      select: { lockState: true, serialNumber: true },
    });

    if (current.lockState === 'LOCKED') {
      return { device: await readSummary(tx, target.deviceId), alreadyLocked: true };
    }

    const result = await sendCommand(() => deviceGateway.sendLock(current.serialNumber));

    await tx.device.update({
      where: { id: target.deviceId },
      data: {
        lockState: 'LOCKED',
        lockStateUpdatedAt: result.ackedAt,
        online: true,
        lastSeenAt: result.ackedAt,
      },
    });

    await recordEvent(tx, {
      deviceId: target.deviceId,
      userId: input.userId,
      type: 'LOCK',
      requestId: input.requestId,
    });

    return { device: await readSummary(tx, target.deviceId), alreadyLocked: false };
  });
}

/** Runs a gateway call and turns any transport failure into a clean 502. */
async function sendCommand(
  call: () => Promise<{ acked: boolean; ackedAt: Date }>,
): Promise<{ acked: boolean; ackedAt: Date }> {
  let result: { acked: boolean; ackedAt: Date };

  try {
    result = await call();
  } catch (cause) {
    logger.error(
      { reason: cause instanceof Error ? cause.message : 'unknown' },
      'Device gateway threw while sending a command',
    );
    throw commandFailed();
  }

  // An unacked command is a command that did not happen. Fail rather than
  // record a state the hardware never confirmed.
  if (!result.acked) throw commandFailed();

  return result;
}

// --- Unlock: request ---------------------------------------------------------

export interface UnlockRequestInput {
  userId: string;
  requestId: string | null;
}

/**
 * Issues a fresh unlock code.
 *
 * Any older open challenge for this user and device is consumed first, so
 * there is **at most one live code at a time**. Leaving the old one valid
 * would quietly multiply the attacker's guesses: five tries per challenge
 * becomes five tries per *request*, and the request endpoint is the one a
 * user can trigger repeatedly.
 */
export async function requestUnlock(
  input: UnlockRequestInput,
): Promise<UnlockRequestResponse> {
  const target = await assertCanOperate(input.userId, prisma, {
    requirePhoneVerified: true,
  });

  const code = generateOtp();
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);

  const challengeId = await prisma.$transaction(async (tx) => {
    await tx.unlockChallenge.updateMany({
      where: { userId: input.userId, deviceId: target.deviceId, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    const challenge = await tx.unlockChallenge.create({
      data: {
        userId: input.userId,
        deviceId: target.deviceId,
        otpHash: hashOtp(code),
        expiresAt,
      },
      select: { id: true },
    });

    await recordEvent(tx, {
      deviceId: target.deviceId,
      userId: input.userId,
      type: 'UNLOCK_REQUESTED',
      requestId: input.requestId,
    });

    return challenge.id;
  });

  /**
   * Delivery happens after the commit, so a code the user has been told about
   * always corresponds to a challenge that exists.
   *
   * If it fails, the challenge is **consumed immediately**: leaving it open
   * would mean a live code for five minutes that the owner never received,
   * which is a code only someone who intercepted it could use. The user gets
   * `OTP_DELIVERY_FAILED` and can simply ask again.
   *
   * **Window, stated plainly:** these are two steps, not one, and nothing can
   * make them atomic — a send cannot join a database transaction, and a
   * transaction cannot un-send. If the process dies between the commit and
   * the compensating consume, an undelivered challenge is left open until it
   * expires on its own five minutes later. That is the same five-minute
   * exposure an ordinary unread code already has, it needs a crash inside a
   * ~100ms window to happen at all, and the code itself only ever existed in
   * the memory of the dead process. See docs/decisions.md.
   */
  const delivery = await deliverOtp({
    userId: input.userId,
    code,
    serialNumber: target.serialNumber,
    expiresAt,
  });

  if (delivery.status !== 'SENT') {
    await consume(challengeId);
    throw deliveryFailed(delivery);
  }

  return {
    expiresAt: expiresAt.toISOString(),
    expiresInSeconds: Math.round(OTP_TTL_MS / 1000),
    attemptsAllowed: OTP_MAX_ATTEMPTS,
    resendAfterSeconds: OTP_RESEND_COOLDOWN_SECONDS,
  };
}

// --- Unlock: confirm ---------------------------------------------------------

export interface UnlockConfirmInput {
  userId: string;
  otp: string;
  requestId: string | null;
}

/** Why a confirm failed, for the audit row. Never includes the code itself. */
export type UnlockFailureReason =
  | 'no_challenge'
  | 'expired'
  | 'attempts_exhausted'
  | 'wrong_code';

/**
 * The same four reasons as the `UnlockFailureReason` enum column.
 *
 * Two spellings exist because the audit metadata values above are already in
 * the audit table and asserted by tests, while the column — being user-visible
 * through `/devices/history` — follows the uppercase convention of every other
 * Prisma enum. The map is the single place they are tied together, so a new
 * reason cannot be added to one without the compiler demanding the other.
 */
const STORED_REASON: Record<UnlockFailureReason, StoredUnlockFailureReason> = {
  no_challenge: 'NO_CHALLENGE',
  expired: 'EXPIRED',
  attempts_exhausted: 'TOO_MANY_ATTEMPTS',
  wrong_code: 'WRONG_CODE',
};

export class UnlockFailed extends Error {
  constructor(
    readonly httpError: HttpError,
    readonly reason: UnlockFailureReason,
    readonly deviceId: string,
  ) {
    super(httpError.message);
    this.name = 'UnlockFailed';
  }
}

/**
 * Verifies a code and, only then, opens the safe.
 *
 * Concurrency: the winning path claims the challenge with a conditional
 * `updateMany` on `consumedAt: null`. Two confirms submitting the same correct
 * code therefore produce exactly one claim — the loser sees `OTP_NOT_FOUND`
 * ("already used") rather than both of them unlocking and writing two events.
 *
 * A wrong code increments `attempts` with an atomic `increment`, so N
 * simultaneous wrong guesses cost N attempts, not one.
 */
export async function confirmUnlock(
  input: UnlockConfirmInput,
): Promise<UnlockConfirmResponse> {
  // Re-checked here too, not just on request: a number could have been
  // unverified between the two calls, and the second call is the one that
  // moves the bolt.
  const target = await assertCanOperate(input.userId, prisma, {
    requirePhoneVerified: true,
  });

  const challenge = await prisma.unlockChallenge.findFirst({
    where: { userId: input.userId, deviceId: target.deviceId, consumedAt: null },
    orderBy: { createdAt: 'desc' },
    select: { id: true, otpHash: true, expiresAt: true, attempts: true },
  });

  if (!challenge) {
    throw new UnlockFailed(
      otpFailure(
        ERROR_CODES.OTP_NOT_FOUND,
        'That code is no longer valid. Request a new one.',
      ),
      'no_challenge',
      target.deviceId,
    );
  }

  if (challenge.expiresAt.getTime() <= Date.now()) {
    await consume(challenge.id);
    throw new UnlockFailed(
      otpFailure(ERROR_CODES.OTP_EXPIRED, 'That code has expired. Request a new one.'),
      'expired',
      target.deviceId,
    );
  }

  // Defensive: the increment below also consumes on the last attempt, so a
  // live challenge should never be sitting at the cap. Checked anyway, since
  // the alternative is unbounded guessing if that ever stops being true.
  if (challenge.attempts >= OTP_MAX_ATTEMPTS) {
    await consume(challenge.id);
    throw new UnlockFailed(
      otpFailure(
        ERROR_CODES.OTP_TOO_MANY_ATTEMPTS,
        'Too many incorrect codes. Request a new one.',
      ),
      'attempts_exhausted',
      target.deviceId,
    );
  }

  if (!verifyOtp(input.otp, challenge.otpHash)) {
    const { attempts } = await prisma.unlockChallenge.update({
      where: { id: challenge.id },
      data: { attempts: { increment: 1 } },
      select: { attempts: true },
    });

    if (attempts >= OTP_MAX_ATTEMPTS) {
      await consume(challenge.id);
      throw new UnlockFailed(
        otpFailure(
          ERROR_CODES.OTP_TOO_MANY_ATTEMPTS,
          'Too many incorrect codes. Request a new one.',
        ),
        'attempts_exhausted',
        target.deviceId,
      );
    }

    throw new UnlockFailed(
      otpFailure(
        ERROR_CODES.OTP_INVALID,
        `That code is not correct. ${OTP_MAX_ATTEMPTS - attempts} attempt${
          OTP_MAX_ATTEMPTS - attempts === 1 ? '' : 's'
        } left.`,
      ),
      'wrong_code',
      target.deviceId,
    );
  }

  const device = await prisma.$transaction(async (tx) => {
    // The serialisation point. Exactly one concurrent confirm claims it.
    const claimed = await tx.unlockChallenge.updateMany({
      where: { id: challenge.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    if (claimed.count !== 1) {
      throw new UnlockFailed(
        otpFailure(
          ERROR_CODES.OTP_NOT_FOUND,
          'That code has already been used. Request a new one.',
        ),
        'no_challenge',
        target.deviceId,
      );
    }

    await lockDeviceRow(tx, target.deviceId);

    const current = await tx.device.findUniqueOrThrow({
      where: { id: target.deviceId },
      select: { serialNumber: true },
    });

    // If this throws, the whole transaction rolls back — including the claim,
    // so the user's code still works and they can simply try again. Burning a
    // valid code because the radio hiccuped would be a poor trade.
    const result = await sendCommand(() => deviceGateway.sendUnlock(current.serialNumber));

    await tx.device.update({
      where: { id: target.deviceId },
      data: {
        lockState: 'UNLOCKED',
        lockStateUpdatedAt: result.ackedAt,
        online: true,
        lastSeenAt: result.ackedAt,
      },
    });

    const eventId = await recordEvent(tx, {
      deviceId: target.deviceId,
      userId: input.userId,
      type: 'UNLOCK_CONFIRMED',
      requestId: input.requestId,
    });

    /**
     * Tell the owner, in this transaction.
     *
     * Atomic with the event on purpose and in both directions: a rollback
     * after this point takes the notification with it, so nobody is told their
     * safe opened when it did not — and there is no path that opens the safe
     * while silently failing to notify, because a notifier that cannot record
     * throws and rolls the unlock back. For a product that physically opens a
     * safe, "it opened but we never told you" is the worse of the two
     * failures. See docs/decisions.md.
     */
    await notifier.notifyUnlock(tx, {
      userId: input.userId,
      type: 'UNLOCK_CONFIRMED',
      deviceEventId: eventId,
      serialNumber: current.serialNumber,
    });

    return readSummary(tx, target.deviceId);
  });

  return { device };
}

/** Marks a challenge dead. Idempotent — only an open challenge is touched. */
async function consume(challengeId: string): Promise<void> {
  await prisma.unlockChallenge.updateMany({
    where: { id: challengeId, consumedAt: null },
    data: { consumedAt: new Date() },
  });
}

/**
 * Records a failed unlock attempt as a user-visible event, and notifies the
 * owner if that failure burned the challenge.
 *
 * Separate from the happy path because it must survive the failure: the
 * controller calls this after catching {@link UnlockFailed}, so a wrong code
 * still shows up in the owner's history. The reason is a fixed enum value —
 * nothing derived from what was typed.
 *
 * **Only `attempts_exhausted` notifies.** A single mistyped digit is the most
 * ordinary thing a legitimate owner does, and a notification per typo would
 * train people to ignore the bell — which is precisely the signal that needs
 * to still mean something. Five wrong codes in a row against one challenge is
 * different in kind: it is either a person who no longer has the code, or
 * someone guessing at a physical safe. See docs/decisions.md.
 */
export async function recordUnlockFailure(input: {
  deviceId: string;
  userId: string;
  reason: UnlockFailureReason;
  requestId: string | null;
}): Promise<void> {
  const shouldNotify = input.reason === 'attempts_exhausted';

  try {
    await prisma.$transaction(async (tx) => {
      const eventId = await recordEvent(tx, {
        deviceId: input.deviceId,
        userId: input.userId,
        type: 'UNLOCK_FAILED',
        requestId: input.requestId,
        failureReason: STORED_REASON[input.reason],
      });

      if (!shouldNotify) return;

      const device = await tx.device.findUniqueOrThrow({
        where: { id: input.deviceId },
        select: { serialNumber: true },
      });

      await notifier.notifyUnlock(tx, {
        userId: input.userId,
        type: 'UNLOCK_FAILED_MAX_ATTEMPTS',
        deviceEventId: eventId,
        serialNumber: device.serialNumber,
      });
    });
  } catch (cause) {
    // Same rule as the audit log: recording must never turn a 400 into a 500.
    // The user's answer is already decided — the code was wrong either way.
    logger.error(
      { reason: cause instanceof Error ? cause.message : 'unknown' },
      'Failed to record an UNLOCK_FAILED device event',
    );
  }
}
