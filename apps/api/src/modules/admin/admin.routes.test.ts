import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '../../lib/prisma';
import {
  TEST_ORIGIN,
  app,
  createTestAdmin,
  createTestUser,
  givePaidPayment,
  seedDevice,
  seedDevices,
} from '../../test/helpers';
import { allocateDevice } from '../devices/device.service';

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
    path: '/api/v1/admin/devices/some-id/allocate',
    body: { userId: 'someone' },
  },
  { method: 'post' as const, path: '/api/v1/admin/allocate-next', body: { userId: 'someone' } },
  { method: 'post' as const, path: '/api/v1/admin/devices/some-id/unassign', body: {} },
  { method: 'post' as const, path: '/api/v1/admin/devices/some-id/retire', body: {} },
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

  it('rejects a paid, device-holding user — paying does not confer admin', async () => {
    const user = await createTestUser();
    await givePaidPayment(user.id);
    const device = await seedDevice();
    await allocateDevice(user.id, device.id);

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
  it('paginates and filters by status', async () => {
    const admin = await createTestAdmin();
    const user = await createTestUser();
    await givePaidPayment(user.id);
    const devices = await seedDevices(3);
    await allocateDevice(user.id, devices[0]!.id);

    const all = await request(app()).get('/api/v1/admin/devices').set('Cookie', admin.cookie);
    expect(all.body.total).toBe(3);
    expect(all.body.items).toHaveLength(3);

    const assigned = await request(app())
      .get('/api/v1/admin/devices?status=ASSIGNED')
      .set('Cookie', admin.cookie);
    expect(assigned.body.total).toBe(1);
    expect(assigned.body.items[0]).toMatchObject({
      serialNumber: devices[0]!.serialNumber,
      owner: { id: user.id },
    });

    const unassigned = await request(app())
      .get('/api/v1/admin/devices?status=UNASSIGNED')
      .set('Cookie', admin.cookie);
    expect(unassigned.body.total).toBe(2);

    const paged = await request(app())
      .get('/api/v1/admin/devices?page=2&pageSize=2')
      .set('Cookie', admin.cookie);
    expect(paged.body.items).toHaveLength(1);
    expect(paged.body).toMatchObject({ page: 2, pageSize: 2, total: 3, totalPages: 2 });
  });

  it('searches by serial and by owner, case-insensitively', async () => {
    const admin = await createTestAdmin();
    const user = await createTestUser({ name: 'Priya Sharma' });
    await givePaidPayment(user.id);
    const device = await seedDevice({ serialNumber: 'SAFE-FIND' });
    await allocateDevice(user.id, device.id);
    await seedDevice({ serialNumber: 'SAFE-OTHER' });

    const bySerial = await request(app())
      .get('/api/v1/admin/devices?q=find')
      .set('Cookie', admin.cookie);
    expect(bySerial.body.total).toBe(1);
    expect(bySerial.body.items[0].serialNumber).toBe('SAFE-FIND');

    const byOwner = await request(app())
      .get('/api/v1/admin/devices?q=priya')
      .set('Cookie', admin.cookie);
    expect(byOwner.body.total).toBe(1);
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

describe('admin allocation routes', () => {
  it('allocates a specific device and audits it against the receiving user', async () => {
    const admin = await createTestAdmin();
    const user = await createTestUser();
    await givePaidPayment(user.id);
    const device = await seedDevice();

    const response = await request(app())
      .post(`/api/v1/admin/devices/${device.id}/allocate`)
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', admin.cookie)
      .send({ userId: user.id });

    expect(response.status).toBe(200);
    expect(response.body.device).toMatchObject({ status: 'ASSIGNED', owner: { id: user.id } });

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'device.allocated', userId: user.id },
    });
    expect(audit).not.toBeNull();
    expect(audit?.metadata).toMatchObject({ allocatedByAdminId: admin.id, mode: 'specific' });
  });

  it('allocates the next available device', async () => {
    const admin = await createTestAdmin();
    const user = await createTestUser();
    await givePaidPayment(user.id);
    const [oldest] = await seedDevices(2);

    const response = await request(app())
      .post('/api/v1/admin/allocate-next')
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', admin.cookie)
      .send({ userId: user.id });

    expect(response.status).toBe(200);
    expect(response.body.device.id).toBe(oldest!.id);
  });

  it('returns 402 NOT_PAID and audits the failure with the error code', async () => {
    const admin = await createTestAdmin();
    const user = await createTestUser();
    const device = await seedDevice();

    const response = await request(app())
      .post(`/api/v1/admin/devices/${device.id}/allocate`)
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', admin.cookie)
      .send({ userId: user.id });

    expect(response.status).toBe(402);
    expect(response.body.error.code).toBe('NOT_PAID');

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'device.allocation.failed' },
    });
    expect(audit).not.toBeNull();
    expect(audit?.metadata).toMatchObject({
      outcome: 'failed',
      errorCode: 'NOT_PAID',
      targetUserId: user.id,
    });
  });

  it('returns 404 USER_NOT_FOUND for an unknown userId', async () => {
    const admin = await createTestAdmin();
    const device = await seedDevice();

    const response = await request(app())
      .post(`/api/v1/admin/devices/${device.id}/allocate`)
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', admin.cookie)
      .send({ userId: 'usr_nope' });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('USER_NOT_FOUND');
  });

  it('returns 409 NO_DEVICES_IN_STOCK when the inventory is empty', async () => {
    const admin = await createTestAdmin();
    const user = await createTestUser();
    await givePaidPayment(user.id);

    const response = await request(app())
      .post('/api/v1/admin/allocate-next')
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', admin.cookie)
      .send({ userId: user.id });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('NO_DEVICES_IN_STOCK');
  });
});

