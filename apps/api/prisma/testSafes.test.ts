import { describe, expect, it } from 'vitest';
import { serialNumberSchema } from '@safelock/shared';
import { prisma } from '../src/lib/prisma';
import { createTestUser, seedBooking } from '../src/test/helpers';
import {
  TEST_SAFE_PREFIX,
  TestSafeError,
  cleanupTestSafes,
  heartbeatTestSafes,
  seedTestSafes,
  testSafeRoster,
} from './testSafes';

/** The guard values a developer's machine actually has. */
const DEV = { nodeEnv: 'development', deviceGateway: 'mock' };

const countTestSafes = () =>
  prisma.device.count({ where: { serialNumber: { startsWith: TEST_SAFE_PREFIX } } });

describe('test safe roster', () => {
  it('is 12 small, 12 medium and 6 large', () => {
    const roster = testSafeRoster();

    expect(roster).toHaveLength(30);
    expect(roster.filter((row) => row.size === 'SMALL')).toHaveLength(12);
    expect(roster.filter((row) => row.size === 'MEDIUM')).toHaveLength(12);
    expect(roster.filter((row) => row.size === 'LARGE')).toHaveLength(6);
  });

  it('uses serials the admin create form would also accept', () => {
    // The seed writes through Prisma rather than the route, so nothing would
    // otherwise stop it inserting a serial no admin could have typed — and the
    // serial is the device's MQTT identity, not just a label.
    for (const { serialNumber } of testSafeRoster()) {
      expect(serialNumberSchema.safeParse(serialNumber).success).toBe(true);
    }
  });

  it('marks every serial as test data by prefix', () => {
    for (const { serialNumber } of testSafeRoster()) {
      expect(serialNumber.startsWith(TEST_SAFE_PREFIX)).toBe(true);
    }
  });
});

describe('seedTestSafes', () => {
  it('creates 30 bookable safes', async () => {
    const result = await seedTestSafes(DEV);

    expect(result.created).toBe(30);
    expect(result.refreshed).toBe(0);
    expect(result.total).toBe(30);
    expect(result.bySize).toEqual({ SMALL: 12, MEDIUM: 12, LARGE: 6 });

    // The three conditions the booking pick applies, all satisfied.
    const bookable = await prisma.device.count({
      where: {
        serialNumber: { startsWith: TEST_SAFE_PREFIX },
        status: 'AVAILABLE',
        online: true,
        doorState: { not: 'UNKNOWN' },
        lastSeenAt: { not: null },
      },
    });
    expect(bookable).toBe(30);
  });

  it('is idempotent — a second run creates nothing and errors on nothing', async () => {
    const first = await seedTestSafes(DEV);
    const second = await seedTestSafes(DEV);

    expect(first.created).toBe(30);
    expect(second.created).toBe(0);
    expect(second.refreshed).toBe(30);
    expect(second.total).toBe(30);
    expect(await countTestSafes()).toBe(30);
  });

  it('is idempotent across many runs', async () => {
    await seedTestSafes(DEV);
    await seedTestSafes(DEV);
    await seedTestSafes(DEV);

    expect(await countTestSafes()).toBe(30);
  });

  it('refills a row deleted by hand without disturbing the rest', async () => {
    await seedTestSafes(DEV);
    const victim = testSafeRoster()[0]!.serialNumber;
    await prisma.device.delete({ where: { serialNumber: victim } });

    const result = await seedTestSafes(DEV);

    expect(result.created).toBe(1);
    expect(result.refreshed).toBe(29);
    expect(await countTestSafes()).toBe(30);
  });

  it('advances liveness on a re-run, which is the point of re-running', async () => {
    const stale = new Date(Date.now() - 60 * 60 * 1000);
    await seedTestSafes({ ...DEV, now: stale });

    const before = await prisma.device.findFirstOrThrow({
      where: { serialNumber: { startsWith: TEST_SAFE_PREFIX } },
      select: { lastSeenAt: true },
    });
    expect(before.lastSeenAt?.getTime()).toBe(stale.getTime());

    const now = new Date();
    await seedTestSafes({ ...DEV, now });

    const after = await prisma.device.findFirstOrThrow({
      where: { serialNumber: { startsWith: TEST_SAFE_PREFIX } },
      select: { lastSeenAt: true, online: true },
    });
    expect(after.lastSeenAt?.getTime()).toBe(now.getTime());
    expect(after.online).toBe(true);
  });

  it('leaves a safe an admin put into NEEDS_INSPECTION where it is', async () => {
    await seedTestSafes(DEV);
    const serial = testSafeRoster()[0]!.serialNumber;
    await prisma.device.update({
      where: { serialNumber: serial },
      data: { status: 'NEEDS_INSPECTION', inspectionNote: 'contents unknown' },
    });

    await seedTestSafes(DEV);

    const device = await prisma.device.findUniqueOrThrow({
      where: { serialNumber: serial },
      select: { status: true, inspectionNote: true },
    });
    // A seed that healed this would be a seed that returns an uninspected safe
    // to the rental pool.
    expect(device.status).toBe('NEEDS_INSPECTION');
    expect(device.inspectionNote).toBe('contents unknown');
  });

  it('does not rewrite a bolt left unlocked', async () => {
    await seedTestSafes(DEV);
    const serial = testSafeRoster()[0]!.serialNumber;
    await prisma.device.update({
      where: { serialNumber: serial },
      data: { lockState: 'UNLOCKED' },
    });

    await seedTestSafes(DEV);

    const device = await prisma.device.findUniqueOrThrow({
      where: { serialNumber: serial },
      select: { lockState: true },
    });
    expect(device.lockState).toBe('UNLOCKED');
  });

  it('keeps a size an admin reclassified by hand', async () => {
    await seedTestSafes(DEV);
    const serial = testSafeRoster()[0]!.serialNumber; // SMALL by plan
    await prisma.device.update({
      where: { serialNumber: serial },
      data: { size: 'LARGE' },
    });

    await seedTestSafes(DEV);

    const device = await prisma.device.findUniqueOrThrow({
      where: { serialNumber: serial },
      select: { size: true },
    });
    expect(device.size).toBe('LARGE');
  });

  it('refuses when NODE_ENV=production, and writes nothing', async () => {
    await expect(
      seedTestSafes({ nodeEnv: 'production', deviceGateway: 'mock' }),
    ).rejects.toThrow(TestSafeError);

    expect(await countTestSafes()).toBe(0);
  });

  it('says why it refused in production', async () => {
    await expect(
      seedTestSafes({ nodeEnv: 'production', deviceGateway: 'mock' }),
    ).rejects.toThrow(/NODE_ENV=production/);
  });

  it('has no override flag for production, unlike the admin seed', async () => {
    // seedAdmin takes SEED_ALLOW_PRODUCTION. This deliberately does not: a
    // privileged account is sometimes needed in production, fake inventory
    // never is.
    await expect(
      seedTestSafes({
        nodeEnv: 'production',
        deviceGateway: 'mock',
        // @ts-expect-error — asserting the input type has no such escape hatch.
        allowProduction: 'true',
      }),
    ).rejects.toThrow(TestSafeError);

    expect(await countTestSafes()).toBe(0);
  });

  it('refuses on a gateway other than mock, and writes nothing', async () => {
    await expect(
      seedTestSafes({ nodeEnv: 'development', deviceGateway: 'mqtt' }),
    ).rejects.toThrow(/DEVICE_GATEWAY=mqtt/);

    expect(await countTestSafes()).toBe(0);
  });

  it('refuses when the gateway is unset rather than assuming mock', async () => {
    await expect(
      seedTestSafes({ nodeEnv: 'development', deviceGateway: undefined }),
    ).rejects.toThrow(TestSafeError);

    expect(await countTestSafes()).toBe(0);
  });
});

