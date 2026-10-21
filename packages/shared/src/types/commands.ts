/**
 * Device commands, as the client sees them.
 *
 * Under the mock gateway a lock or unlock was synchronous: the call returned
 * and the bolt had already moved. Over MQTT it cannot be. A command is
 * published, the device answers separately, and the answer may be lost, late
 * or never — so the client is handed a **command id** and polls for its
 * outcome rather than being told a result that was not yet known.
 *
 * Nothing in this file carries a signature, a sequence number or a key. Those
 * exist on the wire and in the database; a browser has no use for any of them,
 * and the one thing a client needs is "what happened to the thing I asked for".
 */

/** Mirrors the Prisma `CommandType` enum. */
export type CommandType = 'LOCK' | 'UNLOCK';

/**
 * Mirrors the Prisma `CommandStatus` enum.
 *
 * The client's only real question is terminal-or-not, which
 * {@link isCommandSettled} answers. The distinctions matter for what it then
 * says: `TIMED_OUT` means *we do not know* and must not be worded as a
 * failure to act, while `REJECTED` means nothing moved.
 */
export type CommandStatus =
  | 'PENDING'
  | 'SENT'
  | 'ACKED'
  | 'REJECTED'
  | 'FAILED'
  | 'TIMED_OUT'
  | 'EXPIRED'
  | 'CANCELLED';

/** Mirrors the Prisma `CommandFailureCategory` enum. */
export type CommandFailureCategory =
  | 'BAD_VERSION'
  | 'BAD_KEY_VERSION'
  | 'WRONG_DEVICE'
  | 'BAD_SIGNATURE'
  | 'SEQ_REPLAY'
  | 'DUPLICATE'
  | 'EXPIRED'
  | 'UNSUPPORTED'
  | 'MOTOR_FAULT'
  | 'JAMMED'
  | 'DOOR_OBSTRUCTED'
  | 'LOW_POWER'
  | 'SENSOR_FAULT'
  | 'NO_ACK'
  | 'PUBLISH_FAILED'
  | 'NOT_PUBLISHED'
  | 'SUPERSEDED';

/** Mirrors the Prisma `CommandActor` enum. */
export type CommandActor = 'COMPLETION' | 'SWEEPER' | 'ADMIN';

/** Mirrors the Prisma `DoorState` enum. See the schema on why `UNKNOWN` stays. */
export type DoorState = 'CLOSED' | 'OPEN' | 'UNKNOWN';

/**
 * Statuses that will never change again.
 *
 * The polling client stops on these. `PENDING` and `SENT` are the only two
 * that can still move — and a `SENT` command past its expiry is reported as
 * `TIMED_OUT` by the status endpoint without waiting for the sweeper, which is
 * why a wedged sweeper still shows a user the right answer.
 */
const SETTLED: readonly CommandStatus[] = [
  'ACKED',
  'REJECTED',
  'FAILED',
  'TIMED_OUT',
  'EXPIRED',
  'CANCELLED',
];

export function isCommandSettled(status: CommandStatus): boolean {
  return SETTLED.includes(status);
}

/**
 * Response body of `GET /devices/commands/:id`.
 *
 * `lockState` is the device's state **as last acked**, so a client that polls
 * to completion ends with the same truth the dashboard would show. It is not
 * what was requested — a `FAILED` unlock whose ack reports `UNLOCKED` says
 * `UNLOCKED`, because the safe is open and nothing should pretend otherwise.
 */
export interface CommandStatusResponse {
  id: string;
  type: CommandType;
  status: CommandStatus;
  /** True once {@link status} can no longer change. The client's stop signal. */
  settled: boolean;
  /** Null unless the command failed. A closed enum, never a broker string. */
  failureCategory: CommandFailureCategory | null;
  issuedAt: string;
  /** When the server stops waiting. The client's own countdown matches it. */
  expiresAt: string;
  ackedAt: string | null;
  /**
   * Set when the ack arrived after we had already given up.
   *
   * The client shows the outcome it describes rather than the failure it first
   * reported — a safe that opened late is open, and the user needs to know
   * that more than they need our timer vindicated.
   */
  lateAckedAt: string | null;
  /** The device's state as last acked, or null if it has never reported. */
  lockState: 'LOCKED' | 'UNLOCKED' | 'UNKNOWN' | null;
  doorState: DoorState | null;
}

