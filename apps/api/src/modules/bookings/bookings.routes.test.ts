import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import {
  bookingPricePaise,
  overstayHourlyPaise,
  reservedUntilFrom,
} from '@safelock/shared';
import { prisma } from '../../lib/prisma';
import { resetRazorpayClient } from '../../lib/razorpay';
import { DEVICE_OFFLINE_AFTER_MS, env } from '../../config/env';
import {
  TEST_ORIGIN,
  app,
  createTestUser,
  createUserWithDevice,
  pushIntoOverstay,
  seedBooking,
  seedDevice,
  seedDevices,
  withCapturedOtp,
  type TestUser,
} from '../../test/helpers';
import { resetRazorpayMock } from '../../test/razorpayMock';
import { currentRates } from './booking.service';

vi.mock('razorpay', () => import('../../test/razorpayMock'));

const CURRENT_URL = '/api/v1/bookings/current';

function post(url: string, cookie?: string) {
  const req = request(app()).post(url).set('Origin', TEST_ORIGIN);
  return cookie ? req.set('Cookie', cookie) : req;
}

function get(url: string, cookie: string) {
  return request(app()).get(url).set('Cookie', cookie);
}

/** Books a safe through the real endpoint. */
async function book(user: TestUser, hours = 2) {
  const response = await post('/api/v1/bookings', user.cookie).send({ hours });
  expect(response.status).toBe(201);
  return response.body.booking as {
    id: string;
    deviceId: string;
    pricePaise: number;
    status: string;
  };
}

// --- Quote -------------------------------------------------------------------

describe('GET /api/v1/bookings/current', () => {
  it('requires authentication', async () => {
    const response = await request(app()).get(CURRENT_URL);
    expect(response.status).toBe(401);
  });

  /**
   * One endpoint carrying both, because the dashboard always needs both: it
   * either shows a booking or shows what one would cost, and a second round
   * trip to find out which would show the user a flicker.
   */
  it('returns a null booking plus a quote for a user who has never booked', async () => {
    const user = await createTestUser();

    const response = await get(CURRENT_URL, user.cookie);

    expect(response.status).toBe(200);
    expect(response.body.booking).toBeNull();

    const rates = currentRates();
    expect(response.body.quote).toMatchObject({
      minHours: env.RENTAL_MIN_HOURS,
      maxHours: env.RENTAL_MAX_HOURS,
      overstayHourlyPaise: overstayHourlyPaise(rates),
    });

    // Every allowed duration is priced server-side, so the UI does no money
    // arithmetic of its own.
    const options = response.body.quote.options as Array<{ hours: number; pricePaise: number }>;
    expect(options).toHaveLength(env.RENTAL_MAX_HOURS - env.RENTAL_MIN_HOURS + 1);
    for (const option of options) {
      expect(option.pricePaise).toBe(bookingPricePaise(rates, option.hours));
    }
  });

  /**
   * A row the sweeper has not reached yet must still read correctly.
   *
   * This is the property that makes the sweeper safe to be late: the stored
   * status says PENDING_PAYMENT, the clock says the hold lapsed, and the API
   * reports the clock.
   */
  it('reports a lapsed hold as no booking, even before the sweeper runs', async () => {
    const user = await createTestUser();
    const device = await seedDevice();
    await seedBooking({
      userId: user.id,
      deviceId: device.id,
      status: 'PENDING_PAYMENT',
      holdExpiresAt: new Date(Date.now() - 1000),
    });

    const response = await get(CURRENT_URL, user.cookie);

    expect(response.status).toBe(200);
    expect(response.body.booking).toBeNull();
  });
});

// --- Create ------------------------------------------------------------------

