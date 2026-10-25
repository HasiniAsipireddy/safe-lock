import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { deviceGateway, drainDeviceAcks } from '../../lib/deviceGateway';
import {
  TEST_ORIGIN,
  app,
  createTestUser,
  createUserWithDevice,
  seedBooking,
  seedDevice,
  verifyUserPhone,
  withCapturedOtp,
} from '../../test/helpers';
import { sweepCommands } from './command.sweeper';
import { reconcileUnexpectedUnlock } from './reconcile.service';
import { deviceInboundHandler } from './inbound.service';
import { canonicalState, deriveCommandKey, signCanonical } from '../../lib/deviceProtocol';

/**
 * The command sweeper and the reconciler.
 *
 * The sweeper is the third worker in this codebase and the third that decides
 * nothing: `effectiveCommandStatus` derives a timeout from the clock on every
 * read, so the property under test throughout is that the sweeper **writes
 * down** what a read already knows — and does the two things a read cannot,
 * which are retrying a system lock and escalating a safe we could not close.
 *
 * Every test drives `sweepCommands()` directly. Nothing in the suite waits on
 * a timer, and the loop is started from `server.ts` only.
 */

const REQUEST_URL = '/api/v1/devices/unlock/request';
const CONFIRM_URL = '/api/v1/devices/unlock/confirm';

function post(url: string, cookie?: string) {
  const req = request(app()).post(url).set('Origin', TEST_ORIGIN);
  return cookie ? req.set('Cookie', cookie) : req;
}

/** Stops the mock from answering, so a command can be left unanswered. */
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

async function getCode(cookie: string): Promise<string> {
  const { result, code } = await withCapturedOtp(() => post(REQUEST_URL, cookie).send({}));
  expect(result.status).toBe(200);
  return code;
}

/** Ages a command so the sweeper considers it expired. */
async function expire(commandId: string, msAgo = 1_000): Promise<void> {
  await prisma.command.update({
    where: { id: commandId },
    data: { expiresAt: new Date(Date.now() - msAgo) },
  });
}

/** A state report exactly as a device would publish it, signed with its key. */
function deviceState(
  serialNumber: string,
  overrides: { lockState?: 'LOCKED' | 'UNLOCKED' | 'UNKNOWN'; lastSeq?: number } = {},
): Buffer {
  const body = {
    lockState: overrides.lockState ?? ('UNLOCKED' as const),
    doorState: 'CLOSED' as const,
    firmwareVersion: '1.0.3',
    rssi: -62,
    lastSeq: overrides.lastSeq ?? 1,
    bootId: 'stateb01',
    clockSynced: true,
    reason: 'HEARTBEAT' as const,
    uptimeMs: 918_273,
  };

  const key = deriveCommandKey(serialNumber, 1);

  return Buffer.from(
    JSON.stringify({ v: 1, ...body, sig: signCanonical(key, canonicalState(body)) }),
    'utf8',
  );
}

/** A system lock that has already failed, as a chain of `attempts` would leave it. */
async function failedSystemLock(
  deviceId: string,
  options: { attempts?: number; status?: 'TIMED_OUT' | 'FAILED'; failedMsAgo?: number } = {},
): Promise<string> {
  const failedMsAgo = options.failedMsAgo ?? 60 * 60 * 1000;
  const status = options.status ?? 'TIMED_OUT';

  // Allocated the way the real path allocates it, so a retry's sequence number
  // is genuinely higher than this one's — which is what the device requires.
  const device = await prisma.device.update({
    where: { id: deviceId },
    data: { commandSeq: { increment: 1 } },
    select: { commandSeq: true },
  });

  const command = await prisma.command.create({
    data: {
      deviceId,
      type: 'LOCK',
      status,
      failureCategory: status === 'TIMED_OUT' ? 'NO_ACK' : 'JAMMED',
      seq: device.commandSeq,
      attempts: options.attempts ?? 1,
      systemActor: 'COMPLETION',
      issuedAt: new Date(Date.now() - failedMsAgo - 15_000),
      expiresAt: new Date(Date.now() - failedMsAgo),
      ...(status === 'FAILED' ? { ackedAt: new Date(Date.now() - failedMsAgo) } : {}),
    },
    select: { id: true },
  });

  return command.id;
}

// --- Settling what expired ---------------------------------------------------

