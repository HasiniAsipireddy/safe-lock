import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * Shared shell for the static legal pages (/terms, /privacy, /refund-policy,
 * /contact).
 *
 * These pages are Server Components — no client JS, no auth, so Razorpay's
 * activation reviewers can reach them without an account.
 */

export const LEGAL_PLACEHOLDERS = {
  business: '[BUSINESS NAME]',
  address: '[ADDRESS]',
  email: '[EMAIL]',
  phone: '[PHONE]',
} as const;

/** The review warning that sits at the top of every legal page. */
export function LawyerReviewNotice() {
  return (
    <aside
      role="note"
      className="rounded-xl border-2 border-dashed border-amber-400 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-200"
    >
      <p className="font-bold">Draft — not legal advice</p>
      <p className="mt-1">
        This page is placeholder text written to satisfy a payment-gateway activation review. It has
        not been drafted or checked by a lawyer. Every{' '}
        <code className="rounded bg-amber-200/60 px-1 font-mono text-xs dark:bg-amber-900/60">
          [BRACKETED]
        </code>{' '}
        value must be filled in, and the whole document must be reviewed by a qualified lawyer
        before this site goes live.
      </p>
    </aside>
  );
}

export function LegalPage({
  title,
  lastUpdated,
  children,
}: {
  title: string;
  lastUpdated: string;
  children: ReactNode;
}) {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6">
      <nav>
        <Link
          href="/"
          className="text-sm font-semibold text-brand-700 underline underline-offset-2 dark:text-brand-300"
        >
          ← Safe Lock
        </Link>
      </nav>

      <header>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl dark:text-white">
          {title}
        </h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Last updated: {lastUpdated}
        </p>
      </header>

      <LawyerReviewNotice />

      <div className="flex flex-col gap-6 text-sm leading-relaxed text-slate-700 dark:text-slate-300">
        {children}
      </div>
    </main>
  );
}

export function Section({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-base font-bold text-slate-900 dark:text-white">{heading}</h2>
      {children}
    </section>
  );
}

/** Bulleted list with consistent spacing. */
export function List({ items }: { items: ReactNode[] }) {
  return (
    <ul className="flex list-disc flex-col gap-1.5 pl-5">
      {items.map((item, index) => (
        <li key={index}>{item}</li>
      ))}
    </ul>
  );
}
