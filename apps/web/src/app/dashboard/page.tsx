'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import {
  formatInr,
  type BookingSummary,
  type CurrentBookingResponse,
  type ExtensionAvailability,
  type DeviceSummary,
  type MyDeviceResponse,
} from '@safelock/shared';
import { useAuth } from '@/context/AuthContext';
import { Protected } from '@/components/RouteGuard';
import { BookingCard } from '@/components/BookingCard';
import { Button } from '@/components/ui/Button';
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
 * The dashboard, under the rental model.
 *
 * There are three shapes it takes, and which one is decided by the **booking**,
 * not by any flag on the user:
 *
 * 1. **No live booking** — an invitation to book one.
 * 2. **A booking awaiting payment** — the booking card carries pay-or-cancel.
 *    No safe controls: a held safe is not yet one you can operate, and the API
 *    would refuse.
 * 3. **A paid booking** — the booking card plus the safe's controls.
 *
 * The old four-state purchase dashboard (`hasPaid` × `deviceAllocated`,
 * including the refunded-but-holding case) is gone with those flags. A refund
 * no longer withdraws access, because what grants access is a booking you paid
 * for — see docs/decisions.md.
 */
function DashboardContent() {
  const { user, logout } = useAuth();
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  const [booking, setBooking] = useState<BookingSummary | null>(null);
  const [extension, setExtension] = useState<ExtensionAvailability | null>(null);
  const [device, setDevice] = useState<DeviceSummary | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [message, setMessage] = useState<string | null>(null);

  /**
   * Loads the booking and, when there is a paid one, the safe.
   *
   * Two requests rather than one because they are genuinely different reads —
   * the booking says what the user is entitled to, the device says what state
   * the hardware is in — and the second is pointless without the first.
   */
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const current = await api.get<CurrentBookingResponse>('/bookings/current', {
        ...(signal ? { signal } : {}),
      });

      setBooking(current.booking);
      setExtension(current.extension);

      const paid =
        current.booking !== null &&
        (current.booking.effectiveStatus === 'ACTIVE' ||
          current.booking.effectiveStatus === 'OVERSTAY');

      if (paid) {
        const mine = await api.get<MyDeviceResponse>('/devices/mine', {
          ...(signal ? { signal } : {}),
        });
        setDevice(mine.device);
      } else {
        setDevice(null);
      }

      setState('ready');
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setMessage(toUserMessage(error));
      setState('error');
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function handleLogout() {
    setSigningOut(true);
    await logout();
    router.replace('/login');
  }

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
      */}
      <VerifyPhonePrompt />

      {state === 'loading' ? (
        <section
          className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900"
          role="status"
          aria-live="polite"
        >
          <p className="text-sm text-slate-600 dark:text-slate-400">Loading your booking…</p>
        </section>
      ) : state === 'error' ? (
        <section
          role="alert"
          className="rounded-2xl border border-red-300 bg-red-50 p-5 dark:border-red-900 dark:bg-red-950/40"
        >
          <h2 className="text-base font-bold text-red-900 dark:text-red-100">
            Could not load your booking
          </h2>
          <p className="mt-1 text-sm text-red-900/90 dark:text-red-200/90">{message}</p>
          <div className="mt-4">
            <Button
              variant="secondary"
              onClick={() => {
                setState('loading');
                void load();
              }}
            >
              Try again
            </Button>
          </div>
        </section>
      ) : booking ? (
        <>
          <BookingCard
            booking={booking}
            extension={extension}
            onChanged={() => {
              setState('loading');
              void load();
            }}
          />

          {/*
            The safe's own controls, only once the booking is paid. The fee is
            passed down so Unlock can be disabled with a reason rather than
            offering a button the API will refuse with a 402.
          */}
          {device ? (
            <SafeCard device={device} overstayFeePaise={booking.overstayFeePaise} />
          ) : null}
        </>
      ) : (
        <NoBooking />
      )}

      {/* Reachable for every signed-in user, not only those holding a safe:
          history is their own record and stays readable between bookings. */}
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

/** No live booking: the one thing to do is start one. */
function NoBooking() {
  const [hourlyRatePaise, setHourlyRatePaise] = useState<number | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        const response = await api.get<CurrentBookingResponse>('/bookings/current', {
          signal: controller.signal,
        });
        /**
         * The **cheapest** size, which is what makes the word "From" below
         * true. Reading `quote.rates.hourlyRatePaise` would show the medium
         * rate and call it a floor, which it is not.
         */
        setHourlyRatePaise(
          Math.min(...response.quote.sizes.map((offer) => offer.hourlyRatePaise)),
        );
      } catch {
        // The price is a nicety here; the button works regardless, and /book
        // loads the quote properly with its own error state.
      }
    })();

    return () => controller.abort();
  }, []);

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
      <h2 className="text-base font-bold text-slate-900 dark:text-white">
        You don’t have a safe booked
      </h2>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
        Book one by the hour and lock or unlock it from your phone.
        {hourlyRatePaise !== null ? ` From ${formatInr(hourlyRatePaise)} an hour.` : ''}
      </p>

      <Link
        href="/book"
        className="mt-4 inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-brand-600 px-5 text-base font-semibold text-white transition-colors hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
      >
        Book a safe
      </Link>
    </section>
  );
}
