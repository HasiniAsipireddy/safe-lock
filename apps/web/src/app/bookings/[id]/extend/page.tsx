'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import {
  formatInr,
  overstayHourlyPaise,
  type BookingDetailResponse,
  type BookingOrderResponse,
  type BookingSummary,
  type ExtensionAvailability,
  type ExtensionRefusalReason,
} from '@safelock/shared';
import { useAuth } from '@/context/AuthContext';
import { Protected } from '@/components/RouteGuard';
import { Button } from '@/components/ui/Button';
import { FormError } from '@/components/ui/FormError';
import { api } from '@/lib/api';
import { toUserMessage } from '@/lib/apiError';
import { formatShortDateTime } from '@/lib/datetime';
import { USE_MOCK_API } from '@/lib/env';
import { MOCK_CHECKOUT_SIGNATURE } from '@/lib/mockApi';
import { useBookingCheckout } from '@/lib/useBookingCheckout';

/**
 * `/bookings/:id/extend` — where a WhatsApp reminder lands.
 *
 * ## Why this page exists at all
 * The dashboard can already extend the *current* booking. This page exists
 * because a message cannot link to "whatever is current": it is written at
 * one moment and read at another, and a link that resolves to a different
 * booking than the one it described would be worse than no link. So the
 * booking is named in the URL.
 *
 * ## What the link grants
 * Nothing. It carries a cuid, which identifies; the session authenticates and
 * the API authorises. `getBookingForUser` folds ownership into a 404, so
 * someone else's link — forwarded, screenshotted, guessed — says only "we
 * couldn't find that booking", with no way to tell apart "not yours" from
 * "does not exist".
 *
 * ## The offer is the server's
 * Durations and prices come from `extension` in the response. This page does
 * no money arithmetic and invents no options, which is what stops it offering
 * five hours that the order endpoint then refuses — the failure a reminder
 * makes likeliest, since the reader is already short of time.
 */
export default function ExtendBookingPage() {
  return (
    <Protected>
      <ExtendBookingContent />
    </Protected>
  );
}

