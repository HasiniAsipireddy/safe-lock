import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { CHALLENGE_MAX_BINDS } from '@safelock/shared';
import { prisma } from '../../lib/prisma';
import { deviceGateway, drainDeviceAcks } from '../../lib/deviceGateway';
import {
  canonicalAck,
  deriveCommandKey,
  signCanonical,
} from '../../lib/deviceProtocol';
import {
  TEST_ORIGIN,
  app,
  createUserWithDevice,
  seedBooking,
  seedDevice,
  withCapturedOtp,
} from '../../test/helpers';
import { deviceInboundHandler } from './inbound.service';
import { effectiveCommandStatus } from './command.mapper';

/**
 * The command lifecycle, from the angles a route test cannot reach.
 *
 * A happy-path unlock through the API exercises the lifecycle only in its
 * easiest shape: a prompt, valid, correctly-signed `OK`. The interesting
 * behaviour is everywhere else — an ack that disagrees with the command, one
 * for another device, one that arrives after we gave up — so these drive the
 * inbound handler directly with payloads a device could actually send.
 */

const LOCK_URL = '/api/v1/devices/lock';
const REQUEST_URL = '/api/v1/devices/unlock/request';
const CONFIRM_URL = '/api/v1/devices/unlock/confirm';

function post(url: string, cookie?: string) {
  const req = request(app()).post(url).set('Origin', TEST_ORIGIN);
  return cookie ? req.set('Cookie', cookie) : req;
}

function get(url: string, cookie: string) {
  return request(app()).get(url).set('Cookie', cookie);
}

async function getCode(cookie: string): Promise<string> {
  const { result, code } = await withCapturedOtp(() => post(REQUEST_URL, cookie).send({}));
  expect(result.status).toBe(200);
  return code;
}

/** An ack exactly as a device would publish it, signed with its real key. */
function deviceAck(
  serialNumber: string,
  overrides: {
    commandId: string;
    seq?: number;
    result?: 'OK' | 'REJECTED' | 'FAILED';
    reason?: string | null;
    lockState?: 'LOCKED' | 'UNLOCKED' | 'UNKNOWN';
    doorState?: 'CLOSED' | 'OPEN' | 'UNKNOWN';
    signWith?: string;
  },
): Buffer {
  const body = {
    commandId: overrides.commandId,
    seq: overrides.seq ?? 1,
    result: overrides.result ?? ('OK' as const),
    reason: overrides.reason ?? null,
    lockState: overrides.lockState ?? ('UNLOCKED' as const),
    doorState: overrides.doorState ?? ('CLOSED' as const),
    bootId: 'ackb0001',
    measuredAtUptimeMs: 12_345,
  };

  const key = deriveCommandKey(overrides.signWith ?? serialNumber, 1);

  return Buffer.from(
    JSON.stringify({ v: 1, ...body, sig: signCanonical(key, canonicalAck(body)) }),
    'utf8',
  );
}

/** Stops the mock from answering, so a test can answer on its behalf. */
function silenceDevice() {
  const lock = vi
    .spyOn(deviceGateway, 'sendLock')
    .mockResolvedValue({ published: true, publishedAt: new Date() });
  const unlock = vi
    .spyOn(deviceGateway, 'sendUnlock')
    .mockResolvedValue({ published: true, publishedAt: new Date() });

  return () => {
    lock.mockRestore();
    unlock.mockRestore();
  };
}

// --- Sequence allocation -----------------------------------------------------

describe('sequence allocation', () => {
  /**
   * Monotonic per device, which is what makes a captured command unreplayable:
   * its number is already spent. Not *contiguous* — a rolled-back transaction
   * leaves a gap, and the device requires increasing rather than consecutive.
   */
  it('increases per device and is independent between devices', async () => {
    const first = await createUserWithDevice();
    const second = await createUserWithDevice();

    for (const held of [first, second]) {
      await prisma.device.update({
        where: { id: held.deviceId },
        data: { lockState: 'UNLOCKED' },
      });
      await post(LOCK_URL, held.user.cookie).send({});
      await drainDeviceAcks();
      await prisma.device.update({
        where: { id: held.deviceId },
        data: { lockState: 'UNLOCKED' },
      });
      await post(LOCK_URL, held.user.cookie).send({});
      await drainDeviceAcks();
    }

    for (const held of [first, second]) {
      const seqs = await prisma.command.findMany({
        where: { deviceId: held.deviceId },
        orderBy: { seq: 'asc' },
        select: { seq: true },
      });
      expect(seqs.map((row) => row.seq)).toEqual([1, 2]);
    }
  });
});

