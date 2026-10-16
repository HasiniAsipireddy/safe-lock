import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { OTP_MAX_ATTEMPTS, OTP_TTL_MS } from '@safelock/shared';
import { prisma } from '../../lib/prisma';
import {
  TEST_ORIGIN,
  app,
  createTestUser,
  createUserWithDevice,
  givePaidPayment,
  seedDevice,
  withCapturedOtp,
} from '../../test/helpers';
import { allocateDevice } from './device.service';

const LOCK_URL = '/api/v1/devices/lock';
const REQUEST_URL = '/api/v1/devices/unlock/request';
const CONFIRM_URL = '/api/v1/devices/unlock/confirm';

/** A state-changing request as a real browser would send it. */
function post(url: string, cookie?: string) {
  const req = request(app()).post(url).set('Origin', TEST_ORIGIN);
  return cookie ? req.set('Cookie', cookie) : req;
}

/** Requests a code and returns it, through the real delivery path. */
async function getCode(cookie: string): Promise<string> {
  const { result, code } = await withCapturedOtp(() => post(REQUEST_URL, cookie).send({}));
  expect(result.status).toBe(200);
  return code;
}

// --- Eligibility -------------------------------------------------------------

describe('lock/unlock eligibility', () => {
  it('rejects an unauthenticated caller on every route', async () => {
    for (const url of [LOCK_URL, REQUEST_URL]) {
      const response = await post(url).send({});
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('UNAUTHENTICATED');
    }

    const confirm = await post(CONFIRM_URL).send({ otp: '123456' });
    expect(confirm.status).toBe(401);
  });

  it('refuses a user who has never paid with NOT_PAID', async () => {
    const user = await createTestUser();

    const response = await post(LOCK_URL, user.cookie).send({});

    expect(response.status).toBe(402);
    expect(response.body.error.code).toBe('NOT_PAID');
  });

  it('refuses a paid user with no device allocated with NO_DEVICE', async () => {
    const user = await createTestUser();
    await givePaidPayment(user.id);

    const response = await post(LOCK_URL, user.cookie).send({});

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('NO_DEVICE');
  });

  it('refuses a refunded user still holding hardware with REFUNDED_CONTACT_SUPPORT', async () => {
    // The state docs/decisions.md calls out: hasPaid false, device still
    // assigned. It must NOT be flattened into "you have not paid" — paying
    // again is not the remedy, and the user needs to be told to call support.
    const user = await createTestUser();
    const payment = await givePaidPayment(user.id);
    const device = await seedDevice();
    await allocateDevice(user.id, device.id);
    await prisma.payment.update({ where: { id: payment.id }, data: { status: 'REFUNDED' } });

    const response = await post(LOCK_URL, user.cookie).send({});

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('REFUNDED_CONTACT_SUPPORT');

    // And the same for the unlock routes — neither is a way around it.
    expect((await post(REQUEST_URL, user.cookie).send({})).body.error.code).toBe(
      'REFUNDED_CONTACT_SUPPORT',
    );
    expect((await post(CONFIRM_URL, user.cookie).send({ otp: '123456' })).body.error.code).toBe(
      'REFUNDED_CONTACT_SUPPORT',
    );
  });

  it('refuses to operate a device whose state is UNKNOWN', async () => {
    const { user, deviceId } = await createUserWithDevice();
    await prisma.device.update({ where: { id: deviceId }, data: { lockState: 'UNKNOWN' } });

    const response = await post(LOCK_URL, user.cookie).send({});

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('DEVICE_STATE_UNKNOWN');
  });

  it("never lets one user operate another user's safe", async () => {
    // There is no device id in any of these requests — the device is resolved
    // from the session — so this is really asserting that the resolution is
    // by ownerId and cannot be influenced by the body.
    const owner = await createUserWithDevice();
    const other = await createTestUser();
    await givePaidPayment(other.id);

    const response = await post(LOCK_URL, other.cookie).send({
      deviceId: owner.deviceId,
    });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('NO_DEVICE');

    const row = await prisma.device.findUnique({ where: { id: owner.deviceId } });
    expect(row?.lockState).toBe('LOCKED');
  });

  it('audits a denied operation with its error code', async () => {
    const user = await createTestUser();

    await post(LOCK_URL, user.cookie).send({});

    const audit = await prisma.auditLog.findFirst({
      where: { userId: user.id, action: 'device.operation.denied' },
    });
    expect(audit).not.toBeNull();
    expect((audit?.metadata as { code?: string })?.code).toBe('NOT_PAID');
  });
});

// --- Lock --------------------------------------------------------------------

