import { effectiveBookingStatus, reservedUntilFrom } from '@safelock/shared';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { AUDIT_ACTIONS, writeAudit } from '../audit/audit.service';
import { BOOKING_SELECT, snapshotOf, type BookingRow } from './booking.mapper';
import { completeBooking, lockAfterCompletion } from './booking.service';

/**
 * The booking sweeper.
 *
 * ## It does not decide anything
 * Every read derives a booking's state from the server clock
 * (`effectiveBookingStatus`), so the sweeper is a **reconciler**, not an
 * authority. If it is late, wedged, or has never run, no safe becomes
 * unlockable and no fee stops accruing — the only consequence is that rows and
 * device availability lag behind reality. That is the property that makes the
 * whole design safe to operate, and it is worth keeping true: nothing here may
 * ever become the only thing that enforces a transition.
 *
 * ## What it actually does
 * 1. Expires unpaid holds, releasing the safe for someone else.
 * 2. Moves `ACTIVE` rows past their grace period to `OVERSTAY`.
 * 3. Extends `reservedUntil` while a booking is overstaying, so a physically
 *    occupied safe cannot be booked by the next person.
 * 4. Completes bookings whose collection window has lapsed — and sends those
 *    devices to `NEEDS_INSPECTION`, because nobody confirmed the safe is
 *    empty.
 *
 * An **unpaid** overstay is deliberately left alone forever: the fee is capped,
 * the device stays reserved, and the row shows up in the admin flagged list. It
 * must never quietly complete and release a safe that may still hold somebody's
 * belongings.
 */

export interface SweepResult {
  expired: number;
  movedToOverstay: number;
  reservationsExtended: number;
  completed: number;
  /**
   * Rows this sweep could not reconcile.
   *
   * Non-zero is not a crash — each row is isolated — but it is worth being
   * visible, because a row that keeps failing is a row whose state is drifting
   * further from reality every minute.
   */
  failed: number;
}

/**
 * One sweep. Exported and callable directly, which is how the tests drive it —
 * nothing in the suite waits for a timer.
 */
export async function sweepBookings(options: { now?: Date } = {}): Promise<SweepResult> {
  const now = options.now ?? new Date();
  const result: SweepResult = {
    expired: 0,
    movedToOverstay: 0,
    reservationsExtended: 0,
    completed: 0,
    failed: 0,
  };

  // --- 1. Unpaid holds that lapsed ------------------------------------------
  //
  // A conditional update, so a payment landing at the same moment cannot be
  // overwritten: if the row has already gone ACTIVE the `status` precondition
  // fails and this touches nothing.
  const expired = await prisma.booking.updateMany({
    where: {
      status: 'PENDING_PAYMENT',
      holdExpiresAt: { lte: now },
    },
    data: { status: 'EXPIRED_UNPAID', completedAt: now, reservedUntil: now },
  });
  result.expired = expired.count;

  // --- 2, 3, 4. Rows whose deadlines have passed ----------------------------
  const live = (await prisma.booking.findMany({
    where: { status: { in: ['ACTIVE', 'OVERSTAY'] } },
    select: BOOKING_SELECT,
  })) as BookingRow[];

  for (const row of live) {
    /**
     * **Per row, not per sweep.**
     *
     * One row that cannot be reconciled must not stop the other rows being
     * reconciled. Before this was isolated, an overstay whose reservation
     * could not be extended (see `extendReservation`) threw out of the whole
     * loop, the tick's own catch logged it, and *every subsequent sweep failed
     * the same way* — so holds stopped expiring, nothing moved to OVERSTAY and
     * no collection window ever closed, for every booking in the system.
     * Found by running the sweeper against a live database rather than a test
     * that happened not to construct the collision. See docs/decisions.md.
     */
    try {
      await reconcile(row, now, result);
    } catch (cause) {
      result.failed += 1;
      logger.error(
        {
          bookingId: row.id,
          deviceId: row.deviceId,
          reason: cause instanceof Error ? cause.message : 'unknown',
        },
        'Could not reconcile a booking; continuing with the rest of the sweep',
      );
    }
  }

  return result;
}

