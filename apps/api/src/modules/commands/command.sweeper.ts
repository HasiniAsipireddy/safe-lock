import type { CommandStatus, CommandType } from '@safelock/shared';
import { COMMAND_RETRY_BACKOFF_MS, env } from '../../config/env';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { AUDIT_ACTIONS, writeAudit } from '../audit/audit.service';
import { recordEvent } from '../devices/deviceEvents';
import { createCommand, publishCommand, releaseChallenge } from './command.service';

/**
 * The command timeout sweeper.
 *
 * ## It decides nothing, like the booking sweeper
 * `effectiveCommandStatus` derives "is this past its expiry" from the clock on
 * every read, so a wedged or never-started sweeper shows a waiting user the
 * right answer and merely leaves rows untidy. Nothing here may ever become the
 * only thing that enforces a transition — the same property that makes the
 * booking sweeper safe to operate.
 *
 * What it adds on top of that derivation is the work a read cannot do: writing
 * the terminal row, releasing the code bound to it, putting the failure in the
 * owner's feed, and — for a **system** lock, which nobody is waiting on —
 * retrying and then escalating.
 *
 * ## Three passes, in this order
 * 1. `SENT` past its expiry → `TIMED_OUT`. The device did not answer, so it may
 *    well have acted and the physical state is genuinely unknown.
 * 2. `PENDING` past its expiry → `EXPIRED`. The command never left the
 *    building, so we know nothing moved. Different fact, different remedy.
 * 3. A failed **system** `LOCK` → retry with a backoff, or escalate.
 *
 * The order matters only in that a command must be settled before it can be
 * retried; a retry issued in the same pass that timed its predecessor out is
 * exactly the intended behaviour once the backoff has elapsed.
 */

export interface CommandSweepResult {
  timedOut: number;
  expired: number;
  /** System locks re-issued with a fresh sequence number. */
  retried: number;
  /** System locks that ran out of attempts: flagged and sent for inspection. */
  escalated: number;
  /**
   * Rows this pass could not settle. Non-zero is not a crash — every row is
   * isolated — but a row that keeps failing is a safe whose record is drifting
   * further from the physical world every minute.
   */
  failed: number;
}

/** What settling one expired command needs to know. */
interface ExpiredCommand {
  id: string;
  deviceId: string;
  type: CommandType;
  status: CommandStatus;
  userId: string | null;
  systemActor: string | null;
}

/**
 * One pass. Exported and called directly by the tests — nothing in the suite
 * waits on a timer.
 */
export async function sweepCommands(
  options: { now?: Date } = {},
): Promise<CommandSweepResult> {
  const now = options.now ?? new Date();
  const result: CommandSweepResult = {
    timedOut: 0,
    expired: 0,
    retried: 0,
    escalated: 0,
    failed: 0,
  };

  const stale = await prisma.command.findMany({
    where: { status: { in: ['PENDING', 'SENT'] }, expiresAt: { lte: now } },
    orderBy: { issuedAt: 'asc' },
    select: {
      id: true,
      deviceId: true,
      type: true,
      status: true,
      userId: true,
      systemActor: true,
    },
  });

  for (const command of stale) {
    try {
      const settled = await settleExpired(command);
      if (settled === 'TIMED_OUT') result.timedOut += 1;
      else if (settled === 'EXPIRED') result.expired += 1;
    } catch (cause) {
      result.failed += 1;
      logger.error(
        {
          commandId: command.id,
          deviceId: command.deviceId,
          reason: cause instanceof Error ? cause.message : 'unknown',
        },
        'Could not settle an expired command',
      );
    }
  }

  const retries = await sweepSystemLocks(now);
  result.retried = retries.retried;
  result.escalated = retries.escalated;
  result.failed += retries.failed;

  return result;
}

// --- Settling what expired ---------------------------------------------------

/**
 * Writes one terminal row, and everything that must be true with it.
 *
 * **One transaction**, which is the §5.5 decision: the `Command` change and the
 * release of the code bound to it commit together. Two transactions would leave
 * a window in which the command is finished and the code is still held hostage
 * to it, and a user refreshing inside that window would be told their code is
 * unusable for a command that has already given up on them. Since it is one
 * commit there is no such window — and a sweeper that dies mid-pass leaves
 * neither half.
 *
 * Returns null when another writer settled the row first: an ack landing
 * between the read above and this update is the healthy case, not a conflict.
 */
