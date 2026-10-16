'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { MyDeviceResponse, DeviceSummary } from '@safelock/shared';
import { useAuth } from '@/context/AuthContext';
import { Protected } from '@/components/RouteGuard';
import { Button } from '@/components/ui/Button';
import { PaymentRequiredBanner } from '@/components/PaymentRequiredBanner';
import { AllocationTimeline } from '@/components/AllocationTimeline';
import { SafeCard } from '@/components/SafeCard';
import { VerifyPhonePrompt } from '@/components/PhoneVerificationCard';
import { api } from '@/lib/api';
import { toUserMessage } from '@/lib/apiError';

export default function DashboardPage() {
  return (
    <Protected>
      <DashboardContent />
    </Protected>
  );
}

/**
 * The four states a signed-in user can be in, in the order they are checked:
 *
 * 1. **refunded, still holding** — `!hasPaid && deviceAllocated`. A real state
 *    after a refund, and checked first so it can never fall through to a blank
 *    screen. No safe card and no controls.
 * 2. **not paid** — the payment banner.
 * 3. **paid, no device** — waiting for an admin to allocate.
 * 4. **paid, device allocated** — the safe card.
 */
function DashboardContent() {
  const { user, logout } = useAuth();
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  async function handleLogout() {
    setSigningOut(true);
    await logout();
    router.replace('/login');
  }

  const refundedWithDevice = user !== null && !user.hasPaid && user.deviceAllocated;

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8 sm:px-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl dark:text-white">
          Welcome, {user?.name}
        </h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{user?.email}</p>
      </header>

      {/*
        Shown to every unverified user, not only when an unlock is refused.
        Discovering the requirement at the moment you need to open your safe is
        discovering it too late — and the same gap makes password reset
        unreachable, since reset is delivered to a verified number.

        Placed after the refunded check below in importance but before the
        safe card: a refunded user has nothing to unlock, so the prompt is
        suppressed for them by returning early from that branch.
      */}
      {!refundedWithDevice && user?.hasPaid ? <VerifyPhonePrompt /> : null}

      {refundedWithDevice ? (
        <RefundedNotice />
      ) : !user?.hasPaid ? (
        <PaymentRequiredBanner />
      ) : (
        <PaidUserSafe />
      )}

      {/* Reachable for every signed-in user, not only those holding a safe:
          history is their own record and stays readable after a refund. */}
      <Link
        href="/history"
        className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-5 text-base font-semibold text-slate-900 transition-colors hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800"
      >
        View activity history
      </Link>

      <Button
        variant="secondary"
        loading={signingOut}
        loadingText="Signing out…"
        onClick={handleLogout}
      >
        Sign out
      </Button>
    </main>
  );
}

/**
 * Payment refunded while the hardware is still out.
 *
 * Shows no safe card and no controls: the user is not entitled to operate the
 * safe in this state, and the API enforces that independently —
 * `/devices/mine` is behind `requirePaid`, so it would refuse anyway.
 */
function RefundedNotice() {
  return (
    <section
      role="status"
      className="rounded-2xl border border-amber-300 bg-amber-50 p-5 dark:border-amber-800 dark:bg-amber-950/40"
    >
      <h2 className="text-base font-bold text-amber-900 dark:text-amber-100">
        Your payment was refunded
      </h2>
      <p className="mt-1 text-sm text-amber-900/90 dark:text-amber-200/90">
        Please contact support about returning your safe. Remote access has been disabled.
      </p>
      <Link
        href="/contact"
        className="mt-4 inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-amber-600 px-5 text-base font-semibold text-white transition-colors hover:bg-amber-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500 dark:bg-amber-500 dark:text-amber-950 dark:hover:bg-amber-400"
      >
        Contact support
      </Link>
    </section>
  );
}

/** Loads the user's device and shows either the timeline or the safe card. */
function PaidUserSafe() {
  const [device, setDevice] = useState<DeviceSummary | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        const response = await api.get<MyDeviceResponse>('/devices/mine', {
          signal: controller.signal,
        });
        setDevice(response.device);
        setState('ready');
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setMessage(toUserMessage(error));
        setState('error');
      }
    })();

    return () => controller.abort();
  }, []);

  if (state === 'loading') {
    return (
      <section
        className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900"
        role="status"
        aria-live="polite"
      >
        <p className="text-sm text-slate-600 dark:text-slate-400">Loading your safe…</p>
      </section>
    );
  }

  if (state === 'error') {
    return (
      <section
        role="alert"
        className="rounded-2xl border border-red-300 bg-red-50 p-5 dark:border-red-900 dark:bg-red-950/40"
      >
        <h2 className="text-base font-bold text-red-900 dark:text-red-100">
          Could not load your safe
        </h2>
        <p className="mt-1 text-sm text-red-900/90 dark:text-red-200/90">{message}</p>
      </section>
    );
  }

  return device ? <SafeCard device={device} /> : <AllocationTimeline />;
}
