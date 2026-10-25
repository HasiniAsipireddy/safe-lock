import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { prisma } from '../src/lib/prisma';
import { drainDeviceAcks } from '../src/lib/deviceGateway';
import { DEVICE_OFFLINE_AFTER_MS } from '../src/config/env';
import { resetRazorpayClient } from '../src/lib/razorpay';
import {
  TEST_ORIGIN,
  app,
  checkoutSignature,
  createTestUser,
  verifyUserPhone,
  withCapturedOtp,
} from '../src/test/helpers';
import { resetRazorpayMock } from '../src/test/razorpayMock';
import { sweepCommands } from '../src/modules/commands/command.sweeper';
import {
  TEST_SAFE_PREFIX,
  heartbeatTestSafes,
  seedTestSafes,
} from './testSafes';

vi.mock('razorpay', () => import('../src/test/razorpayMock'));

/**
 * Does a seeded safe actually work, all the way through?
 *
 * The question the seed exists to answer, asked of the real endpoints rather
 * than reasoned about: book, pay, lock, unlock with a code, collect. Every
 * device row here comes from `seedTestSafes` and nothing else, so a change that
 * makes the seed produce an unbookable or uncommandable safe fails here rather
 * than in somebody's browser.
 *
 * It also pins the one genuine limitation — a seeded fleet goes offline after
 * `DEVICE_OFFLINE_AFTER_SECONDS` because nothing heartbeats on the mock
 * gateway — and that the dev heartbeat is what recovers it.
 */

const DEV = { nodeEnv: 'development', deviceGateway: 'mock' };

function post(url: string, cookie?: string) {
  const req = request(app()).post(url).set('Origin', TEST_ORIGIN);
  return cookie ? req.set('Cookie', cookie) : req;
}

function get(url: string, cookie: string) {
  return request(app()).get(url).set('Cookie', cookie);
}

/** A renter who can be sent a one-time code. */
async function renter() {
  const user = await createTestUser();
  await verifyUserPhone(user.id);
  return user;
}

