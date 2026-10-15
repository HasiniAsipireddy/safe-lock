'use client';

import Link from 'next/link';

/**
 * Shown on /dashboard while the signed-in user has no verified payment.
 *
 * This is a prompt, not a gate. Device features are refused by the API's
 * `requirePaid` middleware — hiding a button has never stopped anybody.
 */
export function PaymentRequiredBanner() {
  return (
    <section
      role="status"
      className="rounded-2xl border border-amber-300 bg-amber-50 p-5 dark:border-amber-800 dark:bg-amber-950/40"
    >
      <h2 className="text-base font-bold text-amber-900 dark:text-amber-100">
        Complete payment to activate your safe
      </h2>
      <p className="mt-1 text-sm text-amber-900/90 dark:text-amber-200/90">
        A safe lock is allocated to your account once your one-time payment is verified.
      </p>
      <Link
        href="/pay"
        className="mt-4 inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-amber-600 px-5 text-base font-semibold text-white transition-colors hover:bg-amber-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500 dark:bg-amber-500 dark:text-amber-950 dark:hover:bg-amber-400"
      >
        Complete payment
      </Link>
    </section>
  );
}
