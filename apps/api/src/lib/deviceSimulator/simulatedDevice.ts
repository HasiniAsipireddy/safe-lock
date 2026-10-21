import crypto from 'node:crypto';
import {
  canonicalAck,
  canonicalState,
  deriveCommandKey,
  deviceTopic,
  signCanonical,
  verifyCanonical,
  canonicalCommand,
  PROTOCOL_VERSION,
  type AckReason,
  type AckResult,
} from '../deviceProtocol';
import type { SimulatorTransport } from './transport';

/**
 * One safe's firmware, in TypeScript, standing in for the ESP32.
 *
 * Firmware is out of scope for this task (docs/device-protocol.md §0), so the
 * protocol needs a second implementation to be a protocol at all: everything
 * tested only against its own transport has exactly one interpretation of
 * itself, and a canonical string both ends build the same way by accident is a
 * canonical string nobody has checked.
 *
 * ## What it is faithful about
 * §3.4's check order, in that order, including the two orderings that are
 * security properties rather than style: the signature is verified **before**
 * the sequence number, so an unauthenticated packet can never consume one, and
 * a repeated `commandId` is **re-acked** from the stored result rather than
 * silently dropped, so a QoS 1 duplicate whose first answer was lost does not
 * look like silence. It signs its reports with the real `K_d` over the real
 * canonical strings, from `lib/deviceProtocol` — the same module the server
 * uses, which is the only way the two can be shown to agree.
 *
 * ## What it is deliberately unfaithful about
 * It can be told to misbehave: to drop an ack, hold one, forge a signature,
 * ack a command it was never sent, report a state that disagrees with what it
 * just did, reboot mid-command or go silent. §8.2 puts it plainly — a
 * simulator that violates the fail-safe requirements is a useful test fixture
 * and a device that does is a product recall. Those paths are the server
 * behaviour that matters most (`TIMED_OUT`, late acks, foreign commands,
 * invalid signatures, §8.3's reconcile) and there is no other way to reach
 * them.
 *
 * ## Every misbehaviour is recorded where the branch is taken
 * Not where the flag is set — at the `if`. §13 exists because a misbehaviour
 * test fails by *passing*: "the server recorded nothing" is equally true of a
 * simulator that never connected, a misspelled topic and a flag read before it
 * was set. {@link applied} is what a test asserts on first, and it cannot be
 * satisfied by a flag that was never reached.
 */

// --- Device-side constants ---------------------------------------------------

/**
 * §3.3's skew allowance, as the firmware would hold it.
 *
 * Lives here rather than in `config/env.ts` because it is a *device* constant:
 * the server never evaluates it, and a value the server could change would be
 * a value the fleet disagreed with until every unit was re-provisioned.
 */
export const CLOCK_SKEW_MS = 60_000;

/** How many `commandId`s the device keeps in RAM for de-duplication. §3.4. */
const RECENT_COMMAND_IDS = 8;

// --- Misbehaviours -----------------------------------------------------------

/**
 * The ways this simulator can be told to behave like hardware having a bad day.
 *
 * A closed enum, like everything else on this wire. Each one names exactly one
 * server path, and the comment says which — a misbehaviour nobody can point at
 * a test for is a misbehaviour that will be read as a bug in the simulator.
 */
export type MisbehaviourKind =
  /** Receive the command, act, and deliberately never answer. → `TIMED_OUT`. */
  | 'DROP_ACK'
  /** Build the ack and hold it until {@link SimulatedDevice.releaseHeldAcks}. → §5.5. */
  | 'HOLD_ACK'
  /** Sign the ack with a key that is not `K_d`. → `DEVICE_MESSAGE_SIGNATURE_INVALID`. */
  | 'FORGE_SIGNATURE'
  /** Ack a `commandId` it was never sent. → `DEVICE_ACK_FOREIGN_COMMAND`. */
  | 'WRONG_COMMAND_ID'
  /** Publish the same ack a second time. → the idempotent terminal transition. */
  | 'REPLAY_ACK'
  /** Ack `OK` while reporting the bolt where it already was. → the measurement wins. */
  | 'DISAGREE_STATE'
  /** Reboot instead of acting: new `bootId`, nothing in flight survives. → §8.2.3. */
  | 'REBOOT'
  /** Publish nothing at all, like a wedged radio holding its TCP connection. */
  | 'GO_SILENT';

