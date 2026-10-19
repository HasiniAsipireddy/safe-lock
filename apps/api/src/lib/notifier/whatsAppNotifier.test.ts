import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { OTP_MAX_ATTEMPTS } from '@safelock/shared';
import { prisma } from '../prisma';
import { drainDeviceAcks } from '../deviceGateway';
import { fakeWhatsAppClient } from '../whatsapp';
import { processPending } from '../outbox/outbox.service';
import {
  TEST_ORIGIN,
  app,
  createUserWithDevice,
  withCapturedOtp,
} from '../../test/helpers';
import { notifier } from './index';
import { CompositeNotifier } from './composite.notifier';
import { InAppNotifier } from './inApp.notifier';
import { WhatsAppNotifier } from './whatsApp.notifier';

/**
 * The WhatsApp notifier, and the asymmetry it introduces.
 *
 * Step 2 made a notifier failure roll the unlock back, deliberately: "the safe
 * opened and we never recorded it" is the worse failure. That is right for the
 * in-app row — one insert, same connection — and wrong for a third-party HTTP
 * API, which would mean a safe that refuses to open because WhatsApp is down.
 *
 * These tests pin both halves: the in-app record is still atomic and still
 * blocking, and the WhatsApp half cannot block anything because it only ever
 * writes a row.
 */

const REQUEST_URL = '/api/v1/devices/unlock/request';
const CONFIRM_URL = '/api/v1/devices/unlock/confirm';

const fake = fakeWhatsAppClient()!;

function post(url: string, cookie?: string) {
  const req = request(app()).post(url).set('Origin', TEST_ORIGIN);
  return cookie ? req.set('Cookie', cookie) : req;
}

async function getCode(cookie: string): Promise<string> {
  const { result, code } = await withCapturedOtp(() => post(REQUEST_URL, cookie).send({}));
  expect(result.status).toBe(200);
  return code;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the configured notifier', () => {
  it('is a composite of in-app and WhatsApp, in that order', () => {
    expect(notifier.name).toBe('composite(in-app+whatsapp)');
  });
});

describe('a confirmed unlock', () => {
  it('writes the in-app notification and queues a WhatsApp alert', async () => {
    const { user, deviceId } = await createUserWithDevice();
    fake.reset();
    const code = await getCode(user.cookie);

    const response = await post(CONFIRM_URL, user.cookie).send({ otp: code });
    expect(response.status).toBe(202);
    // Both halves are written by the ack handler now, in the transaction that
    // records what the bolt actually did.
    await drainDeviceAcks();

    const inApp = await prisma.notification.findMany({ where: { userId: user.id } });
    expect(inApp).toHaveLength(1);
    expect(inApp[0]!.type).toBe('UNLOCK_CONFIRMED');

    const queued = await prisma.outboundMessage.findMany({
      where: { userId: user.id, kind: 'UNLOCK_ALERT' },
    });
    expect(queued).toHaveLength(1);
    expect(queued[0]!.status).toBe('PENDING');
    expect(queued[0]!.deviceEventId).toBeTruthy();

    // Still nothing sent: the row was written inside the transaction, and the
    // worker has not run. Only the OTP went out, inline.
    expect(fake.sentWithTemplate('safelock_unlock_alert')).toHaveLength(0);

    await processPending();
    expect(fake.sentWithTemplate('safelock_unlock_alert')).toHaveLength(1);

    const event = await prisma.deviceEvent.findFirst({
      where: { deviceId, type: 'UNLOCK_CONFIRMED' },
    });
    expect(queued[0]!.deviceEventId).toBe(event!.id);
  });

  /**
   * The headline property of this commit. A WhatsApp outage must not stop a
   * safe from opening — the owner is standing in front of it.
   */
  it('opens the safe even when WhatsApp is completely down', async () => {
    const { user, deviceId } = await createUserWithDevice();
    fake.reset();
    const code = await getCode(user.cookie);
    // Dead for every send from here on, including the worker's.
    fake.failAlways('TRANSPORT');

    const response = await post(CONFIRM_URL, user.cookie).send({ otp: code });

    expect(response.status).toBe(202);
    await drainDeviceAcks();

    const device = await prisma.device.findUniqueOrThrow({ where: { id: deviceId } });
    expect(device.lockState).toBe('UNLOCKED');

    // The in-app record still exists, so the owner can still see it happened.
    expect(await prisma.notification.count({ where: { userId: user.id } })).toBe(1);

    // And the message is queued, to be retried later.
    await processPending();
    const queued = await prisma.outboundMessage.findFirstOrThrow({
      where: { userId: user.id, kind: 'UNLOCK_ALERT' },
    });
    expect(queued.status).toBe('PENDING');
    expect(queued.failureCategory).toBe('TRANSPORT');

    fake.recover();
  });

  it('queues the alert inside the transaction, so a rollback takes it too', async () => {
    const { user } = await createUserWithDevice();
    fake.reset();
    const code = await getCode(user.cookie);

    /**
     * Fail the in-app half. Both notifiers write through the event's
     * transaction, so neither half survives — the composite is still
     * all-or-nothing, which is what stops a WhatsApp alert existing about an
     * event that does not.
     *
     * What no longer happens is the unlock rolling back with it: the bolt had
     * already moved by the time this ran. See the ack handler on why the
     * physical record commits in its own transaction first.
     */
    vi.spyOn(InAppNotifier.prototype, 'notifyUnlock').mockRejectedValue(
      new Error('in-app unavailable'),
    );

    const response = await post(CONFIRM_URL, user.cookie).send({ otp: code });
    expect(response.status).toBe(202);
    await drainDeviceAcks();

    // Neither half survives, and nothing was sent.
    expect(await prisma.notification.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.outboundMessage.count({ where: { userId: user.id } })).toBe(0);
    expect(fake.sentWithTemplate('safelock_unlock_alert')).toHaveLength(0);
  });

  it('skips the WhatsApp alert for an unverified number but keeps the in-app one', async () => {
    const { user } = await createUserWithDevice();
    fake.reset();
    const code = await getCode(user.cookie);

    // Verified at code time (it had to be), then revoked before the alert is
    // processed — the shape of a user who changed their number mid-flow.
    await post(CONFIRM_URL, user.cookie).send({ otp: code });
    await drainDeviceAcks();
    await prisma.user.update({
      where: { id: user.id },
      data: { phoneVerifiedAt: null },
    });

    await processPending();

    expect(await prisma.notification.count({ where: { userId: user.id } })).toBe(1);
    const queued = await prisma.outboundMessage.findFirstOrThrow({
      where: { userId: user.id, kind: 'UNLOCK_ALERT' },
    });
    // SKIPPED, not FAILED, and never retried.
    expect(queued.status).toBe('SKIPPED');
    expect(queued.failureCategory).toBe('NO_VERIFIED_PHONE');
  });
});

