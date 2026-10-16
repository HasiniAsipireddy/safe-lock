import {
  NOTIFICATION_COPY,
  type MarkNotificationsReadResponse,
  type NotificationItem,
  type NotificationsResponse,
} from '@safelock/shared';
import { prisma } from '../../lib/prisma';

/**
 * Reading and clearing in-app notifications.
 *
 * Writing them is not here: that happens through the {@link ../../lib/notifier
 * Notifier} seam, inside the transaction that records the device event, so a
 * notification can never describe something that did not happen.
 *
 * Every query is scoped to the session's `userId`. Nothing in a request can
 * widen it — not even the list of ids on the mark-read endpoint.
 */

/** Explicit projection: no `userId`, no internal columns. */
const NOTIFICATION_SELECT = {
  id: true,
  type: true,
  deviceEventId: true,
  createdAt: true,
  readAt: true,
} as const;

interface NotificationRow {
  id: string;
  type: 'UNLOCK_CONFIRMED' | 'UNLOCK_FAILED_MAX_ATTEMPTS';
  deviceEventId: string | null;
  createdAt: Date;
  readAt: Date | null;
}

function toNotificationItem(row: NotificationRow): NotificationItem {
  const copy = NOTIFICATION_COPY[row.type];

  return {
    id: row.id,
    type: row.type,
    title: copy.title,
    body: copy.body,
    deviceEventId: row.deviceEventId,
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt ? row.readAt.toISOString() : null,
  };
}

/**
 * The caller's notifications, unread first and newest first within each group,
 * plus the total unread count.
 *
 * The count is a separate query rather than `items.filter(…).length` because
 * the list is truncated by `limit`: counting the page would under-report the
 * badge the moment someone has more unread notifications than fit, which is
 * exactly when the badge matters.
 *
 * Unread-first is not configurable. A bell exists to surface what has not been
 * seen; letting a client reorder it serves nobody.
 */
export async function listNotifications(input: {
  userId: string;
  limit: number;
}): Promise<NotificationsResponse> {
  const [rows, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where: { userId: input.userId },
      // `nulls: 'first'` is what puts unread (readAt IS NULL) at the top.
      orderBy: [{ readAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'desc' }],
      take: input.limit,
      select: NOTIFICATION_SELECT,
    }),
    prisma.notification.count({ where: { userId: input.userId, readAt: null } }),
  ]);

  return { items: rows.map(toNotificationItem), unreadCount };
}

/**
 * Marks notifications read. Idempotent by construction.
 *
 * `ids` omitted means every unread notification of the caller's. Only rows
 * with `readAt: null` are touched, so a repeat call changes nothing and
 * reports `markedRead: 0` rather than quietly moving a timestamp that already
 * recorded when the user first saw it.
 *
 * Ids belonging to someone else simply do not match the `userId` filter and
 * are **silently ignored**. Answering 403 or 404 for them would confirm
 * whether an id exists — an existence oracle on another account's data, for no
 * benefit to a legitimate client, which only ever sends back ids it was given.
 */
export async function markNotificationsRead(input: {
  userId: string;
  ids?: string[] | undefined;
}): Promise<MarkNotificationsReadResponse> {
  const result = await prisma.notification.updateMany({
    where: {
      userId: input.userId,
      readAt: null,
      ...(input.ids ? { id: { in: input.ids } } : {}),
    },
    data: { readAt: new Date() },
  });

  const unreadCount = await prisma.notification.count({
    where: { userId: input.userId, readAt: null },
  });

  return { markedRead: result.count, unreadCount };
}