describe('a seeded safe, end to end on the mock gateway', () => {
  it('is offered in the quote for every size', async () => {
    await seedTestSafes(DEV);
    const user = await renter();

    const response = await get('/api/v1/bookings/current', user.cookie);

    expect(response.status).toBe(200);
    const sizes = response.body.quote.sizes as Array<{
      size: string;
      available: boolean;
    }>;
    expect(sizes.filter((row) => row.available).map((row) => row.size).sort()).toEqual([
      'LARGE',
      'MEDIUM',
      'SMALL',
    ]);
  });

  it('carries a booking from payment through lock, unlock and collection', async () => {
    resetRazorpayMock();
    resetRazorpayClient();

    await seedTestSafes(DEV);
    const user = await renter();

    // --- Book: the pick must choose a seeded safe of the asked-for size ------
    const booked = await post('/api/v1/bookings', user.cookie).send({
      hours: 1,
      size: 'SMALL',
    });
    expect(booked.status).toBe(201);
    expect(booked.body.booking.status).toBe('PENDING_PAYMENT');

    const device = await prisma.device.findUniqueOrThrow({
      where: { id: booked.body.booking.deviceId as string },
      select: { serialNumber: true, size: true },
    });
    expect(device.serialNumber.startsWith(`${TEST_SAFE_PREFIX}S`)).toBe(true);
    expect(device.size).toBe('SMALL');

    const bookingId = booked.body.booking.id as string;

    // --- Pay: only a verified signature makes it ACTIVE ---------------------
    const order = await post(`/api/v1/bookings/${bookingId}/order`, user.cookie).send({});
    expect(order.status).toBe(200);

    const orderId = order.body.orderId as string;
    const paymentId = 'pay_seededsafe';
    const paid = await post('/api/v1/payments/verify', user.cookie).send({
      razorpay_order_id: orderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: checkoutSignature(orderId, paymentId),
    });
    expect(paid.status).toBe(200);
    // The one flag the UI must never render as plain success.
    expect(paid.body.needsReview).toBe(false);

    // Settled in the same transaction that marked the payment PAID, and the
    // clock starts there rather than at booking.
    const active = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(active.status).toBe('ACTIVE');
    expect(active.endsAt).not.toBeNull();

    // --- Lock: 202, then the mock acks and the state moves ------------------
    // The safe is seeded LOCKED, so ask it to open first — a lock on an
    // already-locked safe is a success that issues no command.
    const code = await unlock(user.cookie);
    expect(code.lockState).toBe('UNLOCKED');

    const locked = await post('/api/v1/devices/lock', user.cookie).send({});
    expect(locked.status).toBe(202);
    expect(locked.body.commandId).toBeTruthy();
    await drainDeviceAcks();

    const afterLock = await prisma.command.findUniqueOrThrow({
      where: { id: locked.body.commandId as string },
    });
    expect(afterLock.status).toBe('ACKED');
    expect(afterLock.userId).toBe(user.id);

    const relocked = await prisma.device.findUniqueOrThrow({
      where: { serialNumber: device.serialNumber },
      select: { lockState: true, doorState: true, lastSeenAt: true },
    });
    expect(relocked.lockState).toBe('LOCKED');
    expect(relocked.doorState).toBe('CLOSED');
    // An ack advances liveness, which is how a commanded safe stays online.
    expect(relocked.lastSeenAt).not.toBeNull();

    // --- Collect: the booking ends and a system LOCK is issued --------------
    const collected = await post(`/api/v1/bookings/${bookingId}/collect`, user.cookie).send({});
    expect(collected.status).toBe(200);
    expect(collected.body.booking).toMatchObject({
      status: 'COMPLETED',
      completionReason: 'COLLECTED',
    });
    await drainDeviceAcks();

    const returned = await prisma.device.findUniqueOrThrow({
      where: { serialNumber: device.serialNumber },
      select: { status: true, lockState: true, lockCommandFailedAt: true },
    });
    // `COLLECTED` is the only reason that returns a safe to the pool.
    expect(returned.status).toBe('AVAILABLE');
    expect(returned.lockState).toBe('LOCKED');
    expect(returned.lockCommandFailedAt).toBeNull();
  });

  /**
   * The escalation that would eat the inventory, asserted absent.
   *
   * On a real transport with no broker, a completion lock fails, the sweeper
   * retries it three times and each device is moved to `NEEDS_INSPECTION` — the
   * reason the seed refuses any gateway but `mock`. On the mock the system lock
   * acks, so nothing escalates, and this test says so rather than leaving it to
   * be discovered.
   */
  it('leaves no safe in NEEDS_INSPECTION after a clean rental', async () => {
    resetRazorpayMock();
    resetRazorpayClient();

    await seedTestSafes(DEV);
    const user = await renter();

    const booked = await post('/api/v1/bookings', user.cookie).send({
      hours: 1,
      size: 'MEDIUM',
    });
    const bookingId = booked.body.booking.id as string;

    const order = await post(`/api/v1/bookings/${bookingId}/order`, user.cookie).send({});
    const orderId = order.body.orderId as string;
    const paymentId = 'pay_noinspection';
    await post('/api/v1/payments/verify', user.cookie).send({
      razorpay_order_id: orderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: checkoutSignature(orderId, paymentId),
    });

    await post(`/api/v1/bookings/${bookingId}/collect`, user.cookie).send({});
    await drainDeviceAcks();
    // Run the sweeper too: it is the thing that escalates, so a test that never
    // runs it cannot claim nothing escalated.
    await sweepCommands();
    await drainDeviceAcks();

    expect(
      await prisma.device.count({
        where: {
          serialNumber: { startsWith: TEST_SAFE_PREFIX },
          status: 'NEEDS_INSPECTION',
        },
      }),
    ).toBe(0);
    expect(
      await prisma.device.count({
        where: {
          serialNumber: { startsWith: TEST_SAFE_PREFIX },
          lockCommandFailedAt: { not: null },
        },
      }),
    ).toBe(0);
  });
});