describe('heartbeatTestSafes', () => {
  it('brings a fleet that went stale back online', async () => {
    const stale = new Date(Date.now() - 60 * 60 * 1000);
    await seedTestSafes({ ...DEV, now: stale });

    const now = new Date();
    const touched = await heartbeatTestSafes(now);

    expect(touched).toBe(30);
    const fresh = await prisma.device.count({
      where: { serialNumber: { startsWith: TEST_SAFE_PREFIX }, lastSeenAt: now },
    });
    expect(fresh).toBe(30);
  });

  it('skips retired safes and leaves real inventory alone', async () => {
    await seedTestSafes(DEV);
    const serial = testSafeRoster()[0]!.serialNumber;
    await prisma.device.update({
      where: { serialNumber: serial },
      data: { status: 'RETIRED', online: false, lastSeenAt: null },
    });

    // A real serial, with no prefix, deliberately left offline.
    await prisma.device.create({
      data: { serialNumber: 'SAFE-0001', size: 'MEDIUM', online: false },
    });

    const touched = await heartbeatTestSafes();

    expect(touched).toBe(29);
    const retired = await prisma.device.findUniqueOrThrow({
      where: { serialNumber: serial },
      select: { online: true, lastSeenAt: true },
    });
    expect(retired.online).toBe(false);
    expect(retired.lastSeenAt).toBeNull();

    const real = await prisma.device.findUniqueOrThrow({
      where: { serialNumber: 'SAFE-0001' },
      select: { online: true, lastSeenAt: true },
    });
    expect(real.online).toBe(false);
    expect(real.lastSeenAt).toBeNull();
  });
});

