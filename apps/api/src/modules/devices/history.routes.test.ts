import { describe, expect, it } from 'vitest';
import request from 'supertest';
import type { HistoryResponse } from '@safelock/shared';
import { prisma } from '../../lib/prisma';
import {
  app,
  createTestUser,
  createUserWithDevice,
  seedDevice,
  seedDeviceEvent,
  seedDeviceEvents,
} from '../../test/helpers';
import { encodeCursor } from './history.service';

const HISTORY_URL = '/api/v1/devices/history';

function get(url: string, cookie?: string, instance = app()) {
  const req = request(instance).get(url);
  return cookie ? req.set('Cookie', cookie) : req;
}

/** Walks every page and returns the ids in the order they were served. */
async function readAllPages(
  cookie: string,
  limit: number,
): Promise<{ ids: string[]; pages: number }> {
  const ids: string[] = [];
  let cursor: string | null = null;
  let pages = 0;

  do {
    const url = `${HISTORY_URL}?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const response = await get(url, cookie);
    expect(response.status).toBe(200);

    const body = response.body as HistoryResponse;
    ids.push(...body.items.map((item) => item.id));
    cursor = body.nextCursor;
    pages += 1;

    // A runaway cursor would loop forever; fail loudly instead.
    expect(pages).toBeLessThan(50);
  } while (cursor !== null);

  return { ids, pages };
}

// --- Access ------------------------------------------------------------------

describe('GET /devices/history — access', () => {
  it('rejects an unauthenticated caller', async () => {
    const response = await get(HISTORY_URL);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('returns only the caller’s own events', async () => {
    const mine = await createUserWithDevice();
    const theirs = await createUserWithDevice();

    const ownEvents = await seedDeviceEvents({
      userId: mine.user.id,
      deviceId: mine.deviceId,
      count: 3,
    });
    const foreignEvents = await seedDeviceEvents({
      userId: theirs.user.id,
      deviceId: theirs.deviceId,
      count: 4,
    });

    const response = await get(HISTORY_URL, mine.user.cookie);
    const body = response.body as HistoryResponse;

    expect(response.status).toBe(200);
    expect(body.items).toHaveLength(3);

    const returned = new Set(body.items.map((item) => item.id));
    for (const event of ownEvents) expect(returned.has(event.id)).toBe(true);
    // The real assertion: not one of the other user's rows came back.
    for (const event of foreignEvents) expect(returned.has(event.id)).toBe(false);
  });

  it('never serves another user’s events through a cursor built from them', async () => {
    // A cursor is not signed, so a caller can forge one. It must not widen the
    // query: every page is filtered by the session's userId regardless.
    const mine = await createUserWithDevice();
    const theirs = await createUserWithDevice();

    await seedDeviceEvents({ userId: mine.user.id, deviceId: mine.deviceId, count: 2 });
    const foreign = await seedDeviceEvents({
      userId: theirs.user.id,
      deviceId: theirs.deviceId,
      count: 5,
      startedAt: new Date(Date.now() + 60_000),
    });

    const forged = encodeCursor({
      createdAt: foreign[4]!.createdAt,
      id: foreign[4]!.id,
    });

    const response = await get(`${HISTORY_URL}?cursor=${encodeURIComponent(forged)}`, mine.user.cookie);
    const body = response.body as HistoryResponse;

    expect(response.status).toBe(200);
    for (const item of body.items) {
      expect(foreign.some((event) => event.id === item.id)).toBe(false);
    }
  });
});

// --- Empty states ------------------------------------------------------------

describe('GET /devices/history — empty states', () => {
  it('returns an empty list, not an error, for a user who has never booked', async () => {
    // No eligibility gate on this route: it is the caller's own record, and an
    // empty list is the honest answer rather than a 402.
    const user = await createTestUser();

    const response = await get(HISTORY_URL, user.cookie);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ items: [], nextCursor: null });
  });

  it('still serves history after the booking has ended', async () => {
    const { user, deviceId, bookingId } = await createUserWithDevice();
    await seedDeviceEvents({ userId: user.id, deviceId, count: 2 });
    await prisma.booking.update({
      where: { id: bookingId },
      data: { status: 'COMPLETED', completedAt: new Date(), completionReason: 'COLLECTED' },
    });

    const response = await get(HISTORY_URL, user.cookie);
    const body = response.body as HistoryResponse;

    // The booking is over, but the record of what happened to the safe they
    // had is still theirs to read — it is a security log about them.
    expect(response.status).toBe(200);
    expect(body.items).toHaveLength(2);
  });
});

// --- Ordering and pagination -------------------------------------------------

describe('GET /devices/history — ordering and pagination', () => {
  it('returns events newest first', async () => {
    const { user, deviceId } = await createUserWithDevice();
    const events = await seedDeviceEvents({ userId: user.id, deviceId, count: 5 });

    const response = await get(HISTORY_URL, user.cookie);
    const body = response.body as HistoryResponse;

    expect(body.items.map((item) => item.id)).toEqual(
      [...events].reverse().map((event) => event.id),
    );
  });

  it('pages through every event exactly once with no cursor repeats', async () => {
    const { user, deviceId } = await createUserWithDevice();
    const events = await seedDeviceEvents({ userId: user.id, deviceId, count: 25 });

    const { ids, pages } = await readAllPages(user.cookie, 10);

    expect(pages).toBe(3);
    expect(ids).toHaveLength(25);
    expect(new Set(ids).size).toBe(25);
    expect(ids).toEqual([...events].reverse().map((event) => event.id));
  });

  it('nextCursor is null on the last page', async () => {
    const { user, deviceId } = await createUserWithDevice();
    await seedDeviceEvents({ userId: user.id, deviceId, count: 3 });

    const response = await get(`${HISTORY_URL}?limit=10`, user.cookie);

    expect((response.body as HistoryResponse).nextCursor).toBeNull();
  });

  it('nextCursor is null when the last page is exactly full', async () => {
    // The limit+1 probe is what makes this right: with exactly `limit` rows
    // left there is no further page, and the UI must be told so rather than
    // offering a "Load more" that returns nothing.
    const { user, deviceId } = await createUserWithDevice();
    await seedDeviceEvents({ userId: user.id, deviceId, count: 4 });

    const first = await get(`${HISTORY_URL}?limit=2`, user.cookie);
    const firstBody = first.body as HistoryResponse;
    expect(firstBody.nextCursor).not.toBeNull();

    const second = await get(
      `${HISTORY_URL}?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor!)}`,
      user.cookie,
    );
    const secondBody = second.body as HistoryResponse;

    expect(secondBody.items).toHaveLength(2);
    expect(secondBody.nextCursor).toBeNull();
  });

  it('serves events sharing one timestamp exactly once across a page boundary', async () => {
    // The case `createdAt` alone cannot order. Six events in the *same*
    // millisecond, paged three at a time: without `id` in the sort key and in
    // the cursor, the boundary row is either skipped or served twice.
    const { user, deviceId } = await createUserWithDevice();
    const sameInstant = new Date('2026-10-16T10:00:00.000Z');

    const identical: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const event = await seedDeviceEvent({ userId: user.id, deviceId, createdAt: sameInstant });
      identical.push(event.id);
    }

    const { ids } = await readAllPages(user.cookie, 3);

    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
    expect([...ids].sort()).toEqual([...identical].sort());
  });

  it('keeps paging stable when identical timestamps straddle the boundary with other rows', async () => {
    // A tie split by a page boundary, with distinct rows on either side of it.
    const { user, deviceId } = await createUserWithDevice();
    const tie = new Date('2026-10-16T10:00:00.000Z');

    const older = await seedDeviceEvent({
      userId: user.id,
      deviceId,
      createdAt: new Date(tie.getTime() - 1000),
    });
    const tied: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      tied.push((await seedDeviceEvent({ userId: user.id, deviceId, createdAt: tie })).id);
    }
    const newer = await seedDeviceEvent({
      userId: user.id,
      deviceId,
      createdAt: new Date(tie.getTime() + 1000),
    });

    const { ids } = await readAllPages(user.cookie, 2);

    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
    // Newest and oldest are unambiguous; the three tied rows fill the middle.
    expect(ids[0]).toBe(newer.id);
    expect(ids[4]).toBe(older.id);
    expect([...ids.slice(1, 4)].sort()).toEqual([...tied].sort());
  });

  it('does not duplicate a row when a new event arrives mid-pagination', async () => {
    // Exactly the failure an offset would produce: a row inserted between two
    // page requests shifts everything down one, so page 2 repeats a row.
    const { user, deviceId } = await createUserWithDevice();
    const events = await seedDeviceEvents({ userId: user.id, deviceId, count: 6 });

    const first = await get(`${HISTORY_URL}?limit=3`, user.cookie);
    const firstBody = first.body as HistoryResponse;

    await seedDeviceEvent({ userId: user.id, deviceId, createdAt: new Date(Date.now() + 5000) });

    const second = await get(
      `${HISTORY_URL}?limit=3&cursor=${encodeURIComponent(firstBody.nextCursor!)}`,
      user.cookie,
    );
    const secondBody = second.body as HistoryResponse;

    const firstIds = firstBody.items.map((item) => item.id);
    const secondIds = secondBody.items.map((item) => item.id);

    expect(firstIds.some((id) => secondIds.includes(id))).toBe(false);
    expect(secondIds).toEqual([...events].reverse().slice(3, 6).map((event) => event.id));
  });
});

// --- Limit validation --------------------------------------------------------

describe('GET /devices/history — limit validation', () => {
  it('defaults to 20', async () => {
    const { user, deviceId } = await createUserWithDevice();
    await seedDeviceEvents({ userId: user.id, deviceId, count: 25 });

    const response = await get(HISTORY_URL, user.cookie);

    expect((response.body as HistoryResponse).items).toHaveLength(20);
  });

  it('honours a valid limit', async () => {
    const { user, deviceId } = await createUserWithDevice();
    await seedDeviceEvents({ userId: user.id, deviceId, count: 10 });

    const response = await get(`${HISTORY_URL}?limit=4`, user.cookie);

    expect((response.body as HistoryResponse).items).toHaveLength(4);
  });

  it('accepts the maximum limit of 50', async () => {
    const { user, deviceId } = await createUserWithDevice();
    await seedDeviceEvents({ userId: user.id, deviceId, count: 3 });

    const response = await get(`${HISTORY_URL}?limit=50`, user.cookie);

    expect(response.status).toBe(200);
  });

  it('rejects a limit above the maximum rather than clamping it', async () => {
    // Clamping silently would mean a client asking for 1000 gets 50 and never
    // learns its request was wrong.
    const { user } = await createUserWithDevice();

    const response = await get(`${HISTORY_URL}?limit=51`, user.cookie);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.fields.limit).toMatch(/at most 50/i);
  });

  it.each(['0', '-1', 'abc', '1.5', '1e9', ''])('rejects limit=%j', async (limit) => {
    const { user } = await createUserWithDevice();

    const response = await get(`${HISTORY_URL}?limit=${encodeURIComponent(limit)}`, user.cookie);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });
});

// --- Cursor validation -------------------------------------------------------

describe('GET /devices/history — cursor validation', () => {
  it('accepts a cursor the server issued', async () => {
    const { user, deviceId } = await createUserWithDevice();
    await seedDeviceEvents({ userId: user.id, deviceId, count: 4 });

    const first = await get(`${HISTORY_URL}?limit=2`, user.cookie);
    const cursor = (first.body as HistoryResponse).nextCursor!;

    const second = await get(`${HISTORY_URL}?cursor=${encodeURIComponent(cursor)}`, user.cookie);

    expect(second.status).toBe(200);
  });

  it('rejects a cursor outside the base64url alphabet before decoding it', async () => {
    const { user } = await createUserWithDevice();

    const response = await get(`${HISTORY_URL}?cursor=${encodeURIComponent('not a cursor!')}`, user.cookie);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.fields.cursor).toBeTruthy();
  });

  it('rejects an oversized cursor', async () => {
    const { user } = await createUserWithDevice();
    const oversized = 'a'.repeat(201);

    const response = await get(`${HISTORY_URL}?cursor=${oversized}`, user.cookie);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.fields.cursor).toMatch(/too long/i);
  });

  it('rejects a well-formed cursor whose payload is garbage', async () => {
    const { user } = await createUserWithDevice();
    const garbage = Buffer.from('this is not a cursor payload', 'utf8').toString('base64url');

    const response = await get(`${HISTORY_URL}?cursor=${encodeURIComponent(garbage)}`, user.cookie);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_CURSOR');
  });

  it('rejects a cursor whose timestamp was tampered with', async () => {
    const { user, deviceId } = await createUserWithDevice();
    await seedDeviceEvents({ userId: user.id, deviceId, count: 4 });

    const first = await get(`${HISTORY_URL}?limit=2`, user.cookie);
    const valid = (first.body as HistoryResponse).nextCursor!;

    // Decode, corrupt the timestamp, re-encode — a cursor that passes the
    // shape check and must still be refused.
    const [, id] = Buffer.from(valid, 'base64url').toString('utf8').split('|');
    const tampered = Buffer.from(`2026-13-45T99:99:99.000Z|${id}`, 'utf8').toString('base64url');

    const response = await get(`${HISTORY_URL}?cursor=${encodeURIComponent(tampered)}`, user.cookie);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_CURSOR');
  });

  it('rejects a cursor whose timestamp is loosely parseable but not canonical', async () => {
    // `new Date('2026-10-16')` parses, so a bare equality check on the parse
    // result is not enough — the round trip through toISOString is.
    const { user } = await createUserWithDevice();
    const loose = Buffer.from('2026-10-16|abc123', 'utf8').toString('base64url');

    const response = await get(`${HISTORY_URL}?cursor=${encodeURIComponent(loose)}`, user.cookie);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_CURSOR');
  });

  it('rejects a cursor with the wrong number of parts', async () => {
    const { user } = await createUserWithDevice();
    const extra = Buffer.from('2026-10-16T10:00:00.000Z|abc|def', 'utf8').toString('base64url');

    const response = await get(`${HISTORY_URL}?cursor=${encodeURIComponent(extra)}`, user.cookie);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_CURSOR');
  });

  it('rejects a cursor whose id is not an id', async () => {
    const { user } = await createUserWithDevice();
    const badId = Buffer.from(
      `2026-10-16T10:00:00.000Z|${'x'.repeat(65)}`,
      'utf8',
    ).toString('base64url');

    const response = await get(`${HISTORY_URL}?cursor=${encodeURIComponent(badId)}`, user.cookie);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_CURSOR');
  });
});

// --- Payload shape -----------------------------------------------------------

describe('GET /devices/history — payload', () => {
  it('labels every event type and carries the failure reason', async () => {
    const { user, deviceId } = await createUserWithDevice();
    const base = Date.now();

    await seedDeviceEvent({ userId: user.id, deviceId, type: 'LOCK', createdAt: new Date(base) });
    await seedDeviceEvent({
      userId: user.id,
      deviceId,
      type: 'UNLOCK_REQUESTED',
      createdAt: new Date(base + 1000),
    });
    await seedDeviceEvent({
      userId: user.id,
      deviceId,
      type: 'UNLOCK_CONFIRMED',
      createdAt: new Date(base + 2000),
    });
    await seedDeviceEvent({
      userId: user.id,
      deviceId,
      type: 'UNLOCK_FAILED',
      failureReason: 'TOO_MANY_ATTEMPTS',
      createdAt: new Date(base + 3000),
    });

    const response = await get(HISTORY_URL, user.cookie);
    const items = (response.body as HistoryResponse).items;

    expect(items.map((item) => item.label)).toEqual([
      'Unlock failed',
      'Safe unlocked',
      'Unlock code sent',
      'Safe locked',
    ]);
    expect(items[0]!.failureReason).toBe('TOO_MANY_ATTEMPTS');
    expect(items[0]!.failureLabel).toBe('Too many incorrect codes');
    // A reason is meaningless on a success and must not be invented.
    expect(items[1]!.failureReason).toBeNull();
    expect(items[1]!.failureLabel).toBeNull();
  });

  it('renders a legacy UNLOCK_FAILED with no stored reason generically', async () => {
    const { user, deviceId } = await createUserWithDevice();
    await seedDeviceEvent({ userId: user.id, deviceId, type: 'UNLOCK_FAILED', failureReason: null });

    const response = await get(HISTORY_URL, user.cookie);
    const item = (response.body as HistoryResponse).items[0]!;

    expect(item.label).toBe('Unlock failed');
    expect(item.failureReason).toBeNull();
    expect(item.failureLabel).toBeNull();
  });

  it('exposes the serial number and nothing internal', async () => {
    const { user, deviceId, serialNumber } = await createUserWithDevice();
    await seedDeviceEvent({ userId: user.id, deviceId, requestId: 'req-should-not-leak' });

    const response = await get(HISTORY_URL, user.cookie);
    const item = (response.body as HistoryResponse).items[0]!;

    expect(item.serialNumber).toBe(serialNumber);
    expect(Object.keys(item).sort()).toEqual(
      ['createdAt', 'failureLabel', 'failureReason', 'id', 'label', 'serialNumber', 'type'].sort(),
    );
  });

  it('leaks no requestId, device id, user id or OTP data anywhere in the body', async () => {
    const other = await createUserWithDevice();
    const { user, deviceId } = await createUserWithDevice();

    await seedDeviceEvent({
      userId: user.id,
      deviceId,
      type: 'UNLOCK_FAILED',
      failureReason: 'WRONG_CODE',
      requestId: 'req-sentinel-value',
    });
    await prisma.unlockChallenge.create({
      data: {
        userId: user.id,
        deviceId,
        otpHash: 'otp-hash-sentinel',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const response = await get(HISTORY_URL, user.cookie);
    const serialised = JSON.stringify(response.body);

    for (const sentinel of [
      'req-sentinel-value',
      'otp-hash-sentinel',
      'otpHash',
      'requestId',
      deviceId,
      user.id,
      other.user.id,
      other.deviceId,
    ]) {
      expect(serialised).not.toContain(sentinel);
    }
  });
});

// --- Rate limiting -----------------------------------------------------------

describe('GET /devices/history — rate limiting', () => {
  it('limits per user and answers 429 with RATE_LIMITED', async () => {
    // One app instance across the requests: limiter counters live in per-app
    // memory, so a fresh app per call would reset them (see rateLimit.test.ts).
    const instance = app({ rateLimits: { deviceHistory: { windowMs: 60_000, limit: 2 } } });
    const { user } = await createUserWithDevice();

    expect((await get(HISTORY_URL, user.cookie, instance)).status).toBe(200);
    expect((await get(HISTORY_URL, user.cookie, instance)).status).toBe(200);

    const limited = await get(HISTORY_URL, user.cookie, instance);

    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
  });

  it('keys the limit per user, so one user cannot exhaust another’s quota', async () => {
    const instance = app({ rateLimits: { deviceHistory: { windowMs: 60_000, limit: 1 } } });
    const first = await createUserWithDevice();
    const second = await createUserWithDevice();

    expect((await get(HISTORY_URL, first.user.cookie, instance)).status).toBe(200);
    expect((await get(HISTORY_URL, first.user.cookie, instance)).status).toBe(429);
    expect((await get(HISTORY_URL, second.user.cookie, instance)).status).toBe(200);
  });
});
