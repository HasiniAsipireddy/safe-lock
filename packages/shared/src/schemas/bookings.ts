import { z } from 'zod';
import type { BookingStatus, RateSnapshot } from '../types/bookings';

/**
 * Rental pricing, duration rules and booking request schemas.
 *
 * The arithmetic lives here, as pure functions over a {@link RateSnapshot},
 * for the same reason the OTP parameters do: the API charges it and the UI
 * displays it, and the two must not be able to disagree about what an overstay
 * costs. Every figure is an integer number of paise; the multiplier is basis
 * points. **No money value in this file is ever a float.**
 */

/** Basis-point denominator. 10000 bps = 1.0×. */
export const BPS_DIVISOR = 10_000;

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_MINUTE = 60 * 1000;

/**
 * Hard bounds on a booking or extension, independent of config.
 *
 * The server's configured min/max must sit inside these; they exist so a
 * mistyped env var cannot create a 10,000-hour booking.
 */
export const BOOKING_HOURS_FLOOR = 1;
export const BOOKING_HOURS_CEILING = 24;

/** Durations a client may request. One hour granularity — no part hours. */
export const bookingHoursSchema = z.coerce
  .number()
  .int('Duration must be a whole number of hours')
  .min(BOOKING_HOURS_FLOOR, `Minimum booking is ${BOOKING_HOURS_FLOOR} hour`)
  .max(BOOKING_HOURS_CEILING, `Maximum booking is ${BOOKING_HOURS_CEILING} hours`);

/**
 * `POST /bookings`.
 *
 * **Carries no price and no times.** The duration is the only thing a client
 * chooses; the rate, the start and the end all come from the server. A body
 * with `pricePaise` or `endsAt` is rejected by `.strict()` rather than
 * silently ignored — the same rule `POST /payments/order` has always had.
 */
export const createBookingSchema = z.object({ hours: bookingHoursSchema }).strict();

/** `POST /bookings/:id/extend`. Same rule: hours only. */
export const extendBookingSchema = z.object({ hours: bookingHoursSchema }).strict();

/** `POST /bookings/:id/collect`, `/cancel`, and the order endpoints. */
export const emptyBookingBodySchema = z.object({}).strict();

/** An admin action that must say why. The reason is audited, never free-form UI. */
export const adminReasonSchema = z
  .string()
  .trim()
  .min(3, 'Give a reason of at least 3 characters')
  .max(500, 'Reason must be at most 500 characters');

/**
 * `POST /admin/bookings/:id/force-complete`.
 *
 * `needsInspection` defaults to **true**: the safe's contents are unknown
 * unless the admin says they have checked. Defaulting the other way would send
 * a possibly-occupied safe back into the pool on a careless click.
 */
export const forceCompleteBookingSchema = z
  .object({
    reason: adminReasonSchema,
    needsInspection: z.boolean().default(true),
  })
  .strict();

/** `POST /admin/bookings/:id/waive-overstay`. */
export const waiveOverstaySchema = z.object({ reason: adminReasonSchema }).strict();

/** `POST /admin/devices/:id/clear-inspection`. */
export const clearInspectionSchema = z.object({ note: adminReasonSchema }).strict();

export const bookingStatusFilterSchema = z
  .enum([
    'PENDING_PAYMENT',
    'ACTIVE',
    'OVERSTAY',
    'COMPLETED',
    'CANCELLED',
    'EXPIRED_UNPAID',
  ])
  .optional();

