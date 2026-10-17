import crypto from 'node:crypto';
import {
  ERROR_CODES,
  type BookingOrderResponse,
  type PaymentPurpose,
} from '@safelock/shared';
import { env } from '../../config/env';
import { HttpError, conflict } from '../../lib/httpError';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { createRazorpayOrder } from '../../lib/razorpay';
import {
  assertExtendable,
  getBookingForUser,
  stateInvalid,
} from '../bookings/booking.service';
import { outstandingFeePaise } from '../bookings/booking.mapper';

/**
 * Razorpay orders for bookings, extensions and overstay fees.
 *
 * ## The amount is always ours
 * Every figure here is computed server-side from the booking's **snapshotted**
 * rates. No code path reads an amount from a request body, and a client that
 * posts one is rejected by the route's `.strict()` schema. This is the same
 * invariant the one-time purchase flow had; only the source of the number
 * changed.
 *
 * ## Why an order carries an expiry
 * A booking's hold lapses, and an overstay fee grows. Razorpay's own
 * `expire_by` refuses most late attempts before they ever reach us, which is
 * the cheapest place to stop them. What gets through is handled by the webhook
 * — see `applyBookingPayment`.
 */

const SECONDS = 1000;

/** Razorpay wants a Unix timestamp in seconds, and at least a few minutes out. */
function expireBy(at: Date): number {
  return Math.floor(at.getTime() / SECONDS);
}

async function createOrderRow(input: {
  userId: string;
  bookingId: string;
  purpose: PaymentPurpose;
  amount: number;
  quoteExpiresAt: Date | null;
  expireAt: Date;
}): Promise<BookingOrderResponse> {
  const paymentId = crypto.randomUUID();
  const currency = env.CURRENCY;

  const order = await createRazorpayOrder({
    amountInPaise: input.amount,
    currency,
    // The row id as the receipt, so a dashboard entry or a webhook traces back
    // to a row, a booking and a user without trusting anything the browser said.
    receipt: paymentId,
    notes: {
      userId: input.userId,
      bookingId: input.bookingId,
      purpose: input.purpose,
    },
    expireBy: expireBy(input.expireAt),
  });

  // Trust our own figures, but refuse to proceed if the gateway created an
  // order for something else.
  if (order.amount !== input.amount || order.currency !== currency) {
    logger.error(
      {
        requestedAmount: input.amount,
        returnedAmount: order.amount,
        purpose: input.purpose,
      },
      'Razorpay order amount mismatch',
    );
    throw new HttpError({
      status: 502,
      code: ERROR_CODES.PAYMENT_GATEWAY_ERROR,
      message: 'The payment gateway returned an unexpected order. Please try again.',
    });
  }

  await prisma.payment.create({
    data: {
      id: paymentId,
      userId: input.userId,
      bookingId: input.bookingId,
      purpose: input.purpose,
      razorpayOrderId: order.id,
      amount: input.amount,
      currency,
      status: 'CREATED',
      quoteExpiresAt: input.quoteExpiresAt,
    },
  });

  return {
    orderId: order.id,
    amount: input.amount,
    currency,
    // The publishable key id only. The key secret never leaves the server.
    keyId: env.RAZORPAY_KEY_ID,
    paymentId,
    purpose: input.purpose,
    quoteExpiresAt: input.quoteExpiresAt ? input.quoteExpiresAt.toISOString() : null,
  };
}

/**
 * An order for the booking itself.
 *
 * The order expires **with the hold**, so a payment arriving after the safe
 * has been released is rare rather than routine. The webhook still handles the
 * case, because "rare" is not "impossible".
 */
export async function createBookingOrder(input: {
  userId: string;
  bookingId: string;
  now?: Date;
}): Promise<BookingOrderResponse> {
  const now = input.now ?? new Date();
  const booking = await getBookingForUser(input.bookingId, input.userId);

  if (booking.status !== 'PENDING_PAYMENT') {
    throw stateInvalid('This booking is not awaiting payment.');
  }

  if (booking.holdExpiresAt && booking.holdExpiresAt.getTime() <= now.getTime()) {
    throw stateInvalid('This booking’s hold has expired. Please book again.');
  }

  return createOrderRow({
    userId: input.userId,
    bookingId: booking.id,
    purpose: 'BOOKING',
    amount: booking.pricePaise,
    quoteExpiresAt: null,
    expireAt: booking.holdExpiresAt ?? new Date(now.getTime() + 10 * 60 * SECONDS),
  });
}

/** An order for an extension. Priced from the booking's snapshot. */
export async function createExtensionOrder(input: {
  userId: string;
  bookingId: string;
  hours: number;
  now?: Date;
}): Promise<BookingOrderResponse> {
  const now = input.now ?? new Date();
  const booking = await getBookingForUser(input.bookingId, input.userId);

  const { pricePaise } = await assertExtendable(booking, input.hours, now);

  return createOrderRow({
    userId: input.userId,
    bookingId: booking.id,
    purpose: 'EXTENSION',
    amount: pricePaise,
    quoteExpiresAt: null,
    // An extension is not time-sensitive in the way a quote is, but an order
    // that lives forever is one someone can pay against much later.
    expireAt: new Date(now.getTime() + env.OVERSTAY_QUOTE_TTL_MINUTES * 60 * SECONDS),
  });
}

/**
 * An order for the outstanding overstay fee.
 *
 * The quote is **binding for `OVERSTAY_QUOTE_TTL_MINUTES`** and the Razorpay
 * order carries the same expiry. Fees keep accruing meanwhile; what happens to
 * a capture that arrives late is decided in the webhook, and deliberately not
 * by silently settling less than is owed.
 */
export async function createOverstayOrder(input: {
  userId: string;
  bookingId: string;
  now?: Date;
}): Promise<BookingOrderResponse> {
  const now = input.now ?? new Date();
  const booking = await getBookingForUser(input.bookingId, input.userId);

  const fee = outstandingFeePaise(booking, now);

  if (fee <= 0) {
    throw conflict(
      ERROR_CODES.NOTHING_TO_PAY,
      'There is no overstay fee outstanding on this booking.',
    );
  }

  const quoteExpiresAt = new Date(now.getTime() + env.OVERSTAY_QUOTE_TTL_MINUTES * 60 * SECONDS);

  return createOrderRow({
    userId: input.userId,
    bookingId: booking.id,
    purpose: 'OVERSTAY',
    amount: fee,
    quoteExpiresAt,
    expireAt: quoteExpiresAt,
  });
}