// --- What the server will not command ----------------------------------------

describe('which safes may be commanded', () => {
  /**
   * The sibling of the retired-credential test, and the reason they belong
   * together: between them they are the whole answer to "which safes can still
   * be commanded".
   *
   * `NEEDS_INSPECTION` **keeps its MQTT credential** — it is still in the
   * field, still ours, and an admin needs to reach it to report its state and
   * accept a lock. Keeping a live credential is not the same as keeping a live
   * safe, so the refusal lives in the issuer rather than depending on broker
   * state or on the booking pick having excluded it.
   */
  it('never issues UNLOCK to a device awaiting inspection', async () => {
    const { user, deviceId } = await createUserWithDevice();
    const code = await getCode(user.cookie);

    await prisma.device.update({
      where: { id: deviceId },
      data: { status: 'NEEDS_INSPECTION' },
    });

    const response = await post(CONFIRM_URL, user.cookie).send({ otp: code });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('DEVICE_NOT_OPERABLE');

    // Nothing was published, and nothing was recorded as published.
    expect(await prisma.command.count({ where: { deviceId } })).toBe(0);

    const device = await prisma.device.findUniqueOrThrow({ where: { id: deviceId } });
    expect(device.lockState).toBe('LOCKED');
    // The credential survives: the refusal is a decision, not a disconnection.
    expect(device.credentialIssuedAt).not.toBeNull();
  });

  /**
   * LOCK is still permitted to an inspecting safe. It is exactly the safe an
   * admin may need to close, and locking is the safe direction everywhere else
   * in this system too.
   */
  it('still issues LOCK to a device awaiting inspection', async () => {
    const { user, deviceId } = await createUserWithDevice();
    await prisma.device.update({
      where: { id: deviceId },
      data: { lockState: 'UNLOCKED', status: 'NEEDS_INSPECTION' },
    });

    const response = await post(LOCK_URL, user.cookie).send({});

    expect(response.status).toBe(202);
    await drainDeviceAcks();

    const device = await prisma.device.findUniqueOrThrow({ where: { id: deviceId } });
    expect(device.lockState).toBe('LOCKED');
  });
});

// --- Acks the server must refuse ---------------------------------------------