function ExtendBookingContent() {
  const params = useParams<{ id: string }>();
  const bookingId = typeof params.id === 'string' ? params.id : '';
  const { user } = useAuth();

  const [booking, setBooking] = useState<BookingSummary | null>(null);
  const [extension, setExtension] = useState<ExtensionAvailability | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [message, setMessage] = useState<string | null>(null);
  const [hours, setHours] = useState<number | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const detail = await api.get<BookingDetailResponse>(`/bookings/${bookingId}`, {
          ...(signal ? { signal } : {}),
        });

        setBooking(detail.booking);
        setExtension(detail.extension);
        /**
         * Default to the shortest option, not the longest.
         *
         * An extension is money; the cheapest choice should be the one a
         * mis-tap buys. Re-derived on every load so a reload after a
         * collision cannot leave a duration selected that is no longer on
         * offer.
         */
        setHours(detail.extension.options[0]?.hours ?? null);
        setState('ready');
      } catch (error) {
        if (signal?.aborted) return;
        setMessage(toUserMessage(error));
        setState('error');
      }
    },
    [bookingId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const checkout = useBookingCheckout({
    createOrder: () =>
      api.post<BookingOrderResponse>(`/bookings/${bookingId}/extend/order`, { hours }),
    description: `Extend rental by ${hours ?? 0}h`,
    prefill: { name: user?.name, email: user?.email, phone: user?.phone },
    onPaid: () => load(),
    /**
     * The offer went stale between rendering and tapping — someone booked the
     * safe after us, or the grace period ran out into a fee. Reloading replaces
     * the offer with the current one and shows the reason, which is more use
     * than an error message about a duration that is no longer available.
     */
    onOrderRejected: () => {
      void load();
      return true;
    },
  });

  if (state === 'loading') {
    return (
      <Shell>
        <p className="text-sm text-slate-600 dark:text-slate-400" role="status">
          Loading your booking…
        </p>
      </Shell>
    );
  }

  if (state === 'error' || !booking || !extension) {
    return (
      <Shell>
        <FormError variant="banner" message={message ?? 'We could not load that booking.'} />
        <Link
          href="/dashboard"
          className="mt-4 inline-flex min-h-11 items-center text-sm font-semibold text-brand-700 underline underline-offset-2 dark:text-brand-300"
        >
          Go to your dashboard
        </Link>
      </Shell>
    );
  }

  const selected = extension.options.find((option) => option.hours === hours) ?? null;
  const busy = checkout.stage.kind === 'starting' || checkout.stage.kind === 'verifying';

  return (
    <Shell>
      <header>
        <h1 className="text-xl font-bold text-slate-900 dark:text-white">Extend your booking</h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Safe {booking.serialNumber}
          {booking.endsAt ? <> · booked until {formatShortDateTime(booking.endsAt)}</> : null}
        </p>
      </header>

      {checkout.stage.kind === 'success' ? (
        <div
          role="status"
          className="mt-5 rounded-xl border border-emerald-300 bg-emerald-50 p-4 dark:border-emerald-800 dark:bg-emerald-950/40"
        >
          <h2 className="text-base font-bold text-emerald-900 dark:text-emerald-100">
            Your booking is extended
          </h2>
          <p className="mt-1 text-sm text-emerald-900/90 dark:text-emerald-200/90">
            {booking.endsAt ? (
              <>The safe is yours until {formatShortDateTime(booking.endsAt)}.</>
            ) : (
              <>The extra time has been added.</>
            )}
          </p>
          <Link
            href="/dashboard"
            className="mt-3 inline-flex min-h-11 items-center text-sm font-semibold text-emerald-900 underline underline-offset-2 dark:text-emerald-200"
          >
            Back to your safe
          </Link>
        </div>
      ) : extension.allowed && selected ? (
        <div className="mt-5">
          <fieldset>
            <legend className="text-sm font-semibold text-slate-900 dark:text-white">
              How much longer do you need?
            </legend>

            {/*
              Radio buttons rather than a <select>: there are rarely more than a
              handful of options, every price is visible at once without opening
              anything, and each one is a full-width target for a thumb.
            */}
            <div className="mt-3 grid gap-2">
              {extension.options.map((option) => (
                <label
                  key={option.hours}
                  className="flex min-h-12 cursor-pointer items-center justify-between gap-3 rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm has-checked:border-brand-600 has-checked:ring-2 has-checked:ring-brand-600/30 dark:border-slate-700 dark:bg-slate-900"
                >
                  <span className="flex items-center gap-3">
                    <input
                      type="radio"
                      name="extend-hours"
                      className="size-4"
                      value={option.hours}
                      checked={option.hours === hours}
                      onChange={() => setHours(option.hours)}
                    />
                    <span className="font-medium text-slate-900 dark:text-slate-100">
                      {option.hours} more hour{option.hours === 1 ? '' : 's'}
                    </span>
                  </span>
                  <span className="font-semibold text-slate-900 dark:text-white">
                    {formatInr(option.pricePaise)}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {extension.maxHours < booking.rates.capHours && extension.options.length > 0 ? (
            <p className="mt-3 text-sm text-slate-600 dark:text-slate-400">
              {extension.maxHours} hour{extension.maxHours === 1 ? '' : 's'} is the most available
              — this safe is booked again after you.
            </p>
          ) : null}

          <p className="mt-3 text-sm text-slate-600 dark:text-slate-400">
            Extending now costs {formatInr(booking.rates.hourlyRatePaise)} an hour. Running over
            instead costs {formatInr(overstayHourlyPaise(booking.rates))} for every hour started
            after a {booking.rates.graceMinutes}-minute grace period.
          </p>

          <CheckoutNotice checkout={checkout} />

          <div className="mt-4">
            {checkout.stage.kind === 'awaiting-payment' && USE_MOCK_API ? (
              <Button
                onClick={() =>
                  checkout.simulate(
                    (checkout.stage as { order: BookingOrderResponse }).order,
                    MOCK_CHECKOUT_SIGNATURE,
                  )
                }
              >
                Simulate paying {formatInr(selected.pricePaise)}
              </Button>
            ) : (
              <Button onClick={checkout.start} loading={busy} loadingText="Opening payment…">
                Pay {formatInr(selected.pricePaise)}
              </Button>
            )}
          </div>
        </div>
      ) : (
        <Refusal reason={extension.reason} booking={booking} />
      )}
    </Shell>
  );
}

/**
 * A refusal that names the remedy.
 *
 * Someone arrives here from a message with a deadline running, so "you cannot
 * extend" on its own is close to useless: each reason has a different next
 * action, and the page says which.
 */
function Refusal({
  reason,
  booking,
}: {
  reason: ExtensionRefusalReason | null;
  booking: BookingSummary;
}) {
  const copy: { title: string; body: string } =
    reason === 'OVERSTAY_FEE_DUE'
      ? {
          title: 'There is an overstay fee to pay first',
          body: `Your booking ran out, so ${formatInr(booking.overstayFeePaise)} is outstanding. Pay it on your dashboard to unlock the safe, then collect your items — extending is not possible once a fee has started.`,
        }
      : reason === 'IN_COLLECTION_WINDOW'
        ? {
            title: 'This booking is in its collection window',
            body: booking.collectBy
              ? `The fee is settled, so the safe is yours to empty until ${formatShortDateTime(booking.collectBy)}. Collect your items before then.`
              : 'The fee is settled, so the safe is yours to empty. Collect your items before the window closes.',
          }
        : reason === 'FOLLOWING_BOOKING'
          ? {
              title: 'This safe is booked after you',
              body: booking.endsAt
                ? `Someone else has this safe from shortly after ${formatShortDateTime(booking.endsAt)}, so there is no time to add. Collect your items before your booking ends.`
                : 'Someone else has this safe booked after you, so there is no time to add.',
            }
          : {
              title: 'This booking has finished',
              body: 'There is nothing left to extend. You can book a safe again whenever you need one.',
            };

  return (
    <div className="mt-5 rounded-xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/40">
      <h2 className="text-base font-bold text-amber-900 dark:text-amber-100">{copy.title}</h2>
      <p className="mt-1 text-sm text-amber-900/90 dark:text-amber-200/90">{copy.body}</p>
      <Link
        href="/dashboard"
        className="mt-3 inline-flex min-h-11 items-center text-sm font-semibold text-amber-900 underline underline-offset-2 dark:text-amber-200"
      >
        Go to your dashboard
      </Link>
    </div>
  );
}

/** Checkout failures and the needs-review case, which is never a success. */
function CheckoutNotice({ checkout }: { checkout: ReturnType<typeof useBookingCheckout> }) {
  if (checkout.notice) {
    return (
      <p className="mt-3 text-sm text-slate-600 dark:text-slate-400" role="status">
        {checkout.notice}
      </p>
    );
  }

  /**
   * Money taken that could not be applied.
   *
   * Its own panel, never a success message and never an invitation to pay
   * again: the payment is real, it is queued for a manual refund, and telling
   * someone to retry would take a second payment for the same hour.
   */
  if (checkout.stage.kind === 'needs-review') {
    return (
      <div
        role="status"
        className="mt-3 rounded-xl border border-amber-400 bg-white p-4 text-sm dark:border-amber-700 dark:bg-slate-900"
      >
        <p className="font-semibold text-amber-900 dark:text-amber-100">
          Your payment arrived, but the extension could not be applied.
        </p>
        <p className="mt-1 text-slate-700 dark:text-slate-300">
          It has been logged for a refund — please do not pay again. Contact support if you need
          this sorted sooner.
        </p>
      </div>
    );
  }

  if (checkout.stage.kind === 'failed') {
    return (
      <div className="mt-3">
        <FormError variant="banner" message={checkout.stage.message} />
        {checkout.stage.canRetry ? (
          <Button variant="secondary" onClick={checkout.reset} className="mt-2">
            Try again
          </Button>
        ) : null}
      </div>
    );
  }

  return null;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-lg flex-1 px-4 py-8">
      <div className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
        {children}
      </div>
    </main>
  );
}
