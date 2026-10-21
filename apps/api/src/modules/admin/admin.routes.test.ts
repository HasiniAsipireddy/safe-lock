import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { prisma } from '../../lib/prisma';
import { deviceGateway, drainDeviceAcks } from '../../lib/deviceGateway';
import {
  TEST_ORIGIN,
  app,
  createTestAdmin,
  createTestUser,
  createUserWithDevice,
  pushIntoOverstay,
  seedBooking,
  seedDevice,
  seedDevices,
  seedPayment,
  withCapturedOtp,
} from '../../test/helpers';

/**
 * Every admin route, with the method and a representative body. Used to
 * assert authorisation uniformly — a route added without protection shows up
 * here as a missing entry rather than as a quiet hole.
 */
const ADMIN_ROUTES = [
  { method: 'get' as const, path: '/api/v1/admin/devices' },
  { method: 'post' as const, path: '/api/v1/admin/devices', body: { serialNumber: 'SAFE-7777' } },
  {
    method: 'post' as const,
    path: '/api/v1/admin/devices/bulk',
    body: { serialNumbers: ['SAFE-7778'] },
  },
  {
    method: 'post' as const,
    path: '/api/v1/admin/devices/some-id/clear-inspection',
    body: { note: 'Opened and checked, empty' },
  },
  { method: 'get' as const, path: '/api/v1/admin/devices/some-id/commands' },
  { method: 'post' as const, path: '/api/v1/admin/devices/some-id/credential', body: {} },
  { method: 'post' as const, path: '/api/v1/admin/devices/some-id/retire', body: {} },
  { method: 'get' as const, path: '/api/v1/admin/bookings' },
  {
    method: 'post' as const,
    path: '/api/v1/admin/bookings/some-id/force-complete',
    body: { reason: 'Renter unreachable for two days' },
  },
  {
    method: 'post' as const,
    path: '/api/v1/admin/bookings/some-id/waive-overstay',
    body: { reason: 'Our lock firmware was down' },
  },
  {
    method: 'post' as const,
    path: '/api/v1/admin/payments/some-id/clear-review',
    body: { note: 'Refunded in the Razorpay dashboard' },
  },
  { method: 'get' as const, path: '/api/v1/admin/users' },
  { method: 'get' as const, path: '/api/v1/admin/payments' },
  { method: 'get' as const, path: '/api/v1/admin/audit' },
];

function send(route: (typeof ADMIN_ROUTES)[number], cookie?: string) {
  const instance = app();
  const req =
    route.method === 'get'
      ? request(instance).get(route.path)
      : request(instance).post(route.path).set('Origin', TEST_ORIGIN);

  if (cookie) req.set('Cookie', cookie);
  return route.method === 'get' ? req : req.send(route.body ?? {});
}

describe('admin route authorisation', () => {
  it('rejects every admin route for an unauthenticated caller', async () => {
    for (const route of ADMIN_ROUTES) {
      const response = await send(route);

      expect(
        response.status,
        `${route.method.toUpperCase()} ${route.path} should be 401`,
      ).toBe(401);
      expect(response.body.error.code).toBe('UNAUTHENTICATED');
    }
  });

  it('rejects every admin route for a normal signed-in user', async () => {
    const user = await createTestUser();

    for (const route of ADMIN_ROUTES) {
      const response = await send(route, user.cookie);

      expect(
        response.status,
        `${route.method.toUpperCase()} ${route.path} should be 403`,
      ).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    }
  });

  it('rejects a user holding a booked safe — paying does not confer admin', async () => {
    const { user } = await createUserWithDevice();

    const response = await send({ method: 'get', path: '/api/v1/admin/users' }, user.cookie);
    expect(response.status).toBe(403);
  });

  it('audits a non-admin reaching an admin route', async () => {
    const user = await createTestUser();

    await send({ method: 'get', path: '/api/v1/admin/devices' }, user.cookie);
    await new Promise((resolve) => setTimeout(resolve, 150));

    const audit = await prisma.auditLog.findFirst({
      where: { userId: user.id, action: 'admin.access.denied' },
    });
    expect(audit).not.toBeNull();
    expect(audit?.metadata).toMatchObject({ role: 'USER' });
  });

  it('allows an ADMIN through', async () => {
    const admin = await createTestAdmin();

    const response = await request(app())
      .get('/api/v1/admin/devices')
      .set('Cookie', admin.cookie);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ page: 1, pageSize: 20, total: 0 });
  });
});

describe('GET /api/v1/admin/devices', () => {
  it('paginates, filters by status and shows the occupying booking', async () => {
    const admin = await createTestAdmin();
    const user = await createTestUser();
    const devices = await seedDevices(3);
    await seedBooking({ userId: user.id, deviceId: devices[0]!.id, status: 'ACTIVE' });

    const all = await request(app()).get('/api/v1/admin/devices').set('Cookie', admin.cookie);
    expect(all.body.total).toBe(3);
    expect(all.body.items).toHaveLength(3);

    // Occupancy is a property of the bookings, not a device status — a booked
    // safe is still AVAILABLE as inventory.
    const occupied = await request(app())
      .get('/api/v1/admin/devices?status=AVAILABLE')
      .set('Cookie', admin.cookie);
    expect(occupied.body.total).toBe(3);

    const booked = (all.body.items as Array<{ serialNumber: string; currentBooking: unknown }>)
      .filter((row) => row.currentBooking !== null);
    expect(booked).toHaveLength(1);
    expect(booked[0]).toMatchObject({
      serialNumber: devices[0]!.serialNumber,
      currentBooking: { status: 'ACTIVE', effectiveStatus: 'ACTIVE', user: { id: user.id } },
    });

    const paged = await request(app())
      .get('/api/v1/admin/devices?page=2&pageSize=2')
      .set('Cookie', admin.cookie);
    expect(paged.body.items).toHaveLength(1);
    expect(paged.body).toMatchObject({ page: 2, pageSize: 2, total: 3, totalPages: 2 });
  });

  it('searches by serial, case-insensitively', async () => {
    const admin = await createTestAdmin();
    await seedDevice({ serialNumber: 'SAFE-FIND' });
    await seedDevice({ serialNumber: 'SAFE-OTHER' });

    const bySerial = await request(app())
      .get('/api/v1/admin/devices?q=find')
      .set('Cookie', admin.cookie);
    expect(bySerial.body.total).toBe(1);
    expect(bySerial.body.items[0].serialNumber).toBe('SAFE-FIND');
  });

  it('rejects a search term over 100 characters', async () => {
    const admin = await createTestAdmin();

    const response = await request(app())
      .get(`/api/v1/admin/devices?q=${'x'.repeat(101)}`)
      .set('Cookie', admin.cookie);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a pageSize over the maximum', async () => {
    const admin = await createTestAdmin();

    const response = await request(app())
      .get('/api/v1/admin/devices?pageSize=1000')
      .set('Cookie', admin.cookie);

    expect(response.status).toBe(400);
  });

  it('treats a SQL-injection-shaped search term as literal text', async () => {
    const admin = await createTestAdmin();
    await seedDevice({ serialNumber: 'SAFE-SAFE1' });

    const response = await request(app())
      .get(`/api/v1/admin/devices?q=${encodeURIComponent("'; DROP TABLE \"Device\"; --")}`)
      .set('Cookie', admin.cookie);

    expect(response.status).toBe(200);
    expect(response.body.total).toBe(0);
    // The table is still there, because the term was a bound parameter.
    expect(await prisma.device.count()).toBe(1);
  });
});

