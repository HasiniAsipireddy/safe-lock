import Link from 'next/link';

/**
 * Shown after payment, while the user waits for an admin to allocate a safe.
 *
 * Deliberately promises **no timeframe**. Allocation is a manual step today,
 * and inventing an ETA would create an expectation nobody has agreed to. See
 * docs/decisions.md.
 */

type StepState = 'done' | 'current' | 'upcoming';

const STEPS: Array<{ label: string; detail: string; state: StepState }> = [
  {
    label: 'Payment received',
    detail: 'Verified on our server.',
    state: 'done',
  },
  {
    label: 'Safe being prepared',
    detail: 'We are assigning a safe lock to your account.',
    state: 'current',
  },
  {
    label: 'Safe ready',
    detail: 'Your safe appears here, with its status.',
    state: 'upcoming',
  },
];

export function AllocationTimeline() {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
      <h2 className="text-base font-bold text-slate-900 dark:text-white">
        Payment received. Your safe is being prepared.
      </h2>

      <ol className="mt-4 flex flex-col gap-4">
        {STEPS.map((step, index) => (
          <li key={step.label} className="flex gap-3">
            <div className="flex flex-col items-center">
              <StepMarker state={step.state} />
              {index < STEPS.length - 1 && (
                <span
                  aria-hidden="true"
                  className="mt-1 w-px flex-1 bg-slate-200 dark:bg-slate-700"
                />
              )}
            </div>

            <div className="pb-1">
              <p
                className={
                  step.state === 'upcoming'
                    ? 'text-sm font-semibold text-slate-400 dark:text-slate-500'
                    : 'text-sm font-semibold text-slate-900 dark:text-slate-100'
                }
              >
                {step.label}
                {step.state === 'current' && (
                  <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                    In progress
                  </span>
                )}
              </p>
              <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-400">{step.detail}</p>
            </div>
          </li>
        ))}
      </ol>

      <p className="mt-4 text-xs text-slate-500 dark:text-slate-400">
        Nothing more is needed from you. If you have a question, please{' '}
        <Link href="/contact" className="font-semibold underline underline-offset-2">
          contact us
        </Link>
        .
      </p>
    </section>
  );
}

function StepMarker({ state }: { state: StepState }) {
  if (state === 'done') {
    return (
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-950">
        <svg
          className="size-3.5 text-emerald-600 dark:text-emerald-400"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={3}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m5 13 4 4L19 7" />
        </svg>
      </span>
    );
  }

  if (state === 'current') {
    return (
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-950">
        <span className="size-2 animate-pulse rounded-full bg-amber-500" aria-hidden="true" />
      </span>
    );
  }

  return (
    <span
      className="flex size-6 shrink-0 items-center justify-center rounded-full border-2 border-slate-200 dark:border-slate-700"
      aria-hidden="true"
    />
  );
}
