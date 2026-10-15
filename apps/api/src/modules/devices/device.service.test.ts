import { describe, expect, it } from 'vitest';
import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { HttpError } from '../../lib/httpError';
import { createTestUser, givePaidPayment, seedDevice, seedDevices } from '../../test/helpers';
import {
  allocateDevice,
  bulkCreateDevices,
  createDevice,
  getDeviceForUser,
  retireDevice,
  unassignDevice,
} from './device.service';

/** Asserts a rejection carries a specific error code from our envelope. */
async function expectCode(promise: Promise<unknown>, code: string): Promise<HttpError> {
  try {
    await promise;
    throw new Error(`Expected rejection with code ${code}, but it resolved`);
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    expect(error.code).toBe(code);
    return error;
  }
}

describe('allocateDevice', () => {
  it('allocates to a paid user and records the allocation', async () => {
    const user = await createTestUser();
    await givePaidPayment(user.id);
    const device = await seedDevice();

    const result = await allocateDevice(user.id, device.id);

    expect(result.device).toMatchObject({
      id: device.id,
      serialNumber: device.serialNumber,
      status: 'ASSIGNED',
      owner: { id: user.id },
    });
    expect(result.device.allocatedAt).not.toBeNull();

    const row = await prisma.device.findUnique({ where: { id: device.id } });
    expect(row?.ownerId).toBe(user.id);
    expect(row?.status).toBe('ASSIGNED');
    // No hardware credential is written at this stage.
    expect(row?.credentialHash).toBeNull();
  });

  it('refuses a user with no verified payment', async () => {
    const user = await createTestUser();
    const device = await seedDevice();

    await expectCode(allocateDevice(user.id, device.id), 'NOT_PAID');

    const row = await prisma.device.findUnique({ where: { id: device.id } });
    expect(row?.status).toBe('UNASSIGNED');
    expect(row?.ownerId).toBeNull();
  });

  it('refuses a user whose payment is only CREATED', async () => {
    const user = await createTestUser();
    await prisma.payment.create({
      data: {
        userId: user.id,
        razorpayOrderId: 'order_TESTunpaidalloc',
        amount: env.SAFE_PRICE_PAISE,
        status: 'CREATED',
      },
    });
    const device = await seedDevice();

    await expectCode(allocateDevice(user.id, device.id), 'NOT_PAID');
  });

  it('refuses a user whose payment was refunded', async () => {
    const user = await createTestUser();
    await prisma.payment.create({
      data: {
        userId: user.id,
        razorpayOrderId: 'order_TESTrefundalloc',
        razorpayPaymentId: 'pay_TESTrefundalloc',
        amount: env.SAFE_PRICE_PAISE,
        status: 'REFUNDED',
        paidAt: new Date(),
      },
    });
    const device = await seedDevice();

    await expectCode(allocateDevice(user.id, device.id), 'NOT_PAID');
  });

  it('refuses a second device for the same user', async () => {
    const user = await createTestUser();
    await givePaidPayment(user.id);
    const [first, second] = await seedDevices(2);

    await allocateDevice(user.id, first!.id);
    await expectCode(allocateDevice(user.id, second!.id), 'ALREADY_HAS_DEVICE');

    const row = await prisma.device.findUnique({ where: { id: second!.id } });
    expect(row?.status).toBe('UNASSIGNED');
  });

  it('refuses a device that is already assigned to someone else', async () => {
    const owner = await createTestUser();
    const other = await createTestUser();
    await givePaidPayment(owner.id);
    await givePaidPayment(other.id);
    const device = await seedDevice();

    await allocateDevice(owner.id, device.id);
    await expectCode(allocateDevice(other.id, device.id), 'DEVICE_NOT_AVAILABLE');

    const row = await prisma.device.findUnique({ where: { id: device.id } });
    expect(row?.ownerId).toBe(owner.id);
  });

  it('refuses a retired device', async () => {
    const user = await createTestUser();
    await givePaidPayment(user.id);
    const device = await seedDevice();
    await retireDevice(device.id);

    await expectCode(allocateDevice(user.id, device.id), 'DEVICE_NOT_AVAILABLE');
  });

  it('returns USER_NOT_FOUND for an unknown userId rather than a database error', async () => {
    const device = await seedDevice();

    const error = await expectCode(
      allocateDevice('usr_does_not_exist', device.id),
      'USER_NOT_FOUND',
    );
    expect(error.status).toBe(404);

    const row = await prisma.device.findUnique({ where: { id: device.id } });
    expect(row?.status).toBe('UNASSIGNED');
  });

  it('404s for an unknown deviceId', async () => {
    const user = await createTestUser();
    await givePaidPayment(user.id);

    await expectCode(allocateDevice(user.id, 'dev_does_not_exist'), 'NOT_FOUND');
  });
});

