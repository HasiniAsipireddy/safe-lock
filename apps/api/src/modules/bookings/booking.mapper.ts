import {
  collectByFrom,
  effectiveBookingStatus,
  overstayFeePaise,
  overstayHoursAccrued,
  type BookingStatus,
  type BookingSummary,
  type RateSnapshot,
  type SafeSize,
} from '@safelock/shared';

/**
 * Turning a `Booking` row into what a client sees.
 *
 * The one rule worth stating: **`effectiveStatus`, the fee and the collection
 * deadline are all derived from the server clock at read time**, never read
 * from a column. A sweeper that is late, wedged or has never run therefore
 * cannot make a response wrong, and in particular cannot make a safe look
 * unlockable when it is not.
 */

/** The columns every booking read needs. No admin-only or internal fields. */
export const BOOKING_SELECT = {
  id: true,
  userId: true,
  deviceId: true,
  status: true,
  hours: true,
  startsAt: true,
  endsAt: true,
  holdExpiresAt: true,
  reservedUntil: true,
  pricePaise: true,
  currency: true,
  safeSize: true,
  hourlyRatePaise: true,
  overstayMultiplierBps: true,
  graceMinutes: true,
  capHours: true,
  collectionWindowMinutes: true,
  overstaySettledAt: true,
  overstayPaidPaise: true,
  overstayWaivedAt: true,
  completedAt: true,
  completionReason: true,
  createdAt: true,
  device: { select: { serialNumber: true } },
} as const;

export interface BookingRow {
  id: string;
  userId: string;
  deviceId: string;
  status: BookingStatus;
  hours: number;
  startsAt: Date;
  endsAt: Date | null;
  holdExpiresAt: Date | null;
  reservedUntil: Date;
  pricePaise: number;
  currency: string;
  safeSize: SafeSize;
  hourlyRatePaise: number;
  overstayMultiplierBps: number;
  graceMinutes: number;
  capHours: number;
  collectionWindowMinutes: number;
  overstaySettledAt: Date | null;
  overstayPaidPaise: number;
  overstayWaivedAt: Date | null;
  completedAt: Date | null;
  completionReason: 'COLLECTED' | 'COLLECTION_WINDOW_LAPSED' | 'ADMIN_FORCE_COMPLETED' | null;
  createdAt: Date;
  device: { serialNumber: string };
}

/**
 * The columns a rate snapshot is rebuilt from.
 *
 * Narrower than {@link BookingRow} on purpose: the admin device view selects
 * only these, and widening the parameter would force a cast there that hides a
 * real mismatch if the snapshot ever gains a field.
 */
export type RateSnapshotSource = Pick<
  BookingRow,
  | 'hourlyRatePaise'
  | 'overstayMultiplierBps'
  | 'graceMinutes'
  | 'capHours'
  | 'collectionWindowMinutes'
  | 'currency'
>;

/** The rates this booking was created under. Never the live config. */
export function snapshotOf(row: RateSnapshotSource): RateSnapshot {
  return {
    hourlyRatePaise: row.hourlyRatePaise,
    overstayMultiplierBps: row.overstayMultiplierBps,
    graceMinutes: row.graceMinutes,
    capHours: row.capHours,
    collectionWindowMinutes: row.collectionWindowMinutes,
    currency: row.currency,
  };
}

/**
 * The fee outstanding right now.
 *
 * Zero once settled or waived — those are the two ways a fee stops being owed,
 * and neither rewinds `endsAt`, so without checking them the arithmetic would
 * keep billing someone who has already paid.
 */
export function outstandingFeePaise(row: BookingRow, now: Date): number {
  if (row.overstaySettledAt || row.overstayWaivedAt) return 0;
  if (!row.endsAt) return 0;

  return overstayFeePaise(snapshotOf(row), row.endsAt, now);
}

export function toBookingSummary(row: BookingRow, now = new Date()): BookingSummary {
  const snapshot = snapshotOf(row);

  const effective = effectiveBookingStatus({
    status: row.status,
    endsAt: row.endsAt,
    holdExpiresAt: row.holdExpiresAt,
    overstaySettledAt: row.overstaySettledAt ?? row.overstayWaivedAt,
    snapshot,
    now,
  });

  const settledAt = row.overstaySettledAt ?? row.overstayWaivedAt;

  return {
    id: row.id,
    status: row.status,
    effectiveStatus: effective,
    serialNumber: row.device.serialNumber,
    deviceId: row.deviceId,
    safeSize: row.safeSize,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt ? row.endsAt.toISOString() : null,
    holdExpiresAt: row.holdExpiresAt ? row.holdExpiresAt.toISOString() : null,
    hours: row.hours,
    pricePaise: row.pricePaise,
    currency: row.currency,
    rates: snapshot,
    overstayFeePaise: outstandingFeePaise(row, now),
    overstayHours: row.endsAt ? overstayHoursAccrued(snapshot, row.endsAt, now) : 0,
    overstaySettledAt: row.overstaySettledAt ? row.overstaySettledAt.toISOString() : null,
    collectBy: settledAt ? collectByFrom(snapshot, settledAt).toISOString() : null,
    completionReason: row.completionReason,
    createdAt: row.createdAt.toISOString(),
  };
}
