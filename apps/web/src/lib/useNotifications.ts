'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  MarkNotificationsReadResponse,
  NotificationItem,
  NotificationsResponse,
} from '@safelock/shared';
import { api } from './api';

/**
 * Polls `GET /notifications` and exposes the unread count for the header bell.
 *
 * **Polling, not websockets.** A socket per signed-in tab is a connection to
 * keep alive, authenticate, reconnect and scale for a payload that changes a
 * few times a day. A 60-second poll is less machinery and degrades to "the
 * badge is up to a minute stale", which is an acceptable property for a
 * notification about something that already happened — the authoritative
 * record is `/history`.
 *
 * **It stops when the tab is hidden.** A background tab left open overnight
 * would otherwise make ~480 pointless requests; the only thing it could
 * usefully do with the answer is nothing, because nobody is looking. On
 * becoming visible again it fetches **immediately** rather than waiting out
 * the remainder of an interval, so the first thing a returning user sees is
 * current.
 */

/** How often to poll while the tab is visible. */
export const NOTIFICATION_POLL_MS = 60_000;

/** How many notifications the bell's list holds. */
const NOTIFICATION_LIMIT = 10;

export interface UseNotificationsResult {
  items: NotificationItem[];
  unreadCount: number;
  /** 'loading' only before the first response; a failed poll keeps the last good data. */
  status: 'loading' | 'ready' | 'error';
  /** Set when the unread count has just risen, for an aria-live announcement. */
  announcement: string | null;
  /** Marks the currently loaded unread notifications read. */
  markRead: () => Promise<void>;
  /** Fetches now, outside the polling schedule. */
  refresh: () => void;
}

export function useNotifications(options: { enabled: boolean }): UseNotificationsResult {
  const { enabled } = options;

  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [announcement, setAnnouncement] = useState<string | null>(null);

  /**
   * The last count we announced, in a ref rather than state so the fetch
   * callback does not have to be recreated — and so the polling effect does
   * not restart every time a notification arrives.
   */
  const lastAnnouncedRef = useRef(0);
  const mountedRef = useRef(true);
  /** Bumped on every manual refresh to re-run the polling effect. */
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchNotifications = useCallback(async (signal: AbortSignal) => {
    try {
      const response = await api.get<NotificationsResponse>(
        `/notifications?limit=${NOTIFICATION_LIMIT}`,
        { signal },
      );
      if (!mountedRef.current || signal.aborted) return;

      setItems(response.items);
      setUnreadCount(response.unreadCount);
      setStatus('ready');

      // Announce only an *increase*, so marking things read is silent.
      if (response.unreadCount > lastAnnouncedRef.current) {
        setAnnouncement(
          response.unreadCount === 1
            ? '1 new safe notification'
            : `${response.unreadCount} unread safe notifications`,
        );
      }
      lastAnnouncedRef.current = response.unreadCount;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (!mountedRef.current) return;
      // A failed poll keeps whatever was last loaded: the bell going blank
      // because one request timed out would be worse than a stale count.
      setStatus((current) => (current === 'loading' ? 'error' : current));
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const isVisible = () =>
      typeof document === 'undefined' || document.visibilityState === 'visible';

    const run = async () => {
      await fetchNotifications(controller.signal);
      // Only schedule the next tick if the tab is still being looked at. If it
      // was hidden meanwhile, the visibility handler restarts the loop.
      if (!controller.signal.aborted && isVisible()) {
        timer = setTimeout(() => void run(), NOTIFICATION_POLL_MS);
      }
    };

    const onVisibilityChange = () => {
      if (isVisible()) {
        // Immediately, not after the remainder of an interval.
        if (timer) clearTimeout(timer);
        void run();
        return;
      }
      if (timer) clearTimeout(timer);
    };

    if (isVisible()) void run();
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [enabled, fetchNotifications, refreshToken]);

  const refresh = useCallback(() => {
    setRefreshToken((value) => value + 1);
  }, []);

  const markRead = useCallback(async () => {
    const unreadIds = items.filter((item) => item.readAt === null).map((item) => item.id);
    if (unreadIds.length === 0) return;

    try {
      const response = await api.post<MarkNotificationsReadResponse>('/notifications/read', {
        ids: unreadIds,
      });
      if (!mountedRef.current) return;

      setUnreadCount(response.unreadCount);
      lastAnnouncedRef.current = response.unreadCount;
      setAnnouncement(null);
      // Reflect it locally too, so the list does not flash back to unread
      // before the next poll lands.
      const readAt = new Date().toISOString();
      setItems((current) =>
        current.map((item) =>
          unreadIds.includes(item.id) ? { ...item, readAt: item.readAt ?? readAt } : item,
        ),
      );
    } catch {
      // The endpoint is idempotent, so the next open simply tries again. A
      // failure here must not stop the user reading their notifications.
    }
  }, [items]);

  return { items, unreadCount, status, announcement, markRead, refresh };
}
