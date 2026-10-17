import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { bookingPricePaise, type BookingDetailResponse } from '@safelock/shared';
import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import {
  TEST_ORIGIN,
  app,
  createTestAdmin,
  createTestUser,
  pushIntoOverstay,
  seedBooking,
  seedDevice,
  verifyUserPhone,
} from '../../test/helpers';
import { resetRazorpayMock } from '../../test/razorpayMock';
import { activateBooking } from './booking.service';

/**
 * The Razorpay SDK is mocked, not our wrapper around it, so the order
 * endpoint's own amount arithmetic still runs for real. No network is touched
 * — `test/setup.ts` blocks `fetch` for the whole suite anyway.
 */
vi.mock('razorpay', () => import('../../test/razorpayMock'));

beforeEach(() => {
  resetRazorpayMock();
});

/**
 * The extension offer, over HTTP.
 *
 * Asserted through the endpoint rather than against the function, because the
 * property that matters is that **what a client is offered is what the order
 * endpoint will accept**. A unit test of the availability function alone would
 * not catch the response forgetting to include it.
 */

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

function get(url: string, cookie?: string) {
  const req = request(app()).get(url).set('Origin', TEST_ORIGIN);
  return cookie ? req.set('Cookie', cookie) : req;
}

function post(url: string, cookie: string) {
  return request(app()).post(url).set('Origin', TEST_ORIGIN).set('Cookie', cookie);
}

async function booked(options: {
  hours?: number;
  endsAt?: Date;
  startsAt?: Date;
} = {}) {
  const user = await createTestUser();
  await verifyUserPhone(user.id);
  const device = await seedDevice();

  const seeded = await seedBooking({
    userId: user.id,
    deviceId: device.id,
    status: 'ACTIVE',
    hours: options.hours ?? 2,
    ...(options.startsAt ? { startsAt: options.startsAt } : {}),
    ...(options.endsAt ? { endsAt: options.endsAt } : {}),
  });

  return { user, device, bookingId: seeded.id };
}