describe('POST /api/v1/bookings', () => {
  it('holds a safe without any payment, and prices it server-side', async () => {
    const user = await createTestUser();
    const device = await seedDevice();

    const response = await post('/api/v1/bookings', user.cookie).send({ hours: 3 });

    expect(response.status).toBe(201);
    expect(response.body.booking).toMatchObject({
      status: 'PENDING_PAYMENT',
      effectiveStatus: 'PENDING_PAYMENT',
      deviceId: device.id,
      serialNumber: device.serialNumber,
      hours: 3,
      pricePaise: bookingPricePaise(currentRates(), 3),
    });

    // The clock has not started: endsAt is null until the money lands.
    expect(response.body.booking.endsAt).toBeNull();
    expect(response.body.booking.holdExpiresAt).not.toBeNull();

    const row = await prisma.booking.findUniqueOrThrow({
      where: { id: response.body.booking.id },
    });
    expect(row.endsAt).toBeNull();
    expect(row.holdExpiresAt).toBeInstanceOf(Date);

    /**
     * The hold still reserves the **whole intended window**, not just the hold
     * period — otherwise another booking could be sold into it and the payment
     * would have nowhere to land.
     */
    const provisionalEnd = new Date(row.startsAt.getTime() + 3 * 60 * 60 * 1000);
    expect(row.reservedUntil.getTime()).toBe(
      reservedUntilFrom(currentRates(), provisionalEnd).getTime(),
    );
  });

  /** No amount, no start, no end — the schema is `.strict()`. */
  it('rejects a body that tries to supply its own price or times', async () => {
    const user = await createTestUser();
    await seedDevice();

    for (const body of [
      { hours: 2, pricePaise: 1 },
      { hours: 2, endsAt: new Date().toISOString() },
      { hours: 2, hourlyRatePaise: 1 },
    ]) {
      const response = await post('/api/v1/bookings', user.cookie).send(body);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }

    expect(await prisma.booking.count()).toBe(0);
  });

  it('rejects a duration outside the configured range', async () => {
    const user = await createTestUser();
    await seedDevice();

    for (const hours of [0, 25, 1.5, -1]) {
      const response = await post('/api/v1/bookings', user.cookie).send({ hours });
      expect(response.status, `hours=${hours}`).toBe(400);
    }
  });

  it('refuses a second live booking for the same user', async () => {
    const user = await createTestUser();
    await seedDevices(2);

    await book(user, 1);

    const second = await post('/api/v1/bookings', user.cookie).send({ hours: 1 });

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('BOOKING_ALREADY_EXISTS');
    expect(await prisma.booking.count()).toBe(1);
  });

  it('lets a user book again once their previous booking is finished', async () => {
    const user = await createTestUser();
    const device = await seedDevice();

    await seedBooking({
      userId: user.id,
      deviceId: device.id,
      status: 'COMPLETED',
      completionReason: 'COLLECTED',
      startsAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
    });

    const response = await post('/api/v1/bookings', user.cookie).send({ hours: 1 });
    expect(response.status).toBe(201);
  });

  it('refuses when every safe is taken', async () => {
    const first = await createTestUser();
    const second = await createTestUser();
    await seedDevice();

    await book(first, 2);

    const response = await post('/api/v1/bookings', second.cookie).send({ hours: 2 });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('NO_DEVICES_AVAILABLE');
  });

  it('gives two users booking at once different safes', async () => {
    const [a, b] = [await createTestUser(), await createTestUser()];
    await seedDevices(2);

    const [first, second] = await Promise.all([
      post('/api/v1/bookings', a.cookie).send({ hours: 1 }),
      post('/api/v1/bookings', b.cookie).send({ hours: 1 }),
    ]);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.booking.deviceId).not.toBe(second.body.booking.deviceId);
  });

  it('never picks a retired safe', async () => {
    const user = await createTestUser();
    const device = await seedDevice();
    await prisma.device.update({ where: { id: device.id }, data: { status: 'RETIRED' } });

    const response = await post('/api/v1/bookings', user.cookie).send({ hours: 1 });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('NO_DEVICES_AVAILABLE');
  });

  /**
   * §6.2: renting someone a safe we cannot command is selling a product that
   * does not work.
   *
   * The failure is invisible at the moment of sale and obvious an hour later,
   * when somebody is standing in front of a safe that will not open — and by
   * then there is money involved and a refund to argue about.
   */
  it('never picks an offline safe', async () => {
    const user = await createTestUser();
    await seedDevice({ online: false });

    const response = await post('/api/v1/bookings', user.cookie).send({ hours: 1 });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('NO_DEVICES_AVAILABLE');
  });

  /**
   * The case a retained `online: true` flag cannot catch on its own: a device
   * still claiming to be here whose last message is older than three
   * heartbeats. A wedged unit, or a broker that restarted and lost the will it
   * was holding.
   */
  it('never picks a safe whose last message is too old, whatever its flag says', async () => {
    const user = await createTestUser();
    await seedDevice({
      online: true,
      lastSeenAt: new Date(Date.now() - (DEVICE_OFFLINE_AFTER_MS + 60_000)),
    });

    const response = await post('/api/v1/bookings', user.cookie).send({ hours: 1 });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('NO_DEVICES_AVAILABLE');
  });

  /**
   * §11.8: units ship with a door sensor, and one that is not reporting is a
   * fault rather than a configuration.
   *
   * Without a working sensor, "locked" cannot be distinguished from "bolt
   * extended into thin air" — so the one check that matters before handing a
   * safe to the next renter cannot be made at all, and every guarantee in §8
   * degrades to an assertion about a motor.
   */
  it('never picks a safe whose door sensor is not reporting', async () => {
    const user = await createTestUser();
    await seedDevice({ doorState: 'UNKNOWN' });

    const response = await post('/api/v1/bookings', user.cookie).send({ hours: 1 });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('NO_DEVICES_AVAILABLE');
  });

  /**
   * And the one that stops the three conditions above from being a
   * false-negative machine: a unit backdated for the oldest-first ordering is
   * still perfectly bookable.
   *
   * `createdAt` is how the pick orders, and `lastSeenAt` is how it judges
   * liveness. Conflating them would quietly make the whole fleet unbookable
   * the moment a test — or a real deployment — backdated anything.
   */
  it('still picks the oldest safe when it is old but alive', async () => {
    const user = await createTestUser();
    const oldest = await seedDevice({
      createdAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
      lastSeenAt: new Date(),
    });
    await seedDevice();

    const response = await post('/api/v1/bookings', user.cookie).send({ hours: 1 });

    expect(response.status).toBe(201);
    expect(response.body.booking.deviceId).toBe(oldest.id);
  });

  /**
   * A safe going offline *after* the booking is made is deliberately not
   * cancelled: there is money involved and it may come back within seconds.
   * It raises an admin flag and refuses unlocks with an accurate code.
   */
  it('does not cancel a booking whose safe goes offline afterwards', async () => {
    const user = await createTestUser();
    const device = await seedDevice();

    const created = await post('/api/v1/bookings', user.cookie).send({ hours: 1 });
    expect(created.status).toBe(201);

    await prisma.device.update({
      where: { id: device.id },
      data: { online: false, lastSeenAt: null },
    });

    const mine = await get(CURRENT_URL, user.cookie);

    expect(mine.status).toBe(200);
    expect(mine.body.booking).toMatchObject({ id: created.body.booking.id });
  });
});

