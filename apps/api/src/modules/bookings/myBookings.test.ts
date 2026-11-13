import { describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  app,
  createTestAdmin,
  createTestUser,
  createUserWithDevice,
  seedBooking,
  seedDevice,
  seedPayment,
} from '../../test/helpers';

describe('GET /bookings/mine', () => {
  it("lists only the caller's bookings, with paid and refunded money but no abandoned checkouts", async () => {
    const held = await createUserWithDevice();
    await seedPayment({ userId: held.user.id, bookingId: held.bookingId, amount: 20_000, status: 'PAID' });
    await seedPayment({
      userId: held.user.id,
      bookingId: held.bookingId,
      purpose: 'EXTENSION',
      amount: 10_000,
      status: 'REFUNDED',
    });
    await seedPayment({ userId: held.user.id, bookingId: held.bookingId, amount: 5_000, status: 'CREATED' });

    const other = await createUserWithDevice();
    await seedPayment({ userId: other.user.id, bookingId: other.bookingId, amount: 99_900, status: 'PAID' });

    const res = await request(app()).get('/api/v1/bookings/mine').set('Cookie', held.user.cookie);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    const [item] = res.body.items;
    expect(item.booking.id).toBe(held.bookingId);
    expect(item.payments).toHaveLength(2);
    expect(item.totalPaidPaise).toBe(20_000);
  });

  it('is empty for someone who has never booked', async () => {
    const user = await createTestUser();
    const res = await request(app()).get('/api/v1/bookings/mine').set('Cookie', user.cookie);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it('lists newest first, including finished bookings', async () => {
    const user = await createTestUser();
    const device = await seedDevice();
    const old = await seedBooking({
      userId: user.id,
      deviceId: device.id,
      status: 'COMPLETED',
      startsAt: new Date(Date.now() - 5 * 86_400_000),
      completionReason: 'COLLECTED',
    });
    const live = await seedBooking({ userId: user.id, deviceId: device.id, status: 'ACTIVE' });

    const res = await request(app()).get('/api/v1/bookings/mine').set('Cookie', user.cookie);
    expect(res.body.items.map((i: { booking: { id: string } }) => i.booking.id)).toEqual([
      live.id,
      old.id,
    ]);
  });
});

describe('GET /bookings/:id/receipt', () => {
  it('returns a receipt with a masked phone and no internal ids', async () => {
    const held = await createUserWithDevice();
    await seedPayment({ userId: held.user.id, bookingId: held.bookingId, amount: 20_000, status: 'PAID' });

    const res = await request(app())
      .get(`/api/v1/bookings/${held.bookingId}/receipt`)
      .set('Cookie', held.user.cookie);

    expect(res.status).toBe(200);
    expect(res.body.item.totalPaidPaise).toBe(20_000);
    expect(res.body.customer.email).toBe(held.user.email);
    expect(res.body.customer.phoneMasked).not.toContain(held.user.phone);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|userId/);
  });

  it("is a 404 for someone else's booking, the same as a missing one", async () => {
    const held = await createUserWithDevice();
    const stranger = await createTestUser();

    const theirs = await request(app())
      .get(`/api/v1/bookings/${held.bookingId}/receipt`)
      .set('Cookie', stranger.cookie);
    const missing = await request(app())
      .get('/api/v1/bookings/doesnotexist/receipt')
      .set('Cookie', stranger.cookie);

    expect(theirs.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(theirs.body.error.code).toBe(missing.body.error.code);
  });
});

describe('GET /admin/stats', () => {
  it('is admin-only', async () => {
    const user = await createTestUser();
    const res = await request(app()).get('/api/v1/admin/stats').set('Cookie', user.cookie);
    expect(res.status).toBe(403);
  });

  it('sums paid money, excludes refunds, and buckets today', async () => {
    const admin = await createTestAdmin();
    const held = await createUserWithDevice();
    await seedPayment({ userId: held.user.id, bookingId: held.bookingId, amount: 20_000, status: 'PAID' });
    await seedPayment({
      userId: held.user.id,
      bookingId: held.bookingId,
      purpose: 'OVERSTAY',
      amount: 15_000,
      status: 'PAID',
    });
    await seedPayment({ userId: held.user.id, bookingId: held.bookingId, amount: 7_000, status: 'REFUNDED' });

    const res = await request(app()).get('/api/v1/admin/stats').set('Cookie', admin.cookie);

    expect(res.status).toBe(200);
    expect(res.body.totals.revenuePaise).toBe(35_000);
    expect(res.body.totals.refundedPaise).toBe(7_000);
    expect(res.body.totals.liveBookings).toBe(1);
    expect(res.body.revenueByPurpose).toEqual({ BOOKING: 20_000, EXTENSION: 0, OVERSTAY: 15_000 });

    const today = res.body.perDay[res.body.perDay.length - 1];
    expect(today).toMatchObject({ bookings: 1, revenuePaise: 35_000 });
    expect(res.body.perDay).toHaveLength(res.body.windowDays);

    const device = res.body.devices.find(
      (d: { serialNumber: string }) => d.serialNumber === held.serialNumber,
    );
    expect(device.utilisationPct).toBeGreaterThanOrEqual(0);

    // Aggregates only: nobody is named.
    expect(JSON.stringify(res.body)).not.toContain(held.user.email);
  });
});
