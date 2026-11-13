'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  formatInr,
  type MyBookingItem,
  type MyBookingsResponse,
} from '@safelock/shared';
import { Protected } from '@/components/RouteGuard';
import { BookingStatusBadge } from '@/components/ui/Badge';
import { FormError } from '@/components/ui/FormError';
import { api } from '@/lib/api';
import { toUserMessage } from '@/lib/apiError';
import { formatShortDateTime } from '@/lib/datetime';
import { PAYMENT_PURPOSE_LABEL } from '@/lib/paymentLabels';

/**
 * `/bookings` — every rental the user has made, with what they paid.
 *
 * Status is the **effective** one, as everywhere: a hold that lapsed reads
 * "Hold expired" even if the sweeper has not caught up. Money comes from the
 * server's payment lines; the page adds nothing up itself.
 */
export default function MyBookingsPage() {
  return (
    <Protected>
      <MyBookingsContent />
    </Protected>
  );
}

function MyBookingsContent() {
  const [items, setItems] = useState<MyBookingItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    api
      .get<MyBookingsResponse>('/bookings/mine', { signal: controller.signal })
      .then((response) => setItems(response.items))
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(toUserMessage(cause));
      });

    return () => controller.abort();
  }, []);

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 px-4 py-8 sm:px-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
          My bookings
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Every safe you have rented, what you paid, and a receipt for each.
        </p>
      </div>

      {error ? <FormError variant="banner" message={error} /> : null}

      {!items && !error ? (
        <p role="status" className="text-sm text-slate-600">
          Loading your bookings…
        </p>
      ) : null}

      {items && items.length === 0 ? (
        <div className="rounded-2xl border border-brand-200 bg-white p-6 text-center">
          <p className="font-semibold text-slate-900">No bookings yet</p>
          <p className="mt-1 text-sm text-slate-600">When you rent a safe it will appear here.</p>
          <Link
            href="/book"
            className="mt-4 inline-flex min-h-12 items-center justify-center rounded-xl bg-brand-600 px-5 font-semibold text-white hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
          >
            Book a safe
          </Link>
        </div>
      ) : null}

      {items && items.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {items.map((item) => (
            <li key={item.booking.id}>
              <BookingRow item={item} />
            </li>
          ))}
        </ul>
      ) : null}
    </main>
  );
}

function BookingRow({ item }: { item: MyBookingItem }) {
  const { booking, payments } = item;
  const live = booking.effectiveStatus === 'ACTIVE' || booking.effectiveStatus === 'OVERSTAY';

  return (
    <article className="rounded-2xl border border-brand-200 bg-white p-4 shadow-sm sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-mono text-base font-bold text-slate-900">{booking.serialNumber}</p>
          <p className="text-sm text-slate-600">
            {formatShortDateTime(booking.createdAt)} · {booking.hours}{' '}
            {booking.hours === 1 ? 'hour' : 'hours'}
          </p>
        </div>
        <BookingStatusBadge status={booking.effectiveStatus} />
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <div>
          <dt className="text-slate-500">{item.completedAt ? 'Ended' : 'Ends'}</dt>
          <dd className="font-medium text-slate-900">
            {item.completedAt
              ? formatShortDateTime(item.completedAt)
              : booking.endsAt
                ? formatShortDateTime(booking.endsAt)
                : '—'}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">Total paid</dt>
          <dd className="font-bold text-brand-800">{formatInr(item.totalPaidPaise)}</dd>
        </div>
      </dl>

      {payments.length > 0 ? (
        <ul className="mt-3 flex flex-wrap gap-2 text-xs">
          {payments.map((payment) => (
            <li
              key={payment.id}
              className={
                payment.status === 'REFUNDED'
                  ? 'rounded-full bg-slate-100 px-2.5 py-1 text-slate-600 line-through'
                  : 'rounded-full bg-brand-50 px-2.5 py-1 text-brand-800 ring-1 ring-brand-100'
              }
            >
              {PAYMENT_PURPOSE_LABEL[payment.purpose]} {formatInr(payment.amountPaise)}
              {payment.status === 'REFUNDED' ? ' (refunded)' : ''}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        {payments.length > 0 ? (
          <Link
            href={`/bookings/${booking.id}/receipt`}
            className="inline-flex min-h-11 items-center rounded-xl border border-brand-300 bg-white px-4 text-sm font-semibold text-brand-800 hover:bg-brand-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
          >
            View receipt
          </Link>
        ) : null}
        {live ? (
          <Link
            href="/dashboard"
            className="inline-flex min-h-11 items-center rounded-xl bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
          >
            Go to my safe
          </Link>
        ) : null}
      </div>
    </article>
  );
}
