import { z } from 'zod';
import type { DeviceEventType } from '../types/devices';
import type { NotificationType, UnlockFailureReason } from '../types/history';

/**
 * Activity history and notification request schemas, plus the single source of
 * truth for user-facing event wording.
 *
 * The labels live here rather than in the web app so that the future mobile
 * client (roadmap item 7) renders the same words without reimplementing them,
 * and so a new `DeviceEventType` cannot be added without the compiler
 * pointing at the missing label.
 */

/** Page size for `/devices/history` and `/notifications`. */
export const HISTORY_DEFAULT_LIMIT = 20;
export const HISTORY_MAX_LIMIT = 50;

/**
 * Longest cursor accepted, in characters.
 *
 * A cursor is a base64url of `<iso timestamp>|<cuid>` — about 48 characters.
 * 200 is comfortable headroom and still refuses a megabyte of padding before
 * anything tries to decode it.
 */
export const CURSOR_MAX_LENGTH = 200;

/**
 * An opaque pagination cursor, as far as the client is concerned.
 *
 * Validated in two stages on purpose. This schema checks only the **shape** —
 * length and the base64url alphabet — so an oversized or obviously corrupt
 * value is refused before any decoding happens. The server then decodes it and
 * validates the payload, answering `INVALID_CURSOR` if it is malformed or
 * tampered with. Clients must treat the value as meaningless and simply hand
 * it back.
 */
export const cursorSchema = z
  .string()
  .trim()
  .min(1, 'Cursor must not be empty')
  .max(CURSOR_MAX_LENGTH, 'Cursor is too long')
  .regex(/^[A-Za-z0-9_-]+$/, 'Cursor is malformed');

const limitSchema = z.coerce
  .number()
  .int('Limit must be a whole number')
  .min(1, 'Limit must be at least 1')
  .max(HISTORY_MAX_LIMIT, `Limit must be at most ${HISTORY_MAX_LIMIT}`)
  .default(HISTORY_DEFAULT_LIMIT);

/** Query of `GET /devices/history`. */
export const historyQuerySchema = z.object({
  cursor: cursorSchema.optional(),
  limit: limitSchema,
});

/** Query of `GET /notifications`. Unread-first ordering is not configurable. */
export const notificationsQuerySchema = z.object({
  limit: limitSchema,
});

/**
 * Body of `POST /notifications/read`.
 *
 * `ids` omitted means "every unread notification of mine". Ids that are not
 * the caller's are **silently ignored** rather than rejected: a 403 on someone
 * else's id would confirm that the id exists, which is an existence oracle for
 * no benefit. See docs/decisions.md.
 */
export const markNotificationsReadSchema = z
  .object({
    ids: z
      .array(z.string().trim().min(1, 'Notification id must not be empty').max(64))
      .max(100, 'At most 100 notification ids per request')
      .optional(),
  })
  .strict();

export type HistoryQuery = z.infer<typeof historyQuerySchema>;
export type NotificationsQuery = z.infer<typeof notificationsQuerySchema>;
export type MarkNotificationsReadInput = z.infer<typeof markNotificationsReadSchema>;

// --- User-facing wording -----------------------------------------------------

/**
 * What each event type is called in the UI.
 *
 * `UNLOCK_REQUESTED` is worded carefully: a code being sent is not the safe
 * opening, and the history must not imply that it was.
 */
export const DEVICE_EVENT_LABELS: Record<DeviceEventType, string> = {
  LOCK: 'Safe locked',
  UNLOCK_REQUESTED: 'Unlock code sent',
  UNLOCK_CONFIRMED: 'Safe unlocked',
  UNLOCK_FAILED: 'Unlock failed',
};

/** Why an unlock failed, in words a safe owner can act on. */
export const UNLOCK_FAILURE_LABELS: Record<UnlockFailureReason, string> = {
  WRONG_CODE: 'Incorrect code',
  EXPIRED: 'Code had expired',
  TOO_MANY_ATTEMPTS: 'Too many incorrect codes',
  NO_CHALLENGE: 'No code was outstanding',
};

/** Heading and supporting line for each notification type. */
export const NOTIFICATION_COPY: Record<NotificationType, { title: string; body: string }> = {
  UNLOCK_CONFIRMED: {
    title: 'Your safe was unlocked',
    body: 'An unlock code was accepted and your safe was opened. If this was not you, lock it and contact support.',
  },
  UNLOCK_FAILED_MAX_ATTEMPTS: {
    title: 'Too many incorrect unlock codes',
    body: 'Someone entered the wrong code too many times and the code was cancelled. If this was not you, contact support.',
  },
};
