import type { PaymentPurpose, PaymentReviewReason } from '@safelock/shared';
import { logger } from '../../lib/logger';
import type { PrismaTransaction } from '../../lib/prisma';
import { AUDIT_ACTIONS, writeAudit } from '../audit/audit.service';
import { BOOKING_SELECT, outstandingFeePaise, type BookingRow } from '../bookings/booking.mapper';
import {
  activateBooking,
  applyExtension,
  settleOverstay,
} from '../bookings/booking.service';

/**
 * Applying a captured payment to its booking.
 *
 * Called from the webhook and from the verified Checkout callback, inside the
 * transaction that settles the `Payment` row — so the money and its effect
 * land together or not at all.
 *
 * ## The rule when money cannot be applied
 * The `Payment` row **stays `PAID`**. We never rewrite a payment to pretend it
 * did not happen; that would be a lie in the one table that must not contain
 * one. Instead the row gets a `reviewReason` and appears in an admin
 * "needs refund" list, and the user is told plainly. Refunds are manual: an
 * admin refunds in the Razorpay dashboard and clears the flag with a note, and
 * the existing `refund.processed` webhook flips the row to `REFUNDED` by
 * itself. See docs/decisions.md.
 */

export type SettlementOutcome =
  | { kind: 'applied'; action: string }
  | { kind: 'needs-review'; reason: PaymentReviewReason }
  | { kind: 'ignored'; reason: string };

export interface SettlementInput {
  tx: PrismaTransaction;
  paymentRowId: string;
  bookingId: string | null;
  purpose: PaymentPurpose;
  amountPaise: number;
  quoteExpiresAt: Date | null;
  userId: string;
  now?: Date;
}

/** Flags a captured payment for a human, without touching its PAID status. */
async function flagForReview(
  input: SettlementInput,
  reason: PaymentReviewReason,
): Promise<SettlementOutcome> {
  await input.tx.payment.update({
    where: { id: input.paymentRowId },
    data: { reviewReason: reason },
  });

  logger.error(
    {
      paymentRowId: input.paymentRowId,
      bookingId: input.bookingId,
      purpose: input.purpose,
      reason,
    },
    'Captured a payment that could not be applied; flagged for manual refund',
  );

  await writeAudit({
    action: AUDIT_ACTIONS.PAYMENT_NEEDS_REVIEW,
    userId: input.userId,
    metadata: { paymentRowId: input.paymentRowId, purpose: input.purpose, reason },
  });

  return { kind: 'needs-review', reason };
}

export async function applyBookingPayment(
  input: SettlementInput,
): Promise<SettlementOutcome> {
  const now = input.now ?? new Date();

  if (!input.bookingId) {
    return { kind: 'ignored', reason: 'payment has no booking' };
  }

  switch (input.purpose) {
    case 'BOOKING':
      return applyBookingPurchase(input, now);
    case 'EXTENSION':
      return applyExtensionPurchase(input, now);
    case 'OVERSTAY':
      return applyOverstayPurchase(input, now);
  }
}

/**
 * The booking itself: the only path to `ACTIVE`.
 *
 * `endsAt` is set from **now**, so the user gets the hours they bought no
 * matter how long the checkout took.
 */
async function applyBookingPurchase(
  input: SettlementInput,
  now: Date,
): Promise<SettlementOutcome> {
  const outcome = await activateBooking(input.bookingId!, {
    now,
    client: input.tx,
  });

  if (outcome.kind === 'activated') {
    await writeAudit({
      action: AUDIT_ACTIONS.BOOKING_ACTIVATED,
      userId: input.userId,
      deviceId: outcome.booking.deviceId,
      metadata: {
        bookingId: outcome.booking.id,
        paymentRowId: input.paymentRowId,
        hours: outcome.booking.hours,
      },
    });
    return { kind: 'applied', action: 'booking-activated' };
  }

  if (outcome.kind === 'already-active') {
    // A repeat delivery, or verify and the webhook racing. Idempotent.
    return { kind: 'applied', action: 'already-active' };
  }

  /**
   * The hold lapsed and the safe went to someone else.
   *
   * Nothing is forced: taking the device back from a paying user to give it to
   * an earlier one would just move the problem. The money is flagged.
   */
  if (outcome.kind === 'device-taken') {
    return flagForReview(input, 'BOOKING_EXPIRED_DEVICE_TAKEN');
  }

  return flagForReview(input, 'BOOKING_NO_LONGER_PAYABLE');
}