export const listBookingsQuerySchema = z.object({
  status: bookingStatusFilterSchema,
  /** Only rows needing a human: unpaid overstay, or inspection due. */
  flagged: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export type CreateBookingInput = z.infer<typeof createBookingSchema>;
export type ExtendBookingInput = z.infer<typeof extendBookingSchema>;
export type ForceCompleteBookingInput = z.infer<typeof forceCompleteBookingSchema>;
export type WaiveOverstayInput = z.infer<typeof waiveOverstaySchema>;
export type ClearInspectionInput = z.infer<typeof clearInspectionSchema>;
export type ListBookingsQuery = z.infer<typeof listBookingsQuerySchema>;

// --- Pricing -----------------------------------------------------------------

/** What a booking of `hours` costs under a snapshot. Integer paise. */
export function bookingPricePaise(snapshot: RateSnapshot, hours: number): number {
  return snapshot.hourlyRatePaise * hours;
}

/**
 * The per-hour overstay charge.
 *
 * `Math.round` on the basis-point multiplication, so the result is always a
 * whole number of paise — a fractional paisa cannot be charged and must not be
 * carried around waiting to surprise someone.
 */
export function overstayHourlyPaise(snapshot: RateSnapshot): number {
  return Math.round((snapshot.hourlyRatePaise * snapshot.overstayMultiplierBps) / BPS_DIVISOR);
}

/** The instant overstay fees begin: `endsAt` plus the grace period. */
export function overstayStartsAt(snapshot: RateSnapshot, endsAt: Date): Date {
  return new Date(endsAt.getTime() + snapshot.graceMinutes * MS_PER_MINUTE);
}

/**
 * Hours of overstay charged so far, per **started** hour, capped.
 *
 * The boundary is exact and matters: at precisely `endsAt + grace` the answer
 * is 0, and one millisecond later it is 1. `Math.ceil` is what "per started
 * hour" means — someone five minutes over pays for an hour, which is the rule
 * stated to them before they book.
 */
export function overstayHoursAccrued(
  snapshot: RateSnapshot,
  endsAt: Date,
  now: Date,
): number {
  const elapsedMs = now.getTime() - overstayStartsAt(snapshot, endsAt).getTime();
  if (elapsedMs <= 0) return 0;

  return Math.min(Math.ceil(elapsedMs / MS_PER_HOUR), snapshot.capHours);
}

/** The fee outstanding at `now`, in paise. 0 inside the grace period. */
export function overstayFeePaise(
  snapshot: RateSnapshot,
  endsAt: Date,
  now: Date,
): number {
  return overstayHoursAccrued(snapshot, endsAt, now) * overstayHourlyPaise(snapshot);
}

/** The most an overstay can ever cost — what the cap means in money. */
export function overstayMaxFeePaise(snapshot: RateSnapshot): number {
  return snapshot.capHours * overstayHourlyPaise(snapshot);
}

/** When the collection window closes after a fee is settled. */
export function collectByFrom(snapshot: RateSnapshot, settledAt: Date): Date {
  return new Date(settledAt.getTime() + snapshot.collectionWindowMinutes * MS_PER_MINUTE);
}

/**
 * How long a device stays reserved for a booking.
 *
 * `endsAt` plus the grace period plus the collection window — the turnaround
 * during which the safe may still physically contain someone's belongings. The
 * database's overlap constraint uses this, not `endsAt`, so a back-to-back
 * booking cannot be sold into the window where the previous renter is still
 * entitled to be collecting.
 */
export function reservedUntilFrom(snapshot: RateSnapshot, endsAt: Date): Date {
  return new Date(
    endsAt.getTime() +
      (snapshot.graceMinutes + snapshot.collectionWindowMinutes) * MS_PER_MINUTE,
  );
}

// --- Effective status --------------------------------------------------------

export interface EffectiveStatusInput {
  status: BookingStatus;
  endsAt: Date | null;
  holdExpiresAt: Date | null;
  overstaySettledAt: Date | null;
  snapshot: RateSnapshot;
  now: Date;
}

/**
 * The status the server clock says this booking is in, right now.
 *
 * **This is the function the unlock path asks**, never the stored column. A
 * sweeper that is late, wedged or has never run must not be able to let an
 * unlock through, and the only way to guarantee that is for every read to
 * derive the answer from `now`. The sweeper exists to make the stored row
 * agree, release devices and move `reservedUntil` — not to decide anything.
 *
 * Terminal statuses are returned unchanged: once a booking is `COMPLETED`,
 * `CANCELLED` or `EXPIRED_UNPAID`, no amount of elapsed time changes it.
 */
export function effectiveBookingStatus(input: EffectiveStatusInput): BookingStatus {
  const { status, now } = input;

  if (status === 'COMPLETED' || status === 'CANCELLED' || status === 'EXPIRED_UNPAID') {
    return status;
  }

  if (status === 'PENDING_PAYMENT') {
    const lapsed = input.holdExpiresAt !== null && now.getTime() >= input.holdExpiresAt.getTime();
    return lapsed ? 'EXPIRED_UNPAID' : 'PENDING_PAYMENT';
  }

  if (status === 'ACTIVE') {
    if (!input.endsAt) return 'ACTIVE';
    const overstayFrom = overstayStartsAt(input.snapshot, input.endsAt);
    return now.getTime() > overstayFrom.getTime() ? 'OVERSTAY' : 'ACTIVE';
  }

  // OVERSTAY. A settled fee opens the collection window; when that closes the
  // booking is over, with the contents unknown — which is why the sweeper
  // completes it as COLLECTION_WINDOW_LAPSED and flags the device.
  if (input.overstaySettledAt) {
    const deadline = collectByFrom(input.snapshot, input.overstaySettledAt);
    if (now.getTime() > deadline.getTime()) return 'COMPLETED';
  }

  return 'OVERSTAY';
}

/**
 * Whether this booking may operate the safe's **unlock**, and why not.
 *
 * Returned as a reason rather than a boolean so the caller can map each case
 * to its own error code — the dashboard shows a different thing for "pay the
 * overstay fee" than for "your booking ended".
 */
export type UnlockEligibility =
  | { allowed: true }
  | { allowed: false; reason: 'NO_ACTIVE_BOOKING' | 'OVERSTAY_FEE_DUE' };

export function unlockEligibility(input: EffectiveStatusInput): UnlockEligibility {
  const effective = effectiveBookingStatus(input);

  if (effective === 'ACTIVE') return { allowed: true };

  if (effective === 'OVERSTAY') {
    /**
     * An unpaid overstay refuses to open. This is the product's one piece of
     * leverage, and it is deliberately **unlock only** — locking stays
     * available, because refusing to let someone secure a safe they are
     * standing at would be punishing them in the one direction that creates
     * risk rather than recovers money.
     */
    const feeDue =
      input.endsAt !== null &&
      !input.overstaySettledAt &&
      overstayFeePaise(input.snapshot, input.endsAt, input.now) > 0;

    if (feeDue) return { allowed: false, reason: 'OVERSTAY_FEE_DUE' };

    // Settled, and inside the collection window: the whole point of paying.
    return { allowed: true };
  }

  return { allowed: false, reason: 'NO_ACTIVE_BOOKING' };
}
