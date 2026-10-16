'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { useNotifications } from '@/lib/useNotifications';
import { formatFullTimestamp, formatTime } from '@/lib/datetime';
import { cn } from '@/lib/cn';

/**
 * The header's notification bell.
 *
 * Accessibility notes, because a badge is easy to get wrong:
 * - The button's accessible name **says the count in words**
 *   ("Notifications, 2 unread"), so it does not depend on reading a small
 *   coloured circle. The number inside the badge is `aria-hidden` to avoid
 *   announcing it twice.
 * - New notifications are announced through a polite `aria-live` region that
 *   lives outside the panel, so the announcement happens whether or not the
 *   panel is open.
 * - The panel is a real disclosure: `aria-expanded`, `aria-controls`, Escape
 *   closes it and returns focus to the button, and a click outside dismisses
 *   it. Focus moves into the panel on open so a keyboard user is not left
 *   behind it.
 *
 * Opening the panel marks the loaded notifications read — the endpoint is
 * idempotent, so a failed call simply retries on the next open.
 */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const { items, unreadCount, status, announcement, markRead, refresh } = useNotifications({
    enabled: true,
  });

  const panelId = useId();
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Close on Escape, returning focus to the trigger.
  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    }

    function onPointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    }

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [open]);

  // Move focus into the panel so the list is reachable by keyboard.
  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  function toggle() {
    const next = !open;
    setOpen(next);

    if (next) {
      // Fetch on open so the panel is never showing a minute-old list, then
      // clear the badge for what the user is now looking at.
      refresh();
      void markRead();
    }
  }

  const label =
    unreadCount === 0
      ? 'Notifications, none unread'
      : `Notifications, ${unreadCount} unread`;

  return (
    <div className="relative">
      {/* Outside the panel on purpose: an announcement must not depend on the
          panel being open, and a region inside a conditionally rendered
          element is not reliably announced. */}
      <p aria-live="polite" className="sr-only">
        {announcement ?? ''}
      </p>

      <button
        ref={buttonRef}
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={label}
        className="relative inline-flex size-10 items-center justify-center rounded-lg text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white"
      >
        <svg
          className="size-5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>

        {unreadCount > 0 && (
          <span
            aria-hidden="true"
            className="absolute -top-0.5 -right-0.5 inline-flex min-w-5 items-center justify-center rounded-full bg-red-600 px-1 text-xs font-bold text-white dark:bg-red-500"
          >
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          id={panelId}
          ref={panelRef}
          tabIndex={-1}
          role="group"
          aria-label="Notifications"
          className="absolute right-0 z-30 mt-2 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 dark:border-slate-700 dark:bg-slate-900"
        >
          <div className="border-b border-slate-200 px-4 py-3 dark:border-slate-700">
            <h2 className="text-sm font-bold text-slate-900 dark:text-white">Notifications</h2>
          </div>

          {status === 'loading' && (
            <p className="px-4 py-6 text-sm text-slate-600 dark:text-slate-400">Loading…</p>
          )}

          {status === 'error' && items.length === 0 && (
            <p role="alert" className="px-4 py-6 text-sm text-red-700 dark:text-red-300">
              Could not load notifications.
            </p>
          )}

          {status !== 'loading' && items.length === 0 && (
            <p className="px-4 py-6 text-sm text-slate-600 dark:text-slate-400">
              Nothing yet. You will be told here whenever your safe is unlocked.
            </p>
          )}

          {items.length > 0 && (
            <ul className="max-h-80 divide-y divide-slate-200 overflow-y-auto dark:divide-slate-800">
              {items.map((item) => (
                <li key={item.id}>
                  {/* Every notification links to the full record rather than
                      trying to be one. */}
                  <Link
                    href="/history"
                    onClick={() => setOpen(false)}
                    className={cn(
                      'block px-4 py-3 transition-colors hover:bg-slate-50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-500 dark:hover:bg-slate-800',
                      item.readAt === null && 'bg-brand-50/60 dark:bg-brand-950/30',
                    )}
                  >
                    <p className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-white">
                      {item.readAt === null && (
                        <>
                          <span
                            aria-hidden="true"
                            className="size-2 shrink-0 rounded-full bg-brand-600 dark:bg-brand-400"
                          />
                          {/* Unread is conveyed in text too, not by the dot
                              and background alone. */}
                          <span className="sr-only">Unread. </span>
                        </>
                      )}
                      {item.title}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-400">{item.body}</p>
                    <time
                      dateTime={item.createdAt}
                      title={formatFullTimestamp(item.createdAt)}
                      aria-label={formatFullTimestamp(item.createdAt)}
                      className="mt-1 block text-xs text-slate-500 tabular-nums dark:text-slate-500"
                    >
                      {formatTime(item.createdAt)}
                    </time>
                  </Link>
                </li>
              ))}
            </ul>
          )}

          <div className="border-t border-slate-200 px-4 py-2 dark:border-slate-700">
            <Link
              href="/history"
              onClick={() => setOpen(false)}
              className="inline-flex min-h-10 items-center text-sm font-semibold text-brand-700 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 dark:text-brand-300"
            >
              View all activity
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
