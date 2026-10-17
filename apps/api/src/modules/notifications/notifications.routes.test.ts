import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { OTP_MAX_ATTEMPTS } from '@safelock/shared';
import type {
  MarkNotificationsReadResponse,
  NotificationsResponse,
} from '@safelock/shared';
import { prisma } from '../../lib/prisma';
import { deviceGateway } from '../../lib/deviceGateway';
import { notifier } from '../../lib/notifier';
import {
  TEST_ORIGIN,
  app,
  createTestUser,
  createUserWithDevice,
  deviceHeldBy,
  seedNotification,
  withCapturedOtp,
} from '../../test/helpers';

const LIST_URL = '/api/v1/notifications';
const READ_URL = '/api/v1/notifications/read';
const REQUEST_URL = '/api/v1/devices/unlock/request';
const CONFIRM_URL = '/api/v1/devices/unlock/confirm';

function get(url: string, cookie?: string, instance = app()) {
  const req = request(instance).get(url);
  return cookie ? req.set('Cookie', cookie) : req;
}

function post(url: string, cookie?: string, instance = app()) {
  const req = request(instance).post(url).set('Origin', TEST_ORIGIN);
  return cookie ? req.set('Cookie', cookie) : req;
}

/** Requests a code through the real delivery path and returns it. */
async function getCode(cookie: string): Promise<string> {
  const { result, code } = await withCapturedOtp(() => post(REQUEST_URL, cookie).send({}));
  expect(result.status).toBe(200);
  return code;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// --- Written with the unlock, atomically -------------------------------------

describe('notifications on unlock', () => {
  it('creates exactly one notification when an unlock is confirmed', async () => {
    const { user, deviceId } = await createUserWithDevice();
    const code = await getCode(user.cookie);

    const response = await post(CONFIRM_URL, user.cookie).send({ otp: code });
    expect(response.status).toBe(200);

    const notifications = await prisma.notification.findMany({ where: { userId: user.id } });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.type).toBe('UNLOCK_CONFIRMED');
    expect(notifications[0]!.readAt).toBeNull();

    // It points at the UNLOCK_CONFIRMED event, so the UI can deep-link.
    const event = await prisma.deviceEvent.findFirst({
      where: { userId: user.id, deviceId, type: 'UNLOCK_CONFIRMED' },
      select: { id: true },
    });
    expect(notifications[0]!.deviceEventId).toBe(event!.id);
  });

  it('does not notify on a lock', async () => {
    const { user } = await createUserWithDevice();
    const code = await getCode(user.cookie);
    await post(CONFIRM_URL, user.cookie).send({ otp: code });
    await prisma.notification.deleteMany({ where: { userId: user.id } });

    const response = await post('/api/v1/devices/lock', user.cookie).send({});
    expect(response.status).toBe(200);

    // Deliberate: locking is the safe state, and a notification for it would
    // be noise that trains people to ignore the bell. See docs/decisions.md.
    expect(await prisma.notification.count({ where: { userId: user.id } })).toBe(0);
  });

  it('does not notify on a single wrong code', async () => {
    const { user } = await createUserWithDevice();
    await getCode(user.cookie);

    const response = await post(CONFIRM_URL, user.cookie).send({ otp: '000000' });
    expect(response.status).toBe(400);

    expect(await prisma.notification.count({ where: { userId: user.id } })).toBe(0);
  });

  it('notifies once the attempt limit is burned', async () => {
    const { user } = await createUserWithDevice();
    const code = await getCode(user.cookie);
    // A wrong code that is definitely wrong, whatever was issued.
    const wrong = code === '000000' ? '111111' : '000000';

    for (let attempt = 0; attempt < OTP_MAX_ATTEMPTS; attempt += 1) {
      const response = await post(CONFIRM_URL, user.cookie).send({ otp: wrong });
      expect(response.status).toBe(400);
    }

    const notifications = await prisma.notification.findMany({ where: { userId: user.id } });

    // Five wrong codes against one challenge is a possible tampering signal,
    // and the one failure mode worth interrupting the owner for.
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.type).toBe('UNLOCK_FAILED_MAX_ATTEMPTS');

    const event = await prisma.deviceEvent.findFirst({
      where: { userId: user.id, type: 'UNLOCK_FAILED', failureReason: 'TOO_MANY_ATTEMPTS' },
      select: { id: true },
    });
    expect(notifications[0]!.deviceEventId).toBe(event!.id);
  });

  it('stores the failure reason on every failed-unlock event', async () => {
    const { user } = await createUserWithDevice();

    // No challenge outstanding at all.
    await post(CONFIRM_URL, user.cookie).send({ otp: '123456' });

    const event = await prisma.deviceEvent.findFirst({
      where: { userId: user.id, type: 'UNLOCK_FAILED' },
      select: { failureReason: true },
    });
    expect(event!.failureReason).toBe('NO_CHALLENGE');
    // "No code was outstanding" is not a tampering signal on its own.
    expect(await prisma.notification.count({ where: { userId: user.id } })).toBe(0);
  });
});

