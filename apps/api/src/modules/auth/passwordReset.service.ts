import crypto from 'node:crypto';
import {
  ERROR_CODES,
  PASSWORD_RESET_TTL_MS,
  RESET_CODE_LENGTH,
  RESET_CODE_MAX_ATTEMPTS,
  classifyIdentifier,
} from '@safelock/shared';
import { env } from '../../config/env';
import { HttpError } from '../../lib/httpError';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { resetSender } from '../../lib/resetSender';
import { hashPassword } from './password';
import { revokeAllForUser } from './refreshToken.service';

/**
 * Password reset by one-time code.
 *
 * ## Why a code, not a link
 * Step 3 issued a 32-byte token in a URL. Nothing could deliver it: the
 * WhatsApp message carries no token on purpose — a chat message is persistent,
 * forwardable and cloud-backed-up, and a reset token is an account takeover in
 * one string — and there is no email sender. So reset did not work in
 * production at all. A code works over the channel that exists.
 *
 * ## Why the digest is keyed, when the token's was not
 * For exactly the reason the step 3 entry gave for *not* keying it. An unkeyed
 * hash is reversible when the input space is small enough to enumerate; 2^256
 * is not, and **10^8 is**. So the code is stored as
 * `HMAC-SHA256("pwreset:v1:" + code, OTP_HMAC_SECRET)`.
 *
 * The secret is shared with the unlock OTP rather than new, because the two are
 * the same kind of thing — short-lived one-time codes, where rotating the key
 * invalidates at most 15 minutes of outstanding codes either way. The
 * `pwreset:v1:` prefix is domain separation: a reset digest can never equal an
 * unlock digest for the same digits. **Nothing new is needed in `.env`.**
 *
 * ## The attempt counter is load-bearing
 * 8 digits is only safe because five guesses is five guesses. The counter is
 * therefore incremented by a **conditional update whose `where` carries the
 * limit**, so the check and the increment are one statement and concurrent
 * requests cannot each take a free guess.
 *
 * ## Enumeration
 * Every failure — unknown identifier, no outstanding code, wrong code,
 * expired, already used, attempts exhausted — answers with one error and one
 * message. This endpoint is unauthenticated, so any difference would say
 * whether an account exists, and therefore whether someone owns a safe.
 */

/** Domain separation, so a reset digest cannot collide with an unlock digest. */
const CODE_DOMAIN = 'pwreset:v1:';

/**
 * HMAC of a reset code under `OTP_HMAC_SECRET`, hex.
 *
 * Note the domain prefix: `hashResetCode('12345678')` and
 * `hashOtp('12345678')` are different digests under the same key, so a code
 * valid for one purpose can never be presented as the other even if the two
 * tables were ever confused. There is a test asserting exactly that.
 */
export function hashResetCode(code: string): string {
  return crypto
    .createHmac('sha256', env.OTP_HMAC_SECRET)
    .update(`${CODE_DOMAIN}${code}`)
    .digest('hex');
}

/**
 * Constant-time comparison of a submitted code against a stored digest.
 *
 * Compares the **digests**, so both sides are a fixed length:
 * `timingSafeEqual` cannot throw on a length mismatch, and the comparison
 * leaks nothing about how many leading digits were right. Same construction as
 * `verifyOtp`.
 */
export function verifyResetCode(submitted: string, storedHash: string): boolean {
  const candidate = Buffer.from(hashResetCode(submitted), 'hex');
  const expected = Buffer.from(storedHash, 'hex');

  // A malformed stored digest can never match; bail before timingSafeEqual
  // throws on it.
  if (candidate.length !== expected.length || expected.length === 0) return false;

  return crypto.timingSafeEqual(candidate, expected);
}

/**
 * A digest that nothing can match, for the no-account path.
 *
 * Comparing against this makes the unknown-identifier branch do the same
 * HMAC-and-compare work a wrong guess does, so the two are not trivially
 * distinguishable. Best-effort: the database write on the success path is not
 * equalised, and tests assert response equality rather than timing.
 */
