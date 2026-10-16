import {
  DEVICE_EVENT_LABELS,
  ERROR_CODES,
  UNLOCK_FAILURE_LABELS,
  type HistoryEvent,
  type HistoryResponse,
} from '@safelock/shared';
import { prisma } from '../../lib/prisma';
import { HttpError } from '../../lib/httpError';

/**
 * The user-visible activity feed behind `GET /devices/history`.
 *
 * Two properties this module exists to guarantee:
 *
 * 1. **Only the caller's own events.** Every query filters on `userId` from
 *    the session. There is no device id, event id or user id in the request
 *    that could widen it — the cursor included (see {@link decodeCursor}).
 * 2. **Nothing internal is serialised.** `requestId`, `deviceId` and `userId`
 *    appear in no select list here, so a column added to `DeviceEvent` later
 *    cannot leak into a response by default.
 */

// --- Projection --------------------------------------------------------------

/**
 * Exactly what the feed may read.
 *
 * Explicit, per the same rule as the admin selects: `requestId` is an internal
 * correlation id for server logs and is **deliberately absent**, as is
 * `deviceId`. The serial number comes through the relation because it is what
 * a person recognises, and it is already visible on their dashboard.
 */
const HISTORY_EVENT_SELECT = {
  id: true,
  type: true,
  failureReason: true,
  createdAt: true,
  device: { select: { serialNumber: true } },
} as const;

interface HistoryEventRow {
  id: string;
  type: 'LOCK' | 'UNLOCK_REQUESTED' | 'UNLOCK_CONFIRMED' | 'UNLOCK_FAILED';
  failureReason: 'WRONG_CODE' | 'EXPIRED' | 'TOO_MANY_ATTEMPTS' | 'NO_CHALLENGE' | null;
  createdAt: Date;
  device: { serialNumber: string };
}

function toHistoryEvent(row: HistoryEventRow): HistoryEvent {
  // A reason only means something on a failure. Guarded rather than assumed,
  // so a stray value on another type cannot produce nonsense like
  // "Safe locked — incorrect code".
  const failureReason = row.type === 'UNLOCK_FAILED' ? row.failureReason : null;

  return {
    id: row.id,
    type: row.type,
    label: DEVICE_EVENT_LABELS[row.type],
    serialNumber: row.device.serialNumber,
    failureReason,
    failureLabel: failureReason ? UNLOCK_FAILURE_LABELS[failureReason] : null,
    createdAt: row.createdAt.toISOString(),
  };
}

// --- Cursor ------------------------------------------------------------------

interface CursorPosition {
  createdAt: Date;
  id: string;
}

const invalidCursor = () =>
  new HttpError({
    status: 400,
    code: ERROR_CODES.INVALID_CURSOR,
    message: 'That page link is no longer valid. Reload your activity history.',
  });

/** cuid / cuid2 alphabet, length-capped so a decoded blob cannot be huge. */
const CURSOR_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Encodes a position as `base64url("<iso>|<id>")`.
 *
 * Opaque to the client by intent, **not** by security: a cursor is not a
 * capability and grants nothing. Every query is scoped to the session's
 * `userId`, so the worst a hand-crafted cursor can do is move the window
 * within the caller's own events — which is why it is not signed. If a cursor
 * ever carries something that is not derivable by the caller, it must be
 * signed at that point.
 */
export function encodeCursor(position: CursorPosition): string {
  return Buffer.from(`${position.createdAt.toISOString()}|${position.id}`, 'utf8').toString(
    'base64url',
  );
}

/**
 * Decodes a cursor, or throws a 400.
 *
 * Validated strictly, because base64url decoding is lenient: almost any string
 * in the alphabet decodes to *something*, so the decoded payload has to be
 * checked rather than trusted. The timestamp is round-tripped through
 * `toISOString()` and compared, which is what rejects a value that `Date`
 * parses loosely (`2026-13-45T…`) or renders differently.
 *
 * Length is already capped by `cursorSchema` before anything reaches here, so
 * an oversized cursor is refused without allocating a buffer for it.
 */
export function decodeCursor(cursor: string): CursorPosition {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw invalidCursor();
  }

  const parts = decoded.split('|');
  if (parts.length !== 2) throw invalidCursor();

  const [isoTimestamp, id] = parts as [string, string];

  if (!CURSOR_ID_PATTERN.test(id)) throw invalidCursor();

  const createdAt = new Date(isoTimestamp);
  if (Number.isNaN(createdAt.getTime())) throw invalidCursor();
  if (createdAt.toISOString() !== isoTimestamp) throw invalidCursor();

  return { createdAt, id };
}

// --- Query -------------------------------------------------------------------

export interface HistoryPageInput {
  userId: string;
  limit: number;
  cursor?: string | undefined;
}

/**
 * One page of the caller's activity, newest first.
 *
 * **Keyset pagination on `(createdAt DESC, id DESC)`**, not `skip`/`take`.
 * This is an append-only feed: with an offset, an event arriving between two
 * page requests shifts every later row down one, so page 2 repeats a row page
 * 1 already showed. A keyset asks "what comes strictly after this exact
 * position", which is stable no matter what is inserted.
 *
 * `id` is in the sort key because `createdAt` is not unique — two events can
 * share a millisecond, and a lock plus its event can land in the same tick.
 * Ordering by timestamp alone leaves their relative order undefined, so a page
 * boundary falling between them would skip one or return it twice. The
 * `@@index([userId, createdAt, id])` covers exactly this scan.
 *
 * `limit + 1` rows are fetched to learn whether another page exists without a
 * second count query; the extra row is dropped before responding.
 */
export async function getHistoryPage(input: HistoryPageInput): Promise<HistoryResponse> {
  const after = input.cursor ? decodeCursor(input.cursor) : null;

  const rows = await prisma.deviceEvent.findMany({
    where: {
      userId: input.userId,
      ...(after
        ? {
            OR: [
              { createdAt: { lt: after.createdAt } },
              { createdAt: after.createdAt, id: { lt: after.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: input.limit + 1,
    select: HISTORY_EVENT_SELECT,
  });

  const hasMore = rows.length > input.limit;
  const page = hasMore ? rows.slice(0, input.limit) : rows;
  const last = page.at(-1);

  return {
    items: page.map(toHistoryEvent),
    // Null means end of list, which is how the UI distinguishes "that was
    // everything" from "there is more to load".
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}
