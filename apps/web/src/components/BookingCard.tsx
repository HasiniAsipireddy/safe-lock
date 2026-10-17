'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  formatInr,
  overstayHourlyPaise,
  type BookingOrderResponse,
  type BookingSummary,
  type ExtensionAvailability,
} from '@safelock/shared';
import { BookingStatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useAuth } from '@/context/AuthContext';
import { api } from '@/lib/api';
import { toUserMessage } from '@/lib/apiError';
import { formatDuration, formatShortDateTime, msUntil } from '@/lib/datetime';
import { USE_MOCK_API } from '@/lib/env';
import { MOCK_CHECKOUT_SIGNATURE } from '@/lib/mockApi';
import { useBookingCheckout } from '@/lib/useBookingCheckout';

/**
 * The renter's live booking.
 *
 * There are four states it can be in, and each offers exactly the actions that
 * will work — because the API refuses the rest and a button that cannot work
 * is worse than no button:
 *
 * 1. **Awaiting payment.** A safe is held. Pay, or cancel and release it.
 * 2. **Running.** Time left, extend, collect.
 * 3. **Overstaying, fee owed.** The fee, and paying it. **No collect** — the
 *    API refuses that until the fee is settled.
 * 4. **Overstaying, fee settled or waived.** A collection deadline, and
 *    collect.
 *
 * Every one of those is decided from `effectiveStatus`, never `status`: the
 * stored value lags behind the clock by design, and branching on it would show
 * a lapsed hold as a live booking.
 */
export function BookingCard({
  booking,
  extension,
  onChanged,
}: {
  booking: BookingSummary;
  /**
   * The server's extension offer, from the same response as the booking.
   *
   * Passed in rather than computed here: this card, the extension page and the
   * order endpoint must agree about which durations exist and what they cost,
   * and the only way to guarantee that is for one of them to decide and the
   * others to render. Null means "no offer", which is also what an unpaid
   * booking gets.
   */
  extension: ExtensionAvailability | null;
  /** Called after any action that changes the booking, to reload it. */
  onChanged: () => void;
}) {
  const state = booking.effectiveStatus;

  if (state === 'PENDING_PAYMENT') {
    return <PendingBooking booking={booking} onChanged={onChanged} />;
  }

  return <RunningBooking booking={booking} extension={extension} onChanged={onChanged} />;
}

// --- Awaiting payment --------------------------------------------------------

function PendingBooking({
  booking,
  onChanged,
}: {
  booking: BookingSummary;
  onChanged: () => void;
}) {
  const { user } = useAuth();
  const [cancelling, setCancelling] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const holdLeft = useCountdown(booking.holdExpiresAt);

  const checkout = useBookingCheckout({
    createOrder: () => api.post<BookingOrderResponse>(`/bookings/${booking.id}/order`, {}),
    description: `Safe rental — ${booking.hours}h`,
    prefill: { name: user?.name, email: user?.email, phone: user?.phone },
    onPaid: onChanged,
    onOrderRejected: () => {
      // The hold lapsed while this page was open. Reloading shows the truth.
      onChanged();
      return true;
    },
  });

  async function handleCancel() {
    setConfirmCancel(false);
    setCancelling(true);
    setError(null);
    try {
      await api.post(`/bookings/${booking.id}/cancel`, {});
      onChanged();
    } catch (cause) {
      setError(toUserMessage(cause));
    } finally {
      setCancelling(false);
    }
  }

  return (
    <section className="rounded-2xl border border-brand-300 bg-brand-50 p-5 dark:border-brand-800 dark:bg-brand-950/40">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-slate-900 dark:text-white">
            Safe {booking.serialNumber} is held for you
          </h2>
          <p className="mt-1 text-sm text-slate-700 dark:text-slate-300">
            {booking.hours} hour{booking.hours === 1 ? '' : 's'} ·{' '}
            {formatInr(booking.pricePaise)}
          </p>
        </div>
        <BookingStatusBadge status="PENDING_PAYMENT" />
      </div>

      {/*
        The clock starts when the payment lands, not now. Saying so is the
        point: it is why holding a safe before paying is safe to offer, and a
        user who worries that a slow checkout eats their time would otherwise
        rush.
      */}
      <p className="mt-3 text-sm text-slate-700 dark:text-slate-300">
        Your {booking.hours}-hour rental starts when your payment goes through — not now. This
        hold releases the safe in <strong>{formatDuration(holdLeft)}</strong> if it is unpaid.
      </p>

      <CheckoutStatus checkout={checkout} />

      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        {checkout.stage.kind === 'awaiting-payment' && USE_MOCK_API ? (
          <Button
            onClick={() =>
              checkout.simulate(
                (checkout.stage as { order: BookingOrderResponse }).order,
                MOCK_CHECKOUT_SIGNATURE,
              )
            }
          >
            Simulate a successful payment
          </Button>
        ) : (
          <Button
            onClick={checkout.start}
            loading={checkout.stage.kind === 'starting' || checkout.stage.kind === 'verifying'}
            loadingText="Opening payment…"
            disabled={checkout.stage.kind === 'success'}
          >
            Pay {formatInr(booking.pricePaise)}
          </Button>
        )}

        <Button variant="secondary" onClick={() => setConfirmCancel(true)} loading={cancelling}>
          Cancel booking
        </Button>
      </div>

      <p role="alert" aria-live="assertive" className="mt-2 min-h-5 text-sm font-medium text-red-700 dark:text-red-300">
        {error}
      </p>

      <ConfirmDialog
        open={confirmCancel}
        title="Cancel this booking?"
        description="The safe is released immediately and may be taken by someone else. Nothing has been charged."
        confirmLabel="Cancel it"
        pending={cancelling}
        onConfirm={() => void handleCancel()}
        onCancel={() => setConfirmCancel(false)}
      />
    </section>
  );
}