/** A misbehaviour that actually fired, and on which command. */
export interface AppliedMisbehaviour {
  kind: MisbehaviourKind;
  /** The command it was applied to, or null for one not tied to a command. */
  commandId: string | null;
}

interface ArmedMisbehaviour {
  kind: MisbehaviourKind;
  /** Remaining commands it applies to. `Infinity` for "until cleared". */
  remaining: number;
}

// --- Records ----------------------------------------------------------------

/**
 * One publish the device made, as it made it.
 *
 * `puback` is the broker's answer, kept because §13's delivery proof needs it:
 * a payload the simulator built and a broker refused proves nothing arrived.
 * `misbehaviour` is which flag shaped this particular message, so a test does
 * not have to correlate two lists by index.
 */
export interface SentRecord {
  topic: string;
  kind: 'ack' | 'state' | 'status';
  /** The parsed payload, so a test can read a field without re-parsing JSON. */
  payload: Record<string, unknown>;
  raw: Buffer;
  qos: number;
  retain: boolean;
  puback: boolean;
  misbehaviour: MisbehaviourKind | null;
}

/** An ack as published, flattened so a test reads `ack.sig` and `ack.puback`. */
export type AckRecord = Record<string, unknown> & {
  puback: boolean;
  topic: string;
  retain: boolean;
  qos: number;
};

/**
 * One command the device received, and what it decided.
 *
 * **The inverse proof §13 asks for.** A dropped ack leaves no publish to point
 * at, so without a record of the command *arriving* a timeout test would pass
 * against a gateway that publishes nothing at all — which is precisely the
 * regression it exists to catch.
 */
export interface ReceivedRecord {
  commandId: string;
  seq: number;
  type: string;
  /** False when a §3.4 check refused it before the bolt was driven. */
  accepted: boolean;
  /** The refusal reason, when it was refused. */
  rejection: AckReason | null;
  /** Whether an ack was published for it, at the time it was handled. */
  answered: boolean;
}

/** An ack the device built and is sitting on. */
interface HeldAck {
  commandId: string;
  payload: Record<string, unknown>;
  misbehaviour: MisbehaviourKind | null;
}

export interface SimulatedDeviceOptions {
  serialNumber: string;
  transport: SimulatorTransport;
  /** Which `K_d` version this unit holds. A mismatch is `BAD_KEY_VERSION`. */
  keyVersion?: number;
  /** Which protocol versions it recognises. A mismatch is `BAD_VERSION`. */
  acceptedProtocolVersions?: readonly number[];
  firmwareVersion?: string;
  rssi?: number;
  /** Whether SNTP synced. `false` disables the `issuedAt` check, per §3.3. */
  clockSynced?: boolean;
  lockState?: 'LOCKED' | 'UNLOCKED' | 'UNKNOWN';
  /**
   * What the door sensor reads.
   *
   * Defaults to `CLOSED` because units ship with a sensor (§11.8). `UNKNOWN`
   * models a **failed** sensor, which is a fault to surface — never a unit
   * built without one, which is an unsupported configuration.
   */
  doorState?: 'CLOSED' | 'OPEN' | 'UNKNOWN';
  /** Injectable clock, so a test can age a command without sleeping. */
  now?: () => number;
}

export class SimulatedDevice {
  readonly serialNumber: string;

  /** Every publish, in order. */
  readonly sent: SentRecord[] = [];
  /** Every command received, in order. */
  readonly received: ReceivedRecord[] = [];
  /** Every misbehaviour that actually fired. */
  readonly applied: AppliedMisbehaviour[] = [];

  private readonly transport: SimulatorTransport;
  private readonly acceptedProtocolVersions: readonly number[];
  private readonly now: () => number;

  private keyVersion: number;
  private firmwareVersion: string;
  private rssi: number;
  private clockSynced: boolean;

  private lockState: 'LOCKED' | 'UNLOCKED' | 'UNKNOWN';
  private doorState: 'CLOSED' | 'OPEN' | 'UNKNOWN';

  /**
   * NVS: survives a reboot and a power cut.
   *
   * `lastSeq` is the whole of replay protection (§3.3), which is why it is the
   * one thing persisted — and why §8.2.1 forbids persisting `UNLOCKED`.
   * Authority to be open is never restored from storage.
   */
  private lastSeq = 0;

