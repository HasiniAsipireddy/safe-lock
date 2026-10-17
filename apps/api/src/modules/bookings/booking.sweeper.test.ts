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
    });
  });
});