/**
 * Response body of `POST /devices/lock` and `POST /devices/unlock/confirm`.
 *
 * **202, not 200**, and a command id rather than a device: the request has
 * been accepted and the bolt has not moved yet. Returning a device summary
 * here would be returning a state nobody has confirmed, which is the one thing
 * `lockState` moves only on an ack exists to prevent.
 */
export interface CommandAcceptedResponse {
  /**
   * The command to poll, or **null** when none was issued because the safe was
   * already in the requested state (see {@link alreadyInState}).
   *
   * Null rather than an id pointing at nothing: a client that polls a
   * fabricated id would get a 404 and show an error for what was a success.
   */
  commandId: string | null;
  status: CommandStatus;
  /** How long the client should wait before its first poll, in milliseconds. */
  pollAfterMs: number;
  /** When the server will stop waiting, so the client's spinner has an end. */
  expiresAt: string;
  /**
   * True when the safe was already in the requested state, so no command was
   * issued and `commandId` refers to nothing to wait for.
   *
   * Only ever set for `LOCK`: locking is idempotent and an already-locked safe
   * is a success. There is no such shortcut for unlocking — a code was spent,
   * and "it was already open" is not an answer anyone should accept from a
   * safe.
   */
  alreadyInState?: boolean;
}

/**
 * What to tell the user about a settled command, for each type.
 *
 * Here rather than in a component for the reason `NOTIFICATION_COPY` is: the
 * API owns the fact and the UI owns the wording, and two places that both
 * phrase "your safe did not answer" will eventually phrase it differently.
 *
 * The wording is the hard part, and `TIMED_OUT` is why. It does **not** say
 * the safe stayed shut, because we do not know that — the bolt may have moved
 * and the ack been lost. Claiming otherwise would be a UI lying about a
 * physical safe, and would contradict the `UNLOCK_CONFIRMED` that appears in
 * the feed if the ack turns up late. `EXPIRED` is the opposite case and can
 * afford to be definite: nothing left the building, so nothing moved.
 */
export const COMMAND_OUTCOME_COPY: Record<
  CommandType,
  Partial<Record<CommandStatus, { tone: 'success' | 'warning' | 'error'; message: string }>>
> = {
  LOCK: {
    ACKED: { tone: 'success', message: 'Your safe is locked.' },
    REJECTED: {
      tone: 'error',
      message: 'Your safe refused the instruction and did not move. Please contact support.',
    },
    FAILED: {
      tone: 'error',
      message: 'Your safe tried to lock and could not. Check that nothing is obstructing the door, then try again.',
    },
    TIMED_OUT: {
      tone: 'warning',
      message: 'Your safe did not answer, so we cannot confirm whether it locked. Check it, and try again.',
    },
    EXPIRED: {
      tone: 'error',
      message: 'We could not reach your safe, so nothing was sent to it. Try again in a moment.',
    },
    CANCELLED: {
      tone: 'warning',
      message: 'That instruction was withdrawn because something else happened to your safe.',
    },
  },
  UNLOCK: {
    ACKED: { tone: 'success', message: 'Your safe is unlocked.' },
    REJECTED: {
      tone: 'error',
      message: 'Your safe refused to open and did not move. Your code was correct — please contact support.',
    },
    FAILED: {
      tone: 'error',
      message: 'Your safe tried to open and could not. Your code was correct, so please contact support.',
    },
    TIMED_OUT: {
      tone: 'warning',
      message: 'Your safe did not answer, so we cannot confirm whether it opened. Check it before requesting another code.',
    },
    EXPIRED: {
      tone: 'error',
      message: 'We could not reach your safe, so it did not open. Your code has not been used — try again in a moment.',
    },
    CANCELLED: {
      tone: 'warning',
      message: 'That unlock was withdrawn because something else happened to your safe.',
    },
  },
};

/**
 * The copy for one settled command, with a fallback that cannot be reached.
 *
 * Thrown rather than defaulted would be wrong here — this runs in a browser
 * while somebody is waiting on a bolt — but a silent empty string would be
 * worse, so the fallback is deliberately generic and deliberately honest about
 * not knowing.
 */
export function commandOutcomeCopy(
  type: CommandType,
  status: CommandStatus,
): { tone: 'success' | 'warning' | 'error'; message: string } {
  return (
    COMMAND_OUTCOME_COPY[type][status] ?? {
      tone: 'warning',
      message: 'We could not confirm what your safe did. Check it, and contact support if it looks wrong.',
    }
  );
}