describe('admin unassign and retire routes', () => {
  it('unassigns a device and audits it against the previous owner', async () => {
    const admin = await createTestAdmin();
    const user = await createTestUser();
    await givePaidPayment(user.id);
    const device = await seedDevice();
    await allocateDevice(user.id, device.id);

    const response = await request(app())
      .post(`/api/v1/admin/devices/${device.id}/unassign`)
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', admin.cookie)
      .send({});

    expect(response.status).toBe(200);
    expect(response.body.device.status).toBe('UNASSIGNED');

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'device.unassigned', userId: user.id },
    });
    expect(audit?.metadata).toMatchObject({ unassignedByAdminId: admin.id });
  });

  it('refuses to retire an assigned device and audits the failure', async () => {
    const admin = await createTestAdmin();
    const user = await createTestUser();
    await givePaidPayment(user.id);
    const device = await seedDevice();
    await allocateDevice(user.id, device.id);

    const response = await request(app())
      .post(`/api/v1/admin/devices/${device.id}/retire`)
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', admin.cookie)
      .send({});

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('DEVICE_STILL_ASSIGNED');

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'device.retire.failed' },
    });
    expect(audit?.metadata).toMatchObject({ errorCode: 'DEVICE_STILL_ASSIGNED' });
  });

  it('retires a device once unassigned', async () => {
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
  it('puts users needing attention first', async () => {
    const admin = await createTestAdmin();

    const waiting = await createTestUser({ name: 'Waiting For Safe' });
    await givePaidPayment(waiting.id);

    const refunded = await createTestUser({ name: 'Refunded Holder' });
    const payment = await givePaidPayment(refunded.id);
    const device = await seedDevice();
    await allocateDevice(refunded.id, device.id);
    await prisma.payment.update({
      where: { id: payment.id },
      data: { status: 'REFUNDED' },
    });

    await createTestUser({ name: 'Nothing Doing' });

    const response = await request(app())
      .get('/api/v1/admin/users')
      .set('Cookie', admin.cookie);

    expect(response.status).toBe(200);
    const names = (response.body.items as Array<{ name: string }>).map((row) => row.name);

    // Refunded-but-holding first, then paid-but-unallocated.
    expect(names[0]).toBe('Refunded Holder');
    expect(names[1]).toBe('Waiting For Safe');

    const refundedRow = response.body.items[0];
    expect(refundedRow).toMatchObject({
      hasPaid: false,
      deviceSerial: device.serialNumber,
      refundedWithDevice: true,
    });
  });

  it('filters by paid and allocated', async () => {
    const admin = await createTestAdmin();

    const allocated = await createTestUser();
    await givePaidPayment(allocated.id);
    const device = await seedDevice();
    await allocateDevice(allocated.id, device.id);

    const waiting = await createTestUser();
    await givePaidPayment(waiting.id);

    await createTestUser();

    const paidUnallocated = await request(app())
      .get('/api/v1/admin/users?paid=true&allocated=false')
      .set('Cookie', admin.cookie);
    expect(paidUnallocated.body.total).toBe(1);
    expect(paidUnallocated.body.items[0].id).toBe(waiting.id);

    const unpaid = await request(app())
      .get('/api/v1/admin/users?paid=false')
      .set('Cookie', admin.cookie);
    // The unpaid user plus the admin account itself.
    expect(unpaid.body.total).toBe(2);
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

  it('returns only the agreed user fields', async () => {
    const admin = await createTestAdmin();
    await createTestUser();

    const response = await request(app())
      .get('/api/v1/admin/users')
      .set('Cookie', admin.cookie);

    for (const row of response.body.items as Array<Record<string, unknown>>) {
      expect(Object.keys(row).sort()).toEqual([
        'createdAt',
        'deviceSerial',
        'email',
        'hasPaid',
        'id',
        'name',
        'phone',
        'refundedWithDevice',
        'role',
      ]);
    }
  });
});

describe('GET /api/v1/admin/payments and /audit', () => {
  it('lists payments with the owning user and filters by status', async () => {
    const admin = await createTestAdmin();
    const user = await createTestUser();
    await givePaidPayment(user.id);

    const all = await request(app())
      .get('/api/v1/admin/payments')
      .set('Cookie', admin.cookie);
    expect(all.body.total).toBe(1);
    expect(all.body.items[0]).toMatchObject({
      status: 'PAID',
      user: { id: user.id },
    });

    const failed = await request(app())
      .get('/api/v1/admin/payments?status=FAILED')
      .set('Cookie', admin.cookie);
    expect(failed.body.total).toBe(0);
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

    // Build a rich dataset: a paid user with a device, a payment, audit rows,
    // a refresh token, and a device carrying a (hypothetical) credential.
    const user = await createTestUser();
    await givePaidPayment(user.id);
    const device = await seedDevice();
    await allocateDevice(user.id, device.id);

    await prisma.device.update({
      where: { id: device.id },
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

  it('exposes no password hash on the allocation response', async () => {
    const admin = await createTestAdmin();
    const user = await createTestUser();
    await givePaidPayment(user.id);
    const device = await seedDevice();

    const response = await request(app())
      .post(`/api/v1/admin/devices/${device.id}/allocate`)
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', admin.cookie)
      .send({ userId: user.id });

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
