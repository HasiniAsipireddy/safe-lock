import crypto from 'node:crypto';
import { ERROR_CODES, type PaymentSummary, type PaymentStatus } from '@safelock/shared';
import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import type { PrismaTransaction } from '../../lib/prisma';
import { HttpError, conflict, forbidden, notFound } from '../../lib/httpError';
import { logger } from '../../lib/logger';
import { createRazorpayOrder } from '../../lib/razorpay';
import { userHasPaid } from '../users/user.mapper';
import { verifyCheckoutSignature } from './signature';

/**
 * Payment service.
 *
 * Two invariants hold everywhere in this file:
 *
 * 1. **The price comes only from `env.SAFE_PRICE_PAISE`.** No code path reads
 *    an amount from a request body. A client that posts `{ amount: 100 }` is
 *    charged the server price.
 * 2. **A row only reaches `PAID` after a signature check** — either the
 *    Checkout callback HMAC in {@link verifyPayment}, or the webhook body HMAC
 *    before {@link applyWebhookEvent} is called.
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
  };
}

// --- Order creation ----------------------------------------------------------

export interface CreateOrderResult {
  orderId: string;
  amount: number;
  currency: string;
  keyId: string;
  paymentId: string;
}

/**
 * Creates a Razorpay order for the signed-in user.
 *
 * The Payment row id is generated up front so it can be sent as the Razorpay
 * `receipt`: a dashboard entry or a webhook can then be traced back to a row
 * and a user without trusting anything the browser said.
 *
 * A user with an outstanding `CREATED` row gets a *new* order rather than the
 * old one. Razorpay orders expire, and reusing one could charge a stale price
 * if `SAFE_PRICE_PAISE` changed in between.
 */
export async function createOrder(userId: string): Promise<CreateOrderResult> {
  if (await userHasPaid(userId)) {
    throw conflict(
      ERROR_CODES.ALREADY_PAID,
      'This account has already been activated. No further payment is needed.',
    );
  }

  const paymentId = crypto.randomUUID();
  const amount = env.SAFE_PRICE_PAISE;
  const currency = env.CURRENCY;

  const order = await createRazorpayOrder({
    amountInPaise: amount,
    currency,
    receipt: paymentId,
    notes: { userId },
  });

  // Trust our own figures over the echoed ones, but refuse to proceed if the
  // gateway created an order for a different amount than we asked for.
  if (order.amount !== amount || order.currency !== currency) {
    logger.error(
      {
        requestedAmount: amount,
        returnedAmount: order.amount,
        requestedCurrency: currency,
        returnedCurrency: order.currency,
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
      userId,
      razorpayOrderId: order.id,
      amount,
      currency,
      status: 'CREATED',
    },
  });

  return {
    orderId: order.id,
    amount,
    currency,
    // The publishable key id only. The key secret never leaves the server.
    keyId: env.RAZORPAY_KEY_ID,
    paymentId,
  };
}

// --- Checkout callback verification -----------------------------------------

export interface VerifyResult {
  payment: PaymentSummary;
  hasPaid: boolean;
  /** False when the row was already PAID, i.e. this was a repeat call. */
  changed: boolean;
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
      select: SUMMARY_SELECT,
    });

    if (!row) throw notFound('We could not find that payment.');

    if (row.status === 'PAID') {
      // Repeat call, or the webhook got here first.
      return { row, changed: false };
    }

    // A refunded payment must not be resurrected by a replayed callback.
    if (row.status === 'REFUNDED') {
      return { row, changed: false };
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

    return { row: updated, changed: true };
  });

  return {
    payment: toPaymentSummary(outcome.row),
    hasPaid: outcome.row.status === 'PAID',
    changed: outcome.changed,
  };
}

// --- Payment status ----------------------------------------------------------

export async function getPaymentStateForUser(userId: string): Promise<{
  hasPaid: boolean;
  payment: PaymentSummary | null;
  priceInPaise: number;
  currency: string;
}> {
  const [paid, latest] = await Promise.all([
    userHasPaid(userId),
    prisma.payment.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: SUMMARY_SELECT,
    }),
  ]);

  return {
    hasPaid: paid,
    payment: latest ? toPaymentSummary(latest) : null,
    priceInPaise: env.SAFE_PRICE_PAISE,
    currency: env.CURRENCY,
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

  return { kind: 'applied', action: 'marked-paid', paymentRowId: row.id };
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
 * Policy note: this marks the payment REFUNDED, which makes `hasPaid` false
 * again and so revokes access through `requirePaid`. Whether a refund should
 * also de-allocate the physical device is an open question — see the refund
 * policy TODO in docs/decisions.md.
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
        select: SUMMARY_SELECT,
      })
    : fallbackOrderId
      ? await findByOrderId(tx, fallbackOrderId)
      : null;

  if (!row) return { kind: 'ignored', reason: 'no payment row for refund' };

  if (row.status === 'REFUNDED') {
    return { kind: 'applied', action: 'already-refunded', paymentRowId: row.id };
  }

  await tx.payment.update({
    where: { id: row.id },
    data: { status: 'REFUNDED' },
  });

  return { kind: 'applied', action: 'marked-refunded', paymentRowId: row.id };
}