describe('a burned challenge', () => {
  it('queues a failed-attempts alert, and only once the limit is spent', async () => {
    const { user } = await createUserWithDevice();
    fake.reset();
    await getCode(user.cookie);

    // One wrong code notifies nobody — a typo is the most ordinary thing an
    // owner does.
    await post(CONFIRM_URL, user.cookie).send({ otp: '000000' });
    expect(
      await prisma.outboundMessage.count({
        where: { userId: user.id, kind: 'FAILED_ATTEMPTS_ALERT' },
      }),
    ).toBe(0);

    for (let attempt = 1; attempt < OTP_MAX_ATTEMPTS; attempt += 1) {
      await post(CONFIRM_URL, user.cookie).send({ otp: '000000' });
    }

    const queued = await prisma.outboundMessage.findMany({
      where: { userId: user.id, kind: 'FAILED_ATTEMPTS_ALERT' },
    });
    expect(queued).toHaveLength(1);
    expect(queued[0]!.status).toBe('PENDING');

    await processPending();
    expect(fake.sentWithTemplate('safelock_failed_attempts')).toHaveLength(1);
  });
});

describe('CompositeNotifier', () => {
  it('runs every notifier it was given', async () => {
    const calls: string[] = [];
    const stub = (name: string) => ({
      name,
      notifyUnlock: async () => {
        calls.push(name);
      },
    });

    const composite = new CompositeNotifier([stub('one'), stub('two')]);
    await composite.notifyUnlock({} as never, {
      userId: 'usr_1',
      type: 'UNLOCK_CONFIRMED',
      deviceEventId: 'evt_1',
      serialNumber: 'SAFE-0001',
    });

    expect(calls).toEqual(['one', 'two']);
    expect(composite.name).toBe('composite(one+two)');
  });

  /**
   * No try/catch in the composite, on purpose: swallowing here would turn a
   * real database problem into a successful unlock with no record.
   */
  it('propagates a failure rather than swallowing it', async () => {
    const composite = new CompositeNotifier([
      { name: 'boom', notifyUnlock: async () => Promise.reject(new Error('boom')) },
    ]);

    await expect(
      composite.notifyUnlock({} as never, {
        userId: 'usr_1',
        type: 'UNLOCK_CONFIRMED',
        deviceEventId: 'evt_1',
        serialNumber: 'SAFE-0001',
      }),
    ).rejects.toThrow('boom');
  });

  it('stops at the first failure, so later channels are not half-applied', async () => {
    const later = vi.fn();
    const composite = new CompositeNotifier([
      { name: 'boom', notifyUnlock: async () => Promise.reject(new Error('boom')) },
      { name: 'later', notifyUnlock: later },
    ]);

    await expect(
      composite.notifyUnlock({} as never, {
        userId: 'usr_1',
        type: 'UNLOCK_CONFIRMED',
        deviceEventId: 'evt_1',
        serialNumber: 'SAFE-0001',
      }),
    ).rejects.toThrow('boom');

    expect(later).not.toHaveBeenCalled();
  });
});

describe('WhatsAppNotifier', () => {
  it('makes no network call — it only writes a row', async () => {
    const { user } = await createUserWithDevice();
    fake.reset();

    await prisma.$transaction((tx) =>
      new WhatsAppNotifier().notifyUnlock(tx, {
        userId: user.id,
        type: 'UNLOCK_CONFIRMED',
        deviceEventId: null as unknown as string,
        serialNumber: 'SAFE-0001',
      }),
    );

    expect(fake.sent()).toHaveLength(0);
    expect(await prisma.outboundMessage.count({ where: { userId: user.id } })).toBe(1);
  });

  it('maps each notification type to its template kind', async () => {
    const { user } = await createUserWithDevice();

    for (const [type, kind] of [
      ['UNLOCK_CONFIRMED', 'UNLOCK_ALERT'],
      ['UNLOCK_FAILED_MAX_ATTEMPTS', 'FAILED_ATTEMPTS_ALERT'],
    ] as const) {
      await prisma.$transaction((tx) =>
        new WhatsAppNotifier().notifyUnlock(tx, {
          userId: user.id,
          type,
          deviceEventId: null as unknown as string,
          serialNumber: 'SAFE-0001',
        }),
      );

      expect(
        await prisma.outboundMessage.count({ where: { userId: user.id, kind } }),
      ).toBe(1);
    }
  });
});