async function settleExpired(
  command: ExpiredCommand,
): Promise<'TIMED_OUT' | 'EXPIRED' | null> {
  const timedOut = command.status === 'SENT';
  const status = timedOut ? 'TIMED_OUT' : 'EXPIRED';

  const applied = await prisma.$transaction(async (tx) => {
    const claimed = await tx.command.updateMany({
      where: { id: command.id, status: command.status },
      data: {
        status,
        failureCategory: timedOut ? 'NO_ACK' : 'NOT_PUBLISHED',
      },
    });

    if (claimed.count !== 1) return false;

    await releaseChallenge(tx, command.id);

    /**
     * A user's failed unlock belongs in their feed, with the reason that is
     * actually true of it.
     *
     * `DEVICE_TIMEOUT` and `DEVICE_OFFLINE` are kept apart because they mean
     * different things to the person reading the feed: a timeout means we
     * reached the safe and it never answered, so its state is unknown; a
     * command that never left means we could not reach it at all, and the bolt
     * certainly did not move.
     *
     * A failed **lock** writes no event, matching the ack handler: the user is
     * watching a spinner that will tell them, and an "attempted to lock" row
     * in a security feed is noise that crowds out the signal.
     */
    if (command.userId && command.type === 'UNLOCK') {
      await recordEvent(tx, {
        deviceId: command.deviceId,
        userId: command.userId,
        type: 'UNLOCK_FAILED',
        requestId: null,
        failureReason: timedOut ? 'DEVICE_TIMEOUT' : 'DEVICE_OFFLINE',
      });
    }

    return true;
  });

  if (!applied) return null;

  await writeAudit({
    action: AUDIT_ACTIONS.DEVICE_COMMAND_TIMED_OUT,
    userId: command.userId,
    deviceId: command.deviceId,
    metadata: {
      commandId: command.id,
      type: command.type,
      status,
      ...(command.systemActor ? { systemActor: command.systemActor } : {}),
    },
  });

  return status;
}

// --- Retrying and escalating a system lock -----------------------------------

/**
 * Statuses that mean a system lock did not demonstrably close the safe.
 *
 * `CANCELLED` is deliberately absent: it means the command was **withdrawn
 * because its premise stopped being true** — a late ack proved the bolt had
 * already moved — and retrying a withdrawal would re-send a command we decided
 * not to want.
 *
 * `REJECTED` and `FAILED` are present. One rule for every way a lock can not
 * happen, rather than a special case per reason: a bolt catching on a
 * misaligned door is the ordinary field failure and often clears on the second
 * attempt, and whatever the reason, three attempts without a safe reporting
 * itself shut is a job for a human either way.
 */
const UNFINISHED: CommandStatus[] = ['TIMED_OUT', 'EXPIRED', 'REJECTED', 'FAILED'];

interface SystemLockSweep {
  retried: number;
  escalated: number;
  failed: number;
}

async function sweepSystemLocks(now: Date): Promise<SystemLockSweep> {
  const outcome: SystemLockSweep = { retried: 0, escalated: 0, failed: 0 };

  /**
   * The most recent unfinished system lock per device.
   *
   * Grouped in application code rather than SQL because the set is small by
   * construction — at most one live system command per device, enforced by
   * `Command_one_live_system_per_device` — and the alternative is a window
   * function this query is not worth.
   *
   * Two conditions keep the candidate list from growing without bound: a
   * device already carrying `lockCommandFailedAt` has been escalated and is an
   * admin's problem now, and a device whose last report said `LOCKED` has
   * nothing left to reconcile.
   */
  const candidates = await prisma.command.findMany({
    where: {
      type: 'LOCK',
      systemActor: { not: null },
      status: { in: UNFINISHED },
      device: {
        lockCommandFailedAt: null,
        lockState: { not: 'LOCKED' },
      },
    },
    orderBy: { issuedAt: 'desc' },
    select: {
      id: true,
      deviceId: true,
      attempts: true,
      status: true,
      expiresAt: true,
      ackedAt: true,
      systemActor: true,
      bookingId: true,
    },
  });

  const newestPerDevice = new Map<string, (typeof candidates)[number]>();
  for (const command of candidates) {
    if (!newestPerDevice.has(command.deviceId)) newestPerDevice.set(command.deviceId, command);
  }

  for (const command of newestPerDevice.values()) {
    try {
      /**
       * Attempts exhausted. The safe may be standing open, which is the one
       * outcome this machinery exists to avoid quietly.
       */
      if (command.attempts >= env.COMMAND_MAX_ATTEMPTS) {
        const escalated = await escalate(command.deviceId, command.id, command.attempts, now);
        if (escalated) outcome.escalated += 1;
        continue;
      }

      /**
       * Backoff, measured from when this attempt actually failed.
       *
       * `ackedAt` for a device that answered `FAILED` in two seconds, the
       * expiry for one that never answered at all — otherwise a fast failure
       * would be retried on the schedule of a slow one.
       */
      const failedAt = command.ackedAt ?? command.expiresAt;
      const index = Math.min(
        Math.max(command.attempts - 1, 0),
        COMMAND_RETRY_BACKOFF_MS.length - 1,
      );
      // The index is clamped to the array, so the fallback is unreachable. Kept
      // because a retry with no backoff would hammer a jammed safe.
      const backoff = COMMAND_RETRY_BACKOFF_MS[index] ?? COMMAND_RETRY_BACKOFF_MS[0];

      if (now.getTime() - failedAt.getTime() < backoff) continue;

      const retried = await retry(command.deviceId, {
        systemActor: command.systemActor,
        bookingId: command.bookingId,
        attempts: command.attempts,
        now,
      });

      if (retried) outcome.retried += 1;
    } catch (cause) {
      outcome.failed += 1;
      logger.error(
        {
          commandId: command.id,
          deviceId: command.deviceId,
          reason: cause instanceof Error ? cause.message : 'unknown',
        },
        'Could not retry or escalate a system lock',
      );
    }
  }

  return outcome;
}