  /** RAM: the last few command ids with their answers. Lost on reboot. */
  private recent: Array<{ commandId: string; payload: Record<string, unknown> }> = [];

  private bootId: string;
  private bootedAt: number;
  private connected = false;

  private armed: ArmedMisbehaviour[] = [];
  private held: HeldAck[] = [];

  /**
   * A mechanism that cannot reach the state it is asked for.
   *
   * **Not a misbehaviour.** A jammed bolt is honest hardware failure and the
   * device reports it correctly: a `FAILED` ack with a mechanism reason, and
   * the bolt left where it is. It is modelled here because it is the only way
   * to reach the server's `FAILED` path and §8.3's retry chain — a safe that
   * drops acks but quietly locks itself anyway would heartbeat `LOCKED` and
   * clear the very flag the chain exists to raise.
   */
  private jammedWith: AckReason | null = null;

  constructor(options: SimulatedDeviceOptions) {
    this.serialNumber = options.serialNumber;
    this.transport = options.transport;
    this.keyVersion = options.keyVersion ?? 1;
    this.acceptedProtocolVersions = options.acceptedProtocolVersions ?? [PROTOCOL_VERSION];
    this.firmwareVersion = options.firmwareVersion ?? '1.0.3';
    this.rssi = options.rssi ?? -62;
    this.clockSynced = options.clockSynced ?? true;
    this.lockState = options.lockState ?? 'LOCKED';
    this.doorState = options.doorState ?? 'CLOSED';
    this.now = options.now ?? (() => Date.now());

    this.bootId = freshBootId();
    this.bootedAt = this.now();
  }

  // --- Connecting ------------------------------------------------------------

  /**
   * Connects: subscribe, then announce.
   *
   * The order matters and matches §10's confirm step — retained `status`
   * first, then a `BOOT` state — because the server learns liveness and
   * physical state from two different messages and the first is the one that
   * makes a row go online.
   */
  async connect(): Promise<void> {
    await this.transport.subscribe(deviceTopic(this.serialNumber, 'cmd'), (message) =>
      this.onCommand(message.payload),
    );

    this.connected = true;

    await this.publishStatus(true);
    await this.reportState('BOOT');
  }

  /**
   * A clean disconnect: the device publishes its own offline status first.
   *
   * Distinct from {@link lastWill}, which is the broker speaking for a device
   * that vanished. The server treats them identically on purpose — one
   * unsigned message, no authority over a lock state — but a test that
   * conflated them would not notice if that ever stopped being true.
   */
  async disconnectCleanly(): Promise<void> {
    await this.publishStatus(false);
    this.connected = false;
  }

  /**
   * The last will, as the **broker** would publish it.
   *
   * Composed by the device at connect time and published by someone else
   * later, which is exactly why §4.4 leaves it unsigned: a signature the
   * broker holds is a signature the broker could have made.
   */
  async lastWill(): Promise<void> {
    this.connected = false;

    await this.publish('status', { v: PROTOCOL_VERSION, online: false }, { retain: true });
  }

  // --- Reports ---------------------------------------------------------------

  /** A heartbeat, as the firmware sends every `DEVICE_HEARTBEAT_SECONDS`. */
  heartbeat(): Promise<void> {
    return this.reportState('HEARTBEAT');
  }

  /**
   * A signed state report, retained.
   *
   * Retained because the server must learn a device's state on its **own**
   * reconnect without waiting up to a heartbeat interval. Safe to re-deliver
   * because a report is a report: nothing moves when one arrives twice.
   */
  async reportState(reason: 'BOOT' | 'CHANGE' | 'HEARTBEAT' | 'COMMAND'): Promise<void> {
    const body = {
      lockState: this.lockState,
      doorState: this.doorState,
      firmwareVersion: this.firmwareVersion,
      lastSeq: this.lastSeq,
      bootId: this.bootId,
      uptimeMs: this.uptimeMs(),
      reason,
    };

    await this.publish(
      'state',
      {
        v: PROTOCOL_VERSION,
        ...body,
        rssi: this.rssi,
        clockSynced: this.clockSynced,
        sig: signCanonical(this.key(), canonicalState(body)),
      },
      { retain: true },
    );
  }

