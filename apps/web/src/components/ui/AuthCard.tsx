import type { ReactNode } from 'react';

export interface AuthCardProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
  /** Links below the card, e.g. "Don't have an account?". */
  footer?: ReactNode;
}

/** Centred, mobile-first shell for the auth pages. */
export function AuthCard({ title, subtitle, children, footer }: AuthCardProps) {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 py-8 sm:px-6">
      <div className="mb-6 flex flex-col items-center text-center">
        <SafeMark />
        <h1 className="mt-4 text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl dark:text-white">
          {title}
        </h1>
        {subtitle ? (
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">{subtitle}</p>
        ) : null}
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6 dark:border-slate-800 dark:bg-slate-900">
        {children}
      </div>

      {footer ? (
        <div className="mt-6 text-center text-sm text-slate-600 dark:text-slate-400">{footer}</div>
      ) : null}
    </main>
  );
}

function SafeMark() {
  return (
    <div
      aria-hidden="true"
      className="flex size-12 items-center justify-center rounded-2xl bg-brand-600 text-white shadow-sm dark:bg-brand-500"
    >
      <svg className="size-6" viewBox="0 0 24 24" fill="none">
        <rect
          x="3"
          y="4"
          width="18"
          height="16"
          rx="3"
          stroke="currentColor"
          strokeWidth="1.8"
        />
        <circle cx="11" cy="12" r="3.2" stroke="currentColor" strokeWidth="1.8" />
        <path d="M11 12h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    </div>
  );
}
