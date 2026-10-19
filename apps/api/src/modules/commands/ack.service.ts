import type { CommandFailureCategory, UnlockFailureReason } from '@safelock/shared';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { prisma, type PrismaTransaction } from '../../lib/prisma';
import { notifier } from '../../lib/notifier';
import {
  deriveCommandKey,
  failureCategoryFor,
  verifyAckSignature,
  type AckPayload,
} from '../../lib/deviceProtocol';
import { AUDIT_ACTIONS, writeAudit } from '../audit/audit.service';
import { recordEvent } from '../devices/deviceEvents';
import { releaseChallenge } from './command.service';

/**
 * What a device says happened, and what the server does about it.
 *
 * This is where `Device.lockState` moves, and the only place it moves — not on
 * a button press, not on a publish. A safe recorded as locked has reported
 * itself locked.
 *
 * ## The measurement wins over the intent
 * A `FAILED` ack reporting `lockState: "UNLOCKED"` still moves the stored
 * state to `UNLOCKED`. The command failed; the safe is open; the dashboard
 * must say the safe is open. Recording what we asked for instead of what was
 * measured is how a product ends up telling someone their safe is locked while
 * it stands open.
 *
 * ## Four things are checked before anything is believed
 * The serial comes from the topic, the signature must verify under that
 * device's key, the command must exist **and belong to that device**, and the
 * correlation must still be fresh. Each failure drops the message and audits
 * it. "Cannot verify" never degrades to "accept" — the rule the Razorpay and
 * WhatsApp webhooks already follow.
 */

/** Statuses an ack may still settle. */
const SETTLEABLE = ['PENDING', 'SENT', 'TIMED_OUT'] as const;

/**
 * `PENDING` is in that list on purpose.
 *
 * An ack can beat its own `SENT` update: the mock gateway is in-process, and a
 * real broker on a fast link can deliver and be answered before the publishing
 * transaction commits. Excluding `PENDING` would drop exactly those acks —
 * the fastest, healthiest ones — and time the command out instead.
 */

export interface AckOutcome {
  applied: boolean;
  /** Why it was dropped, for the caller's log line. Null when applied. */
  droppedReason:
    | 'UNKNOWN_DEVICE'
    | 'BAD_SIGNATURE'
    | 'FOREIGN_COMMAND'
    | 'TOO_LATE'
    | 'ALREADY_SETTLED'
    | null;
}

const dropped = (reason: NonNullable<AckOutcome['droppedReason']>): AckOutcome => ({
  applied: false,
  droppedReason: reason,
});

/**
 * Applies one verified ack.
 *
 * @param serialNumber From the **topic**, never from the payload. The payload's
 *   own claim about which device it is cannot be the thing that decides which
 *   device's key verifies it — that would be asking a message to authenticate
 *   itself.
 */
