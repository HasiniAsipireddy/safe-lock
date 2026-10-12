'use client';

import { cn } from '@/lib/cn';

export interface FormErrorProps {
  id?: string;
  message?: string;
  /** `field` sits under an input; `banner` sits above the form. */
  variant?: 'field' | 'banner';
  className?: string;
}

/**
 * Renders a validation or server error.
 *
 * Always mounted as a live region so screen readers announce errors that appear
 * after submit; renders nothing visible when there is no message.
 */
export function FormError({ id, message, variant = 'field', className }: FormErrorProps) {
  if (variant === 'banner') {
    return (
      <div role="alert" aria-live="polite" className={className}>
        {message ? (
          <p
            id={id}
            className={cn(
              'flex items-start gap-2 rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm font-medium text-red-800',
              'dark:border-red-900 dark:bg-red-950/60 dark:text-red-200',
            )}
          >
            <svg
              className="mt-0.5 size-4 shrink-0"
              viewBox="0 0 20 20"
              fill="currentColor"
              aria-hidden="true"
            >
              <path
                fillRule="evenodd"
                d="M10 18a8 8 0 100-16 8 8 0 000 16zM9 9a1 1 0 112 0v4a1 1 0 11-2 0V9zm1-4a1 1 0 100 2 1 1 0 000-2z"
                clipRule="evenodd"
              />
            </svg>
            <span>{message}</span>
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <p
      id={id}
      role="alert"
      aria-live="polite"
      className={cn('min-h-5 text-sm text-red-700 dark:text-red-400', className)}
    >
      {message ?? ''}
    </p>
  );
}
