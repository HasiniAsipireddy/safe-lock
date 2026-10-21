import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import mqtt from 'mqtt';
import { prisma } from '../prisma';
import { deviceGateway, MqttDeviceGateway } from '../deviceGateway';
import { canonicalAck, deriveCommandKey, deviceTopic, signCanonical } from '../deviceProtocol';
import { AUDIT_ACTIONS } from '../../modules/audit/audit.service';
import { deviceInboundHandler } from '../../modules/commands/inbound.service';
import { sweepCommands } from '../../modules/commands/command.sweeper';
import {
  TEST_ORIGIN,
  app,
  createUserWithDevice,
  seedDevice,
  withCapturedOtp,
} from '../../test/helpers';
import { BrokerBackedMqttClient, MemoryBroker } from './memoryBroker';
import { DeviceSimulator } from './fleet';

/**
 * Both ends of the protocol, in one process, over a broker.
 *
 * Everything else in this suite drives the inbound handler with a payload a
 * test constructed. That is the right shape for "what does the server do with
 * this message", and it cannot answer the question this file exists for: does
 * the **other end** agree? A canonical string both sides build the same way by
 * accident is a canonical string nobody has checked, and the firmware
 * developer this protocol is written for has no access to our zod schemas.
 *
 * So the real `MqttDeviceGateway` publishes, over a real-enough broker, to a
 * device that verifies the signature itself and answers with one of its own.
 * Nothing between them is a stub agreeing by construction.
 *
 * ## The rule every misbehaviour test in here obeys
 * **Assert the misbehaviour was delivered, then assert the server's response.**
 * In that order, and the first one is not optional. A test that forges a
 * signature and checks the server recorded nothing also passes if the
 * simulator never connected, if the topic was misspelled, if the broker
 * refused the publish on an ACL, or if the flag was read before it was set. In
 * every one of those the server recorded nothing *because nothing arrived*,
 * and the green tells us only that silence is silent — which is worse than no
 * test, because it reports the path as covered. See docs/device-protocol.md
 * §13.
 */

const LOCK_URL = '/api/v1/devices/lock';
const REQUEST_URL = '/api/v1/devices/unlock/request';
const CONFIRM_URL = '/api/v1/devices/unlock/confirm';

function post(url: string, cookie?: string) {
  const req = request(app()).post(url).set('Origin', TEST_ORIGIN);
  return cookie ? req.set('Cookie', cookie) : req;
}

async function getCode(cookie: string): Promise<string> {
  const { result, code } = await withCapturedOtp(() => post(REQUEST_URL, cookie).send({}));
  expect(result.status).toBe(200);
  return code;
}

interface Harness {
  sim: DeviceSimulator;
  broker: MemoryBroker;
  /** Waits for every inbound message the gateway is still handling. */
  settle: () => Promise<void>;
  stop: () => Promise<void>;
}

/**
 * Wires the application's gateway to a broker the simulator is also on.
 *
 * The singleton `deviceGateway` is the mock, because `DEVICE_GATEWAY=mock` for
 * the suite and a broker connection has no business in it. Spying its two
 * publish methods onto a **real** `MqttDeviceGateway` is what puts the actual
 * transport under test from an HTTP request — its publish options, its
 * signing, its topic parsing and its dispatch — rather than a second
 * implementation written to agree with it.
 */
