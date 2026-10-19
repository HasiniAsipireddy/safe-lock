import crypto from 'node:crypto';

/**
 * Signing and verifying a canonical string under a device's command key.
 *
 * **The signature is what makes a compromised broker survivable.** A broker
 * that can read every packet, inject any packet and impersonate the server
 * still cannot produce a valid `sig`, so it cannot open a safe — which is why
 * the broker ACL is described as the second line of defence rather than the
 * first.
 *
 * `base64url`, not hex: it is half the bytes on a radio link that is the
 * expensive part of this system, and it has no padding to disagree about.
 */

export function signCanonical(key: Buffer, canonical: string): string {
  return crypto.createHmac('sha256', key).update(canonical).digest('base64url');
}

/**
 * Whether a signature matches, compared in constant time.
 *
 * Returns false — never throws — for a missing, malformed or wrong-length
 * signature, so every bad signature takes one path and the caller can drop and
 * audit uniformly. An exception here would turn a hostile publish into a 500
 * and a stack trace, and the one thing a forged device report must produce is
 * a shrug.
 *
 * Constant-time matters even though a device signature is not a password: the
 * broker is a party we have assumed may be hostile, and it can replay a
 * candidate ack as often as it likes. A byte-at-a-time oracle against an
 * HMAC-SHA256 is only useful if we hand it one.
 */
export function verifyCanonical(
  key: Buffer,
  canonical: string,
  provided: unknown,
): boolean {
  if (typeof provided !== 'string' || provided.length === 0) return false;

  const expected = signCanonical(key, canonical);

  const expectedBytes = Buffer.from(expected, 'base64url');
  let providedBytes: Buffer;

  try {
    providedBytes = Buffer.from(provided, 'base64url');
  } catch {
    return false;
  }

  /**
   * A length check before `timingSafeEqual`, which throws on a mismatch.
   *
   * This leaks the length of a 32-byte constant, which is public. It is also
   * not a short-circuit on *content*, so it gives up nothing about the key.
   */
  if (expectedBytes.length !== providedBytes.length) return false;

  return crypto.timingSafeEqual(expectedBytes, providedBytes);
}
