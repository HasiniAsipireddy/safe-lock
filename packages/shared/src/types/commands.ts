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