// --- Running, or overstaying --------------------------------------------------

function RunningBooking({
  booking,
  extension,
  onChanged,
}: {
  booking: BookingSummary;
  extension: ExtensionAvailability | null;
  onChanged: () => void;
}) {
  const { user } = useAuth();
  const overstaying = booking.effectiveStatus === 'OVERSTAY';
  const feeDue = booking.overstayFeePaise > 0;
  const settled = booking.overstaySettledAt !== null || booking.collectBy !== null;

  const timeLeft = useCountdown(booking.endsAt);
  const collectLeft = useCountdown(booking.collectBy);

  const [collecting, setCollecting] = useState(false);
  const [confirmCollect, setConfirmCollect] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * The selected duration, chosen from the server's options.
   *
   * Defaults to the shortest on offer — an extension is money, so the
   * cheapest choice should be what a mis-tap buys — and resets whenever the
   * offer changes, so a reload after a collision cannot leave a duration
   * selected that is no longer available.
   */
  const extendOptions = extension?.allowed ? extension.options : [];
  const [extendHours, setExtendHours] = useState<number | null>(
    extendOptions[0]?.hours ?? null,
  );

  const offeredHours = extendOptions.map((option) => option.hours).join(',');
  useEffect(() => {
    setExtendHours(extendOptions[0]?.hours ?? null);
    // Keyed on the *set* of offered hours, not the array identity, which is a
    // fresh object on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offeredHours]);

  const feeCheckout = useBookingCheckout({
    createOrder: () =>
      api.post<BookingOrderResponse>(`/bookings/${booking.id}/overstay/order`, {}),
    description: 'Overstay fee',
    prefill: { name: user?.name, email: user?.email, phone: user?.phone },
    onPaid: onChanged,
    onOrderRejected: () => {
      onChanged();
      return true;
    },
  });

  const extendCheckout = useBookingCheckout({
    createOrder: () =>
      api.post<BookingOrderResponse>(`/bookings/${booking.id}/extend/order`, {
        hours: extendHours,
      }),
    description: `Extend rental by ${extendHours ?? 0}h`,
    prefill: { name: user?.name, email: user?.email, phone: user?.phone },
    onPaid: onChanged,
  });

  async function handleCollect() {
    setConfirmCollect(false);
    setCollecting(true);
    setError(null);
    try {
      await api.post(`/bookings/${booking.id}/collect`, {});
      onChanged();
    } catch (cause) {
      setError(toUserMessage(cause));
    } finally {
      setCollecting(false);
    }
  }

  /**
   * The price of the selected option, **as quoted by the server**.
   *
   * This used to be `hourlyRatePaise * extendHours` — money arithmetic in the
   * browser, against the rule that the client does none. Now it is a lookup,
   * so the number on the button is the number the order will be for.
   */
  const extendPrice =
    extendOptions.find((option) => option.hours === extendHours)?.pricePaise ?? null;

  return (
    <section
      className={
        overstaying
          ? 'rounded-2xl border border-amber-300 bg-amber-50 p-5 dark:border-amber-800 dark:bg-amber-950/40'
          : 'rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900'
      }
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
            Your booking
          </h2>
          <p className="mt-1 text-base font-bold text-slate-900 dark:text-white">
            Safe {booking.serialNumber}
          </p>
        </div>
        <BookingStatusBadge status={booking.effectiveStatus} />
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-slate-500 dark:text-slate-400">Booked until</dt>
          <dd className="mt-0.5 font-medium text-slate-900 dark:text-slate-100">
            {booking.endsAt ? formatShortDateTime(booking.endsAt) : '—'}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500 dark:text-slate-400">
            {overstaying ? 'Over by' : 'Time left'}
          </dt>
          <dd className="mt-0.5 font-medium text-slate-900 dark:text-slate-100">
            {overstaying
              ? `${booking.overstayHours} hour${booking.overstayHours === 1 ? '' : 's'} charged`
              : formatDuration(timeLeft)}
          </dd>
        </div>
      </dl>

      {/* --- Overstaying, fee owed ------------------------------------------ */}
      {feeDue ? (
        <div className="mt-4 rounded-xl border border-amber-400 bg-white p-4 dark:border-amber-700 dark:bg-slate-900">
          <h3 className="text-base font-bold text-amber-900 dark:text-amber-100">
            Overstay fee: {formatInr(booking.overstayFeePaise)}
          </h3>
          <p className="mt-1 text-sm text-slate-700 dark:text-slate-300">
            Your booking ran out, so {formatInr(overstayHourlyPaise(booking.rates))} is charged
            for each hour started after a {booking.rates.graceMinutes}-minute grace period, up to{' '}
            {booking.rates.capHours} hours. Pay the fee to unlock your safe and collect your
            items — you then have {booking.rates.collectionWindowMinutes} minutes to do it.
          </p>

          {/*
            The quote is binding for a bounded window and the Razorpay order
            carries the same expiry, because the fee keeps growing while the
            user is at the checkout. Said plainly here so a payment that
            arrives too late to cover the fee is not a surprise.
          */}
          {feeCheckout.stage.kind === 'awaiting-payment' &&
          feeCheckout.stage.order.quoteExpiresAt ? (
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
              This amount is held for{' '}
              {formatDuration(msUntil(feeCheckout.stage.order.quoteExpiresAt))}. After that you
              will need a fresh quote.
            </p>
          ) : null}

          <CheckoutStatus checkout={feeCheckout} />

          <div className="mt-3">
            {feeCheckout.stage.kind === 'awaiting-payment' && USE_MOCK_API ? (
              <Button
                onClick={() =>
                  feeCheckout.simulate(
                    (feeCheckout.stage as { order: BookingOrderResponse }).order,
                    MOCK_CHECKOUT_SIGNATURE,
                  )
                }
              >
                Simulate paying the fee
              </Button>
            ) : (
              <Button
                onClick={feeCheckout.start}
                loading={
                  feeCheckout.stage.kind === 'starting' || feeCheckout.stage.kind === 'verifying'
                }
                loadingText="Opening payment…"
              >
                Pay {formatInr(booking.overstayFeePaise)}
              </Button>
            )}
          </div>
        </div>
      ) : null}

      {/* --- Overstaying, settled: the collection window -------------------- */}
      {overstaying && settled && !feeDue ? (
        <div
          role="status"
          className="mt-4 rounded-xl border border-emerald-300 bg-emerald-50 p-4 dark:border-emerald-800 dark:bg-emerald-950/40"
        >
          <h3 className="text-base font-bold text-emerald-900 dark:text-emerald-100">
            Collect your items
          </h3>
          <p className="mt-1 text-sm text-emerald-900/90 dark:text-emerald-200/90">
            You have <strong>{formatDuration(collectLeft)}</strong> to unlock the safe and take
            your belongings. After that the booking closes and the safe is held back for a staff
            check before anyone else can use it.
          </p>
        </div>
      ) : null}

      {/* --- Extend ---------------------------------------------------------- */}
      {extendOptions.length > 0 && extendHours !== null && extendPrice !== null ? (
        <div className="mt-4 border-t border-slate-200 pt-4 dark:border-slate-800">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
            Need more time?
          </h3>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Extending is cheaper than overstaying, and you can still do it during the grace
            period.
          </p>

          <div className="mt-3 flex flex-wrap items-end gap-3">
            <div>
              <label
                htmlFor="extend-hours"
                className="block text-sm font-medium text-slate-700 dark:text-slate-300"
              >
                Extra hours
              </label>
              {/*
                The options are the server's, so this list cannot offer a
                duration the order endpoint would refuse — which is what the
                hardcoded 1-to-12 it replaces did whenever another booking
                followed this one.
              */}
              <select
                id="extend-hours"
                value={extendHours}
                onChange={(event) => setExtendHours(Number(event.target.value))}
                className="mt-1 min-h-12 rounded-xl border border-slate-300 bg-white px-3 text-base text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              >
                {extendOptions.map((option) => (
                  <option key={option.hours} value={option.hours}>
                    {option.hours} hour{option.hours === 1 ? '' : 's'} ·{' '}
                    {formatInr(option.pricePaise)}
                  </option>
                ))}
              </select>
            </div>

            {extendCheckout.stage.kind === 'awaiting-payment' && USE_MOCK_API ? (
              <Button
                onClick={() =>
                  extendCheckout.simulate(
                    (extendCheckout.stage as { order: BookingOrderResponse }).order,
                    MOCK_CHECKOUT_SIGNATURE,
                  )
                }
              >
                Simulate paying for the extension
              </Button>
            ) : (
              <Button
                variant="secondary"
                onClick={extendCheckout.start}
                loading={
                  extendCheckout.stage.kind === 'starting' ||
                  extendCheckout.stage.kind === 'verifying'
                }
                loadingText="Opening payment…"
              >
                Extend for {formatInr(extendPrice)}
              </Button>
            )}
          </div>

          <CheckoutStatus checkout={extendCheckout} />
        </div>
      ) : null}

      {/* --- Collect --------------------------------------------------------- */}
      <div className="mt-4 border-t border-slate-200 pt-4 dark:border-slate-800">
        <Button
          variant="secondary"
          onClick={() => setConfirmCollect(true)}
          loading={collecting}
          loadingText="Finishing up…"
          // The API refuses this with 402 while a fee is owed. Saying so here
          // is better than letting the user find out by being refused.
          disabled={feeDue}
        >
          I’ve collected my items
        </Button>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
          {feeDue
            ? 'Pay your overstay fee first. The safe stays yours until you do.'
            : 'This ends your booking and returns the safe. Make sure it is empty first — we cannot check for you.'}
        </p>
      </div>

      <p
        role="alert"
        aria-live="assertive"
        className="mt-2 min-h-5 text-sm font-medium text-red-700 dark:text-red-300"
      >
        {error}
      </p>

      <ConfirmDialog
        open={confirmCollect}
        title="Finished with the safe?"
        description="This ends your booking and returns the safe to the pool. You will not be able to unlock it again. Check it is empty first."
        confirmLabel="Yes, I'm done"
        pending={collecting}
        onConfirm={() => void handleCollect()}
        onCancel={() => setConfirmCollect(false)}
      />
    </section>
  );
}

// --- Shared bits -------------------------------------------------------------

/**
 * A minute-resolution countdown to an ISO instant.
 *
 * Ticks every 30 seconds rather than every second: the displayed value has
 * minute resolution, so a per-second interval would re-render 59 times for
 * nothing, and nothing a renter decides turns on the seconds digit.
 */
function useCountdown(iso: string | null): number {
  const [remaining, setRemaining] = useState(() => (iso ? msUntil(iso) : 0));

  useEffect(() => {
    if (!iso) {
      setRemaining(0);
      return;
    }

    setRemaining(msUntil(iso));
    const timer = setInterval(() => setRemaining(msUntil(iso)), 30_000);
    return () => clearInterval(timer);
  }, [iso]);

  return remaining;
}

/**
 * The checkout's own status line.
 *
 * `needs-review` is the case that must not read as success: the money arrived
 * and could not be applied, so it says so and points at support rather than
 * congratulating anybody.
 */
function CheckoutStatus({
  checkout,
}: {
  checkout: ReturnType<typeof useBookingCheckout>;
}) {
  const { stage, notice } = checkout;

  if (stage.kind === 'needs-review') {
    return (
      <div
        role="alert"
        className="mt-3 rounded-xl border border-red-300 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950/40"
      >
        <h3 className="text-base font-bold text-red-900 dark:text-red-100">
          Your payment went through, but we could not apply it
        </h3>
        <p className="mt-1 text-sm text-red-900/90 dark:text-red-200/90">
          The safe was taken, or the amount no longer covered the fee. Your payment is logged for
          a refund — please contact support, and do not pay again.
        </p>
        <Link
          href="/contact"
          className="mt-3 inline-flex min-h-12 items-center justify-center rounded-xl bg-red-600 px-5 text-base font-semibold text-white hover:bg-red-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-500"
        >
          Contact support
        </Link>
      </div>
    );
  }

  if (stage.kind === 'failed') {
    return (
      <p role="alert" className="mt-3 text-sm font-medium text-red-700 dark:text-red-300">
        {stage.message}
        {stage.canRetry ? '' : ' Please contact support before paying again.'}
      </p>
    );
  }

  if (notice) {
    return (
      <p role="status" className="mt-3 text-sm text-slate-600 dark:text-slate-400">
        {notice}
      </p>
    );
  }

  if (stage.kind === 'verifying') {
    return (
      <p role="status" aria-live="polite" className="mt-3 text-sm text-slate-600 dark:text-slate-400">
        Confirming your payment on our server…
      </p>
    );
  }

  return null;
}
