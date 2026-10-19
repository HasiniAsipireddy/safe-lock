import {
  CHALLENGE_MAX_BINDS,
  COMMAND_POLL_INTERVAL_MS,
  ERROR_CODES,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_SECONDS,
  OTP_TTL_MS,
  type CommandAcceptedResponse,
  type DeviceSummary,
  type UnlockFailureReason as StoredUnlockFailureReason,
  type UnlockRequestResponse,
} from '@safelock/shared';
import { prisma, type PrismaTransaction } from '../../lib/prisma';
import { HttpError, conflict } from '../../lib/httpError';
import type { SendOutcome } from '../../lib/whatsapp/send';
import { logger } from '../../lib/logger';
import { notifier } from '../../lib/notifier';
import { unlockEligibility } from '@safelock/shared';
import {
  BOOKING_SELECT,
  outstandingFeePaise,
  snapshotOf,
  type BookingRow,
} from '../bookings/booking.mapper';
import {
  assertNotBusyWith,
  bindLimitReached,
  createCommand,
  publishCommand,
  type CommandRecord,
} from '../commands/command.service';
import { DEVICE_SUMMARY_SELECT, isDeviceOnline, toDeviceSummary } from './device.mapper';
import { recordEvent } from './deviceEvents';
import { deliverOtp, generateOtp, hashOtp, verifyOtp } from './otp.service';

/**
 * Lock and unlock.
 *
 * Three invariants hold throughout this module:
 *
 * 1. **Eligibility is re-derived on every call** by {@link assertCanOperate},
 *    never trusted from the client and never cached — and for `confirm`, again
 *    inside the transaction with the device row locked. It is derived from the
 *    **server clock**, not from a booking's stored status, so a sweeper that is
 *    late, wedged or has never run cannot leave a safe unlockable.
 * 2. **Unlocking always costs a valid OTP.** There is no flag, no environment
 *    variable and no admin override in this file that skips it.
 * 3. **The stored lock state only moves on an ack.** A sent command that is
 *    not acknowledged leaves the state alone, so the dashboard never tells
 *    someone their safe is locked when the bolt did not move.
 */

// --- Errors ------------------------------------------------------------------

const noActiveBooking = () =>
  conflict(
    ERROR_CODES.NO_ACTIVE_BOOKING,
    'You have no running booking. Book a safe to use one.',
  );

/**
 * An overstay fee is outstanding.
 *
 * **402, and unlock-only.** Locking stays available: refusing to let someone
 * secure a safe they are standing at would punish them in the one direction
 * that creates risk rather than recovering money.
 */
const overstayDue = (feePaise: number) =>
  new HttpError({
    status: 402,
    code: ERROR_CODES.OVERSTAY_PAYMENT_REQUIRED,
    message: `An overstay fee of ${feePaise} paise is outstanding. Pay it to unlock your safe and collect your items.`,
  });

/**
 * Unlock needs a verified number because that is where the code goes.
 *
 * Checked **before** the booking, because it is the one thing a user can fix
 * at any time — including while they have no booking at all.
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
 * We cannot reach the safe.
 *
 * **Refused, not queued — including a lock.** That is not a weakening of
 * "never block locking": that rule is about *policy* gates, and no code, no
 * settled fee and no verified phone are needed to secure your safe. This is
 * physics. A queued lock firing forty minutes later is a command whose premise
 * has expired, and would either record a safe as locked when it is not — which
 * "lockState moves only on an ack" forbids — or sit invisibly pending.
 *
 * Refused at the unlock *request* too, before a code is sent: issuing an OTP
 * for a safe that cannot receive a command spends the user's WhatsApp send cap
 * and their three-codes-per-ten-minutes on a code that cannot work. Refusing
 * early with an accurate message costs them nothing.
 */