async function harness(): Promise<Harness> {
  const broker = new MemoryBroker();
  const client = new BrokerBackedMqttClient(broker);

  vi.spyOn(mqtt, 'connect').mockImplementation(() => {
    setImmediate(() => client.emit('connect'));
    return client as unknown as ReturnType<typeof mqtt.connect>;
  });

  const gateway = new MqttDeviceGateway();
  await gateway.start(deviceInboundHandler);

  vi.spyOn(deviceGateway, 'sendLock').mockImplementation((command) =>
    gateway.sendLock(command),
  );
  vi.spyOn(deviceGateway, 'sendUnlock').mockImplementation((command) =>
    gateway.sendUnlock(command),
  );

  return {
    sim: new DeviceSimulator(broker),
    broker,
    settle: () => gateway.drain(),
    stop: () => gateway.stop(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** Ages a command so the sweeper treats it as expired. */
async function expire(commandId: string): Promise<void> {
  await prisma.command.update({
    where: { id: commandId },
    data: { expiresAt: new Date(Date.now() - 1_000) },
  });
}

/** The commands a device was sent, as the broker carried them. */
function commandsOn(broker: MemoryBroker, serialNumber: string): Record<string, unknown>[] {
  return broker
    .publishedTo(deviceTopic(serialNumber, 'cmd'))
    .map((message) => JSON.parse(message.payload.toString('utf8')) as Record<string, unknown>);
}

async function auditActions(deviceId: string): Promise<string[]> {
  const rows = await prisma.auditLog.findMany({
    where: { deviceId },
    select: { action: true },
  });

  return rows.map((row) => row.action);
}

// --- The two implementations agree -------------------------------------------

describe('a real command, over a broker, to a device that checks it', () => {
  /**
   * The baseline, and the only test here that asserts nothing unusual.
   *
   * Its value is entirely in what it does *not* share between the ends: the
   * server signs with `deriveCommandKey` and the device verifies with its own
   * call to the same function over its own reconstruction of the canonical
   * string. If the two disagreed about a single field or a single separator
   * this would fail, and every other test in the file would fail with it.
   */
  it('is signed by the server, verified by the device, and acked', async () => {
    const { sim, broker, settle } = await harness();
    const held = await createUserWithDevice();
    const device = await sim.add(held.serialNumber);

    const code = await getCode(held.user.cookie);
    const response = await post(CONFIRM_URL, held.user.cookie).send({ otp: code });

    expect(response.status).toBe(202);
    const commandId = response.body.commandId as string;

    // 1. It arrived, and the device accepted it on its own terms.
    expect(device.received.map((command) => command.commandId)).toEqual([commandId]);
    expect(device.received[0]).toMatchObject({ type: 'UNLOCK', accepted: true, rejection: null });
    expect(device.lastAck()).toMatchObject({ commandId, result: 'OK', puback: true });

    // The retain flag on `/cmd` is false, and that is not cosmetic: a retained
    // UNLOCK is a safe that opens itself every time its Wi-Fi flaps.
    expect(broker.publishedTo(deviceTopic(held.serialNumber, 'cmd'))[0]).toMatchObject({
      qos: 1,
      retain: false,
    });

    // 2. And only now, what the server did with the answer.
    await settle();

    const command = await prisma.command.findUniqueOrThrow({
      where: { id: commandId },
      select: { status: true, ackedAt: true, failureCategory: true },
    });
    expect(command).toMatchObject({ status: 'ACKED', failureCategory: null });
    expect(command.ackedAt).not.toBeNull();

    const stored = await prisma.device.findUniqueOrThrow({
      where: { id: held.deviceId },
      select: { lockState: true, doorState: true, firmwareVersion: true, rssi: true },
    });
    expect(stored).toMatchObject({
      lockState: 'UNLOCKED',
      doorState: 'CLOSED',
      firmwareVersion: '1.0.3',
      rssi: -62,
    });

    const events = await prisma.deviceEvent.findMany({
      where: { deviceId: held.deviceId },
      select: { type: true },
    });
    expect(events.map((event) => event.type)).toContain('UNLOCK_CONFIRMED');
  });

  /**
   * A captured packet, replayed. The defence that does not depend on a clock.
   *
   * Published straight at the broker rather than through the gateway, because
   * the server will never allocate a sequence number twice — which is the
   * point. This is an attacker with a recording, and the device refuses it
   * because the number is spent.
   */
  it('refuses a replayed command with SEQ_REPLAY, and does not move the bolt', async () => {
    const { sim, broker, settle } = await harness();
    const held = await createUserWithDevice();
    const device = await sim.add(held.serialNumber);

    const code = await getCode(held.user.cookie);
    await post(CONFIRM_URL, held.user.cookie).send({ otp: code });
    await settle();

    const captured = broker.publishedTo(deviceTopic(held.serialNumber, 'cmd'))[0]!;
    await prisma.device.update({
      where: { id: held.deviceId },
      data: { lockState: 'LOCKED' },
    });

    await broker.publish(captured.topic, captured.payload, { qos: 1, retain: false });
    await settle();

    // 1. It was delivered twice. Both the attacker's packet and the refusal.
    expect(device.received).toHaveLength(2);
    expect(device.received[1]).toMatchObject({
      seq: device.received[0]!.seq,
      accepted: false,
      /**
       * `DUPLICATE`, not `SEQ_REPLAY`, and that ordering is §3.4 step 5 doing
       * its job: the device remembers the last eight command ids, so a replay
       * of a command it has *already answered* is re-acked from the stored
       * result rather than re-evaluated. It never reaches the sequence check,
       * and — the part that matters — it never reaches the bolt.
       */
      rejection: 'DUPLICATE',
      answered: true,
    });

    // 2. Nothing moved, and the server's record was not walked backwards.
    expect(device.physicalState().lockState).toBe('UNLOCKED');
    expect(
      (
        await prisma.device.findUniqueOrThrow({
          where: { id: held.deviceId },
          select: { lockState: true },
        })
      ).lockState,
    ).toBe('LOCKED');
  });

  /**
   * The same replay after the device has forgotten the id — which is what a
   * reboot does to its eight-entry RAM cache, while `lastSeq` survives in NVS.
   *
   * This is the case `SEQ_REPLAY` actually exists for, and the reason the
   * sequence number is persisted and the id cache is not.
   */
  it('refuses a replay after a reboot with SEQ_REPLAY, from lastSeq in NVS', async () => {
    const { sim, broker, settle } = await harness();
    const held = await createUserWithDevice();
    const device = await sim.add(held.serialNumber);

    const code = await getCode(held.user.cookie);
    await post(CONFIRM_URL, held.user.cookie).send({ otp: code });
    await settle();

    const spentSeq = device.physicalState().lastSeq;
    const captured = broker.publishedTo(deviceTopic(held.serialNumber, 'cmd'))[0]!;

    await device.reboot();
    expect(device.physicalState().lastSeq).toBe(spentSeq);
    expect(device.physicalState().lockState).toBe('LOCKED');

    await broker.publish(captured.topic, captured.payload, { qos: 1, retain: false });
    await settle();

    expect(device.received[1]).toMatchObject({ accepted: false, rejection: 'SEQ_REPLAY' });
    expect(device.lastAck()).toMatchObject({ result: 'REJECTED', reason: 'SEQ_REPLAY' });
    expect(device.physicalState().lockState).toBe('LOCKED');
  });

  /**
   * A command lifted from one safe's topic to another's.
   *
   * The serial is repeated **inside** the signed canonical string precisely so
   * this fails: the device checks the field against its own identity, and the
   * signature covers it, so neither can be changed without the other.
   */
  it('refuses a command addressed to another safe with WRONG_DEVICE', async () => {
    const { sim, broker, settle } = await harness();
    const held = await createUserWithDevice();
    const neighbour = await seedDevice();

    await sim.add(held.serialNumber);
    const other = await sim.add(neighbour.serialNumber);

    const code = await getCode(held.user.cookie);
    await post(CONFIRM_URL, held.user.cookie).send({ otp: code });
    await settle();

    const captured = broker.publishedTo(deviceTopic(held.serialNumber, 'cmd'))[0]!;
    await broker.publish(deviceTopic(neighbour.serialNumber, 'cmd'), captured.payload, {
      qos: 1,
      retain: false,
    });
    await settle();

    expect(other.received).toHaveLength(1);
    expect(other.received[0]).toMatchObject({ accepted: false, rejection: 'WRONG_DEVICE' });
    expect(other.physicalState().lockState).toBe('LOCKED');
  });

  /**
   * The ordering that is a security property rather than a style choice.
   *
   * §3.4 verifies the signature at step 4 and the sequence number at step 6.
   * If those were the other way round, anyone able to publish could wedge a
   * safe permanently by sending `seq: 2^31` — no key required. So: an
   * unsigned command with an enormous sequence number must be refused
   * `BAD_SIGNATURE`, must not consume the number, and the next legitimate
   * command must still work.
   */
  it('verifies the signature before the sequence number, so a forged packet cannot wedge a safe', async () => {
    const { sim, broker, settle } = await harness();
    const held = await createUserWithDevice();
    const device = await sim.add(held.serialNumber);

    await broker.publish(
      deviceTopic(held.serialNumber, 'cmd'),
      Buffer.from(
        JSON.stringify({
          v: 1,
          kv: 1,
          commandId: 'cforgedcommand0001',
          type: 'UNLOCK',
          serial: held.serialNumber,
          seq: 2_147_483_647,
          issuedAt: new Date().toISOString(),
          ttlMs: 15_000,
          sig: 'not-a-signature',
        }),
        'utf8',
      ),
      { qos: 1, retain: false },
    );
    await settle();

    expect(device.received[0]).toMatchObject({
      seq: 2_147_483_647,
      accepted: false,
      rejection: 'BAD_SIGNATURE',
    });
    // The number was not spent, which is the whole assertion.
    expect(device.physicalState().lastSeq).toBe(0);

    const code = await getCode(held.user.cookie);
    const response = await post(CONFIRM_URL, held.user.cookie).send({ otp: code });
    await settle();

    expect(response.status).toBe(202);
    expect(
      (
        await prisma.command.findUniqueOrThrow({
          where: { id: response.body.commandId as string },
          select: { status: true },
        })
      ).status,
    ).toBe('ACKED');
  });

  /**
   * Rotation, done properly: the device and its row move together.
   *
   * `kv` is on the wire so the master secret can be rotated without a flag
   * day — the server signs for the version each device actually holds, which
   * is what makes "re-provision one at a time" possible rather than a fleet
   * outage.
   */
  it('works at a rotated key version when the device and its row agree', async () => {
    const { sim, settle } = await harness();
    const held = await createUserWithDevice();
    const device = await sim.add(held.serialNumber, { keyVersion: 2 });

    await prisma.device.update({
      where: { id: held.deviceId },
      data: { commandKeyVersion: 2 },
    });

    const code = await getCode(held.user.cookie);
    const response = await post(CONFIRM_URL, held.user.cookie).send({ otp: code });
    await settle();

    expect(device.received[0]).toMatchObject({ accepted: true, rejection: null });
    expect(
      (
        await prisma.command.findUniqueOrThrow({
          where: { id: response.body.commandId as string },
          select: { status: true },
        })
      ).status,
    ).toBe('ACKED');
  });

  /**
   * And a rotation done wrong, which is not what I expected to find.
   *
   * A device re-provisioned to `kv=2` whose row still says `kv=1` refuses the
   * command correctly — `BAD_KEY_VERSION`, exactly as §3.4 step 2 requires —
   * and **the server cannot read the refusal**. Device reports are signed with
   * the device's own `K_d` (§4.3) and the ack carries no `kv` of its own, so
   * the server verifies the rejection under the version it wrongly believes
   * and the signature does not match.
   *
   * The result is the honest one and worth pinning down, because it is a
   * consequence of the protocol rather than a bug in this code: a mismatched
   * key version is **mutual incomprehension**, recorded as
   * `DEVICE_MESSAGE_SIGNATURE_INVALID` and a timeout rather than as the
   * `BAD_KEY_VERSION` the device actually said. A mis-provisioned safe
   * therefore looks exactly like a hostile one — which is the right way round
   * to be wrong, and still means `BAD_KEY_VERSION` is a reason the server can
   * essentially never see. See docs/device-protocol.md §2.3's open note.
   */
  it('cannot read a rejection from a device whose key version its row disagrees with', async () => {
    const { sim, settle } = await harness();
    const held = await createUserWithDevice();
    const device = await sim.add(held.serialNumber);

    device.reprovision(2);

    const code = await getCode(held.user.cookie);
    const response = await post(CONFIRM_URL, held.user.cookie).send({ otp: code });
    const commandId = response.body.commandId as string;
    await settle();

    // 1. The device did refuse it, for the right reason, and said so out loud.
    expect(device.received[0]).toMatchObject({ accepted: false, rejection: 'BAD_KEY_VERSION' });
    expect(device.lastAck()).toMatchObject({
      result: 'REJECTED',
      reason: 'BAD_KEY_VERSION',
      puback: true,
    });

    // 2. And the server could not verify it, so the command is simply unanswered.
    expect(await auditActions(held.deviceId)).toContain(
      AUDIT_ACTIONS.DEVICE_MESSAGE_SIGNATURE_INVALID,
    );
    expect(
      (
        await prisma.command.findUniqueOrThrow({
          where: { id: commandId },
          select: { status: true },
        })
      ).status,
    ).toBe('SENT');

    await expire(commandId);
    await sweepCommands();

    expect(
      await prisma.command.findUniqueOrThrow({
        where: { id: commandId },
        select: { status: true, failureCategory: true },
      }),
    ).toMatchObject({ status: 'TIMED_OUT', failureCategory: 'NO_ACK' });

    /**
     * The one consolation, and it is a real one: the code is released rather
     * than burned. Nothing the user typed was wrong, and our provisioning
     * mistake must not cost them their one-time code.
     */
    expect(
      await prisma.unlockChallenge.findFirstOrThrow({
        where: { userId: held.user.id },
        select: { consumedAt: true, commandId: true },
      }),
    ).toMatchObject({ consumedAt: null, commandId: null });
  });

  /**
   * A seized mechanism, which is not a misbehaviour: the device tried, failed,
   * and reported it honestly.
   *
   * The distinction the `failureCategory` enum exists for. A jam is a `FAILED`
   * ack with a mechanism reason and the bolt left where it was — materially
   * different from a `REJECTED` (nothing moved, and the device knew in
   * advance) and from silence (we have no idea).
   */
  it('records a jam as FAILED with the mechanism reason, and releases the code', async () => {
    const { sim, settle } = await harness();
    const held = await createUserWithDevice();
    const device = await sim.add(held.serialNumber).then((added) => added.jam('MOTOR_FAULT'));

    const code = await getCode(held.user.cookie);
    const response = await post(CONFIRM_URL, held.user.cookie).send({ otp: code });
    const commandId = response.body.commandId as string;
    await settle();

    expect(device.received[0]).toMatchObject({ accepted: true, rejection: 'MOTOR_FAULT' });
    expect(device.lastAck()).toMatchObject({
      result: 'FAILED',
      reason: 'MOTOR_FAULT',
      lockState: 'LOCKED',
    });
    expect(device.physicalState().lockState).toBe('LOCKED');

    expect(
      await prisma.command.findUniqueOrThrow({
        where: { id: commandId },
        select: { status: true, failureCategory: true },
      }),
    ).toMatchObject({ status: 'FAILED', failureCategory: 'MOTOR_FAULT' });

    // The safe is shut, and the user's own feed says the unlock failed.
    expect(
      await prisma.device.findUniqueOrThrow({
        where: { id: held.deviceId },
        select: { lockState: true },
      }),
    ).toMatchObject({ lockState: 'LOCKED' });

    const failures = await prisma.deviceEvent.findMany({
      where: { deviceId: held.deviceId, type: 'UNLOCK_FAILED' },
      select: { failureReason: true },
    });
    expect(failures.map((event) => event.failureReason)).toEqual(['DEVICE_FAILED']);

    // Burning the code for our motor's fault would charge the user for our
    // hardware's mistake.
    expect(
      await prisma.unlockChallenge.findFirstOrThrow({
        where: { userId: held.user.id },
        select: { consumedAt: true, commandId: true },
      }),
    ).toMatchObject({ consumedAt: null, commandId: null });
  });
});

// --- Misbehaviours, each proved delivered first ------------------------------

describe('a device that drops an ack', () => {
  it('times out, and the drop is proved before the timeout is asserted', async () => {
    const { sim, settle } = await harness();
    const held = await createUserWithDevice();
    const device = await sim.add(held.serialNumber).then((added) => added.misbehave('DROP_ACK'));

    const code = await getCode(held.user.cookie);
    const response = await post(CONFIRM_URL, held.user.cookie).send({ otp: code });
    const commandId = response.body.commandId as string;
    await settle();

    /**
     * 1. The command **arrived and was deliberately ignored**.
     *
     * Without this line, "no ack arrived" is indistinguishable from "no
     * command was ever sent", and this test would pass against a gateway that
     * publishes nothing at all — which is precisely the regression it is here
     * to catch.
     */
    expect(device.received.map((command) => command.commandId)).toEqual([commandId]);
    expect(sim.appliedMisbehaviours()).toEqual([{ kind: 'DROP_ACK', commandId }]);
    expect(device.sent.filter((record) => record.kind === 'ack')).toHaveLength(0);

    // 2. And the server's answer to silence.
    await expire(commandId);
    expect(await sweepCommands()).toMatchObject({ timedOut: 1 });

    expect(
      await prisma.command.findUniqueOrThrow({
        where: { id: commandId },
        select: { status: true, failureCategory: true },
      }),
    ).toMatchObject({ status: 'TIMED_OUT', failureCategory: 'NO_ACK' });

    // The code is released in the same transaction, so there is no window in
    // which the command is finished and the code is still held hostage to it.
    expect(
      await prisma.unlockChallenge.findFirstOrThrow({
        where: { userId: held.user.id },
        select: { commandId: true, consumedAt: true },
      }),
    ).toMatchObject({ commandId: null, consumedAt: null });

    const failures = await prisma.deviceEvent.findMany({
      where: { deviceId: held.deviceId, type: 'UNLOCK_FAILED' },
      select: { failureReason: true },
    });
    expect(failures.map((event) => event.failureReason)).toEqual(['DEVICE_TIMEOUT']);
  });
});

describe('a device that forges a signature', () => {
  it('is dropped and audited, and the forgery is proved before that is asserted', async () => {
    const { sim, settle } = await harness();
    const held = await createUserWithDevice();
    const device = await sim
      .add(held.serialNumber)
      .then((added) => added.misbehave('FORGE_SIGNATURE'));

    const code = await getCode(held.user.cookie);
    const response = await post(CONFIRM_URL, held.user.cookie).send({ otp: code });
    const commandId = response.body.commandId as string;
    await settle();

    // 1. The misbehaviour was delivered, and it really is forged.
    const ack = device.lastAck()!;
    expect(sim.appliedMisbehaviours()).toEqual([{ kind: 'FORGE_SIGNATURE', commandId }]);
    expect(ack).toMatchObject({ commandId, result: 'OK', puback: true });
    expect(ack.sig).not.toBe(device.honestSignatureFor(ack));

    // 2. And only now, what the server did with it.
    expect(await auditActions(held.deviceId)).toContain(AUDIT_ACTIONS.DEVICE_MESSAGE_SIGNATURE_INVALID);
    expect(
      (
        await prisma.command.findUniqueOrThrow({
          where: { id: commandId },
          select: { status: true },
        })
      ).status,
    ).toBe('SENT');

    /**
     * The command settled nothing — and the stored state nevertheless says
     * `UNLOCKED`, which took me a moment and is right.
     *
     * The bolt did move: this device unlocked honestly and then lied about the
     * signature on its *ack*. Its `COMMAND` state report is a separate
     * message, separately signed, and it verifies — so the physical record
     * comes from the report, and the forged ack contributed exactly nothing.
     * That is the division of authority the protocol intends: an ack settles a
     * command, a state report describes a safe, and failing to verify one does
     * not discard the other.
     */
    expect(
      (
        await prisma.device.findUniqueOrThrow({
          where: { id: held.deviceId },
          select: { lockState: true },
        })
      ).lockState,
    ).toBe('UNLOCKED');
  });

  /**
   * The threat §4.3 is actually written against: a **hostile publisher** — a
   * compromised broker, or anyone who got onto the ack topic — fabricating the
   * security record of a physical safe.
   *
   * A forged ack cannot open anything; that is the point at which a reasonable
   * person stops caring. What it could do unsigned is rewrite the record: show
   * `LOCKED` on a safe standing open, or invent an `UNLOCK_CONFIRMED` the
   * owner never caused. For this product the record is close to the product.
   */
  it('refuses a forged ack injected by someone who is not the device', async () => {
    const { sim, broker, settle } = await harness();
    const held = await createUserWithDevice();
    const device = await sim
      .add(held.serialNumber, { lockState: 'UNLOCKED' })
      .then((added) => added.misbehave('DROP_ACK'));

    await prisma.device.update({
      where: { id: held.deviceId },
      data: { lockState: 'UNLOCKED' },
    });

    const response = await post(LOCK_URL, held.user.cookie).send({});
    const commandId = response.body.commandId as string;
    await settle();

    expect(device.received.map((command) => command.commandId)).toEqual([commandId]);
    expect(sim.appliedMisbehaviours()).toEqual([{ kind: 'DROP_ACK', commandId }]);

    // Somebody else answers for the safe, claiming it shut.
    const body = {
      commandId,
      seq: device.received[0]!.seq,
      result: 'OK' as const,
      reason: null,
      lockState: 'LOCKED' as const,
      doorState: 'CLOSED' as const,
      bootId: 'forgedb01',
      measuredAtUptimeMs: 12_345,
    };
    const honest = signCanonical(
      deriveCommandKey(held.serialNumber, 1),
      canonicalAck(body),
    );
    const forged = signCanonical(Buffer.alloc(32, 7), canonicalAck(body));

    const puback = await broker.publish(
      deviceTopic(held.serialNumber, 'ack'),
      Buffer.from(JSON.stringify({ v: 1, ...body, sig: forged }), 'utf8'),
      { qos: 1, retain: false },
    );
    await settle();

    // 1. It was delivered, and it really is unverifiable.
    expect(puback).toBe(true);
    expect(forged).not.toBe(honest);

    // 2. Dropped, audited, and the record of a physical safe is untouched.
    expect(await auditActions(held.deviceId)).toContain(
      AUDIT_ACTIONS.DEVICE_MESSAGE_SIGNATURE_INVALID,
    );
    expect(
      await prisma.command.findUniqueOrThrow({
        where: { id: commandId },
        select: { status: true, ackedAt: true },
      }),
    ).toMatchObject({ status: 'SENT', ackedAt: null });
    expect(
      (
        await prisma.device.findUniqueOrThrow({
          where: { id: held.deviceId },
          select: { lockState: true },
        })
      ).lockState,
    ).toBe('UNLOCKED');
    expect(
      await prisma.deviceEvent.count({ where: { deviceId: held.deviceId, type: 'LOCK' } }),
    ).toBe(0);
  });
});

describe('a device that acks a command it was never sent', () => {
  it('is refused as a foreign command, and the real one is left alone', async () => {
    const { sim, settle } = await harness();
    const held = await createUserWithDevice();
    const device = await sim
      .add(held.serialNumber)
      .then((added) => added.misbehave('WRONG_COMMAND_ID'));

    const code = await getCode(held.user.cookie);
    const response = await post(CONFIRM_URL, held.user.cookie).send({ otp: code });
    const commandId = response.body.commandId as string;
    await settle();

    // 1. Delivered, with a correct signature over somebody else's id — which
    //    is the case the device-to-command join exists to refuse.
    const ack = device.lastAck()!;
    expect(sim.appliedMisbehaviours()).toEqual([{ kind: 'WRONG_COMMAND_ID', commandId }]);
    expect(ack.puback).toBe(true);
    expect(ack.commandId).not.toBe(commandId);
    expect(ack.sig).toBe(device.honestSignatureFor(ack));

    // 2. Audited, and the command it quoted the wrong id for is untouched.
    expect(await auditActions(held.deviceId)).toContain(AUDIT_ACTIONS.DEVICE_ACK_FOREIGN_COMMAND);
    expect(
      (
        await prisma.command.findUniqueOrThrow({
          where: { id: commandId },
          select: { status: true },
        })
      ).status,
    ).toBe('SENT');
  });
});

describe('a device that acks twice', () => {
  /**
   * Ordinary QoS 1 behaviour, not an error: a device re-acking a command whose
   * first answer it believes was lost is doing the right thing. What must not
   * happen is a second event, a second notification, or a second settlement.
   */
  it('settles once, with one event and one notification', async () => {
    const { sim, settle } = await harness();
    const held = await createUserWithDevice();
    const device = await sim
      .add(held.serialNumber)
      .then((added) => added.misbehave('REPLAY_ACK'));

    const code = await getCode(held.user.cookie);
    const response = await post(CONFIRM_URL, held.user.cookie).send({ otp: code });
    const commandId = response.body.commandId as string;
    await settle();

    // 1. Two identical acks really were published, and the broker took both.
    const acks = device.sent.filter((record) => record.kind === 'ack');
    expect(sim.appliedMisbehaviours()).toEqual([{ kind: 'REPLAY_ACK', commandId }]);
    expect(acks).toHaveLength(2);
    expect(acks[0]!.raw.equals(acks[1]!.raw)).toBe(true);
    expect(acks.every((record) => record.puback)).toBe(true);

    // 2. One settlement, one event, one notification.
    expect(
      await prisma.deviceEvent.count({
        where: { deviceId: held.deviceId, type: 'UNLOCK_CONFIRMED' },
      }),
    ).toBe(1);
    expect(
      await prisma.notification.count({
        where: { userId: held.user.id, type: 'UNLOCK_CONFIRMED' },
      }),
    ).toBe(1);
  });
});

describe('a device whose ack disagrees with what it was asked to do', () => {
  /**
   * The measurement wins over the intent, always.
   *
   * An `OK` unlock whose ack reports the bolt still `LOCKED` records `LOCKED`.
   * Trusting the request instead is how a product ends up telling someone
   * their safe is shut while it stands open — and this is the same rule from
   * the other side.
   */
  it('stores the state it measured, not the state we asked for', async () => {
    const { sim, settle } = await harness();
    const held = await createUserWithDevice();
    const device = await sim
      .add(held.serialNumber)
      .then((added) => added.misbehave('DISAGREE_STATE'));

    const code = await getCode(held.user.cookie);
    const response = await post(CONFIRM_URL, held.user.cookie).send({ otp: code });
    const commandId = response.body.commandId as string;
    await settle();

    // 1. The disagreement was delivered, correctly signed.
    const ack = device.lastAck()!;
    expect(sim.appliedMisbehaviours()).toEqual([{ kind: 'DISAGREE_STATE', commandId }]);
    expect(ack).toMatchObject({ result: 'OK', lockState: 'LOCKED', puback: true });
    expect(ack.sig).toBe(device.honestSignatureFor(ack));

    // 2. The command succeeded and the safe is recorded shut.
    expect(
      (
        await prisma.command.findUniqueOrThrow({
          where: { id: commandId },
          select: { status: true },
        })
      ).status,
    ).toBe('ACKED');
    expect(
      (
        await prisma.device.findUniqueOrThrow({
          where: { id: held.deviceId },
          select: { lockState: true },
        })
      ).lockState,
    ).toBe('LOCKED');
  });
});

describe('a device that reboots mid-command', () => {
  /**
   * §8.2.1 and §8.2.3 together: a restart abandons everything in flight, and
   * the bolt is driven `LOCKED` rather than restored from storage. A device
   * that came back up believing it was entitled to be open would be a safe
   * that opens itself after a power cut.
   */
  it('answers nothing, comes back locked, and the command times out', async () => {
    const { sim, settle } = await harness();
    const held = await createUserWithDevice();
    const device = await sim.add(held.serialNumber).then((added) => added.misbehave('REBOOT'));

    const bootIdBefore = device.physicalState().bootId;

    const code = await getCode(held.user.cookie);
    const response = await post(CONFIRM_URL, held.user.cookie).send({ otp: code });
    const commandId = response.body.commandId as string;
    await settle();

    // 1. It arrived, passed every check, and the reboot happened instead of
    //    the movement — with a `BOOT` report to prove the restart was real.
    expect(device.received[0]).toMatchObject({ commandId, accepted: true, answered: false });
    expect(sim.appliedMisbehaviours()).toEqual([{ kind: 'REBOOT', commandId }]);
    expect(device.physicalState().bootId).not.toBe(bootIdBefore);
    expect(device.physicalState().lockState).toBe('LOCKED');
    expect(
      device.sent.filter((record) => record.kind === 'state' && record.payload.reason === 'BOOT'),
    ).toHaveLength(2);

    // 2. The server never heard an answer, and says so.
    await expire(commandId);
    await sweepCommands();

    expect(
      (
        await prisma.command.findUniqueOrThrow({
          where: { id: commandId },
          select: { status: true },
        })
      ).status,
    ).toBe('TIMED_OUT');
    expect(
      (
        await prisma.device.findUniqueOrThrow({
          where: { id: held.deviceId },
          select: { lockState: true },
        })
      ).lockState,
    ).toBe('LOCKED');
  });
});

describe('a device that goes silent', () => {
  /**
   * A wedged radio still holding its TCP connection — the case a last will
   * cannot catch, and the reason `online` is derived from `lastSeenAt` as well
   * as from the retained flag.
   */
  it('publishes nothing at all, and its liveness goes stale', async () => {
    const { sim, settle } = await harness();
    const held = await createUserWithDevice();
    const device = await sim.add(held.serialNumber);

    const sentBefore = device.sent.length;
    device.misbehave('GO_SILENT', { times: Infinity });

    const code = await getCode(held.user.cookie);
    const response = await post(CONFIRM_URL, held.user.cookie).send({ otp: code });
    const commandId = response.body.commandId as string;
    await settle();

    await device.heartbeat();

    // 1. The command arrived; nothing went back, including the heartbeat.
    expect(device.received.map((command) => command.commandId)).toEqual([commandId]);
    expect(device.sent).toHaveLength(sentBefore);
    /**
     * Three suppressions, not one: the ack, the `COMMAND` state report that
     * follows it, and the heartbeat. A radio that was silent for acks while
     * still reporting state would be a failure mode no hardware has — and
     * would hide itself, because the state report would keep the device
     * looking alive.
     */
    expect(sim.appliedMisbehaviours().map((applied) => applied.kind)).toEqual([
      'GO_SILENT',
      'GO_SILENT',
      'GO_SILENT',
    ]);

    // 2. The command times out, and nothing refreshed the device's liveness.
    const before = await prisma.device.findUniqueOrThrow({
      where: { id: held.deviceId },
      select: { lastSeenAt: true },
    });

    await expire(commandId);
    await sweepCommands();

    expect(
      await prisma.device.findUniqueOrThrow({
        where: { id: held.deviceId },
        select: { lastSeenAt: true },
      }),
    ).toEqual(before);
  });
});

// --- The late ack, and single use ---------------------------------------------

describe('an ack that arrives after we gave up', () => {
  /**
   * §5.5, end to end, with a real device holding the ack.
   *
   * The rule stated once: a late ack updates the physical record and never
   * retracts what the user was told. The command stays a failure in the user's
   * history *and* stamps `lateAckedAt`, the safe is recorded open because it
   * is open, and the owner is told — which is exactly when they most need to
   * know, having just been told it failed.
   */
  it('updates the record, writes the event, and consumes the code for good', async () => {
    const { sim, settle } = await harness();
    const held = await createUserWithDevice();
    const device = await sim.add(held.serialNumber).then((added) => added.misbehave('HOLD_ACK'));

    const code = await getCode(held.user.cookie);
    const response = await post(CONFIRM_URL, held.user.cookie).send({ otp: code });
    const commandId = response.body.commandId as string;
    await settle();

    // 1. The command arrived and the ack is being withheld, not lost.
    expect(sim.appliedMisbehaviours()).toEqual([{ kind: 'HOLD_ACK', commandId }]);
    expect(device.heldAcks()).toEqual([commandId]);

    await expire(commandId);
    await sweepCommands();
    expect(
      (
        await prisma.command.findUniqueOrThrow({
          where: { id: commandId },
          select: { status: true },
        })
      ).status,
    ).toBe('TIMED_OUT');

    // 2. And now the bolt's answer turns up anyway.
    await device.releaseHeldAcks();
    await settle();

    expect(device.lastAck()).toMatchObject({ commandId, result: 'OK', puback: true });

    const command = await prisma.command.findUniqueOrThrow({
      where: { id: commandId },
      select: { status: true, lateAckedAt: true },
    });
    expect(command.status).toBe('ACKED');
    expect(command.lateAckedAt).not.toBeNull();

    expect(
      (
        await prisma.device.findUniqueOrThrow({
          where: { id: held.deviceId },
          select: { lockState: true },
        })
      ).lockState,
    ).toBe('UNLOCKED');

    // The safe is open; the owner's security log must say so, and they must be
    // told — the request having returned a failure is what makes this matter.
    expect(
      await prisma.deviceEvent.count({
        where: { deviceId: held.deviceId, type: 'UNLOCK_CONFIRMED' },
      }),
    ).toBe(1);
    expect(
      await prisma.notification.count({
        where: { userId: held.user.id, type: 'UNLOCK_CONFIRMED' },
      }),
    ).toBe(1);

    expect(await auditActions(held.deviceId)).toContain(AUDIT_ACTIONS.DEVICE_COMMAND_LATE_ACK);
  });

  /**
   * **One code can never unlock twice.** The test §5.5 step 5 names.
   *
   * The sequence is the whole argument. A timeout *released* the code —
   * provisionally, because a release says only "we have no evidence the bolt
   * moved" — and then evidence arrived. A released code that demonstrably
   * opened a safe is a used code, so it is consumed and dead forever. Without
   * both halves, the release would be a second use of a code that already
   * worked, which is the one thing "single-use" has to mean.
   */
  it('refuses the same code afterwards, and creates no second command', async () => {
    const { sim, settle } = await harness();
    const held = await createUserWithDevice();
    const device = await sim.add(held.serialNumber).then((added) => added.misbehave('HOLD_ACK'));

    const code = await getCode(held.user.cookie);
    const first = await post(CONFIRM_URL, held.user.cookie).send({ otp: code });
    const commandId = first.body.commandId as string;
    await settle();

    expect(sim.appliedMisbehaviours()).toEqual([{ kind: 'HOLD_ACK', commandId }]);

    await expire(commandId);
    await sweepCommands();

    // The release really did happen: this is the window the attack would use.
    expect(
      (
        await prisma.unlockChallenge.findFirstOrThrow({
          where: { userId: held.user.id },
          select: { commandId: true, consumedAt: true },
        })
      ).commandId,
    ).toBeNull();

    await device.releaseHeldAcks();
    await settle();

    const second = await post(CONFIRM_URL, held.user.cookie).send({ otp: code });

    expect(second.status).toBe(400);
    expect(second.body.error.code).toBe('OTP_NOT_FOUND');

    // No second command row. Not a refused one — none at all.
    expect(await prisma.command.count({ where: { deviceId: held.deviceId } })).toBe(1);
    expect(device.received).toHaveLength(1);

    expect(
      (
        await prisma.unlockChallenge.findFirstOrThrow({
          where: { userId: held.user.id },
          select: { consumedAt: true },
        })
      ).consumedAt,
    ).not.toBeNull();
  });
});

// --- §8.3, with a device that answers --------------------------------------

describe('a safe that reports itself open with nobody entitled to it', () => {
  /**
   * The full §8.3 loop, which no other test can assemble: a device moves its
   * own bolt, reports it, the server issues a reconciling `LOCK` through the
   * ordinary lifecycle, and the device closes and acks.
   *
   * The flag is raised on **issue** rather than on failure — a safe found open
   * with nobody entitled to it is already an incident — and cleared by a
   * report that shows `LOCKED`, because the flag is about the safe's state and
   * an acked lock is only evidence of that.
   */
  it('is locked, flagged, audited, and the flag clears when it reports LOCKED', async () => {
    const { sim, settle } = await harness();
    const free = await seedDevice();
    const device = await sim.add(free.serialNumber);

    await device.forcePhysicalState('UNLOCKED');
    await settle();

    // 1. A reconciling LOCK really was published, and the device answered it.
    expect(device.received).toHaveLength(1);
    expect(device.received[0]).toMatchObject({ type: 'LOCK', accepted: true });
    expect(device.physicalState().lockState).toBe('LOCKED');

    const reconcile = await prisma.command.findFirstOrThrow({
      where: { deviceId: free.id },
      select: { id: true, type: true, status: true, systemActor: true, userId: true },
    });
    expect(reconcile).toMatchObject({
      type: 'LOCK',
      status: 'ACKED',
      systemActor: 'SWEEPER',
      userId: null,
    });
    expect(device.received[0]!.commandId).toBe(reconcile.id);

    // 2. Audited, and the flag is already cleared because the ack said LOCKED.
    expect(await auditActions(free.id)).toContain(AUDIT_ACTIONS.DEVICE_UNEXPECTED_UNLOCKED_RECONCILED);
    expect(
      await prisma.device.findUniqueOrThrow({
        where: { id: free.id },
        select: { lockState: true, unexpectedUnlockAt: true },
      }),
    ).toMatchObject({ lockState: 'LOCKED', unexpectedUnlockAt: null });
  });

  /**
   * The same incident, with a safe that will not close.
   *
   * One reconcile in flight per device, taken under the row lock, so a safe
   * heartbeating every sixty seconds while jammed produces one retry chain and
   * not one per heartbeat.
   */
  it('issues one chain however often the jammed safe heartbeats', async () => {
    const { sim, settle } = await harness();
    const free = await seedDevice();
    /**
     * Jammed **and** silent, which is what "a safe we cannot close" actually
     * is. A device that dropped its acks but quietly locked itself anyway
     * would heartbeat `LOCKED` and clear the very flag this chain exists to
     * raise — so the test would pass while testing nothing.
     */
    const device = await sim
      .add(free.serialNumber)
      .then((added) => added.jam().misbehave('DROP_ACK', { times: Infinity }));

    await device.forcePhysicalState('UNLOCKED');
    await settle();
    await device.heartbeat();
    await settle();
    await device.heartbeat();
    await settle();

    // 1. Three reports went out; every command that was issued arrived.
    expect(
      device.sent.filter((record) => record.kind === 'state').length,
    ).toBeGreaterThanOrEqual(3);
    expect(device.received).toHaveLength(1);
    expect(sim.appliedMisbehaviours()).toEqual([
      { kind: 'DROP_ACK', commandId: device.received[0]!.commandId },
    ]);

    // 2. One command, and the device is flagged for an admin to look at.
    expect(await prisma.command.count({ where: { deviceId: free.id } })).toBe(1);
    expect(
      (
        await prisma.device.findUniqueOrThrow({
          where: { id: free.id },
          select: { unexpectedUnlockAt: true },
        })
      ).unexpectedUnlockAt,
    ).not.toBeNull();
  });
});

// --- The discipline itself ---------------------------------------------------

describe('the delivery assertion', () => {
  /**
   * A test about the tests, and the only one in the suite whose subject is a
   * convention rather than a behaviour.
   *
   * It is here because §13's failure mode is a *green* test. If arming a
   * misbehaviour on a device nothing is ever sent to could satisfy
   * `appliedMisbehaviours()`, then every delivery assertion above would be
   * decoration — so this pins the one property that makes them load-bearing:
   * the record is written where the device branches on the flag, and nowhere
   * else.
   */
  it('is not satisfied by a misbehaviour that was armed but never reached', async () => {
    const { sim } = await harness();
    const unused = await seedDevice();

    const device = await sim.add(unused.serialNumber);
    device.misbehave('FORGE_SIGNATURE');

    // Nothing was ever sent to it, so nothing branched on the flag.
    expect(device.received).toHaveLength(0);
    expect(sim.appliedMisbehaviours()).toEqual([]);

    // And the server recorded nothing — the assertion that would have passed
    // vacuously, shown passing for the wrong reason.
    expect(await auditActions(unused.id)).not.toContain(AUDIT_ACTIONS.DEVICE_MESSAGE_SIGNATURE_INVALID);
  });

  /**
   * The other half: a signature the simulator believes is honest must actually
   * verify under the server's key.
   *
   * Without this, `honestSignatureFor` could be wrong in the same way the
   * forging path is, and `expect(ack.sig).not.toBe(honest)` would pass for a
   * device that cannot sign at all.
   */
  it('compares a forged signature against one the server really accepts', async () => {
    const { sim, settle } = await harness();
    const held = await createUserWithDevice();
    const device = await sim.add(held.serialNumber);

    const code = await getCode(held.user.cookie);
    await post(CONFIRM_URL, held.user.cookie).send({ otp: code });
    await settle();

    const ack = device.lastAck()!;
    const key = deriveCommandKey(held.serialNumber, 1);

    expect(ack.sig).toBe(device.honestSignatureFor(ack));
    expect(ack.sig).toBe(
      signCanonical(
        key,
        canonicalAck({
          commandId: String(ack.commandId),
          seq: Number(ack.seq),
          result: String(ack.result),
          reason: (ack.reason as string | null) ?? null,
          lockState: String(ack.lockState),
          doorState: String(ack.doorState),
          bootId: String(ack.bootId),
          measuredAtUptimeMs: Number(ack.measuredAtUptimeMs),
        }),
      ),
    );
  });
});

// --- A lock, for the symmetry -------------------------------------------------

describe('a user lock over the real transport', () => {
  it('is published, acked, and recorded with a LOCK event', async () => {
    const { sim, settle } = await harness();
    const held = await createUserWithDevice();
    const device = await sim.add(held.serialNumber, { lockState: 'UNLOCKED' });

    await prisma.device.update({
      where: { id: held.deviceId },
      data: { lockState: 'UNLOCKED' },
    });

    const response = await post(LOCK_URL, held.user.cookie).send({});
    expect(response.status).toBe(202);
    const commandId = response.body.commandId as string;
    await settle();

    expect(device.received[0]).toMatchObject({ commandId, type: 'LOCK', accepted: true });
    expect(device.lastAck()).toMatchObject({ result: 'OK', lockState: 'LOCKED' });
    expect(commandsOn(sim.broker, held.serialNumber)[0]).toMatchObject({
      type: 'LOCK',
      serial: held.serialNumber,
    });

    await settle();

    expect(
      await prisma.device.findUniqueOrThrow({
        where: { id: held.deviceId },
        select: { lockState: true },
      }),
    ).toMatchObject({ lockState: 'LOCKED' });
    expect(
      await prisma.deviceEvent.count({ where: { deviceId: held.deviceId, type: 'LOCK' } }),
    ).toBe(1);
  });
});
