'use client';

import { useId, useState, type ComponentPropsWithRef, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { FormError } from './FormError';
import { inputBaseClasses, inputStateClasses } from './Input';

export interface PasswordInputProps
  extends Omit<ComponentPropsWithRef<'input'>, 'id' | 'className' | 'type'> {
  label: string;
  error?: string;
  hint?: string;
  /** Rendered under the field, e.g. the strength meter. */
  footer?: ReactNode;
  className?: string;
}

/**
 * Password field with a "Show password" toggle.
 *
 * The value is only ever held by the form library in memory — this component
 * never copies, stores or logs it.
 */
export function PasswordInput({
  label,
  error,
  hint,
  footer,
  className,
  ...inputProps
}: PasswordInputProps) {
  const [revealed, setRevealed] = useState(false);
  const reactId = useId();
  const inputId = `password-${reactId}`;
  const errorId = `${inputId}-error`;
  const hintId = `${inputId}-hint`;
  const hasError = Boolean(error);
  const showHint = Boolean(hint) && !hasError;

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={inputId} className="text-sm font-medium text-slate-700 dark:text-slate-300">
        {label}
      </label>

      <div className="relative">
        <input
          id={inputId}
          type={revealed ? 'text' : 'password'}
          aria-invalid={hasError || undefined}
          aria-describedby={hasError ? errorId : showHint ? hintId : undefined}
          className={cn(inputBaseClasses, inputStateClasses(hasError), 'pr-14')}
          {...inputProps}
        />
        <button
          type="button"
          onClick={() => setRevealed((value) => !value)}
          aria-pressed={revealed}
          aria-controls={inputId}
          // 44x44 touch target, inset so it never overlaps the focus ring.
          className={cn(
            'absolute inset-y-0 right-0 flex min-h-11 min-w-11 items-center justify-center rounded-r-xl px-3',
            'text-sm font-medium text-slate-600 hover:text-slate-900',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
            'dark:text-slate-400 dark:hover:text-slate-100',
          )}
        >
          <span className="sr-only">{revealed ? 'Hide password' : 'Show password'}</span>
          {revealed ? <EyeOffIcon /> : <EyeIcon />}
        </button>
      </div>

      {showHint ? (
        <p id={hintId} className="text-sm text-slate-500 dark:text-slate-400">
          {hint}
        </p>
      ) : null}
      <FormError id={errorId} message={error} className={showHint ? 'hidden' : undefined} />

      {footer}
    </div>
  );
}

function EyeIcon() {
  return (
    <svg className="size-5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg className="size-5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 4l16 16M9.9 5.9A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.9 3.7M6.4 8.3A17 17 0 0 0 2.5 12S6 18.5 12 18.5c.9 0 1.7-.1 2.5-.4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}