  /**
   * Moves the bolt with no command behind it, and reports honestly.
   *
   * A firmware fault, a power event that left the bolt withdrawn, or a
   * mechanical override — the ways §8.3's trigger is reached in the field,
   * none of which involve a command of ours. The device still *reports* what
   * it sees, which is the only reason the server can react at all.
   */
  async forcePhysicalState(
    lockState: 'LOCKED' | 'UNLOCKED' | 'UNKNOWN',
    doorState?: 'CLOSED' | 'OPEN' | 'UNKNOWN',
  ): Promise<void> {
    this.lockState = lockState;
    if (doorState) this.doorState = doorState;

    await this.reportState('CHANGE');
  }

  // --- Misbehaviour ----------------------------------------------------------

  /**
   * Arms a misbehaviour for the next `times` commands.
   *
   * Armed rather than invoked, because the interesting misbehaviours are
   * decisions taken *while handling a command* and the test does not have one
   * to hand yet. `times: Infinity` is "until cleared", which is what
   * `GO_SILENT` means.
   */
  misbehave(kind: MisbehaviourKind, options: { times?: number } = {}): this {
    this.armed.push({ kind, remaining: options.times ?? 1 });
    return this;
  }

  /** Disarms everything. Nothing already applied is forgotten. */
  behave(): void {
    this.armed = [];
  }

  /**
   * Seizes the mechanism. The device stays honest about it.
   *
   * Every command from here is acked `FAILED` with this reason and the bolt
   * does not move — which is what makes a jam distinguishable from a lost ack
   * in the server's record, and why `failureCategory` is a closed enum rather
   * than a boolean.
   */
  jam(reason: AckReason = 'JAMMED'): this {
    this.jammedWith = reason;
    return this;
  }

  unjam(): void {
    this.jammedWith = null;
  }

  /**
   * Publishes acks the device was sitting on.
   *
   * The ordering argument is how "send a second command's ack first" is
   * expressed: hold two, release them backwards. A separate misbehaviour flag
   * for that would be a flag whose only content is an array order.
   */
  async releaseHeldAcks(options: { order?: 'fifo' | 'lifo' } = {}): Promise<void> {
    const queued = options.order === 'lifo' ? [...this.held].reverse() : [...this.held];
    this.held = [];

    for (const ack of queued) {
      await this.publish('ack', ack.payload, { misbehaviour: ack.misbehaviour });
    }
  }

  /** Acks still held, by command id, oldest first. */
  heldAcks(): string[] {
    return this.held.map((ack) => ack.commandId);
  }

  /**
   * A restart: new `bootId`, nothing in flight survives, `lastSeq` read back.
   *
   * And the bolt is driven **`LOCKED`**, never restored from storage — §8.2.1,
   * the single most important line in the firmware requirements. A device that
   * came back up believing it was entitled to be open would be a safe that
   * opens itself after a power cut.
   */
  async reboot(): Promise<void> {
    this.bootId = freshBootId();
    this.bootedAt = this.now();
    this.recent = [];
    this.held = [];
    this.lockState = 'LOCKED';

    if (this.connected) {
      await this.publishStatus(true);
      await this.reportState('BOOT');
    }
  }

  /** Re-provisioned at a new key version, as §2.3's rotation row describes. */
  reprovision(keyVersion: number): void {
    this.keyVersion = keyVersion;
  }

  // --- Inspection ------------------------------------------------------------

  /** The last ack published, flattened. Null if it has never acked. */
  lastAck(): AckRecord | null {
    const acks = this.sent.filter((record) => record.kind === 'ack');
    const last = acks[acks.length - 1];
    if (!last) return null;

    return {
      ...last.payload,
      puback: last.puback,
      topic: last.topic,
      retain: last.retain,
      qos: last.qos,
    };
  }

  /** What the bolt and the door physically read right now. */
  physicalState(): {
    lockState: 'LOCKED' | 'UNLOCKED' | 'UNKNOWN';
    doorState: 'CLOSED' | 'OPEN' | 'UNKNOWN';
    bootId: string;
    lastSeq: number;
  } {
    return {
      lockState: this.lockState,
      doorState: this.doorState,
      bootId: this.bootId,
      lastSeq: this.lastSeq,
    };
  }

  /** The signature this device *would* have put on its last ack, honestly. */
  honestSignatureFor(payload: Record<string, unknown>): string {
    return signCanonical(this.key(), canonicalAck(ackCanonicalInput(payload)));
  }

  // --- The command path ------------------------------------------------------

