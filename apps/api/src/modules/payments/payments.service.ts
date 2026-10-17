import {
  ERROR_CODES,
  type PaymentPurpose,
  type PaymentStatus,
  type PaymentSummary,
} from '@safelock/shared';
import { prisma } from '../../lib/prisma';
import type { PrismaTransaction } from '../../lib/prisma';
import { HttpError, forbidden, notFound } from '../../lib/httpError';
import { logger } from '../../lib/logger';
import { applyBookingPayment } from './booking.settlement';
import { verifyCheckoutSignature } from './signature';

/**
 * Payment service.
 *
 * Three invariants hold everywhere in this file:
 *
 * 1. **The amount is always a server figure**, computed from a booking's
 *    snapshotted rates (see `booking.payments.ts`). No code path reads an
 *    amount from a request body.
 * 2. **A row only reaches `PAID` after a signature check** — either the
 *    Checkout callback HMAC in {@link verifyPayment}, or the webhook body HMAC
 *    before {@link applyWebhookEvent} is called.
 * 3. **Settling a payment and applying it to its booking happen in one
 *    transaction.** A booking must never be ACTIVE without the money, and
 *    money must never be taken without either an effect or a review flag.
 */

interface PaymentRow {
  id: string;
  userId: string;
  amount: number;
  currency: string;
  status: PaymentStatus;
  razorpayOrderId: string;
  razorpayPaymentId: string | null;
  paidAt: Date | null;
  createdAt: Date;
  purpose: PaymentPurpose;
  bookingId: string | null;
  quoteExpiresAt: Date | null;
}

const SUMMARY_SELECT = {
  id: true,
  userId: true,
  amount: true,
  currency: true,
  status: true,
  razorpayOrderId: true,
  razorpayPaymentId: true,
  paidAt: true,
  createdAt: true,
  purpose: true,
  bookingId: true,
  quoteExpiresAt: true,
} as const;

/** Strips internal fields; the Razorpay signature is never stored or returned. */
export function toPaymentSummary(payment: PaymentRow): PaymentSummary {
  return {
    id: payment.id,
    amount: payment.amount,
    currency: payment.currency,
    status: payment.status,
    razorpayOrderId: payment.razorpayOrderId,
    createdAt: payment.createdAt.toISOString(),
    paidAt: payment.paidAt ? payment.paidAt.toISOString() : null,
    purpose: payment.purpose,
    bookingId: payment.bookingId,
  };
}

// --- Checkout callback verification -----------------------------------------

export interface VerifyResult {
  payment: PaymentSummary;
  /** False when the row was already PAID, i.e. this was a repeat call. */
  changed: boolean;
  /**
   * Set when the money arrived but could not be applied — a lapsed hold whose
   * safe was taken, or an expired overstay quote. The payment stays PAID and
   * is queued for a manual refund; the client must say so plainly rather than
   * showing success.
   */
  needsReview: boolean;
}

/**
 * Verifies a Razorpay Checkout callback and marks the payment PAID.
 *
 * Idempotent by design: the signature is checked on *every* call, and the
 * status transition happens inside a transaction that no-ops when the row has
 * already been settled. Calling it twice with the same valid payload returns
 * the same success response.
 */