describe('POST /api/v1/admin/devices', () => {
  it('creates a device and normalises the serial', async () => {
    const admin = await createTestAdmin();

    const response = await request(app())
      .post('/api/v1/admin/devices')
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', admin.cookie)
      .send({ serialNumber: '  safe-abcd  ' });

    expect(response.status).toBe(201);
    expect(response.body.device.serialNumber).toBe('SAFE-ABCD');

    const audit = await prisma.auditLog.findFirst({ where: { action: 'device.created' } });
    expect(audit).not.toBeNull();
    expect(audit?.metadata).toMatchObject({ serialNumber: 'SAFE-ABCD' });
    // Request id is threaded into the audit row.
    expect((audit?.metadata as { requestId?: string })?.requestId).toBeTruthy();
  });

  it('rejects a malformed serial', async () => {
    const admin = await createTestAdmin();

    const response = await request(app())
      .post('/api/v1/admin/devices')
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', admin.cookie)
      .send({ serialNumber: 'NOT-A-SERIAL!' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(await prisma.device.count()).toBe(0);
  });

  it('rejects a duplicate serial with 409', async () => {
    const admin = await createTestAdmin();
    await seedDevice({ serialNumber: 'SAFE-DUP1' });

    const response = await request(app())
      .post('/api/v1/admin/devices')
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', admin.cookie)
      .send({ serialNumber: 'safe-dup1' });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('DUPLICATE_SERIAL');
  });
});

describe('POST /api/v1/admin/devices/bulk', () => {
  it('reports each row and creates only the valid new serials', async () => {
    const admin = await createTestAdmin();
    await seedDevice({ serialNumber: 'SAFE-0001' });

    const response = await request(app())
      .post('/api/v1/admin/devices/bulk')
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', admin.cookie)
      .send({ serialNumbers: ['SAFE-0002', 'SAFE-0001', 'bad', 'safe-0002'] });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ created: 1, duplicates: 2, invalid: 1 });
    expect(response.body.results).toHaveLength(4);
    expect(response.body.results[1]).toMatchObject({ row: 2, status: 'duplicate' });
    expect(response.body.results[2]).toMatchObject({ row: 3, status: 'invalid' });
    expect(response.body.results[3]).toMatchObject({ row: 4, status: 'duplicate' });
  });

  it('refuses more than 500 rows with a clear error', async () => {
    const admin = await createTestAdmin();
    const serialNumbers = Array.from({ length: 501 }, (_unused, index) =>
      `SAFE-${String(index).padStart(4, '0')}`,
    );

    const response = await request(app())
      .post('/api/v1/admin/devices/bulk')
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', admin.cookie)
      .send({ serialNumbers });

    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toMatch(/at most 500/);
    expect(await prisma.device.count()).toBe(0);
  });

  it('audits counts, not the submitted serial list', async () => {
    const admin = await createTestAdmin();

    await request(app())
      .post('/api/v1/admin/devices/bulk')
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', admin.cookie)
      .send({ serialNumbers: ['SAFE-1111', 'SAFE-2222'] });

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'device.bulk_created' },
    });
    expect(audit?.metadata).toMatchObject({ submitted: 2, created: 2 });
    expect(JSON.stringify(audit?.metadata)).not.toContain('SAFE-1111');
  });
});

describe('POST /api/v1/admin/bookings/:id/force-complete', () => {
  it('ends the booking and sends the safe for inspection by default', async () => {
    const admin = await createTestAdmin();
    const { user, deviceId, bookingId } = await createUserWithDevice();

    const response = await request(app())
      .post(`/api/v1/admin/bookings/${bookingId}/force-complete`)
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', admin.cookie)
      .send({ reason: 'Renter unreachable for two days' });

    expect(response.status).toBe(200);
    expect(response.body.needsInspection).toBe(true);

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(booking.status).toBe('COMPLETED');
    expect(booking.completionReason).toBe('ADMIN_FORCE_COMPLETED');
    expect(booking.adminNote).toBe('Renter unreachable for two days');

    /**
     * The safety property this whole feature exists for: the safe does **not**
     * go back into the pool. Nobody confirmed it was emptied, so renting it out
     * again could hand the next person someone else's property along with the
     * ability to unlock it.
     */
    const device = await prisma.device.findUniqueOrThrow({ where: { id: deviceId } });
    expect(device.status).toBe('NEEDS_INSPECTION');
    expect(device.inspectionNote).toBe('Renter unreachable for two days');

    // And the safe is commanded locked after the booking ends.
    expect(device.lockState).toBe('LOCKED');

    // Any open unlock code dies with the booking.
    const open = await prisma.unlockChallenge.count({
      where: { userId: user.id, consumedAt: null },
    });
    expect(open).toBe(0);

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'booking.force_completed' },
    });
    expect(audit?.metadata).toMatchObject({
      bookingId,
      completedByAdminId: admin.id,
      needsInspection: true,
      reason: 'Renter unreachable for two days',
    });
  });

  it('returns the safe to the pool when the admin says they checked it', async () => {
    const admin = await createTestAdmin();
    const { deviceId, bookingId } = await createUserWithDevice();

    const response = await request(app())
      .post(`/api/v1/admin/bookings/${bookingId}/force-complete`)
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', admin.cookie)
      .send({ reason: 'Collected in person at the desk', needsInspection: false });

    expect(response.status).toBe(200);
    expect(response.body.needsInspection).toBe(false);

    const device = await prisma.device.findUniqueOrThrow({ where: { id: deviceId } });
    expect(device.status).toBe('AVAILABLE');
  });

  it('requires a reason of at least three characters', async () => {
    const admin = await createTestAdmin();
    const { bookingId } = await createUserWithDevice();

    const response = await request(app())
      .post(`/api/v1/admin/bookings/${bookingId}/force-complete`)
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', admin.cookie)
      .send({ reason: 'x' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(booking.status).toBe('ACTIVE');
  });

  it('refuses a booking that has already ended, and audits the failure', async () => {
    const admin = await createTestAdmin();
    const { bookingId } = await createUserWithDevice();

    await prisma.booking.update({
      where: { id: bookingId },
      data: { status: 'COMPLETED', completedAt: new Date(), completionReason: 'COLLECTED' },
    });

    const response = await request(app())
      .post(`/api/v1/admin/bookings/${bookingId}/force-complete`)
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', admin.cookie)
      .send({ reason: 'Trying again by mistake' });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('BOOKING_STATE_INVALID');

    const audits = await prisma.auditLog.findMany({
      where: { action: 'booking.force_completed' },
    });
    const failure = audits.find(
      (row) => (row.metadata as { outcome?: string } | null)?.outcome === 'failed',
    );
    expect(failure?.metadata).toMatchObject({ errorCode: 'BOOKING_STATE_INVALID' });
  });
});

