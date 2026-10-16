import { describe, expect, it } from 'vitest';
import {
  BPS_DIVISOR,
  bookingPricePaise,
  collectByFrom,
  effectiveBookingStatus,
  overstayFeePaise,
  overstayHourlyPaise,
  overstayHoursAccrued,
  overstayMaxFeePaise,
  overstayStartsAt,
  reservedUntilFrom,
  unlockEligibility,
  type RateSnapshot,
} from '@safelock/shared';

/**
 * Rental pricing and effective status.
 *
 * Pure functions over a snapshot — no database, no app. They live in
 * `@safelock/shared` so the API's charge and the UI's quote cannot disagree,
 * and they are tested here because this workspace owns the only vitest runner.
 *
 * The grace boundary and the per-started-hour rule get the most attention:
 * they are the two places a user would notice an off-by-one as money.
 */

/** The dev defaults: ₹100/hour, 1.5×, 15 min grace, 24h cap, 30 min to collect. */
const RATES: RateSnapshot = {
  hourlyRatePaise: 10_000,
  overstayMultiplierBps: 15_000,
  graceMinutes: 15,
  capHours: 24,
  collectionWindowMinutes: 30,
  currency: 'INR',
};

const ENDS_AT = new Date('2026-10-17T12:00:00.000Z');

/** `endsAt` plus minutes, for readable boundary arithmetic. */
function at(minutes: number, seconds = 0, ms = 0): Date {
  return new Date(ENDS_AT.getTime() + minutes * 60_000 + seconds * 1000 + ms);
}

describe('bookingPricePaise', () => {
  it('is the hourly rate times the hours', () => {
    expect(bookingPricePaise(RATES, 1)).toBe(10_000);
    expect(bookingPricePaise(RATES, 3)).toBe(30_000);
    expect(bookingPricePaise(RATES, 24)).toBe(240_000);
  });

  it('stays an integer number of paise', () => {
    const odd: RateSnapshot = { ...RATES, hourlyRatePaise: 9_999 };
    for (const hours of [1, 2, 7, 24]) {
      expect(Number.isInteger(bookingPricePaise(odd, hours))).toBe(true);
    }
  });
});

describe('overstayHourlyPaise', () => {
  it('applies the multiplier in basis points', () => {
    expect(overstayHourlyPaise(RATES)).toBe(15_000);
    expect(overstayHourlyPaise({ ...RATES, overstayMultiplierBps: BPS_DIVISOR })).toBe(10_000);
    expect(overstayHourlyPaise({ ...RATES, overstayMultiplierBps: 20_000 })).toBe(20_000);
  });

  /**
   * The reason the multiplier is basis points and not a float: a fractional
   * paisa cannot be charged, so it must be rounded away at the point of
   * definition rather than carried around.
   */
  it('rounds to a whole paisa', () => {
    const awkward: RateSnapshot = {
      ...RATES,
      hourlyRatePaise: 3_333,
      overstayMultiplierBps: 15_000,
    };
    // 3333 * 1.5 = 4999.5 -> 5000
    expect(overstayHourlyPaise(awkward)).toBe(5_000);
    expect(Number.isInteger(overstayHourlyPaise(awkward))).toBe(true);
  });
});

describe('the grace boundary', () => {
  it('starts charging exactly graceMinutes after endsAt', () => {
    expect(overstayStartsAt(RATES, ENDS_AT).toISOString()).toBe('2026-10-17T12:15:00.000Z');
  });

  it('charges nothing up to and including the boundary', () => {
    // Before endsAt at all.
    expect(overstayFeePaise(RATES, ENDS_AT, at(-60))).toBe(0);
    // Inside the grace period.
    expect(overstayFeePaise(RATES, ENDS_AT, at(1))).toBe(0);
    expect(overstayFeePaise(RATES, ENDS_AT, at(14, 59))).toBe(0);
    // Exactly on the boundary: still nothing.
    expect(overstayFeePaise(RATES, ENDS_AT, at(15))).toBe(0);
    expect(overstayHoursAccrued(RATES, ENDS_AT, at(15))).toBe(0);
  });

  it('charges a full hour one millisecond past the boundary', () => {
    expect(overstayHoursAccrued(RATES, ENDS_AT, at(15, 0, 1))).toBe(1);
    expect(overstayFeePaise(RATES, ENDS_AT, at(15, 0, 1))).toBe(15_000);
  });
});

