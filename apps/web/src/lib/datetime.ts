/**
 * Local-time formatting for the activity history.
 *
 * Everything here runs in the browser and formats in the **viewer's** time
 * zone. The API only ever sends ISO 8601 in UTC; converting on the server
 * would mean guessing where the user is, and a safe owner reading "unlocked at
 * 03:14" needs that to be their 03:14.
 *
 * These are only ever called from client components after data has loaded, so
 * there is no server/client hydration mismatch to worry about — the first
 * render is a loading state, not a timestamp.
 */

/** `14:32` — the time shown on a row. */
export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * `Thursday, 16 October 2026 at 14:32:07 GMT+5:30` — the full value exposed on
 * hover, on focus and to screen readers.
 *
 * Seconds and the zone are included deliberately: this is the detail someone
 * reaches for when they are trying to work out whether an unlock was theirs.
 */
export function formatFullTimestamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'full',
    timeStyle: 'long',
  });
}

/** A stable `YYYY-MM-DD` key in **local** time, for grouping rows by day. */
export function localDayKey(iso: string): string {
  const date = new Date(iso);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * The heading for a day group: `Today`, `Yesterday`, or a full date.
 *
 * Relative wording only for the two days people actually think of that way.
 * "3 days ago" is harder to reason about than a date, not easier.
 */
export function formatDayHeading(iso: string): string {
  const key = localDayKey(iso);
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  if (key === localDayKey(now.toISOString())) return 'Today';
  if (key === localDayKey(yesterday.toISOString())) return 'Yesterday';

  return new Date(iso).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/** `16 Oct, 14:32` — a booking's start or end, compact enough for a card. */
export function formatShortDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * `2h 15m`, `14m`, `0m` — a duration, for the time left on a booking.
 *
 * Clamped at zero rather than going negative, because every caller is counting
 * down to a deadline and "-3m left" is not a thing to show anybody. Whether
 * the deadline has *passed* is a separate question the caller already has to
 * ask, since what happens next differs: a lapsed hold is gone, a lapsed
 * booking starts accruing a fee.
 *
 * Seconds are deliberately absent above a minute. A safe rental is not a
 * stopwatch, and a ticking seconds display invites a per-second re-render for
 * no decision the user makes differently.
 */
export function formatDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

/** Milliseconds from now until an ISO instant. Negative once it has passed. */
export function msUntil(iso: string): number {
  return new Date(iso).getTime() - Date.now();
}

/** Groups events into consecutive day buckets, preserving their order. */
export function groupByDay<T extends { createdAt: string }>(
  items: T[],
): Array<{ key: string; heading: string; items: T[] }> {
  const groups: Array<{ key: string; heading: string; items: T[] }> = [];

  for (const item of items) {
    const key = localDayKey(item.createdAt);
    const current = groups.at(-1);

    if (current?.key === key) {
      current.items.push(item);
      continue;
    }
    groups.push({ key, heading: formatDayHeading(item.createdAt), items: [item] });
  }

  return groups;
}
