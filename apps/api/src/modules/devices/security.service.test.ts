import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { TAMPER_ALERT_COOLDOWN_MINUTES } from '@safelock/shared';
import { prisma } from '../../lib/prisma';
import {
  TEST_ORIGIN,
  app,
  createTestAdmin,
  createUserWithDevice,
  seedDevice,
} from '../../test/helpers';
import { recordSecurityReading, tamperKindOf, type SecurityReadingInput } from './security.service';

function reading(
  serialNumber: string,
  overrides: Partial<SecurityReadingInput> = {},
): SecurityReadingInput {
  return {
    serialNumber,
    lockState: 'LOCKED',
    doorOpen: false,
    vibration: false,
    at: new Date(),
    ...overrides,
  };
}

describe('tamperKindOf', () => {
  it('only counts readings taken while locked, and a forced door outranks vibration', () => {
    expect(tamperKindOf(reading('S', { vibration: true }))).toBe('VIBRATION');
    expect(tamperKindOf(reading('S', { doorOpen: true, vibration: true }))).toBe('DOOR_FORCED');
    expect(
      tamperKindOf(reading('S', { lockState: 'UNLOCKED', doorOpen: true, vibration: true })),
    ).toBeNull();
    expect(tamperKindOf(reading('S', { doorOpen: null }))).toBeNull();
    expect(tamperKindOf(reading('S'))).toBeNull();
  });
});

describe('recordSecurityReading', () => {
  it("writes an event and a linked notification to the renter's feed", async () => {
    const held = await createUserWithDevice();

    expect(await recordSecurityReading(reading(held.serialNumber, { doorOpen: true }))).toBe(
      'DOOR_FORCED',
    );

    const event = await prisma.deviceEvent.findFirstOrThrow({ where: { type: 'DOOR_FORCED' } });
    expect(event).toMatchObject({ userId: held.user.id, source: 'SYSTEM' });

    const note = await prisma.notification.findFirstOrThrow({ where: { userId: held.user.id } });
    expect(note).toMatchObject({ type: 'TAMPER_DOOR_FORCED', deviceEventId: event.id });

    const device = await prisma.device.findUniqueOrThrow({ where: { id: held.deviceId } });
    expect(device.lastTamperKind).toBe('DOOR_FORCED');

    const mine = await request(app()).get('/api/v1/devices/mine').set('Cookie', held.user.cookie);
    expect(mine.body.device.security.lastTamperKind).toBe('DOOR_FORCED');
  });

  it('treats continuous tampering as one incident, and alerts again after a quiet spell', async () => {
    const held = await createUserWithDevice();
    const start = Date.now() - 60 * 60_000;

    await recordSecurityReading(
      reading(held.serialNumber, { vibration: true, at: new Date(start) }),
    );
    await recordSecurityReading(
      reading(held.serialNumber, { vibration: true, at: new Date(start + 3_000) }),
    );
    expect(await prisma.notification.count()).toBe(1);

    await recordSecurityReading(
      reading(held.serialNumber, {
        vibration: true,
        at: new Date(start + 3_000 + TAMPER_ALERT_COOLDOWN_MINUTES * 60_000 + 1_000),
      }),
    );
    expect(await prisma.notification.count()).toBe(2);
  });

  it('flags an unrented safe for admins without notifying anyone', async () => {
    const admin = await createTestAdmin();
    const device = await seedDevice();

    await recordSecurityReading(reading(device.serialNumber, { vibration: true }));

    expect(await prisma.notification.count()).toBe(0);
    expect(await prisma.deviceEvent.count()).toBe(0);
    const audit = await prisma.auditLog.findFirst({ where: { action: 'device.tamper.detected' } });
    expect(audit).not.toBeNull();

    const list = await request(app()).get('/api/v1/admin/devices').set('Cookie', admin.cookie);
    const row = list.body.items.find((d: { id: string }) => d.id === device.id);
    expect(row.flags).toContain('TAMPER_DETECTED');
    expect(row.simulatable).toBe(false);
  });

  it('ignores the renter opening their own unlocked safe', async () => {
    const held = await createUserWithDevice();
    await recordSecurityReading(
      reading(held.serialNumber, { lockState: 'UNLOCKED', doorOpen: true, vibration: true }),
    );
    expect(await prisma.notification.count()).toBe(0);
  });
});

describe('POST /admin/devices/:id/simulate', () => {
  it('is refused for a safe that is not the simulated board', async () => {
    const admin = await createTestAdmin();
    const device = await seedDevice();

    const res = await request(app())
      .post(`/api/v1/admin/devices/${device.id}/simulate`)
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', admin.cookie)
      .send({ scenario: 'VIBRATION' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SIMULATION_UNAVAILABLE');
  });

  it('validates the scenario', async () => {
    const admin = await createTestAdmin();
    const device = await seedDevice();

    const res = await request(app())
      .post(`/api/v1/admin/devices/${device.id}/simulate`)
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', admin.cookie)
      .send({ scenario: 'EXPLODE' });

    expect(res.status).toBe(400);
  });
});