export async function handleAck(
  serialNumber: string,
  payload: AckPayload,
  now: Date = new Date(),
): Promise<AckOutcome> {
  const device = await prisma.device.findUnique({
    where: { serialNumber },
    select: { id: true, commandKeyVersion: true, serialNumber: true },
  });

  if (!device) {
    logger.warn({ serialNumber }, 'Ack from a serial that is not in the inventory');
    return dropped('UNKNOWN_DEVICE');
  }

  if (!verifyAckSignature(deriveCommandKey(serialNumber, device.commandKeyVersion), payload)) {
    await writeAudit({
      action: AUDIT_ACTIONS.DEVICE_MESSAGE_SIGNATURE_INVALID,
      deviceId: device.id,
      metadata: { kind: 'ack', commandId: payload.commandId, seq: payload.seq },
    });
    return dropped('BAD_SIGNATURE');
  }

  /**
   * The ack is authentic, so the device is alive. Recorded before anything
   * else, and **regardless of what happens to the command** — liveness is a
   * fact about the radio, not about whether we could correlate the message.
   */
  await touchDevice(device.id, now);

  const command = await prisma.command.findUnique({
    where: { id: payload.commandId },
    select: {
      id: true,
      deviceId: true,
      type: true,
      status: true,
      seq: true,
      userId: true,
      systemActor: true,
      challengeId: true,
      expiresAt: true,
    },
  });

  /**
   * A device may only ack its own commands, and that is checked by joining the
   * command to the serial the message arrived on — not by trusting the
   * payload. Without the device check, a device holding a valid key could
   * settle another device's command simply by quoting its id.
   */
  if (!command || command.deviceId !== device.id) {
    await writeAudit({
      action: AUDIT_ACTIONS.DEVICE_ACK_FOREIGN_COMMAND,
      deviceId: device.id,
      metadata: {
        commandId: payload.commandId,
        known: command !== null,
        seq: payload.seq,
      },
    });
    return dropped('FOREIGN_COMMAND');
  }

  /**
   * Past the late-ack horizon the correlation is not worth trusting — but the
   * **measurement still is**, so the physical state has already been applied
   * by `touchDevice`'s sibling below before we give up on the command.
   *
   * The same shape of decision as the reminder staleness floor: late is false,
   * while the underlying thing it describes is still real.
   */
  if (now.getTime() - command.expiresAt.getTime() > env.COMMAND_LATE_ACK_MAX_MS) {
    await applyMeasuredState(prisma, device.id, payload, now);

    await writeAudit({
      action: AUDIT_ACTIONS.DEVICE_ACK_TOO_LATE,
      userId: command.userId,
      deviceId: device.id,
      metadata: {
        commandId: command.id,
        lateByMs: now.getTime() - command.expiresAt.getTime(),
        result: payload.result,
      },
    });

    return dropped('TOO_LATE');
  }

  const wasTimedOut = command.status === 'TIMED_OUT';
  const input: SettleInput = { device, command, payload, now, wasTimedOut };

  /**
   * ## Two transactions, and why the physical record goes first
   *
   * Step 5 made the in-app notification atomic with its `DeviceEvent`, and
   * deliberately let a notifier failure **roll the unlock back** — the trade
   * being that we would rather refuse to open a safe than open it without
   * telling the owner.
   *
   * That trade does not survive contact with hardware, because by the time an
   * ack arrives **the bolt has already moved**. There is no unlock left to
   * refuse. Rolling back here would not prevent an unannounced opening; it
   * would only leave a safe that is physically open recorded as locked, which
   * is the one outcome this whole protocol is arranged to avoid (it is why an
   * ack reports a *measured* state, and why a `FAILED` ack still moves
   * `lockState`).
   *
   * So the physical truth commits first and on its own, and the owner's record
   * follows in a second transaction. The step-5 contract is kept **where it
   * still means something**: the event and the notification are atomic with
   * each other, so there can be no event the owner was not told about. What
   * can now happen is a bolt that moved with the feed row missing — logged
   * loudly, and recoverable, which "safe silently recorded as shut" is not.
   * See docs/decisions.md.
   */
  const settled = await prisma.$transaction((tx) => settlePhysical(tx, input));

  if (!settled) {
    /**
     * A duplicate ack. Idempotent by construction: the terminal transition is
     * a conditional update, so the second one changes no row and writes no
     * second event and no second notification. A device re-acking a command
     * whose first answer was lost is ordinary QoS 1 behaviour, not an error.
     */
    return dropped('ALREADY_SETTLED');
  }

  /**
   * The owner's record, atomically with its notification.
   *
   * A system command has no owner's feed to write to — its record is the
   * command row and the audit trail, which is where an admin looks.
   */
  if (command.userId) {
    try {
      await prisma.$transaction((tx) =>
        writeUserFacingEvent(tx, input, payload.result === 'OK'),
      );
    } catch (cause) {
      /**
       * Swallowed, loudly. The bolt moved and the command row says so; the
       * alternative — propagating — would leave the caller's broker callback
       * with an exception and change nothing about the safe. The audit row
       * below is still written, so the event is reconstructable.
       */
      logger.error(
        {
          commandId: command.id,
          deviceId: device.id,
          reason: cause instanceof Error ? cause.message : 'unknown',
        },
        'A device command settled but its owner-facing event could not be written',
      );
    }
  }

  await writeAudit({
    action: wasTimedOut
      ? AUDIT_ACTIONS.DEVICE_COMMAND_LATE_ACK
      : AUDIT_ACTIONS.DEVICE_COMMAND_ACKED,
    userId: command.userId,
    deviceId: device.id,
    metadata: {
      commandId: command.id,
      type: command.type,
      result: payload.result,
      reason: payload.reason ?? null,
      lockState: payload.lockState,
      doorState: payload.doorState,
      ...(command.systemActor ? { systemActor: command.systemActor } : {}),
    },
  });

  return { applied: true, droppedReason: null };
}

