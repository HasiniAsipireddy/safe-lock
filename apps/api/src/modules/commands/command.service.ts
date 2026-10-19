import {
  ERROR_CODES,
  type CommandStatus,
  type CommandType,
  type DeviceStatus,
} from '@safelock/shared';
import { conflict, HttpError } from '../../lib/httpError';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { prisma, type PrismaTransaction } from '../../lib/prisma';
import { deviceGateway } from '../../lib/deviceGateway';
import type { OutboundCommand } from '../../lib/deviceGateway';
import { AUDIT_ACTIONS, writeAudit } from '../audit/audit.service';
import { recordEvent } from '../devices/deviceEvents';

/**
 * The command lifecycle: created in a transaction, published after it.
 *
 * ## The one rule this module exists to enforce
 * **Nothing is published inside a transaction, and no row lock is held across
 * the radio.** The row is committed `PENDING`, then published, then moved to
 * `SENT`. This is the same rule the WhatsApp outbox already follows, for the
 * same two reasons: a rollback cannot un-publish, and a transaction that waits
 * on a network round trip makes a network outage fatal — and this one would
 * hold the device row lock while it waited, serialising the entire fleet
 * behind one slow radio.
 *
 * ## Why `PENDING` is a real state and not an implementation detail
 * The gap between the commit and the publish is a window in which the process
 * can die. A row left `PENDING` past its expiry is therefore meaningful: it
 * says the command **never left the building**, so we know nothing moved. That
 * is a different fact from `TIMED_OUT`, where the device may well have acted,
 * and the two need different answers. See `CommandStatus`.
 */

// --- Errors ------------------------------------------------------------------

/**
 * No `UNLOCK` is ever issued to a safe that is not `AVAILABLE`.
 *
 * A `NEEDS_INSPECTION` device keeps its MQTT credential on purpose — it is
 * still in the field, still ours, and an admin is about to need it to report
 * its state and accept a `LOCK`. But keeping a live credential is not the same
 * as keeping a live safe, and the two must not be allowed to drift together.
 *
 * It should also be unreachable: an inspecting device is excluded from the
 * booking pick, so no booking exists, so `assertCanOperate` has nothing to
 * authorise. "Should be unreachable" is a consequence of a `WHERE` clause
 * three modules away, though, and a physical-security guarantee should not
 * rest on one. See docs/device-protocol.md §2.3.
 */
const notOperable = (status: DeviceStatus) =>
  conflict(
    ERROR_CODES.DEVICE_NOT_OPERABLE,
    status === 'RETIRED'
      ? 'This safe has been retired and cannot be opened.'
      : 'This safe is awaiting inspection and cannot be opened. Please contact support.',
  );

/**
 * Another command is already on its way to this safe.
 *
 * The device holds no queue by design (docs/device-protocol.md §12): one
 * command at a time, and a second arriving while one is in flight is rejected
 * `UNSUPPORTED`. Anticipating that here is cheaper than spending a sequence
 * number to discover it, and gives the user a sentence that means something
 * instead of a device-level enum.
 */
const deviceBusy = () =>
  conflict(
    ERROR_CODES.DEVICE_BUSY,
    'Your safe is already carrying out another instruction. Wait a few seconds and try again.',
  );

// --- Creating a command ------------------------------------------------------

/**
 * The command already on its way to this device, if any.
 *
 * **Must be called under the device row lock**, which is what makes it a
 * decision rather than a guess: without the lock two concurrent taps both read
 * "nothing in flight" and both send.
 *
 * Expiry is applied here rather than trusted from the status, for the same
 * reason the status endpoint derives it: a `SENT` row past its `expiresAt` is
 * finished whether or not the sweeper has noticed, and treating it as live
 * would mean a wedged sweeper locked a user out of their own safe.
 */
export async function findLiveCommand(
  tx: PrismaTransaction,
  deviceId: string,
  now: Date = new Date(),
): Promise<{ id: string; type: CommandType; expiresAt: Date } | null> {
  return tx.command.findFirst({
    where: {
      deviceId,
      status: { in: ['PENDING', 'SENT'] },
      expiresAt: { gt: now },
    },
    orderBy: { issuedAt: 'desc' },
    select: { id: true, type: true, expiresAt: true },
  });
}

/**
 * Refuses when a command of a *different* type is in flight.
 *
 * Same-type is the caller's business: tapping Lock twice should return the
 * command already running rather than refuse, because the second tap is asking
 * for something that is already happening.
 */
export async function assertNotBusyWith(
  tx: PrismaTransaction,
  deviceId: string,
  type: CommandType,
  now: Date = new Date(),
): Promise<{ id: string; type: CommandType; expiresAt: Date } | null> {
  const live = await findLiveCommand(tx, deviceId, now);

  if (live && live.type !== type) throw deviceBusy();

  return live;
}

