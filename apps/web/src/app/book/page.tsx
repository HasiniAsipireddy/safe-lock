'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ERROR_CODES,
  formatInr,
  overstayHourlyPaise,
  overstayMaxFeePaise,
  type BookingQuote,
  type CreateBookingResponse,
  type CurrentBookingResponse,
} from '@safelock/shared';
import { Protected } from '@/components/RouteGuard';
import { Button } from '@/components/ui/Button';
import { api } from '@/lib/api';
import { ApiError, toUserMessage } from '@/lib/apiError';

export default function BookPage() {
  return (
    <Protected>
      <BookContent />
    </Protected>
  );
}

/**
 * Choosing how long to rent a safe for.
 *
 * Two rules shape this page:
 *
 * 1. **The client does no money arithmetic.** Every price shown comes from the
 *    server's quote, which prices each allowed duration. Multiplying a rate in
 *    the browser would be a second implementation of the pricing rules, and
 *    the one that disagrees with the invoice.
 * 2. **The overstay rule is stated before anyone pays**, with the real
 *    numbers — the per-hour charge, the grace period, and the cap. A fee
 *    somebody first learns about when they are charged it is a fee they are
 *    entitled to be angry about.
 */
function BookContent() {
  const router = useRouter();

  const [quote, setQuote] = useState<BookingQuote | null>(null);
  const [hours, setHours] = useState(2);
  const [loading, setLoading] = useState(true);
  const [booking, setBooking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        const response = await api.get<CurrentBookingResponse>('/bookings/current', {
          signal: controller.signal,
        });

        // Already holding one. There is nothing to choose here.
        if (response.booking) {
          router.replace('/dashboard');
          return;
        }

        setQuote(response.quote);
        setHours(Math.min(Math.max(2, response.quote.minHours), response.quote.maxHours));
        setLoading(false);
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        setError(toUserMessage(cause));
        setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [router]);

  const selected = useMemo(
    () => quote?.options.find((option) => option.hours === hours) ?? null,
    [quote, hours],
  );

  async function handleBook() {
    setBooking(true);
    setError(null);

    try {
      const response = await api.post<CreateBookingResponse>('/bookings', { hours });
      // The dashboard carries the pay-or-cancel step: the booking now holds a
      // safe, and that is the thing the user needs to see.
      router.replace(`/dashboard?booked=${response.booking.id}`);
    } catch (cause) {
      setBooking(false);

      if (cause instanceof ApiError && cause.code === ERROR_CODES.BOOKING_ALREADY_EXISTS) {
        router.replace('/dashboard');
        return;
      }

      setError(toUserMessage(cause));
    }
  }

  if (loading) {
    return (
      <main
        className="mx-auto flex w-full max-w-md flex-1 items-center justify-center px-4 py-8"
        role="status"
        aria-live="polite"
      >
        <p className="text-sm text-slate-600 dark:text-slate-400">Loading prices…</p>
      </main>
    );
  }

  if (!quote) {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 py-8">
        <div
          role="alert"
          className="rounded-2xl border border-red-300 bg-red-50 p-5 dark:border-red-900 dark:bg-red-950/40"
        >
          <h1 className="text-base font-bold text-red-900 dark:text-red-100">
            Could not load prices
          </h1>
          <p className="mt-1 text-sm text-red-900/90 dark:text-red-200/90">{error}</p>
        </div>
        <Link
          href="/dashboard"
          className="inline-flex min-h-12 items-center justify-center rounded-xl border border-slate-300 bg-white px-5 text-base font-semibold text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
        >
          Back to dashboard
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8 sm:px-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl dark:text-white">
          Book a safe
        </h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          {formatInr(quote.rates.hourlyRatePaise)} per hour. Pay for the hours you need.
        </p>
      </header>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
        <label
          htmlFor="hours"
          className="block text-sm font-semibold text-slate-900 dark:text-white"
        >
          How long do you need it?
        </label>

        <select
          id="hours"
          value={hours}
          onChange={(event) => setHours(Number(event.target.value))}
          className="mt-2 min-h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-base text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
        >
          {quote.options.map((option) => (
            <option key={option.hours} value={option.hours}>
              {option.hours} hour{option.hours === 1 ? '' : 's'} — {formatInr(option.pricePaise)}
            </option>
          ))}
        </select>

        <p
          className="mt-4 text-2xl font-bold text-slate-900 dark:text-white"
          aria-live="polite"
        >
          {selected ? formatInr(selected.pricePaise) : '—'}
        </p>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          for {hours} hour{hours === 1 ? '' : 's'}
        </p>

        {/*
          Said before payment, deliberately and with the real figures. The
          overstay charge is the one surprise this product could spring on
          someone, so it is spelled out while they still have the choice.
        */}
        <div className="mt-5 rounded-xl bg-slate-50 p-4 dark:bg-slate-800/50">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
            If you run over
          </h2>
          <ul className="mt-2 space-y-1.5 text-sm text-slate-700 dark:text-slate-300">
            <li>
              You get a <strong>{quote.rates.graceMinutes}-minute grace period</strong> at no
              charge.
            </li>
            <li>
              After that it is{' '}
              <strong>{formatInr(overstayHourlyPaise(quote.rates))} per hour started</strong>,
              capped at {quote.rates.capHours} hours (
              {formatInr(overstayMaxFeePaise(quote.rates))} at most).
            </li>
            <li>
              The safe <strong>will not open</strong> until the fee is paid, and locking it still
              works.
            </li>
            <li>
              Once paid, you have {quote.rates.collectionWindowMinutes} minutes to collect your
              belongings.
            </li>
          </ul>
        </div>

        <p className="mt-4 text-sm text-slate-600 dark:text-slate-400">
          We hold a safe for you while you pay, and your {hours}-hour rental only starts once
          the payment goes through.
        </p>

        <div className="mt-5">
          <Button onClick={() => void handleBook()} loading={booking} loadingText="Holding a safe…">
            Continue to payment
          </Button>
        </div>

        <p
          role="alert"
          aria-live="assertive"
          className="mt-2 min-h-5 text-sm font-medium text-red-700 dark:text-red-300"
        >
          {error}
        </p>
      </section>

      <Link
        href="/dashboard"
        className="inline-flex min-h-12 items-center justify-center rounded-xl border border-slate-300 bg-white px-5 text-base font-semibold text-slate-900 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800"
      >
        Back to dashboard
      </Link>
    </main>
  );
}
