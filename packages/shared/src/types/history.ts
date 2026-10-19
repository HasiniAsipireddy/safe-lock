import type { DeviceEventType } from './devices';

/**
 * Activity history and in-app notifications.
 *
 * Both are the **user's own** data: a signed-in user sees their own events and
 * nothing else. What is deliberately absent from every shape here is as
 * important as what is present — see {@link HistoryEvent}.
 */

/**
 * Why an unlock attempt failed, as stored on the event.
 *
 * A fixed enum, never free text and never anything derived from what the user
 * typed. `NO_CHALLENGE` covers "no code was outstanding" — never requested,
 * already used, or superseded by a newer request.
 *
 * Events recorded before this column existed carry `null` and render as a
 * generic "Unlock failed" (see docs/decisions.md — there is no backfill).
 */
export type UnlockFailureReason =
  | 'WRONG_CODE'
  | 'EXPIRED'
  | 'TOO_MANY_ATTEMPTS'
  | 'NO_CHALLENGE'
  /**
   * The four below are failures **after a correct code** — ways an unlock can
   * fail that the mock gateway could not produce, because it acked
   * synchronously and always.
   *
   * `DEVICE_TIMEOUT` is the one to word carefully: the device did not answer,
   * which is not the same as the safe not opening. It may have. A late ack
   * will write an `UNLOCK_CONFIRMED` after this row if it did.
   */
  | 'DEVICE_TIMEOUT'
  | 'DEVICE_REJECTED'
  | 'DEVICE_FAILED'
  | 'DEVICE_OFFLINE';

/**
 * One row of the `/history` page.
 *
 * Note what a user never receives: the `requestId` (an internal correlation
 * id for server logs), the `deviceId`, the owner's `userId`, any IP address,
 * and anything OTP-related. `id` is here because the list needs a stable key
 * and the cursor is built from it.
 */
export interface HistoryEvent {
  id: string;
  type: DeviceEventType;
  /** User-facing wording for {@link type}, resolved server-side. */
  label: string;
  /** The safe this concerns, so history survives a device being replaced. */
  serialNumber: string;
  /** Null for every type except `UNLOCK_FAILED`, and null on legacy rows. */
  failureReason: UnlockFailureReason | null;
  /** User-facing wording for {@link failureReason}, or null. */
  failureLabel: string | null;
  /** ISO 8601. The client renders it in the viewer's local time zone. */
  createdAt: string;
}

/**
 * Response body of `GET /devices/history`.
 *
 * Cursor-based rather than offset-based: an append-only feed shifts under an
 * offset every time a new event lands, which silently duplicates or skips
 * rows between pages. See docs/decisions.md.
 */
export interface HistoryResponse {
  items: HistoryEvent[];
  /**
   * Pass back as `?cursor=` for the next page. `null` means end of list —
   * which is how the UI tells "no more" apart from "not loaded yet".
   */
  nextCursor: string | null;
}

// --- Notifications -----------------------------------------------------------

/**
 * What a notification is about.
 *
 * Deliberately **not** the same enum as `DeviceEventType`: most device events
 * generate no notification at all, and a later non-device notification
 * (allocation, say) should not have to pretend to be a device event. Only an
 * unlock — or an unlock attempt that burned every attempt — is worth
 * interrupting someone for. See docs/decisions.md.
 */
export type NotificationType = 'UNLOCK_CONFIRMED' | 'UNLOCK_FAILED_MAX_ATTEMPTS';

export interface NotificationItem {
  id: string;
  type: NotificationType;
  /** Short user-facing heading, resolved server-side. */
  title: string;
  /** One supporting sentence. Never contains a code or an identifier. */
  body: string;
  /** The event this is about, so the UI can deep-link into `/history`. */
  deviceEventId: string | null;
  createdAt: string;
  /** ISO timestamp, or null while unread. */
  readAt: string | null;
}

/** Response body of `GET /notifications`. */
export interface NotificationsResponse {
  /** Unread first, then newest first. Capped by the `limit` query parameter. */
  items: NotificationItem[];
  /**
   * Unread notifications for this user **in total**, not just within `items` —
   * the header badge must not under-report because the list was truncated.
   */
  unreadCount: number;
}

/** Response body of `POST /notifications/read`. */
export interface MarkNotificationsReadResponse {
  /** How many rows this call actually changed. Zero on a repeat call. */
  markedRead: number;
  /** Unread count after the write, so the badge needs no second request. */
  unreadCount: number;
}