describe('POST /devices/lock', () => {
  it('locks an unlocked safe and records the state change', async () => {
    const { user, deviceId } = await createUserWithDevice();
    await prisma.device.update({ where: { id: deviceId }, data: { lockState: 'UNLOCKED' } });

    const response = await post(LOCK_URL, user.cookie).send({});

    expect(response.status).toBe(200);
    expect(response.body.alreadyLocked).toBe(false);
    expect(response.body.device.lockState).toBe('LOCKED');
    expect(response.body.device.lockStateUpdatedAt).not.toBeNull();

    const row = await prisma.device.findUnique({ where: { id: deviceId } });
    expect(row?.lockState).toBe('LOCKED');
    // The mock gateway acked, so the device is considered reachable.
    expect(row?.online).toBe(true);
    expect(row?.lastSeenAt).not.toBeNull();
  });

  it('is idempotent: locking a locked safe succeeds and writes no event', async () => {
    const { user, deviceId } = await createUserWithDevice();

    const first = await post(LOCK_URL, user.cookie).send({});
    expect(first.status).toBe(200);
    // Allocation already left it LOCKED, so even the first call is a no-op.
    expect(first.body.alreadyLocked).toBe(true);

    const second = await post(LOCK_URL, user.cookie).send({});
    expect(second.status).toBe(200);
    expect(second.body.alreadyLocked).toBe(true);
    expect(second.body.device.lockState).toBe('LOCKED');

    // No state changed, so there is nothing to put in the activity feed.
    const events = await prisma.deviceEvent.count({ where: { deviceId, type: 'LOCK' } });
    expect(events).toBe(0);
  });

  it('writes a DeviceEvent and an audit row for a real lock', async () => {
    const { user, deviceId } = await createUserWithDevice();
    await prisma.device.update({ where: { id: deviceId }, data: { lockState: 'UNLOCKED' } });

    await post(LOCK_URL, user.cookie).send({});

    const event = await prisma.deviceEvent.findFirst({ where: { deviceId, type: 'LOCK' } });
    expect(event).toMatchObject({ userId: user.id, type: 'LOCK', source: 'WEB' });
    expect(event?.requestId).toBeTruthy();

    const audit = await prisma.auditLog.findFirst({
      where: { userId: user.id, action: 'device.lock.success' },
    });
    expect(audit?.deviceId).toBe(deviceId);
  });

  it('rejects a cross-site POST before it reaches the handler', async () => {
    const { user, deviceId } = await createUserWithDevice();
    await prisma.device.update({ where: { id: deviceId }, data: { lockState: 'UNLOCKED' } });

    const response = await request(app())
      .post(LOCK_URL)
      .set('Origin', 'https://attacker.test')
      .set('Cookie', user.cookie)
      .send({});

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('CSRF_ORIGIN_REJECTED');

    const row = await prisma.device.findUnique({ where: { id: deviceId } });
    expect(row?.lockState).toBe('UNLOCKED');
  });
});

// --- Unlock: request ---------------------------------------------------------

describe('POST /devices/unlock/request', () => {
  it('creates a challenge and returns no code or hash', async () => {
    const { user, deviceId } = await createUserWithDevice();

    const { result } = await withCapturedOtp(() => post(REQUEST_URL, user.cookie).send({}));

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      attemptsAllowed: OTP_MAX_ATTEMPTS,
      expiresInSeconds: OTP_TTL_MS / 1000,
    });

    const challenge = await prisma.unlockChallenge.findFirstOrThrow({ where: { deviceId } });
    expect(challenge.userId).toBe(user.id);
    expect(challenge.attempts).toBe(0);
    expect(challenge.consumedAt).toBeNull();

    // Nothing that could be used to derive the code crosses the wire.
    const serialised = JSON.stringify(result.body);
    expect(serialised).not.toContain(challenge.otpHash);
    expect(serialised).not.toContain(challenge.id);
    expect(serialised).not.toMatch(/\d{6}/);
  });

  it('stores only a hash — never the code itself', async () => {
    const { user, deviceId } = await createUserWithDevice();

    const code = await getCode(user.cookie);

    const challenge = await prisma.unlockChallenge.findFirstOrThrow({ where: { deviceId } });
    expect(challenge.otpHash).not.toContain(code);
    expect(challenge.otpHash).toHaveLength(64);

    // And nowhere else in the database either.
    const everything = JSON.stringify([
      await prisma.unlockChallenge.findMany(),
      await prisma.deviceEvent.findMany(),
      await prisma.auditLog.findMany(),
      await prisma.device.findMany(),
    ]);
    expect(everything).not.toContain(code);
  });

  it('writes an UNLOCK_REQUESTED event but does not move the bolt', async () => {
    const { user, deviceId } = await createUserWithDevice();

    await getCode(user.cookie);

    const event = await prisma.deviceEvent.findFirstOrThrow({ where: { deviceId } });
    expect(event.type).toBe('UNLOCK_REQUESTED');

    const row = await prisma.device.findUnique({ where: { id: deviceId } });
    expect(row?.lockState).toBe('LOCKED');
  });

  it('invalidates the previous challenge, so only one code is ever live', async () => {
    const { user, deviceId } = await createUserWithDevice();

    const first = await getCode(user.cookie);
    const second = await getCode(user.cookie);
    expect(second).not.toBe(first);

    const open = await prisma.unlockChallenge.findMany({
      where: { deviceId, consumedAt: null },
    });
    expect(open).toHaveLength(1);

    // The superseded code is dead, not merely second in line.
    const stale = await post(CONFIRM_URL, user.cookie).send({ otp: first });
    expect(stale.status).toBe(400);
    expect(stale.body.error.code).toBe('OTP_INVALID');

    // The current one still works.
    const ok = await post(CONFIRM_URL, user.cookie).send({ otp: second });
    expect(ok.status).toBe(200);
  });
});