describe('POST /api/v1/admin/bookings/:id/waive-overstay', () => {
  it('waives the fee without recording it as revenue', async () => {
    const admin = await createTestAdmin();
    const { bookingId } = await createUserWithDevice();
    await pushIntoOverstay(bookingId, 2);

    const response = await request(app())
      .post(`/api/v1/admin/bookings/${bookingId}/waive-overstay`)
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', admin.cookie)
      .send({ reason: 'Our lock firmware was down for an hour' });

    expect(response.status).toBe(200);
    expect(response.body.waivedPaise).toBeGreaterThan(0);

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(booking.overstayWaivedAt).toBeInstanceOf(Date);
    // A waive must never look like money we collected.
    expect(booking.overstayPaidPaise).toBe(0);
    expect(booking.overstaySettledAt).toBeNull();

    // The user can now collect: the fee is no longer outstanding, and the
    // collection window has opened from the waive.
    expect(response.body.booking.overstayFeePaise).toBe(0);
    expect(response.body.booking.collectBy).not.toBeNull();

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'booking.overstay.waived' },
    });
    expect(audit?.metadata).toMatchObject({ bookingId, waivedByAdminId: admin.id });
    expect((audit?.metadata as { waivedPaise?: number })?.waivedPaise).toBeGreaterThan(0);
  });

  it('refuses when there is no fee outstanding', async () => {
    const admin = await createTestAdmin();
    const { bookingId } = await createUserWithDevice();

    const response = await request(app())
      .post(`/api/v1/admin/bookings/${bookingId}/waive-overstay`)
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', admin.cookie)
      .send({ reason: 'Nothing to waive here' });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('NOTHING_TO_PAY');
  });

  it('refuses a second waive on the same overstay', async () => {
    const admin = await createTestAdmin();
    const { bookingId } = await createUserWithDevice();
    await pushIntoOverstay(bookingId, 1);

    const waive = () =>
      request(app())
        .post(`/api/v1/admin/bookings/${bookingId}/waive-overstay`)
        .set('Origin', TEST_ORIGIN)
        .set('Cookie', admin.cookie)
        .send({ reason: 'Goodwill gesture for the outage' });

    expect((await waive()).status).toBe(200);

    const second = await waive();
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('BOOKING_STATE_INVALID');
  });
});

describe('GET /api/v1/admin/bookings', () => {
  it('lists bookings with the user and the serial', async () => {
    const admin = await createTestAdmin();
    const { user, serialNumber } = await createUserWithDevice();

    const response = await request(app())
      .get('/api/v1/admin/bookings')
      .set('Cookie', admin.cookie);

    expect(response.status).toBe(200);
    expect(response.body.total).toBe(1);
    expect(response.body.items[0]).toMatchObject({
      serialNumber,
      status: 'ACTIVE',
      effectiveStatus: 'ACTIVE',
      user: { id: user.id },
      flagged: false,
    });
  });

  /**
   * The flagged list is the admin's work queue, and an unpaid overstay is the
   * case that must never be reachable only by scrolling: the sweeper
   * deliberately never completes one, so nothing else will surface it.
   */
  it('flags an unpaid overstay', async () => {
    const admin = await createTestAdmin();
    const { bookingId } = await createUserWithDevice();
    await pushIntoOverstay(bookingId, 1);

    const flagged = await request(app())
      .get('/api/v1/admin/bookings?flagged=true')
      .set('Cookie', admin.cookie);

    expect(flagged.status).toBe(200);
    expect(flagged.body.items).toHaveLength(1);
    expect(flagged.body.items[0]).toMatchObject({
      id: bookingId,
      effectiveStatus: 'OVERSTAY',
      flagged: true,
    });
    expect(flagged.body.items[0].overstayFeePaise).toBeGreaterThan(0);

    const unflagged = await request(app())
      .get('/api/v1/admin/bookings?flagged=false')
      .set('Cookie', admin.cookie);
    expect(unflagged.body.items).toHaveLength(0);
  });

  it('flags a booking whose safe is awaiting inspection', async () => {
    const admin = await createTestAdmin();
    const { bookingId, deviceId } = await createUserWithDevice();

    await request(app())
      .post(`/api/v1/admin/bookings/${bookingId}/force-complete`)
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', admin.cookie)
      .send({ reason: 'Renter never came back' });

    const device = await prisma.device.findUniqueOrThrow({ where: { id: deviceId } });
    expect(device.status).toBe('NEEDS_INSPECTION');

    const flagged = await request(app())
      .get('/api/v1/admin/bookings?flagged=true')
      .set('Cookie', admin.cookie);

    expect(flagged.body.items).toHaveLength(1);
    expect(flagged.body.items[0].id).toBe(bookingId);
  });

  it('filters by status and searches by serial', async () => {
    const admin = await createTestAdmin();
    await createUserWithDevice();
    const second = await createUserWithDevice();

    const active = await request(app())
      .get('/api/v1/admin/bookings?status=ACTIVE')
      .set('Cookie', admin.cookie);
    expect(active.body.total).toBe(2);

    const completed = await request(app())
      .get('/api/v1/admin/bookings?status=COMPLETED')
      .set('Cookie', admin.cookie);
    expect(completed.body.total).toBe(0);

    const bySerial = await request(app())
      .get(`/api/v1/admin/bookings?q=${second.serialNumber}`)
      .set('Cookie', admin.cookie);
    expect(bySerial.body.total).toBe(1);
  });
});