describe('acks the server refuses', () => {
  async function pendingUnlock() {
    const held = await createUserWithDevice();
    const restore = silenceDevice();
    const code = await getCode(held.user.cookie);

    const response = await post(CONFIRM_URL, held.user.cookie).send({ otp: code });
    expect(response.status).toBe(202);

    return { ...held, commandId: response.body.commandId as string, restore };
  }

  it('drops an ack whose signature does not verify, and audits it', async () => {
    const { deviceId, serialNumber, commandId, restore } = await pendingUnlock();

    // Signed with another device's key: the shape of a compromised broker, or
    // of a device attacking its neighbour.
    await deviceInboundHandler.handleMessage(
      serialNumber,
      'ack',
      deviceAck(serialNumber, { commandId, signWith: 'SAFE-9999' }),
    );

    const command = await prisma.command.findUniqueOrThrow({ where: { id: commandId } });
    expect(command.status).toBe('SENT');

    const device = await prisma.device.findUniqueOrThrow({ where: { id: deviceId } });
    expect(device.lockState).toBe('LOCKED');

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'device.message.signature_invalid', deviceId },
    });
    expect(audit).not.toBeNull();

    restore();
  });

  /**
   * A device may only ack **its own** commands, checked by joining the command
   * to the serial the message arrived on. Without that check, any device
   * holding a valid key could settle another device's command by quoting its
   * id — and it would be correctly signed, because it signs with its own key.
   */
  it('drops an ack for another device’s command', async () => {
    const { deviceId, commandId, restore } = await pendingUnlock();
    const intruder = await seedDevice();

    await deviceInboundHandler.handleMessage(
      intruder.serialNumber,
      'ack',
      deviceAck(intruder.serialNumber, { commandId }),
    );

    const command = await prisma.command.findUniqueOrThrow({ where: { id: commandId } });
    expect(command.status).toBe('SENT');

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'device.ack.foreign_command', deviceId: intruder.id },
    });
    expect(audit).not.toBeNull();

    // The real device's state is untouched.
    const device = await prisma.device.findUniqueOrThrow({ where: { id: deviceId } });
    expect(device.lockState).toBe('LOCKED');

    restore();
  });

  it('drops a second ack for the same command, writing no second event', async () => {
    const { user, serialNumber, commandId, restore } = await pendingUnlock();

    const ack = deviceAck(serialNumber, { commandId });
    await deviceInboundHandler.handleMessage(serialNumber, 'ack', ack);
    await deviceInboundHandler.handleMessage(serialNumber, 'ack', ack);

    expect(
      await prisma.deviceEvent.count({ where: { userId: user.id, type: 'UNLOCK_CONFIRMED' } }),
    ).toBe(1);
    expect(await prisma.notification.count({ where: { userId: user.id } })).toBe(1);

    restore();
  });

  /**
   * An ack whose signature is right but whose shape is wrong — a `REJECTED`
   * carrying a mechanism reason — is dropped at the schema. A device that
   * disagrees with us about which group a reason belongs to is a device whose
   * acks we cannot interpret, and guessing which half it meant would be
   * guessing about whether a bolt moved.
   */
  it('drops an ack whose reason contradicts its result', async () => {
    const { serialNumber, commandId, restore } = await pendingUnlock();

    await deviceInboundHandler.handleMessage(
      serialNumber,
      'ack',
      deviceAck(serialNumber, { commandId, result: 'REJECTED', reason: 'MOTOR_FAULT' }),
    );

    const command = await prisma.command.findUniqueOrThrow({ where: { id: commandId } });
    expect(command.status).toBe('SENT');

    restore();
  });
});

// --- The measurement wins ----------------------------------------------------

