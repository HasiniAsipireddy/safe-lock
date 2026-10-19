import { unlockEligibility, type LockState } from '@safelock/shared';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { AUDIT_ACTIONS, writeAudit } from '../audit/audit.service';
import { BOOKING_SELECT, snapshotOf, type BookingRow } from '../bookings/booking.mapper';
import { createCommand, publishCommand } from './command.service';

/**
 * Reconciling a safe that should not be open.
 *
 * The completion lock (`lockAfterCompletion`) handles the lock we *asked* for.
 * This handles the one nobody asked for: a safe that reports itself open when
 * no booking entitles anyone to have it open.
 *
 * A device reaches that state without any command of ours — a firmware fault, a
 * power event that left the bolt withdrawn, an inspection someone walked away
 * from, or a `COLLECTED` booking whose completion lock was lost while the
 * process was down. The common thread is that the record and the physical world
 * disagree, and the physical world is the one holding somebody's property.
 *
 * ## This is not a command queue, and must not be read as one
 * A user `LOCK` to an offline safe is still refused, 409 `DEVICE_OFFLINE`,
 * never queued, because a person is standing there waiting and "we cannot reach
 * your safe" is the true answer. The reconciler is the opposite situation in
 * every respect: nobody is waiting, the correct end state is not a judgement
 * call, and it only ever runs **because a device just spoke to us** — it is
 * reacting to a live connection, not holding an instruction against a dead one.
 * A queue is a promise about the future; this is a response to the present.
 *
 * ## `lockState` still only moves on an ack
 * Nothing here writes `LOCKED`. It publishes, and the device's ack moves the
 * state exactly as for any other command. A safe that reports open and never
 * acks the lock stays recorded as open — correctly, because it is — and
 * escalates through the sweeper like any other system lock.
 */

/**
 * Checks one device's reported state and reconciles it if nobody is entitled to
 * it being open.
 *
 * @param reportedLockState What the device just said. For a `/status` message,
 *   which carries no lock state, the caller passes the stored one: a device
 *   reconnecting while recorded `UNLOCKED` is the same incident arriving by a
 *   different route, and §8.3 covers both.
 * @returns Whether a reconciling lock was issued.
 */
export async function reconcileUnexpectedUnlock(input: {
  deviceId: string;
  reportedLockState: LockState;
  now?: Date;
}): Promise<boolean> {
  if (input.reportedLockState !== 'UNLOCKED') return false;

  const now = input.now ?? new Date();

  const booking = (await prisma.booking.findFirst({
    where: { deviceId: input.deviceId, status: { in: ['ACTIVE', 'OVERSTAY'] } },
    orderBy: { createdAt: 'desc' },
    select: BOOKING_SELECT,
  })) as BookingRow | null;

  /**
   * "Permits" is `unlockEligibility` on the device's live booking — the same
   * function the unlock path uses, derived from the same server clock.
   *
   * Not `Booking.status`, which a wedged sweeper can leave stale, and not a
   * bare "has a booking", which would leave a safe standing open for a renter
   * whose collection window lapsed an hour ago. A booking that may not *open*
   * the safe is a booking that may not have it open.
   */
  const eligibility = booking
    ? unlockEligibility({
        status: booking.status,
        endsAt: booking.endsAt,
        holdExpiresAt: booking.holdExpiresAt,
        overstaySettledAt: booking.overstaySettledAt ?? booking.overstayWaivedAt,
        snapshot: snapshotOf(booking),
        now,
      })
    : { allowed: false as const, reason: 'NO_ACTIVE_BOOKING' as const };

  if (eligibility.allowed) return false;

  const issued = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Device" WHERE "id" = ${input.deviceId} FOR UPDATE`;

    const device = await tx.device.findUnique({
      where: { id: input.deviceId },
      select: { id: true, unexpectedUnlockAt: true },
    });
    if (!device) return null;

    /**
     * **At most one reconcile in flight per device.** Taken under the row lock,
     * so a safe heartbeating every 60 seconds while jammed produces one retry
     * chain rather than one per heartbeat — and a reconnect storm is harmless
     * for the same reason. The partial unique index enforces it too; this makes
     * the ordinary case a clean skip instead of a caught constraint violation.
     */
    const inFlight = await tx.command.findFirst({
      where: {
        deviceId: input.deviceId,
        systemActor: { not: null },
        status: { in: ['PENDING', 'SENT'] },
      },
      select: { id: true },
    });
    if (inFlight) return null;

    /**
     * Flagged **on issue, not on failure.**
     *
     * A safe found open with nobody entitled to it is already an incident; the
     * lock then succeeding makes it a resolved incident rather than a
     * non-event. The flag clears when a later report shows the safe `LOCKED` —
     * which is a claim about the safe's state, where "the lock command acked"
     * is only evidence of it.
     */
    if (!device.unexpectedUnlockAt) {
      await tx.device.update({
        where: { id: device.id },
        data: { unexpectedUnlockAt: now },
      });
    }

    /**
     * An ordinary command, through the ordinary lifecycle: the same rows, the
     * same sequence allocation under the same lock, the same ack handling, the
     * same retry and escalation. A reconcile is not a special kind of command,
     * it is an ordinary command with a different reason for existing.
     */
    return createCommand(tx, {
      deviceId: device.id,
      type: 'LOCK',
      systemActor: 'SWEEPER',
      now,
    });
  });

  if (!issued) return false;

  await writeAudit({
    action: AUDIT_ACTIONS.DEVICE_UNEXPECTED_UNLOCKED_RECONCILED,
    deviceId: input.deviceId,
    metadata: {
      commandId: issued.id,
      reportedLockState: input.reportedLockState,
      bookingId: booking?.id ?? null,
      // Ids and enum values only, as the audit scrubber requires.
      reason: eligibility.allowed ? null : eligibility.reason,
    },
  });

  logger.warn(
    { deviceId: input.deviceId, commandId: issued.id, bookingId: booking?.id ?? null },
    'A safe reported itself open with nobody entitled to it; locking it',
  );

  await publishCommand(issued);

  return true;
}