const UNMATCHABLE_DIGEST = crypto
  .createHmac('sha256', 'password-reset-dummy-digest')
  .update('no-such-account')
  .digest('hex');

/** A cryptographically random {@link RESET_CODE_LENGTH}-digit code. */
export function generateResetCode(): string {
  const max = 10 ** RESET_CODE_LENGTH;
  // randomInt over the whole range: rejection-sampled and unbiased. Padded so
  // a leading zero is never silently dropped.
  return String(crypto.randomInt(0, max)).padStart(RESET_CODE_LENGTH, '0');
}

/**
 * Whether a generated reset code may be printed to the server console.
 *
 * A pure function of the environment name, exported so the guard is directly
 * testable — including against values not in the enum, in case `NODE_ENV` is
 * unset or misspelled. Anything that is not `development` or `test` answers
 * false: the default must be silence, not printing a working reset code into
 * whatever collects stdout. Mirrors `mayPrintOtp`.
 */
export function mayPrintResetCode(nodeEnv: string): boolean {
  return nodeEnv === 'development' || nodeEnv === 'test';
}

/**
 * Delivers a reset code through the {@link resetSender} seam.
 *
 * The outcome is **logged and discarded**. `/auth/password/forgot` must answer
 * byte-identically for every input — registered email, unknown email,
 * registered phone, unknown phone, a user with no verified phone, a user whose
 * daily send cap is spent — because any observable difference turns the
 * endpoint into an account-enumeration oracle.
 *
 * So nothing here throws, and nothing here changes what the caller returns.
 */
export async function deliverPasswordReset(params: {
  userId: string;
  code: string;
  expiresAt: Date;
}): Promise<void> {
  try {
    const outcome = await resetSender.send({
      userId: params.userId,
      code: params.code,
      expiresAt: params.expiresAt,
    });

    if (outcome.status !== 'SENT') {
      // Diagnostic only. The user is told nothing either way.
      logger.info(
        { sender: resetSender.name, status: outcome.status, reason: outcome.reason },
        'Password reset code was not delivered',
      );
    }
  } catch (cause) {
    // A sender is contractually not supposed to throw. If one does, it must not
    // change the response shape — that is the whole property.
    logger.error(
      { reason: cause instanceof Error ? cause.message : 'unknown' },
      'Password reset sender threw',
    );
  }
}

/** Resolves an email-or-phone identifier to a user id, or null. */
async function findUserByIdentifier(identifier: string): Promise<{ id: string } | null> {
  const needle = identifier.trim();
  const byPhone = classifyIdentifier(needle) === 'phone';

  return prisma.user.findUnique({
    where: byPhone ? { phone: needle } : { email: needle.toLowerCase() },
    select: { id: true },
  });
}

export interface ResetRequestOutcome {
  /** The user, or null when the identifier matched nobody. */
  userId: string | null;
}

/**
 * Mints a reset code for an identifier, if it belongs to an account.
 *
 * **Returns the same shape either way.** The route answers identically and
 * audits the difference server-side.
 *
 * A code is generated and hashed even when there is no account, so the
 * cryptographic work does not depend on the answer. The database write does,
 * and that is not hidden — a remote attacker measuring it through network
 * jitter is not a threat this defeats, and a sleep long enough to mask it would
 * be a self-inflicted denial of service.
 */