describe('a user command that was never answered', () => {
  /**
   * The timeout and the release of the code bound to it are **one
   * transaction** (§5.5). Two would leave a window in which the command is
   * finished and the code is still held hostage to it, and a user refreshing
   * inside that window would be told their code is unusable for a command that
   * has already given up on them.
   */
  it('times out, releases the code, and tells the owner why', async () => {
    const held = await createUserWithDevice();
    const restore = silenceDevice();
    const code = await getCode(held.user.cookie);

    const confirm = await post(CONFIRM_URL, held.user.cookie).send({ otp: code });
    expect(confirm.status).toBe(202);
    const commandId = confirm.body.commandId as string;

    await expire(commandId);
    const result = await sweepCommands();

    expect(result.timedOut).toBe(1);
    expect(result.expired).toBe(0);

    const command = await prisma.command.findUniqueOrThrow({ where: { id: commandId } });
    expect(command.status).toBe('TIMED_OUT');
    expect(command.failureCategory).toBe('NO_ACK');

    // Released, not consumed: a code whose command demonstrably opened nothing
    // is an unused code.
    const challenge = await prisma.unlockChallenge.findFirstOrThrow({});
    expect(challenge.commandId).toBeNull();
    expect(challenge.consumedAt).toBeNull();

    const event = await prisma.deviceEvent.findFirstOrThrow({
      where: { type: 'UNLOCK_FAILED' },
      orderBy: { createdAt: 'desc' },
    });
    expect(event.failureReason).toBe('DEVICE_TIMEOUT');

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'device.command.timed_out' },
    });
    expect(audit).not.toBeNull();

    restore();
  });

  /**
   * `EXPIRED` and `TIMED_OUT` are different facts and the feed says so. A
   * timeout means we reached the safe and it never answered, so its state is
   * unknown; a command that never left the building means we could not reach it
   * at all, and the bolt certainly did not move.
   */
  it('records a command that never left the building as EXPIRED, not a timeout', async () => {
    const held = await createUserWithDevice();

    const command = await prisma.command.create({
      data: {
        deviceId: held.deviceId,
        userId: held.user.id,
        type: 'UNLOCK',
        status: 'PENDING',
        seq: 800,
        expiresAt: new Date(Date.now() - 1_000),
      },
      select: { id: true },
    });

    const result = await sweepCommands();

    expect(result.expired).toBe(1);
    expect(result.timedOut).toBe(0);

    const settled = await prisma.command.findUniqueOrThrow({ where: { id: command.id } });
    expect(settled.status).toBe('EXPIRED');
    expect(settled.failureCategory).toBe('NOT_PUBLISHED');

    const event = await prisma.deviceEvent.findFirstOrThrow({
      where: { type: 'UNLOCK_FAILED' },
    });
    expect(event.failureReason).toBe('DEVICE_OFFLINE');
  });

  /**
   * A user command is **never** retried. A person is standing there, and a
   * silent retry would answer a question they have already stopped asking.
   */
  it('is never retried', async () => {
    const held = await createUserWithDevice();
    const restore = silenceDevice();
    const code = await getCode(held.user.cookie);

    const confirm = await post(CONFIRM_URL, held.user.cookie).send({ otp: code });
    await expire(confirm.body.commandId as string);

    await sweepCommands();
    await sweepCommands();

    expect(await prisma.command.count({ where: { deviceId: held.deviceId } })).toBe(1);

    restore();
  });

  /** An ack that beat the sweeper wins. The sweep must not walk it backwards. */
  it('leaves a command an ack already settled alone', async () => {
    const held = await createUserWithDevice();
    const code = await getCode(held.user.cookie);

    const confirm = await post(CONFIRM_URL, held.user.cookie).send({ otp: code });
    await drainDeviceAcks();

    const commandId = confirm.body.commandId as string;
    await expire(commandId);

    const result = await sweepCommands();

    expect(result.timedOut).toBe(0);
    const command = await prisma.command.findUniqueOrThrow({ where: { id: commandId } });
    expect(command.status).toBe('ACKED');
  });
});

// --- Retrying and escalating a system lock -----------------------------------