describe('POST /api/v1/admin/devices/:id/clear-inspection', () => {
  it('returns an inspected safe to the pool, with an audited note', async () => {
    const admin = await createTestAdmin();
    const { bookingId, deviceId } = await createUserWithDevice();

    await request(app())
      .post(`/api/v1/admin/bookings/${bookingId}/force-complete`)
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', admin.cookie)
      .send({ reason: 'Renter never came back' });

    const response = await request(app())
      .post(`/api/v1/admin/devices/${deviceId}/clear-inspection`)
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', admin.cookie)
      .send({ note: 'Opened at the desk, empty, wiped down' });

    expect(response.status).toBe(200);
    expect(response.body.device.status).toBe('AVAILABLE');

    const device = await prisma.device.findUniqueOrThrow({ where: { id: deviceId } });
    expect(device.status).toBe('AVAILABLE');
    expect(device.inspectionNote).toBe('Opened at the desk, empty, wiped down');

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'device.inspection.cleared' },
    });
    expect(audit?.metadata).toMatchObject({
      clearedByAdminId: admin.id,
      note: 'Opened at the desk, empty, wiped down',
    });
  });

  /** A safe nobody has flagged does not need clearing, and saying so is honest. */
  it('refuses a safe that is not awaiting inspection', async () => {
    const admin = await createTestAdmin();
    const device = await seedDevice();

    const response = await request(app())
      .post(`/api/v1/admin/devices/${device.id}/clear-inspection`)
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', admin.cookie)
      .send({ note: 'Nothing was wrong with it' });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('DEVICE_NOT_AVAILABLE');
  });

  it('requires a note', async () => {
    const admin = await createTestAdmin();
    const device = await seedDevice();

    const response = await request(app())
      .post(`/api/v1/admin/devices/${device.id}/clear-inspection`)
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', admin.cookie)
      .send({});

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  /**
   * And a flagged safe cannot be booked in the meantime.
   *
   * The end-to-end form of the rule: the device pick filters on
   * `status = 'AVAILABLE'`, so a safe awaiting inspection is simply not in the
   * pool until a human has cleared it.
   */
  it('keeps a flagged safe out of the booking pool until cleared', async () => {
    const admin = await createTestAdmin();
    const { bookingId, deviceId } = await createUserWithDevice();

    await request(app())
      .post(`/api/v1/admin/bookings/${bookingId}/force-complete`)
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', admin.cookie)
      .send({ reason: 'Renter never came back' });

    const nextRenter = await createTestUser();
    const refused = await request(app())
      .post('/api/v1/bookings')
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', nextRenter.cookie)
      .send({ hours: 1 });

    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('NO_DEVICES_AVAILABLE');

    await request(app())
      .post(`/api/v1/admin/devices/${deviceId}/clear-inspection`)
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', admin.cookie)
      .send({ note: 'Checked, empty' });

    const allowed = await request(app())
      .post('/api/v1/bookings')
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', nextRenter.cookie)
      .send({ hours: 1 });

    expect(allowed.status).toBe(201);
    expect(allowed.body.booking.deviceId).toBe(deviceId);
  });
});

describe('GET /api/v1/admin/devices/:id/commands', () => {
  /**
   * The §7 expander: what this safe has been doing lately.
   *
   * The interesting assertion is the negative one. `seq` is not a secret, but
   * it is an input to a signed canonical string, and the rule in this codebase
   * is that nothing feeding a signature is serialised to a client — the same
   * discipline that keeps `credentialHash` out of every select.
   */
  it('returns recent commands newest first, with no signing input', async () => {
    const admin = await createTestAdmin();
    const held = await createUserWithDevice();

    // A safe already locked issues no command at all — locking is idempotent.
    await prisma.device.update({
      where: { id: held.deviceId },
      data: { lockState: 'UNLOCKED' },
    });

    await request(app())
      .post('/api/v1/devices/lock')
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', held.user.cookie)
      .send({});

    const response = await request(app())
      .get(`/api/v1/admin/devices/${held.deviceId}/commands`)
      .set('Cookie', admin.cookie);

    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0]).toMatchObject({
      type: 'LOCK',
      // A user asked, so the actor is the person and not a system actor.
      actor: 'USER',
    });

    const serialised = JSON.stringify(response.body);
    for (const forbidden of ['seq', 'sig', 'commandKey', 'credentialHash', 'keyVersion']) {
      expect(serialised, forbidden).not.toContain(forbidden);
    }
  });

  /**
   * Latency is measured from `sentAt`, not `issuedAt`.
   *
   * The gap between committing a row and publishing it is our own scheduling,
   * and folding it into a number labelled "device latency" would make our
   * slowness look like the hardware's.
   */
  it('reports a latency the device is actually responsible for', async () => {
    const admin = await createTestAdmin();
    const held = await createUserWithDevice();

    // A safe already locked issues no command at all — locking is idempotent.
    await prisma.device.update({
      where: { id: held.deviceId },
      data: { lockState: 'UNLOCKED' },
    });

    await request(app())
      .post('/api/v1/devices/lock')
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', held.user.cookie)
      .send({});
    await drainDeviceAcks();

    const command = await prisma.command.findFirstOrThrow({
      where: { deviceId: held.deviceId },
      select: { id: true, sentAt: true, ackedAt: true },
    });

    // Backdated so the two possible answers differ by a visible amount.
    await prisma.command.update({
      where: { id: command.id },
      data: {
        issuedAt: new Date(Date.now() - 60_000),
        sentAt: new Date(Date.now() - 1_000),
        ackedAt: new Date(),
      },
    });

    const response = await request(app())
      .get(`/api/v1/admin/devices/${held.deviceId}/commands`)
      .set('Cookie', admin.cookie);

    const latency = response.body.items[0].latencyMs as number;
    expect(latency).toBeGreaterThanOrEqual(900);
    expect(latency).toBeLessThan(5_000);
  });

  it('404s an unknown device', async () => {
    const admin = await createTestAdmin();

    const response = await request(app())
      .get('/api/v1/admin/devices/not-a-device/commands')
      .set('Cookie', admin.cookie);

    expect(response.status).toBe(404);
  });
});

