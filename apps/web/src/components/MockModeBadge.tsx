'use client';

import { useState } from 'react';
import { USE_MOCK_API } from '@/lib/env';
import { MOCK_DEMO_CREDENTIALS } from '@/lib/mockApi';

/**
 * Always-visible reminder that the auth API is faked, plus the seeded demo
 * credentials. Renders nothing when NEXT_PUBLIC_USE_MOCK_API is off (and mock
 * mode cannot be on in production — see lib/env.ts).
 */
export function MockModeBadge() {
  const [expanded, setExpanded] = useState(false);

  if (!USE_MOCK_API) return null;

  return (
    <div className="sticky top-0 z-50 border-b border-amber-300 bg-amber-100 text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
      <div className="mx-auto flex max-w-md flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-xs sm:px-6">
        <span className="inline-flex items-center gap-1.5 font-semibold tracking-wide uppercase">
          <span
            aria-hidden="true"
            className="size-2 rounded-full bg-amber-500 dark:bg-amber-400"
          />
          Mock mode
        </span>
        <span className="text-amber-900/80 dark:text-amber-200/80">
          No real backend — responses are faked.
        </span>
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          className="ml-auto min-h-8 rounded-lg px-2 font-semibold underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600"
        >
          {expanded ? 'Hide' : 'Demo login'}
        </button>
        {expanded ? (
          <p className="w-full font-mono text-[11px] break-all">
            {MOCK_DEMO_CREDENTIALS.email} / {MOCK_DEMO_CREDENTIALS.password}
          </p>
        ) : null}
      </div>
    </div>
  );
}