describe('per started hour', () => {
  it('rounds up, so five minutes over costs an hour', () => {
    expect(overstayHoursAccrued(RATES, ENDS_AT, at(20))).toBe(1);
    expect(overstayFeePaise(RATES, ENDS_AT, at(20))).toBe(15_000);
  });

  it('turns over on the hour, not before', () => {
    // 15 + 60 = 75 minutes past endsAt is exactly one hour of overstay.
    expect(overstayHoursAccrued(RATES, ENDS_AT, at(75))).toBe(1);
    expect(overstayHoursAccrued(RATES, ENDS_AT, at(75, 0, 1))).toBe(2);
    expect(overstayFeePaise(RATES, ENDS_AT, at(75, 0, 1))).toBe(30_000);
  });

  it('accumulates linearly between turnovers', () => {
    expect(overstayHoursAccrued(RATES, ENDS_AT, at(15 + 60 * 3))).toBe(3);
    expect(overstayFeePaise(RATES, ENDS_AT, at(15 + 60 * 3))).toBe(45_000);
  });
});

describe('the cap', () => {
  it('stops accruing at capHours', () => {
    expect(overstayHoursAccrued(RATES, ENDS_AT, at(15 + 60 * 24))).toBe(24);
    // A week later: still 24.
    expect(overstayHoursAccrued(RATES, ENDS_AT, at(15 + 60 * 24 * 7))).toBe(24);
  });

  it('bounds the money, which is what the cap is for', () => {
    expect(overstayMaxFeePaise(RATES)).toBe(24 * 15_000);
    expect(overstayFeePaise(RATES, ENDS_AT, at(15 + 60 * 1000))).toBe(overstayMaxFeePaise(RATES));
  });
});

describe('reservedUntilFrom', () => {
  /**
   * The device stays reserved through the grace period *and* the collection
   * window, because the safe may still hold someone's belongings for all of
   * it. Selling a back-to-back booking into that window would hand the next
   * renter a safe that is not empty.
   */
  it('covers the grace period plus the collection window', () => {
    expect(reservedUntilFrom(RATES, ENDS_AT).toISOString()).toBe('2026-10-17T12:45:00.000Z');
  });
});

describe('collectByFrom', () => {
  it('is the collection window after the fee is settled', () => {
    const settled = new Date('2026-10-17T18:00:00.000Z');
    expect(collectByFrom(RATES, settled).toISOString()).toBe('2026-10-17T18:30:00.000Z');
  });
});

// --- Effective status --------------------------------------------------------

const BASE = {
  endsAt: ENDS_AT,
  holdExpiresAt: null,
  overstaySettledAt: null,
  snapshot: RATES,
};

