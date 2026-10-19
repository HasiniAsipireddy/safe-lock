import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { OTP_MAX_ATTEMPTS, OTP_TTL_MS } from '@safelock/shared';
import { prisma } from '../../lib/prisma';
import { drainDeviceAcks } from '../../lib/deviceGateway';
import {
  TEST_ORIGIN,
  app,
  createTestUser,
  createUserWithDevice,
  pushIntoOverstay,
  seedBooking,
  seedDevice,
  withCapturedOtp,
} from '../../test/helpers';

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

/**
 * Issues a command and waits for the simulated device to answer it.
 *
 * Lock and unlock are **202s** now: the command has been accepted and the bolt
 * has not moved. So a test that wants to assert on a *settled* world has to
 * wait for the ack, and `drainDeviceAcks` is how it does that without sleeping
 * — the mock knows exactly what it owes.
 *
 * Every assertion about `lockState`, a `DeviceEvent` or a notification belongs
 * after this, because all three are now written by the ack handler. That is
 * the point of the change: they describe what the safe did, not what we asked.
 */
async function sendCommand(url: string, cookie: string, body: object = {}) {
  const response = await post(url, cookie).send(body);
  await drainDeviceAcks();
  return response;
}

/** The command row for an accepted 202, once it has settled. */
async function commandOf(response: { body: { commandId: string | null } }) {
  const commandId = response.body.commandId;
  expect(commandId).toBeTruthy();

  return prisma.command.findUniqueOrThrow({ where: { id: commandId as string } });
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

  it('refuses a user with no booking with NO_ACTIVE_BOOKING', async () => {
    const user = await createTestUser();

    const response = await post(LOCK_URL, user.cookie).send({});

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('NO_ACTIVE_BOOKING');
  });

  it('refuses a booking that is still awaiting payment', async () => {
    // A held safe is not an operable safe. Only a verified payment makes a
    // booking ACTIVE, and only ACTIVE (or a settled overstay) operates.
    const user = await createTestUser();
    const device = await seedDevice();
    await seedBooking({ userId: user.id, deviceId: device.id, status: 'PENDING_PAYMENT' });

    const response = await post(LOCK_URL, user.cookie).send({});

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('NO_ACTIVE_BOOKING');
  });

  /**
   * The asymmetry that matters: an unpaid overstay refuses to **open** but
   * still agrees to **close**.
   *
   * Refusing to let someone secure a safe they are standing at would punish
   * them in the one direction that creates risk rather than recovering money.
   */
  it('refuses unlock but allows lock during an unpaid overstay', async () => {
    const { user, bookingId } = await createUserWithDevice();
    await pushIntoOverstay(bookingId, 1);

    const unlockRequest = await post(REQUEST_URL, user.cookie).send({});
    expect(unlockRequest.status).toBe(402);
    expect(unlockRequest.body.error.code).toBe('OVERSTAY_PAYMENT_REQUIRED');

    const confirm = await post(CONFIRM_URL, user.cookie).send({ otp: '123456' });
    expect(confirm.status).toBe(402);
    expect(confirm.body.error.code).toBe('OVERSTAY_PAYMENT_REQUIRED');

    // Lock is allowed, and is a 202 whether or not it had to move the bolt.
    const lock = await post(LOCK_URL, user.cookie).send({});
    expect(lock.status).toBe(202);
  });

  /** Paying the fee is what opens the collection window — and the safe. */
  it('allows unlock during an overstay once the fee is settled', async () => {
    const { user, bookingId } = await createUserWithDevice();
    await pushIntoOverstay(bookingId, 1);
    await prisma.booking.update({
      where: { id: bookingId },
      data: { status: 'OVERSTAY', overstaySettledAt: new Date() },
    });

    const response = await post(REQUEST_URL, user.cookie).send({});

    expect(response.status).toBe(200);
  });

  it('refuses a completed booking', async () => {
    const { user, bookingId } = await createUserWithDevice();
    await prisma.booking.update({
      where: { id: bookingId },
      data: { status: 'COMPLETED', completedAt: new Date(), completionReason: 'COLLECTED' },
    });

    const response = await post(LOCK_URL, user.cookie).send({});

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('NO_ACTIVE_BOOKING');
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
    // from the caller's own booking — so this is really asserting that the
    // resolution cannot be influenced by the body.
    const owner = await createUserWithDevice();
    const other = await createTestUser();

    const response = await post(LOCK_URL, other.cookie).send({
      deviceId: owner.deviceId,
    });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('NO_ACTIVE_BOOKING');

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
    expect((audit?.metadata as { code?: string })?.code).toBe('NO_ACTIVE_BOOKING');
  });
});

// --- Lock --------------------------------------------------------------------