/**
 * Advances liveness from any verified message.
 *
 * `online: true` is set alongside `lastSeenAt` because the two are read
 * together — but it is never the authority on its own: `isDeviceOnline`
 * requires the timestamp to be fresh as well, so this column going stale
 * cannot keep a dead device looking alive.
 */
export async function touchDevice(deviceId: string, now: Date): Promise<void> {
  await prisma.device.update({
    where: { id: deviceId },
    data: { online: true, lastSeenAt: now },
  });
}

/**
 * Writes the measured physical state. Used on both the normal and the
 * too-late path, which is the point of having it separate.
 */
async function applyMeasuredState(
  client: PrismaTransaction | typeof prisma,
  deviceId: string,
  payload: AckPayload,
  now: Date,
): Promise<void> {
  await client.device.update({
    where: { id: deviceId },
    data: {
      lockState: payload.lockState,
      doorState: payload.doorState,
      lockStateUpdatedAt: now,
      bootId: payload.bootId,
      /**
       * A safe that has reported itself shut is no longer an open-safe
       * incident, so the §8.3 flag clears here rather than on the reconciling
       * command's success. The distinction matters: the flag is about the
       * *safe's state*, and a lock command succeeding is only evidence of that
       * because the ack says `LOCKED`.
       */
      ...(payload.lockState === 'LOCKED' ? { unexpectedUnlockAt: null } : {}),
    },
  });
}

interface SettleInput {
  device: { id: string; serialNumber: string };
  command: {
    id: string;
    type: 'LOCK' | 'UNLOCK';
    status: string;
    userId: string | null;
    systemActor: string | null;
    challengeId: string | null;
  };
  payload: AckPayload;
  now: Date;
  wasTimedOut: boolean;
}

/** Status and failure category implied by a result. */
function statusFor(payload: AckPayload): {
  status: 'ACKED' | 'REJECTED' | 'FAILED';
  failureCategory: CommandFailureCategory | null;
} {
  if (payload.result === 'OK') return { status: 'ACKED', failureCategory: null };

  /**
   * Unreachable: the payload schema refuses a non-`OK` ack with no reason, and
   * refuses a reason from the wrong group for its result. Thrown rather than
   * defaulted, because a default here would invent a failure category and put
   * it in front of an admin as if the device had said it.
   */
  if (!payload.reason) {
    throw new Error(`A ${payload.result} ack reached the handler without a reason`);
  }

  return { status: payload.result, failureCategory: failureCategoryFor(payload.reason) };
}

/** How an unlock that failed *after a correct code* is shown to its owner. */
function unlockFailureReasonFor(result: 'REJECTED' | 'FAILED'): UnlockFailureReason {
  return result === 'REJECTED' ? 'DEVICE_REJECTED' : 'DEVICE_FAILED';
}

/**
 * The physical half of the settlement: the command row, the measured state and
 * the challenge, committed together.
 *
 * Returns false when another ack got there first — the conditional update is
 * what makes a duplicate ack idempotent, which is ordinary QoS 1 behaviour and
 * not an error: a device re-acking a command whose first answer was lost must
 * not produce a second event or a second notification.
 */
async function settlePhysical(
  tx: PrismaTransaction,
  input: SettleInput,
): Promise<boolean> {
  const { command, payload, now } = input;
  const { status, failureCategory } = statusFor(payload);

  const claimed = await tx.command.updateMany({
    where: { id: command.id, status: { in: [...SETTLEABLE] } },
    data: {
      status,
      failureCategory,
      ackedAt: now,
      ...(input.wasTimedOut ? { lateAckedAt: now } : {}),
    },
  });

  if (claimed.count !== 1) return false;

  await applyMeasuredState(tx, input.device.id, payload, now);

  const succeeded = payload.result === 'OK';

  /**
   * A system lock that worked clears the escalation flag.
   *
   * Only on success, and only for a lock: the flag means "we could not close
   * this safe", and the thing that disproves it is closing it.
   */
  if (succeeded && command.type === 'LOCK' && command.systemActor) {
    await tx.device.update({
      where: { id: input.device.id },
      data: { lockCommandFailedAt: null },
    });
  }

  await settleChallenge(tx, input, succeeded);

  return true;
}

