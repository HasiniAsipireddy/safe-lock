import crypto from 'node:crypto';
import { ERROR_CODES, PASSWORD_RESET_TTL_MS, RESET_TOKEN_BYTES } from '@safelock/shared';
import { env } from '../../config/env';
import { HttpError } from '../../lib/httpError';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { hashPassword } from './password';
import { revokeAllForUser } from './refreshToken.service';

/**
 * Password reset tokens: minting, delivery and redemption.
 *
 * ## Shape, and why it is a plain SHA-256
 * A token is {@link RESET_TOKEN_BYTES} bytes from `crypto.randomBytes`,
 * base64url-encoded, stored only as `sha256(token)` — the same construction as
 * `RefreshToken`, deliberately. There is no `RESET_TOKEN_HMAC_SECRET` and
 * there should not be one: an unkeyed hash is only reversible when the input
 * space is small enough to enumerate, and 2^256 is not. The unlock OTP is an
 * HMAC for exactly that reason — a 6-digit code is 10^6 values, which someone
 * holding a database dump can walk in milliseconds. Adding a key here would
 * protect nothing and add a required secret to every deployment.
 * See docs/decisions.md.
 *
 * ## One live link at a time
 * Requesting a reset consumes any outstanding token for that user, the same
 * discipline `UnlockChallenge` follows. Otherwise every request would leave
 * another working link behind, and an old mail in an inbox would stay live for
 * its full 30 minutes after the user had already used a newer one.
 *
 * ## What redemption does beyond setting the password
 * It revokes **every** refresh token for the user. Someone resetting a
 * password is often doing it because they think somebody else is in the
 * account; leaving the other sessions alive would make the reset cosmetic.
 */

/** SHA-256 hex of a raw token. The only form that is ever persisted. */
export function hashResetToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

function generateRawToken(): string {
  return crypto.randomBytes(RESET_TOKEN_BYTES).toString('base64url');
}

/**
 * Whether a generated reset token may be printed to the server console.
 *
 * A pure function of the environment name, exported so the guard itself is
 * testable — including against values that are not in the enum, in case
 * `NODE_ENV` is unset or misspelled. Anything that is not `development` or
 * `test` answers false: the default must be silence, not printing a working
 * password-reset link into whatever collects stdout.
 *
 * Mirrors `mayPrintOtp` in `modules/devices/otp.service.ts`.
 */
export function mayPrintResetToken(nodeEnv: string): boolean {
  return nodeEnv === 'development' || nodeEnv === 'test';
}

/**
 * Delivers a reset link to the user.
 *
 * Today that means a console line outside production. Email/WhatsApp delivery
 * is the same open question as OTP delivery (see CLAUDE.md) and replaces the
 * body of this function and nothing else.
 *
 * **In production this currently sends nothing** and logs a warning. That is
 * the correct failure mode — better than printing a credential that can take
 * over an account into a log aggregator.
 */
export function deliverPasswordReset(params: { token: string; expiresAt: Date }): void {
  if (!mayPrintResetToken(env.NODE_ENV)) {
    // TODO(reset-delivery): send through the notification provider. Until then
    // password reset does not work in production.
    logger.warn(
      {},
      'No password-reset delivery channel is configured; a token was generated but not sent',
    );
    return;
  }

  // Deliberately `console.log`, not the logger: pino output is shipped to log
  // storage, and a token that reaches log storage has outlived its 30 minutes.
  // This line is for a developer watching their own terminal, and
  // `mayPrintResetToken` is what keeps it out of production.
  // eslint-disable-next-line no-console -- see above
  console.log(
    `\n  [dev] Password reset token: ${params.token}` +
      `  (expires ${params.expiresAt.toISOString()})\n`,
  );
}

export interface ResetRequestOutcome {
  /** The user the token belongs to, or null when the email matched nobody. */
  userId: string | null;
}

/**
 * Mints a reset token for an email address, if it belongs to an account.
 *
 * **Returns the same shape either way** and never reveals which it was to a
 * caller that does not look at `userId`. The route does not: it answers
 * identically and audits the difference server-side.
 *
 * Timing is equalised on a best-effort basis — a token is generated and hashed
 * even when there is no account, so the cryptographic work does not depend on
 * the answer. The database write does, and that is not hidden; a remote
 * attacker measuring that difference through network jitter is not a threat
 * this is built to defeat, and a sleep long enough to mask it would be a
 * self-inflicted denial of service.
 */
