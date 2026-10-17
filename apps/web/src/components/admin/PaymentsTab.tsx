'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  formatInr,
  type AdminPaymentRow,
  type Paginated,
  type PaymentPurpose,
  type PaymentReviewReason,
  type PaymentStatus,
} from '@safelock/shared';
import { api } from '@/lib/api';
import { toUserMessage } from '@/lib/apiError';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';
import { AdminTable, type Column } from './AdminTable';

const STATUS_TONE: Record<PaymentStatus, 'neutral' | 'positive' | 'warning' | 'danger'> = {
  CREATED: 'neutral',
  PAID: 'positive',
  FAILED: 'danger',
  REFUNDED: 'warning',
};

const PURPOSE_LABEL: Record<PaymentPurpose, string> = {
  BOOKING: 'Booking',
  EXTENSION: 'Extension',
  OVERSTAY: 'Overstay fee',
};

/**
 * Why money could not be applied, in words an admin can act on.
 *
 * Not the enum name: "BOOKING_EXPIRED_DEVICE_TAKEN" tells someone reading a
 * refund queue nothing about what to do next.
 */
const REVIEW_REASON_LABEL: Record<PaymentReviewReason, string> = {
  BOOKING_EXPIRED_DEVICE_TAKEN:
    'Paid after the hold lapsed, and the safe had gone to someone else.',
  OVERSTAY_QUOTE_EXPIRED: 'Paid against an expired quote that no longer covered the fee.',
  BOOKING_NO_LONGER_PAYABLE: 'The booking had already ended when the money arrived.',
};