describe('the measured state, not the requested one', () => {
  /**
   * The consequence worth stating out loud: a `FAILED` unlock whose ack
   * reports `UNLOCKED` still moves the stored state to `UNLOCKED`. The command
   * failed; the safe is open; the dashboard must say the safe is open.
   * Recording the intent instead of the measurement is how a product ends up
   * telling someone their safe is locked while it stands open.
   */
  it('records UNLOCKED from a FAILED ack that reports the bolt open', async () => {
    const held = await createUserWithDevice();
    const restore = silenceDevice();
    const code = await getCode(held.user.cookie);

    const response = await post(CONFIRM_URL, held.user.cookie).send({ otp: code });
    const commandId = response.body.commandId as string;

    await deviceInboundHandler.handleMessage(
      held.serialNumber,
      'ack',
      deviceAck(held.serialNumber, {
        commandId,
        result: 'FAILED',
        reason: 'JAMMED',
        lockState: 'UNLOCKED',
        doorState: 'OPEN',
      }),
    );

    const command = await prisma.command.findUniqueOrThrow({ where: { id: commandId } });
    expect(command.status).toBe('FAILED');
    expect(command.failureCategory).toBe('JAMMED');

    const device = await prisma.device.findUniqueOrThrow({ where: { id: held.deviceId } });
    expect(device.lockState).toBe('UNLOCKED');
    expect(device.doorState).toBe('OPEN');

    // The command failed, so the owner's feed says the unlock failed — and
    // the device row says the safe is open. Both are true.
    const event = await prisma.deviceEvent.findFirstOrThrow({
      where: { userId: held.user.id, type: 'UNLOCK_FAILED' },
    });
    expect(event.failureReason).toBe('DEVICE_FAILED');

    restore();
  });

  /**
   * A demonstrated failure releases the code, because burning it for our
   * motor fault would charge the user for our hardware's mistake.
   */
  it('releases the code when the command demonstrably opened nothing', async () => {
    const held = await createUserWithDevice();
    const restore = silenceDevice();
    const code = await getCode(held.user.cookie);

    const first = await post(CONFIRM_URL, held.user.cookie).send({ otp: code });
    await deviceInboundHandler.handleMessage(
      held.serialNumber,
      'ack',
      deviceAck(held.serialNumber, {
        commandId: first.body.commandId as string,
        result: 'REJECTED',
        reason: 'SEQ_REPLAY',
        lockState: 'LOCKED',
      }),
    );

    const challenge = await prisma.unlockChallenge.findFirstOrThrow({});
    expect(challenge.commandId).toBeNull();
    expect(challenge.consumedAt).toBeNull();
    // Nothing was extended to make this work: the attacker's five guesses are
    // still five guesses inside the same five minutes.
    expect(challenge.attempts).toBe(0);

    // So the same code buys another attempt.
    const second = await post(CONFIRM_URL, held.user.cookie).send({ otp: code });
    expect(second.status).toBe(202);
    expect(second.body.commandId).not.toBe(first.body.commandId);

    restore();
  });

  it(`stops rebinding one code after ${CHALLENGE_MAX_BINDS} failed commands`, async () => {
    const held = await createUserWithDevice();
    const restore = silenceDevice();
    const code = await getCode(held.user.cookie);

    for (let attempt = 0; attempt < CHALLENGE_MAX_BINDS; attempt += 1) {
      const response = await post(CONFIRM_URL, held.user.cookie).send({ otp: code });
      expect(response.status).toBe(202);

      await deviceInboundHandler.handleMessage(
        held.serialNumber,
        'ack',
        deviceAck(held.serialNumber, {
          commandId: response.body.commandId as string,
          seq: attempt + 1,
          result: 'FAILED',
          reason: 'MOTOR_FAULT',
          lockState: 'LOCKED',
        }),
      );
    }

    const exhausted = await post(CONFIRM_URL, held.user.cookie).send({ otp: code });
    expect(exhausted.status).toBe(409);
    expect(exhausted.body.error.code).toBe('OTP_BIND_LIMIT_REACHED');

    // And the code is now dead, not merely out of binds — a jammed motor and
    // a determined user must not be able to spawn commands indefinitely.
    const challenge = await prisma.unlockChallenge.findFirstOrThrow({});
    expect(challenge.consumedAt).not.toBeNull();

    restore();
  });
});

// --- The late ack ------------------------------------------------------------

