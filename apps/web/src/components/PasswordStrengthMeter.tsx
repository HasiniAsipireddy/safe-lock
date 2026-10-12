'use client';

import { getPasswordStrength } from '@/lib/passwordStrength';
import { cn } from '@/lib/cn';

const BAR_COLORS = [
  'bg-slate-200 dark:bg-slate-700',
  'bg-red-500',
  'bg-amber-500',
  'bg-lime-500',
  'bg-emerald-500',
] as const;

const TEXT_COLORS = [
  'text-slate-500 dark:text-slate-400',
  'text-red-700 dark:text-red-400',
  'text-amber-700 dark:text-amber-400',
  'text-lime-700 dark:text-lime-400',
  'text-emerald-700 dark:text-emerald-400',
] as const;

export interface PasswordStrengthMeterProps {
  password: string;
  id?: string;
}

/** Four-segment strength meter shown under the signup password field. */
export function PasswordStrengthMeter({ password, id }: PasswordStrengthMeterProps) {
  const { score, label, hint } = getPasswordStrength(password);

  return (
    <div id={id} className="mt-1">
      <div className="flex gap-1.5" aria-hidden="true">
        {[1, 2, 3, 4].map((segment) => (
          <span
            key={segment}
            className={cn(
              'h-1.5 flex-1 rounded-full transition-colors duration-200',
              segment <= score ? BAR_COLORS[score] : BAR_COLORS[0],
            )}
          />
        ))}
      </div>
      <p aria-live="polite" className={cn('mt-1.5 text-xs font-medium', TEXT_COLORS[score])}>
        {password ? `Password strength: ${label}` : 'Password strength'}
        {hint ? <span className="font-normal text-slate-500 dark:text-slate-400"> — {hint}</span> : null}
      </p>
    </div>
  );
}
