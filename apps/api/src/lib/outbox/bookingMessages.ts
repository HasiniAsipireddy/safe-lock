import {
  collectByFrom,
  effectiveBookingStatus,
  overstayHourlyPaise,
} from '@safelock/shared';
import { prisma } from '../prisma';
import {
  BOOKING_SELECT,
  outstandingFeePaise,
  snapshotOf,
  type BookingRow,
} from '../../modules/bookings/booking.mapper';
import type { BookingMessageKind } from '../whatsapp/send';
import { formatIstDateTime, formatIstTime, formatMoney } from './messageFormat';

/**
 * Deciding, at send time, whether a scheduled message is still true.
 *
 * ## This is the guard that matters
 * Cancellation at the state change is the tidy path and it is not trusted. A
 * booking can be collected, cancelled, extended, settled or force-completed
 * between a row being scheduled and the worker claiming it; a deploy can lose
 * a tick; a cancellation path can be forgotten in a future change. So every
 * row carrying a `bookingId` is re-read here against the live booking, and the
 * **same read** that produces the template parameters decides whether there is
 * a message at all.
 *
 * That coupling is deliberate. Splitting "should we send?" from "what does it
 * say?" would let the two disagree, and the shape of the disagreement is a
 * confident false statement about a safe holding someone's property.
 *
 * ## Why a refusal is not a failure
 * A refusal is `SKIPPED`/`NOT_APPLICABLE`: nothing was attempted, nothing is
 * wrong, and nothing should be retried. It is also a signal — a steady stream
 * of `NOT_APPLICABLE` means some state change is failing to cancel what it
 * should, which is exactly the thing two independent guards are supposed to
 * let you see rather than hide.
 */

export type Revalidation =
  | {
      ok: true;
      params: readonly string[];
      /** The dynamic URL button's variable, for the two templates with one. */
      urlButtonSuffix?: string;
    }
  | { ok: false; reason: string };

/**
 * Re-reads the booking and either builds the message or refuses it.
 *
 * `now` is passed in rather than read here so the worker's clock is the only
 * clock involved: the staleness check, the eligibility derivation and the
 * parameters all describe the same instant.
 */
export async function revalidate(
  kind: BookingMessageKind,
  bookingId: string,
  now: Date,
): Promise<Revalidation> {
  const row = (await prisma.booking.findUnique({
    where: { id: bookingId },
    select: BOOKING_SELECT,
  })) as BookingRow | null;

  if (!row) return { ok: false, reason: 'booking no longer exists' };

  const snapshot = snapshotOf(row);
  const serial = row.device.serialNumber;

  /**
   * Derived from the clock, never read from `row.status`.
   *
   * The same rule every other read in the product follows, and for the same
   * reason: a late or wedged sweeper must not be able to make a message say
   * something the clock disagrees with.
   */
  const effective = effectiveBookingStatus({
    status: row.status,
    endsAt: row.endsAt,
    holdExpiresAt: row.holdExpiresAt,
    overstaySettledAt: row.overstaySettledAt ?? row.overstayWaivedAt,
    snapshot,
    now,
  });

  switch (kind) {
    /**
     * The weakest precondition of the five, on purpose: a confirmation
     * describes a payment that was captured, and that stays true even once the
     * booking is running late. Only a booking that never started — cancelled,
     * or the hold expired unpaid — has nothing to confirm.
     */
    case 'BOOKING_CONFIRMED': {
      if (effective === 'CANCELLED' || effective === 'EXPIRED_UNPAID') {
        return { ok: false, reason: `booking is ${effective}` };
      }
      if (!row.endsAt) return { ok: false, reason: 'booking has no end time' };

      return { ok: true, params: [serial, formatIstDateTime(row.endsAt)] };
    }

    /**
     * A reminder is only honest while there is still time to act on it. Both
     * halves are needed: `ACTIVE` alone would let a booking extended into the
     * future keep an old reminder, and a future `endsAt` alone would let one
     * fire after a collection.
     */
    case 'BOOKING_ENDING_SOON': {
      if (effective !== 'ACTIVE') return { ok: false, reason: `booking is ${effective}` };
      if (!row.endsAt || row.endsAt.getTime() <= now.getTime()) {
        return { ok: false, reason: 'booking has already ended' };
      }

      return {
        ok: true,
        params: [serial, formatIstTime(row.endsAt)],
        urlButtonSuffix: manageSuffix(row.id),
      };
    }

    /**
     * An outstanding fee is the whole content of this message, so the message
     * cannot exist without one. Which is why it is scheduled a minute past the
     * grace boundary rather than at it: the fee is exactly zero at that
     * instant, and this check would refuse the notice forever.
     */
    case 'OVERSTAY_STARTED': {
      if (effective !== 'OVERSTAY') return { ok: false, reason: `booking is ${effective}` };

      const fee = outstandingFeePaise(row, now);
      if (fee <= 0) return { ok: false, reason: 'no fee outstanding' };

      return {
        ok: true,
        params: [serial, formatMoney(overstayHourlyPaise(snapshot))],
        urlButtonSuffix: manageSuffix(row.id),
      };
    }

    /**
     * A receipt for money we actually took. `overstayPaidPaise` is the figure
     * from the books, not the quote and not the fee — a receipt must name what
     * was collected.
     *
     * Refused for a waiver: `overstayWaivedAt` leaves `overstayPaidPaise` at
     * zero, and "we received your payment of ₹0" is a lie about money.
     */
    case 'OVERSTAY_SETTLED': {
      if (!row.overstaySettledAt) return { ok: false, reason: 'overstay is not settled' };
      if (row.overstayPaidPaise <= 0) return { ok: false, reason: 'nothing was collected' };

      return {
        ok: true,
        params: [
          formatMoney(row.overstayPaidPaise),
          serial,
          formatIstTime(collectByFrom(snapshot, row.overstaySettledAt)),
        ],
      };
    }

    /**
     * Settled or waived — both open a collection window, and a waived user
     * needs this reminder more than anyone, since it is the only message their
     * path sends.
     */
    case 'COLLECTION_CLOSING': {
      const settledAt = row.overstaySettledAt ?? row.overstayWaivedAt;
      if (!settledAt) return { ok: false, reason: 'no collection window is open' };

      const collectBy = collectByFrom(snapshot, settledAt);
      if (collectBy.getTime() <= now.getTime()) {
        return { ok: false, reason: 'collection window has closed' };
      }
      if (effective === 'COMPLETED') {
        return { ok: false, reason: 'booking is already complete' };
      }

      return { ok: true, params: [serial, formatIstTime(collectBy)] };
    }
  }
}

/**
 * The variable half of the dynamic URL button.
 *
 * Meta approved the base (`https://<host>/bookings/`) into the template, so
 * this can only ever produce a link under that path. A booking id and a fixed
 * segment, and nothing else — there is no amount, code or token that could
 * end up in a chat message through here.
 */
function manageSuffix(bookingId: string): string {
  return `${bookingId}/extend`;
}