describe('a system lock nobody is waiting on', () => {
  /**
   * The asymmetry the whole design rests on: nobody is waiting, the correct end
   * state is not a judgement call, and the alternative is a safe left open
   * between renters. So this one retries — after its backoff, not before.
   */
  it('waits out its backoff, then re-issues with a fresh sequence number', async () => {
    const device = await seedDevice();
    await prisma.device.update({
      where: { id: device.id },
      data: { lockState: 'UNLOCKED' },
    });

    // Failed four seconds ago: inside the first 10-second backoff.
    const first = await failedSystemLock(device.id, { attempts: 1, failedMsAgo: 4_000 });

    expect((await sweepCommands()).retried).toBe(0);
    expect(await prisma.command.count({ where: { deviceId: device.id } })).toBe(1);

    // Now past it.
    await prisma.command.update({
      where: { id: first },
      data: { expiresAt: new Date(Date.now() - 11_000) },
    });

    expect((await sweepCommands()).retried).toBe(1);

    const commands = await prisma.command.findMany({
      where: { deviceId: device.id },
      orderBy: { seq: 'asc' },
    });
    expect(commands).toHaveLength(2);

    const retry = commands[1]!;
    expect(retry.seq).toBeGreaterThan(commands[0]!.seq);
    expect(retry.systemActor).toBe('COMPLETION');
    expect(retry.userId).toBeNull();
    // The chain is countable: one attempt before this, two after publishing.
    expect(retry.attempts).toBe(2);
  });

  /**
   * A safe that has reported itself shut has nothing left to reconcile, even if
   * the ack that would have said so was lost. The device's own report is the
   * authority on where the bolt is.
   */
  it('is not retried once the device reports itself locked', async () => {
    const device = await seedDevice();
    await failedSystemLock(device.id, { attempts: 1 });

    expect((await sweepCommands()).retried).toBe(0);
    expect(await prisma.command.count({ where: { deviceId: device.id } })).toBe(1);
  });

  /**
   * The escalation the roadmap owed this path. Before it, a safe could be
   * recorded closed while standing physically open; now it is flagged, audited
   * and — the part that matters to the next renter — unbookable.
   */
  it(`escalates after ${env.COMMAND_MAX_ATTEMPTS} attempts, and sends the safe for inspection`, async () => {
    const device = await seedDevice();
    await prisma.device.update({
      where: { id: device.id },
      data: { lockState: 'UNLOCKED' },
    });

    const commandId = await failedSystemLock(device.id, {
      attempts: env.COMMAND_MAX_ATTEMPTS,
    });

    const result = await sweepCommands();
    expect(result.escalated).toBe(1);
    expect(result.retried).toBe(0);

    const escalated = await prisma.device.findUniqueOrThrow({ where: { id: device.id } });
    expect(escalated.lockCommandFailedAt).not.toBeNull();
    expect(escalated.status).toBe('NEEDS_INSPECTION');
    expect(escalated.inspectionNote).not.toBeNull();
    // Still open, and still recorded as open: `lockState` moves only on an ack.
    expect(escalated.lockState).toBe('UNLOCKED');

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'device.lock.escalated' },
    });
    expect((audit.metadata as { commandId?: string }).commandId).toBe(commandId);

    // And nothing escalates twice, or keeps retrying afterwards: the safe is an
    // admin's problem now.
    const second = await sweepCommands();
    expect(second.escalated).toBe(0);
    expect(second.retried).toBe(0);
    expect(await prisma.command.count({ where: { deviceId: device.id } })).toBe(1);
  });

  /** A safe nobody could close must not be rentable. */
  it('leaves an escalated safe out of the booking pick', async () => {
    const device = await seedDevice();
    await prisma.device.update({
      where: { id: device.id },
      data: { lockState: 'UNLOCKED' },
    });
    await failedSystemLock(device.id, { attempts: env.COMMAND_MAX_ATTEMPTS });
    await sweepCommands();

    const user = await createTestUser();
    await verifyUserPhone(user.id);

    const response = await post('/api/v1/bookings', user.cookie).send({ hours: 2, size: 'MEDIUM' });

    // The only safe in the fleet is the escalated one — out of service, not
    // occupied, so the refusal says so.
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('NO_DEVICES_IN_SERVICE');
  });
});

// --- Reconciling a safe that should not be open ------------------------------

