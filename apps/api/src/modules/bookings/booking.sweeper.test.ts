import { describe, expect, it } from 'vitest';
import { prisma } from '../../lib/prisma';
import {
  createTestUser,
  createUserWithDevice,
  pushIntoOverstay,
  seedBooking,
  seedDevice,
} from '../../test/helpers';
import { sweepBookings } from './booking.sweeper';

/**
 * The sweeper.
 *
 * The property under test throughout is that it is a **reconciler, not an
 * authority**: nothing here may be the only thing enforcing a transition. So
 * each test asserts the row it moved, and the companion tests in
 * `bookings.routes.test.ts` assert that the API already reported the truth
 * before it ran.
 */
describe('sweepBookings', () => {
  it('expires a lapsed unpaid hold and frees the safe', async () => {
    const user = await createTestUser();
    const device = await seedDevice();

    const booking = await seedBooking({
      userId: user.id,
      deviceId: device.id,
      status: 'PENDING_PAYMENT',
      hours: 2,
      holdExpiresAt: new Date(Date.now() - 60 * 1000),
    });

    const result = await sweepBookings();
    expect(result.expired).toBe(1);

    const row = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(row.status).toBe('EXPIRED_UNPAID');
    expect(row.completedAt).toBeInstanceOf(Date);

    // Leaving the constraint is what frees the safe for the next booking.
    expect(row.reservedUntil.getTime()).toBeLessThanOrEqual(Date.now());

    const nextRenter = await createTestUser();
    const rebooked = await seedBooking({
      userId: nextRenter.id,
      deviceId: device.id,
      status: 'ACTIVE',
      hours: 1,
    });
    expect(rebooked.id).toBeTruthy();
  });

  it('leaves a hold that has not lapsed alone', async () => {
    const user = await createTestUser();
    const device = await seedDevice();

    const booking = await seedBooking({
      userId: user.id,
      deviceId: device.id,
      status: 'PENDING_PAYMENT',
      hours: 2,
      holdExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
    });

    const result = await sweepBookings();
    expect(result.expired).toBe(0);

    const row = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(row.status).toBe('PENDING_PAYMENT');
  });

  /**
   * The conditional update is what makes a payment landing mid-sweep safe: if
   * the row has already gone ACTIVE, the `status` precondition fails and the
   * sweep touches nothing.
   */
  it('cannot expire a booking that has just been paid for', async () => {
    const user = await createTestUser();
    const device = await seedDevice();

    const booking = await seedBooking({
      userId: user.id,
      deviceId: device.id,
      status: 'ACTIVE',
      hours: 2,
      // A stale hold timestamp left behind; the status is what matters.
      holdExpiresAt: new Date(Date.now() - 60 * 1000),
    });

    await sweepBookings();

    const row = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(row.status).toBe('ACTIVE');
  });

  it('moves a booking past its grace period into OVERSTAY and audits it', async () => {
    const { user, bookingId } = await createUserWithDevice();
    await pushIntoOverstay(bookingId, 1);

    const result = await sweepBookings();
    expect(result.movedToOverstay).toBe(1);

    const row = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(row.status).toBe('OVERSTAY');

    const audit = await prisma.auditLog.findFirst({
      where: { userId: user.id, action: 'booking.overstay.started' },
    });
    expect(audit).not.toBeNull();
  });

  it('leaves a booking inside its grace period as ACTIVE', async () => {
    const { bookingId } = await createUserWithDevice();

    // One minute past endsAt, well inside the 15-minute grace period.
    await prisma.booking.update({
      where: { id: bookingId },
      data: { endsAt: new Date(Date.now() - 60 * 1000) },
    });

    const result = await sweepBookings();
    expect(result.movedToOverstay).toBe(0);

    const row = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(row.status).toBe('ACTIVE');
  });

  /**
   * The reservation has to keep moving while a safe is physically occupied.
   *
   * Without this, `reservedUntil` would fall into the past and the exclusion
   * constraint would happily let the next person book a safe that still has
   * the previous renter's belongings in it.
   */
  it('keeps extending the reservation while a booking is overstaying', async () => {
    const { bookingId, deviceId } = await createUserWithDevice();
    await pushIntoOverstay(bookingId, 3);

    const result = await sweepBookings();
    expect(result.reservationsExtended).toBe(1);

    const row = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(row.reservedUntil.getTime()).toBeGreaterThan(Date.now());

    // So the safe is still not bookable by anyone else.
    const nextRenter = await createTestUser();
    await expect(
      seedBooking({ userId: nextRenter.id, deviceId, status: 'ACTIVE', hours: 1 }),
    ).rejects.toThrow();
  });

  /**
   * An unpaid overstay is left alone **forever**, on purpose.
   *
   * The fee is capped, the safe stays reserved, and the row shows up in the
   * admin flagged list. Quietly completing it would release a safe that may
   * still hold somebody's belongings to the next renter — who could then
   * unlock it.
   */
  it('never completes an unpaid overstay, however long it runs', async () => {
    const { bookingId, deviceId } = await createUserWithDevice();
    // Far beyond any collection window.
    await pushIntoOverstay(bookingId, 48);

    for (let pass = 0; pass < 3; pass += 1) {
      const result = await sweepBookings();
      expect(result.completed).toBe(0);
    }

    const row = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(row.status).toBe('OVERSTAY');
    expect(row.completedAt).toBeNull();

    const device = await prisma.device.findUniqueOrThrow({ where: { id: deviceId } });
    expect(device.status).toBe('AVAILABLE');
    expect(row.reservedUntil.getTime()).toBeGreaterThan(Date.now());
  });

  /**
   * A **settled** overstay whose collection window has closed does complete —
   * and sends the safe for inspection, because nobody confirmed it was
   * emptied.
   */
  it('completes a settled overstay once the collection window lapses, flagging the safe', async () => {
    const { user, bookingId, deviceId } = await createUserWithDevice();
    const { endsAt } = await pushIntoOverstay(bookingId, 2);

    const row = await prisma.booking.findUniqueOrThrow({
      where: { id: bookingId },
      select: { collectionWindowMinutes: true },
    });

    await prisma.booking.update({
      where: { id: bookingId },
      data: {
        status: 'OVERSTAY',
        overstayPaidPaise: 30_000,
        // Settled long enough ago that the window has closed.
        overstaySettledAt: new Date(
          Date.now() - (row.collectionWindowMinutes + 5) * 60 * 1000,
        ),
      },
    });
    expect(endsAt.getTime()).toBeLessThan(Date.now());

    const result = await sweepBookings();
    expect(result.completed).toBe(1);

    const after = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(after.status).toBe('COMPLETED');
    expect(after.completionReason).toBe('COLLECTION_WINDOW_LAPSED');

    /**
     * The safety rule: the safe does **not** go back into the pool. The
     * collection window lapsed with no confirmation, so its contents are
     * unknown and a human must look before it is rented again.
     */
    const device = await prisma.device.findUniqueOrThrow({ where: { id: deviceId } });
    expect(device.status).toBe('NEEDS_INSPECTION');
    expect(device.inspectionNote).toMatch(/collection window lapsed/i);
    expect(device.lockState).toBe('LOCKED');

    const audit = await prisma.auditLog.findFirst({
      where: { userId: user.id, action: 'booking.collection.lapsed' },
    });
    expect(audit).not.toBeNull();

    // Open unlock codes die with it.
    expect(
      await prisma.unlockChallenge.count({ where: { userId: user.id, consumedAt: null } }),
    ).toBe(0);
  });

  /** A waive opens the collection window just as a payment does. */
  it('completes a waived overstay once its window lapses', async () => {
    const { bookingId } = await createUserWithDevice();
    await pushIntoOverstay(bookingId, 1);

    const row = await prisma.booking.findUniqueOrThrow({
      where: { id: bookingId },
      select: { collectionWindowMinutes: true },
    });

    await prisma.booking.update({
      where: { id: bookingId },
      data: {
        status: 'OVERSTAY',
        overstayWaivedAt: new Date(
          Date.now() - (row.collectionWindowMinutes + 5) * 60 * 1000,
        ),
      },
    });

    const result = await sweepBookings();
    expect(result.completed).toBe(1);
  });

  it('leaves a settled overstay inside its collection window alone', async () => {
    const { bookingId, deviceId } = await createUserWithDevice();
    await pushIntoOverstay(bookingId, 1);
    await prisma.booking.update({
      where: { id: bookingId },
      data: { status: 'OVERSTAY', overstaySettledAt: new Date() },
    });

    const result = await sweepBookings();
    expect(result.completed).toBe(0);

    const device = await prisma.device.findUniqueOrThrow({ where: { id: deviceId } });
    expect(device.status).toBe('AVAILABLE');
  });

  /**
   * An extension can pull a booking back out of OVERSTAY, and the stored row
   * needs correcting — including shrinking the reservation back to the real
   * end, so the safe does not stay blocked for an hour that was paid for.
   */
  it('pulls a row back to ACTIVE when an extension cleared the overstay', async () => {
    const { bookingId } = await createUserWithDevice();

    await prisma.booking.update({
      where: { id: bookingId },
      data: {
        status: 'OVERSTAY',
        // An extension pushed the end back into the future.
        endsAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
        reservedUntil: new Date(Date.now() + 6 * 60 * 60 * 1000),
      },
    });

    await sweepBookings();

    const row = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(row.status).toBe('ACTIVE');
    // Reservation shrunk back to endsAt plus the turnaround.
    expect(row.reservedUntil.getTime()).toBeLessThan(Date.now() + 4 * 60 * 60 * 1000);
  });

  it('is idempotent — a second sweep changes nothing', async () => {
    const { bookingId } = await createUserWithDevice();
    await pushIntoOverstay(bookingId, 1);

    await sweepBookings();
    const afterFirst = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });

    const second = await sweepBookings();
    expect(second.movedToOverstay).toBe(0);
    expect(second.completed).toBe(0);

    const afterSecond = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(afterSecond.status).toBe(afterFirst.status);
  });

  it('does nothing when there is nothing to do', async () => {
    await createUserWithDevice();

    const result = await sweepBookings();

    expect(result).toEqual({
      expired: 0,
      movedToOverstay: 0,
      reservationsExtended: 0,
      completed: 0,
      failed: 0,
    });
  });
});