describe('POST /api/v1/admin/devices/:id/credential', () => {
  const issue = (deviceId: string, cookie: string) =>
    request(app())
      .post(`/api/v1/admin/devices/${deviceId}/credential`)
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', cookie)
      .send({});

  /**
   * The one response in this API that carries a secret, and the only time it
   * exists in readable form.
   *
   * A device cannot be *told* its identity over a channel it does not yet
   * have, so the secrets have to come out of an endpoint once. What matters is
   * that "once" is literal: only a `sha256` of the password is kept, nothing
   * of the key at all, and nothing reads either back.
   */
  it('returns the password and command key once, and stores only a hash', async () => {
    const admin = await createTestAdmin();
    const device = await seedDevice();

    /**
     * `seedDevice` pre-provisions, because every other test needs a device
     * whose commands can be signed. A genuinely new unit has nothing, which is
     * the state this test is about.
     */
    await prisma.device.update({
      where: { id: device.id },
      data: { credentialIssuedAt: null },
    });

    const response = await issue(device.id, admin.cookie);

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      deviceId: device.id,
      serialNumber: device.serialNumber,
      keyVersion: 1,
      reissued: false,
    });
    expect(response.body.password).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(response.body.commandKey).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // A secret-bearing response must not be cacheable by anything in the path.
    expect(response.headers['cache-control']).toBe('no-store');

    const stored = await prisma.device.findUniqueOrThrow({
      where: { id: device.id },
      select: { credentialHash: true, credentialIssuedAt: true, commandKeyVersion: true },
    });

    // The hash, and never the password.
    expect(stored.credentialHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.credentialHash).not.toBe(response.body.password);
    expect(stored.credentialIssuedAt).not.toBeNull();
    expect(stored.commandKeyVersion).toBe(1);

    /**
     * And the key is not stored in any form, hashed or otherwise. It is
     * derived from the master secret and the serial on demand, which is why a
     * database leak yields no device key.
     */
    const row = await prisma.$queryRaw<
      Array<Record<string, unknown>>
    >`SELECT * FROM "Device" WHERE "id" = ${device.id}`;
    expect(JSON.stringify(row)).not.toContain(response.body.commandKey);
    expect(JSON.stringify(row)).not.toContain(response.body.password);
  });

  /**
   * Re-issuing is a revocation, and the response says so.
   *
   * The dangerous case: the old password stops working the moment the broker
   * is updated, so a unit in the field that is not then re-provisioned goes
   * silent. An admin needs to know that before they press the button and
   * afterwards in the audit log.
   */
  it('mints a different credential on a re-issue and flags it as one', async () => {
    const admin = await createTestAdmin();
    const device = await seedDevice();

    await prisma.device.update({
      where: { id: device.id },
      data: { credentialIssuedAt: null },
    });

    const first = await issue(device.id, admin.cookie);
    const firstHash = (
      await prisma.device.findUniqueOrThrow({
        where: { id: device.id },
        select: { credentialHash: true },
      })
    ).credentialHash;

    const second = await issue(device.id, admin.cookie);

    expect(second.status).toBe(201);
    expect(second.body.reissued).toBe(true);
    expect(second.body.password).not.toBe(first.body.password);

    // The key is derived from the serial, so it is *stable* across a re-issue
    // at the same version — which is the point of versioning it rather than
    // rotating it per credential.
    expect(second.body.commandKey).toBe(first.body.commandKey);

    expect(
      (
        await prisma.device.findUniqueOrThrow({
          where: { id: device.id },
          select: { credentialHash: true },
        })
      ).credentialHash,
    ).not.toBe(firstHash);

    const audit = await prisma.auditLog.findMany({
      where: { action: 'device.credential.issued' },
      orderBy: { createdAt: 'asc' },
      select: { metadata: true },
    });
    expect(audit).toHaveLength(2);
    expect(audit[1]?.metadata).toMatchObject({ reissued: true, keyVersion: 1 });
  });

  /**
   * Nothing derived from the secrets reaches the audit table.
   *
   * Not a prefix, not a length, not a digest. An audit row is read by more
   * people than a password store, and a value that is useless to an attacker
   * is equally useless to the admin reading the row — so there is nothing to
   * put there.
   */
  it('audits the issue without recording anything derived from the secrets', async () => {
    const admin = await createTestAdmin();
    const device = await seedDevice();

    const response = await issue(device.id, admin.cookie);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'device.credential.issued' },
    });

    const serialised = JSON.stringify(audit);
    expect(serialised).not.toContain(response.body.password);
    expect(serialised).not.toContain(response.body.commandKey);
    expect(serialised).not.toContain(response.body.password.slice(0, 8));
  });

  /**
   * `NEEDS_INSPECTION` keeps its credential and can be re-provisioned.
   *
   * The disagreement with the brief, and §2.3's reasoning: that status means a
   * safe is in the field with contents nobody has checked. Revoking its
   * credential would make the one device that most needs attention the one
   * device nobody can reach.
   */
  it('issues to a safe awaiting inspection, which is the safe most needing to be reachable', async () => {
    const admin = await createTestAdmin();
    const device = await seedDevice();

    await prisma.device.update({
      where: { id: device.id },
      data: { status: 'NEEDS_INSPECTION' },
    });

    const response = await issue(device.id, admin.cookie);

    expect(response.status).toBe(201);
    expect(response.body.password).toBeTruthy();
  });

  it('refuses a retired safe, whose credential was revoked deliberately', async () => {
    const admin = await createTestAdmin();
    const device = await seedDevice();

    await prisma.device.update({ where: { id: device.id }, data: { status: 'RETIRED' } });

    const response = await issue(device.id, admin.cookie);

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('DEVICE_NOT_AVAILABLE');
    expect(
      (
        await prisma.device.findUniqueOrThrow({
          where: { id: device.id },
          select: { credentialHash: true },
        })
      ).credentialHash,
    ).toBeNull();
  });

  it('404s an unknown device', async () => {
    const admin = await createTestAdmin();

    expect((await issue('not-a-device', admin.cookie)).status).toBe(404);
  });
});

/**
 * Which safes can still be commanded, read as one thing.
 *
 * The two halves of §2.3 are deliberately adjacent. Retirement revokes the
 * credential, so a retired unit cannot connect at all; `NEEDS_INSPECTION`
 * keeps its credential on purpose and is refused at a different layer
 * entirely. Keeping a live credential is not the same as keeping a live safe,
 * and the two must not be allowed to drift together — which is only visible
 * if both tests are in front of you.
 */