export async function requestPasswordReset(input: {
  identifier: string;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<ResetRequestOutcome> {
  const user = await findUserByIdentifier(input.identifier);

  // Generated unconditionally: see the note above.
  const code = generateResetCode();
  const codeHash = hashResetCode(code);
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);

  if (!user) return { userId: null };

  await prisma.$transaction(async (tx) => {
    /**
     * Supersede anything outstanding, so exactly one code is live.
     *
     * Without this, "5 attempts per code" would quietly become "5 per
     * request", and the request endpoint is the one a caller can trigger
     * repeatedly. The minimum-interval limiter bounds how often that is
     * possible, but the invariant must not depend on it.
     */
    await tx.passwordResetCode.updateMany({
      where: { userId: user.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    await tx.passwordResetCode.create({
      data: {
        userId: user.id,
        codeHash,
        expiresAt,
        requestedIp: input.ip ?? null,
        userAgent: input.userAgent?.slice(0, 500) ?? null,
      },
    });
  });

  if (mayPrintResetCode(env.NODE_ENV)) {
    // Deliberately `console.log`, not the logger: pino output is shipped to log
    // storage, and a code that reaches log storage has outlived its 15 minutes.
    // eslint-disable-next-line no-console -- dev only, see mayPrintResetCode
    console.log(`\n  [dev] Password reset code: ${code}  (expires ${expiresAt.toISOString()})\n`);
  }

  await deliverPasswordReset({ userId: user.id, code, expiresAt });

  return { userId: user.id };
}

/**
 * The single answer to every redemption failure.
 *
 * Unknown identifier, no outstanding code, wrong code, expired, already used,
 * attempts exhausted — all of it. One status, one code, one message.
 */
function invalidCode(): HttpError {
  return new HttpError({
    status: 400,
    code: ERROR_CODES.RESET_CODE_INVALID,
    message: 'That code is invalid or has expired. Please request a new one.',
  });
}

export interface CompleteResetResult {
  userId: string;
}

/**
 * Redeems a code: sets the new password and ends every session.
 *
 * Order of operations, and why:
 *
 * 1. Resolve the identifier. No account → do the comparison work anyway, then
 *    answer `invalidCode()`.
 * 2. **Spend an attempt atomically.** The increment's `where` carries
 *    `attempts < RESET_CODE_MAX_ATTEMPTS`, `consumedAt: null` and an unexpired
 *    `expiresAt`, so the limit is enforced *by the same statement* that
 *    increments. N concurrent wrong guesses therefore cost N attempts and stop
 *    at the cap — none of them gets a free guess, and the cap cannot be
 *    overshot. This is the property an 8-digit code depends on.
 * 3. Only then compare, in constant time.
 * 4. On success, claim the row with a conditional update so two concurrent
 *    correct submissions cannot both reset the password.
 *
 * Does **not** issue a session: completing a reset proves control of a delivery
 * channel, which is enough to set a password and then be asked to sign in.
 */
export async function completePasswordReset(input: {
  identifier: string;
  code: string;
  password: string;
}): Promise<CompleteResetResult> {
  const user = await findUserByIdentifier(input.identifier);

  if (!user) {
    // Equivalent work, same answer. Best-effort: see UNMATCHABLE_DIGEST.
    verifyResetCode(input.code, UNMATCHABLE_DIGEST);
    throw invalidCode();
  }

  const challenge = await prisma.passwordResetCode.findFirst({
    where: { userId: user.id, consumedAt: null },
    orderBy: { createdAt: 'desc' },
    select: { id: true, codeHash: true, expiresAt: true, attempts: true },
  });

  if (!challenge) {
    verifyResetCode(input.code, UNMATCHABLE_DIGEST);
    throw invalidCode();
  }

  /**
   * Spend an attempt, and enforce the limit, in one statement.
   *
   * `count === 0` means the row was consumed, expired, or already at the cap —
   * including by a request racing this one. All of those are the same answer,
   * and crucially **the correct code also fails here** once the attempts are
   * gone: there is no branch that checks the digest before spending an attempt.
   */
  const spent = await prisma.passwordResetCode.updateMany({
    where: {
      id: challenge.id,
      consumedAt: null,
      attempts: { lt: RESET_CODE_MAX_ATTEMPTS },
      expiresAt: { gt: new Date() },
    },
    data: { attempts: { increment: 1 } },
  });

  if (spent.count !== 1) {
    // Close the row if it is still open, so a dead challenge does not linger.
    await consume(challenge.id);
    throw invalidCode();
  }

  if (!verifyResetCode(input.code, challenge.codeHash)) {
    /**
     * Re-read to decide whether that was the last attempt.
     *
     * Only the *limit* needs to be atomic, and it already is — this read just
     * decides whether to also close the row. A concurrent guess advancing the
     * counter in between is harmless: `consume` is idempotent and only runs at
     * or past the cap.
     */
    const after = await prisma.passwordResetCode.findUnique({
      where: { id: challenge.id },
      select: { attempts: true },
    });

    if ((after?.attempts ?? 0) >= RESET_CODE_MAX_ATTEMPTS) {
      await consume(challenge.id);
      // Worth a line: five wrong codes against one reset is either someone who
      // cannot read their message or someone guessing. The code never appears.
      logger.warn(
        { userId: user.id, attempts: after?.attempts ?? 0 },
        'Password reset code exhausted its attempts',
      );
      throw exhausted();
    }

    throw invalidCode();
  }

  // Hashed outside the transaction: argon2 costs real time by design, and
  // holding a transaction open across it pins a connection for no reason.
  const passwordHash = await hashPassword(input.password);

  const claimed = await prisma.$transaction(async (tx) => {
    const claim = await tx.passwordResetCode.updateMany({
      where: { id: challenge.id, consumedAt: null, expiresAt: { gt: new Date() } },
      data: { consumedAt: new Date() },
    });

    if (claim.count !== 1) return false;

    await tx.user.update({
      where: { id: user.id },
      data: { passwordHash },
      select: { id: true },
    });

    return true;
  });

  if (!claimed) throw invalidCode();

  /**
   * Outside the transaction on purpose: the password is already changed, and a
   * failure to revoke must not roll that back.
   *
   * `PASSWORD_RESET`, not the reuse cascade — a device still holding one of
   * these will present it shortly, and that is ordinary rather than theft. See
   * the revokedReason decision in docs/decisions.md.
   */
  await revokeAllForUser(user.id, 'PASSWORD_RESET');

  return { userId: user.id };
}

/**
 * Attempts exhausted.
 *
 * Carries the **same** status, code and message as every other failure — the
 * distinction exists only so the route can audit it. Telling the caller "that
 * code is now dead" would confirm the account exists.
 */
class ExhaustedError extends HttpError {
  readonly exhausted = true;
}

function exhausted(): ExhaustedError {
  return new ExhaustedError({
    status: 400,
    code: ERROR_CODES.RESET_CODE_INVALID,
    message: 'That code is invalid or has expired. Please request a new one.',
  });
}

export function wasExhausted(error: unknown): boolean {
  return error instanceof ExhaustedError;
}

/** Marks a code dead. Idempotent — only an open row is touched. */
async function consume(id: string): Promise<void> {
  await prisma.passwordResetCode.updateMany({
    where: { id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
}

/**
 * Deletes reset codes that can no longer authorise anything.
 *
 * Unlike refresh tokens there is no reuse-detection reason to keep a consumed
 * row: replaying a dead code and submitting an unknown one answer identically
 * by design, so nothing distinguishes them at request time anyway. Callable
 * from `scripts/cleanupRefreshTokens.ts`.
 */
export async function cleanupPasswordResetCodes(
  options: { consumedRetentionDays?: number; now?: Date } = {},
): Promise<{ deleted: number }> {
  const now = options.now ?? new Date();
  const retentionDays = options.consumedRetentionDays ?? 7;
  const consumedBefore = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);

  const result = await prisma.passwordResetCode.deleteMany({
    where: {
      OR: [{ expiresAt: { lt: now } }, { consumedAt: { lt: consumedBefore } }],
    },
  });

  return { deleted: result.count };
}