const deviceOffline = () =>
  conflict(
    ERROR_CODES.DEVICE_OFFLINE,
    'We cannot reach your safe right now. Check that it has power, and use your key if you need your belongings immediately.',
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

/**
 * There is no `commandFailed` 502 any more, and its absence is the point.
 *
 * A command can no longer fail *during the request*: the request's job ends at
 * "a command row exists and has been handed to the gateway". Everything that
 * can go wrong afterwards — a refusal, a jam, silence — is reported on the
 * command itself and read by polling `GET /devices/commands/:id`.
 *
 * One answer for every outcome rather than a 502 for one particular failure
 * and a poll for the rest. `ERROR_CODES.DEVICE_COMMAND_FAILED` is kept for the
 * clients still switching on it.
 */

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
  bookingId: string;
  /** Derived from the age of the last verified message, never the stored flag. */
  online: boolean;
}

/**
 * Resolves the safe this user may operate right now, or throws.
 *
 * Eligibility under the rental model is: **a verified phone, plus a live
 * booking whose effective status allows the action.** Device ownership no
 * longer exists.
 *
 * Checked in this order, which matters:
 * 1. **Verified phone** — the one thing the user can fix at any moment, and
 *    pointless to discover after choosing a safe.
 * 2. **A live booking** — derived from the server clock, never from the stored
 *    status, so a missed sweep cannot leave a safe unlockable.
 * 3. **An outstanding overstay fee** — its own code, because the dashboard
 *    shows a pay button for it and nothing else.
 * 4. **Unknown lock state** — refuse rather than guess.
 *
 * `requirePhoneVerified` and `requireUnlockable` are separate because
 * **locking is deliberately less gated than unlocking**: locking needs no
 * one-time code and no settled fee. The asymmetry is the point.
 */
export async function assertCanOperate(
  userId: string,
  client: PrismaTransaction | typeof prisma = prisma,
  options: {
    requirePhoneVerified?: boolean;
    requireUnlockable?: boolean;
    /**
     * Whether an unreachable safe is a refusal.
     *
     * True for every action that sends a command, and for the unlock request
     * that would otherwise spend a code on one. False for a plain read, which
     * must still answer for an offline safe — a dashboard that 409s because a
     * device is unplugged tells the user nothing about their booking.
     */
    requireOnline?: boolean;
    now?: Date;
  } = {},
): Promise<OperableDevice> {
  const now = options.now ?? new Date();

  const [user, booking] = await Promise.all([
    client.user.findUnique({
      where: { id: userId },
      select: { phoneVerifiedAt: true },
    }),
    client.booking.findFirst({
      where: { userId, status: { in: ['ACTIVE', 'OVERSTAY'] } },
      orderBy: { createdAt: 'desc' },
      select: BOOKING_SELECT,
    }),
  ]);

  if (options.requirePhoneVerified && !user?.phoneVerifiedAt) throw phoneNotVerified();

  if (!booking) throw noActiveBooking();

  const row = booking as BookingRow;
  const eligibility = unlockEligibility({
    status: row.status,
    endsAt: row.endsAt,
    holdExpiresAt: row.holdExpiresAt,
    overstaySettledAt: row.overstaySettledAt ?? row.overstayWaivedAt,
    snapshot: snapshotOf(row),
    now,
  });

  /**
   * Locking is allowed in any live booking state, including an unpaid
   * overstay. Only unlocking consults `unlockEligibility`.
   */
  if (options.requireUnlockable && !eligibility.allowed) {
    if (eligibility.reason === 'OVERSTAY_FEE_DUE') {
      throw overstayDue(outstandingFeePaise(row, now));
    }
    throw noActiveBooking();
  }

  const device = await client.device.findUnique({
    where: { id: row.deviceId },
    select: { id: true, serialNumber: true, lockState: true, online: true, lastSeenAt: true },
  });

  if (!device) throw noActiveBooking();

  // Should be unreachable for a booked safe. Refusing rather than guessing —
  // the alternative is sending a bolt command on a state we cannot reason
  // about.
  if (device.lockState === 'UNKNOWN') throw stateUnknown();

  const online = isDeviceOnline(device, now);

  /**
   * Checked last, after everything the user could do something about.
   *
   * A user whose booking has ended *and* whose safe is offline should be told
   * about the booking: that is the one of the two they can act on. Ordering
   * the other way would send someone to check a power cable over a rental that
   * expired yesterday.
   */
  if (options.requireOnline && !online) throw deviceOffline();

  return {
    deviceId: device.id,
    serialNumber: device.serialNumber,
    lockState: device.lockState,
    bookingId: row.id,
    online,
  };
}