describe('POST /devices/lock', () => {
  /**
   * The 202 contract: accepted, not done. The response carries a command to
   * poll and deliberately **no device summary** — returning one would be
   * returning a lock state nobody has confirmed.
   */
  it('accepts the command without claiming the bolt has moved', async () => {
    const { user, deviceId } = await createUserWithDevice();
    await prisma.device.update({ where: { id: deviceId }, data: { lockState: 'UNLOCKED' } });

    const response = await post(LOCK_URL, user.cookie).send({});

    expect(response.status).toBe(202);
    expect(response.body.commandId).toBeTruthy();
    expect(response.body.status).toBe('SENT');
    expect(response.body).not.toHaveProperty('device');

    // Still UNLOCKED: the ack has not been handled yet, and the stored state
    // moves on an ack and on nothing else.
    const beforeAck = await prisma.device.findUnique({ where: { id: deviceId } });
    expect(beforeAck?.lockState).toBe('UNLOCKED');
  });

  it('locks the safe once the device acks, and records the state change', async () => {
    const { user, deviceId } = await createUserWithDevice();
    await prisma.device.update({ where: { id: deviceId }, data: { lockState: 'UNLOCKED' } });

    const response = await sendCommand(LOCK_URL, user.cookie);
    const command = await commandOf(response);

    expect(command.status).toBe('ACKED');
    expect(command.ackedAt).not.toBeNull();
    expect(command.lateAckedAt).toBeNull();
    // Monotonic from zero, allocated under the device row lock.
    expect(command.seq).toBe(1);

    const row = await prisma.device.findUnique({ where: { id: deviceId } });
    expect(row?.lockState).toBe('LOCKED');
    expect(row?.lockStateUpdatedAt).not.toBeNull();
    // The device spoke, so it is reachable.
    expect(row?.online).toBe(true);
    expect(row?.lastSeenAt).not.toBeNull();
    // Measured, not assumed.
    expect(row?.doorState).toBe('CLOSED');
  });

  it('is idempotent: locking a locked safe issues no command and writes no event', async () => {
    const { user, deviceId } = await createUserWithDevice();

    const first = await sendCommand(LOCK_URL, user.cookie);
    expect(first.status).toBe(202);
    // The safe is already locked, so even the first call has nothing to send.
    expect(first.body.alreadyInState).toBe(true);
    expect(first.body.commandId).toBeNull();

    const second = await sendCommand(LOCK_URL, user.cookie);
    expect(second.body.alreadyInState).toBe(true);

    // No command, so nothing to poll and nothing to record.
    expect(await prisma.command.count({ where: { deviceId } })).toBe(0);
    const events = await prisma.deviceEvent.count({ where: { deviceId, type: 'LOCK' } });
    expect(events).toBe(0);
  });

  /**
   * The `LOCK` event is written by the **ack handler**, not the request. The
   * feed is the user-visible security record of a physical safe, and the fact
   * worth recording is that the bolt moved.
   */
  it('writes the DeviceEvent when the device acks, not when the command is sent', async () => {
    const { user, deviceId } = await createUserWithDevice();
    await prisma.device.update({ where: { id: deviceId }, data: { lockState: 'UNLOCKED' } });

    await post(LOCK_URL, user.cookie).send({});
    expect(await prisma.deviceEvent.count({ where: { deviceId, type: 'LOCK' } })).toBe(0);

    await drainDeviceAcks();

    const event = await prisma.deviceEvent.findFirst({ where: { deviceId, type: 'LOCK' } });
    expect(event).toMatchObject({ userId: user.id, type: 'LOCK', source: 'WEB' });

    const issued = await prisma.auditLog.findFirst({
      where: { userId: user.id, action: 'device.command.issued' },
    });
    expect(issued).not.toBeNull();

    const acked = await prisma.auditLog.findFirst({
      where: { action: 'device.command.acked', deviceId },
    });
    expect((acked?.metadata as { result?: string })?.result).toBe('OK');
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
    expect(ok.status).toBe(202);
  });

  /**
   * The offline refusal that matters most, because it happens **before** a
   * code exists. Issuing one for a safe that cannot receive a command spends
   * the user's send cap and one of their three codes per ten minutes on a code
   * that cannot work, and then fails at confirm anyway — after they have typed
   * it in.
   */
  it('refuses before sending a code when the safe is unreachable', async () => {
    const { user, deviceId } = await createUserWithDevice();
    await prisma.device.update({
      where: { id: deviceId },
      data: { online: false, lastSeenAt: null },
    });

    const response = await post(REQUEST_URL, user.cookie).send({});

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('DEVICE_OFFLINE');
    expect(await prisma.unlockChallenge.count({ where: { deviceId } })).toBe(0);
  });

  /**
   * Stale liveness is not liveness. The stored flag still says online; the
   * last message is older than three heartbeats, and that is what decides.
   */
  it('treats a device that has stopped reporting as offline', async () => {
    const { user, deviceId } = await createUserWithDevice();
    await prisma.device.update({
      where: { id: deviceId },
      data: { online: true, lastSeenAt: new Date(Date.now() - 10 * 60 * 1000) },
    });

    const response = await post(REQUEST_URL, user.cookie).send({});

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('DEVICE_OFFLINE');
  });
});

// --- Unlock: confirm ---------------------------------------------------------