  /**
   * §3.4, in order.
   *
   * Every refusal is acked. A device that silently drops a command it dislikes
   * is indistinguishable from one that is offline, and those two need
   * different answers in the UI and different escalation — the reason code is
   * what makes a refusal diagnosable at all.
   */
  private async onCommand(raw: Buffer): Promise<void> {
    const command = parseCommand(raw);

    // Not JSON, or not shaped like a command. A real device has nothing to ack
    // *to* — there is no `commandId` to quote — so it drops it.
    if (!command) return;

    const record: ReceivedRecord = {
      commandId: command.commandId,
      seq: command.seq,
      type: command.type,
      accepted: false,
      rejection: null,
      answered: false,
    };
    this.received.push(record);

    const refuse = async (reason: AckReason): Promise<void> => {
      record.rejection = reason;
      await this.answer(command, 'REJECTED', reason, record);
    };

    // 1. Protocol version.
    if (!this.acceptedProtocolVersions.includes(command.v)) {
      await refuse('BAD_VERSION');
      return;
    }

    // 2. A key version it holds.
    if (command.kv !== this.keyVersion) {
      await refuse('BAD_KEY_VERSION');
      return;
    }

    // 3. Its own serial, from inside the signed payload — so a command lifted
    //    from another device's topic fails here and not on a technicality.
    if (command.serial !== this.serialNumber) {
      await refuse('WRONG_DEVICE');
      return;
    }

    /**
     * 4. The signature, **before** the sequence check.
     *
     * The whole reason for the ordering: if `seq` were consumed first, anyone
     * able to publish could wedge a device forever by sending `seq: 2^31`.
     */
    const canonical = canonicalCommand({
      keyVersion: command.kv,
      commandId: command.commandId,
      type: command.type as 'LOCK' | 'UNLOCK',
      serialNumber: command.serial,
      seq: command.seq,
      issuedAt: new Date(command.issuedAt),
      ttlMs: command.ttlMs,
    });

    if (!verifyCanonical(this.key(), canonical, command.sig)) {
      await refuse('BAD_SIGNATURE');
      return;
    }

    /**
     * 5. Seen this id before? Re-ack the stored answer; do not act again.
     *
     * Re-ack rather than ignore, because a QoS 1 duplicate must produce an
     * answer: a legitimate retry whose first ack was lost would otherwise look
     * exactly like a device that has stopped responding.
     */
    const remembered = this.recent.find((entry) => entry.commandId === command.commandId);
    if (remembered) {
      record.rejection = 'DUPLICATE';
      record.answered = true;
      await this.publish('ack', remembered.payload, { misbehaviour: null });
      return;
    }

    // 6. Strictly increasing. The captured-packet defence.
    if (command.seq <= this.lastSeq) {
      await refuse('SEQ_REPLAY');
      return;
    }

    /**
     * 7. The clock check, and only when there is a clock.
     *
     * `ttlMs` is authoritative and needs no wall time; `issuedAt` is an extra
     * check used only once SNTP has synced. A device whose sync failed is not
     * degraded — replay protection is the sequence number, never the clock.
     */
    if (this.clockSynced) {
      const drift = this.now() - command.issuedAt;

      if (drift > command.ttlMs + CLOCK_SKEW_MS || drift < -CLOCK_SKEW_MS) {
        await refuse('EXPIRED');
        return;
      }
    }

    // 8. Persist `lastSeq`, then drive the bolt. In that order: a command that
    //    acted without its number persisted could be replayed after a reboot.
    this.lastSeq = command.seq;
    record.accepted = true;

    /**
     * The reboot misbehaviour lands here, after the checks and instead of the
     * movement — which is the honest shape of §8.2.3. A restart abandons
     * everything in flight, so there is no ack and no bolt travel, and the
     * server sees a `BOOT` report where it expected an answer.
     */
    if (this.take('REBOOT', command.commandId)) {
      await this.reboot();
      return;
    }

    /**
     * A seized mechanism: it tried, and it did not get there. The bolt is left
     * exactly where it was and the ack says so — `FAILED` with a mechanism
     * reason, never `REJECTED`, because something did move.
     */
    if (this.jammedWith) {
      record.rejection = this.jammedWith;
      await this.answer(command, 'FAILED', this.jammedWith, record);
      return;
    }

    const before = this.lockState;
    this.lockState = command.type === 'LOCK' ? 'LOCKED' : 'UNLOCKED';

    /**
     * An ack that claims success while reporting the bolt where it already
     * was. The server stores the **measurement**, so this is how "a safe
     * recorded shut while standing open" is reached deliberately rather than
     * waited for.
     */
    if (this.take('DISAGREE_STATE', command.commandId)) {
      await this.answer(command, 'OK', null, record, { reportLockState: before });
      return;
    }

    await this.answer(command, 'OK', null, record);
  }