export async function verifyPayment(params: {
  userId: string;
  orderId: string;
  paymentId: string;
  signature: string;
}): Promise<VerifyResult> {
  const existing = await prisma.payment.findUnique({
    where: { razorpayOrderId: params.orderId },
    select: SUMMARY_SELECT,
  });

  if (!existing) {
    throw notFound('We could not find that payment. Please start the payment again.');
  }

  // Ownership check before anything else leaks information about the row.
  if (existing.userId !== params.userId) {
    throw forbidden('This payment belongs to a different account.');
  }

  const signatureValid = verifyCheckoutSignature({
    orderId: params.orderId,
    paymentId: params.paymentId,
    signature: params.signature,
  });

  if (!signatureValid) {
    // Deliberately does NOT mark the row FAILED: anyone who learned an order
    // id could then poison a legitimate payment in progress.
    throw new HttpError({
      status: 400,
      code: ERROR_CODES.INVALID_SIGNATURE,
      message: 'We could not verify this payment. Please contact support before paying again.',
      logContext: { paymentRowId: existing.id },
    });
  }

  const outcome = await prisma.$transaction(async (tx) => {
    // Re-read inside the transaction: the webhook may have settled the row
    // between the check above and here.
    const row = await tx.payment.findUnique({
      where: { razorpayOrderId: params.orderId },
      select: { ...SUMMARY_SELECT, reviewReason: true },
    });

    if (!row) throw notFound('We could not find that payment.');

    if (row.status === 'PAID') {
      // Repeat call, or the webhook got here first. The booking has already
      // been settled by whichever path won.
      return { row, changed: false, needsReview: row.reviewReason !== null };
    }

    // A refunded payment must not be resurrected by a replayed callback.
    if (row.status === 'REFUNDED') {
      return { row, changed: false, needsReview: false };
    }

    const updated = await tx.payment.update({
      where: { id: row.id },
      data: {
        status: 'PAID',
        razorpayPaymentId: params.paymentId,
        paidAt: row.paidAt ?? new Date(),
      },
      select: SUMMARY_SELECT,
    });

    /**
     * Apply it to the booking **in this transaction**.
     *
     * A booking must never be ACTIVE without the money, and money must never
     * be taken without either an effect or a review flag. Both halves commit
     * together or neither does.
     */
    const settlement = await applyBookingPayment({
      tx,
      paymentRowId: updated.id,
      bookingId: updated.bookingId,
      purpose: updated.purpose,
      amountPaise: updated.amount,
      quoteExpiresAt: updated.quoteExpiresAt,
      userId: updated.userId,
    });

    return { row: updated, changed: true, needsReview: settlement.kind === 'needs-review' };
  });

  return {
    payment: toPaymentSummary(outcome.row),
    changed: outcome.changed,
    needsReview: outcome.needsReview ?? false,
  };
}

// --- Webhook application -----------------------------------------------------

export type WebhookOutcome =
  | { kind: 'applied'; action: string; paymentRowId: string | null }
  | { kind: 'ignored'; reason: string };

/**
 * Applies one already-signature-verified webhook event.
 *
 * The caller runs this inside the same transaction that records the event id,
 * so a thrown error rolls back both the state change and the idempotency row
 * and Razorpay's retry can be applied cleanly.
 */
export async function applyWebhookEvent(
  tx: PrismaTransaction,
  event: { type: string; payload: unknown },
): Promise<WebhookOutcome> {
  switch (event.type) {
    case 'payment.captured':
      return applyPaymentCaptured(tx, event.payload);
    case 'payment.failed':
      return applyPaymentFailed(tx, event.payload);
    case 'refund.processed':
      return applyRefundProcessed(tx, event.payload);
    default:
      // Acknowledged and recorded, so Razorpay stops retrying an event this
      // version does not act on.
      return { kind: 'ignored', reason: `unhandled event type ${event.type}` };
  }
}

interface PaymentEntity {
  id?: unknown;
  order_id?: unknown;
  amount?: unknown;
  error_description?: unknown;
  error_reason?: unknown;
}

function paymentEntity(payload: unknown): PaymentEntity | null {
  const entity = (payload as { payment?: { entity?: PaymentEntity } })?.payment?.entity;
  return entity && typeof entity === 'object' ? entity : null;
}

async function findByOrderId(tx: PrismaTransaction, orderId: string) {
  return tx.payment.findUnique({
    where: { razorpayOrderId: orderId },
    select: SUMMARY_SELECT,
  });
}

/**
 * `payment.captured` is the authoritative "money received" signal. It settles
 * the row whether or not the browser ever called `/payments/verify` — the user
 * may have closed the tab immediately after paying.
 */
async function applyPaymentCaptured(
  tx: PrismaTransaction,
  payload: unknown,
): Promise<WebhookOutcome> {
  const entity = paymentEntity(payload);
  const orderId = typeof entity?.order_id === 'string' ? entity.order_id : null;
  const razorpayPaymentId = typeof entity?.id === 'string' ? entity.id : null;

  if (!orderId) return { kind: 'ignored', reason: 'payload had no order_id' };

  const row = await findByOrderId(tx, orderId);
  if (!row) return { kind: 'ignored', reason: 'no payment row for order' };

  // Underpayment guard. The order amount is set server-side so this should be
  // impossible, but settling a row for less than the price is exactly the kind
  // of mistake that must fail loudly rather than quietly.
  const capturedAmount = typeof entity?.amount === 'number' ? entity.amount : null;
  if (capturedAmount !== null && capturedAmount < row.amount) {
    logger.error(
      {
        paymentRowId: row.id,
        expected: row.amount,
        captured: capturedAmount,
      },
      'Webhook captured amount is below the order amount',
    );
    return { kind: 'ignored', reason: 'captured amount below order amount' };
  }

  if (row.status === 'PAID') {
    return { kind: 'applied', action: 'already-paid', paymentRowId: row.id };
  }
  if (row.status === 'REFUNDED') {
    return { kind: 'ignored', reason: 'payment already refunded' };
  }

  await tx.payment.update({
    where: { id: row.id },
    data: {
      status: 'PAID',
      paidAt: row.paidAt ?? new Date(),
      ...(razorpayPaymentId ? { razorpayPaymentId } : {}),
    },
  });

  /**
   * The webhook is the source of truth, so this is the path that normally
   * activates a booking — the browser may never have called `/verify` at all.
   * Settled in the same transaction that records the event id, so Razorpay's
   * retry gets a clean attempt if anything throws.
   */
  const settlement = await applyBookingPayment({
    tx,
    paymentRowId: row.id,
    bookingId: row.bookingId,
    purpose: row.purpose,
    amountPaise: row.amount,
    quoteExpiresAt: row.quoteExpiresAt,
    userId: row.userId,
  });

  return {
    kind: 'applied',
    action: settlement.kind === 'needs-review' ? `needs-review:${settlement.reason}` : 'marked-paid',
    paymentRowId: row.id,
  };
}