/** Requests a code, confirms it, and returns the settled device state. */
async function unlock(cookie: string): Promise<{ lockState: string }> {
  const { result, code } = await withCapturedOtp(() =>
    post('/api/v1/devices/unlock/request', cookie).send({}),
  );
  expect(result.status).toBe(200);

  const confirmed = await post('/api/v1/devices/unlock/confirm', cookie).send({ otp: code });
  expect(confirmed.status).toBe(202);
  await drainDeviceAcks();

  const command = await prisma.command.findUniqueOrThrow({
    where: { id: confirmed.body.commandId as string },
  });
  expect(command.status).toBe('ACKED');
  expect(command.type).toBe('UNLOCK');
  // The code that bought the command is recorded against it, immutably.
  expect(command.challengeId).not.toBeNull();

  const device = await prisma.device.findFirstOrThrow({
    where: { id: command.deviceId },
    select: { lockState: true },
  });

  return device;
}

/**
 * The limitation worth knowing about, pinned.
 *
 * Nothing on the mock gateway sends a heartbeat, so `lastSeenAt` only moves on
 * an ack — and both `lockDevice` and `requestUnlock` pass `requireOnline: true`.
 * A fleet left alone past `DEVICE_OFFLINE_AFTER_SECONDS` therefore cannot be
 * commanded *or* recover by being commanded. The dev heartbeat is the way out.
 */
describe('a seeded fleet left alone', () => {
  it('goes offline, and then refuses lock and unlock alike', async () => {
    resetRazorpayMock();
    resetRazorpayClient();

    await seedTestSafes(DEV);
    const user = await renter();

    const booked = await post('/api/v1/bookings', user.cookie).send({
      hours: 2,
      size: 'LARGE',
    });
    const bookingId = booked.body.booking.id as string;
    const order = await post(`/api/v1/bookings/${bookingId}/order`, user.cookie).send({});
    const orderId = order.body.orderId as string;
    const paymentId = 'pay_goesoffline';
    await post('/api/v1/payments/verify', user.cookie).send({
      razorpay_order_id: orderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: checkoutSignature(orderId, paymentId),
    });

    // One tick past the threshold, as an idle dev machine reaches on its own.
    await prisma.device.updateMany({
      where: { serialNumber: { startsWith: TEST_SAFE_PREFIX } },
      data: { lastSeenAt: new Date(Date.now() - DEVICE_OFFLINE_AFTER_MS - 1000) },
    });

    const lock = await post('/api/v1/devices/lock', user.cookie).send({});
    expect(lock.body.error.code).toBe('DEVICE_OFFLINE');

    // Refused *before* a code is sent, so the user's send cap is not spent on
    // a code that could not be used.
    const unlockRequest = await post('/api/v1/devices/unlock/request', user.cookie).send({});
    expect(unlockRequest.body.error.code).toBe('DEVICE_OFFLINE');
    expect(await prisma.unlockChallenge.count()).toBe(0);
  });

  it('is usable again after a dev heartbeat, with no booking disturbed', async () => {
    resetRazorpayMock();
    resetRazorpayClient();

    await seedTestSafes(DEV);
    const user = await renter();

    const booked = await post('/api/v1/bookings', user.cookie).send({
      hours: 2,
      size: 'LARGE',
    });
    const bookingId = booked.body.booking.id as string;
    const order = await post(`/api/v1/bookings/${bookingId}/order`, user.cookie).send({});
    const orderId = order.body.orderId as string;
    const paymentId = 'pay_heartbeat';
    await post('/api/v1/payments/verify', user.cookie).send({
      razorpay_order_id: orderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: checkoutSignature(orderId, paymentId),
    });

    await prisma.device.updateMany({
      where: { serialNumber: { startsWith: TEST_SAFE_PREFIX } },
      data: { lastSeenAt: new Date(Date.now() - DEVICE_OFFLINE_AFTER_MS - 1000) },
    });
    const refused = await post('/api/v1/devices/lock', user.cookie).send({});
    expect(refused.body.error.code).toBe('DEVICE_OFFLINE');

    await heartbeatTestSafes();

    const unlocked = await unlock(user.cookie);
    expect(unlocked.lockState).toBe('UNLOCKED');

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(booking.status).toBe('ACTIVE');
  });
});