describe('GET /bookings/:id extension block', () => {
  it('offers every allowed duration, priced from the snapshot', async () => {
    const { user, bookingId } = await booked();

    const response = await get(`/api/v1/bookings/${bookingId}`, user.cookie);
    const body = response.body as BookingDetailResponse;

    expect(response.status).toBe(200);
    expect(body.extension.allowed).toBe(true);
    expect(body.extension.reason).toBeNull();
    expect(body.extension.maxHours).toBe(env.RENTAL_MAX_HOURS);
    expect(body.extension.options[0]).toEqual({
      hours: env.RENTAL_MIN_HOURS,
      pricePaise: bookingPricePaise(
        {
          hourlyRatePaise: env.RENTAL_HOURLY_RATE_PAISE,
          overstayMultiplierBps: env.OVERSTAY_MULTIPLIER_BPS,
          graceMinutes: env.OVERSTAY_GRACE_MINUTES,
          capHours: env.OVERSTAY_CAP_HOURS,
          collectionWindowMinutes: env.COLLECTION_WINDOW_MINUTES,
          currency: env.CURRENCY,
        },
        env.RENTAL_MIN_HOURS,
      ),
    });
  });

  /**
   * Someone five minutes over should be able to buy an hour rather than be
   * pushed into a fee. The grace period is exactly that window.
   */
  it('still offers an extension during the grace period', async () => {
    const { user, bookingId } = await booked({
      endsAt: new Date(Date.now() - 5 * MS_PER_MINUTE),
    });

    const body = (await get(`/api/v1/bookings/${bookingId}`, user.cookie))
      .body as BookingDetailResponse;

    expect(body.booking.effectiveStatus).toBe('ACTIVE');
    expect(body.extension.allowed).toBe(true);
  });

  it('refuses once a fee is owed, and says so', async () => {
    const { user, bookingId } = await booked();
    await pushIntoOverstay(bookingId, 1);

    const body = (await get(`/api/v1/bookings/${bookingId}`, user.cookie))
      .body as BookingDetailResponse;

    expect(body.booking.effectiveStatus).toBe('OVERSTAY');
    expect(body.extension.allowed).toBe(false);
    expect(body.extension.reason).toBe('OVERSTAY_FEE_DUE');
    expect(body.extension.options).toEqual([]);
    expect(body.extension.maxHours).toBe(0);
  });

  it('refuses inside the collection window', async () => {
    const { user, bookingId } = await booked();
    await pushIntoOverstay(bookingId, 1);
    await prisma.booking.update({
      where: { id: bookingId },
      data: { status: 'OVERSTAY', overstaySettledAt: new Date(), overstayPaidPaise: 15_000 },
    });

    const body = (await get(`/api/v1/bookings/${bookingId}`, user.cookie))
      .body as BookingDetailResponse;

    expect(body.extension.reason).toBe('IN_COLLECTION_WINDOW');
  });

  it('refuses a finished booking', async () => {
    const { user, bookingId } = await booked();
    await prisma.booking.update({
      where: { id: bookingId },
      data: { status: 'COMPLETED', completedAt: new Date(), completionReason: 'COLLECTED' },
    });

    const body = (await get(`/api/v1/bookings/${bookingId}`, user.cookie))
      .body as BookingDetailResponse;

    expect(body.extension.reason).toBe('NOT_RUNNING');
  });

  /**
   * A following booking shortens the offer rather than removing it. "Two more
   * hours but not five" is a far better answer than "no", and it is what stops
   * the dashboard offering a duration the order endpoint refuses.
   */
  it('shortens the offer to fit the next booking, turnaround included', async () => {
    const startsAt = new Date();
    const { user, device, bookingId } = await booked({ hours: 2, startsAt });

    // The next renter arrives four hours in, so there is one whole hour to
    // sell once the grace period and collection window are accounted for.
    await seedBooking({
      userId: (await createTestUser()).id,
      deviceId: device.id,
      status: 'PENDING_PAYMENT',
      hours: 1,
      startsAt: new Date(startsAt.getTime() + 4 * MS_PER_HOUR),
    });

    const body = (await get(`/api/v1/bookings/${bookingId}`, user.cookie))
      .body as BookingDetailResponse;

    expect(body.extension.allowed).toBe(true);
    expect(body.extension.maxHours).toBe(1);
    expect(body.extension.options.map((option) => option.hours)).toEqual([1]);
  });

  /**
   * The offer and the order endpoint cannot disagree — the point of one
   * function deciding. Asked for an hour beyond the offer, the order is
   * refused with the matching code.
   */
  it('the order endpoint refuses exactly what the offer excludes', async () => {
    const startsAt = new Date();
    const { user, device, bookingId } = await booked({ hours: 2, startsAt });

    await seedBooking({
      userId: (await createTestUser()).id,
      deviceId: device.id,
      status: 'PENDING_PAYMENT',
      hours: 1,
      startsAt: new Date(startsAt.getTime() + 4 * MS_PER_HOUR),
    });

    const offered = await post(`/api/v1/bookings/${bookingId}/extend/order`, user.cookie).send({
      hours: 1,
    });
    expect(offered.status).toBe(200);

    const beyond = await post(`/api/v1/bookings/${bookingId}/extend/order`, user.cookie).send({
      hours: 2,
    });
    expect(beyond.status).toBe(409);
    expect(beyond.body.error.code).toBe('EXTENSION_NOT_AVAILABLE');
  });

  /**
   * The link a WhatsApp message carries is a booking id. Someone else's id —
   * forwarded, screenshotted or guessed — must be indistinguishable from one
   * that does not exist, or the response becomes an oracle for who is renting.
   */
  it('answers 404 for another user’s booking, with no hint that it exists', async () => {
    const { bookingId } = await booked();
    const stranger = await createTestUser();

    const theirs = await get(`/api/v1/bookings/${bookingId}`, stranger.cookie);
    const nonexistent = await get('/api/v1/bookings/clx_not_a_real_booking', stranger.cookie);

    expect(theirs.status).toBe(404);
    expect(nonexistent.status).toBe(404);
    /**
     * Identical but for the request id, which every error body carries and
     * which is per-request by design. Code and message are what a caller could
     * use to tell the two cases apart, and they match.
     */
    expect(theirs.body.error.code).toBe(nonexistent.body.error.code);
    expect(theirs.body.error.message).toBe(nonexistent.body.error.message);
  });

  it('requires a session', async () => {
    const { bookingId } = await booked();

    expect((await get(`/api/v1/bookings/${bookingId}`)).status).toBe(401);
  });
});

