import crypto from 'node:crypto';
import { OTP_LENGTH } from '@safelock/shared';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { loadRecipient, sendWhatsApp, type SendOutcome } from '../../lib/whatsapp/send';

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
 * 3. The plaintext code leaves this module exactly twice: to the WhatsApp
 *    client as a template parameter, and (outside production) to the console.
 *    It is never returned by an endpoint, never written to an audit row, never
 *    written to a DeviceEvent, and never queued — the outbox stores no
 *    template parameters precisely so a code cannot reach a table.
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
 * Delivers an unlock code over WhatsApp.
 *
 * ## Sent inline, not through the outbox
 * The user is standing in front of the dashboard waiting for it. A queued
 * message that arrives after a retry backoff is a code that has already
 * expired, and the outbox structurally cannot carry one anyway: it stores no
 * template parameters, because a code must never be written to a table.
 * See `lib/outbox/params.ts`.
 *
 * ## The outcome matters to the caller
 * Unlike the notifier, this returns its outcome rather than swallowing it.
 * A code nobody received is worse than an error: the user would sit waiting
 * for a message that is never coming, and a challenge would be left open for
 * five minutes with a code only an attacker could have. `requestUnlock`
 * invalidates the challenge and answers `OTP_DELIVERY_FAILED`.
 *
 * The dev console print survives, still behind {@link mayPrintOtp}, because
 * local development has no WhatsApp number to message.
 */
export async function deliverOtp(params: {
  userId: string;
  code: string;
  serialNumber: string;
  expiresAt: Date;
}): Promise<SendOutcome> {
  if (mayPrintOtp(env.NODE_ENV)) {
    // Deliberately `console.log`, not the logger: pino output is shipped to
    // log storage, and a code that reaches log storage has outlived its 5
    // minutes. This line is for a developer watching their own terminal, and
    // the `mayPrintOtp` guard is what keeps it out of production.
    // eslint-disable-next-line no-console -- see above; the only console call in the API
    console.log(
      `\n  [dev] Unlock code for ${params.serialNumber}: ${params.code}` +
        `  (expires ${params.expiresAt.toISOString()})\n`,
    );
  }

  const recipient = await loadRecipient(params.userId);
  if (!recipient) {
    logger.error({ userId: params.userId }, 'No recipient for an unlock code');
    return { status: 'SKIPPED', reason: 'NO_VERIFIED_PHONE' };
  }

  /**
   * The unlock code ignores the daily cap on purpose.
   *
   * Everything else a cap protects — cost, spam — is bounded here by the
   * unlock rate limiter (3 codes per 10 minutes per user) and by the fact
   * that only a paid owner with a verified number can reach this at all.
   * Letting a cap lock someone out of their own safe would be the cap doing
   * more harm than the abuse it exists to prevent.
   */
  /**
   * **The code, and nothing else.**
   *
   * `safelock_unlock_code` is an AUTHENTICATION template, and Meta's layout
   * for that category permits exactly one body parameter: the code. Passing
   * the serial as a second one is rejected as a `TEMPLATE` error — which is
   * terminal and never retried, so the user would get no code at all and the
   * challenge would be compensated away. A live bug until now, and the worst
   * possible place to have one.
   *
   * Nothing is lost. A user has at most one live booking, so the message is
   * unambiguous about which safe it is for, and the serial is already carried
   * by `safelock_unlock_alert`, a UTILITY template where a second parameter is
   * allowed. The dev console print above still names the safe, because that
   * line is for a developer with several seeded devices.
   */
  return sendWhatsApp({
    recipient,
    kind: 'UNLOCK_OTP',
    params: [params.code],
    ignoreCap: true,
  });
}