describe('a late ack after a timeout', () => {
  /**
   * The amendment this commit exists to get right.
   *
   * A timeout releases the code — provisionally, because a release says only
   * *we have no evidence the bolt moved*. Evidence can still arrive. When it
   * does, the code goes back to being used, and **one code can never unlock
   * twice**.
   */
  it('consumes the released code, so one code can never unlock twice', async () => {
    const held = await createUserWithDevice();
    const restore = silenceDevice();
    const code = await getCode(held.user.cookie);

    const response = await post(CONFIRM_URL, held.user.cookie).send({ otp: code });
    const commandId = response.body.commandId as string;

    // The timeout, with the release in the same transaction as the status
    // change — simulated here as the sweeper would write it.
    await prisma.$transaction(async (tx) => {
      await tx.command.update({
        where: { id: commandId },
        data: { status: 'TIMED_OUT', failureCategory: 'NO_ACK' },
      });
      await tx.unlockChallenge.updateMany({
        where: { commandId, consumedAt: null },
        data: { commandId: null },
      });
    });

    const released = await prisma.unlockChallenge.findFirstOrThrow({});
    expect(released.commandId).toBeNull();
    expect(released.consumedAt).toBeNull();

    // The bolt moved after all.
    await deviceInboundHandler.handleMessage(
      held.serialNumber,
      'ack',
      deviceAck(held.serialNumber, { commandId, lockState: 'UNLOCKED' }),
    );

    const command = await prisma.command.findUniqueOrThrow({ where: { id: commandId } });
    expect(command.status).toBe('ACKED');
    // The row remembers that we had already given up, so a dashboard showing
    // "failed" and a database saying "acked" is explainable rather than a
    // contradiction.
    expect(command.lateAckedAt).not.toBeNull();

    const device = await prisma.device.findUniqueOrThrow({ where: { id: held.deviceId } });
    expect(device.lockState).toBe('UNLOCKED');

    /**
     * The code is spent. This is the assertion the amendment asked for: a
     * released code that turns out to have opened a safe is a used code.
     */
    const challenge = await prisma.unlockChallenge.findFirstOrThrow({});
    expect(challenge.consumedAt).not.toBeNull();

    const replay = await post(CONFIRM_URL, held.user.cookie).send({ otp: code });
    expect(replay.status).toBe(400);
    expect(replay.body.error.code).toBe('OTP_NOT_FOUND');

    // One code, one command, even across a timeout and a late answer.
    expect(await prisma.command.count({ where: { type: 'UNLOCK' } })).toBe(1);

    restore();
  });

  /**
   * The safe is open; the owner's security log must say so — even though the
   * request returned a failure. The notification fires here too, which is when
   * it is most useful: the user has been told it failed and needs to know it
   * did not.
   */
  it('writes the event and notifies, even though the user was told it failed', async () => {
    const held = await createUserWithDevice();
    const restore = silenceDevice();
    const code = await getCode(held.user.cookie);

    const response = await post(CONFIRM_URL, held.user.cookie).send({ otp: code });
    const commandId = response.body.commandId as string;

    await prisma.command.update({
      where: { id: commandId },
      data: { status: 'TIMED_OUT', failureCategory: 'NO_ACK' },
    });

    await deviceInboundHandler.handleMessage(
      held.serialNumber,
      'ack',
      deviceAck(held.serialNumber, { commandId }),
    );

    const event = await prisma.deviceEvent.findFirstOrThrow({
      where: { userId: held.user.id, type: 'UNLOCK_CONFIRMED' },
    });
    const notification = await prisma.notification.findFirstOrThrow({
      where: { userId: held.user.id, type: 'UNLOCK_CONFIRMED' },
    });
    expect(notification.deviceEventId).toBe(event.id);

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'device.command.late_ack', deviceId: held.deviceId },
    });
    expect(audit).not.toBeNull();

    restore();
  });

  /**
   * Past the horizon the correlation is not worth trusting — but the
   * **measurement still is**. The same shape of decision as the reminder
   * staleness floor: late is false, while the thing it describes is real.
   */
  it('applies the state but drops the command past the late-ack horizon', async () => {
    const held = await createUserWithDevice();
    const restore = silenceDevice();
    const code = await getCode(held.user.cookie);

    const response = await post(CONFIRM_URL, held.user.cookie).send({ otp: code });
    const commandId = response.body.commandId as string;

    await prisma.command.update({
      where: { id: commandId },
      data: {
        status: 'TIMED_OUT',
        failureCategory: 'NO_ACK',
        expiresAt: new Date(Date.now() - 60 * 60 * 1000),
      },
    });

    await deviceInboundHandler.handleMessage(
      held.serialNumber,
      'ack',
      deviceAck(held.serialNumber, { commandId, lockState: 'UNLOCKED' }),
    );

    const command = await prisma.command.findUniqueOrThrow({ where: { id: commandId } });
    expect(command.status).toBe('TIMED_OUT');

    // The state is applied anyway: an hour-old measurement of an open safe is
    // still a measurement of an open safe.
    const device = await prisma.device.findUniqueOrThrow({ where: { id: held.deviceId } });
    expect(device.lockState).toBe('UNLOCKED');

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'device.ack.too_late', deviceId: held.deviceId },
    });
    expect(audit).not.toBeNull();

    restore();
  });
});

// --- The no-queue rule -------------------------------------------------------

