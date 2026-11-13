'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { formatInr, type BookingReceiptResponse } from '@safelock/shared';
import { Protected } from '@/components/RouteGuard';
import { Button } from '@/components/ui/Button';
import { FormError } from '@/components/ui/FormError';
import { BOOKING_STATUS_LABEL } from '@/components/ui/Badge';
import { api } from '@/lib/api';
import { toUserMessage } from '@/lib/apiError';
import { formatShortDateTime } from '@/lib/datetime';
import { PAYMENT_PURPOSE_LABEL } from '@/lib/paymentLabels';

/**
 * `/bookings/:id/receipt` — a printable record of what was paid.
 *
 * "Print / Save as PDF" uses the browser's own print dialog, which every
 * desktop and phone browser can turn into a PDF, so there is no PDF library
 * and nothing generated server-side. The header, footer and buttons are
 * hidden in print (`print:hidden`), leaving just the receipt.
 *
 * **Not a tax invoice.** No GSTIN or registered business details exist yet
 * (see the open questions in CLAUDE.md), and the page says so rather than
 * looking like one.
 */
export default function ReceiptPage() {
  return (
    <Protected>
      <ReceiptContent />
    </Protected>
  );
}

function ReceiptContent() {
  const params = useParams<{ id: string }>();
  const bookingId = typeof params.id === 'string' ? params.id : '';
  const [receipt, setReceipt] = useState<BookingReceiptResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    api
      .get<BookingReceiptResponse>(`/bookings/${bookingId}/receipt`, {
        signal: controller.signal,
      })
      .then(setReceipt)
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(toUserMessage(cause));
      });

    return () => controller.abort();
  }, [bookingId]);

  if (error) {
    return (
      <main className="mx-auto w-full max-w-lg flex-1 px-4 py-8">
        <FormError variant="banner" message={error} />
        <BackLink />
      </main>
    );
  }

  if (!receipt) {
    return (
      <main className="mx-auto w-full max-w-lg flex-1 px-4 py-8">
        <p role="status" className="text-sm text-slate-600">
          Loading receipt…
        </p>
      </main>
    );
  }

  const { item, customer } = receipt;
  const { booking } = item;

  return (
    <main className="mx-auto w-full max-w-lg flex-1 px-4 py-8 print:max-w-none print:p-0">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 print:hidden">
        <BackLink />
        <Button fullWidth={false} onClick={() => window.print()}>
          Print / Save as PDF
        </Button>
      </div>

      <article className="rounded-2xl border border-brand-200 bg-white p-6 shadow-sm print:border-0 print:shadow-none">
        <header className="flex items-start justify-between gap-4 border-b border-brand-100 pb-4">
          <div>
            <p className="text-lg font-bold text-brand-800">Safe Lock</p>
            <p className="text-xs text-slate-500">Payment receipt</p>
          </div>
          <div className="text-right text-xs text-slate-600">
            <p>
              Receipt no.{' '}
              <span className="font-mono font-semibold text-slate-900">
                {booking.id.slice(-10).toUpperCase()}
              </span>
            </p>
            <p>Issued {formatShortDateTime(receipt.issuedAt)}</p>
          </div>
        </header>

        <section className="grid grid-cols-2 gap-4 border-b border-brand-100 py-4 text-sm">
          <div>
            <h2 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
              Billed to
            </h2>
            <p className="mt-1 font-medium text-slate-900">{customer.name}</p>
            <p className="text-slate-600">{customer.email}</p>
            <p className="text-slate-600">{customer.phoneMasked}</p>
          </div>
          <div>
            <h2 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
              Rental
            </h2>
            <p className="mt-1 font-mono font-medium text-slate-900">{booking.serialNumber}</p>
            <p className="text-slate-600">
              {booking.hours} {booking.hours === 1 ? 'hour' : 'hours'} ·{' '}
              {BOOKING_STATUS_LABEL[booking.effectiveStatus]}
            </p>
            <p className="text-slate-600">Booked {formatShortDateTime(booking.createdAt)}</p>
            {item.completedAt ? (
              <p className="text-slate-600">Ended {formatShortDateTime(item.completedAt)}</p>
            ) : null}
          </div>
        </section>

        <table className="mt-4 w-full text-sm">
          <caption className="sr-only">Payments for this booking</caption>
          <thead>
            <tr className="text-left text-xs text-slate-500">
              <th scope="col" className="pb-2 font-medium">
                Item
              </th>
              <th scope="col" className="pb-2 font-medium">
                Paid on
              </th>
              <th scope="col" className="pb-2 text-right font-medium">
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {item.payments.length === 0 ? (
              <tr>
                <td colSpan={3} className="py-3 text-slate-600">
                  No payments were made for this booking.
                </td>
              </tr>
            ) : (
              item.payments.map((payment) => (
                <tr key={payment.id} className="border-t border-slate-100 align-top">
                  <td className="py-2">
                    <p className="font-medium text-slate-900">
                      {PAYMENT_PURPOSE_LABEL[payment.purpose]}
                      {payment.status === 'REFUNDED' ? ' (refunded)' : ''}
                    </p>
                    {payment.razorpayPaymentId ? (
                      <p className="font-mono text-xs text-slate-500">
                        {payment.razorpayPaymentId}
                      </p>
                    ) : null}
                  </td>
                  <td className="py-2 text-slate-600">
                    {payment.paidAt ? formatShortDateTime(payment.paidAt) : '—'}
                  </td>
                  <td
                    className={
                      payment.status === 'REFUNDED'
                        ? 'py-2 text-right text-slate-500 line-through'
                        : 'py-2 text-right font-medium text-slate-900'
                    }
                  >
                    {formatInr(payment.amountPaise)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-brand-200">
              <th scope="row" colSpan={2} className="pt-3 text-left font-semibold text-slate-900">
                Total paid
              </th>
              <td className="pt-3 text-right text-lg font-bold text-brand-800">
                {formatInr(item.totalPaidPaise)}
              </td>
            </tr>
          </tfoot>
        </table>

        <p className="mt-6 text-xs text-slate-500">
          This is a payment receipt, not a tax invoice. Payments are processed by Razorpay. Keep
          the receipt number if you need to contact support.
        </p>
      </article>
    </main>
  );
}

function BackLink() {
  return (
    <Link
      href="/bookings"
      className="inline-flex min-h-11 items-center text-sm font-semibold text-brand-700 underline underline-offset-2"
    >
      ← My bookings
    </Link>
  );
}