describe('notification atomicity with UNLOCK_CONFIRMED', () => {
  it('rolls the notification back when the transaction fails after writing it', async () => {
    // The orphan test. The notifier writes its row through the transaction
    // client it was handed and the transaction then fails — if the write had
    // been on its own connection, or after the commit, the row would survive.
    const { user } = await createUserWithDevice();
    const code = await getCode(user.cookie);

    const spy = vi.spyOn(notifier, 'notifyUnlock').mockImplementation(async (client, event) => {
      await client.notification.create({
        data: {
          userId: event.userId,
          type: event.type,
          deviceEventId: event.deviceEventId,
        },
      });
      throw new Error('notifier exploded after writing');
    });

    const response = await post(CONFIRM_URL, user.cookie).send({ otp: code });

    expect(spy).toHaveBeenCalledOnce();
    expect(response.status).toBe(500);

    // Nothing survived: no orphan notification, no event, and the safe did
    // not move.
    expect(await prisma.notification.count({ where: { userId: user.id } })).toBe(0);
    expect(
      await prisma.deviceEvent.count({ where: { userId: user.id, type: 'UNLOCK_CONFIRMED' } }),
    ).toBe(0);

    const device = await deviceHeldBy(user.id);
    expect(device.lockState).toBe('LOCKED');
  });

  it('rolls the unlock back when the notifier cannot record anything', async () => {
    // The inverse direction, and the deliberate trade: we would rather refuse
    // to open the safe than open it without telling the owner. The code is
    // not burned either, so a retry still works.
    const { user } = await createUserWithDevice();
    const code = await getCode(user.cookie);

    vi.spyOn(notifier, 'notifyUnlock').mockRejectedValue(new Error('notifier unavailable'));

    const failed = await post(CONFIRM_URL, user.cookie).send({ otp: code });
    expect(failed.status).toBe(500);

    const device = await deviceHeldBy(user.id);
    expect(device.lockState).toBe('LOCKED');

    const challenge = await prisma.unlockChallenge.findFirstOrThrow({
      where: { userId: user.id },
    });
    expect(challenge.consumedAt).toBeNull();

    // With the notifier working again, the same code still opens the safe.
    vi.restoreAllMocks();
    const retried = await post(CONFIRM_URL, user.cookie).send({ otp: code });
    expect(retried.status).toBe(200);
    expect(await prisma.notification.count({ where: { userId: user.id } })).toBe(1);
  });

  it('writes no notification when the device command fails', async () => {
    const { user } = await createUserWithDevice();
    const code = await getCode(user.cookie);

    vi.spyOn(deviceGateway, 'sendUnlock').mockRejectedValue(new Error('radio silence'));

    const response = await post(CONFIRM_URL, user.cookie).send({ otp: code });

    expect(response.status).toBe(502);
    expect(response.body.error.code).toBe('DEVICE_COMMAND_FAILED');
    expect(await prisma.notification.count({ where: { userId: user.id } })).toBe(0);
  });
});

// --- Listing -----------------------------------------------------------------

describe('GET /notifications', () => {
  it('rejects an unauthenticated caller', async () => {
    const response = await get(LIST_URL);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('returns an empty list and a zero count for a user with nothing', async () => {
    const user = await createTestUser();

    const response = await get(LIST_URL, user.cookie);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ items: [], unreadCount: 0 });
  });

  it('puts unread first, then newest first within each group', async () => {
    const user = await createTestUser();
    const base = Date.now();

    await seedNotification({
      userId: user.id,
      createdAt: new Date(base),
      readAt: new Date(base),
    });
    await seedNotification({
      userId: user.id,
      createdAt: new Date(base + 1000),
      readAt: new Date(base + 1000),
    });
    const oldUnread = await seedNotification({ userId: user.id, createdAt: new Date(base + 2000) });
    const newUnread = await seedNotification({ userId: user.id, createdAt: new Date(base + 3000) });

    const response = await get(LIST_URL, user.cookie);
    const body = response.body as NotificationsResponse;

    expect(body.items.slice(0, 2).map((item) => item.id)).toEqual([
      newUnread.id,
      oldUnread.id,
    ]);
    expect(body.items.slice(0, 2).every((item) => item.readAt === null)).toBe(true);
    expect(body.items.slice(2).every((item) => item.readAt !== null)).toBe(true);
  });

  it('reports the total unread count even when the list is truncated', async () => {
    // The badge must not under-report because the page was capped.
    const user = await createTestUser();
    for (let index = 0; index < 7; index += 1) {
      await seedNotification({ userId: user.id, createdAt: new Date(Date.now() + index * 1000) });
    }

    const response = await get(`${LIST_URL}?limit=3`, user.cookie);
    const body = response.body as NotificationsResponse;

    expect(body.items).toHaveLength(3);
    expect(body.unreadCount).toBe(7);
  });

  it('returns only the caller’s notifications', async () => {
    const mine = await createTestUser();
    const theirs = await createTestUser();
    const own = await seedNotification({ userId: mine.id });
    const foreign = await seedNotification({ userId: theirs.id });

    const response = await get(LIST_URL, mine.cookie);
    const body = response.body as NotificationsResponse;

    expect(body.items.map((item) => item.id)).toEqual([own.id]);
    expect(body.unreadCount).toBe(1);
    expect(JSON.stringify(body)).not.toContain(foreign.id);
  });

  it('resolves copy server-side and exposes no internal fields', async () => {
    const user = await createTestUser();
    await seedNotification({ userId: user.id, type: 'UNLOCK_CONFIRMED' });

    const response = await get(LIST_URL, user.cookie);
    const item = (response.body as NotificationsResponse).items[0]!;

    expect(item.title).toBe('Your safe was unlocked');
    expect(item.body).toContain('unlock code was accepted');
    expect(Object.keys(item).sort()).toEqual(
      ['body', 'createdAt', 'deviceEventId', 'id', 'readAt', 'title', 'type'].sort(),
    );
    expect(JSON.stringify(response.body)).not.toContain(user.id);
  });

  it.each(['0', '51', 'abc', '-2'])('rejects limit=%j', async (limit) => {
    const user = await createTestUser();

    const response = await get(`${LIST_URL}?limit=${encodeURIComponent(limit)}`, user.cookie);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });
});