describe('a safe found open with nobody entitled to it', () => {
  /**
   * §8.3. The trigger is an ordinary heartbeat, because every way a bolt ends
   * up withdrawn without a command of ours — a power event, a firmware fault, a
   * completion lock lost while the process was down — surfaces as one.
   */
  it('is locked, flagged and audited on the strength of a state report', async () => {
    const device = await seedDevice();
    const restore = silenceDevice();

    await deviceInboundHandler.handleMessage(
      device.serialNumber,
      'state',
      deviceState(device.serialNumber, { lockState: 'UNLOCKED' }),
    );

    const command = await prisma.command.findFirstOrThrow({
      where: { deviceId: device.id },
    });
    expect(command.type).toBe('LOCK');
    expect(command.systemActor).toBe('SWEEPER');
    expect(command.userId).toBeNull();
    expect(command.bookingId).toBeNull();

    const flagged = await prisma.device.findUniqueOrThrow({ where: { id: device.id } });
    // Flagged on issue, not on failure: a safe found open with nobody entitled
    // to it is already an incident.
    expect(flagged.unexpectedUnlockAt).not.toBeNull();
    // And not recorded shut just because we asked.
    expect(flagged.lockState).toBe('UNLOCKED');

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'device.unexpected_unlocked.reconciled' },
    });
    expect((audit.metadata as { reason?: string }).reason).toBe('NO_ACTIVE_BOOKING');

    restore();
  });

  /** A renter's own open safe is not an incident. */
  it('leaves a safe open for a booking that permits it', async () => {
    const held = await createUserWithDevice();

    await deviceInboundHandler.handleMessage(
      held.serialNumber,
      'state',
      deviceState(held.serialNumber, { lockState: 'UNLOCKED' }),
    );

    expect(await prisma.command.count({ where: { deviceId: held.deviceId } })).toBe(0);
    const device = await prisma.device.findUniqueOrThrow({ where: { id: held.deviceId } });
    expect(device.unexpectedUnlockAt).toBeNull();
  });

  /**
   * "Permits" is `unlockEligibility`, not "has a booking". A renter whose
   * collection window lapsed an hour ago is not entitled to a safe standing
   * open, and neither is one with an unpaid overstay fee — the same function
   * that refuses to issue them a code.
   */
  it('reconciles a safe whose booking may not open it', async () => {
    const user = await createTestUser();
    await verifyUserPhone(user.id);
    const device = await seedDevice();
    const restore = silenceDevice();

    // An overstay with the fee outstanding: live booking, no entitlement.
    await seedBooking({
      userId: user.id,
      deviceId: device.id,
      status: 'OVERSTAY',
      hours: 1,
      startsAt: new Date(Date.now() - 4 * 60 * 60 * 1000),
    });

    const reconciled = await reconcileUnexpectedUnlock({
      deviceId: device.id,
      reportedLockState: 'UNLOCKED',
    });

    expect(reconciled).toBe(true);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'device.unexpected_unlocked.reconciled' },
    });
    expect((audit.metadata as { reason?: string }).reason).toBe('OVERSTAY_FEE_DUE');

    restore();
  });

  /**
   * At most one reconcile in flight per device, taken under the row lock — so a
   * safe heartbeating every 60 seconds while jammed produces one retry chain
   * rather than one per heartbeat, and a reconnect storm is harmless.
   */
  it('issues one lock however many times the device repeats itself', async () => {
    const device = await seedDevice();
    const restore = silenceDevice();

    for (let i = 0; i < 4; i += 1) {
      await deviceInboundHandler.handleMessage(
        device.serialNumber,
        'state',
        deviceState(device.serialNumber, { lockState: 'UNLOCKED', lastSeq: i }),
      );
    }

    expect(await prisma.command.count({ where: { deviceId: device.id } })).toBe(1);

    restore();
  });

  /**
   * A device that connects while *recorded* open is the other half of the
   * trigger, and the case worth catching: a status message carries no lock
   * state, and nobody would look at that safe again until its next heartbeat.
   */
  it('reconciles a device that merely reconnects while recorded open', async () => {
    const device = await seedDevice();
    await prisma.device.update({
      where: { id: device.id },
      data: { lockState: 'UNLOCKED' },
    });
    const restore = silenceDevice();

    await deviceInboundHandler.handleMessage(
      device.serialNumber,
      'status',
      Buffer.from(JSON.stringify({ v: 1, online: true, bootId: 'bootb001' }), 'utf8'),
    );

    expect(await prisma.command.count({ where: { deviceId: device.id } })).toBe(1);

    restore();
  });

  /**
   * The flag is about the **safe's state**, so what clears it is the safe
   * reporting itself shut — not a command of ours succeeding, which is only
   * evidence of that because the ack says `LOCKED`.
   */
  it('clears the flag when a later report shows the safe locked', async () => {
    const device = await seedDevice();
    await prisma.device.update({
      where: { id: device.id },
      data: { unexpectedUnlockAt: new Date(), lockState: 'UNLOCKED' },
    });

    await deviceInboundHandler.handleMessage(
      device.serialNumber,
      'state',
      deviceState(device.serialNumber, { lockState: 'LOCKED' }),
    );

    const cleared = await prisma.device.findUniqueOrThrow({ where: { id: device.id } });
    expect(cleared.unexpectedUnlockAt).toBeNull();
    expect(cleared.lockState).toBe('LOCKED');
  });
});
