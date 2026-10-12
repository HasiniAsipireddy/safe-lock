'use client';

import Link from 'next/link';
import { useAuth } from '@/context/AuthContext';
import { Protected } from '@/components/RouteGuard';

/** Placeholder. Razorpay Checkout is a separate task. */
export default function PayPage() {
  return (
    <Protected>
      <PayContent />
    </Protected>
  );
}

function PayContent() {
  const { user } = useAuth();

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8 sm:px-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl dark:text-white">
          Activate your safe
        </h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Account created for {user?.name}. One payment unlocks device allocation.
        </p>
      </header>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
        <h2 className="text-sm font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
          Payment
        </h2>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
          Razorpay Checkout is not wired up yet. Pricing and the plan structure are still open
          questions in CLAUDE.md.
        </p>
      </section>

      <Link
        href="/dashboard"
        className="inline-flex min-h-12 items-center justify-center rounded-xl border border-slate-300 px-5 text-base font-semibold text-slate-900 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-100 dark:hover:bg-slate-800"
      >
        Skip to dashboard
      </Link>
    </main>
  );
}