describe('GET /bookings/current extension block', () => {
  it('carries the same offer, so the dashboard prices nothing itself', async () => {
    const { user, bookingId } = await booked();

    const response = await get('/api/v1/bookings/current', user.cookie);

    expect(response.status).toBe(200);
    expect(response.body.booking.id).toBe(bookingId);
    expect(response.body.extension.allowed).toBe(true);
    expect(response.body.extension.options.length).toBeGreaterThan(0);
  });

  it('is null when there is no live booking', async () => {
    const user = await createTestUser();

    const response = await get('/api/v1/bookings/current', user.cookie);

    expect(response.body.booking).toBeNull();
    expect(response.body.extension).toBeNull();
  });
});

describe('the admin bookings list', () => {
  /**
   * A dropped message is the one outbox state a human has to see: a renter who
   * was never told a fee had started will dispute the fee, and the admin
   * should know that before the conversation starts.
   */
  it('counts dropped messages and flags the booking', async () => {
    const admin = await createTestAdmin();
    const user = await createTestUser();
    await verifyUserPhone(user.id);
    const device = await seedDevice();

    const seeded = await seedBooking({
      userId: user.id,
      deviceId: device.id,
      status: 'PENDING_PAYMENT',
      hours: 2,
    });
    await activateBooking(seeded.id);

    // One notice dropped by the send budget, one too late to be true.
    await prisma.outboundMessage.updateMany({
      where: { bookingId: seeded.id, kind: 'OVERSTAY_STARTED' },
      data: { status: 'SKIPPED', failureCategory: 'CAP_REACHED' },
    });
    await prisma.outboundMessage.updateMany({
      where: { bookingId: seeded.id, kind: 'BOOKING_ENDING_SOON' },
      data: { status: 'SKIPPED', failureCategory: 'STALE' },
    });

    const response = await get('/api/v1/admin/bookings', admin.cookie);
    const row = response.body.items.find(
      (item: { id: string }) => item.id === seeded.id,
    ) as { undeliveredMessages: number; flagged: boolean };

    // Two reminders plus the overstay notice.
    expect(row.undeliveredMessages).toBe(3);
    expect(row.flagged).toBe(true);
  });

  /**
   * A cancelled message is the system correctly deciding not to say something.
   * Counting those would bury the ones that matter under ordinary traffic.
   */
  it('does not count cancelled or not-applicable messages', async () => {
    const admin = await createTestAdmin();
    const user = await createTestUser();
    await verifyUserPhone(user.id);
    const device = await seedDevice();

    const seeded = await seedBooking({
      userId: user.id,
      deviceId: device.id,
      status: 'PENDING_PAYMENT',
      hours: 2,
    });
    await activateBooking(seeded.id);

    await prisma.outboundMessage.updateMany({
      where: { bookingId: seeded.id },
      data: { status: 'SKIPPED', failureCategory: 'CANCELLED' },
    });

    const response = await get('/api/v1/admin/bookings', admin.cookie);
    const row = response.body.items.find(
      (item: { id: string }) => item.id === seeded.id,
    ) as { undeliveredMessages: number };

    expect(row.undeliveredMessages).toBe(0);
  });
});
