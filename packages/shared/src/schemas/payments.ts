import { z } from 'zod';

/**
 * Body of `POST /payments/verify` — exactly the three fields Razorpay
 * Checkout hands to its success handler.
 *
 * Note what is *not* here: an amount. The price is read from server config on
 * every request, so a tampered client cannot pay less than the real price.
 */
export const verifyPaymentSchema = z.object({
  razorpay_order_id: z
    .string()
    .trim()
    .min(1, 'razorpay_order_id is required')
    .max(64)
    .regex(/^order_[A-Za-z0-9]+$/, 'Malformed Razorpay order id'),
  razorpay_payment_id: z
    .string()
    .trim()
    .min(1, 'razorpay_payment_id is required')
    .max(64)
    .regex(/^pay_[A-Za-z0-9]+$/, 'Malformed Razorpay payment id'),
  // HMAC-SHA256, hex encoded: always 64 lowercase hex characters.
  razorpay_signature: z
    .string()
    .trim()
    .min(1, 'razorpay_signature is required')
    .regex(/^[a-f0-9]{64}$/i, 'Malformed Razorpay signature'),
});

export type VerifyPaymentInput = z.infer<typeof verifyPaymentSchema>;

/**
 * `POST /payments/order` takes no input at all. Declared explicitly so the
 * validate middleware can reject a body that tries to smuggle in an amount.
 */
export const createOrderSchema = z.object({}).strict();