describe('which safes the server will still issue an UNLOCK to', () => {
  /** Watches the transport without answering, so "nothing was published" means it. */
  function watchGateway() {
    return {
      lock: vi.spyOn(deviceGateway, 'sendLock'),
      unlock: vi.spyOn(deviceGateway, 'sendUnlock'),
    };
  }

  /**
   * The guarantee that does not depend on how the device got there.
   *
   * A booking should not exist for an inspecting safe — it is excluded from
   * the pick — but "should not exist" is a consequence of a `WHERE` clause
   * three modules away, and a physical-security guarantee must not rest on
   * one. So the command issuer refuses outright, under the device row lock, in
   * the same transaction that would have allocated the sequence number.
   */
  it('refuses an UNLOCK to a NEEDS_INSPECTION safe, and publishes nothing', async () => {
    const held = await createUserWithDevice();
    const gateway = watchGateway();

    const { result, code } = await withCapturedOtp(() =>
      request(app())
        .post('/api/v1/devices/unlock/request')
        .set('Origin', TEST_ORIGIN)
        .set('Cookie', held.user.cookie)
        .send({}),
    );
    expect(result.status).toBe(200);

    // The status changes *after* the code is issued, which is the race this
    // guard exists for: an admin flags a safe while a renter is typing.
    await prisma.device.update({
      where: { id: held.deviceId },
      data: { status: 'NEEDS_INSPECTION' },
    });

    const confirm = await request(app())
      .post('/api/v1/devices/unlock/confirm')
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', held.user.cookie)
      .send({ otp: code });

    expect(confirm.status).toBe(409);
    expect(confirm.body.error.code).toBe('DEVICE_NOT_OPERABLE');

    // Nothing published, no command row, no sequence number spent.
    expect(gateway.unlock).not.toHaveBeenCalled();
    expect(await prisma.command.count({ where: { deviceId: held.deviceId } })).toBe(0);
    expect(
      (
        await prisma.device.findUniqueOrThrow({
          where: { id: held.deviceId },
          select: { commandSeq: true },
        })
      ).commandSeq,
    ).toBe(0);

    /**
     * And the code survives, unbound. The transaction that would have claimed
     * it rolled back with the refusal, so a user whose safe was flagged
     * mid-flow has not lost their code — though they will not be opening the
     * safe with it either.
     */
    expect(
      await prisma.unlockChallenge.findFirstOrThrow({
        where: { userId: held.user.id },
        select: { consumedAt: true, commandId: true },
      }),
    ).toMatchObject({ consumedAt: null, commandId: null });

    vi.restoreAllMocks();
  });

  /**
   * Locking a safe under inspection is still allowed, and that asymmetry is
   * the point: a safe an admin has opened is exactly a safe somebody may need
   * to close, and locking is the safe direction everywhere else in this system
   * too.
   */
  it('still allows a LOCK to a NEEDS_INSPECTION safe', async () => {
    const held = await createUserWithDevice();

    await prisma.device.update({
      where: { id: held.deviceId },
      data: { status: 'NEEDS_INSPECTION', lockState: 'UNLOCKED' },
    });

    const response = await request(app())
      .post('/api/v1/devices/lock')
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', held.user.cookie)
      .send({});

    expect(response.status).toBe(202);
    expect(await prisma.command.count({ where: { deviceId: held.deviceId } })).toBe(1);
  });

  /** Retirement, the other half: the credential is gone, so is the unlock. */
  it('revokes the credential on retirement and refuses an UNLOCK to a retired safe', async () => {
    const admin = await createTestAdmin();
    const held = await createUserWithDevice();

    const credential = await request(app())
      .post(`/api/v1/admin/devices/${held.deviceId}/credential`)
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', admin.cookie)
      .send({});
    expect(credential.status).toBe(201);

    const { result, code } = await withCapturedOtp(() =>
      request(app())
        .post('/api/v1/devices/unlock/request')
        .set('Origin', TEST_ORIGIN)
        .set('Cookie', held.user.cookie)
        .send({}),
    );
    expect(result.status).toBe(200);

    /**
     * Retiring is refused while a booking is live, which is the rule that
     * makes this test take the long way round: the booking is force-completed
     * first, exactly as an admin would have to.
     */
    await request(app())
      .post(`/api/v1/admin/bookings/${held.bookingId}/force-complete`)
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', admin.cookie)
      .send({ reason: 'Unit is being taken out of service' });

    const retire = await request(app())
      .post(`/api/v1/admin/devices/${held.deviceId}/retire`)
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', admin.cookie)
      .send({});

    expect(retire.status).toBe(200);
    expect(retire.body.credentialRevoked).toBe(true);

    const stored = await prisma.device.findUniqueOrThrow({
      where: { id: held.deviceId },
      select: { credentialHash: true, credentialIssuedAt: true },
    });
    expect(stored).toMatchObject({ credentialHash: null, credentialIssuedAt: null });

    // The revocation gets a row of its own, because it has a second half
    // somebody has to perform at the broker by hand.
    expect(
      await prisma.auditLog.findFirstOrThrow({
        where: { action: 'device.credential.revoked' },
        select: { metadata: true },
      }),
    ).toMatchObject({ metadata: { reason: 'RETIRED' } });

    /**
     * And the unlock is refused on the **booking**, not on the hardware —
     * which is the right refusal and the right order. Completing the booking
     * took the entitlement away, and `assertCanOperate` asks about
     * entitlement before anything reaches the command issuer. A renter is told
     * their rental has ended rather than being sent to look at a safe.
     */
    const confirm = await request(app())
      .post('/api/v1/devices/unlock/confirm')
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', held.user.cookie)
      .send({ otp: code });

    expect(confirm.status).toBe(409);
    expect(confirm.body.error.code).toBe('NO_ACTIVE_BOOKING');
    expect(await prisma.command.count({ where: { deviceId: held.deviceId, type: 'UNLOCK' } })).toBe(
      0,
    );
  });

  /** A retired safe with a live booking cannot happen, so this forces the state. */
  it('refuses an UNLOCK to a RETIRED safe even with a booking that would otherwise allow it', async () => {
    const held = await createUserWithDevice();
    const gateway = watchGateway();

    const { code } = await withCapturedOtp(() =>
      request(app())
        .post('/api/v1/devices/unlock/request')
        .set('Origin', TEST_ORIGIN)
        .set('Cookie', held.user.cookie)
        .send({}),
    );

    await prisma.device.update({
      where: { id: held.deviceId },
      data: { status: 'RETIRED' },
    });

    const confirm = await request(app())
      .post('/api/v1/devices/unlock/confirm')
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', held.user.cookie)
      .send({ otp: code });

    expect(confirm.status).toBe(409);
    expect(confirm.body.error.code).toBe('DEVICE_NOT_OPERABLE');
    expect(gateway.unlock).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });
});

describe('POST /api/v1/admin/devices/:id/retire', () => {
  it('refuses to retire a safe with a live booking, and audits the failure', async () => {
    const admin = await createTestAdmin();
    const { deviceId } = await createUserWithDevice();

    const response = await request(app())
      .post(`/api/v1/admin/devices/${deviceId}/retire`)
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', admin.cookie)
      .send({});

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('DEVICE_HAS_LIVE_BOOKING');

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'device.retire.failed' },
    });
    expect(audit?.metadata).toMatchObject({ errorCode: 'DEVICE_HAS_LIVE_BOOKING' });
  });

  it('retires a free safe', async () => {
    const admin = await createTestAdmin();
    const device = await seedDevice();

    const response = await request(app())
      .post(`/api/v1/admin/devices/${device.id}/retire`)
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', admin.cookie)
      .send({});

    expect(response.status).toBe(200);
    expect(response.body.device.status).toBe('RETIRED');
    expect(
      await prisma.auditLog.count({ where: { action: 'device.retired' } }),
    ).toBe(1);
  });
});