describe('effectiveBookingStatus', () => {
  it('leaves terminal statuses alone, whatever the clock says', () => {
    for (const status of ['COMPLETED', 'CANCELLED', 'EXPIRED_UNPAID'] as const) {
      expect(
        effectiveBookingStatus({ ...BASE, status, now: at(60 * 1000) }),
      ).toBe(status);
    }
  });

  it('expires an unpaid hold on the clock, not on a sweeper', () => {
    const holdExpiresAt = new Date('2026-10-17T11:10:00.000Z');

    expect(
      effectiveBookingStatus({
        ...BASE,
        status: 'PENDING_PAYMENT',
        holdExpiresAt,
        now: new Date('2026-10-17T11:09:59.000Z'),
      }),
    ).toBe('PENDING_PAYMENT');

    // At the instant it lapses, and after.
    for (const now of ['2026-10-17T11:10:00.000Z', '2026-10-17T11:30:00.000Z']) {
      expect(
        effectiveBookingStatus({
          ...BASE,
          status: 'PENDING_PAYMENT',
          holdExpiresAt,
          now: new Date(now),
        }),
      ).toBe('EXPIRED_UNPAID');
    }
  });

  /**
   * The property the whole design rests on: an `ACTIVE` row past its grace
   * period reads as `OVERSTAY` **without anything having run**. A missed sweep
   * can therefore never leave a safe unlockable.
   */
  it('reads an ACTIVE row past grace as OVERSTAY with no sweeper involved', () => {
    expect(effectiveBookingStatus({ ...BASE, status: 'ACTIVE', now: at(10) })).toBe('ACTIVE');
    expect(effectiveBookingStatus({ ...BASE, status: 'ACTIVE', now: at(15) })).toBe('ACTIVE');
    expect(effectiveBookingStatus({ ...BASE, status: 'ACTIVE', now: at(16) })).toBe('OVERSTAY');
    expect(effectiveBookingStatus({ ...BASE, status: 'ACTIVE', now: at(60 * 48) })).toBe(
      'OVERSTAY',
    );
  });

  it('keeps a settled overstay in OVERSTAY until the collection window closes', () => {
    const settledAt = at(30);

    expect(
      effectiveBookingStatus({
        ...BASE,
        status: 'OVERSTAY',
        overstaySettledAt: settledAt,
        now: at(45),
      }),
    ).toBe('OVERSTAY');

    // One minute past the 30-minute window: over, contents unknown.
    expect(
      effectiveBookingStatus({
        ...BASE,
        status: 'OVERSTAY',
        overstaySettledAt: settledAt,
        now: at(61),
      }),
    ).toBe('COMPLETED');
  });

  it('keeps an unsettled overstay in OVERSTAY indefinitely', () => {
    // Nobody paid and nobody collected: the booking stays open, the device
    // stays reserved, and an admin sees it flagged. It must never quietly
    // complete and release a safe with someone's things in it.
    expect(
      effectiveBookingStatus({ ...BASE, status: 'OVERSTAY', now: at(60 * 24 * 30) }),
    ).toBe('OVERSTAY');
  });
});

describe('unlockEligibility', () => {
  it('allows an active booking', () => {
    expect(unlockEligibility({ ...BASE, status: 'ACTIVE', now: at(-30) })).toEqual({
      allowed: true,
    });
  });

  it('refuses an unpaid overstay with its own reason', () => {
    expect(unlockEligibility({ ...BASE, status: 'ACTIVE', now: at(20) })).toEqual({
      allowed: false,
      reason: 'OVERSTAY_FEE_DUE',
    });
  });

  it('allows a settled overstay inside the collection window', () => {
    // The entire point of paying the fee.
    expect(
      unlockEligibility({
        ...BASE,
        status: 'OVERSTAY',
        overstaySettledAt: at(20),
        now: at(25),
      }),
    ).toEqual({ allowed: true });
  });

  it('refuses once the collection window has closed', () => {
    expect(
      unlockEligibility({
        ...BASE,
        status: 'OVERSTAY',
        overstaySettledAt: at(20),
        now: at(60),
      }),
    ).toEqual({ allowed: false, reason: 'NO_ACTIVE_BOOKING' });
  });

  it('refuses every terminal and pending state', () => {
    for (const status of [
      'PENDING_PAYMENT',
      'COMPLETED',
      'CANCELLED',
      'EXPIRED_UNPAID',
    ] as const) {
      expect(unlockEligibility({ ...BASE, status, now: at(-30) }), status).toEqual({
        allowed: false,
        reason: 'NO_ACTIVE_BOOKING',
      });
    }
  });

  /**
   * An overstay sitting exactly on the grace boundary has no fee yet, so it is
   * still `ACTIVE` and still unlocks. The boundary must not be a dead zone
   * where the user can neither use the safe nor pay anything.
   */
  it('has no dead zone on the grace boundary', () => {
    expect(unlockEligibility({ ...BASE, status: 'ACTIVE', now: at(15) })).toEqual({
      allowed: true,
    });
  });
});