// --- The exclusion constraint ------------------------------------------------

/**
 * The constraint, tested against the database directly.
 *
 * The service checks too, but a check is a read followed by a write and two
 * concurrent bookings can both pass the read. These tests bypass the service
 * entirely and insert rows, because the claim being made is about Postgres —
 * if the constraint were dropped from a future migration, every service-level
 * test would still pass and only this one would fail.
 */
describe('the Booking overlap exclusion constraint', () => {
  it('rejects two overlapping live bookings on one safe', async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const device = await seedDevice();

    const startsAt = new Date();
    await seedBooking({ userId: a.id, deviceId: device.id, status: 'ACTIVE', hours: 2, startsAt });

    await expect(
      seedBooking({
        userId: b.id,
        deviceId: device.id,
        status: 'ACTIVE',
        hours: 2,
        // Starts an hour in, squarely inside the first reservation.
        startsAt: new Date(startsAt.getTime() + 60 * 60 * 1000),
      }),
    ).rejects.toThrow();

    expect(await prisma.booking.count({ where: { deviceId: device.id } })).toBe(1);
  });

  /** A pending hold occupies the safe just as an active booking does. */
  it('rejects a booking overlapping an unpaid hold', async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const device = await seedDevice();

    await seedBooking({
      userId: a.id,
      deviceId: device.id,
      status: 'PENDING_PAYMENT',
      hours: 2,
    });

    await expect(
      seedBooking({ userId: b.id, deviceId: device.id, status: 'ACTIVE', hours: 1 }),
    ).rejects.toThrow();
  });

  /**
   * `[)` bounds: a booking reserved **until** 12:45 does not collide with one
   * starting **at** 12:45. Without this, every back-to-back rental would be
   * rejected.
   */
  it('allows a booking that starts exactly when the previous reservation ends', async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const device = await seedDevice();

    const first = await seedBooking({
      userId: a.id,
      deviceId: device.id,
      status: 'ACTIVE',
      hours: 1,
    });

    const second = await seedBooking({
      userId: b.id,
      deviceId: device.id,
      status: 'ACTIVE',
      hours: 1,
      startsAt: first.reservedUntil,
    });

    expect(second.id).toBeTruthy();
    expect(await prisma.booking.count({ where: { deviceId: device.id } })).toBe(2);
  });

  /** Terminal statuses leave the constraint, which is what frees the safe. */
  it('ignores completed, cancelled and expired bookings', async () => {
    const device = await seedDevice();
    const startsAt = new Date();

    for (const status of ['COMPLETED', 'CANCELLED', 'EXPIRED_UNPAID'] as const) {
      const user = await createTestUser();
      await seedBooking({
        userId: user.id,
        deviceId: device.id,
        status,
        hours: 2,
        startsAt,
        // Deliberately overlapping: a terminal row is outside the constraint
        // whatever its range says.
        reservedUntil: new Date(startsAt.getTime() + 4 * 60 * 60 * 1000),
      });
    }

    const live = await createTestUser();
    const ok = await seedBooking({
      userId: live.id,
      deviceId: device.id,
      status: 'ACTIVE',
      hours: 2,
      startsAt,
    });
    expect(ok.id).toBeTruthy();
  });

  /** And the other constraint: one live booking per user, enforced by an index. */
  it('rejects a second live booking for one user even across safes', async () => {
    const user = await createTestUser();
    const [first, second] = await seedDevices(2);

    await seedBooking({ userId: user.id, deviceId: first!.id, status: 'ACTIVE', hours: 1 });

    await expect(
      seedBooking({ userId: user.id, deviceId: second!.id, status: 'ACTIVE', hours: 1 }),
    ).rejects.toThrow();
  });
});