describe('GET /api/v1/admin/users', () => {
  /**
   * The work queue has changed shape, not disappeared.
   *
   * There is no Allocate button to feed any more, so what sorts to the top is
   * trouble: a user who owes an overstay fee, then anyone holding a safe, then
   * everyone else.
   */
  it('puts users who owe an overstay fee first, then holders', async () => {
    const admin = await createTestAdmin();

    const holder = await createUserWithDevice();
    await prisma.user.update({
      where: { id: holder.user.id },
      data: { name: 'Ordinary Holder' },
    });

    const owing = await createUserWithDevice();
    await prisma.user.update({ where: { id: owing.user.id }, data: { name: 'Owes A Fee' } });
    await pushIntoOverstay(owing.bookingId, 2);

    await createTestUser({ name: 'Nothing Doing' });

    const response = await request(app())
      .get('/api/v1/admin/users')
      .set('Cookie', admin.cookie);

    expect(response.status).toBe(200);
    const names = (response.body.items as Array<{ name: string }>).map((row) => row.name);

    expect(names[0]).toBe('Owes A Fee');
    expect(names[1]).toBe('Ordinary Holder');

    // And the column an admin actually reads: what have they got, and is it
    // in trouble?
    expect(response.body.items[0].currentBooking).toMatchObject({
      id: owing.bookingId,
      serialNumber: owing.serialNumber,
      effectiveStatus: 'OVERSTAY',
    });
    expect(response.body.items[0].currentBooking.overstayFeePaise).toBeGreaterThan(0);

    expect(response.body.items[1].currentBooking).toMatchObject({
      effectiveStatus: 'ACTIVE',
      overstayFeePaise: 0,
    });
  });

  it('filters by whether the user holds a booking', async () => {
    const admin = await createTestAdmin();

    const holder = await createUserWithDevice();
    await createTestUser();

    const booked = await request(app())
      .get('/api/v1/admin/users?booked=true')
      .set('Cookie', admin.cookie);
    expect(booked.body.total).toBe(1);
    expect(booked.body.items[0].id).toBe(holder.user.id);

    const free = await request(app())
      .get('/api/v1/admin/users?booked=false')
      .set('Cookie', admin.cookie);
    // The user with no booking plus the admin account itself.
    expect(free.body.total).toBe(2);
  });

  it('reports a null current booking once it has ended', async () => {
    const admin = await createTestAdmin();
    const { user, bookingId } = await createUserWithDevice();

    await prisma.booking.update({
      where: { id: bookingId },
      data: { status: 'COMPLETED', completedAt: new Date(), completionReason: 'COLLECTED' },
    });

    const response = await request(app())
      .get(`/api/v1/admin/users?q=${encodeURIComponent(user.email)}`)
      .set('Cookie', admin.cookie);

    expect(response.body.items[0].currentBooking).toBeNull();
  });

  it('searches by name, email and phone', async () => {
    const admin = await createTestAdmin();
    const user = await createTestUser({ name: 'Findable Person' });

    const byName = await request(app())
      .get('/api/v1/admin/users?q=findable')
      .set('Cookie', admin.cookie);
    expect(byName.body.total).toBe(1);

    const byEmail = await request(app())
      .get(`/api/v1/admin/users?q=${encodeURIComponent(user.email)}`)
      .set('Cookie', admin.cookie);
    expect(byEmail.body.total).toBe(1);

    const byPhone = await request(app())
      .get(`/api/v1/admin/users?q=${user.phone}`)
      .set('Cookie', admin.cookie);
    expect(byPhone.body.total).toBe(1);
  });

  /**
   * The exact field list, asserted.
   *
   * This is the allow-list that keeps admin tooling from being the place a
   * password hash first reaches a browser, so it is pinned rather than
   * described.
   */
  it('returns only the agreed user fields', async () => {
    const admin = await createTestAdmin();
    await createTestUser();

    const response = await request(app())
      .get('/api/v1/admin/users')
      .set('Cookie', admin.cookie);

    for (const row of response.body.items as Array<Record<string, unknown>>) {
      expect(Object.keys(row).sort()).toEqual([
        'createdAt',
        'currentBooking',
        'email',
        'id',
        'name',
        'phone',
        'phoneVerified',
        'role',
      ]);
    }
  });
});

describe('GET /api/v1/admin/payments and /audit', () => {
  it('lists payments with their purpose, booking and owning user', async () => {
    const admin = await createTestAdmin();
    const { user, bookingId } = await createUserWithDevice();
    await seedPayment({
      userId: user.id,
      bookingId,
      purpose: 'BOOKING',
      amount: 20_000,
      status: 'PAID',
    });

    const all = await request(app())
      .get('/api/v1/admin/payments')
      .set('Cookie', admin.cookie);
    expect(all.body.total).toBe(1);
    expect(all.body.items[0]).toMatchObject({
      status: 'PAID',
      purpose: 'BOOKING',
      bookingId,
      user: { id: user.id },
      reviewReason: null,
    });

    const failed = await request(app())
      .get('/api/v1/admin/payments?status=FAILED')
      .set('Cookie', admin.cookie);
    expect(failed.body.total).toBe(0);

    const overstay = await request(app())
      .get('/api/v1/admin/payments?purpose=OVERSTAY')
      .set('Cookie', admin.cookie);
    expect(overstay.body.total).toBe(0);
  });

  /**
   * The refund queue.
   *
   * Money we captured and could not apply stays `PAID` — we never rewrite a
   * payment to pretend it did not happen — so this filter is the only way an
   * admin finds it.
   */
  it('filters the payments that need a manual refund', async () => {
    const admin = await createTestAdmin();
    const user = await createTestUser();

    const flagged = await seedPayment({
      userId: user.id,
      amount: 20_000,
      status: 'PAID',
      reviewReason: 'BOOKING_EXPIRED_DEVICE_TAKEN',
    });
    await seedPayment({ userId: user.id, amount: 20_000, status: 'PAID' });

    const queue = await request(app())
      .get('/api/v1/admin/payments?needsReview=true')
      .set('Cookie', admin.cookie);

    expect(queue.body.total).toBe(1);
    expect(queue.body.items[0]).toMatchObject({
      id: flagged.id,
      status: 'PAID',
      reviewReason: 'BOOKING_EXPIRED_DEVICE_TAKEN',
      reviewClearedAt: null,
    });

    const rest = await request(app())
      .get('/api/v1/admin/payments?needsReview=false')
      .set('Cookie', admin.cookie);
    expect(rest.body.total).toBe(1);
  });

  it('clears a review flag with an audited note, without touching the status', async () => {
    const admin = await createTestAdmin();
    const user = await createTestUser();
    const flagged = await seedPayment({
      userId: user.id,
      amount: 20_000,
      status: 'PAID',
      reviewReason: 'OVERSTAY_QUOTE_EXPIRED',
    });

    const response = await request(app())
      .post(`/api/v1/admin/payments/${flagged.id}/clear-review`)
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', admin.cookie)
      .send({ note: 'Refunded in the Razorpay dashboard, ref rfnd_123' });

    expect(response.status).toBe(200);

    const row = await prisma.payment.findUniqueOrThrow({ where: { id: flagged.id } });
    expect(row.reviewClearedAt).toBeInstanceOf(Date);
    // A payment is PAID until Razorpay says otherwise. Ticking a box is not
    // Razorpay saying otherwise.
    expect(row.status).toBe('PAID');

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'payment.review_cleared' },
    });
    expect(audit?.metadata).toMatchObject({
      paymentRowId: flagged.id,
      clearedByAdminId: admin.id,
      note: 'Refunded in the Razorpay dashboard, ref rfnd_123',
    });
  });

  it('refuses to clear a payment that is not flagged', async () => {
    const admin = await createTestAdmin();
    const user = await createTestUser();
    const ordinary = await seedPayment({ userId: user.id, amount: 20_000, status: 'PAID' });

    const response = await request(app())
      .post(`/api/v1/admin/payments/${ordinary.id}/clear-review`)
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', admin.cookie)
      .send({ note: 'Nothing wrong with this one' });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('BOOKING_STATE_INVALID');
  });

  it('refuses to clear the same flag twice', async () => {
    const admin = await createTestAdmin();
    const user = await createTestUser();
    const flagged = await seedPayment({
      userId: user.id,
      amount: 20_000,
      status: 'PAID',
      reviewReason: 'BOOKING_NO_LONGER_PAYABLE',
    });

    const clear = () =>
      request(app())
        .post(`/api/v1/admin/payments/${flagged.id}/clear-review`)
        .set('Origin', TEST_ORIGIN)
        .set('Cookie', admin.cookie)
        .send({ note: 'Refunded by hand' });

    expect((await clear()).status).toBe(200);
    expect((await clear()).status).toBe(409);
  });

  it('lists audit entries newest first and filters by action', async () => {
    const admin = await createTestAdmin();
    const device = await seedDevice();

    await request(app())
      .post(`/api/v1/admin/devices/${device.id}/retire`)
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', admin.cookie)
      .send({});

    const response = await request(app())
      .get('/api/v1/admin/audit?action=device.retired')
      .set('Cookie', admin.cookie);

    expect(response.status).toBe(200);
    expect(response.body.total).toBe(1);
    expect(response.body.items[0]).toMatchObject({ action: 'device.retired' });
  });
});

