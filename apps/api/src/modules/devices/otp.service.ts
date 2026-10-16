import crypto from 'node:crypto';
import { OTP_LENGTH } from '@safelock/shared';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';

/**
 * Unlock OTP generation, hashing and (for now) delivery.
 *
 * Three rules this module exists to keep in one place:
 * 1. The code comes from `crypto.randomInt`, never `Math.random` — the latter
 *    is seeded, predictable, and would make the whole flow decorative.
 * 2. Only an HMAC of the code is ever persisted. A 6-digit space is 10^6, so
 *    an unkeyed hash of one is trivially reversible by brute force; the
 *    secret, held outside the database, is what makes the stored digest
 *    useless to someone holding a database dump.
 * 3. The plaintext code leaves this module exactly twice: to the notifier,
 *    and (outside production) to the console. It is never returned by an
 *    endpoint, never written to an audit row, and never written to a
 *    DeviceEvent.
 */

/**
 * A cryptographically random {@link OTP_LENGTH}-digit code, zero-padded.
 *
 * `randomInt` over the whole range rather than digit-by-digit: it is
 * rejection-sampled and unbiased, and padding keeps every code the same
 * length so a leading zero is not silently dropped.
 */
export function generateOtp(): string {
  const max = 10 ** OTP_LENGTH;
  return String(crypto.randomInt(0, max)).padStart(OTP_LENGTH, '0');
}

/** HMAC-SHA256 of a code under `OTP_HMAC_SECRET`, hex. */
export function hashOtp(code: string): string {
  return crypto.createHmac('sha256', env.OTP_HMAC_SECRET).update(code).digest('hex');
}

/**
 * Constant-time comparison of a submitted code against a stored hash.
 *
 * Comparing the *hashes* rather than the codes means both sides are the same
 * fixed length, so `timingSafeEqual` cannot throw on a length mismatch and
 * the comparison leaks nothing about how many leading digits were right.
 */
export function verifyOtp(submitted: string, storedHash: string): boolean {
  const candidate = Buffer.from(hashOtp(submitted), 'hex');
  const expected = Buffer.from(storedHash, 'hex');

  // A malformed stored hash (wrong length) can never match; bail before
  // timingSafeEqual throws on it.
  if (candidate.length !== expected.length) return false;

  return crypto.timingSafeEqual(candidate, expected);
}

/**
 * Whether the generated code may be printed to the server console.
 *
 * Exported as a pure function of the environment name so the guard itself is
 * directly testable — including against values that are not in the enum, in
 * case `NODE_ENV` is ever unset or misspelled. Anything that is not
 * `development` or `test` answers false: the default must be silence.
 */
export function mayPrintOtp(nodeEnv: string): boolean {
  return nodeEnv === 'development' || nodeEnv === 'test';
}

/**
 * Delivers a code to the user.
 *
 * Today that means a console line in development. WhatsApp/SMS delivery is a
 * later step; when it lands it replaces the body of this function and nothing
 * else — callers already treat delivery as fire-and-forget side effect that
 * must not leak the code back into their own return values.
 */
export function deliverOtp(params: {
  code: string;
  serialNumber: string;
  expiresAt: Date;
}): void {
  if (!mayPrintOtp(env.NODE_ENV)) {
    // TODO(whatsapp): send via the notification provider. Until then a
    // production deployment delivers nothing, which is the correct failure
    // mode — better than printing a working unlock code into a log
    // aggregator that half the company can read.
    logger.warn(
      { serialNumber: params.serialNumber },
      'No OTP delivery channel is configured; the code was generated but not sent',
    );
    return;
  }

  // Deliberately `console.log`, not the logger: pino output is shipped to log
  // storage, and a code that reaches log storage has outlived its 5 minutes.
  // This line is for a developer watching their own terminal, and the
  // `mayPrintOtp` guard above is what keeps it out of production.
  // eslint-disable-next-line no-console -- see above; the only console call in the API
  console.log(
    `\n  [dev] Unlock code for ${params.serialNumber}: ${params.code}` +
      `  (expires ${params.expiresAt.toISOString()})\n`,
  );
}