/**
 * The safe the caller currently has, or null.
 *
 * A **read**, so it answers null rather than throwing: a user between bookings
 * is not an error, and `GET /devices/mine` has no eligibility gate for exactly
 * that reason. It is also null during `PENDING_PAYMENT` — a held safe is not
 * yet a safe you can operate, and showing one before the money lands would
 * imply controls that `assertCanOperate` would refuse.
 */
export async function currentDeviceFor(userId: string): Promise<DeviceSummary | null> {
  const booking = await prisma.booking.findFirst({
    where: { userId, status: { in: ['ACTIVE', 'OVERSTAY'] } },
    orderBy: { createdAt: 'desc' },
    select: { deviceId: true },
  });

  if (!booking) return null;

  const device = await prisma.device.findUnique({
    where: { id: booking.deviceId },
    select: DEVICE_SUMMARY_SELECT,
  });

  return device ? toDeviceSummary(device) : null;
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

// --- Lock --------------------------------------------------------------------

export interface LockInput {
  userId: string;
  requestId: string | null;
}

/**
 * Asks the safe to lock, and answers before it has.
 *
 * ## 202, not 200
 * The old version called the gateway **inside** the transaction while holding
 * the device row lock, and returned the device. That was correct for an
 * in-process mock and is unacceptable over MQTT for two independent reasons: a
 * transaction that waits on a radio makes a network outage fatal, and holding
 * the device row lock across the round trip serialises the fleet behind one
 * slow safe. So the row is committed, the lock is released, the command is
 * published, and the client is handed a `commandId` to poll.
 *
 * Returning a device summary here would mean returning a lock state nobody has
 * confirmed — which is the thing `lockState` moves only on an ack exists to
 * prevent.
 *
 * ## Idempotent
 * An already-locked safe is a success with no command issued. Nothing was sent
 * and no event is written, because there was no state change to record.
 */
export async function lockDevice(input: LockInput): Promise<CommandAcceptedResponse> {
  /**
   * Neither policy gate: locking needs no one-time code and no settled fee. An
   * unverified user mid-overstay must still be able to secure their safe.
   * `requireOnline` is not a policy gate — it is whether the safe can hear us.
   */
  const target = await assertCanOperate(input.userId, prisma, { requireOnline: true });

  /**
   * Three outcomes, named: the safe is already locked, a lock is already on
   * its way, or we are issuing one. Each answers the caller differently and
   * none of them is an error.
   */
  type LockDecision =
    | { kind: 'already-locked' }
    | { kind: 'in-flight'; command: { id: string; expiresAt: Date } }
    | { kind: 'issued'; command: CommandRecord };

  const issued = await prisma.$transaction<LockDecision>(async (tx) => {
    await lockDeviceRow(tx, target.deviceId);

    // Re-read under the lock: another tab may have moved it since
    // assertCanOperate ran.
    const current = await tx.device.findUniqueOrThrow({
      where: { id: target.deviceId },
      select: { lockState: true },
    });

    if (current.lockState === 'LOCKED') return { kind: 'already-locked' };

    /**
     * A lock already on its way is the answer to a second tap.
     *
     * Returning the in-flight command rather than issuing another keeps the
     * two taps idempotent *and* keeps the device's no-queue rule satisfied —
     * it would reject the second as `UNSUPPORTED`, and the user would see a
     * failure for a lock that was in fact succeeding. A different command in
     * flight raises `DEVICE_BUSY` from here.
     */
    const live = await assertNotBusyWith(tx, target.deviceId, 'LOCK');
    if (live) return { kind: 'in-flight', command: live };

    return {
      kind: 'issued',
      command: await createCommand(tx, {
        deviceId: target.deviceId,
        type: 'LOCK',
        userId: input.userId,
        bookingId: target.bookingId,
      }),
    };
  });

  if (issued.kind === 'in-flight') {
    return {
      commandId: issued.command.id,
      status: 'SENT',
      pollAfterMs: COMMAND_POLL_INTERVAL_MS,
      expiresAt: issued.command.expiresAt.toISOString(),
    };
  }

  if (issued.kind === 'already-locked') {
    return {
      commandId: null,
      /**
       * `ACKED` because the safe is in the requested state and has previously
       * confirmed it — `alreadyInState` is what tells the client there is
       * nothing to wait for. Inventing a sixth status for "no work to do"
       * would put a value in the enum that no command row can ever hold.
       */
      status: 'ACKED',
      pollAfterMs: 0,
      expiresAt: new Date().toISOString(),
      alreadyInState: true,
    };
  }

  // Outside the transaction, after the commit, with no lock held.
  const outcome = await publishCommand(issued.command);

  return {
    commandId: issued.command.id,
    status: outcome.status,
    pollAfterMs: COMMAND_POLL_INTERVAL_MS,
    expiresAt: issued.command.expiresAt.toISOString(),
  };
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
  /**
   * `requireOnline` here, before a code exists.
   *
   * This is the most important of the offline refusals: issuing an OTP for a
   * safe that cannot receive a command spends the user's WhatsApp send cap and
   * one of their three codes per ten minutes on a code that cannot possibly
   * work — and then fails at the confirm step anyway, after they have typed it.
   */
  const target = await assertCanOperate(input.userId, prisma, {
    requirePhoneVerified: true,
    requireUnlockable: true,
    requireOnline: true,
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
  | 'wrong_code'
  /**
   * The code was never examined: we could not reach the safe.
   *
   * The only member of this union that is not about the code. Kept here rather
   * than given its own path because the *recording* is identical — an
   * `UNLOCK_FAILED` row in the owner's feed with a reason — and the three
   * device-side failures that happen after a correct code are recorded by the
   * ack handler instead, where their outcome is actually known.
   */
  | 'device_offline';

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
  device_offline: 'DEVICE_OFFLINE',
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
): Promise<CommandAcceptedResponse> {
  // Re-checked here, not just on request: a number could have been unverified
  // and a booking could have ended between the two calls, and this is the call
  // that moves the bolt. Re-checked **again** inside the transaction below,
  // with the device row locked.
  const target = await assertCanOperate(input.userId, prisma, {
    requirePhoneVerified: true,
    requireUnlockable: true,
  });

  /**
   * Offline raised as an `UnlockFailed` rather than a bare 409, so the owner's
   * activity feed records the attempt.
   *
   * It is the one refusal at this point that is about the *safe* rather than
   * about the code or the booking, and somebody looking at their history
   * afterwards — wondering why their safe would not open — should find it
   * there. The code is untouched: nothing was spent, so they can try again the
   * moment the safe is back.
   */
  if (!target.online) {
    throw new UnlockFailed(deviceOffline(), 'device_offline', target.deviceId);
  }

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

  /**
   * Two outcomes, and the second one has to survive the rollback.
   *
   * A code at its bind limit must be *burned*, and a burn written inside a
   * transaction that then throws is a burn that never happened.
   */
  type ConfirmDecision =
    | { kind: 'issued'; command: CommandRecord }
    | { kind: 'bind-limit' };

  const issued = await prisma.$transaction<ConfirmDecision>(async (tx) => {
    /**
     * The row lock first, so two concurrent confirms are serialised here
     * rather than racing the bind below. The second one then reads a challenge
     * that is already bound and loses cleanly, instead of both allocating a
     * sequence number and one of them rolling back.
     */
    await lockDeviceRow(tx, target.deviceId);

    /**
     * Eligibility, again, **inside the transaction and under the row lock**.
     *
     * Everything checked before the transaction was checked on data that could
     * have changed since: a booking can end, a collection window can lapse, or
     * an overstay fee can start accruing between the code being verified and
     * the bolt moving. This is the check that is actually load-bearing; the
     * earlier one exists to fail fast with a good message.
     *
     * A throw here rolls the whole transaction back — including the bind — so
     * the user's code is not burned by a refusal that was not their fault.
     */
    await assertCanOperate(input.userId, tx, {
      requirePhoneVerified: true,
      requireUnlockable: true,
      requireOnline: true,
    });

    /**
     * Checked **before** the challenge is bound, so a refusal costs the user
     * nothing: a completion lock or a reconcile already in flight means the
     * device would reject this unlock as a duplicate, and burning a bind to
     * find that out would be charging them for our timing.
     */
    await assertNotBusyWith(tx, target.deviceId, 'UNLOCK');

    const open = await tx.unlockChallenge.findUnique({
      where: { id: challenge.id },
      select: { consumedAt: true, commandId: true, binds: true },
    });

    // Consumed, or already backing a live command: either way this code is not
    // available to spend, and the answer is the same one a reused code gets.
    if (!open || open.consumedAt || open.commandId) {
      throw new UnlockFailed(
        otpFailure(
          ERROR_CODES.OTP_NOT_FOUND,
          'That code has already been used. Request a new one.',
        ),
        'no_challenge',
        target.deviceId,
      );
    }

    /**
     * The bind limit. Without it, a jammed motor and a determined user could
     * spawn commands until the code expired — each failure releasing the code
     * for another attempt, indefinitely.
     */
    /**
     * The bind limit. Without it, a jammed motor and a determined user could
     * spawn commands until the code expired — each failure releasing the code
     * for another attempt, indefinitely.
     *
     * The code is burned **outside** this transaction, below. Doing it here
     * and then throwing would roll the burn back with everything else, leaving
     * a code that refuses forever at the limit but never dies — and a user
     * told to request a new one while the old one still occupies the "one live
     * challenge" slot.
     */
    if (open.binds >= CHALLENGE_MAX_BINDS) return { kind: 'bind-limit' };

    const command = await createCommand(tx, {
      deviceId: target.deviceId,
      type: 'UNLOCK',
      userId: input.userId,
      bookingId: target.bookingId,
      // Recorded on the command, not only on the challenge: a timeout clears
      // the challenge's link, and a late ack still has to find the code.
      challengeId: challenge.id,
    });

    /**
     * The serialisation point, now on `commandId` rather than `consumedAt`.
     *
     * The concurrency property is unchanged: exactly one of N concurrent
     * confirms wins the conditional update, so exactly one command is ever
     * created and the loser sees `OTP_NOT_FOUND`. What changed is *when the
     * code dies* — at the ack, not here, because a command can fail after the
     * code was right and burning it for our motor fault would charge the user
     * for our hardware's mistake.
     */
    const bound = await tx.unlockChallenge.updateMany({
      where: { id: challenge.id, consumedAt: null, commandId: null },
      data: { commandId: command.id, binds: { increment: 1 } },
    });

    if (bound.count !== 1) {
      throw new UnlockFailed(
        otpFailure(
          ERROR_CODES.OTP_NOT_FOUND,
          'That code has already been used. Request a new one.',
        ),
        'no_challenge',
        target.deviceId,
      );
    }

    return { kind: 'issued', command };
  });

  /**
   * The burn, in its own transaction, after the first one has committed.
   *
   * Past three failed commands the code is dead rather than merely refused:
   * telling someone to request a new one while the old one still holds the
   * "one live challenge" slot would be telling them to do something that
   * cannot work.
   */
  if (issued.kind === 'bind-limit') {
    await consume(challenge.id);
    throw bindLimitReached();
  }

  /**
   * No `DeviceEvent` is written here at all.
   *
   * `UNLOCK_CONFIRMED` belongs to the ack, because the fact worth recording is
   * that the bolt moved — and a row saying "a command was sent" tells the
   * owner nothing they did not just do. `/history` is better for not having
   * one per unlock. The notification moves with it, and stays atomic with the
   * event it describes: it is now atomic with the *true* event.
   */
  const outcome = await publishCommand(issued.command);

  return {
    commandId: issued.command.id,
    status: outcome.status,
    pollAfterMs: COMMAND_POLL_INTERVAL_MS,
    expiresAt: issued.command.expiresAt.toISOString(),
  };
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