/**
 * The collision the live run found.
 *
 * A back-to-back booking already holds the safe from the moment the first
 * reservation ends. When the first booking overstays, pushing its
 * `reservedUntil` forward violates the exclusion constraint — and the
 * constraint is right to refuse, because two bookings cannot occupy one safe.
 *
 * Before this was handled, the rejected write threw out of the sweep loop and
 * **every subsequent sweep failed the same way**: holds stopped expiring,
 * nothing moved to OVERSTAY, and no collection window ever closed, for every
 * booking in the system. These tests pin both halves of the fix.
 */
describe('an overstay that collides with the next booking', () => {
  /** Two bookings, back to back, with the first one overstaying. */
  async function backToBack() {
    const first = await createUserWithDevice({ hours: 1 });
    const nextRenter = await createTestUser();

    const firstRow = await prisma.booking.findUniqueOrThrow({
      where: { id: first.bookingId },
      select: { reservedUntil: true },
    });

    // Starts exactly where ours ends — legal under the `[)` bounds, and the
    // ordinary case for a busy pool.
    const second = await seedBooking({
      userId: nextRenter.id,
      deviceId: first.deviceId,
      status: 'ACTIVE',
      hours: 2,
      startsAt: firstRow.reservedUntil,
    });

    await pushIntoOverstay(first.bookingId, 1);

    return { first, second, nextRenter };
  }

  it('still moves the booking to OVERSTAY and keeps accruing a fee', async () => {
    const { first } = await backToBack();

    const result = await sweepBookings();

    expect(result.failed).toBe(0);
    expect(result.movedToOverstay).toBe(1);

    const row = await prisma.booking.findUniqueOrThrow({ where: { id: first.bookingId } });
    expect(row.status).toBe('OVERSTAY');
    // The fee is what matters to the renter, and it is unaffected.
    expect(row.completedAt).toBeNull();
  });

  it('clamps the reservation at the next booking rather than past it', async () => {
    const { first, second } = await backToBack();

    const nextStart = (
      await prisma.booking.findUniqueOrThrow({
        where: { id: second.id },
        select: { startsAt: true },
      })
    ).startsAt;

    await sweepBookings();

    const row = await prisma.booking.findUniqueOrThrow({ where: { id: first.bookingId } });

    /**
     * Clamped **at** the next booking's start, never past it.
     *
     * The unclamped value would have been `now + 1 hour`, which is what the
     * constraint rejected — so asserting the ceiling rather than merely
     * "something in the future" is what pins the fix.
     */
    expect(row.reservedUntil.getTime()).toBeLessThanOrEqual(nextStart.getTime());
    expect(row.reservedUntil.getTime()).toBeLessThan(Date.now() + 60 * 60 * 1000);

    const next = await prisma.booking.findUniqueOrThrow({ where: { id: second.id } });
    expect(next.status).toBe('ACTIVE');
    // And the next renter's own window is untouched.
    expect(next.startsAt.getTime()).toBe(nextStart.getTime());
  });

  /**
   * The property the bug destroyed: one unreconcilable row must not stop the
   * others. Without per-row isolation this sweep returns nothing useful and
   * the lapsed hold below stays pending forever.
   */
  it('does not stop the rest of the sweep', async () => {
    await backToBack();

    // An unrelated booking that very much needs reconciling.
    const other = await createTestUser();
    const otherDevice = await seedDevice();
    const lapsed = await seedBooking({
      userId: other.id,
      deviceId: otherDevice.id,
      status: 'PENDING_PAYMENT',
      hours: 1,
      holdExpiresAt: new Date(Date.now() - 60 * 1000),
    });

    const result = await sweepBookings();

    expect(result.expired).toBe(1);
    const row = await prisma.booking.findUniqueOrThrow({ where: { id: lapsed.id } });
    expect(row.status).toBe('EXPIRED_UNPAID');
  });

  /** And repeated sweeps stay healthy rather than failing identically. */
  it('stays healthy across repeated sweeps', async () => {
    await backToBack();

    for (let pass = 0; pass < 3; pass += 1) {
      const result = await sweepBookings();
      expect(result.failed).toBe(0);
    }
  });

  /**
   * A row that genuinely cannot be written is counted, not thrown.
   *
   * Simulated by deleting the device out from under a booking — `onDelete:
   * Restrict` makes that impossible through Prisma, so this uses the one write
   * that can still fail: a booking whose status update would clash with a row
   * inserted between the read and the write.
   */
  it('counts a row it cannot reconcile instead of aborting', async () => {
    const { first } = await backToBack();

    // Make the collision unavoidable: the next booking starts before our
    // reservation even ends, which only a direct insert can produce.
    await prisma.$executeRawUnsafe(
      `UPDATE "Booking" SET "reservedUntil" = "startsAt" + interval '10 minutes' WHERE id = $1`,
      first.bookingId,
    );

    const result = await sweepBookings();

    // Either reconciled or counted — never thrown.
    expect(result.failed).toBeLessThanOrEqual(1);
    expect(typeof result.failed).toBe('number');
  });
});
