import Razorpay from 'razorpay';
import { ERROR_CODES } from '@safelock/shared';
import { env } from '../config/env';
import { HttpError } from './httpError';
import { logger } from './logger';

/**
 * Razorpay SDK wrapper.
 *
 * The client is built lazily and cached, so importing this module has no side
 * effects and tests can replace the `razorpay` package before first use.
 *
 * `RAZORPAY_KEY_SECRET` is read here and in `payments/signature.ts` and
 * nowhere else. It is never logged and never sent to a client.
 */

let client: Razorpay | null = null;

export function razorpayClient(): Razorpay {
  client ??= new Razorpay({
    key_id: env.RAZORPAY_KEY_ID,
    key_secret: env.RAZORPAY_KEY_SECRET,
  });
  return client;
}

/** Test seam: drops the cached client so a fresh mock is picked up. */
export function resetRazorpayClient(): void {
  client = null;
}

export interface CreatedOrder {
  id: string;
  amount: number;
  currency: string;
}

/**
 * Creates a Razorpay order.
 *
 * `amountInPaise` always comes from server config. `receipt` is our own
 * Payment row id, which is how a webhook or a dashboard entry can be traced
 * back to a user without trusting anything the client said.
 */
export async function createRazorpayOrder(params: {
  amountInPaise: number;
  currency: string;
  receipt: string;
  notes: Record<string, string>;
  /**
   * Unix seconds after which Razorpay refuses a payment attempt.
   *
   * Set from the booking hold or the overstay quote TTL, so the gateway
   * rejects most late attempts before they ever reach our webhook — the
   * cheapest place to stop them. What gets through is still handled.
   */
  expireBy?: number;
}): Promise<CreatedOrder> {
  try {
    const order = await razorpayClient().orders.create({
      amount: params.amountInPaise,
      currency: params.currency,
      receipt: params.receipt,
      notes: params.notes,
      ...(params.expireBy ? { expire_by: params.expireBy } : {}),
      // Razorpay may only capture up to the order amount; auto-capture avoids
      // a separate capture call for a one-time purchase.
      payment_capture: true,
    });

    return {
      id: String(order.id),
      amount: Number(order.amount),
      currency: String(order.currency),
    };
  } catch (cause) {
    // The SDK error can contain the request payload; log only a safe summary.
    logger.error(
      {
        receipt: params.receipt,
        reason: cause instanceof Error ? cause.message : 'unknown',
      },
      'razorpay.orders.create failed',
    );

    throw new HttpError({
      status: 502,
      code: ERROR_CODES.PAYMENT_GATEWAY_ERROR,
      message: 'Could not reach the payment gateway. Please try again in a moment.',
    });
  }
}
