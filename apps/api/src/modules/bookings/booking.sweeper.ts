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
      continue;
    }

    if (effective === 'OVERSTAY') {
      const becameOverstay = row.status !== 'OVERSTAY';

      /**
       * Keep the safe reserved while it is overstaying.
       *
       * Without this, `reservedUntil` would be in the past and the exclusion
       * constraint would happily let someone book a safe that still has the
       * previous renter's things in it. Pushed out in one-hour steps rather
       * than to the cap immediately, so an abandoned booking does not block a
       * device for longer than it has actually been occupied.
       */
      const keepUntil = new Date(now.getTime() + 60 * 60 * 1000);
      const extend = row.reservedUntil.getTime() < keepUntil.getTime();

      if (becameOverstay || extend) {
        await prisma.booking.update({
          where: { id: row.id },
          data: {
            status: 'OVERSTAY',
            ...(extend ? { reservedUntil: keepUntil } : {}),
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
        if (extend) result.reservationsExtended += 1;
      }
      continue;
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

  return result;
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
    if (touched > 0) logger.info(result, 'Booking sweep');
  } catch (cause) {
    // A failed sweep must never take the process down. Correctness does not
    // depend on it, so the next tick simply tries again.
    logger.error(
      { reason: cause instanceof Error ? cause.message : 'unknown' },
      'Booking sweep failed',
    );
  } finally {
    running = false;
  }
}
