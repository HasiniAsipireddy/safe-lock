import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '../../lib/prisma';
import {
  TEST_ORIGIN,
  app,
  createTestAdmin,
  createTestUser,
  seedBooking,
  seedDevice,
} from '../../test/helpers';

/**
 * Registering and reclassifying a cabinet's size.
 *
 * The size is what a safe is rented at, so these are money-adjacent writes:
 * required on create (no silent default), audited with both values on change,
 * and — the one that matters most — unable to touch a live booking.
 */

const DEVICES_URL = '/api/v1/admin/devices';

function post(url: string, cookie: string) {
  return request(app()).post(url).set('Origin', TEST_ORIGIN).set('Cookie', cookie);
}

function patch(url: string, cookie: string) {
  return request(app()).patch(url).set('Origin', TEST_ORIGIN).set('Cookie', cookie);
}

describe('POST /api/v1/admin/devices', () => {
  /**
   * No default on the request body, deliberately — unlike the column, whose
   * `MEDIUM` default exists only so the backfill of pre-existing rows had
   * somewhere to land. An admin registering stock knows which shelf they are
   * holding, and a silent default would price a large safe as a medium until
   * somebody noticed.
   */
  it('requires a size', async () => {
    const admin = await createTestAdmin();

    const response = await post(DEVICES_URL, admin.cookie).send({
      serialNumber: 'SAFE-NOSZ',
    });

    expect(response.status).toBe(400);
    expect(await prisma.device.count()).toBe(0);
  });

  it('rejects a size that is not one of the three', async () => {
    const admin = await createTestAdmin();

    const response = await post(DEVICES_URL, admin.cookie).send({
      serialNumber: 'SAFE-BADZ',
      size: 'HUGE',
    });

    expect(response.status).toBe(400);
    expect(await prisma.device.count()).toBe(0);
  });

  it.each(['SMALL', 'MEDIUM', 'LARGE'] as const)('stores %s and returns it', async (size) => {
    const admin = await createTestAdmin();

    const response = await post(DEVICES_URL, admin.cookie).send({
      serialNumber: `SAFE-${size.slice(0, 4)}`,
      size,
    });

    expect(response.status).toBe(201);
    expect(response.body.device.size).toBe(size);

    const stored = await prisma.device.findFirstOrThrow({ select: { size: true } });
    expect(stored.size).toBe(size);
  });

  it('records the size in the audit row', async () => {
    const admin = await createTestAdmin();

    await post(DEVICES_URL, admin.cookie).send({
      serialNumber: 'SAFE-AUDS',
      size: 'LARGE',
    });

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'device.created' },
      orderBy: { createdAt: 'desc' },
    });

    expect(audit?.metadata).toMatchObject({ serialNumber: 'SAFE-AUDS', size: 'LARGE' });
  });
});

describe('POST /api/v1/admin/devices/bulk', () => {
  it('applies one size to the whole batch', async () => {
    const admin = await createTestAdmin();

    const response = await post(`${DEVICES_URL}/bulk`, admin.cookie).send({
      serialNumbers: ['SAFE-B001', 'SAFE-B002'],
      size: 'SMALL',
    });

    expect(response.status).toBe(201);
    expect(response.body.created).toBe(2);

    const devices = await prisma.device.findMany({ select: { size: true } });
    expect(devices).toHaveLength(2);
    expect(devices.every((device) => device.size === 'SMALL')).toBe(true);
  });

  it('requires a size', async () => {
    const admin = await createTestAdmin();

    const response = await post(`${DEVICES_URL}/bulk`, admin.cookie).send({
      serialNumbers: ['SAFE-B003'],
    });

    expect(response.status).toBe(400);
    expect(await prisma.device.count()).toBe(0);
  });
});

