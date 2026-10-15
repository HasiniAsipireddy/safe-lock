'use client';

import type { DeviceSummary } from '@safelock/shared';
import { LockStateBadge, OnlineBadge } from '@/components/ui/Badge';

/**
 * The owner's safe.
 *
 * Lock and Unlock are rendered **disabled** and labelled "Coming soon". They
 * are deliberately inert: the command layer, the OTP flow and the hardware
 * driver do not exist yet, and a button that looks live but silently does
 * nothing is worse than one that says so — this product's buttons will move a
 * physical bolt.
 *
 * When they are implemented they must require a paid user **and** an assigned
 * device, and unlocking must additionally require a valid OTP.
 */
export function SafeCard({ device }: { device: DeviceSummary }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
            Your safe
          </h2>
          <p className="mt-1 font-mono text-lg font-bold text-slate-900 dark:text-white">
            {device.serialNumber}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <LockStateBadge state={device.lockState} />
          <OnlineBadge online={device.online} />
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-slate-500 dark:text-slate-400">Last seen</dt>
          <dd className="mt-0.5 font-medium text-slate-900 dark:text-slate-100">
            {formatTimestamp(device.lastSeenAt)}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500 dark:text-slate-400">Allocated</dt>
          <dd className="mt-0.5 font-medium text-slate-900 dark:text-slate-100">
            {formatTimestamp(device.allocatedAt)}
          </dd>
        </div>
      </dl>

      <div className="mt-5 flex flex-col gap-2 sm:flex-row">
        <ComingSoonButton label="Lock" />
        <ComingSoonButton label="Unlock" />
      </div>
      <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
        Remote locking is not enabled yet. Unlocking will ask for a one-time code.
      </p>
    </section>
  );
}

/**
 * A control that is visibly present but not yet functional.
 *
 * `disabled` plus explicit text, rather than a handler that shows "not
 * implemented" — the state is legible before the tap, not after.
 */
function ComingSoonButton({ label }: { label: string }) {
  return (
    <button
      type="button"
      disabled
      aria-disabled="true"
      className="inline-flex min-h-12 w-full cursor-not-allowed items-center justify-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-5 text-base font-semibold text-slate-400 select-none dark:border-slate-800 dark:bg-slate-800/50 dark:text-slate-500"
    >
      {label}
      <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-semibold text-slate-600 dark:bg-slate-700 dark:text-slate-300">
        Coming soon
      </span>
    </button>
  );
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return 'Never';

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Unknown';

  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}
