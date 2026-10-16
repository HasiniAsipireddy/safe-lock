import crypto from 'node:crypto';
import { env } from '../../config/env';

/**
 * `X-Hub-Signature-256` verification for the WhatsApp delivery webhook.
 *
 * Meta signs the **raw request body bytes** with the app secret and sends
 * `sha256=<hex>`. Re-serialising parsed JSON would change the bytes — key
 * order, whitespace, unicode escaping — and the signature would never match,
 * which is why the route parses its own body with `express.raw()`.
 *
 * Modelled on `modules/payments/signature.ts`, which does the same job for
 * Razorpay. Kept separate rather than generalised: they use different secrets,
 * different header names and different prefixes, and a shared helper taking
 * all three as parameters would be harder to audit than two short files.
 */

/** The signature Meta should have sent for this body. */
export function expectedSignature(rawBody: Buffer | string): string {
  if (!env.WHATSAPP_APP_SECRET) {
    // Unreachable in cloud mode: the env schema requires it. Thrown rather
    // than returning a value that could accidentally compare equal.
    throw new Error('WHATSAPP_APP_SECRET is not configured');
  }

  return crypto
    .createHmac('sha256', env.WHATSAPP_APP_SECRET)
    .update(rawBody)
    .digest('hex');
}

/**
 * Whether the header matches the body.
 *
 * Returns false — never throws — for a missing, malformed, wrong-length or
 * wrong-prefix header, so every bad signature takes the same path and the
 * route can answer 401 uniformly.
 */
export function verifySignature(
  rawBody: Buffer | string,
  header: string | undefined,
): boolean {
  if (!header) return false;

  // Meta's format. Anything else is not a signature we can check.
  const prefix = 'sha256=';
  if (!header.startsWith(prefix)) return false;

  const provided = header.slice(prefix.length);
  if (!/^[a-f0-9]{64}$/i.test(provided)) return false;

  const expected = expectedSignature(rawBody);

  // Both are now known to be 64 hex chars, so timingSafeEqual cannot throw on
  // a length mismatch — and comparing in constant time is what stops an
  // attacker learning the correct signature a byte at a time.
  return crypto.timingSafeEqual(
    Buffer.from(expected, 'hex'),
    Buffer.from(provided.toLowerCase(), 'hex'),
  );
}

/**
 * Meta's subscription handshake.
 *
 * Meta GETs the webhook with `hub.mode=subscribe`, `hub.verify_token` and
 * `hub.challenge`, and expects the challenge echoed back verbatim. The token
 * is compared in constant time: it is a shared secret, and the handshake is a
 * public endpoint anyone can call repeatedly.
 */
export function verifyHandshakeToken(token: string | undefined): boolean {
  if (!token || !env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) return false;

  const expected = Buffer.from(env.WHATSAPP_WEBHOOK_VERIFY_TOKEN, 'utf8');
  const provided = Buffer.from(token, 'utf8');

  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(expected, provided);
}
