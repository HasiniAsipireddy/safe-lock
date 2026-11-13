import { AUTO_LOCK_AFTER_MINUTES } from '@safelock/shared';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { AUDIT_ACTIONS, writeAudit } from '../audit/audit.service';
import { isDeviceOnline } from '../devices/device.mapper';
import { createCommand, publishCommand } from './command.service';

/**
 * Auto-lock: a safe left unlocked for {@link AUTO_LOCK_AFTER_MINUTES} after a
 * confirmed unlock is locked by the server.
 *
 * ## What starts the clock
 * The **ack** of the last `UNLOCK` command, not `Device.lockStateUpdatedAt`.
 * That column moves on every state report — the ESP32 gateway polls every few
 * seconds — so it means "last confirmed", not "last changed", and a timer
 * keyed on it would never expire. A safe opened with its physical key has no
 * acked unlock and is deliberately left alone: we did not open it and cannot
 * know why it is open.
 *
 * ## When it does nothing
 * - a `LOCK` of any kind was issued after that unlock was acked — the renter
 *   (or a previous auto-lock, or the completion flow) already tried, and a
 *   failed system lock has its own retry and escalation in the sweeper;
 * - the door is reported `OPEN` — throwing a bolt into an open door secures
 *   nothing and would read on the dashboard as "locked";
 * - the safe is offline — the publish would fail, and the next tick tries again;
 * - the unlock's booking is no longer live — `reconcileUnexpectedUnlock` owns
 *   a safe open with nobody entitled to it;
 * - any command is already in flight for the device.
 *
 * ## It is an ordinary system command
 * Same sequence allocation, same row lock, same ack handling, same retries and
 * the same escalation to `NEEDS_INSPECTION` on exhaustion. What differs is the
 * actor, `AUTO_LOCK`, which is how the ack handler knows to write an
 * `AUTO_LOCK` event to the renter's activity feed.
 */

const AUTO_LOCK_AFTER_MS = AUTO_LOCK_AFTER_MINUTES * 60_000;

interface UnlockAnchor {
  ackedAt: Date;
  bookingId: string | null;
}

/** The acked unlock that would start an auto-lock timer, or null. */
async function unlockAnchorFor(deviceId: string): Promise<UnlockAnchor | null> {
  const lastUnlock = await prisma.command.findFirst({
    where: { deviceId, type: 'UNLOCK', status: 'ACKED', ackedAt: { not: null } },
    orderBy: { ackedAt: 'desc' },
    select: { ackedAt: true, bookingId: true },
  });
  if (!lastUnlock?.ackedAt) return null;

  const lockSince = await prisma.command.findFirst({
    where: { deviceId, type: 'LOCK', issuedAt: { gte: lastUnlock.ackedAt } },
    select: { id: true },
  });
  if (lockSince) return null;

  return { ackedAt: lastUnlock.ackedAt, bookingId: lastUnlock.bookingId };
}

/**
 * When the dashboard should say the safe will lock itself, or null.
 *
 * Read-only and cheap enough for `GET /devices/mine`: two indexed lookups, and
 * only for a safe that is currently `UNLOCKED`.
 */
export async function autoLockDueAt(device: {
  id: string;
  lockState: string;
  doorState: string;
}): Promise<Date | null> {
  if (device.lockState !== 'UNLOCKED' || device.doorState === 'OPEN') return null;
  const anchor = await unlockAnchorFor(device.id);
  return anchor ? new Date(anchor.ackedAt.getTime() + AUTO_LOCK_AFTER_MS) : null;
}

/**
 * One pass over every unlocked safe. Called from the command sweeper's tick.
 *
 * @returns How many auto-lock commands were issued.
 */
export async function sweepAutoLocks(now: Date = new Date()): Promise<number> {
  const candidates = await prisma.device.findMany({
    where: { lockState: 'UNLOCKED', status: { not: 'RETIRED' }, doorState: { not: 'OPEN' } },
    select: { id: true, online: true, lastSeenAt: true },
  });

  let issued = 0;

  for (const device of candidates) {
    try {
      if (await autoLockOne(device, now)) issued += 1;
    } catch (cause) {
      // One device's failure must not stop the others being considered.
      logger.error(
        { deviceId: device.id, reason: cause instanceof Error ? cause.message : 'unknown' },
        'Auto-lock failed for a device',
      );
    }
  }

  return issued;
}

async function autoLockOne(
  device: { id: string; online: boolean; lastSeenAt: Date | null },
  now: Date,
): Promise<boolean> {
  if (!isDeviceOnline(device, now)) return false;

  const anchor = await unlockAnchorFor(device.id);
  if (!anchor || !anchor.bookingId) return false;
  if (now.getTime() - anchor.ackedAt.getTime() < AUTO_LOCK_AFTER_MS) return false;

  const booking = await prisma.booking.findUnique({
    where: { id: anchor.bookingId },
    select: { id: true, userId: true, status: true },
  });
  if (!booking || (booking.status !== 'ACTIVE' && booking.status !== 'OVERSTAY')) return false;

  const command = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Device" WHERE "id" = ${device.id} FOR UPDATE`;

    // Re-read under the lock: the renter may have tapped Lock a moment ago.
    const current = await tx.device.findUnique({
      where: { id: device.id },
      select: { lockState: true, doorState: true },
    });
    if (!current || current.lockState !== 'UNLOCKED' || current.doorState === 'OPEN') return null;

    const inFlight = await tx.command.findFirst({
      where: { deviceId: device.id, status: { in: ['PENDING', 'SENT'] } },
      select: { id: true },
    });
    if (inFlight) return null;

    const lockSince = await tx.command.findFirst({
      where: { deviceId: device.id, type: 'LOCK', issuedAt: { gte: anchor.ackedAt } },
      select: { id: true },
    });
    if (lockSince) return null;

    return createCommand(tx, {
      deviceId: device.id,
      type: 'LOCK',
      systemActor: 'AUTO_LOCK',
      bookingId: booking.id,
      now,
    });
  });

  if (!command) return false;

  await writeAudit({
    action: AUDIT_ACTIONS.DEVICE_AUTO_LOCK_ISSUED,
    userId: booking.userId,
    deviceId: device.id,
    metadata: {
      commandId: command.id,
      bookingId: booking.id,
      openForMs: now.getTime() - anchor.ackedAt.getTime(),
    },
  });

  logger.info(
    { deviceId: device.id, commandId: command.id, bookingId: booking.id },
    'Safe left unlocked past the auto-lock timeout; locking it',
  );

  await publishCommand(command);
  return true;
}