// --- Cancel ------------------------------------------------------------------

describe('POST /api/v1/bookings/:id/cancel', () => {
  it('cancels an unpaid booking and frees the safe at once', async () => {
    const user = await createTestUser();
    const next = await createTestUser();
    await seedDevice();

    const booking = await book(user, 2);

    const response = await post(`/api/v1/bookings/${booking.id}/cancel`, user.cookie).send({});
    expect(response.status).toBe(200);
    expect(response.body.booking.status).toBe('CANCELLED');

    // The safe is immediately bookable by someone else.
    const rebooked = await post('/api/v1/bookings', next.cookie).send({ hours: 2 });
    expect(rebooked.status).toBe(201);
    expect(rebooked.body.booking.deviceId).toBe(booking.deviceId);
  });

  it('refuses to cancel a paid booking', async () => {
    const { user, bookingId } = await createUserWithDevice();

    const response = await post(`/api/v1/bookings/${bookingId}/cancel`, user.cookie).send({});

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('BOOKING_STATE_INVALID');
  });

  it("404s on someone else's booking, indistinguishably from one that does not exist", async () => {
    const { bookingId } = await createUserWithDevice();
    const other = await createTestUser();

    const theirs = await post(`/api/v1/bookings/${bookingId}/cancel`, other.cookie).send({});
    const nonexistent = await post('/api/v1/bookings/bkg_nope/cancel', other.cookie).send({});

    expect(theirs.status).toBe(404);
    expect(theirs.body.error.code).toBe('BOOKING_NOT_FOUND');
    expect(theirs.body.error.message).toBe(nonexistent.body.error.message);
  });
});

// --- Collect -----------------------------------------------------------------

