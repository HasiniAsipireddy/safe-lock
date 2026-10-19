import { effectiveBookingStatus } from '@safelock/shared';
import type {
  AdminCommandRow,
  AdminDeviceRow,
  BookingStatus,
  CommandActor,
  CommandFailureCategory,
  CommandStatus,
  CommandType,
  DeviceCurrentBooking,
  DeviceFlag,
  DeviceStatus,
  DeviceSummary,
  DoorState,
} from '@safelock/shared';
import { DEVICE_OFFLINE_AFTER_MS, env } from '../../config/env';
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
  doorState: true,
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
  doorState: true,
  inspectionNote: true,
  inspectionNotedAt: true,
  createdAt: true,

  /**
   * Hardware diagnostics. Note what is still absent: `credentialHash`,
   * `commandSeq` and `commandKeyVersion`. The first is a secret; the other two
   * are inputs to a signed canonical string, and nothing that feeds a
   * signature is serialised to a client.
   */
  firmwareVersion: true,
  rssi: true,
  clockSynced: true,
  credentialIssuedAt: true,
  lockCommandFailedAt: true,
  unexpectedUnlockAt: true,

  /**
   * The most recent commands, newest first, for the consecutive-failure flag.
   *
   * Taken as `COMMAND_FAILURE_FLAG_THRESHOLD` rows because that is exactly how
   * many the flag needs to look at: "three in a row failed" is a question
   * about the last three, and fetching twenty to answer it would be twenty
   * rows per device per page.
   */
  commands: {
    orderBy: { issuedAt: 'desc' },
    take: env.COMMAND_FAILURE_FLAG_THRESHOLD,
    select: { status: true },
  },
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
  doorState: DoorState;
}

/**
 * Whether a device is reachable, derived from both signals.
 *
 * `online` is what the device last *claimed*, through its retained `/status`
 * topic or its last will. `lastSeenAt` is when we last heard anything from it
 * at all. Both are required, because each misses something the other catches:
 * the will catches a clean drop within about a keepalive, and the heartbeat age
 * catches what a will cannot — a device holding a TCP connection but wedged, or
 * a broker that restarted and lost the will it was holding.
 *
 * Derived on read rather than trusted from the stored boolean, so the column
 * can never become the stale authority. Same reflex as
 * `effectiveBookingStatus`: a stored flag is a claim about a moment, and every
 * caller is asking about now.
 */
export function isDeviceOnline(
  device: { online: boolean; lastSeenAt: Date | null },
  now: Date = new Date(),
): boolean {
  if (!device.online) return false;
  if (!device.lastSeenAt) return false;
  return now.getTime() - device.lastSeenAt.getTime() <= DEVICE_OFFLINE_AFTER_MS;
}