/**
 * Re-issues a system lock with a fresh sequence number.
 *
 * A **new row**, not a re-publish of the old one: the device rejects anything
 * at or below the highest sequence number it has seen, so a retry has to be a
 * new command to be acceptable at all. `attempts` carries across, which is what
 * makes the chain countable — the column means "attempts in this chain", and
 * `publishCommand` adds this one.
 *
 * Returns false when something else holds the device's one live system command
 * slot. That is a skip rather than a failure: a completion lock racing a
 * reconcile is two commands asking for the same end state, and the second would
 * be rejected by the device as a duplicate anyway.
 */
async function retry(
  deviceId: string,
  input: {
    systemActor: string | null;
    bookingId: string | null;
    attempts: number;
    now: Date;
  },
): Promise<boolean> {
  const issued = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Device" WHERE "id" = ${deviceId} FOR UPDATE`;

    const inFlight = await tx.command.findFirst({
      where: { deviceId, systemActor: { not: null }, status: { in: ['PENDING', 'SENT'] } },
      select: { id: true },
    });
    if (inFlight) return null;

    const command = await createCommand(tx, {
      deviceId,
      type: 'LOCK',
      /**
       * The retry inherits the actor that started the chain, so the admin view
       * still says *why* a safe is being closed — a completion that was never
       * confirmed reads differently from a safe found open.
       */
      systemActor: (input.systemActor as 'COMPLETION' | 'SWEEPER' | 'ADMIN' | null) ?? 'SWEEPER',
      bookingId: input.bookingId,
      now: input.now,
    });

    await tx.command.update({
      where: { id: command.id },
      data: { attempts: input.attempts },
    });

    return command;
  });

  if (!issued) return false;

  await publishCommand(issued);
  return true;
}

/**
 * The end of the line for a safe we could not close.
 *
 * Three things, and the third is the one the roadmap owed this path: the device
 * is stamped, flagged for admins, and moved to `NEEDS_INSPECTION`. A safe that
 * may be standing open must not be handed to the next renter, which is exactly
 * what that status already means — so the escalation reuses it rather than
 * inventing a second way to say the same thing.
 *
 * A device already `NEEDS_INSPECTION` is the common case, because every
 * completion reason except `COLLECTED` has already put it there; for those the
 * escalation adds urgency rather than state. `RETIRED` is left alone: it is off
 * the fleet, and un-retiring hardware because a lock did not ack would be the
 * wrong direction.
 */
async function escalate(
  deviceId: string,
  commandId: string,
  attempts: number,
  now: Date,
): Promise<boolean> {
  const stamped = await prisma.device.updateMany({
    where: { id: deviceId, lockCommandFailedAt: null },
    data: { lockCommandFailedAt: now },
  });

  // Another pass got here first. Not a failure, and not worth a second audit
  // row: the flag is already up.
  if (stamped.count !== 1) return false;

  const device = await prisma.device.findUnique({
    where: { id: deviceId },
    select: { status: true, lockState: true },
  });

  if (device?.status === 'AVAILABLE') {
    await prisma.device.update({
      where: { id: deviceId },
      data: {
        status: 'NEEDS_INSPECTION',
        inspectionNote:
          'The safe did not confirm it locked after repeated attempts — check whether it is physically shut',
        inspectionNotedAt: now,
      },
    });
  }

  await writeAudit({
    action: AUDIT_ACTIONS.DEVICE_LOCK_ESCALATED,
    deviceId,
    metadata: {
      commandId,
      attempts,
      lockState: device?.lockState ?? null,
      sentForInspection: device?.status === 'AVAILABLE',
    },
  });

  logger.error(
    { deviceId, commandId, attempts },
    'A safe could not be locked after every attempt; flagged and sent for inspection',
  );

  return true;
}

// --- The loop ----------------------------------------------------------------

let timer: NodeJS.Timeout | null = null;
let running = false;

/**
 * Starts the sweep loop.
 *
 * Called from `server.ts` only — **never** from `createApp()`, exactly like the
 * outbox worker and the booking sweeper. A loop that started with the app would
 * tick during the test suite and race every assertion about command state;
 * tests call {@link sweepCommands} directly instead.
 */
export function startCommandSweeper(): void {
  if (timer) return;

  timer = setInterval(() => {
    void tick();
  }, env.COMMAND_SWEEP_INTERVAL_MS);

  timer.unref();
  logger.info({ intervalMs: env.COMMAND_SWEEP_INTERVAL_MS }, 'Command sweeper started');
}

export function stopCommandSweeper(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;

  try {
    const result = await sweepCommands();
    const touched = result.timedOut + result.expired + result.retried + result.escalated;

    if (result.failed > 0) logger.warn(result, 'Command sweep finished with failures');
    else if (touched > 0) logger.info(result, 'Command sweep');
  } catch (cause) {
    logger.error(
      { reason: cause instanceof Error ? cause.message : 'unknown' },
      'Command sweep failed',
    );
  } finally {
    running = false;
  }
}
