import {
  ERROR_CODES,
  isCommandSettled,
  type CommandStatus,
  type CommandStatusResponse,
} from '@safelock/shared';
import { HttpError } from '../../lib/httpError';
import { prisma } from '../../lib/prisma';

/**
 * Reading a command's outcome, for the client that is waiting on it.
 *
 * The status is **derived from the clock on every read**, exactly as a
 * booking's is. A `SENT` command past its expiry reads as `TIMED_OUT` and a
 * `PENDING` one reads as `EXPIRED` whether or not the sweeper has run, so a
 * late, wedged or never-started sweeper shows the user the right answer and
 * merely leaves rows untidy. Correctness never depends on a worker.
 */

const COMMAND_SELECT = {
  id: true,
  type: true,
  status: true,
  failureCategory: true,
  issuedAt: true,
  expiresAt: true,
  ackedAt: true,
  lateAckedAt: true,
  userId: true,
  device: { select: { lockState: true, doorState: true, lastSeenAt: true } },
} as const;

const notFound = () =>
  new HttpError({
    status: 404,
    code: ERROR_CODES.COMMAND_NOT_FOUND,
    message: 'That command does not exist.',
  });

/**
 * What a command's status is *now*.
 *
 * Note the direction of the derivation: it only ever moves a non-terminal
 * status to a terminal one. It cannot revive a settled row, so an ack that
 * arrived a millisecond before the expiry is never reported as a timeout.
 */
export function effectiveCommandStatus(
  command: { status: CommandStatus; expiresAt: Date },
  now: Date = new Date(),
): CommandStatus {
  if (isCommandSettled(command.status)) return command.status;
  if (now.getTime() <= command.expiresAt.getTime()) return command.status;

  return command.status === 'PENDING' ? 'EXPIRED' : 'TIMED_OUT';
}

/**
 * One command, for the caller who issued it.
 *
 * Scoped by `userId`, so a command id is not a handle on somebody else's
 * safe. **404 rather than 403** for another user's command: a 403 would
 * confirm the id exists, and a command id is the kind of thing that ends up in
 * a URL or a log a user can see.
 */
export async function readCommandStatus(
  userId: string,
  commandId: string,
  now: Date = new Date(),
): Promise<CommandStatusResponse> {
  const command = await prisma.command.findUnique({
    where: { id: commandId },
    select: COMMAND_SELECT,
  });

  if (!command || command.userId !== userId) throw notFound();

  const status = effectiveCommandStatus(command, now);

  return {
    id: command.id,
    type: command.type,
    status,
    settled: isCommandSettled(status),
    /**
     * A derived timeout carries no stored category — the sweeper has not
     * written one yet. `NO_ACK` is what it will write, and saying so now keeps
     * the two reads consistent rather than showing a blank that fills in later.
     */
    failureCategory:
      command.failureCategory ??
      (status === 'TIMED_OUT' ? 'NO_ACK' : status === 'EXPIRED' ? 'NOT_PUBLISHED' : null),
    issuedAt: command.issuedAt.toISOString(),
    expiresAt: command.expiresAt.toISOString(),
    ackedAt: command.ackedAt ? command.ackedAt.toISOString() : null,
    lateAckedAt: command.lateAckedAt ? command.lateAckedAt.toISOString() : null,
    /**
     * The device's state **as last acked**, not what the command asked for. A
     * failed unlock whose ack reported `UNLOCKED` says `UNLOCKED` here,
     * because the safe is open.
     */
    lockState: command.device.lastSeenAt ? command.device.lockState : null,
    doorState: command.device.lastSeenAt ? command.device.doorState : null,
  };
}