describe('admin responses never carry secret material', () => {
  /** Recursively collects every key name and string value in a payload. */
  function walk(value: unknown, keys: string[] = [], values: string[] = []) {
    if (typeof value === 'string') {
      values.push(value);
      return { keys, values };
    }
    if (value === null || typeof value !== 'object') return { keys, values };

    if (Array.isArray(value)) {
      for (const item of value) walk(item, keys, values);
      return { keys, values };
    }

    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      keys.push(key);
      walk(inner, keys, values);
    }
    return { keys, values };
  }

  const FORBIDDEN_KEY = /passwordhash|tokenhash|credentialhash|refreshtoken|secret|signature/i;

  it('exposes no hash, token or credential field on any admin endpoint', async () => {
    const admin = await createTestAdmin();

    // Build a rich dataset: a user holding a booked safe, a payment, audit
    // rows, a refresh token, and a device carrying a (hypothetical) credential.
    const { user, deviceId, bookingId } = await createUserWithDevice();
    await seedPayment({
      userId: user.id,
      bookingId,
      amount: 20_000,
      status: 'PAID',
    });

    await prisma.device.update({
      where: { id: deviceId },
      data: { credentialHash: 'DEVICE-CREDENTIAL-SENTINEL' },
    });
    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: 'REFRESH-TOKEN-HASH-SENTINEL',
        familyId: 'fam-1',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const endpoints = [
      '/api/v1/admin/devices',
      '/api/v1/admin/bookings',
      '/api/v1/admin/users',
      '/api/v1/admin/payments',
      '/api/v1/admin/audit',
    ];

    for (const endpoint of endpoints) {
      const response = await request(app()).get(endpoint).set('Cookie', admin.cookie);
      expect(response.status, endpoint).toBe(200);

      const { keys, values } = walk(response.body);

      const offendingKeys = keys.filter((key) => FORBIDDEN_KEY.test(key));
      expect(offendingKeys, `${endpoint} exposed keys: ${offendingKeys.join(', ')}`).toEqual([]);

      const serialised = JSON.stringify(response.body);
      expect(serialised, endpoint).not.toContain('DEVICE-CREDENTIAL-SENTINEL');
      expect(serialised, endpoint).not.toContain('REFRESH-TOKEN-HASH-SENTINEL');
      // No argon2 hash anywhere.
      expect(values.some((value) => value.startsWith('$argon2')), endpoint).toBe(false);
    }
  });

  it('exposes no password hash on a force-complete response', async () => {
    const admin = await createTestAdmin();
    const { bookingId } = await createUserWithDevice();

    const response = await request(app())
      .post(`/api/v1/admin/bookings/${bookingId}/force-complete`)
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', admin.cookie)
      .send({ reason: 'Renter unreachable' });

    const { keys } = walk(response.body);
    expect(keys.filter((key) => FORBIDDEN_KEY.test(key))).toEqual([]);
    expect(JSON.stringify(response.body)).not.toMatch(/\$argon2/);
  });
});

describe('admin routes are covered by the Origin check', () => {
  it('rejects an admin write from a wrong origin', async () => {
    const admin = await createTestAdmin();

    const response = await request(app())
      .post('/api/v1/admin/devices')
      .set('Origin', 'https://evil.example.com')
      .set('Cookie', admin.cookie)
      .send({ serialNumber: 'SAFE-EVIL' });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('CSRF_ORIGIN_REJECTED');
    expect(await prisma.device.count()).toBe(0);
  });

  it('rejects an admin write with cookies but no Origin', async () => {
    const admin = await createTestAdmin();

    const response = await request(app())
      .post('/api/v1/admin/devices')
      .set('Cookie', admin.cookie)
      .send({ serialNumber: 'SAFE-NOORIGIN' });

    expect(response.status).toBe(403);
    expect(await prisma.device.count()).toBe(0);
  });
});

describe('admin write rate limiting', () => {
  it('returns 429 once the admin write limit is exceeded', async () => {
    const admin = await createTestAdmin();
    // One app instance, so the limiter counter persists across requests.
    const instance = app({ rateLimits: { adminWrite: { windowMs: 60_000, limit: 2 } } });

    const create = (serial: string) =>
      request(instance)
        .post('/api/v1/admin/devices')
        .set('Origin', TEST_ORIGIN)
        .set('Cookie', admin.cookie)
        .send({ serialNumber: serial });

    expect((await create('SAFE-RL01')).status).toBe(201);
    expect((await create('SAFE-RL02')).status).toBe(201);

    const limited = await create('SAFE-RL03');
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');

    // Reads are not limited by adminWrite.
    const read = await request(instance).get('/api/v1/admin/devices').set('Cookie', admin.cookie);
    expect(read.status).toBe(200);
  });
});