/** One booking's reconciliation. Throws only for that row — see the caller. */
async function reconcile(row: BookingRow, now: Date, result: SweepResult): Promise<void> {
  const snapshot = snapshotOf(row);
  const settledAt = row.overstaySettledAt ?? row.overstayWaivedAt;

  const effective = effectiveBookingStatus({
    status: row.status,
    endsAt: row.endsAt,
    holdExpiresAt: row.holdExpiresAt,
    overstaySettledAt: settledAt,
    snapshot,
    now,
  });

  if (effective === 'COMPLETED') {
    /**
     * The collection window lapsed. The booking is over and the safe's
     * contents are **unknown** — the user never confirmed collection — so
     * the device goes for inspection rather than back into the pool.
     */
    await completeBooking({
      bookingId: row.id,
      reason: 'COLLECTION_WINDOW_LAPSED',
      needsInspection: true,
      now,
    });

    await lockAfterCompletion(row.deviceId);

    await writeAudit({
      action: AUDIT_ACTIONS.BOOKING_COLLECTION_LAPSED,
      userId: row.userId,
      deviceId: row.deviceId,
      metadata: { bookingId: row.id },
    });

    result.completed += 1;
    return;
  }

  if (effective === 'OVERSTAY') {
    const becameOverstay = row.status !== 'OVERSTAY';
    const reservedUntil = await extendReservation(row, now);

    if (becameOverstay || reservedUntil) {
      await prisma.booking.update({
        where: { id: row.id },
        data: {
          status: 'OVERSTAY',
          ...(reservedUntil ? { reservedUntil } : {}),
        },
      });

      if (becameOverstay) {
        result.movedToOverstay += 1;
        await writeAudit({
          action: AUDIT_ACTIONS.BOOKING_OVERSTAY_STARTED,
          userId: row.userId,
          deviceId: row.deviceId,
          metadata: { bookingId: row.id },
        });
      }
      if (reservedUntil) result.reservationsExtended += 1;
    }
    return;
  }

  // Still ACTIVE. An extension may have pulled it back from OVERSTAY, in
  // which case the stored status needs correcting and the reservation
  // shrinking back to the real end of the booking.
  if (row.status === 'OVERSTAY' && row.endsAt) {
    await prisma.booking.update({
      where: { id: row.id },
      data: { status: 'ACTIVE', reservedUntil: reservedUntilFrom(snapshot, row.endsAt) },
    });
  }
}

/**
 * How far an overstaying booking's reservation may be pushed out, or null if
 * it should be left alone.
 *
 * Keeping the safe reserved is what stops the exclusion constraint letting
 * someone book a safe that still has the previous renter's things in it. It is
 * pushed out in one-hour steps rather than straight to the cap, so an
 * abandoned booking does not block a device for longer than it has actually
 * been occupied.
 *
 * **The clamp is the point.** A back-to-back booking already holds this device
 * from the moment our reservation was due to end, and pushing past that start
 * violates the exclusion constraint. The constraint is right to refuse — two
 * bookings cannot occupy one safe — so the answer is not to force it but to
 * extend only as far as it legally can, which may be not at all.
 *
 * When it cannot extend, the booking still moves to `OVERSTAY` and still
 * accrues a fee, so nothing is lost but the reservation. The row shows up in
 * the admin flagged list, where a human decides what to do about two people
 * wanting one safe — which is a policy question, not something a sweeper
 * should settle silently. See the overstay-collision open question in
 * CLAUDE.md.
 */
async function extendReservation(row: BookingRow, now: Date): Promise<Date | null> {
  const wanted = new Date(now.getTime() + 60 * 60 * 1000);
  if (row.reservedUntil.getTime() >= wanted.getTime()) return null;

  // The next booking already holding this device after ours.
  const next = await prisma.booking.findFirst({
    where: {
      deviceId: row.deviceId,
      id: { not: row.id },
      status: { in: ['PENDING_PAYMENT', 'ACTIVE', 'OVERSTAY'] },
      startsAt: { gte: row.startsAt },
    },
    orderBy: { startsAt: 'asc' },
    select: { startsAt: true },
  });

  // `[)` bounds, so ending exactly at the next booking's start is legal.
  const ceiling = next?.startsAt ?? null;
  if (!ceiling) return wanted;

  if (ceiling.getTime() <= row.reservedUntil.getTime()) {
    // Already up against it. Nothing to extend into.
    logger.warn(
      { bookingId: row.id, deviceId: row.deviceId },
      'An overstaying booking cannot hold its safe any longer: another booking starts next',
    );
    return null;
  }

  return new Date(Math.min(wanted.getTime(), ceiling.getTime()));
}

// --- The loop ----------------------------------------------------------------

let timer: NodeJS.Timeout | null = null;
let running = false;

/**
 * Starts the sweep loop.
 *
 * Called from `server.ts` only — **never** from `createApp()`, exactly like
 * the outbox worker. A sweeper that started with the app would tick during the
 * test suite and race every assertion about booking state; tests call
 * {@link sweepBookings} directly instead.
 */
export function startBookingSweeper(): void {
  if (timer) return;

  timer = setInterval(() => {
    void tick();
  }, env.BOOKING_SWEEP_INTERVAL_MS);

  timer.unref();
  logger.info({ intervalMs: env.BOOKING_SWEEP_INTERVAL_MS }, 'Booking sweeper started');
}

export function stopBookingSweeper(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;

  try {
    const result = await sweepBookings();
    const touched =
      result.expired + result.movedToOverstay + result.completed + result.reservationsExtended;

    // A row that could not be reconciled is worth a line even when nothing
    // else happened: it is the signal that some booking's state is drifting.
    if (result.failed > 0) logger.warn(result, 'Booking sweep finished with failures');
    else if (touched > 0) logger.info(result, 'Booking sweep');
  } catch (cause) {
    /**
     * The backstop, not the normal path.
     *
     * Individual rows are isolated inside `sweepBookings`, so reaching here
     * means the sweep failed before or outside the per-row loop — the
     * expire-holds query, say. A failed sweep must never take the process
     * down, and correctness does not depend on it, so the next tick retries.
     */
    logger.error(
      { reason: cause instanceof Error ? cause.message : 'unknown' },
      'Booking sweep failed',
    );
  } finally {
    running = false;
  }
}
