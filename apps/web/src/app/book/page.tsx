'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ERROR_CODES,
  SAFE_SIZE_COPY,
  formatInr,
  overstayMaxFeePaise,
  type BookingQuote,
  type CreateBookingResponse,
  type CurrentBookingResponse,
  type SafeSize,
  type SafeSizeOffer,
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
 * Choosing a safe: **size first, then how long for.**
 *
 * That order is the product's, not an implementation detail. Size is the
 * question a renter can answer by looking at what they are holding, and it is
 * what determines the price — so asking for hours first would mean showing a
 * price that changes the moment they pick a size, which reads as a bait and
 * switch even when it is not.
 *
 * Three rules shape this page:
 *
 * 1. **The client does no money arithmetic.** Every figure comes from the
 *    server's quote, which prices each (size, duration) pair it would accept.
 *    Multiplying a rate in the browser would be a second implementation of the
 *    pricing rules — the one that disagrees with the invoice.
 * 2. **A size with no free safe is disabled before it is chosen**, with the
 *    reason on the card. The API refuses it anyway (409 `SIZE_NOT_AVAILABLE`),
 *    but discovering that *after* picking a duration wastes the user's time on
 *    a path that was never going to work.
 * 3. **The overstay rule is stated before anyone pays**, with the real numbers
 *    for the chosen size — the per-hour charge, the grace period and the cap. A
 *    fee somebody first learns about when they are charged it is a fee they are
 *    entitled to be angry about.
 */