  /**
   * Builds one ack, and then decides whether to be honest about it.
   *
   * Every misbehaviour that shapes an ack is taken here, in one place, so the
   * §3.4 path above reads as the protocol rather than as a thicket of flags —
   * and so {@link applied} is written at the branch in every case.
   */
  private async answer(
    command: ParsedCommand,
    result: AckResult,
    reason: AckReason | null,
    record: ReceivedRecord,
    options: { reportLockState?: 'LOCKED' | 'UNLOCKED' | 'UNKNOWN' } = {},
  ): Promise<void> {
    const forged = this.take('FORGE_SIGNATURE', command.commandId);
    const foreign = this.take('WRONG_COMMAND_ID', command.commandId);

    const body = {
      commandId: foreign ? foreignCommandId() : command.commandId,
      seq: command.seq,
      result,
      reason,
      lockState: options.reportLockState ?? this.lockState,
      doorState: this.doorState,
      bootId: this.bootId,
      measuredAtUptimeMs: this.uptimeMs(),
    };

    /**
     * A forged signature is signed with a **random** key, not with a wrong key
     * version: the point is to be unverifiable under any key the server could
     * reach for, so a passing test cannot be explained by the server having
     * picked the wrong one.
     */
    const key = forged ? crypto.randomBytes(32) : this.key();

    const payload = {
      v: PROTOCOL_VERSION,
      ...body,
      sig: signCanonical(key, canonicalAck(body)),
    };

    const misbehaviour: MisbehaviourKind | null = forged
      ? 'FORGE_SIGNATURE'
      : foreign
        ? 'WRONG_COMMAND_ID'
        : options.reportLockState !== undefined
          ? 'DISAGREE_STATE'
          : null;

    // Remembered before any decision not to send it: §3.4 step 5 is about what
    // the device *decided*, and a dropped ack is still the answer to that id.
    this.remember(command.commandId, payload);

    if (this.take('DROP_ACK', command.commandId)) return;

    if (this.take('HOLD_ACK', command.commandId)) {
      this.held.push({ commandId: command.commandId, payload, misbehaviour });
      return;
    }

    record.answered = true;
    await this.publish('ack', payload, { misbehaviour });

    if (this.take('REPLAY_ACK', command.commandId)) {
      await this.publish('ack', payload, { misbehaviour: 'REPLAY_ACK' });
    }

    /**
     * And the state report a command produces, which is not the same message
     * as the ack and is not redundant with it: the ack settles a command, the
     * retained report is what a server learns from on its own reconnect.
     */
    await this.reportState('COMMAND');
  }

  // --- Plumbing --------------------------------------------------------------

  /**
   * Whether a misbehaviour is armed, consuming one use — **and recording it**.
   *
   * This is the load-bearing method in the file. The record is written here,
   * at the branch, rather than where the flag was set, so a flag that was
   * armed and never reached leaves {@link applied} empty and the test that
   * asserts on it fails. §13 calls that the difference between a test and a
   * test-shaped absence.
   */
  private take(kind: MisbehaviourKind, commandId: string | null): boolean {
    const index = this.armed.findIndex((entry) => entry.kind === kind);
    if (index === -1) return false;

    const entry = this.armed[index]!;
    entry.remaining -= 1;
    if (entry.remaining <= 0) this.armed.splice(index, 1);

    this.applied.push({ kind, commandId });
    return true;
  }

  private remember(commandId: string, payload: Record<string, unknown>): void {
    this.recent.push({ commandId, payload });
    if (this.recent.length > RECENT_COMMAND_IDS) this.recent.shift();
  }

  private publishStatus(online: boolean): Promise<void> {
    return this.publish(
      'status',
      {
        v: PROTOCOL_VERSION,
        online,
        bootId: this.bootId,
        firmwareVersion: this.firmwareVersion,
      },
      { retain: true },
    );
  }

