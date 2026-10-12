'use client';

import { useId, type ComponentPropsWithRef, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { FormError } from './FormError';

export interface InputProps
  // `prefix` is overridden: the DOM attribute of that name is a string, ours is a node.
  extends Omit<ComponentPropsWithRef<'input'>, 'id' | 'className' | 'prefix'> {
  label: string;
  /** Validation message. Its presence switches the field into the error state. */
  error?: string;
  /** Helper text shown under the field when there is no error. */
  hint?: string;
  /** Static prefix inside the field, e.g. "+91" for phone numbers. */
  prefix?: ReactNode;
  /** Extra classes for the wrapper, not the input. */
  className?: string;
  inputClassName?: string;
}

/** Shared input shell so Input and PasswordInput look identical. */
export const inputBaseClasses =
  'min-h-12 w-full rounded-xl border bg-white px-4 text-base text-slate-900 ' +
  'placeholder:text-slate-400 transition-colors ' +
  'focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 ' +
  'disabled:cursor-not-allowed disabled:bg-slate-100 ' +
  'dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-500 dark:disabled:bg-slate-800';

export function inputStateClasses(hasError: boolean): string {
  return hasError
    ? 'border-red-400 focus-visible:outline-red-500 dark:border-red-700'
    : 'border-slate-300 focus-visible:outline-brand-500 dark:border-slate-700';
}

export function Input({
  label,
  error,
  hint,
  prefix,
  className,
  inputClassName,
  ...inputProps
}: InputProps) {
  const reactId = useId();
  const inputId = `input-${reactId}`;
  const errorId = `${inputId}-error`;
  const hintId = `${inputId}-hint`;
  const hasError = Boolean(error);
  const showHint = Boolean(hint) && !hasError;

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label
        htmlFor={inputId}
        className="text-sm font-medium text-slate-700 dark:text-slate-300"
      >
        {label}
      </label>

      <div className="relative">
        {prefix ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-4 text-base text-slate-500 dark:text-slate-400"
          >
            {prefix}
          </span>
        ) : null}
        <input
          id={inputId}
          aria-invalid={hasError || undefined}
          aria-describedby={
            hasError ? errorId : showHint ? hintId : undefined
          }
          className={cn(
            inputBaseClasses,
            inputStateClasses(hasError),
            prefix ? 'pl-14' : null,
            inputClassName,
          )}
          {...inputProps}
        />
      </div>

      {showHint ? (
        <p id={hintId} className="text-sm text-slate-500 dark:text-slate-400">
          {hint}
        </p>
      ) : null}
      {/* Always mounted so screen readers announce errors that appear on submit. */}
      <FormError id={errorId} message={error} className={showHint ? 'hidden' : undefined} />
    </div>
  );
}