// --- Unlock: confirm ---------------------------------------------------------

describe('POST /devices/unlock/confirm', () => {
  it('opens the safe for the right code', async () => {
    const { user, deviceId } = await createUserWithDevice();
    const code = await getCode(user.cookie);

    const response = await post(CONFIRM_URL, user.cookie).send({ otp: code });

    expect(response.status).toBe(200);
    expect(response.body.device.lockState).toBe('UNLOCKED');

    const row = await prisma.device.findUnique({ where: { id: deviceId } });
    expect(row?.lockState).toBe('UNLOCKED');
    expect(row?.lockStateUpdatedAt).not.toBeNull();

    const event = await prisma.deviceEvent.findFirst({
      where: { deviceId, type: 'UNLOCK_CONFIRMED' },
    });
    expect(event?.userId).toBe(user.id);

    const audit = await prisma.auditLog.findFirst({
      where: { userId: user.id, action: 'device.unlock.success' },
    });
    expect(audit?.deviceId).toBe(deviceId);
  });

  it('accepts a pasted code with spaces', async () => {
    const { user } = await createUserWithDevice();
    const code = await getCode(user.cookie);

    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
    const response = await post(CONFIRM_URL, user.cookie).send({ otp: spaced });

    expect(response.status).toBe(200);
  });

  it('rejects a malformed code at the schema, before any lookup', async () => {
    const { user } = await createUserWithDevice();
    await getCode(user.cookie);

    for (const otp of ['12345', '1234567', 'abcdef', '', '12 34']) {
      const response = await post(CONFIRM_URL, user.cookie).send({ otp });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }

    // None of that counted against the challenge.
    const challenge = await prisma.unlockChallenge.findFirstOrThrow({});
    expect(challenge.attempts).toBe(0);
  });

  it('rejects a wrong code, counts the attempt, and leaves the safe locked', async () => {
    const { user, deviceId } = await createUserWithDevice();
    const code = await getCode(user.cookie);
    const wrong = code === '000000' ? '111111' : '000000';

    const response = await post(CONFIRM_URL, user.cookie).send({ otp: wrong });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('OTP_INVALID');

    const row = await prisma.device.findUnique({ where: { id: deviceId } });
    expect(row?.lockState).toBe('LOCKED');

    const challenge = await prisma.unlockChallenge.findFirstOrThrow({});
    expect(challenge.attempts).toBe(1);
    expect(challenge.consumedAt).toBeNull();

    // The right code still works afterwards — one mistake is not fatal.
    expect((await post(CONFIRM_URL, user.cookie).send({ otp: code })).status).toBe(200);
  });

  it('records a failed attempt in the activity feed and the audit log', async () => {
    const { user, deviceId } = await createUserWithDevice();
    const code = await getCode(user.cookie);
    const wrong = code === '000000' ? '111111' : '000000';

    await post(CONFIRM_URL, user.cookie).send({ otp: wrong });

    const event = await prisma.deviceEvent.findFirst({
      where: { deviceId, type: 'UNLOCK_FAILED' },
    });
    expect(event?.userId).toBe(user.id);

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { userId: user.id, action: 'device.unlock.otp_failed' },
    });
    expect(audit.metadata).toMatchObject({ reason: 'wrong_code', code: 'OTP_INVALID' });
    // The reason is an enum, not an echo of what was typed.
    expect(JSON.stringify(audit.metadata)).not.toContain(wrong);
  });

  it('refuses an expired code', async () => {
    const { user, deviceId } = await createUserWithDevice();
    const code = await getCode(user.cookie);

    await prisma.unlockChallenge.updateMany({
      where: { deviceId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const response = await post(CONFIRM_URL, user.cookie).send({ otp: code });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('OTP_EXPIRED');

    const row = await prisma.device.findUnique({ where: { id: deviceId } });
    expect(row?.lockState).toBe('LOCKED');

    // And it is burned — the same code cannot be retried a moment later.
    const challenge = await prisma.unlockChallenge.findFirstOrThrow({});
    expect(challenge.consumedAt).not.toBeNull();
  });

  it(`invalidates the challenge after ${OTP_MAX_ATTEMPTS} wrong attempts`, async () => {
    const { user, deviceId } = await createUserWithDevice();
    const code = await getCode(user.cookie);
    const wrong = code === '000000' ? '111111' : '000000';

    for (let attempt = 1; attempt < OTP_MAX_ATTEMPTS; attempt += 1) {
      const response = await post(CONFIRM_URL, user.cookie).send({ otp: wrong });
      expect(response.body.error.code).toBe('OTP_INVALID');
    }

    const last = await post(CONFIRM_URL, user.cookie).send({ otp: wrong });
    expect(last.body.error.code).toBe('OTP_TOO_MANY_ATTEMPTS');

    // The correct code is now worthless: the challenge is dead, not merely
    // out of guesses.
    const afterwards = await post(CONFIRM_URL, user.cookie).send({ otp: code });
    expect(afterwards.body.error.code).toBe('OTP_NOT_FOUND');

    const row = await prisma.device.findUnique({ where: { id: deviceId } });
    expect(row?.lockState).toBe('LOCKED');
  });

  it('is single-use: a correct code cannot be replayed', async () => {
    const { user } = await createUserWithDevice();
    const code = await getCode(user.cookie);

    expect((await post(CONFIRM_URL, user.cookie).send({ otp: code })).status).toBe(200);

    const replay = await post(CONFIRM_URL, user.cookie).send({ otp: code });
    expect(replay.status).toBe(400);
    expect(replay.body.error.code).toBe('OTP_NOT_FOUND');
  });

  it('refuses when no code was ever requested', async () => {
    const { user } = await createUserWithDevice();

    const response = await post(CONFIRM_URL, user.cookie).send({ otp: '123456' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('OTP_NOT_FOUND');
  });

  it("rejects another user's code", async () => {
    // Challenges are bound to a user and a device. A code overheard from
    // someone else must not open your safe, or theirs.
    const victim = await createUserWithDevice();
    const attacker = await createUserWithDevice();

    const victimCode = await getCode(victim.user.cookie);
    await getCode(attacker.user.cookie);

    const response = await post(CONFIRM_URL, attacker.user.cookie).send({ otp: victimCode });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('OTP_INVALID');

    const victimDevice = await prisma.device.findUnique({ where: { id: victim.deviceId } });
    expect(victimDevice?.lockState).toBe('LOCKED');
  });
});

// --- Concurrency -------------------------------------------------------------

describe('concurrency', () => {
  it('lets only one of two simultaneous confirms succeed', async () => {
    const { user, deviceId } = await createUserWithDevice();
    const code = await getCode(user.cookie);

    const [a, b] = await Promise.all([
      post(CONFIRM_URL, user.cookie).send({ otp: code }),
      post(CONFIRM_URL, user.cookie).send({ otp: code }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 400]);

    const loser = a.status === 400 ? a : b;
    expect(loser.body.error.code).toBe('OTP_NOT_FOUND');

    // One physical movement, one event.
    const events = await prisma.deviceEvent.count({
      where: { deviceId, type: 'UNLOCK_CONFIRMED' },
    });
    expect(events).toBe(1);
  });

  it('serialises two simultaneous locks into one state change', async () => {
    const { user, deviceId } = await createUserWithDevice();
    await prisma.device.update({ where: { id: deviceId }, data: { lockState: 'UNLOCKED' } });

    const [a, b] = await Promise.all([
      post(LOCK_URL, user.cookie).send({}),
      post(LOCK_URL, user.cookie).send({}),
    ]);

    // Both succeed — locking is idempotent — but exactly one did the work.
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect([a.body.alreadyLocked, b.body.alreadyLocked].sort()).toEqual([false, true]);

    const events = await prisma.deviceEvent.count({ where: { deviceId, type: 'LOCK' } });
    expect(events).toBe(1);
  });

  it('spends one attempt per simultaneous wrong guess', async () => {
    // An atomic increment, not read-then-write: five parallel guesses must
    // cost five attempts, or the limit is bypassable by firing them at once.
    const { user } = await createUserWithDevice();
    const code = await getCode(user.cookie);
    const wrong = code === '000000' ? '111111' : '000000';

    await Promise.all([
      post(CONFIRM_URL, user.cookie).send({ otp: wrong }),
      post(CONFIRM_URL, user.cookie).send({ otp: wrong }),
      post(CONFIRM_URL, user.cookie).send({ otp: wrong }),
    ]);

    const challenge = await prisma.unlockChallenge.findFirstOrThrow({});
    expect(challenge.attempts).toBe(3);
  });
});

// --- Rate limiting -----------------------------------------------------------

describe('rate limiting', () => {
  it('limits unlock code requests per user', async () => {
    // One app instance across the requests: limiter counters live in per-app
    // memory, so a fresh app per call would reset them (see rateLimit.test.ts).
    const { user } = await createUserWithDevice();
    const server = app({
      rateLimits: { unlockRequest: { windowMs: 60_000, limit: 2 } },
    });

    const send = () =>
      request(server).post(REQUEST_URL).set('Origin', TEST_ORIGIN).set('Cookie', user.cookie).send({});

    await withCapturedOtp(async () => {
      expect((await send()).status).toBe(200);
      expect((await send()).status).toBe(200);
    });

    const blocked = await send();
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
  });

  it('limits unlock code requests per IP across different users', async () => {
    const first = await createUserWithDevice();
    const second = await createUserWithDevice();
    const server = app({
      rateLimits: { unlockRequestIp: { windowMs: 60_000, limit: 1 } },
    });

    const send = (cookie: string) =>
      request(server).post(REQUEST_URL).set('Origin', TEST_ORIGIN).set('Cookie', cookie).send({});

    await withCapturedOtp(async () => {
      expect((await send(first.user.cookie)).status).toBe(200);
    });

    // A different account, same address — the per-user limb cannot see this.
    const blocked = await send(second.user.cookie);
    expect(blocked.status).toBe(429);
  });

  it('limits confirm attempts', async () => {
    const { user } = await createUserWithDevice();
    const server = app({
      rateLimits: { unlockConfirm: { windowMs: 60_000, limit: 2 } },
    });

    const send = () =>
      request(server)
        .post(CONFIRM_URL)
        .set('Origin', TEST_ORIGIN)
        .set('Cookie', user.cookie)
        .send({ otp: '000000' });

    await send();
    await send();

    const blocked = await send();
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
  });

  it('limits lock requests', async () => {
    const { user } = await createUserWithDevice();
    const server = app({ rateLimits: { deviceLock: { windowMs: 60_000, limit: 1 } } });

    const send = () =>
      request(server).post(LOCK_URL).set('Origin', TEST_ORIGIN).set('Cookie', user.cookie).send({});

    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(429);
  });
});

// --- Secret hygiene ----------------------------------------------------------

describe('the code never escapes', () => {
  it('appears in no response body, audit row, event or device column', async () => {
    const { user, deviceId } = await createUserWithDevice();

    const { result: requestResponse, code } = await withCapturedOtp(() =>
      post(REQUEST_URL, user.cookie).send({}),
    );
    const wrong = code === '000000' ? '111111' : '000000';
    const failed = await post(CONFIRM_URL, user.cookie).send({ otp: wrong });
    const confirmed = await post(CONFIRM_URL, user.cookie).send({ otp: code });
    const locked = await post(LOCK_URL, user.cookie).send({});

    for (const response of [requestResponse, failed, confirmed, locked]) {
      expect(JSON.stringify(response.body)).not.toContain(code);
    }

    const stored = JSON.stringify([
      await prisma.auditLog.findMany(),
      await prisma.deviceEvent.findMany({ where: { deviceId } }),
      await prisma.device.findMany(),
      // The hash is here, but the code must not be.
      await prisma.unlockChallenge.findMany(),
    ]);
    expect(stored).not.toContain(code);
  });

  it('never writes a hash or a credential into an audit row', async () => {
    const { user } = await createUserWithDevice();
    const code = await getCode(user.cookie);
    await post(CONFIRM_URL, user.cookie).send({ otp: code });

    const rows = JSON.stringify(await prisma.auditLog.findMany());
    expect(rows).not.toMatch(/otpHash|credentialHash|passwordHash|tokenHash/i);
  });
});