describe('one command at a time', () => {
  /**
   * The device holds no queue by design, and rejects a second command as
   * `UNSUPPORTED`. The server anticipates that rather than spending a sequence
   * number to discover it.
   */
  it('refuses an unlock while a system lock is in flight', async () => {
    const held = await createUserWithDevice();
    const restore = silenceDevice();
    const code = await getCode(held.user.cookie);

    // A completion lock, still unanswered.
    await prisma.command.create({
      data: {
        deviceId: held.deviceId,
        type: 'LOCK',
        status: 'SENT',
        seq: 500,
        systemActor: 'COMPLETION',
        expiresAt: new Date(Date.now() + 15_000),
      },
    });

    const response = await post(CONFIRM_URL, held.user.cookie).send({ otp: code });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('DEVICE_BUSY');

    // Refused before the bind, so the code cost nothing.
    const challenge = await prisma.unlockChallenge.findFirstOrThrow({});
    expect(challenge.binds).toBe(0);
    expect(challenge.commandId).toBeNull();

    restore();
  });

  /**
   * An *expired* in-flight command is not in flight. Derived from the clock
   * rather than trusted from the status, so a wedged sweeper cannot lock a
   * user out of their own safe.
   */
  it('ignores a command that is past its expiry', async () => {
    const held = await createUserWithDevice();
    await prisma.command.create({
      data: {
        deviceId: held.deviceId,
        type: 'LOCK',
        status: 'SENT',
        seq: 500,
        systemActor: 'COMPLETION',
        expiresAt: new Date(Date.now() - 1_000),
      },
    });

    const code = await getCode(held.user.cookie);
    const response = await post(CONFIRM_URL, held.user.cookie).send({ otp: code });

    expect(response.status).toBe(202);
    await drainDeviceAcks();
  });
});

// --- The status endpoint -----------------------------------------------------

describe('GET /devices/commands/:id', () => {
  it('reports a settled command to the caller who issued it', async () => {
    const held = await createUserWithDevice();
    const code = await getCode(held.user.cookie);

    const response = await post(CONFIRM_URL, held.user.cookie).send({ otp: code });
    await drainDeviceAcks();

    const status = await get(
      `/api/v1/devices/commands/${response.body.commandId}`,
      held.user.cookie,
    );

    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      type: 'UNLOCK',
      status: 'ACKED',
      settled: true,
      failureCategory: null,
      lockState: 'UNLOCKED',
    });
  });

  /**
   * **404, not 403.** A 403 would confirm the id exists, and a command id is
   * the kind of thing that ends up in a URL or a log a user can see.
   */
  it("answers 404 for someone else's command", async () => {
    const owner = await createUserWithDevice();
    const stranger = await createUserWithDevice();
    const code = await getCode(owner.user.cookie);

    const response = await post(CONFIRM_URL, owner.user.cookie).send({ otp: code });
    await drainDeviceAcks();

    const status = await get(
      `/api/v1/devices/commands/${response.body.commandId}`,
      stranger.user.cookie,
    );

    expect(status.status).toBe(404);
    expect(status.body.error.code).toBe('COMMAND_NOT_FOUND');
  });

  /**
   * Derived from the clock on every read, so a late, wedged or never-started
   * sweeper shows the user the right answer and merely leaves rows untidy.
   * Correctness never depends on a worker.
   */
  it('reports a timeout from the clock, before any sweeper has run', async () => {
    const held = await createUserWithDevice();
    const restore = silenceDevice();
    const code = await getCode(held.user.cookie);

    const response = await post(CONFIRM_URL, held.user.cookie).send({ otp: code });
    const commandId = response.body.commandId as string;

    // Still SENT in the database. Only the clock has moved.
    await prisma.command.update({
      where: { id: commandId },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    const status = await get(`/api/v1/devices/commands/${commandId}`, held.user.cookie);

    expect(status.body.status).toBe('TIMED_OUT');
    expect(status.body.settled).toBe(true);
    expect(status.body.failureCategory).toBe('NO_ACK');

    // The stored row is untouched — the derivation is a read, not a write.
    const stored = await prisma.command.findUniqueOrThrow({ where: { id: commandId } });
    expect(stored.status).toBe('SENT');

    restore();
  });
});

describe('effectiveCommandStatus', () => {
  const now = new Date('2026-10-19T12:00:00.000Z');
  const past = new Date(now.getTime() - 1_000);
  const future = new Date(now.getTime() + 1_000);

  it.each([
    ['PENDING past its expiry never left the building', 'PENDING', past, 'EXPIRED'],
    ['SENT past its expiry is unanswered', 'SENT', past, 'TIMED_OUT'],
    ['PENDING in time is still pending', 'PENDING', future, 'PENDING'],
    ['SENT in time is still sent', 'SENT', future, 'SENT'],
  ] as const)('%s', (_label, status, expiresAt, expected) => {
    expect(effectiveCommandStatus({ status, expiresAt }, now)).toBe(expected);
  });

  /**
   * Only ever moves a non-terminal status to a terminal one, so an ack that
   * arrived a millisecond before the expiry is never reported as a timeout.
   */
  it('cannot revive or override a settled command', () => {
    expect(effectiveCommandStatus({ status: 'ACKED', expiresAt: past }, now)).toBe('ACKED');
    expect(effectiveCommandStatus({ status: 'REJECTED', expiresAt: past }, now)).toBe(
      'REJECTED',
    );
  });
});