describe('POST /api/v1/bookings/:id/collect', () => {
  it('completes the booking and returns the safe to the pool', async () => {
    const { user, bookingId, deviceId } = await createUserWithDevice();

    const response = await post(`/api/v1/bookings/${bookingId}/collect`, user.cookie).send({});

    expect(response.status).toBe(200);
    expect(response.body.booking).toMatchObject({
      status: 'COMPLETED',
      completionReason: 'COLLECTED',
    });

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(booking.completedAt).toBeInstanceOf(Date);

    /**
     * `COLLECTED` is the only reason that returns the safe automatically: the
     * user has told us they have their belongings.
     */
    const device = await prisma.device.findUniqueOrThrow({ where: { id: deviceId } });
    expect(device.status).toBe('AVAILABLE');
    // And the safe is commanded locked after the commit.
    expect(device.lockState).toBe('LOCKED');

    const audit = await prisma.auditLog.findFirst({
      where: { userId: user.id, action: 'booking.collected' },
    });
    expect(audit).not.toBeNull();
  });

  /**
   * The fee is the product's only leverage, and letting someone walk away with
   * their things while owing it would discard it.
   */
  it('refuses to collect while an overstay fee is outstanding, and keeps the safe reserved', async () => {
    const { user, bookingId, deviceId } = await createUserWithDevice();
    await pushIntoOverstay(bookingId, 1);

    const response = await post(`/api/v1/bookings/${bookingId}/collect`, user.cookie).send({});

    expect(response.status).toBe(402);
    expect(response.body.error.code).toBe('OVERSTAY_PAYMENT_REQUIRED');

    // The booking is still live and the safe is still theirs — not released to
    // the next renter while their belongings may still be inside it.
    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(booking.status).not.toBe('COMPLETED');
    expect(booking.completedAt).toBeNull();

    const device = await prisma.device.findUniqueOrThrow({ where: { id: deviceId } });
    expect(device.status).toBe('AVAILABLE');

    const nextRenter = await createTestUser();
    const refused = await post('/api/v1/bookings', nextRenter.cookie).send({ hours: 1 });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('NO_DEVICES_AVAILABLE');
  });

  it('allows collection once the overstay fee is settled', async () => {
    const { user, bookingId, deviceId } = await createUserWithDevice();
    await pushIntoOverstay(bookingId, 1);
    await prisma.booking.update({
      where: { id: bookingId },
      data: { status: 'OVERSTAY', overstaySettledAt: new Date(), overstayPaidPaise: 15_000 },
    });

    const response = await post(`/api/v1/bookings/${bookingId}/collect`, user.cookie).send({});

    expect(response.status).toBe(200);
    expect(response.body.booking.completionReason).toBe('COLLECTED');

    const device = await prisma.device.findUniqueOrThrow({ where: { id: deviceId } });
    expect(device.status).toBe('AVAILABLE');
  });

  it('refuses to collect a booking that has not been paid for', async () => {
    const user = await createTestUser();
    await seedDevice();
    const booking = await book(user, 2);

    const response = await post(`/api/v1/bookings/${booking.id}/collect`, user.cookie).send({});

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('BOOKING_STATE_INVALID');
  });

  it('refuses a second collect', async () => {
    const { user, bookingId } = await createUserWithDevice();

    expect(
      (await post(`/api/v1/bookings/${bookingId}/collect`, user.cookie).send({})).status,
    ).toBe(200);

    const second = await post(`/api/v1/bookings/${bookingId}/collect`, user.cookie).send({});
    expect(second.status).toBe(409);
  });
});

// --- Unlock challenges are bound to the booking ------------------------------

/**
 * Assumption (d), made testable.
 *
 * A code is valid for five minutes and knows nothing about bookings, so
 * without these two guards a code requested while a booking was live would
 * still open the safe after the booking ended.
 */
