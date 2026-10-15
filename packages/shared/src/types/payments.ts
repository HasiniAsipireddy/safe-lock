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
}

/** Response body of `GET /payments/me`. */
export interface PaymentMeResponse {
  hasPaid: boolean;
  /** The most recent payment attempt, or null if the user never started one. */
  payment: PaymentSummary | null;
  /** Current activation price in paise, straight from the server config. */
  priceInPaise: number;
  currency: string;
}

/**
 * Response body of `POST /payments/order`.
 *
 * `keyId` is the Razorpay **publishable** key id. The key *secret* never
 * leaves the server.
 */
export interface CreateOrderResponse {
  orderId: string;
  amount: number;
  currency: string;
  keyId: string;
  paymentId: string;
}

/** Request body of `POST /payments/verify` — the three fields Checkout returns. */
export interface VerifyPaymentRequest {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

/** Response body of `POST /payments/verify`. */
export interface VerifyPaymentResponse {
  payment: PaymentSummary;
  hasPaid: boolean;
}
