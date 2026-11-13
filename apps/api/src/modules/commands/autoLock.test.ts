import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { AUTO_LOCK_AFTER_MINUTES } from '@safelock/shared';
import { prisma } from '../../lib/prisma';
import { drainDeviceAcks } from '../../lib/deviceGateway';
import {
  TEST_ORIGIN,
  app,
  createUserWithDevice,
  withCapturedOtp,
} from '../../test/helpers';
import { sweepAutoLocks } from './autoLock.service';

/**
 * Auto-lock: a safe left unlocked past AUTO_LOCK_AFTER_MINUTES is locked by
 * the server, and the renter's activity feed says so.
 *
 * Every test unlocks through the real OTP flow and the mock gateway, then
 * moves the unlock's ack into the past rather than waiting minutes.
 */

const TIMEOUT_MS = AUTO_LOCK_AFTER_MINUTES * 60_000;

function post(url: string, cookie: string) {
  return request(app()).post(url).set('Origin', TEST_ORIGIN).set('Cookie', cookie);
}

/** Unlocks the user's safe for real, and returns the acked command's id. */
async function unlock(cookie: string): Promise<string> {
  const { result, code } = await withCapturedOtp(() =>
    post('/api/v1/devices/unlock/request', cookie).send({}),
  );
  expect(result.status).toBe(200);

  const confirm = await post('/api/v1/devices/unlock/confirm', cookie).send({ otp: code });
  expect(confirm.status).toBe(202);
  await drainDeviceAcks();

  const command = await prisma.command.findUniqueOrThrow({
    where: { id: confirm.body.commandId as string },
  });
  expect(command.status).toBe('ACKED');
  return command.id;
}

/** Pretends the unlock was acked `msAgo` ago. */
async function ageUnlock(commandId: string, msAgo: number): Promise<void> {
  const at = new Date(Date.now() - msAgo);
  await prisma.command.update({
    where: { id: commandId },
    data: { issuedAt: at, ackedAt: at },
  });
}

describe('auto-lock', () => {
  it('locks a safe left open past the timeout and records it in the feed', async () => {
    const held = await createUserWithDevice();
    const unlockId = await unlock(held.user.cookie);
    await ageUnlock(unlockId, TIMEOUT_MS + 1_000);

    expect(await sweepAutoLocks()).toBe(1);
    await drainDeviceAcks();

    const lock = await prisma.command.findFirstOrThrow({
      where: { deviceId: held.deviceId, type: 'LOCK' },
    });
    expect(lock.systemActor).toBe('AUTO_LOCK');
    expect(lock.userId).toBeNull();
    expect(lock.bookingId).toBe(held.bookingId);
    expect(lock.status).toBe('ACKED');

    const device = await prisma.device.findUniqueOrThrow({ where: { id: held.deviceId } });
    expect(device.lockState).toBe('LOCKED');

    const event = await prisma.deviceEvent.findFirstOrThrow({ where: { type: 'AUTO_LOCK' } });
    expect(event.userId).toBe(held.user.id);
    expect(event.source).toBe('SYSTEM');

    const audit = await prisma.auditLog.findFirst({ where: { action: 'device.auto_lock.issued' } });
    expect(audit).not.toBeNull();

    // The feed shows it with its label.
    const history = await request(app())
      .get('/api/v1/devices/history')
      .set('Cookie', held.user.cookie);
    expect(history.body.items[0]).toMatchObject({ type: 'AUTO_LOCK', label: 'Safe auto-locked' });
  });

  it('does nothing before the timeout, and says when it will', async () => {
    const held = await createUserWithDevice();
    const unlockId = await unlock(held.user.cookie);
    await ageUnlock(unlockId, TIMEOUT_MS - 30_000);

    expect(await sweepAutoLocks()).toBe(0);

    const mine = await request(app()).get('/api/v1/devices/mine').set('Cookie', held.user.cookie);
    expect(mine.body.device.lockState).toBe('UNLOCKED');
    const dueIn = new Date(mine.body.device.autoLockAt as string).getTime() - Date.now();
    expect(dueIn).toBeGreaterThan(0);
    expect(dueIn).toBeLessThanOrEqual(30_000);
  });

  it('does not run again once a lock has been issued after the unlock', async () => {
    const held = await createUserWithDevice();
    const unlockId = await unlock(held.user.cookie);
    await ageUnlock(unlockId, TIMEOUT_MS + 1_000);

    expect(await sweepAutoLocks()).toBe(1);
    await drainDeviceAcks();
    expect(await sweepAutoLocks()).toBe(0);

    expect(await prisma.command.count({ where: { type: 'LOCK' } })).toBe(1);
  });

  it('leaves a safe whose door is reported open', async () => {
    const held = await createUserWithDevice();
    const unlockId = await unlock(held.user.cookie);
    await ageUnlock(unlockId, TIMEOUT_MS + 1_000);
    await prisma.device.update({ where: { id: held.deviceId }, data: { doorState: 'OPEN' } });

    expect(await sweepAutoLocks()).toBe(0);

    const mine = await request(app()).get('/api/v1/devices/mine').set('Cookie', held.user.cookie);
    expect(mine.body.device.autoLockAt).toBeNull();
  });

  it('leaves a safe that was not opened by a command of ours', async () => {
    const held = await createUserWithDevice();
    // Opened with the physical key: no acked UNLOCK exists.
    await prisma.device.update({ where: { id: held.deviceId }, data: { lockState: 'UNLOCKED' } });

    expect(await sweepAutoLocks()).toBe(0);
  });

  it('leaves the reconciler to handle a safe whose booking has ended', async () => {
    const held = await createUserWithDevice();
    const unlockId = await unlock(held.user.cookie);
    await ageUnlock(unlockId, TIMEOUT_MS + 1_000);
    await prisma.booking.update({
      where: { id: held.bookingId },
      data: { status: 'COMPLETED', completedAt: new Date(), completionReason: 'COLLECTED' },
    });

    expect(await sweepAutoLocks()).toBe(0);
  });
});
