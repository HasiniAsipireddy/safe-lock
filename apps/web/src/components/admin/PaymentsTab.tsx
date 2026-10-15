'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  formatInr,
  type AdminPaymentRow,
  type Paginated,
  type PaymentStatus,
} from '@safelock/shared';
import { api } from '@/lib/api';
import { toUserMessage } from '@/lib/apiError';
import { Badge } from '@/components/ui/Badge';
import { useToast } from '@/components/ui/Toast';
import { AdminTable, type Column } from './AdminTable';

const STATUS_TONE: Record<PaymentStatus, 'neutral' | 'positive' | 'warning' | 'danger'> = {
  CREATED: 'neutral',
  PAID: 'positive',
  FAILED: 'danger',
  REFUNDED: 'warning',
};

export function PaymentsTab() {
  const toast = useToast();

  const [data, setData] = useState<Paginated<AdminPaymentRow> | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<PaymentStatus | 'ALL'>('ALL');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page) });
      if (status !== 'ALL') params.set('status', status);

      setData(await api.get<Paginated<AdminPaymentRow>>(`/admin/payments?${params.toString()}`));
    } catch (error) {
      toast.error(toUserMessage(error));
    } finally {
      setLoading(false);
    }
  }, [page, status, toast]);

  useEffect(() => {
    void load();
  }, [load]);

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
      cell: (payment) => <span className="font-semibold">{formatInr(payment.amount)}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (payment) => <Badge tone={STATUS_TONE[payment.status]}>{payment.status}</Badge>,
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
  ];

  return (
    <div className="flex flex-col gap-4">
      <label className="flex max-w-xs flex-col gap-1.5 text-sm">
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

      <AdminTable
        data={data}
        columns={columns}
        rowKey={(payment) => payment.id}
        loading={loading}
        emptyMessage="No payments match this filter."
        onPageChange={setPage}
      />
    </div>
  );
}
