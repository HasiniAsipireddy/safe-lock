'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatInr, type AdminUserRow, type Paginated } from '@safelock/shared';
import { api } from '@/lib/api';
import { toUserMessage } from '@/lib/apiError';
import { Badge, BookingStatusBadge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';
import { formatShortDateTime } from '@/lib/datetime';
import { AdminTable, type Column } from './AdminTable';

/**
 * The admin Users tab.
 *
 * **There is no Allocate button any more**, and no paid/allocated/refunded
 * states: paying for a booking is what gets someone a safe, and which safe is
 * decided under a row lock by the booking service. What stays is the question
 * an admin actually asks of a user — *what have they got out, and is it in
 * trouble* — which is one column rather than three flags.
 *
 * Actions on a booking live on the Bookings tab, where the booking is the
 * subject rather than an attribute of someone.
 */
type Filter = 'ALL' | 'BOOKED' | 'FREE';

const FILTER_PARAMS: Record<Filter, Record<string, string>> = {
  ALL: {},
  BOOKED: { booked: 'true' },
  FREE: { booked: 'false' },
};

export function UsersTab({ refreshKey }: { refreshKey?: number }) {
  const toast = useToast();

  const [data, setData] = useState<Paginated<AdminUserRow> | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState<Filter>('ALL');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), ...FILTER_PARAMS[filter] });
      if (query) params.set('q', query);

      setData(await api.get<Paginated<AdminUserRow>>(`/admin/users?${params.toString()}`));
    } catch (error) {
      toast.error(toUserMessage(error));
    } finally {
      setLoading(false);
    }
  }, [page, filter, query, toast]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search.trim());
      setPage(1);
    }, 350);
    return () => clearTimeout(timer);
  }, [search]);

  const owesFee = (user: AdminUserRow): boolean =>
    (user.currentBooking?.overstayFeePaise ?? 0) > 0;

  const columns: Array<Column<AdminUserRow>> = [
    {
      key: 'user',
      header: 'User',
      cell: (user) => (
        <span>
          <span className="font-semibold">{user.name}</span>
          {user.role === 'ADMIN' && (
            <Badge tone="info" className="ml-2">
              Admin
            </Badge>
          )}
          <span className="block text-xs text-slate-500 dark:text-slate-400">{user.email}</span>
          <span className="block text-xs text-slate-500 dark:text-slate-400">
            {user.phone}
            {user.phoneVerified ? '' : ' (unverified)'}
          </span>
        </span>
      ),
    },
    {
      key: 'booking',
      header: 'Current booking',
      cell: (user) =>
        user.currentBooking ? (
          <span>
            <BookingStatusBadge status={user.currentBooking.effectiveStatus} />
            <span className="mt-1 block font-mono text-sm">
              {user.currentBooking.serialNumber}
            </span>
            {user.currentBooking.endsAt ? (
              <span className="block text-xs text-slate-500 dark:text-slate-400">
                until {formatShortDateTime(user.currentBooking.endsAt)}
              </span>
            ) : null}
          </span>
        ) : (
          <span className="text-slate-400 dark:text-slate-500">None</span>
        ),
    },
    {
      key: 'fee',
      header: 'Owes',
      cell: (user) =>
        owesFee(user) ? (
          // The one thing on this row that needs a human. Text, not colour
          // alone — the row highlight below is the redundant signal.
          <Badge tone="danger">{formatInr(user.currentBooking!.overstayFeePaise)} overstay</Badge>
        ) : (
          <span className="text-slate-400 dark:text-slate-500">—</span>
        ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <Input
            label="Search"
            type="search"
            placeholder="Name, email or phone"
            value={search}
            maxLength={100}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>

        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-semibold text-slate-700 dark:text-slate-300">Show</span>
          <select
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value as Filter);
              setPage(1);
            }}
            className="min-h-12 rounded-xl border border-slate-300 bg-white px-3 text-base text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          >
            <option value="ALL">Everyone</option>
            <option value="BOOKED">Holding a safe</option>
            <option value="FREE">No booking</option>
          </select>
        </label>
      </div>

      <AdminTable
        data={data}
        columns={columns}
        rowKey={(user) => user.id}
        loading={loading}
        emptyMessage="No users match this filter."
        onPageChange={setPage}
        rowClassName={(user) =>
          owesFee(user)
            ? 'rounded-xl border-2 border-red-300 bg-red-50 p-4 dark:border-red-800 dark:bg-red-950/30 sm:border-x-0 sm:border-t-0 sm:border-b sm:rounded-none sm:bg-red-50/60 sm:dark:bg-red-950/20'
            : undefined
        }
      />
    </div>
  );
}
