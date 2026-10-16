import type { DeviceEventType } from '@safelock/shared';
import { cn } from '@/lib/cn';

/**
 * The icon for one activity row.
 *
 * **Never the only signal.** Every row carries its text label next to this,
 * and the icon shapes differ (closed padlock, open padlock, envelope, warning
 * triangle) rather than relying on colour alone — so the list is readable with
 * a colour vision deficiency, in high contrast, and with images disabled.
 * `aria-hidden` because the adjacent label already says it; announcing both
 * would be a stutter.
 */

const TONES: Record<DeviceEventType, string> = {
  LOCK: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  UNLOCK_REQUESTED: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300',
  UNLOCK_CONFIRMED: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300',
  UNLOCK_FAILED: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
};

export function EventIcon({ type }: { type: DeviceEventType }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex size-9 shrink-0 items-center justify-center rounded-full',
        TONES[type],
      )}
    >
      <svg
        className="size-5"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        focusable="false"
      >
        {type === 'LOCK' && (
          <>
            <rect x="3" y="11" width="18" height="10" rx="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </>
        )}
        {type === 'UNLOCK_CONFIRMED' && (
          <>
            <rect x="3" y="11" width="18" height="10" rx="2" />
            {/* Shackle swung open — distinct in shape, not just colour. */}
            <path d="M7 11V7a5 5 0 0 1 9.5-2" />
          </>
        )}
        {type === 'UNLOCK_REQUESTED' && (
          <>
            <rect x="3" y="5" width="18" height="14" rx="2" />
            <path d="m3 7 9 6 9-6" />
          </>
        )}
        {type === 'UNLOCK_FAILED' && (
          <>
            <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
            <path d="M12 9v4" />
            <path d="M12 17h.01" />
          </>
        )}
      </svg>
    </span>
  );
}
