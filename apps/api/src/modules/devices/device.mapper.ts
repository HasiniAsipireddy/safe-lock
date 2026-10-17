import { effectiveBookingStatus } from '@safelock/shared';
import type {
  AdminDeviceRow,
  BookingStatus,
  DeviceCurrentBooking,
  DeviceStatus,
  DeviceSummary,
} from '@safelock/shared';
import { snapshotOf, type BookingRow } from '../bookings/booking.mapper';

/**
 * Explicit column lists for every device query.
 *
 * Nothing here selects `credentialHash`. Using `select` rather than returning
 * whole rows means a column added to the schema later — a device secret, say —
 * cannot leak into an API response just because someone forgot to exclude it.
 */

/** Columns needed for the renter-facing view. */
export const DEVICE_SUMMARY_SELECT = {
  id: true,
  serialNumber: true,
  lockState: true,
  lockStateUpdatedAt: true,
  online: true,
  lastSeenAt: true,
} as const;

/**
 * Columns needed for the admin inventory view.
 *
 * The occupying booking comes with it, because "who has this safe and until
 * when" is the first thing an admin looking at inventory wants to know. It is
 * fetched as the **live** bookings for the device — at most one can exist, the
 * exclusion constraint guarantees it — rather than as a column on `Device`,
 * which is exactly the denormalised ownership field the rental model removed.
 */
export const ADMIN_DEVICE_SELECT = {
  id: true,
  serialNumber: true,
  status: true,
  lockState: true,
  lockStateUpdatedAt: true,
  online: true,
  lastSeenAt: true,
  inspectionNote: true,
  inspectionNotedAt: true,
  createdAt: true,
  bookings: {
    /**
     * The live booking, expressed as `completedAt: null`.
     *
     * Equivalent to the three occupying statuses, and deliberately not written
     * as `status: { in: [...] }`: an `as const` object cannot carry a mutable
     * array, and splitting the select to work around that would put the
     * definition of "live" in two places. Every terminal transition —
     * complete, cancel, expire — stamps `completedAt`, so the two predicates
     * cannot drift apart without a booking ending without a timestamp, which
     * nothing does.
     */
    where: { completedAt: null },
    orderBy: { createdAt: 'desc' },
    take: 1,
    select: {
      id: true,
      status: true,
      endsAt: true,
      holdExpiresAt: true,
      overstaySettledAt: true,
      overstayWaivedAt: true,
      hourlyRatePaise: true,
      overstayMultiplierBps: true,
      graceMinutes: true,
      capHours: true,
      collectionWindowMinutes: true,
      currency: true,
      user: { select: { id: true, name: true, email: true } },
    },
  },
} as const;

interface DeviceSummaryRow {
  id: string;
  serialNumber: string;
  lockState: 'LOCKED' | 'UNLOCKED' | 'UNKNOWN';
  lockStateUpdatedAt: Date | null;
  online: boolean;
  lastSeenAt: Date | null;
}

export function toDeviceSummary(device: DeviceSummaryRow): DeviceSummary {
  return {
    id: device.id,
    serialNumber: device.serialNumber,
    lockState: device.lockState,
    lockStateUpdatedAt: device.lockStateUpdatedAt
      ? device.lockStateUpdatedAt.toISOString()
      : null,
    online: device.online,
    lastSeenAt: device.lastSeenAt ? device.lastSeenAt.toISOString() : null,
  };
}

/** The subset of a booking row the device view needs. */
export interface DeviceBookingRow
  extends Pick<
    BookingRow,
    | 'id'
    | 'status'
    | 'endsAt'
    | 'holdExpiresAt'
    | 'overstaySettledAt'
    | 'overstayWaivedAt'
    | 'hourlyRatePaise'
    | 'overstayMultiplierBps'
    | 'graceMinutes'
    | 'capHours'
    | 'collectionWindowMinutes'
    | 'currency'
  > {
  user: { id: string; name: string; email: string };
}

interface AdminDeviceRowSource extends DeviceSummaryRow {
  status: DeviceStatus;
  createdAt: Date;
  inspectionNote: string | null;
  inspectionNotedAt: Date | null;
  bookings: DeviceBookingRow[];
}

/**
 * The effective status of a device's occupying booking.
 *
 * Derived from the clock here as everywhere else, so the admin list shows a
 * lapsed hold as lapsed rather than as a safe somebody still holds — the
 * sweeper's lag must not be visible as wrong data.
 */
function toCurrentBooking(row: DeviceBookingRow): DeviceCurrentBooking {
  const snapshot = snapshotOf(row);

  const effective: BookingStatus = effectiveBookingStatus({
    status: row.status,
    endsAt: row.endsAt,
    holdExpiresAt: row.holdExpiresAt,
    overstaySettledAt: row.overstaySettledAt ?? row.overstayWaivedAt,
    snapshot,
    now: new Date(),
  });

  return {
    id: row.id,
    status: row.status,
    effectiveStatus: effective,
    endsAt: row.endsAt ? row.endsAt.toISOString() : null,
    user: row.user,
  };
}

export function toAdminDeviceRow(device: AdminDeviceRowSource): AdminDeviceRow {
  const live = device.bookings[0];

  return {
    ...toDeviceSummary(device),
    status: device.status,
    createdAt: device.createdAt.toISOString(),
    currentBooking: live ? toCurrentBooking(live) : null,
    inspectionNote: device.inspectionNote,
    inspectionNotedAt: device.inspectionNotedAt
      ? device.inspectionNotedAt.toISOString()
      : null,
  };
}
