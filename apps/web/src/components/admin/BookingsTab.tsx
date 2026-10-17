'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  formatInr,
  type AdminBookingRow,
  type BookingStatus,
  type Paginated,
} from '@safelock/shared';
import { api } from '@/lib/api';
import { toUserMessage } from '@/lib/apiError';
import { Badge, BookingStatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';
import { formatShortDateTime } from '@/lib/datetime';
import { AdminTable, type Column } from './AdminTable';

/**
 * The admin Bookings tab.
 *
 * **"Needs a human" is the default view**, not "all bookings", because two
 * situations will otherwise sit unnoticed forever:
 *
 * - an **unpaid overstay**, which the sweeper deliberately never completes:
 *   the fee is capped, the safe stays reserved, and nothing automatic will
 *   ever release it — because quietly handing the next renter a safe that may
 *   still hold somebody's belongings is the one outcome worth avoiding at any
 *   cost;
 * - a booking whose safe came back with unknown contents and is sitting in
 *   `NEEDS_INSPECTION`.
 *
 * Both are computed from the clock server-side, so the list is right even when
 * the sweeper is behind.
 */
type View = 'FLAGGED' | 'ALL';

interface Pending {
  kind: 'force-complete' | 'waive-overstay';
  booking: AdminBookingRow;
}

export function BookingsTab({ onChanged }: { onChanged?: () => void }) {
  const toast = useToast();

  const [data, setData] = useState<Paginated<AdminBookingRow> | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [view, setView] = useState<View>('FLAGGED');
  const [status, setStatus] = useState<BookingStatus | 'ALL'>('ALL');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');

  const [pending, setPending] = useState<Pending | null>(null);
  const [reason, setReason] = useState('');
  /**
   * Defaults to **true**, matching the API.
   *
   * Defaulting the other way would release a possibly-occupied safe on a
   * careless click. Unticking it is an admin saying "I have looked inside",
   * and it is recorded as such.
   */
  const [needsInspection, setNeedsInspection] = useState(true);
  const [acting, setActing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page) });
      if (view === 'FLAGGED') params.set('flagged', 'true');
      if (status !== 'ALL') params.set('status', status);
      if (query) params.set('q', query);

      setData(await api.get<Paginated<AdminBookingRow>>(`/admin/bookings?${params.toString()}`));
    } catch (error) {
      toast.error(toUserMessage(error));
    } finally {
      setLoading(false);
    }
  }, [page, view, status, query, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search.trim());
      setPage(1);
    }, 350);
    return () => clearTimeout(timer);
  }, [search]);

  async function runAction() {
    if (!pending) return;
    setActing(true);

    try {
      const body =
        pending.kind === 'force-complete'
          ? { reason: reason.trim(), needsInspection }
          : { reason: reason.trim() };

      await api.post(`/admin/bookings/${pending.booking.id}/${pending.kind}`, body);

      toast.success(
        pending.kind === 'force-complete'
          ? needsInspection
            ? `Booking ended. ${pending.booking.serialNumber} is held for inspection.`
            : `Booking ended. ${pending.booking.serialNumber} returned to the pool.`
          : 'Overstay fee waived.',
      );

      setPending(null);
      setReason('');
      setNeedsInspection(true);
      void load();
      onChanged?.();
    } catch (error) {
      toast.error(toUserMessage(error));
    } finally {
      setActing(false);
    }
  }

  const isLive = (booking: AdminBookingRow): boolean =>
    booking.status === 'PENDING_PAYMENT' ||
    booking.status === 'ACTIVE' ||
    booking.status === 'OVERSTAY';

  const columns: Array<Column<AdminBookingRow>> = [
    {
      key: 'user',
      header: 'Renter',
      cell: (booking) => (
        <span>
          <span className="font-semibold">{booking.user.name}</span>
          <span className="block text-xs text-slate-500 dark:text-slate-400">
            {booking.user.email}
          </span>
          <span className="mt-1 block font-mono text-sm">{booking.serialNumber}</span>
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (booking) => (
        <span className="flex flex-col gap-1">
          {/* The effective status, never the stored one: a lapsed hold shown
              as "awaiting payment" would be an admin chasing a ghost. */}
          <BookingStatusBadge status={booking.effectiveStatus} />
          {booking.flagged ? <Badge tone="danger">Needs attention</Badge> : null}
          {/*
            A message this renter should have had and did not — a spent send
            budget, or one claimed too late to still be true. Shown next to the
            booking rather than in a log of its own, because the admin's
            question is "is anything wrong here?", and a renter who was never
            warned about a fee is about to dispute it.
          */}
          {booking.undeliveredMessages > 0 ? (
            <span className="text-xs font-semibold text-amber-700 dark:text-amber-300">
              {booking.undeliveredMessages} message
              {booking.undeliveredMessages === 1 ? '' : 's'} not delivered
            </span>
          ) : null}
          {booking.completionReason ? (
            <span className="text-xs text-slate-500 dark:text-slate-400">
              {booking.completionReason.toLowerCase().replace(/_/g, ' ')}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: 'window',
      header: 'Window',
      cell: (booking) => (
        <span className="text-sm">
          {formatShortDateTime(booking.startsAt)}
          <span className="block text-xs text-slate-500 dark:text-slate-400">
            {booking.endsAt ? `to ${formatShortDateTime(booking.endsAt)}` : 'not started'} ·{' '}
            {booking.hours}h
          </span>
        </span>
      ),
    },
    {
      key: 'money',
      header: 'Money',
      cell: (booking) => (
        <span className="text-sm">
          {formatInr(booking.pricePaise)}
          {booking.overstayFeePaise > 0 ? (
            <span className="block text-xs font-semibold text-red-700 dark:text-red-300">
              + {formatInr(booking.overstayFeePaise)} overstay due
            </span>
          ) : booking.overstaySettledAt ? (
            <span className="block text-xs text-slate-500 dark:text-slate-400">
              overstay settled
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      hideLabelOnMobile: true,
      cell: (booking) => (
        <span className="flex flex-wrap gap-2">
          {booking.overstayFeePaise > 0 && (
            <Button
              variant="secondary"
              fullWidth={false}
              className="min-h-10 px-3 text-sm"
              onClick={() => {
                setReason('');
                setPending({ kind: 'waive-overstay', booking });
              }}
            >
              Waive fee
            </Button>
          )}
          {isLive(booking) && (
            <Button
              variant="ghost"
              fullWidth={false}
              className="min-h-10 px-3 text-sm"
              onClick={() => {
                setReason('');
                setNeedsInspection(true);
                setPending({ kind: 'force-complete', booking });
              }}
            >
              Force complete
            </Button>
          )}
          {!isLive(booking) && booking.overstayFeePaise === 0 && (
            <span className="text-slate-400 dark:text-slate-500">—</span>
          )}
        </span>
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
            placeholder="Serial, renter name or email"
            value={search}
            maxLength={100}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>

        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-semibold text-slate-700 dark:text-slate-300">Show</span>
          <select
            value={view}
            onChange={(event) => {
              setView(event.target.value as View);
              setPage(1);
            }}
            className="min-h-12 rounded-xl border border-slate-300 bg-white px-3 text-base text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          >
            <option value="FLAGGED">Needs attention</option>
            <option value="ALL">All bookings</option>
          </select>
        </label>

        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-semibold text-slate-700 dark:text-slate-300">Status</span>
          <select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as BookingStatus | 'ALL');
              setPage(1);
            }}
            className="min-h-12 rounded-xl border border-slate-300 bg-white px-3 text-base text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          >
            <option value="ALL">Any</option>
            <option value="PENDING_PAYMENT">Awaiting payment</option>
            <option value="ACTIVE">Running</option>
            <option value="OVERSTAY">Overstaying</option>
            <option value="COMPLETED">Completed</option>
            <option value="CANCELLED">Cancelled</option>
            <option value="EXPIRED_UNPAID">Hold expired</option>
          </select>
        </label>
      </div>

      {view === 'FLAGGED' ? (
        <p className="text-sm text-slate-600 dark:text-slate-400">
          Bookings with an unpaid overstay fee, or whose safe is waiting on a staff check.
          Nothing clears these automatically — an unpaid overstay is left alone on purpose, so
          that a safe which may still hold someone&rsquo;s belongings is never released without a
          person deciding to.
        </p>
      ) : null}

      <AdminTable
        data={data}
        columns={columns}
        rowKey={(booking) => booking.id}
        loading={loading}
        emptyMessage={
          view === 'FLAGGED'
            ? 'Nothing needs attention. Every booking is paid up and every safe has been checked.'
            : 'No bookings match this filter.'
        }
        onPageChange={setPage}
        rowClassName={(booking) =>
          booking.flagged
            ? 'rounded-xl border-2 border-red-300 bg-red-50 p-4 dark:border-red-800 dark:bg-red-950/30 sm:border-x-0 sm:border-t-0 sm:border-b sm:rounded-none sm:bg-red-50/60 sm:dark:bg-red-950/20'
            : undefined
        }
      />

      <ConfirmDialog
        open={pending !== null}
        title={
          pending?.kind === 'waive-overstay' ? 'Waive this overstay fee?' : 'End this booking?'
        }
        description={
          pending?.kind === 'waive-overstay'
            ? `${pending ? formatInr(pending.booking.overstayFeePaise) : ''} will be written off. The renter can then unlock and collect, and nothing is recorded as collected.`
            : `This ends ${pending?.booking.user.name}'s booking of ${pending?.booking.serialNumber} immediately. They will not be able to unlock it again.`
        }
        confirmLabel={pending?.kind === 'waive-overstay' ? 'Waive the fee' : 'End the booking'}
        destructive
        pending={acting}
        confirmDisabled={reason.trim().length < 3}
        onConfirm={() => void runAction()}
        onCancel={() => {
          setPending(null);
          setReason('');
          setNeedsInspection(true);
        }}
      >
        <div className="flex flex-col gap-3">
          <Input
            label="Why?"
            hint="Required, and recorded in the audit log. At least 3 characters."
            value={reason}
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
          />

          {pending?.kind === 'force-complete' ? (
            <label className="flex items-start gap-3 rounded-xl bg-slate-50 p-3 text-sm dark:bg-slate-800/50">
              <input
                type="checkbox"
                checked={needsInspection}
                onChange={(event) => setNeedsInspection(event.target.checked)}
                className="mt-0.5 size-5 shrink-0 rounded border-slate-400"
              />
              <span className="text-slate-700 dark:text-slate-300">
                <strong className="block text-slate-900 dark:text-white">
                  Hold this safe for a staff check
                </strong>
                Leave this on unless you have opened the safe yourself and know it is empty. The
                next renter would be able to unlock whatever is inside.
              </span>
            </label>
          ) : null}
        </div>
      </ConfirmDialog>
    </div>
  );
}