describe('allocateDevice — next available', () => {
  it('picks the oldest unassigned device when no id is given', async () => {
    const user = await createTestUser();
    await givePaidPayment(user.id);
    const [oldest] = await seedDevices(3);

    const result = await allocateDevice(user.id);

    expect(result.device.id).toBe(oldest!.id);
  });

  it('skips assigned devices and takes the next oldest', async () => {
    const first = await createTestUser();
    const second = await createTestUser();
    await givePaidPayment(first.id);
    await givePaidPayment(second.id);
    const [oldest, next] = await seedDevices(2);

    await allocateDevice(first.id);
    const result = await allocateDevice(second.id);

    expect(oldest!.id).not.toBe(result.device.id);
    expect(result.device.id).toBe(next!.id);
  });

  it('returns NO_DEVICES_IN_STOCK when the inventory is empty', async () => {
    const user = await createTestUser();
    await givePaidPayment(user.id);

    await expectCode(allocateDevice(user.id), 'NO_DEVICES_IN_STOCK');
  });

  it('returns NO_DEVICES_IN_STOCK when every device is assigned or retired', async () => {
    const holder = await createTestUser();
    const waiting = await createTestUser();
    await givePaidPayment(holder.id);
    await givePaidPayment(waiting.id);

    const [assigned, retired] = await seedDevices(2);
    await allocateDevice(holder.id, assigned!.id);
    await retireDevice(retired!.id);

    await expectCode(allocateDevice(waiting.id), 'NO_DEVICES_IN_STOCK');
  });
});

describe('unassignDevice', () => {
  it('returns the device to stock and clears the owner', async () => {
    const user = await createTestUser();
    await givePaidPayment(user.id);
    const device = await seedDevice();
    await allocateDevice(user.id, device.id);

    const result = await unassignDevice(device.id);

    expect(result.previousOwnerId).toBe(user.id);
    expect(result.device.status).toBe('UNASSIGNED');
    expect(result.device.owner).toBeNull();

    const row = await prisma.device.findUnique({ where: { id: device.id } });
    expect(row?.ownerId).toBeNull();
    expect(row?.allocatedAt).toBeNull();
    // We no longer know the state of a safe nobody owns.
    expect(row?.lockState).toBe('UNKNOWN');

    // And the user can be allocated a fresh device afterwards.
    const replacement = await seedDevice();
    await expect(allocateDevice(user.id, replacement.id)).resolves.toBeDefined();
  });

  it('refuses to unassign a device nobody holds', async () => {
    const device = await seedDevice();

    await expectCode(unassignDevice(device.id), 'DEVICE_NOT_AVAILABLE');
  });

  it('404s for an unknown device', async () => {
    await expectCode(unassignDevice('dev_nope'), 'NOT_FOUND');
  });

  it('frees a device held by a refunded user', async () => {
    // The refunded-but-still-holding state: unassign is the way out of it.
    const user = await createTestUser();
    const payment = await givePaidPayment(user.id);
    const device = await seedDevice();
    await allocateDevice(user.id, device.id);

    await prisma.payment.update({
      where: { id: payment.id },
      data: { status: 'REFUNDED' },
    });

    const result = await unassignDevice(device.id);
    expect(result.device.status).toBe('UNASSIGNED');
  });
});

describe('retireDevice', () => {
  it('retires an unassigned device', async () => {
    const device = await seedDevice();

    const result = await retireDevice(device.id);

    expect(result.device.status).toBe('RETIRED');
    const row = await prisma.device.findUnique({ where: { id: device.id } });
    expect(row?.status).toBe('RETIRED');
    expect(row?.online).toBe(false);
  });

  it('refuses to retire an assigned device — unassign first', async () => {
    const user = await createTestUser();
    await givePaidPayment(user.id);
    const device = await seedDevice();
    await allocateDevice(user.id, device.id);

    const error = await expectCode(retireDevice(device.id), 'DEVICE_STILL_ASSIGNED');
    expect(error.status).toBe(409);

    // Still assigned: the user has not silently lost their safe.
    const row = await prisma.device.findUnique({ where: { id: device.id } });
    expect(row?.status).toBe('ASSIGNED');
    expect(row?.ownerId).toBe(user.id);

    // Unassigning first makes retirement possible.
    await unassignDevice(device.id);
    await expect(retireDevice(device.id)).resolves.toBeDefined();
  });

  it('refuses to retire an already-retired device', async () => {
    const device = await seedDevice();
    await retireDevice(device.id);

    await expectCode(retireDevice(device.id), 'DEVICE_NOT_AVAILABLE');
  });
});