/** Everything the publisher needs, and nothing about who asked. */
export interface CommandRecord {
  id: string;
  deviceId: string;
  serialNumber: string;
  type: CommandType;
  seq: number;
  keyVersion: number;
  issuedAt: Date;
  expiresAt: Date;
  ttlMs: number;
  /** Null for a user command. Non-null is what licenses a retry. */
  systemActor: 'COMPLETION' | 'SWEEPER' | 'ADMIN' | null;
  userId: string | null;
  bookingId: string | null;
}

export interface CreateCommandInput {
  deviceId: string;
  type: CommandType;
  /** Exactly one of these two. The test for "is anyone waiting on this". */
  userId?: string | null;
  systemActor?: 'COMPLETION' | 'SWEEPER' | 'ADMIN' | null;
  bookingId?: string | null;
  /**
   * Which unlock code bought this command, recorded immutably.
   *
   * Set before the code is bound, because the bind needs this command's id and
   * the command needs the challenge's — so one of the two links has to be
   * written first, and this is the one that never changes.
   */
  challengeId?: string | null;
  /** Reuses the caller's clock, so a command and its audit row agree. */
  now?: Date;
}

/**
 * Allocates a sequence number and writes a `PENDING` command.
 *
 * **Must be called inside a transaction that already holds the device row
 * lock** (`lockDeviceRow`). That lock is what makes the sequence monotonic
 * under concurrency: two tabs tapping Unlock would otherwise both read
 * `commandSeq` and both be handed the same number, and the device — which
 * rejects anything at or below the highest it has seen — would refuse the
 * second as a replay. The lock is already taken for this kind of reason, so
 * monotonicity costs nothing new.
 *
 * A rolled-back transaction leaves a gap in the sequence. That is fine: the
 * device requires *increasing*, not contiguous.
 */
export async function createCommand(
  tx: PrismaTransaction,
  input: CreateCommandInput,
): Promise<CommandRecord> {
  const now = input.now ?? new Date();

  const device = await tx.device.findUniqueOrThrow({
    where: { id: input.deviceId },
    select: {
      id: true,
      serialNumber: true,
      status: true,
      commandKeyVersion: true,
    },
  });

  // The guarantee that does not depend on how the device got here.
  if (input.type === 'UNLOCK' && device.status !== 'AVAILABLE') {
    throw notOperable(device.status);
  }

  /**
   * One statement, under the lock the caller is holding.
   *
   * Raw SQL because Prisma has no `UPDATE … RETURNING`. The only interpolated
   * value is a device id we just read from our own database, bound as a
   * parameter rather than concatenated.
   */
  const allocated = await tx.$queryRaw<{ commandSeq: number }[]>`
    UPDATE "Device"
       SET "commandSeq" = "commandSeq" + 1
     WHERE "id" = ${input.deviceId}
    RETURNING "commandSeq"
  `;

  const seq = allocated[0]?.commandSeq;
  if (seq === undefined) {
    // Unreachable: the device row was just read inside this transaction.
    throw new Error(`Could not allocate a command sequence for ${input.deviceId}`);
  }

  const ttlMs = env.COMMAND_TTL_MS;

  const command = await tx.command.create({
    data: {
      deviceId: device.id,
      type: input.type,
      seq,
      issuedAt: now,
      expiresAt: new Date(now.getTime() + ttlMs),
      userId: input.userId ?? null,
      systemActor: input.systemActor ?? null,
      bookingId: input.bookingId ?? null,
      challengeId: input.challengeId ?? null,
    },
    select: { id: true, issuedAt: true, expiresAt: true },
  });

  return {
    id: command.id,
    deviceId: device.id,
    serialNumber: device.serialNumber,
    type: input.type,
    seq,
    keyVersion: device.commandKeyVersion,
    issuedAt: command.issuedAt,
    expiresAt: command.expiresAt,
    ttlMs,
    systemActor: input.systemActor ?? null,
    userId: input.userId ?? null,
    bookingId: input.bookingId ?? null,
  };
}

// --- Publishing --------------------------------------------------------------

/** What the publish attempt settled on. */
export interface PublishOutcome {
  status: Extract<CommandStatus, 'SENT' | 'EXPIRED'>;
  sentAt: Date | null;
}

/**
 * Publishes a committed command. **Call after the transaction has committed.**
 *
 * Never throws for a transport failure. The command's own row is where a
 * failure is recorded, and a caller that has already returned a `commandId` to
 * a user wants that row updated rather than an exception: the client is going
 * to poll, and the honest answer to "what happened to my command" is
 * `EXPIRED` / `PUBLISH_FAILED`, not a 500.
 */