export async function requestPasswordReset(input: {
  email: string;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<ResetRequestOutcome> {
  const user = await prisma.user.findUnique({
    where: { email: input.email },
    select: { id: true },
  });

  // Generated unconditionally: see the timing note above.
  const rawToken = generateRawToken();
  const tokenHash = hashResetToken(rawToken);
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);

  if (!user) return { userId: null };

  await prisma.$transaction(async (tx) => {
    // Supersede anything still outstanding, so exactly one link is live.
    await tx.passwordResetToken.updateMany({
      where: { userId: user.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    await tx.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt,
        requestedIp: input.ip ?? null,
        userAgent: input.userAgent?.slice(0, 500) ?? null,
      },
    });
  });

  deliverPasswordReset({ token: rawToken, expiresAt });

  return { userId: user.id };
}

/** Unknown, expired and already-used all answer with this one error. */
function invalidToken(): HttpError {
  return new HttpError({
    status: 400,
    code: ERROR_CODES.RESET_TOKEN_INVALID,
    message: 'That reset link is invalid or has expired. Please request a new one.',
  });
}

/**
 * Redeems a token: sets the new password and ends every session.
 *
 * The claim is a conditional `updateMany` whose `where` carries both
 * preconditions (`consumedAt: null`, not expired), so two concurrent
 * redemptions of one token cannot both win — the loser sees `count === 0` and
 * gets the same invalid-token error as any other dead link.
 *
 * Does **not** issue a session. Completing a reset proves control of a
 * delivery channel, which is enough to set a password and then be asked to
 * sign in with it.
 */
export async function completePasswordReset(input: {
  token: string;
  password: string;
}): Promise<{ userId: string }> {
  const tokenHash = hashResetToken(input.token);

  const row = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
    select: { id: true, userId: true, expiresAt: true, consumedAt: true },
  });

  if (!row) throw invalidToken();
  if (row.consumedAt) throw invalidToken();
  if (row.expiresAt.getTime() <= Date.now()) throw invalidToken();

  // Hashed outside the transaction: argon2 takes real time by design, and
  // holding a transaction open across it would pin a connection for no reason.
  const passwordHash = await hashPassword(input.password);

  const claimed = await prisma.$transaction(async (tx) => {
    const claim = await tx.passwordResetToken.updateMany({
      where: { id: row.id, consumedAt: null, expiresAt: { gt: new Date() } },
      data: { consumedAt: new Date() },
    });

    if (claim.count !== 1) return false;

    await tx.user.update({
      where: { id: row.userId },
      data: { passwordHash },
      select: { id: true },
    });

    return true;
  });

  if (!claimed) throw invalidToken();

  // Outside the transaction on purpose: the password is already changed, and a
  // failure to revoke must not roll that back. It is logged by the caller's
  // error path instead, and the sessions are 15-minute access tokens at worst.
  //
  // PASSWORD_RESET rather than the reuse cascade: a device still holding one
  // of these will present it shortly, and that is ordinary rather than theft.
  await revokeAllForUser(row.userId, 'PASSWORD_RESET');

  return { userId: row.userId };
}

/**
 * Deletes reset tokens that can no longer authorise anything.
 *
 * Unlike refresh tokens, there is no reuse-detection reason to keep a consumed
 * row around: replaying a reset link is not a signal worth distinguishing from
 * an expired one, since both answer identically. Callable alongside
 * `cleanupRefreshTokens` from `scripts/cleanupRefreshTokens.ts`.
 */
export async function cleanupPasswordResetTokens(
  options: { consumedRetentionDays?: number; now?: Date } = {},
): Promise<{ deleted: number }> {
  const now = options.now ?? new Date();
  const retentionDays = options.consumedRetentionDays ?? 7;
  const consumedBefore = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);

  const result = await prisma.passwordResetToken.deleteMany({
    where: {
      OR: [{ expiresAt: { lt: now } }, { consumedAt: { lt: consumedBefore } }],
    },
  });

  return { deleted: result.count };
}
