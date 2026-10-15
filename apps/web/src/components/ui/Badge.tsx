import type { ReactNode } from 'react';
import type { DeviceStatus, LockState } from '@safelock/shared';
import { cn } from '@/lib/cn';

/**
 * Status pills.
 *
 * Colour is never the only signal — each badge also carries text — so the
 * state is still readable to someone who cannot distinguish the hues.
 */

type Tone = 'neutral' | 'positive' | 'warning' | 'danger' | 'info';

const TONES: Record<Tone, string> = {
  neutral:
    'bg-slate-100 text-slate-700 ring-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-700',
  positive:
    'bg-emerald-100 text-emerald-800 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-200 dark:ring-emerald-800',
  warning:
    'bg-amber-100 text-amber-900 ring-amber-200 dark:bg-amber-950 dark:text-amber-200 dark:ring-amber-800',
  danger:
    'bg-red-100 text-red-800 ring-red-200 dark:bg-red-950 dark:text-red-200 dark:ring-red-800',
  info: 'bg-brand-100 text-brand-800 ring-brand-200 dark:bg-brand-950 dark:text-brand-200 dark:ring-brand-800',
};

export function Badge({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset',
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

const LOCK_STATE_TONE: Record<LockState, Tone> = {
  LOCKED: 'positive',
  UNLOCKED: 'warning',
  UNKNOWN: 'neutral',
};

const LOCK_STATE_LABEL: Record<LockState, string> = {
  LOCKED: 'Locked',
  UNLOCKED: 'Unlocked',
  // Honest about not knowing, rather than implying a safe state.
  UNKNOWN: 'State unknown',
};

export function LockStateBadge({ state }: { state: LockState }) {
  return <Badge tone={LOCK_STATE_TONE[state]}>{LOCK_STATE_LABEL[state]}</Badge>;
}

export function OnlineBadge({ online }: { online: boolean }) {
  return (
    <Badge tone={online ? 'positive' : 'neutral'}>
      <span
        aria-hidden="true"
        className={cn('size-1.5 rounded-full', online ? 'bg-emerald-500' : 'bg-slate-400')}
      />
      {online ? 'Online' : 'Offline'}
    </Badge>
  );
}

const DEVICE_STATUS_TONE: Record<DeviceStatus, Tone> = {
  UNASSIGNED: 'info',
  ASSIGNED: 'positive',
  RETIRED: 'neutral',
};

const DEVICE_STATUS_LABEL: Record<DeviceStatus, string> = {
  UNASSIGNED: 'In stock',
  ASSIGNED: 'Assigned',
  RETIRED: 'Retired',
};

export function DeviceStatusBadge({ status }: { status: DeviceStatus }) {
  return <Badge tone={DEVICE_STATUS_TONE[status]}>{DEVICE_STATUS_LABEL[status]}</Badge>;
}
