import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '../../lib/prisma';
import { app, createTestUser, givePaidPayment, seedDevice } from '../../test/helpers';
import { allocateDevice } from './device.service';

const MINE_URL = '/api/v1/devices/mine';

describe('GET /api/v1/devices/mine', () => {
  it('requires authentication', async () => {
    const response = await request(app()).get(MINE_URL);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('requires a verified payment', async () => {
    const user = await createTestUser();

    const response = await request(app()).get(MINE_URL).set('Cookie', user.cookie);

    expect(response.status).toBe(402);
    expect(response.body.error.code).toBe('PAYMENT_REQUIRED');
  });

  it('returns null while the user waits for allocation', async () => {
    const user = await createTestUser();
    await givePaidPayment(user.id);

    const response = await request(app()).get(MINE_URL).set('Cookie', user.cookie);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ device: null });
  });

  it('returns the allocated device', async () => {
    const user = await createTestUser();
    await givePaidPayment(user.id);
    const device = await seedDevice();
    await allocateDevice(user.id, device.id);

    const response = await request(app()).get(MINE_URL).set('Cookie', user.cookie);

    expect(response.status).toBe(200);
    expect(response.body.device).toMatchObject({
      id: device.id,
      serialNumber: device.serialNumber,
      lockState: 'LOCKED',
      online: false,
    });
    expect(response.body.device.allocatedAt).not.toBeNull();
  });

  it("never exposes another user's device", async () => {
    const owner = await createTestUser();
    const other = await createTestUser();
    await givePaidPayment(owner.id);
    await givePaidPayment(other.id);
    const device = await seedDevice();
    await allocateDevice(owner.id, device.id);

    const response = await request(app()).get(MINE_URL).set('Cookie', other.cookie);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ device: null });
    expect(JSON.stringify(response.body)).not.toContain(device.serialNumber);
  });

  it('never exposes the reserved hardware credential', async () => {
    const user = await createTestUser();
    await givePaidPayment(user.id);
    const device = await seedDevice();
    await allocateDevice(user.id, device.id);
    await prisma.device.update({
      where: { id: device.id },
      data: { credentialHash: 'device-credential-must-not-leak' },
    });

    const response = await request(app()).get(MINE_URL).set('Cookie', user.cookie);

    const serialised = JSON.stringify(response.body);
    expect(serialised).not.toContain('device-credential-must-not-leak');
    expect(serialised).not.toContain('credentialHash');
  });

  it('still serves the device after a refund, so the UI can explain the state', async () => {
    // hasPaid goes false, so requirePaid blocks /devices/mine with a 402. The
    // dashboard relies on `deviceAllocated` from /auth/me for this state
    // rather than on this endpoint — asserted here so the behaviour is pinned.
    const user = await createTestUser();
    const payment = await givePaidPayment(user.id);
    const device = await seedDevice();
    await allocateDevice(user.id, device.id);

    await prisma.payment.update({
      where: { id: payment.id },
      data: { status: 'REFUNDED' },
    });

    const response = await request(app()).get(MINE_URL).set('Cookie', user.cookie);
    expect(response.status).toBe(402);
    expect(response.body.error.code).toBe('PAYMENT_REQUIRED');
  });
});

describe('GET /api/v1/auth/me — deviceAllocated', () => {
  it('is false before allocation and true after', async () => {
    const user = await createTestUser();
    await givePaidPayment(user.id);

    const before = await request(app()).get('/api/v1/auth/me').set('Cookie', user.cookie);
    expect(before.body.user).toMatchObject({ hasPaid: true, deviceAllocated: false });

    const device = await seedDevice();
    await allocateDevice(user.id, device.id);

    const after = await request(app()).get('/api/v1/auth/me').set('Cookie', user.cookie);
    expect(after.body.user).toMatchObject({ hasPaid: true, deviceAllocated: true });
  });

  it('reports hasPaid false with deviceAllocated true after a refund', async () => {
    const user = await createTestUser();
    const payment = await givePaidPayment(user.id);
    const device = await seedDevice();
    await allocateDevice(user.id, device.id);

    await prisma.payment.update({
      where: { id: payment.id },
      data: { status: 'REFUNDED' },
    });

    const response = await request(app()).get('/api/v1/auth/me').set('Cookie', user.cookie);

    // The combination the dashboard has an explicit state for.
    expect(response.body.user).toMatchObject({ hasPaid: false, deviceAllocated: true });
  });

  it('never leaks a password hash', async () => {
    const user = await createTestUser();

    const response = await request(app()).get('/api/v1/auth/me').set('Cookie', user.cookie);

    expect(JSON.stringify(response.body)).not.toMatch(/argon2|passwordHash/i);
  });
});
