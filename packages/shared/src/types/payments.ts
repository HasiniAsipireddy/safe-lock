import type { PaymentPurpose } from './bookings';

/** Mirrors the Prisma `PaymentStatus` enum. */
export type PaymentStatus = 'CREATED' | 'PAID' | 'FAILED' | 'REFUNDED';

/**
 * The safe-to-expose view of a Payment row. Never carries the Razorpay
 * signature or any secret.
 */
export interface PaymentSummary {
  id: string;
  /** Integer paise. Format for display with {@link formatInr}. */
  amount: number;
  currency: string;
  status: PaymentStatus;
  razorpayOrderId: string;
  createdAt: string;
  paidAt: string | null;
  /** What this payment bought. Every payment belongs to a booking now. */
  purpose: PaymentPurpose;
  bookingId: string | null;
}

/** Request body of `POST /payments/verify` — the three fields Checkout returns. */
export interface VerifyPaymentRequest {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

/**
 * Response body of `POST /payments/verify`.
 *
 * `needsReview` must **not** be rendered as plain success. It means the money
 * arrived and could not be applied — a booking hold that lapsed and whose safe
 * was taken, or an overstay quote that expired while the fee grew past it. The
 * payment row stays `PAID` (we never pretend a payment did not happen) and is
 * queued for a manual refund. The UI says so and points at support.
 */
export interface VerifyPaymentResponse {
  payment: PaymentSummary;
  needsReview: boolean;
}