/** `payment.failed` only moves a row that has not been settled. */
async function applyPaymentFailed(
  tx: PrismaTransaction,
  payload: unknown,
): Promise<WebhookOutcome> {
  const entity = paymentEntity(payload);
  const orderId = typeof entity?.order_id === 'string' ? entity.order_id : null;

  if (!orderId) return { kind: 'ignored', reason: 'payload had no order_id' };

  const row = await findByOrderId(tx, orderId);
  if (!row) return { kind: 'ignored', reason: 'no payment row for order' };

  // A later failed attempt on the same order must not undo a captured payment.
  if (row.status !== 'CREATED') {
    return { kind: 'ignored', reason: `payment is ${row.status}, not CREATED` };
  }

  await tx.payment.update({
    where: { id: row.id },
    data: { status: 'FAILED' },
  });

  return { kind: 'applied', action: 'marked-failed', paymentRowId: row.id };
}

/**
 * `refund.processed`.
 *
 * **It marks the money refunded and nothing else.** Under the rental model a
 * refund does not touch the booking: a safe someone is physically using cannot
 * be taken back by a webhook, and a booking that has already ended has nothing
 * left to revoke. Whether a refunded booking should also be force-completed is
 * a policy question, and the answer today is that an admin decides — which is
 * why this is also the path that clears a `reviewReason` row once the refund it
 * was flagged for actually lands. See docs/decisions.md.
 */
async function applyRefundProcessed(
  tx: PrismaTransaction,
  payload: unknown,
): Promise<WebhookOutcome> {
  const entity = (payload as { refund?: { entity?: { payment_id?: unknown } } })?.refund?.entity;
  const razorpayPaymentId = typeof entity?.payment_id === 'string' ? entity.payment_id : null;

  // A refund references the payment, not the order, so look up by payment id
  // and fall back to the order id if the payload carries one.
  const fallbackOrderId =
    typeof paymentEntity(payload)?.order_id === 'string'
      ? (paymentEntity(payload)!.order_id as string)
      : null;

  const row = razorpayPaymentId
    ? await tx.payment.findUnique({
        where: { razorpayPaymentId },
        select: { ...SUMMARY_SELECT, reviewReason: true, reviewClearedAt: true },
      })
    : fallbackOrderId
      ? await tx.payment.findUnique({
          where: { razorpayOrderId: fallbackOrderId },
          select: { ...SUMMARY_SELECT, reviewReason: true, reviewClearedAt: true },
        })
      : null;

  if (!row) return { kind: 'ignored', reason: 'no payment row for refund' };

  if (row.status === 'REFUNDED') {
    return { kind: 'applied', action: 'already-refunded', paymentRowId: row.id };
  }

  await tx.payment.update({
    where: { id: row.id },
    data: {
      status: 'REFUNDED',
      /**
       * A refund landing on a flagged row **is** the flag being dealt with.
       *
       * The admin list exists to say "this money needs refunding by hand"; once
       * the refund is confirmed by Razorpay, leaving it on the list would make
       * the list wrong in the direction that gets a second refund issued. The
       * admin can still clear a flag explicitly with a note (see
       * `clearPaymentReview`) for the cases a refund never arrives.
       */
      ...(row.reviewReason && !row.reviewClearedAt ? { reviewClearedAt: new Date() } : {}),
    },
  });

  return {
    kind: 'applied',
    action: row.reviewReason ? 'marked-refunded-review-cleared' : 'marked-refunded',
    paymentRowId: row.id,
  };
}