export async function publishCommand(command: CommandRecord): Promise<PublishOutcome> {
  const outbound: OutboundCommand = {
    commandId: command.id,
    serialNumber: command.serialNumber,
    seq: command.seq,
    keyVersion: command.keyVersion,
    issuedAt: command.issuedAt,
    ttlMs: command.ttlMs,
  };

  try {
    const result =
      command.type === 'LOCK'
        ? await deviceGateway.sendLock(outbound)
        : await deviceGateway.sendUnlock(outbound);

    if (!result.published) throw new Error('the broker did not acknowledge the publish');

    /**
     * `SENT` only for a command still `PENDING`.
     *
     * The mock gateway's ack can arrive **before** this update runs — it is in
     * the same process — and a blind `update` would walk an `ACKED` row back
     * to `SENT`, losing the ack entirely. The conditional makes publishing and
     * acking order-independent, which a real broker on a fast link can also
     * demand.
     */
    await prisma.command.updateMany({
      where: { id: command.id, status: 'PENDING' },
      data: {
        status: 'SENT',
        sentAt: result.publishedAt,
        attempts: { increment: 1 },
      },
    });

    return { status: 'SENT', sentAt: result.publishedAt };
  } catch (cause) {
    logger.error(
      {
        commandId: command.id,
        serialNumber: command.serialNumber,
        reason: cause instanceof Error ? cause.message : 'unknown',
      },
      'Could not publish a device command',
    );

    await markPublishFailed(command);

    return { status: 'EXPIRED', sentAt: null };
  }
}

/**
 * Records a publish that never happened, and frees whatever was waiting on it.
 *
 * `EXPIRED`, not `TIMED_OUT`: we know the packet did not leave, so we know
 * nothing moved. And the bound unlock code is released in the **same
 * transaction**, so a finished command and a reusable code become true
 * together — there is no window in which the user's code is held hostage to a
 * command that has already given up.
 */
async function markPublishFailed(command: CommandRecord): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const settled = await tx.command.updateMany({
      where: { id: command.id, status: 'PENDING' },
      data: { status: 'EXPIRED', failureCategory: 'PUBLISH_FAILED', attempts: { increment: 1 } },
    });

    // Nothing to release if something else already settled this row — and
    // releasing anyway could unbind a code a *later* command legitimately holds.
    if (settled.count !== 1) return;

    await releaseChallenge(tx, command.id);

    /**
     * A user's unlock that never left the building is still their history.
     *
     * `DEVICE_OFFLINE` is the honest reason: the distinguishing fact about a
     * publish failure is that we could not reach the safe, and unlike a
     * timeout we know for certain the bolt did not move. Somebody looking at
     * their feed afterwards — wondering why their safe would not open — should
     * find this rather than a gap.
     */
    if (command.userId && command.type === 'UNLOCK') {
      await recordEvent(tx, {
        deviceId: command.deviceId,
        userId: command.userId,
        type: 'UNLOCK_FAILED',
        requestId: null,
        failureReason: 'DEVICE_OFFLINE',
      });
    }
  });

  await writeAudit({
    action: AUDIT_ACTIONS.DEVICE_COMMAND_PUBLISH_FAILED,
    userId: command.userId,
    deviceId: command.deviceId,
    metadata: { commandId: command.id, type: command.type },
  });
}

// --- The unlock challenge's half of the lifecycle ----------------------------

/**
 * Unbinds a challenge from a command that demonstrably opened nothing.
 *
 * Called wherever a terminal non-success status is set — here for a publish
 * failure, in the ack handler for `REJECTED`/`FAILED`, in the sweeper for
 * `TIMED_OUT`/`EXPIRED` — so there is no path that leaves a challenge bound to
 * a finished command.
 *
 * Takes the transaction client, and that is the contract: the release must
 * commit with the status change that justified it.
 *
 * Note what it does **not** touch: `consumedAt`, `expiresAt` and `attempts`.
 * Nothing about the code is extended to make rebinding work, so the attacker's
 * five guesses are still five guesses inside the same five minutes. And a
 * challenge already `consumedAt` is left alone — a code that opened a safe
 * stays dead even if some other row later says its command failed.
 */
export async function releaseChallenge(
  tx: PrismaTransaction,
  commandId: string,
): Promise<void> {
  await tx.unlockChallenge.updateMany({
    where: { commandId, consumedAt: null },
    data: { commandId: null },
  });
}

/**
 * The bind limit, as an error the user can act on.
 *
 * Its own code and its own wording because the remedy differs from every other
 * OTP failure: nothing they typed was wrong, and the honest message is about
 * the safe rather than about them.
 */
export const bindLimitReached = () =>
  new HttpError({
    status: 409,
    code: ERROR_CODES.OTP_BIND_LIMIT_REACHED,
    message:
      'Your safe did not open after several attempts with this code. Request a new code, and contact support if it keeps failing.',
  });
