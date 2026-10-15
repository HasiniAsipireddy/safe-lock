import { describe, expect, it } from 'vitest';
import { prisma } from '../../lib/prisma';
import { HttpError } from '../../lib/httpError';
import { createTestUser, givePaidPayment, seedDevices } from '../../test/helpers';
import { allocateDevice } from './device.service';

/**
 * Concurrency behaviour of `allocateDevice`.
 *
 * These run against real Postgres — the whole point is the row locking, which
 * a mock could not exercise. `Promise.all` fires the calls together so they
 * genuinely overlap inside the database.
 *
 * Two mechanisms are under test:
 *  - `SELECT … FOR UPDATE SKIP LOCKED` in the next-available pick, so two
 *    admins take different rows instead of fighting over one.
 *  - the `UNIQUE` constraint on `Device.ownerId`, as the backstop that makes a
 *    second device per user impossible even under a race.
 */

function codeOf(error: unknown): string {
  return error instanceof HttpError ? error.code : `unexpected:${String(error)}`;
}

describe('concurrent allocation', () => {
  it('never gives the same device to two different users', async () => {
    const first = await createTestUser();
    const second = await createTestUser();
    await givePaidPayment(first.id);
    await givePaidPayment(second.id);
    await seedDevices(2);

    const [a, b] = await Promise.all([allocateDevice(first.id), allocateDevice(second.id)]);

    // Both succeeded, with *different* devices.
    expect(a.device.id).not.toBe(b.device.id);
    expect(a.device.owner?.id).toBe(first.id);
    expect(b.device.owner?.id).toBe(second.id);

    const assigned = await prisma.device.findMany({
      where: { status: 'ASSIGNED' },
      select: { id: true, ownerId: true },
    });
    expect(assigned).toHaveLength(2);
    // Two distinct owners over two distinct devices.
    expect(new Set(assigned.map((device) => device.ownerId)).size).toBe(2);
    expect(new Set(assigned.map((device) => device.id)).size).toBe(2);
  });

  it('with one device and two users, exactly one wins and the other sees no stock', async () => {
    const first = await createTestUser();
    const second = await createTestUser();
    await givePaidPayment(first.id);
    await givePaidPayment(second.id);
    await seedDevices(1);

    const outcomes = await Promise.allSettled([
      allocateDevice(first.id),
      allocateDevice(second.id),
    ]);

    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // The loser gets a clean, actionable error — not a deadlock or a 500.
    expect(codeOf((rejected[0] as PromiseRejectedResult).reason)).toBe('NO_DEVICES_IN_STOCK');

    expect(await prisma.device.count({ where: { status: 'ASSIGNED' } })).toBe(1);
  });

  it('spreads ten simultaneous allocations across ten devices, one each', async () => {
    const users = await Promise.all(
      Array.from({ length: 10 }, () => createTestUser()),
    );
    await Promise.all(users.map((user) => givePaidPayment(user.id)));
    await seedDevices(10);

    const results = await Promise.all(users.map((user) => allocateDevice(user.id)));

    const deviceIds = results.map((result) => result.device.id);
    // No device handed out twice.
    expect(new Set(deviceIds).size).toBe(10);

    const assigned = await prisma.device.findMany({
      where: { status: 'ASSIGNED' },
      select: { ownerId: true },
    });
    expect(assigned).toHaveLength(10);
    expect(new Set(assigned.map((device) => device.ownerId)).size).toBe(10);
  });

  it('cannot give one user two devices, even from two simultaneous calls', async () => {
    const user = await createTestUser();
    await givePaidPayment(user.id);
    await seedDevices(2);

    const outcomes = await Promise.allSettled([
      allocateDevice(user.id),
      allocateDevice(user.id),
    ]);

    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);

    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    // Either the service check or the UNIQUE constraint caught it; both map to
    // the same client-facing code.
    expect(codeOf((rejected as PromiseRejectedResult).reason)).toBe('ALREADY_HAS_DEVICE');

    expect(await prisma.device.count({ where: { ownerId: user.id } })).toBe(1);
  });

  it('leaves no device half-allocated when a concurrent attempt fails', async () => {
    const paid = await createTestUser();
    const unpaid = await createTestUser();
    await givePaidPayment(paid.id);
    await seedDevices(1);

    const outcomes = await Promise.allSettled([
      allocateDevice(paid.id),
      // This one must fail on the payment check, and roll back cleanly.
      allocateDevice(unpaid.id),
    ]);

    expect(outcomes[0]?.status).toBe('fulfilled');
    expect(outcomes[1]?.status).toBe('rejected');
    expect(codeOf((outcomes[1] as PromiseRejectedResult).reason)).toBe('NOT_PAID');

    const devices = await prisma.device.findMany({
      select: { status: true, ownerId: true, allocatedAt: true },
    });
    expect(devices).toHaveLength(1);
    // Exactly one consistent outcome: assigned to the paid user.
    expect(devices[0]).toMatchObject({ status: 'ASSIGNED', ownerId: paid.id });
    expect(devices[0]?.allocatedAt).toBeInstanceOf(Date);
  });
});
