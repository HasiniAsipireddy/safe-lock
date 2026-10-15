import crypto from 'node:crypto';
import { env } from '../../config/env';

/**
 * Razorpay signature verification.
 *
 * Two different signatures, two different secrets:
 *
 * 1. **Checkout callback** — HMAC-SHA256 of `"<order_id>|<payment_id>"` keyed
 *    with `RAZORPAY_KEY_SECRET`.
 * 2. **Webhook** — HMAC-SHA256 of the *raw request body bytes* keyed with
 *    `RAZORPAY_WEBHOOK_SECRET`. Re-serialising the parsed JSON would change
 *    the bytes and the signature would never match.
 *
 * Both comparisons go through `crypto.timingSafeEqual`, which needs equal
 * buffer lengths — hence the length guard before comparing.
 */

function timingSafeEqualHex(expectedHex: string, providedHex: string): boolean {
  // timingSafeEqual throws on a length mismatch, which would itself leak
  // information through an exception path. Compare lengths first.
  if (expectedHex.length !== providedHex.length) return false;

  const expected = Buffer.from(expectedHex, 'hex');
  const provided = Buffer.from(providedHex, 'hex');
  if (expected.length !== provided.length || expected.length === 0) return false;

  return crypto.timingSafeEqual(expected, provided);
}

/** The signature Razorpay Checkout should have returned for this order. */
export function expectedCheckoutSignature(orderId: string, paymentId: string): string {
  return crypto
    .createHmac('sha256', env.RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
}

export function verifyCheckoutSignature(params: {
  orderId: string;
  paymentId: string;
  signature: string;
}): boolean {
  return timingSafeEqualHex(
    expectedCheckoutSignature(params.orderId, params.paymentId),
    params.signature,
  );
}

/** The signature Razorpay should have sent in `X-Razorpay-Signature`. */
export function expectedWebhookSignature(rawBody: Buffer | string): string {
  return crypto
    .createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
}

export function verifyWebhookSignature(rawBody: Buffer | string, signature: string): boolean {
  return timingSafeEqualHex(expectedWebhookSignature(rawBody), signature);
}