describe('POST /devices/unlock/confirm', () => {
  it('opens the safe for the right code', async () => {
    const { user, deviceId } = await createUserWithDevice();
    const code = await getCode(user.cookie);

    const response = await sendCommand(CONFIRM_URL, user.cookie, { otp: code });

    expect(response.status).toBe(202);
    expect(response.body.commandId).toBeTruthy();

    const command = await commandOf(response);
    expect(command.type).toBe('UNLOCK');
    expect(command.status).toBe('ACKED');
    expect(command.userId).toBe(user.id);
    // A user command. Nobody retries one, because somebody is waiting on it.
    expect(command.systemActor).toBeNull();
    expect(command.attempts).toBe(1);

    const row = await prisma.device.findUnique({ where: { id: deviceId } });
    expect(row?.lockState).toBe('UNLOCKED');
    expect(row?.lockStateUpdatedAt).not.toBeNull();

    const event = await prisma.deviceEvent.findFirst({
      where: { deviceId, type: 'UNLOCK_CONFIRMED' },
    });
    expect(event?.userId).toBe(user.id);

    // The owner is told, in the same transaction as the event.
    const notification = await prisma.notification.findFirst({
      where: { userId: user.id, type: 'UNLOCK_CONFIRMED' },
    });
    expect(notification?.deviceEventId).toBe(event?.id);
  });

  /**
   * The code is spent **at the ack**, not at the confirm. That is what makes a
   * failed command releasable without ever making a successful one reusable.
   */
  it('consumes the code when the device acks, and not before', async () => {
    const { user } = await createUserWithDevice();
    const code = await getCode(user.cookie);

    const response = await post(CONFIRM_URL, user.cookie).send({ otp: code });
    const commandId = response.body.commandId as string;

    const bound = await prisma.unlockChallenge.findFirstOrThrow({});
    expect(bound.commandId).toBe(commandId);
    expect(bound.binds).toBe(1);
    expect(bound.consumedAt).toBeNull();

    await drainDeviceAcks();

    const settled = await prisma.unlockChallenge.findFirstOrThrow({});
    expect(settled.consumedAt).not.toBeNull();
  });

  it('accepts a pasted code with spaces', async () => {
    const { user } = await createUserWithDevice();
    const code = await getCode(user.cookie);

    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
    const response = await sendCommand(CONFIRM_URL, user.cookie, { otp: spaced });

    expect(response.status).toBe(202);
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
    expect((await post(CONFIRM_URL, user.cookie).send({ otp: code })).status).toBe(202);
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

  /**
   * Single-use, and the interesting thing is that it holds **at both points**.
   *
   * Before the ack the code is bound to a live command, so a replay has
   * nothing to spend. After the ack it is consumed. There is no instant in
   * between at which the same code buys a second command.
   */
  it('is single-use: a correct code cannot be replayed, before or after the ack', async () => {
    const { user } = await createUserWithDevice();
    const code = await getCode(user.cookie);

    expect((await post(CONFIRM_URL, user.cookie).send({ otp: code })).status).toBe(202);

    // While the first command is still in flight.
    const duringFlight = await post(CONFIRM_URL, user.cookie).send({ otp: code });
    expect(duringFlight.status).toBe(400);
    expect(duringFlight.body.error.code).toBe('OTP_NOT_FOUND');

    await drainDeviceAcks();

    const afterAck = await post(CONFIRM_URL, user.cookie).send({ otp: code });
    expect(afterAck.status).toBe(400);
    expect(afterAck.body.error.code).toBe('OTP_NOT_FOUND');

    // One code, one command, ever.
    expect(await prisma.command.count({ where: { type: 'UNLOCK' } })).toBe(1);
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
    expect(statuses).toEqual([202, 400]);

    const loser = a.status === 400 ? a : b;
    expect(loser.body.error.code).toBe('OTP_NOT_FOUND');

    await drainDeviceAcks();

    /**
     * One command, one movement, one event. The serialisation point moved
     * from `consumedAt` to `commandId`, and this is the property that had to
     * survive the move: the loser must not be able to allocate a second
     * sequence number and send a second command to the same bolt.
     */
    expect(await prisma.command.count({ where: { deviceId } })).toBe(1);

    const events = await prisma.deviceEvent.count({
      where: { deviceId, type: 'UNLOCK_CONFIRMED' },
    });
    expect(events).toBe(1);
  });

  it('serialises two simultaneous locks into one command', async () => {
    const { user, deviceId } = await createUserWithDevice();
    await prisma.device.update({ where: { id: deviceId }, data: { lockState: 'UNLOCKED' } });

    const [a, b] = await Promise.all([
      post(LOCK_URL, user.cookie).send({}),
      post(LOCK_URL, user.cookie).send({}),
    ]);

    /**
     * Both succeed — locking is idempotent — and both are pointed at the
     * **same** command.
     *
     * This is the shape the asynchronous model forces. The second request is
     * serialised behind the first by the device row lock, but the state has
     * not moved yet (it moves on the ack), so "is it already locked?" is still
     * no. What stops a second command is the in-flight check: the device holds
     * no queue and would reject a duplicate as `UNSUPPORTED`, so the honest
     * answer to a second tap is the command already running.
     */
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(a.body.commandId).toBe(b.body.commandId);

    await drainDeviceAcks();

    expect(await prisma.command.count({ where: { deviceId } })).toBe(1);
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

    expect((await send()).status).toBe(202);
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