export function PaymentsTab() {
  const toast = useToast();

  const [data, setData] = useState<Paginated<AdminPaymentRow> | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<PaymentStatus | 'ALL'>('ALL');
  const [view, setView] = useState<'ALL' | 'NEEDS_REFUND'>('ALL');
  const [clearing, setClearing] = useState<AdminPaymentRow | null>(null);
  const [note, setNote] = useState('');
  const [acting, setActing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page) });
      if (status !== 'ALL') params.set('status', status);
      if (view === 'NEEDS_REFUND') params.set('needsReview', 'true');

      setData(await api.get<Paginated<AdminPaymentRow>>(`/admin/payments?${params.toString()}`));
    } catch (error) {
      toast.error(toUserMessage(error));
    } finally {
      setLoading(false);
    }
  }, [page, status, view, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const needsRefund = (payment: AdminPaymentRow): boolean =>
    payment.reviewReason !== null && payment.reviewClearedAt === null;

  async function clearReview() {
    if (!clearing) return;
    setActing(true);

    try {
      await api.post(`/admin/payments/${clearing.id}/clear-review`, { note: note.trim() });
      toast.success('Marked as refunded.');
      setClearing(null);
      setNote('');
      void load();
    } catch (error) {
      toast.error(toUserMessage(error));
    } finally {
      setActing(false);
    }
  }

  const columns: Array<Column<AdminPaymentRow>> = [
    {
      key: 'user',
      header: 'User',
      cell: (payment) =>
        payment.user ? (
          <span>
            <span className="font-semibold">{payment.user.name}</span>
            <span className="block text-xs text-slate-500 dark:text-slate-400">
              {payment.user.email}
            </span>
          </span>
        ) : (
          <span className="text-slate-400 dark:text-slate-500">(deleted user)</span>
        ),
    },
    {
      key: 'amount',
      header: 'Amount',
      cell: (payment) => (
        <span>
          <span className="font-semibold">{formatInr(payment.amount)}</span>
          <span className="block text-xs text-slate-500 dark:text-slate-400">
            {PURPOSE_LABEL[payment.purpose]}
          </span>
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (payment) => (
        <span className="flex flex-col gap-1">
          <Badge tone={STATUS_TONE[payment.status]}>{payment.status}</Badge>
          {/*
            A flagged row stays PAID — we never rewrite a payment to pretend it
            did not happen — so the flag is the only thing that distinguishes
            "money we used" from "money we owe back".
          */}
          {needsRefund(payment) ? (
            <>
              <Badge tone="danger">Needs refund</Badge>
              <span className="text-xs text-red-700 dark:text-red-300">
                {REVIEW_REASON_LABEL[payment.reviewReason!]}
              </span>
            </>
          ) : null}
          {payment.reviewReason !== null && payment.reviewClearedAt !== null ? (
            <span className="text-xs text-slate-500 dark:text-slate-400">Refund recorded</span>
          ) : null}
        </span>
      ),
    },
    {
      key: 'order',
      header: 'Razorpay order',
      cell: (payment) => (
        <span className="font-mono text-xs break-all">{payment.razorpayOrderId}</span>
      ),
    },
    {
      key: 'date',
      header: 'Paid at',
      cell: (payment) => (
        <span className="text-sm">
          {payment.paidAt ? new Date(payment.paidAt).toLocaleString('en-IN') : '—'}
        </span>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      hideLabelOnMobile: true,
      cell: (payment) =>
        needsRefund(payment) ? (
          <Button
            variant="secondary"
            fullWidth={false}
            className="min-h-10 px-3 text-sm"
            onClick={() => {
              setNote('');
              setClearing(payment);
            }}
          >
            Mark refunded
          </Button>
        ) : (
          <span className="text-slate-400 dark:text-slate-500">—</span>
        ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <label className="flex max-w-xs flex-1 flex-col gap-1.5 text-sm">
          <span className="font-semibold text-slate-700 dark:text-slate-300">Show</span>
          <select
            value={view}
            onChange={(event) => {
              setView(event.target.value as 'ALL' | 'NEEDS_REFUND');
              setPage(1);
            }}
            className="min-h-12 rounded-xl border border-slate-300 bg-white px-3 text-base text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          >
            <option value="ALL">All payments</option>
            <option value="NEEDS_REFUND">Needs a refund</option>
          </select>
        </label>

        <label className="flex max-w-xs flex-1 flex-col gap-1.5 text-sm">
          <span className="font-semibold text-slate-700 dark:text-slate-300">Status</span>
          <select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as PaymentStatus | 'ALL');
              setPage(1);
            }}
            className="min-h-12 rounded-xl border border-slate-300 bg-white px-3 text-base text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          >
            <option value="ALL">All</option>
            <option value="PAID">Paid</option>
            <option value="CREATED">Created</option>
            <option value="FAILED">Failed</option>
            <option value="REFUNDED">Refunded</option>
          </select>
        </label>
      </div>

      <AdminTable
        data={data}
        columns={columns}
        rowKey={(payment) => payment.id}
        loading={loading}
        emptyMessage="No payments match this filter."
        onPageChange={setPage}
        rowClassName={(payment) =>
          needsRefund(payment)
            ? 'rounded-xl border-2 border-red-300 bg-red-50 p-4 dark:border-red-800 dark:bg-red-950/30 sm:border-x-0 sm:border-t-0 sm:border-b sm:rounded-none sm:bg-red-50/60 sm:dark:bg-red-950/20'
            : undefined
        }
      />

      {/*
        Recording a refund, not issuing one.
        The refund itself happens in the Razorpay dashboard — that is the only
        place with the authority and its own ledger — and this records that it
        did. It deliberately does not change the payment's status: a payment is
        PAID until Razorpay says otherwise, and the `refund.processed` webhook
        is what says so.
      */}
      <ConfirmDialog
        open={clearing !== null}
        title="Mark this payment as refunded?"
        description={`Refund ${clearing ? formatInr(clearing.amount) : ''} in the Razorpay dashboard first. This only records that you did, and does not move any money.`}
        confirmLabel="Record the refund"
        pending={acting}
        confirmDisabled={note.trim().length < 3}
        onConfirm={() => void clearReview()}
        onCancel={() => {
          setClearing(null);
          setNote('');
        }}
      >
        <Input
          label="How was it refunded?"
          hint="Recorded in the audit log. A Razorpay refund id is ideal."
          value={note}
          maxLength={500}
          onChange={(event) => setNote(event.target.value)}
        />
      </ConfirmDialog>
    </div>
  );
}