describe('createDevice', () => {
  it('creates a device with a normalised serial', async () => {
    const device = await createDevice('SAFE-ABCD');

    expect(device.serialNumber).toBe('SAFE-ABCD');
    expect(device.status).toBe('UNASSIGNED');
    expect(device.lockState).toBe('UNKNOWN');
    expect(device.online).toBe(false);
  });

  it('rejects a duplicate serial', async () => {
    await createDevice('SAFE-DUPE');

    await expectCode(createDevice('SAFE-DUPE'), 'DUPLICATE_SERIAL');
    expect(await prisma.device.count({ where: { serialNumber: 'SAFE-DUPE' } })).toBe(1);
  });
});

describe('bulkCreateDevices', () => {
  it('reports created, duplicate and invalid rows individually', async () => {
    await createDevice('SAFE-0001');

    const result = await bulkCreateDevices([
      'SAFE-0002', // created
      'SAFE-0001', // already in the inventory
      'nonsense', // invalid format
      'SAFE-0002', // repeated within this list
      '  safe-0003  ', // created, after normalisation
      '', // invalid
    ]);

    expect(result.created).toBe(2);
    expect(result.duplicates).toBe(2);
    expect(result.invalid).toBe(2);

    expect(result.results).toHaveLength(6);
    expect(result.results[0]).toMatchObject({ row: 1, serialNumber: 'SAFE-0002', status: 'created' });
    expect(result.results[1]).toMatchObject({ row: 2, serialNumber: 'SAFE-0001', status: 'duplicate' });
    expect(result.results[2]).toMatchObject({ row: 3, status: 'invalid' });
    expect(result.results[3]).toMatchObject({ row: 4, serialNumber: 'SAFE-0002', status: 'duplicate' });
    expect(result.results[4]).toMatchObject({ row: 5, serialNumber: 'SAFE-0003', status: 'created' });
    expect(result.results[5]).toMatchObject({ row: 6, status: 'invalid' });

    // Only the two valid, new serials were inserted.
    const serials = (
      await prisma.device.findMany({ select: { serialNumber: true }, orderBy: { serialNumber: 'asc' } })
    ).map((device) => device.serialNumber);
    expect(serials).toEqual(['SAFE-0001', 'SAFE-0002', 'SAFE-0003']);
  });

  it('normalises case and whitespace so one safe cannot become two devices', async () => {
    const result = await bulkCreateDevices(['safe-9999', 'SAFE-9999', ' Safe-9999 ']);

    expect(result.created).toBe(1);
    expect(result.duplicates).toBe(2);
    expect(await prisma.device.count({ where: { serialNumber: 'SAFE-9999' } })).toBe(1);
  });

  it('refuses more than 500 rows', async () => {
    const rows = Array.from({ length: 501 }, (_unused, index) =>
      `SAFE-${String(index).padStart(4, '0')}`,
    );

    const error = await expectCode(bulkCreateDevices(rows), 'VALIDATION_ERROR');
    expect(error.message).toMatch(/at most 500/);
    expect(await prisma.device.count()).toBe(0);
  });

  it('accepts exactly 500 rows', async () => {
    const rows = Array.from({ length: 500 }, (_unused, index) =>
      `SAFE-${String(index).padStart(5, '0')}`,
    );

    const result = await bulkCreateDevices(rows);
    expect(result.created).toBe(500);
  });
});

describe('getDeviceForUser', () => {
  it('returns null while the user is waiting for allocation', async () => {
    const user = await createTestUser();
    await givePaidPayment(user.id);

    expect(await getDeviceForUser(user.id)).toBeNull();
  });

  it("never returns another user's device", async () => {
    const owner = await createTestUser();
    const other = await createTestUser();
    await givePaidPayment(owner.id);
    const device = await seedDevice();
    await allocateDevice(owner.id, device.id);

    expect(await getDeviceForUser(owner.id)).toMatchObject({ id: device.id });
    expect(await getDeviceForUser(other.id)).toBeNull();
  });

  it('omits the reserved hardware credential field', async () => {
    const user = await createTestUser();
    await givePaidPayment(user.id);
    const device = await seedDevice();
    await allocateDevice(user.id, device.id);

    // Simulate the hardware phase having populated it.
    await prisma.device.update({
      where: { id: device.id },
      data: { credentialHash: 'super-secret-device-credential' },
    });

    const summary = await getDeviceForUser(user.id);

    expect(summary).not.toBeNull();
    expect(JSON.stringify(summary)).not.toContain('super-secret-device-credential');
    expect(Object.keys(summary!).sort()).toEqual([
      'allocatedAt',
      'id',
      'lastSeenAt',
      'lockState',
      'online',
      'serialNumber',
    ]);
  });
});