async function applyExtensionPurchase(
  input: SettlementInput,
  now: Date,
): Promise<SettlementOutcome> {
  const booking = (await input.tx.booking.findUnique({
    where: { id: input.bookingId! },
    select: BOOKING_SELECT,
  })) as BookingRow | null;

  if (!booking) return flagForReview(input, 'BOOKING_NO_LONGER_PAYABLE');

  if (booking.status !== 'ACTIVE' && booking.status !== 'OVERSTAY') {
    // Completed or cancelled while the extension payment was in flight.
    return flagForReview(input, 'BOOKING_NO_LONGER_PAYABLE');
  }

  /**
   * An extension bought while in grace is honoured; one bought once a fee is
   * owed is not applied, because the hour being extended has already been
   * charged at the overstay rate. That money is refundable, not applicable.
   */
  if (outstandingFeePaise(booking, now) > 0) {
    return flagForReview(input, 'BOOKING_NO_LONGER_PAYABLE');
  }

  // The hours are derived from the amount and the snapshot, never taken from a
  // request: `amount / hourlyRate` is exactly what the order was priced at.
  const hours = Math.round(input.amountPaise / booking.hourlyRatePaise);
  if (hours < 1) return flagForReview(input, 'BOOKING_NO_LONGER_PAYABLE');

  await applyExtension(booking.id, hours, input.amountPaise, input.tx);

  await writeAudit({
    action: AUDIT_ACTIONS.BOOKING_EXTENDED,
    userId: input.userId,
    deviceId: booking.deviceId,
    metadata: { bookingId: booking.id, hours, paymentRowId: input.paymentRowId },
  });

  return { kind: 'applied', action: 'extension-applied' };
}

/**
 * The overstay fee.
 *
 * Two cases that must not be confused:
 *
 * - **The quote is still live, or the amount still covers the fee.** Settle it.
 *   Accrual stops at capture, and any growth during the checkout is absorbed —
 *   see `settleOverstay`.
 * - **The quote expired *and* the fee has outgrown what was paid.** Do not
 *   settle: that would quietly accept less than is owed and open the collection
 *   window on a part payment. The money is flagged for a manual refund and the
 *   user is told to request a fresh quote.
 */
async function applyOverstayPurchase(
  input: SettlementInput,
  now: Date,
): Promise<SettlementOutcome> {
  const booking = (await input.tx.booking.findUnique({
    where: { id: input.bookingId! },
    select: BOOKING_SELECT,
  })) as BookingRow | null;

  if (!booking) return flagForReview(input, 'BOOKING_NO_LONGER_PAYABLE');

  if (booking.overstaySettledAt || booking.overstayWaivedAt) {
    // Already settled or waived — a repeat delivery, or an admin got there
    // first. Idempotent, and no second charge is applied.
    return { kind: 'applied', action: 'overstay-already-settled' };
  }

  if (booking.status === 'COMPLETED' || booking.status === 'CANCELLED') {
    return flagForReview(input, 'BOOKING_NO_LONGER_PAYABLE');
  }

  const feeNow = outstandingFeePaise(booking, now);
  const quoteExpired =
    input.quoteExpiresAt !== null && now.getTime() > input.quoteExpiresAt.getTime();

  if (quoteExpired && feeNow > input.amountPaise) {
    return flagForReview(input, 'OVERSTAY_QUOTE_EXPIRED');
  }

  await settleOverstay(booking.id, input.amountPaise, { now, client: input.tx });

  await writeAudit({
    action: AUDIT_ACTIONS.BOOKING_OVERSTAY_SETTLED,
    userId: input.userId,
    deviceId: booking.deviceId,
    metadata: {
      bookingId: booking.id,
      paidPaise: input.amountPaise,
      feeAtCapturePaise: feeNow,
      absorbedPaise: Math.max(0, feeNow - input.amountPaise),
      paymentRowId: input.paymentRowId,
    },
  });

  return { kind: 'applied', action: 'overstay-settled' };
}
