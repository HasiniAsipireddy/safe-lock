'use client';

import { useRef, useState } from 'react';
import type { DeviceSummary, LockResponse } from '@safelock/shared';
import { LockStateBadge, OnlineBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { UnlockDialog } from '@/components/UnlockDialog';
import { useAuth } from '@/context/AuthContext';
import { api } from '@/lib/api';
import { toUserMessage } from '@/lib/apiError';

/**
 * The owner's safe, with working controls.
 *
 * The rules this component follows, all of which the API enforces anyway:
 * - **State is never optimistic.** Every control waits for the server's
 *   response and then renders the device the server returned. A safe that
 *   failed to move must not look as though it moved.
 * - **Unlock always goes through a code.** The button opens
 *   {@link UnlockDialog}; there is no path from here to an unlock request.
 * - **UNKNOWN disables everything.** It should not happen for a booked safe,
 *   but if it ever does the honest answer is "state unavailable", not a pair
 *   of buttons whose effect nobody can predict.
 * - **An outstanding overstay fee disables unlock, never lock.** The API
 *   refuses the unlock (402) and allows the lock, and the asymmetry is
 *   deliberate: refusing to let someone secure a safe they are standing at
 *   would punish them in the one direction that creates risk rather than
 *   recovering money.
 */
export function SafeCard({
  device: initial,
  overstayFeePaise = 0,
}: {
  device: DeviceSummary;
  /** Non-zero when a fee is owed. Disables unlock and says why. */
  overstayFeePaise?: number;
}) {
  const { user } = useAuth();
  const phoneVerified = user?.phoneVerified ?? false;
  const feeDue = overstayFeePaise > 0;
  const [device, setDevice] = useState(initial);
  const [locking, setLocking] = useState(false);
  const [confirmLock, setConfirmLock] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  /** Synchronous double-click guard — see the note in UnlockDialog. */
  const inFlight = useRef(false);

  const stateUnavailable = device.lockState === 'UNKNOWN';

  async function handleLock() {
    if (inFlight.current) return;
    inFlight.current = true;

    setConfirmLock(false);
    setLocking(true);
    setError(null);
    setStatus('Locking your safe…');

    try {
      const result = await api.post<LockResponse>('/devices/lock');
      setDevice(result.device);
      setStatus(result.alreadyLocked ? 'Your safe was already locked.' : 'Your safe is locked.');
    } catch (cause) {
      setStatus(null);
      setError(toUserMessage(cause));
    } finally {
      setLocking(false);
      inFlight.current = false;
    }
  }

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

      {/* Icon + words. The badge above carries colour; this carries meaning
          for anyone who cannot use colour to tell the two apart. */}
      <div className="mt-4 flex items-center gap-3 rounded-xl bg-slate-50 p-3 dark:bg-slate-800/50">
        <LockGlyph state={device.lockState} />
        <div>
          <p className="text-base font-bold text-slate-900 dark:text-white">
            {STATE_HEADING[device.lockState]}
          </p>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            {device.lockState === 'UNKNOWN'
              ? 'Your safe has not reported its state. Please contact support.'
              : `Last confirmed ${formatTimestamp(device.lockStateUpdatedAt)}`}
          </p>
        </div>
      </div>

      <dl className="mt-4 text-sm">
        <div>
          <dt className="text-slate-500 dark:text-slate-400">Last seen</dt>
          <dd className="mt-0.5 font-medium text-slate-900 dark:text-slate-100">
            {formatTimestamp(device.lastSeenAt)}
          </dd>
        </div>
      </dl>

      <div className="mt-5 flex flex-col gap-2 sm:flex-row">
        <Button
          onClick={() => setConfirmLock(true)}
          loading={locking}
          loadingText="Locking…"
          disabled={stateUnavailable || device.lockState === 'LOCKED'}
        >
          {device.lockState === 'LOCKED' ? 'Locked' : 'Lock'}
        </Button>
        {/*
          Unlock is disabled for an unverified number, because the API refuses
          it (403 PHONE_NOT_VERIFIED) — the one-time code has nowhere to go —
          and while a fee is owed, because the API refuses that too (402).
          Offering a button that cannot work and explaining afterwards is worse
          than saying so now; the booking card above carries the fix for each.

          Lock stays enabled in both cases: it needs no code and no settled
          fee, and a user must always be able to secure their own safe.
        */}
        <Button
          variant="secondary"
          onClick={() => setUnlocking(true)}
          disabled={stateUnavailable || locking || !phoneVerified || feeDue}
        >
          Unlock
        </Button>
      </div>

      {feeDue ? (
        <p className="mt-2 text-sm text-amber-800 dark:text-amber-200">
          Pay your overstay fee to unlock and collect your items. Locking still works.
        </p>
      ) : !phoneVerified ? (
        <p className="mt-2 text-sm text-amber-800 dark:text-amber-200">
          Verify your phone number to unlock. Locking still works.
        </p>
      ) : null}

      <p
        role="status"
        aria-live="polite"
        className="mt-2 min-h-5 text-sm text-slate-600 dark:text-slate-400"
      >
        {status}
      </p>
      <p
        role="alert"
        aria-live="assertive"
        className="min-h-5 text-sm font-medium text-red-700 dark:text-red-300"
      >
        {error}
      </p>

      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
        Unlocking always asks for a one-time code. Every lock and unlock is recorded.
      </p>

      {/* Lock is one tap plus a confirmation — it is not destructive, but
          locking a safe you are standing in front of is a real inconvenience. */}
      <ConfirmDialog
        open={confirmLock}
        title="Lock your safe?"
        description="The bolt will close immediately. You will need a one-time code to open it again."
        confirmLabel="Lock it"
        pending={locking}
        onConfirm={() => void handleLock()}
        onCancel={() => setConfirmLock(false)}
      />

      <UnlockDialog
        open={unlocking}
        onClose={() => setUnlocking(false)}
        onUnlocked={(updated) => {
          setDevice(updated);
          setStatus('Your safe is unlocked.');
          setError(null);
        }}
      />
    </section>
  );
}

const STATE_HEADING: Record<DeviceSummary['lockState'], string> = {
  LOCKED: 'Locked',
  UNLOCKED: 'Unlocked',
  UNKNOWN: 'State unavailable',
};

/** A padlock whose shackle is open, closed, or replaced by a question mark. */
function LockGlyph({ state }: { state: DeviceSummary['lockState'] }) {
  const tone =
    state === 'LOCKED'
      ? 'text-emerald-600 dark:text-emerald-400'
      : state === 'UNLOCKED'
        ? 'text-amber-600 dark:text-amber-400'
        : 'text-slate-500 dark:text-slate-400';

  return (
    <svg
      viewBox="0 0 24 24"
      className={`size-8 shrink-0 ${tone}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      // Decorative: the heading next to it already says the state in words.
      aria-hidden="true"
      focusable="false"
    >
      <rect x="4" y="10" width="16" height="10" rx="2" />
      {state === 'UNKNOWN' ? (
        <path d="M10 7a2 2 0 1 1 4 0c0 1.5-2 1.5-2 3" />
      ) : state === 'LOCKED' ? (
        <path d="M8 10V7a4 4 0 0 1 8 0v3" />
      ) : (
        <path d="M8 10V7a4 4 0 0 1 7.5-2" />
      )}
    </svg>
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
