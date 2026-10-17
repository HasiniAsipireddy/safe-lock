import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '../../lib/prisma';
import {
  app,
  createTestUser,
  createUserWithDevice,
  seedBooking,
  seedDevice,
} from '../../test/helpers';

const MINE_URL = '/api/v1/devices/mine';

describe('GET /api/v1/devices/mine', () => {
  it('requires authentication', async () => {
    const response = await request(app()).get(MINE_URL);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });

  /**
   * No eligibility gate — `requirePaid` is gone with the purchase model.
   *
   * A user with no booking is not an error state: they are a user who has not
   * booked yet, and the honest answer is null. The dashboard asks
   * `GET /bookings/current` to find out what to offer them.
   */
  it('returns null for a user with no booking, not an error', async () => {
    const user = await createTestUser();

    const response = await request(app()).get(MINE_URL).set('Cookie', user.cookie);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ device: null });
  });

  /**
   * A held safe is not yet an operable safe.
   *
   * `PENDING_PAYMENT` reserves the device, but showing it here would imply
   * controls that `assertCanOperate` would refuse — so this stays null until
   * the money lands.
   */
  it('returns null while a booking is still awaiting payment', async () => {
    const user = await createTestUser();
    const device = await seedDevice();
    await seedBooking({ userId: user.id, deviceId: device.id, status: 'PENDING_PAYMENT' });

    const response = await request(app()).get(MINE_URL).set('Cookie', user.cookie);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ device: null });
    expect(JSON.stringify(response.body)).not.toContain(device.serialNumber);
  });

  it('returns the safe held by an active booking', async () => {
    const { user, deviceId, serialNumber } = await createUserWithDevice();

    const response = await request(app()).get(MINE_URL).set('Cookie', user.cookie);

    expect(response.status).toBe(200);
    expect(response.body.device).toMatchObject({
      id: deviceId,
      serialNumber,
      lockState: 'LOCKED',
      online: false,
    });
  });

  /** An unpaid overstay still has the safe physically, so it still resolves. */
  it('returns the safe during an overstay', async () => {
    const { user, serialNumber, bookingId } = await createUserWithDevice();
    await prisma.booking.update({ where: { id: bookingId }, data: { status: 'OVERSTAY' } });

    const response = await request(app()).get(MINE_URL).set('Cookie', user.cookie);

    expect(response.status).toBe(200);
    expect(response.body.device).toMatchObject({ serialNumber });
  });

  it("never exposes another user's safe", async () => {
    const { serialNumber } = await createUserWithDevice();
    const other = await createTestUser();

    const response = await request(app()).get(MINE_URL).set('Cookie', other.cookie);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ device: null });
    expect(JSON.stringify(response.body)).not.toContain(serialNumber);
  });

  it('returns null once the booking has been completed', async () => {
    const { user, bookingId, serialNumber } = await createUserWithDevice();
    await prisma.booking.update({
      where: { id: bookingId },
      data: { status: 'COMPLETED', completedAt: new Date(), completionReason: 'COLLECTED' },
    });

    const response = await request(app()).get(MINE_URL).set('Cookie', user.cookie);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ device: null });
    expect(JSON.stringify(response.body)).not.toContain(serialNumber);
  });

  it('never exposes the reserved hardware credential', async () => {
    const { user, deviceId } = await createUserWithDevice();
    await prisma.device.update({
      where: { id: deviceId },
      data: { credentialHash: 'device-credential-must-not-leak' },
    });

    const response = await request(app()).get(MINE_URL).set('Cookie', user.cookie);

    const serialised = JSON.stringify(response.body);
    expect(serialised).not.toContain('device-credential-must-not-leak');
    expect(serialised).not.toContain('credentialHash');
  });
});

describe('GET /api/v1/auth/me', () => {
  /**
   * The two purchase flags are gone from the payload.
   *
   * Pinned as an assertion rather than just deleted: a client still reading
   * `hasPaid` would get `undefined` and silently treat every user as unpaid,
   * so the absence is the contract.
   */
  it('no longer carries hasPaid or deviceAllocated', async () => {
    const { user } = await createUserWithDevice();

    const response = await request(app()).get('/api/v1/auth/me').set('Cookie', user.cookie);

    expect(response.status).toBe(200);
    expect(response.body.user).not.toHaveProperty('hasPaid');
    expect(response.body.user).not.toHaveProperty('deviceAllocated');
    expect(response.body.user).toMatchObject({ id: user.id, phoneVerified: true });
  });

  it('never leaks a password hash', async () => {
    const user = await createTestUser();

    const response = await request(app()).get('/api/v1/auth/me').set('Cookie', user.cookie);

    expect(JSON.stringify(response.body)).not.toMatch(/argon2|passwordHash/i);
  });
});