export function toDeviceSummary(
  device: DeviceSummaryRow,
  now: Date = new Date(),
): DeviceSummary {
  return {
    id: device.id,
    serialNumber: device.serialNumber,
    lockState: device.lockState,
    lockStateUpdatedAt: device.lockStateUpdatedAt
      ? device.lockStateUpdatedAt.toISOString()
      : null,
    online: isDeviceOnline(device, now),
    lastSeenAt: device.lastSeenAt ? device.lastSeenAt.toISOString() : null,
    doorState: device.doorState,
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
  firmwareVersion: string | null;
  rssi: number | null;
  clockSynced: boolean | null;
  credentialIssuedAt: Date | null;
  lockCommandFailedAt: Date | null;
  unexpectedUnlockAt: Date | null;
  commands: { status: CommandStatus }[];
  bookings: DeviceBookingRow[];
}

/** Command statuses that count as a failure for the consecutive-failure flag. */
const FAILED_COMMAND_STATUSES: readonly CommandStatus[] = [
  'TIMED_OUT',
  'FAILED',
  'REJECTED',
  'EXPIRED',
];

/**
 * Why this device needs a human, as a closed set.
 *
 * All five are derived rather than stored, except the two that are genuinely
 * events (`lockCommandFailedAt`, `unexpectedUnlockAt`) — and even those are
 * timestamps of something that happened, not a cached verdict, so clearing one
 * is an explicit act rather than a cache invalidation.
 */
function deviceFlags(device: AdminDeviceRowSource, now: Date): DeviceFlag[] {
  const flags: DeviceFlag[] = [];

  /**
   * Offline on its own is not a flag. A safe nobody has rented and that is
   * unplugged in a cupboard is not an incident — it is excluded from the
   * booking pick and that is the end of it. Offline *while somebody has paid
   * for it* is the whole point: that renter cannot open their safe.
   */
  if (!isDeviceOnline(device, now) && device.bookings.length > 0) {
    flags.push('OFFLINE_WITH_BOOKING');
  }

  // Only when there are at least that many to look at: two failures out of a
  // device's only two commands is not yet a pattern, and calling it one would
  // flag every new unit whose first command was lost.
  if (
    device.commands.length >= env.COMMAND_FAILURE_FLAG_THRESHOLD &&
    device.commands.every((command) => FAILED_COMMAND_STATUSES.includes(command.status))
  ) {
    flags.push('CONSECUTIVE_COMMAND_FAILURES');
  }

  if (device.lockCommandFailedAt) flags.push('LOCK_COMMAND_FAILED');
  if (device.unexpectedUnlockAt) flags.push('UNEXPECTED_UNLOCKED');

  /**
   * A door sensor that is not reporting.
   *
   * Only flagged for a device we have actually heard from: `UNKNOWN` on a
   * never-provisioned unit is simply "no reports yet", and flagging that would
   * mean every row in a fresh inventory arrives pre-flagged, which is how a
   * flagged list stops being read.
   */
  if (device.doorState === 'UNKNOWN' && device.lastSeenAt) {
    flags.push('DOOR_STATE_UNKNOWN');
  }

  return flags;
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

export function toAdminDeviceRow(
  device: AdminDeviceRowSource,
  now: Date = new Date(),
): AdminDeviceRow {
  const live = device.bookings[0];

  return {
    ...toDeviceSummary(device, now),
    status: device.status,
    createdAt: device.createdAt.toISOString(),
    currentBooking: live ? toCurrentBooking(live) : null,
    inspectionNote: device.inspectionNote,
    inspectionNotedAt: device.inspectionNotedAt
      ? device.inspectionNotedAt.toISOString()
      : null,
    firmwareVersion: device.firmwareVersion,
    rssi: device.rssi,
    clockSynced: device.clockSynced,
    /**
     * Whether a credential exists, never the credential. There is no endpoint
     * that reads one back — it is shown once, at issue, and only its `sha256`
     * is kept.
     */
    credentialIssued: device.credentialIssuedAt !== null,
    credentialIssuedAt: device.credentialIssuedAt
      ? device.credentialIssuedAt.toISOString()
      : null,
    lockCommandFailedAt: device.lockCommandFailedAt
      ? device.lockCommandFailedAt.toISOString()
      : null,
    flags: deviceFlags(device, now),
  };
}

/**
 * One row of the admin recent-commands expander.
 *
 * `latencyMs` is measured from `sentAt`, not `issuedAt`: the gap between
 * committing a row and publishing it is our own scheduling, and folding it
 * into a number labelled "device latency" would make our slowness look like
 * the hardware's.
 */
export function toAdminCommandRow(command: {
  id: string;
  type: CommandType;
  status: CommandStatus;
  failureCategory: CommandFailureCategory | null;
  userId: string | null;
  systemActor: CommandActor | null;
  issuedAt: Date;
  sentAt: Date | null;
  ackedAt: Date | null;
  lateAckedAt: Date | null;
}): AdminCommandRow {
  return {
    id: command.id,
    type: command.type,
    status: command.status,
    failureCategory: command.failureCategory,
    actor: command.userId ? 'USER' : (command.systemActor ?? 'SWEEPER'),
    issuedAt: command.issuedAt.toISOString(),
    latencyMs:
      command.sentAt && command.ackedAt
        ? command.ackedAt.getTime() - command.sentAt.getTime()
        : null,
    lateAcked: command.lateAckedAt !== null,
  };
}

/** Columns the recent-commands expander reads. No seq, no signing input. */
export const ADMIN_COMMAND_SELECT = {
  id: true,
  type: true,
  status: true,
  failureCategory: true,
  userId: true,
  systemActor: true,
  issuedAt: true,
  sentAt: true,
  ackedAt: true,
  lateAckedAt: true,
} as const;