/**
 * The code's half of the settlement.
 *
 * `OK` consumes it — dead forever. Anything else releases it, so a motor fault
 * does not charge the user for our hardware's mistake.
 *
 * The late case is the interesting one. A timeout already released the code,
 * possibly minutes ago, and it may well have been handed out and bound to
 * another command since. A late `OK` proves the bolt moved anyway, so the code
 * is spent: `consumedAt` is stamped **by challenge id**, found through this
 * command, and the release is not undone. Without that, a released code would
 * be a second use of a code that already opened a safe — which is the one
 * thing "single-use" has to mean.
 */
async function settleChallenge(
  tx: PrismaTransaction,
  input: SettleInput,
  succeeded: boolean,
): Promise<void> {
  if (!succeeded) {
    await releaseChallenge(tx, input.command.id);
    return;
  }

  /**
   * Found by the command's **immutable** record of which code bought it, not
   * by the challenge's mutable claim.
   *
   * That difference is the whole point. A timeout clears
   * `UnlockChallenge.commandId` — provisionally, because a release says only
   * *we have no evidence the bolt moved* — so looking the challenge up that
   * way would find nothing on the late path and leave a code that demonstrably
   * opened a safe available for a second use. `Command.challengeId` survives
   * the release, so evidence arriving late still spends the code.
   *
   * Falls back to the bound link for a command issued before that column
   * existed, and for any command that never had a challenge (a system lock),
   * where this is a no-op.
   */
  await tx.unlockChallenge.updateMany({
    where: {
      ...(input.command.challengeId
        ? { id: input.command.challengeId }
        : { commandId: input.command.id }),
      consumedAt: null,
    },
    data: { consumedAt: input.now, commandId: null },
  });

  /**
   * A successful unlock makes every other live command for this device
   * pointless, and a queued system lock actively wrong — its premise was that
   * the bolt had not moved.
   *
   * Cancelled rather than left to time out, so the admin view does not fill
   * with failures that were really withdrawals, and so the one-live-system-
   * command index frees up immediately.
   */
  if (input.wasTimedOut) {
    await tx.command.updateMany({
      where: {
        deviceId: input.device.id,
        id: { not: input.command.id },
        status: { in: ['PENDING', 'SENT'] },
      },
      data: { status: 'CANCELLED', failureCategory: 'SUPERSEDED' },
    });
  }
}

/**
 * The owner's record of what their safe did.
 *
 * **Written when the ack arrives, not when the command was sent.** The event
 * feed is the user-visible security record of a physical safe, and the fact
 * worth recording is that the bolt moved. Writing it on the request would make
 * `/history` a log of intentions.
 *
 * This is also what keeps `notifyUnlock`'s step-5 contract rather than
 * weakening it: the notification is still written in the same transaction as
 * the event it describes, so neither can exist without the other. It is now
 * atomic with the *true* event.
 */
async function writeUserFacingEvent(
  tx: PrismaTransaction,
  input: SettleInput,
  succeeded: boolean,
): Promise<void> {
  const { command, payload } = input;
  const userId = command.userId;
  if (!userId) return;

  if (command.type === 'LOCK') {
    // A failed lock writes no event. The user is watching a spinner that will
    // tell them, and the command row carries the detail — an "attempted to
    // lock" row in a security feed is noise that crowds out the signal.
    if (succeeded) {
      await recordEvent(tx, {
        deviceId: input.device.id,
        userId,
        type: 'LOCK',
        requestId: null,
      });
    }
    return;
  }

  if (succeeded) {
    const eventId = await recordEvent(tx, {
      deviceId: input.device.id,
      userId,
      type: 'UNLOCK_CONFIRMED',
      requestId: null,
    });

    /**
     * Tell the owner, in this transaction.
     *
     * On the late path this fires exactly when it is most useful: the user has
     * already been told the unlock failed, and needs to know that it did not.
     */
    await notifier.notifyUnlock(tx, {
      userId,
      type: 'UNLOCK_CONFIRMED',
      deviceEventId: eventId,
      serialNumber: input.device.serialNumber,
    });
    return;
  }

  await recordEvent(tx, {
    deviceId: input.device.id,
    userId,
    type: 'UNLOCK_FAILED',
    requestId: null,
    failureReason: unlockFailureReasonFor(payload.result as 'REJECTED' | 'FAILED'),
  });
}