describe('PATCH /api/v1/admin/devices/:id/size', () => {
  it('reclassifies a cabinet', async () => {
    const admin = await createTestAdmin();
    const device = await seedDevice({ size: 'MEDIUM' });

    const response = await patch(`${DEVICES_URL}/${device.id}/size`, admin.cookie).send({
      size: 'LARGE',
    });

    expect(response.status).toBe(200);
    expect(response.body.device.size).toBe('LARGE');

    const stored = await prisma.device.findUniqueOrThrow({
      where: { id: device.id },
      select: { size: true },
    });
    expect(stored.size).toBe('LARGE');
  });

  /** Both values, because "who made the large safes cheap" needs an answer. */
  it('audits the old size as well as the new one', async () => {
    const admin = await createTestAdmin();
    const device = await seedDevice({ size: 'SMALL' });

    await patch(`${DEVICES_URL}/${device.id}/size`, admin.cookie).send({ size: 'LARGE' });

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'device.size_changed' },
      orderBy: { createdAt: 'desc' },
    });

    expect(audit?.metadata).toMatchObject({
      from: 'SMALL',
      to: 'LARGE',
      serialNumber: device.serialNumber,
    });
  });

  /**
   * **The guarantee this whole feature rests on.** Correcting a mislabelled
   * shelf must not re-price a rental somebody is in the middle of, because the
   * booking snapshotted its own size and rate at creation.
   *
   * Which is also why this is permitted while the safe is occupied: the
   * alternative is an admin unable to fix a data-entry error for up to 24
   * hours, protecting nothing.
   */
  it('leaves a live booking’s snapshot untouched', async () => {
    const admin = await createTestAdmin();
    const user = await createTestUser();
    const device = await seedDevice({ size: 'SMALL' });

    const booking = await seedBooking({
      userId: user.id,
      deviceId: device.id,
      status: 'ACTIVE',
      safeSize: 'SMALL',
      hours: 2,
    });

    const before = await prisma.booking.findUniqueOrThrow({
      where: { id: booking.id },
      select: { safeSize: true, hourlyRatePaise: true, pricePaise: true },
    });

    const response = await patch(`${DEVICES_URL}/${device.id}/size`, admin.cookie).send({
      size: 'LARGE',
    });
    expect(response.status).toBe(200);

    const after = await prisma.booking.findUniqueOrThrow({
      where: { id: booking.id },
      select: { safeSize: true, hourlyRatePaise: true, pricePaise: true },
    });

    expect(after).toEqual(before);
    expect(after.safeSize).toBe('SMALL');
  });

  /**
   * A retired safe will never be booked again, so reclassifying one is a write
   * with no effect — and accepting it would let the inventory list imply
   * retired stock is being kept current.
   */
  it('refuses to reclassify a retired safe', async () => {
    const admin = await createTestAdmin();
    const device = await seedDevice({ size: 'MEDIUM' });
    await prisma.device.update({ where: { id: device.id }, data: { status: 'RETIRED' } });

    const response = await patch(`${DEVICES_URL}/${device.id}/size`, admin.cookie).send({
      size: 'LARGE',
    });

    expect(response.status).toBe(409);

    const stored = await prisma.device.findUniqueOrThrow({
      where: { id: device.id },
      select: { size: true },
    });
    expect(stored.size).toBe('MEDIUM');
  });

  it('404s for a device that does not exist', async () => {
    const admin = await createTestAdmin();

    const response = await patch(`${DEVICES_URL}/dev_nope/size`, admin.cookie).send({
      size: 'LARGE',
    });

    expect(response.status).toBe(404);
  });

  it('rejects an unknown size and a body carrying anything else', async () => {
    const admin = await createTestAdmin();
    const device = await seedDevice({ size: 'MEDIUM' });

    const bad = await patch(`${DEVICES_URL}/${device.id}/size`, admin.cookie).send({
      size: 'GIGANTIC',
    });
    expect(bad.status).toBe(400);

    // `.strict()`: a body also naming a price is a 400, never a silent ignore.
    const extra = await patch(`${DEVICES_URL}/${device.id}/size`, admin.cookie).send({
      size: 'LARGE',
      hourlyRatePaise: 1,
    });
    expect(extra.status).toBe(400);
  });

  it('refuses a non-admin', async () => {
    const user = await createTestUser();
    const device = await seedDevice({ size: 'MEDIUM' });

    const response = await patch(`${DEVICES_URL}/${device.id}/size`, user.cookie).send({
      size: 'LARGE',
    });

    expect(response.status).toBe(403);
  });
});