describe('cleanupTestSafes', () => {
  it('deletes safes nobody has ever booked', async () => {
    await seedTestSafes(DEV);

    const result = await cleanupTestSafes(DEV);

    expect(result.deleted).toBe(30);
    expect(result.retired).toBe(0);
    expect(await countTestSafes()).toBe(0);
  });

  it('retires rather than deletes a safe with a booking, because the booking must survive', async () => {
    await seedTestSafes(DEV);
    const user = await createTestUser();
    const serial = testSafeRoster()[0]!.serialNumber;
    const device = await prisma.device.findUniqueOrThrow({
      where: { serialNumber: serial },
      select: { id: true },
    });
    const booking = await seedBooking({
      userId: user.id,
      deviceId: device.id,
      status: 'COMPLETED',
      safeSize: 'SMALL',
    });

    const result = await cleanupTestSafes(DEV);

    expect(result.deleted).toBe(29);
    expect(result.retired).toBe(1);
    expect(result.liveBookings).toEqual([]);

    const kept = await prisma.device.findUniqueOrThrow({
      where: { serialNumber: serial },
      select: { status: true, online: true, credentialHash: true, credentialIssuedAt: true },
    });
    expect(kept.status).toBe('RETIRED');
    expect(kept.online).toBe(false);
    // Retirement revokes the credential here exactly as it does in the admin flow.
    expect(kept.credentialHash).toBeNull();
    expect(kept.credentialIssuedAt).toBeNull();

    // The contract record is intact. This is what `onDelete: Restrict` protects.
    expect(await prisma.booking.findUnique({ where: { id: booking.id } })).not.toBeNull();
  });

  it('names a safe it retired out from under a live booking', async () => {
    await seedTestSafes(DEV);
    const user = await createTestUser();
    const serial = testSafeRoster()[0]!.serialNumber;
    const device = await prisma.device.findUniqueOrThrow({
      where: { serialNumber: serial },
      select: { id: true },
    });
    await seedBooking({
      userId: user.id,
      deviceId: device.id,
      status: 'ACTIVE',
      safeSize: 'SMALL',
    });

    const result = await cleanupTestSafes(DEV);

    expect(result.retired).toBe(1);
    expect(result.liveBookings).toEqual([serial]);
  });

  it('is idempotent — a second run has nothing left to do', async () => {
    await seedTestSafes(DEV);
    const user = await createTestUser();
    const device = await prisma.device.findFirstOrThrow({
      where: { serialNumber: { startsWith: TEST_SAFE_PREFIX } },
      select: { id: true },
    });
    await seedBooking({
      userId: user.id,
      deviceId: device.id,
      status: 'COMPLETED',
      safeSize: 'SMALL',
    });

    const first = await cleanupTestSafes(DEV);
    const second = await cleanupTestSafes(DEV);

    expect(first.deleted).toBe(29);
    expect(first.retired).toBe(1);
    expect(second.deleted).toBe(0);
    expect(second.retired).toBe(0);
    expect(second.untouched).toBe(1);
  });

  it('runs on an empty database without erroring', async () => {
    const result = await cleanupTestSafes(DEV);

    expect(result).toEqual({ deleted: 0, retired: 0, liveBookings: [], untouched: 0 });
  });

  it('never touches a device whose serial lacks the prefix', async () => {
    await seedTestSafes(DEV);
    await prisma.device.create({
      data: { serialNumber: 'SAFE-0001', size: 'LARGE', online: true, doorState: 'CLOSED' },
    });

    await cleanupTestSafes(DEV);

    const real = await prisma.device.findUniqueOrThrow({
      where: { serialNumber: 'SAFE-0001' },
      select: { status: true, online: true },
    });
    expect(real.status).toBe('AVAILABLE');
    expect(real.online).toBe(true);
    expect(await countTestSafes()).toBe(0);
  });

  it('removes the device events and commands of a safe that never existed', async () => {
    await seedTestSafes(DEV);
    const user = await createTestUser();
    const device = await prisma.device.findFirstOrThrow({
      where: { serialNumber: { startsWith: TEST_SAFE_PREFIX } },
      select: { id: true },
    });
    await prisma.deviceEvent.create({
      data: { deviceId: device.id, userId: user.id, type: 'LOCK', source: 'WEB' },
    });
    await prisma.command.create({
      data: {
        deviceId: device.id,
        type: 'LOCK',
        seq: 1,
        expiresAt: new Date(Date.now() + 15_000),
        systemActor: 'SWEEPER',
      },
    });

    await cleanupTestSafes(DEV);

    expect(await prisma.deviceEvent.count()).toBe(0);
    expect(await prisma.command.count()).toBe(0);
  });

  it('refuses in production, and deletes nothing', async () => {
    await seedTestSafes(DEV);

    await expect(
      cleanupTestSafes({ nodeEnv: 'production', deviceGateway: 'mock' }),
    ).rejects.toThrow(/NODE_ENV=production/);

    expect(await countTestSafes()).toBe(30);
  });

  it('refuses on a gateway other than mock, and deletes nothing', async () => {
    await seedTestSafes(DEV);

    await expect(
      cleanupTestSafes({ nodeEnv: 'development', deviceGateway: 'mqtt' }),
    ).rejects.toThrow(TestSafeError);

    expect(await countTestSafes()).toBe(30);
  });
});
