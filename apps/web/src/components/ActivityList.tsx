'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { HistoryEvent, HistoryResponse } from '@safelock/shared';
import { Button } from '@/components/ui/Button';
import { EventIcon } from '@/components/EventIcon';
import { api } from '@/lib/api';
import { toUserMessage } from '@/lib/apiError';
import { formatFullTimestamp, formatTime, groupByDay } from '@/lib/datetime';

/**
 * The `/history` activity feed.
 *
 * Paginated with an explicit **"Load more" button, not infinite scroll**: an
 * infinite list has no end for a keyboard or screen reader user to reach, moves
 * the focus target out from under them as it grows, and strands anything below
 * it (a footer) permanently out of reach. A button is a stable, focusable,
 * announceable control that says how to get more.
 *
 * Five states are distinguishable, and the UI never conflates them: first
 * load, a page loading, empty, error (with retry), and end of list.
 */

type Status = 'loading' | 'ready' | 'error';

/** Rows per request. Within the API's max of 50. */
const PAGE_SIZE = 20;

export function ActivityList() {
  const [events, setEvents] = useState<HistoryEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** True once a response has arrived, so "empty" is never shown mid-load. */
  const [loaded, setLoaded] = useState(false);

  /**
   * Where to send focus after a page is appended.
   *
   * Without this, pressing "Load more" leaves focus on a button that may have
   * moved down the page while the new rows went in above it, and a screen
   * reader user is given no clue that anything happened. Focus lands on the
   * first new row's heading instead.
   */
  const newGroupAnchorRef = useRef<HTMLLIElement | null>(null);
  const shouldFocusRef = useRef(false);

  const load = useCallback(async (nextCursor: string | null, signal: AbortSignal) => {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (nextCursor) query.set('cursor', nextCursor);

    const response = await api.get<HistoryResponse>(`/devices/history?${query.toString()}`, {
      signal,
    });

    setEvents((current) => (nextCursor ? [...current, ...response.items] : response.items));
    setCursor(response.nextCursor);
    setStatus('ready');
    setLoaded(true);
    setError(null);
  }, []);

  // First page.
  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        await load(null, controller.signal);
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        setError(toUserMessage(cause));
        setStatus('error');
      }
    })();

    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    if (shouldFocusRef.current && newGroupAnchorRef.current) {
      newGroupAnchorRef.current.focus();
      shouldFocusRef.current = false;
    }
  }, [events]);

  async function loadMore() {
    if (!cursor) return;

    setLoadingMore(true);
    // Set before the await: the effect that moves focus runs after the new
    // rows are committed, and `events` here is the pre-append snapshot.
    shouldFocusRef.current = true;

    try {
      await load(cursor, new AbortController().signal);
    } catch (cause) {
      shouldFocusRef.current = false;
      setError(toUserMessage(cause));
    } finally {
      setLoadingMore(false);
    }
  }

  function retry() {
    setStatus('loading');
    setError(null);

    const controller = new AbortController();
    void (async () => {
      try {
        await load(null, controller.signal);
      } catch (cause) {
        setError(toUserMessage(cause));
        setStatus('error');
      }
    })();
  }

  if (status === 'loading' && !loaded) {
    return (
      <p
        role="status"
        aria-live="polite"
        className="rounded-2xl border border-slate-200 bg-white p-5 text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400"
      >
        Loading your activity…
      </p>
    );
  }

  if (status === 'error' && !loaded) {
    return (
      <section
        role="alert"
        className="rounded-2xl border border-red-300 bg-red-50 p-5 dark:border-red-900 dark:bg-red-950/40"
      >
        <h2 className="text-base font-bold text-red-900 dark:text-red-100">
          Could not load your activity
        </h2>
        <p className="mt-1 text-sm text-red-900/90 dark:text-red-200/90">{error}</p>
        <Button variant="secondary" className="mt-4" onClick={retry}>
          Try again
        </Button>
      </section>
    );
  }

  if (events.length === 0) {
    return (
      <section className="rounded-2xl border border-slate-200 bg-white p-6 text-center dark:border-slate-800 dark:bg-slate-900">
        <h2 className="text-base font-bold text-slate-900 dark:text-white">No activity yet</h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Locking and unlocking your safe will show up here.
        </p>
      </section>
    );
  }

  const groups = groupByDay(events);
  /**
   * The first row of the most recently appended page, so focus can be moved
   * onto it. Null until there is more than one page — on first load focus
   * belongs where the user left it.
   */
  const anchorId = events.length > PAGE_SIZE ? (events[events.length - PAGE_SIZE]?.id ?? null) : null;

  return (
    <div className="flex flex-col gap-6">
      {groups.map((group) => (
        <section key={group.key} aria-labelledby={`day-${group.key}`}>
          <h2
            id={`day-${group.key}`}
            className="sticky top-0 z-10 bg-slate-50 py-2 text-xs font-bold tracking-wide text-slate-500 uppercase dark:bg-slate-950 dark:text-slate-400"
          >
            {group.heading}
          </h2>

          <ul className="divide-y divide-slate-200 overflow-hidden rounded-2xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
            {group.items.map((event) => (
              <ActivityRow
                key={event.id}
                event={event}
                anchorRef={event.id === anchorId ? newGroupAnchorRef : undefined}
              />
            ))}
          </ul>
        </section>
      ))}

      {error && loaded && (
        <p
          role="alert"
          className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
        >
          {error}
        </p>
      )}

      {cursor ? (
        <Button
          variant="secondary"
          loading={loadingMore}
          loadingText="Loading…"
          onClick={() => void loadMore()}
        >
          Load more
        </Button>
      ) : (
        <p className="pb-2 text-center text-sm text-slate-500 dark:text-slate-400">
          That’s all your activity.
        </p>
      )}
    </div>
  );
}

/**
 * One event.
 *
 * The timestamp is a real `<time datetime>` carrying the machine-readable ISO
 * value, with the full local timestamp available three ways: as the accessible
 * name (`aria-label`), as a native tooltip on hover (`title`), and as a visible
 * tooltip on hover **or keyboard focus** — the row's time is focusable, so the
 * detail is not mouse-only.
 */
function ActivityRow({
  event,
  anchorRef,
}: {
  event: HistoryEvent;
  anchorRef?: React.RefObject<HTMLLIElement | null> | undefined;
}) {
  const full = formatFullTimestamp(event.createdAt);

  return (
    <li
      ref={anchorRef}
      tabIndex={anchorRef ? -1 : undefined}
      className="flex items-center gap-3 px-4 py-3 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-500"
    >
      <EventIcon type={event.type} />

      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-slate-900 dark:text-white">{event.label}</p>
        {event.failureLabel && (
          <p className="text-sm text-red-700 dark:text-red-300">{event.failureLabel}</p>
        )}
        <p className="truncate text-xs text-slate-500 dark:text-slate-400">{event.serialNumber}</p>
      </div>

      <span className="group relative shrink-0">
        <time
          dateTime={event.createdAt}
          aria-label={full}
          title={full}
          tabIndex={0}
          className="rounded text-sm text-slate-600 tabular-nums focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 dark:text-slate-400"
        >
          {formatTime(event.createdAt)}
        </time>

        {/* Visible on hover and on keyboard focus. aria-hidden because the
            aria-label above already carries the same string. */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute right-0 bottom-full z-20 mb-2 hidden w-max max-w-[16rem] rounded-lg bg-slate-900 px-2 py-1 text-xs font-medium text-white shadow-lg group-hover:block group-focus-within:block dark:bg-slate-700"
        >
          {full}
        </span>
      </span>
    </li>
  );
}