// --- The completion lock -----------------------------------------------------

describe('the completion lock', () => {
  /**
   * No longer best effort. It used to call the gateway, log a failure and
   * shrug — tolerable against a mock that always acked, and not against
   * hardware, where a safe between renters could be recorded closed while
   * standing physically open.
   */
  it('issues a system command with no user and no booking', async () => {
    const { user, deviceId, bookingId } = await createUserWithDevice();
    await prisma.device.update({
      where: { id: deviceId },
      data: { lockState: 'UNLOCKED' },
    });

    const collect = await post(`/api/v1/bookings/${bookingId}/collect`, user.cookie).send({});
    expect(collect.status).toBe(200);
    await drainDeviceAcks();

    const command = await prisma.command.findFirstOrThrow({ where: { deviceId } });
    expect(command.type).toBe('LOCK');
    expect(command.systemActor).toBe('COMPLETION');
    // Nobody is waiting on it, which is exactly what licenses it to retry.
    expect(command.userId).toBeNull();
    expect(command.status).toBe('ACKED');

    const device = await prisma.device.findUniqueOrThrow({ where: { id: deviceId } });
    expect(device.lockState).toBe('LOCKED');
  });

  /**
   * A system command writes no row to anyone's activity feed: there is no
   * owner whose action it was. Its record is the command row and the audit
   * trail, which is where an admin looks.
   */
  it('writes no user-facing event', async () => {
    const { user, deviceId, bookingId } = await createUserWithDevice();
    await prisma.device.update({
      where: { id: deviceId },
      data: { lockState: 'UNLOCKED' },
    });

    await post(`/api/v1/bookings/${bookingId}/collect`, user.cookie).send({});
    await drainDeviceAcks();

    expect(await prisma.deviceEvent.count({ where: { deviceId, type: 'LOCK' } })).toBe(0);
    expect(await prisma.notification.count({ where: { userId: user.id } })).toBe(0);
  });

  /**
   * One live system command per device, which the partial unique index also
   * enforces. Two commands racing to the same bolt is how a device ends up
   * rejecting the one we care about as a duplicate.
   */
  it('does not issue a second system lock while one is in flight', async () => {
    const device = await seedDevice();
    await prisma.command.create({
      data: {
        deviceId: device.id,
        type: 'LOCK',
        status: 'SENT',
        seq: 1,
        systemActor: 'SWEEPER',
        expiresAt: new Date(Date.now() + 15_000),
      },
    });

    const { lockAfterCompletion } = await import('../bookings/booking.service');
    await lockAfterCompletion(device.id);

    expect(await prisma.command.count({ where: { deviceId: device.id } })).toBe(1);
  });

  /**
   * The database refuses it too, not just the service check. A check is a read
   * followed by a write, and a device heartbeating every 60 seconds while
   * jammed is a case made of concurrency.
   */
  it('is refused by the database as well as by the service', async () => {
    const device = await seedDevice();
    const row = {
      deviceId: device.id,
      type: 'LOCK' as const,
      status: 'SENT' as const,
      systemActor: 'SWEEPER' as const,
      expiresAt: new Date(Date.now() + 15_000),
    };

    await prisma.command.create({ data: { ...row, seq: 1 } });

    await expect(prisma.command.create({ data: { ...row, seq: 2 } })).rejects.toThrow();

    // A user command is deliberately outside the constraint: it is answered
    // rather than retried, and two tabs racing are already serialised by the
    // device row lock.
    const user = await createUserWithDevice();
    await seedBooking({ userId: user.user.id, deviceId: device.id, status: 'COMPLETED' });
    await expect(
      prisma.command.create({
        data: { ...row, seq: 3, systemActor: null, userId: user.user.id },
      }),
    ).resolves.toBeTruthy();
  });
});