function BookContent() {
  const router = useRouter();

  const [quote, setQuote] = useState<BookingQuote | null>(null);
  const [size, setSize] = useState<SafeSize | null>(null);
  const [hours, setHours] = useState(2);
  const [loading, setLoading] = useState(true);
  const [booking, setBooking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Sizes the server told us were free when it refused our booking.
   *
   * Comes from `SIZE_NOT_AVAILABLE`'s `fields.size`, and it is more current
   * than the quote we loaded: somebody took the last medium while this page was
   * open. Applied over the quote's own flags so the cards stop offering what
   * has just been refused.
   */
  const [refusedSizes, setRefusedSizes] = useState<Set<SafeSize>>(new Set());

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
        setHours(
          Math.min(Math.max(2, response.quote.minHours), response.quote.maxHours),
        );
        // Preselect the first size that can actually be booked, so the common
        // case is one tap on a duration. Nothing is preselected if none are.
        setSize(response.quote.sizes.find((offer) => offer.available)?.size ?? null);
        setLoading(false);
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        setError(toUserMessage(cause));
        setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [router]);

  /** Whether a size can be booked, taking the server's latest refusal into account. */
  function isBookable(offer: SafeSizeOffer): boolean {
    if (refusedSizes.size > 0) return refusedSizes.has(offer.size);
    return offer.available;
  }

  const chosen = useMemo(
    () => quote?.sizes.find((offer) => offer.size === size) ?? null,
    [quote, size],
  );

  const selected = useMemo(
    () => chosen?.options.find((option) => option.hours === hours) ?? null,
    [chosen, hours],
  );

  async function handleBook() {
    if (!size) return;

    setBooking(true);
    setError(null);

    try {
      const response = await api.post<CreateBookingResponse>('/bookings', { hours, size });
      // The dashboard carries the pay-or-cancel step: the booking now holds a
      // safe, and that is the thing the user needs to see.
      router.replace(`/dashboard?booked=${response.booking.id}`);
    } catch (cause) {
      setBooking(false);

      if (cause instanceof ApiError && cause.code === ERROR_CODES.BOOKING_ALREADY_EXISTS) {
        router.replace('/dashboard');
        return;
      }

      /**
       * The size went while the page was open.
       *
       * The server names what *is* free, so the cards are corrected and the
       * user's choice is cleared rather than left pointing at something that
       * has just been refused — re-submitting the same thing would fail the
       * same way.
       */
      if (cause instanceof ApiError && cause.code === ERROR_CODES.SIZE_NOT_AVAILABLE) {
        const offered = (cause.fields?.size ?? '')
          .split(',')
          .filter((value): value is SafeSize =>
            value === 'SMALL' || value === 'MEDIUM' || value === 'LARGE',
          );

        setRefusedSizes(new Set(offered));
        setSize(offered[0] ?? null);
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

  const anyBookable = quote.sizes.some(isBookable);

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8 sm:px-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl dark:text-white">
          Book a safe
        </h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Pick a size, then how long you need it. You only pay for the hours you book.
        </p>
      </header>

      {/* Step 1: the size. A radio group, not a <select>: three options with a
          price and a description each are worth seeing side by side, and a
          native select cannot show any of that until it is opened. */}
      <section className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
        <fieldset>
          <legend className="text-sm font-semibold text-slate-900 dark:text-white">
            1. What size do you need?
          </legend>

          <div className="mt-3 flex flex-col gap-2">
            {quote.sizes.map((offer) => {
              const bookable = isBookable(offer);
              const copy = SAFE_SIZE_COPY[offer.size];
              const active = size === offer.size;

              return (
                <label
                  key={offer.size}
                  className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors ${
                    active
                      ? 'border-brand-500 bg-brand-50 dark:bg-brand-950/40'
                      : 'border-slate-300 dark:border-slate-700'
                  } ${bookable ? 'hover:bg-slate-50 dark:hover:bg-slate-800' : 'cursor-not-allowed opacity-60'}`}
                >
                  <input
                    type="radio"
                    name="size"
                    value={offer.size}
                    checked={active}
                    disabled={!bookable}
                    onChange={() => setSize(offer.size)}
                    className="mt-1 size-5 shrink-0 accent-brand-600"
                  />
                  <span className="flex-1">
                    <span className="flex flex-wrap items-baseline justify-between gap-x-2">
                      <span className="text-base font-bold text-slate-900 dark:text-white">
                        {copy.label}
                      </span>
                      <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                        {formatInr(offer.hourlyRatePaise)}/hour
                      </span>
                    </span>
                    <span className="mt-0.5 block text-sm text-slate-600 dark:text-slate-400">
                      {copy.fits}
                    </span>
                    {/* Icon-free, text-only: the disabled state is already
                        conveyed by the control, and colour alone must never be
                        the carrier of a fact. */}
                    {!bookable && (
                      <span className="mt-1 block text-sm font-medium text-amber-800 dark:text-amber-200">
                        None free right now
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        {!anyBookable && (
          <p
            role="alert"
            className="mt-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
          >
            Every safe is booked at the moment. Please check back shortly.
          </p>
        )}
      </section>

      {/* Step 2: the duration, priced at the chosen size. Hidden until a size
          is picked, because a duration with no size has no price — and showing
          one that then changes is the bait-and-switch this ordering avoids. */}
      {chosen && (
        <section className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
          <label
            htmlFor="hours"
            className="block text-sm font-semibold text-slate-900 dark:text-white"
          >
            2. How long do you need it?
          </label>

          <select
            id="hours"
            value={hours}
            onChange={(event) => setHours(Number(event.target.value))}
            className="mt-2 min-h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-base text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          >
            {chosen.options.map((option) => (
              <option key={option.hours} value={option.hours}>
                {option.hours} hour{option.hours === 1 ? '' : 's'} —{' '}
                {formatInr(option.pricePaise)}
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
            {SAFE_SIZE_COPY[chosen.size].label.toLowerCase()} safe, {hours} hour
            {hours === 1 ? '' : 's'}
          </p>

          {/*
            Said before payment, deliberately and with the real figures for the
            chosen size. The overstay charge is the one surprise this product
            could spring on someone, so it is spelled out while they still have
            the choice.
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
                <strong>{formatInr(chosen.overstayHourlyPaise)} per hour started</strong>,
                capped at {quote.rates.capHours} hours (
                {formatInr(
                  overstayMaxFeePaise({
                    ...quote.rates,
                    hourlyRatePaise: chosen.hourlyRatePaise,
                  }),
                )}{' '}
                at most).
              </li>
              <li>
                The safe <strong>will not open</strong> until the fee is paid, and locking it
                still works.
              </li>
              <li>
                Once paid, you have {quote.rates.collectionWindowMinutes} minutes to collect
                your belongings.
              </li>
            </ul>
          </div>

          <p className="mt-4 text-sm text-slate-600 dark:text-slate-400">
            We hold a safe for you while you pay, and your {hours}-hour rental only starts once
            the payment goes through.
          </p>

          <div className="mt-5">
            <Button
              onClick={() => void handleBook()}
              loading={booking}
              loadingText="Holding a safe…"
              disabled={!isBookable(chosen)}
            >
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
      )}

      <Link
        href="/dashboard"
        className="inline-flex min-h-12 items-center justify-center rounded-xl border border-slate-300 bg-white px-5 text-base font-semibold text-slate-900 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800"
      >
        Back to dashboard
      </Link>
    </main>
  );
}