describe('a code requested while ACTIVE does not survive the booking', () => {
  it('fails to confirm after the booking has been collected', async () => {
    const { user, bookingId } = await createUserWithDevice();

    const { code } = await withCapturedOtp(() =>
      post('/api/v1/devices/unlock/request', user.cookie).send({}),
    );

    await post(`/api/v1/bookings/${bookingId}/collect`, user.cookie).send({});

    const confirm = await post('/api/v1/devices/unlock/confirm', user.cookie).send({ otp: code });

    expect(confirm.status).toBe(409);
    expect(confirm.body.error.code).toBe('NO_ACTIVE_BOOKING');
  });

  it('fails to confirm once an unpaid overstay has begun', async () => {
    const { user, bookingId, deviceId } = await createUserWithDevice();

    const { code } = await withCapturedOtp(() =>
      post('/api/v1/devices/unlock/request', user.cookie).send({}),
    );

    // Time passes; the booking runs over and a fee accrues.
    await pushIntoOverstay(bookingId, 1);

    const confirm = await post('/api/v1/devices/unlock/confirm', user.cookie).send({ otp: code });

    expect(confirm.status).toBe(402);
    expect(confirm.body.error.code).toBe('OVERSTAY_PAYMENT_REQUIRED');

    // The bolt did not move.
    const device = await prisma.device.findUniqueOrThrow({ where: { id: deviceId } });
    expect(device.lockState).toBe('LOCKED');
  });

  it('fails to confirm after an admin force-completes the booking', async () => {
    const { user, bookingId } = await createUserWithDevice();

    const { code } = await withCapturedOtp(() =>
      post('/api/v1/devices/unlock/request', user.cookie).send({}),
    );

    await prisma.booking.update({
      where: { id: bookingId },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        completionReason: 'ADMIN_FORCE_COMPLETED',
      },
    });

    const confirm = await post('/api/v1/devices/unlock/confirm', user.cookie).send({ otp: code });
    expect(confirm.status).toBe(409);
  });

  /** The first of the two guards: completion consumes open challenges. */
  it('consumes every open challenge when the booking completes', async () => {
    const { user, bookingId } = await createUserWithDevice();

    await withCapturedOtp(() => post('/api/v1/devices/unlock/request', user.cookie).send({}));

    expect(
      await prisma.unlockChallenge.count({ where: { userId: user.id, consumedAt: null } }),
    ).toBe(1);

    await post(`/api/v1/bookings/${bookingId}/collect`, user.cookie).send({});

    expect(
      await prisma.unlockChallenge.count({ where: { userId: user.id, consumedAt: null } }),
    ).toBe(0);
  });
});

// --- Orders ------------------------------------------------------------------