  /**
   * Publishes, records, and honours `GO_SILENT`.
   *
   * The silence is applied at the single point every message leaves through,
   * because a wedged radio does not pick which messages it loses — and a
   * simulator that went silent for acks while still heartbeating would be
   * testing a failure mode no hardware has.
   */
  private async publish(
    kind: 'ack' | 'state' | 'status',
    payload: Record<string, unknown>,
    options: { retain?: boolean; misbehaviour?: MisbehaviourKind | null } = {},
  ): Promise<void> {
    const commandId = typeof payload.commandId === 'string' ? payload.commandId : null;

    if (this.take('GO_SILENT', commandId)) return;

    const topic = deviceTopic(this.serialNumber, kind);
    const raw = Buffer.from(JSON.stringify(payload), 'utf8');
    const retain = options.retain ?? false;

    const puback = await this.transport.publish(topic, raw, { qos: 1, retain });

    this.sent.push({
      topic,
      kind,
      payload,
      raw,
      qos: 1,
      retain,
      puback,
      misbehaviour: options.misbehaviour ?? null,
    });
  }

  private key(): Buffer {
    return deriveCommandKey(this.serialNumber, this.keyVersion);
  }

  private uptimeMs(): number {
    return Math.max(0, this.now() - this.bootedAt);
  }
}

// --- Parsing, device-side ----------------------------------------------------

interface ParsedCommand {
  v: number;
  kv: number;
  commandId: string;
  type: string;
  serial: string;
  seq: number;
  /** Epoch ms. The device stores the parse, never the string. */
  issuedAt: number;
  ttlMs: number;
  sig: string;
}

/**
 * The device's own parse, deliberately **not** a zod schema.
 *
 * Firmware has no zod. If the simulator validated a command with the server's
 * schemas it would prove the server agrees with itself, which is the one thing
 * never in doubt. This is a hand-rolled field check of the kind a C
 * implementation would do, and it is loose on purpose: an unrecognised version
 * must reach the version check and be *acked* `BAD_VERSION` rather than
 * disappear into a parser.
 */
function parseCommand(raw: Buffer): ParsedCommand | null {
  let json: unknown;

  try {
    json = JSON.parse(raw.toString('utf8'));
  } catch {
    return null;
  }

  if (typeof json !== 'object' || json === null) return null;
  const body = json as Record<string, unknown>;

  const issuedAt = typeof body.issuedAt === 'string' ? Date.parse(body.issuedAt) : NaN;

  if (
    typeof body.v !== 'number' ||
    typeof body.kv !== 'number' ||
    typeof body.commandId !== 'string' ||
    typeof body.type !== 'string' ||
    typeof body.serial !== 'string' ||
    typeof body.seq !== 'number' ||
    typeof body.ttlMs !== 'number' ||
    typeof body.sig !== 'string' ||
    Number.isNaN(issuedAt)
  ) {
    return null;
  }

  return {
    v: body.v,
    kv: body.kv,
    commandId: body.commandId,
    type: body.type,
    serial: body.serial,
    seq: body.seq,
    issuedAt,
    ttlMs: body.ttlMs,
    sig: body.sig,
  };
}

/** Pulls the canonical ack input back out of a published payload. */
function ackCanonicalInput(payload: Record<string, unknown>): {
  commandId: string;
  seq: number;
  result: string;
  reason: string | null;
  lockState: string;
  doorState: string;
  bootId: string;
  measuredAtUptimeMs: number;
} {
  return {
    commandId: String(payload.commandId),
    seq: Number(payload.seq),
    result: String(payload.result),
    reason: (payload.reason as string | null) ?? null,
    lockState: String(payload.lockState),
    doorState: String(payload.doorState),
    bootId: String(payload.bootId),
    measuredAtUptimeMs: Number(payload.measuredAtUptimeMs),
  };
}

/** Random per boot, opaque by design: it exists to *differ*, not to be read. */
function freshBootId(): string {
  return crypto.randomBytes(6).toString('hex');
}

/**
 * A command id this device was never sent.
 *
 * Shaped like a cuid so it is refused for the right reason — a string that
 * failed the payload schema's length bound would never reach the ownership
 * check, and `DEVICE_ACK_FOREIGN_COMMAND` is the audit row under test.
 */
function foreignCommandId(): string {
  return `c${crypto.randomBytes(12).toString('hex')}`;
}
