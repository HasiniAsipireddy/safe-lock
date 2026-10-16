'use client';

import Link from 'next/link';
import { Protected } from '@/components/RouteGuard';
import { ActivityList } from '@/components/ActivityList';

/**
 * `/history` — every lock and unlock on the signed-in user's safe.
 *
 * Open to any signed-in user, including one still waiting for a safe and one
 * whose payment was refunded. It is their own record: the API applies no
 * payment or allocation gate here and answers with an empty list rather than
 * an error. See docs/decisions.md.
 */
export default function HistoryPage() {
  return (
    <Protected>
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 py-8 sm:px-6">
        <header>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl dark:text-white">
            Activity
          </h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Every lock and unlock on your safe, newest first.
          </p>
        </header>

        <ActivityList />

        <Link
          href="/dashboard"
          className="inline-flex min-h-12 items-center justify-center rounded-xl px-5 text-base font-semibold text-brand-700 transition-colors hover:bg-brand-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 dark:text-brand-300 dark:hover:bg-slate-800"
        >
          Back to dashboard
        </Link>
      </main>
    </Protected>
  );
}