describe('booking orders', () => {
  it('prices the order from the booking, never from the request', async () => {
    resetRazorpayMock();
    resetRazorpayClient();

    const user = await createTestUser();
    await seedDevice();
    const booking = await book(user, 3);

    const response = await post(`/api/v1/bookings/${booking.id}/order`, user.cookie).send({});

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      amount: bookingPricePaise(currentRates(), 3),
      currency: 'INR',
      purpose: 'BOOKING',
      keyId: env.RAZORPAY_KEY_ID,
    });
    // An overstay quote has a TTL; a booking order does not.
    expect(response.body.quoteExpiresAt).toBeNull();

    // The key *secret* never leaves the server.
    expect(JSON.stringify(response.body)).not.toContain(env.RAZORPAY_KEY_SECRET);
  });

  it('refuses an order for a booking whose hold has expired', async () => {
    resetRazorpayMock();
    resetRazorpayClient();

    const user = await createTestUser();
    const device = await seedDevice();
    const booking = await seedBooking({
      userId: user.id,
      deviceId: device.id,
      status: 'PENDING_PAYMENT',
      holdExpiresAt: new Date(Date.now() - 1000),
    });

    const response = await post(`/api/v1/bookings/${booking.id}/order`, user.cookie).send({});

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('BOOKING_STATE_INVALID');
  });

  it('refuses an overstay order when no fee is outstanding', async () => {
    resetRazorpayMock();
    resetRazorpayClient();

    const { user, bookingId } = await createUserWithDevice();

    const response = await post(
      `/api/v1/bookings/${bookingId}/overstay/order`,
      user.cookie,
    ).send({});

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('NOTHING_TO_PAY');
  });

  /**
   * The quote is binding for a bounded window, and the Razorpay order carries
   * the same expiry so the gateway refuses most late attempts before they ever
   * reach us.
   */
  it('quotes the outstanding overstay fee with a TTL', async () => {
    resetRazorpayMock();
    resetRazorpayClient();

    const { user, bookingId } = await createUserWithDevice();
    await pushIntoOverstay(bookingId, 2);

    const response = await post(
      `/api/v1/bookings/${bookingId}/overstay/order`,
      user.cookie,
    ).send({});

    expect(response.status).toBe(200);
    expect(response.body.purpose).toBe('OVERSTAY');
    // Two chargeable hours at the overstay rate.
    expect(response.body.amount).toBe(2 * overstayHourlyPaise(currentRates()));

    const expiresAt = new Date(response.body.quoteExpiresAt as string);
    const ttlMs = expiresAt.getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan((env.OVERSTAY_QUOTE_TTL_MINUTES - 1) * 60 * 1000);
    expect(ttlMs).toBeLessThanOrEqual(env.OVERSTAY_QUOTE_TTL_MINUTES * 60 * 1000 + 1000);

    const row = await prisma.payment.findUniqueOrThrow({
      where: { razorpayOrderId: response.body.orderId },
    });
    expect(row.quoteExpiresAt).toBeInstanceOf(Date);
  });

  it('refuses an extension while an overstay fee is owed', async () => {
    resetRazorpayMock();
    resetRazorpayClient();

    const { user, bookingId } = await createUserWithDevice();
    await pushIntoOverstay(bookingId, 1);

    const response = await post(
      `/api/v1/bookings/${bookingId}/extend/order`,
      user.cookie,
    ).send({ hours: 1 });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('EXTENSION_NOT_AVAILABLE');
  });

  /**
   * Assumption (f): an extension is allowed during the **grace period**.
   *
   * Someone five minutes over who wants another hour should be able to buy one
   * rather than be pushed into an overstay fee.
   */
  it('allows an extension inside the grace period', async () => {
    resetRazorpayMock();
    resetRazorpayClient();

    const { user, bookingId } = await createUserWithDevice();

    // Just past endsAt, but still inside grace — so no fee has accrued.
    await prisma.booking.update({
      where: { id: bookingId },
      data: { endsAt: new Date(Date.now() - 60 * 1000) },
    });

    const response = await post(
      `/api/v1/bookings/${bookingId}/extend/order`,
      user.cookie,
    ).send({ hours: 1 });

    expect(response.status).toBe(200);
    expect(response.body.purpose).toBe('EXTENSION');
  });

  /** An extension is priced from the booking's snapshot, not the live config. */
  it('prices an extension from the rates the booking was created under', async () => {
    resetRazorpayMock();
    resetRazorpayClient();

    const user = await createTestUser();
    const device = await seedDevice();

    const cheapRate = Math.floor(env.RENTAL_HOURLY_RATE_PAISE / 2);
    const booking = await seedBooking({
      userId: user.id,
      deviceId: device.id,
      status: 'ACTIVE',
      hours: 2,
      rates: { hourlyRatePaise: cheapRate },
    });

    const response = await post(
      `/api/v1/bookings/${booking.id}/extend/order`,
      user.cookie,
    ).send({ hours: 2 });

    expect(response.status).toBe(200);
    // The snapshot wins: config changes never re-price a live booking.
    expect(response.body.amount).toBe(cheapRate * 2);
  });

  it('refuses an extension that would collide with a later booking', async () => {
    resetRazorpayMock();
    resetRazorpayClient();

    const user = await createTestUser();
    const nextRenter = await createTestUser();
    const device = await seedDevice();

    const mine = await seedBooking({
      userId: user.id,
      deviceId: device.id,
      status: 'ACTIVE',
      hours: 1,
    });

    // Someone has the safe immediately after me.
    await seedBooking({
      userId: nextRenter.id,
      deviceId: device.id,
      status: 'ACTIVE',
      hours: 1,
      startsAt: mine.reservedUntil,
    });

    const response = await post(
      `/api/v1/bookings/${mine.id}/extend/order`,
      user.cookie,
    ).send({ hours: 2 });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('EXTENSION_NOT_AVAILABLE');
  });

  it("404s on an order for someone else's booking", async () => {
    resetRazorpayMock();
    resetRazorpayClient();

    const { bookingId } = await createUserWithDevice();
    const other = await createTestUser();

    const response = await post(`/api/v1/bookings/${bookingId}/order`, other.cookie).send({});

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('BOOKING_NOT_FOUND');
  });
});