// --- Mark read ---------------------------------------------------------------

describe('POST /notifications/read', () => {
  it('rejects an unauthenticated caller', async () => {
    const response = await post(READ_URL).send({});

    expect(response.status).toBe(401);
  });

  it('marks every unread notification read when no ids are given', async () => {
    const user = await createTestUser();
    await seedNotification({ userId: user.id });
    await seedNotification({ userId: user.id });

    const response = await post(READ_URL, user.cookie).send({});
    const body = response.body as MarkNotificationsReadResponse;

    expect(response.status).toBe(200);
    expect(body).toEqual({ markedRead: 2, unreadCount: 0 });
  });

  it('marks only the given ids', async () => {
    const user = await createTestUser();
    const first = await seedNotification({ userId: user.id });
    await seedNotification({ userId: user.id });

    const response = await post(READ_URL, user.cookie).send({ ids: [first.id] });

    expect((response.body as MarkNotificationsReadResponse)).toEqual({
      markedRead: 1,
      unreadCount: 1,
    });
  });

  it('is idempotent: a repeat call changes nothing', async () => {
    const user = await createTestUser();
    await seedNotification({ userId: user.id });

    const first = await post(READ_URL, user.cookie).send({});
    expect((first.body as MarkNotificationsReadResponse).markedRead).toBe(1);

    const readAt = (await prisma.notification.findFirstOrThrow({ where: { userId: user.id } }))
      .readAt;

    const second = await post(READ_URL, user.cookie).send({});
    expect((second.body as MarkNotificationsReadResponse)).toEqual({
      markedRead: 0,
      unreadCount: 0,
    });

    // The original timestamp is preserved — it records when the user first saw
    // it, and a repeat call must not move it.
    const after = await prisma.notification.findFirstOrThrow({ where: { userId: user.id } });
    expect(after.readAt?.toISOString()).toBe(readAt?.toISOString());
  });

  it('silently ignores ids that are not the caller’s', async () => {
    // No 403 and no 404: either would confirm whether the id exists, which is
    // an existence oracle on another account's data for no benefit.
    const mine = await createTestUser();
    const theirs = await createTestUser();
    await seedNotification({ userId: mine.id });
    const foreign = await seedNotification({ userId: theirs.id });

    const response = await post(READ_URL, mine.cookie).send({ ids: [foreign.id] });

    expect(response.status).toBe(200);
    expect((response.body as MarkNotificationsReadResponse).markedRead).toBe(0);

    // And the other user's notification is untouched.
    const untouched = await prisma.notification.findUniqueOrThrow({ where: { id: foreign.id } });
    expect(untouched.readAt).toBeNull();
  });

  it('ignores an unknown id without erroring', async () => {
    const user = await createTestUser();
    await seedNotification({ userId: user.id });

    const response = await post(READ_URL, user.cookie).send({ ids: ['does-not-exist'] });

    expect(response.status).toBe(200);
    expect((response.body as MarkNotificationsReadResponse).markedRead).toBe(0);
  });

  it('rejects an unknown body field', async () => {
    const user = await createTestUser();

    const response = await post(READ_URL, user.cookie).send({ userId: 'someone-else' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects more than 100 ids', async () => {
    const user = await createTestUser();
    const ids = Array.from({ length: 101 }, (_value, index) => `id-${index}`);

    const response = await post(READ_URL, user.cookie).send({ ids });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });
});

// --- Rate limiting -----------------------------------------------------------

describe('notifications rate limiting', () => {
  it('limits per user across both routes', async () => {
    const instance = app({ rateLimits: { notifications: { windowMs: 60_000, limit: 2 } } });
    const user = await createTestUser();

    expect((await get(LIST_URL, user.cookie, instance)).status).toBe(200);
    expect((await post(READ_URL, user.cookie, instance).send({})).status).toBe(200);

    const limited = await get(LIST_URL, user.cookie, instance);

    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
  });
});
