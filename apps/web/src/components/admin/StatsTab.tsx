'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatInr, type AdminStatsDay, type AdminStatsResponse } from '@safelock/shared';
import { api } from '@/lib/api';
import { toUserMessage } from '@/lib/apiError';
import { Button } from '@/components/ui/Button';
import { DeviceStatusBadge } from '@/components/ui/Badge';
import { FormError } from '@/components/ui/FormError';
import { PAYMENT_PURPOSE_LABEL } from '@/lib/paymentLabels';

/**
 * Admin Stats: the business at a glance.
 *
 * Aggregates only — the endpoint names no user, so this tab is safe to leave
 * on a shared screen. Charts are plain SVG/CSS bars; every bar's number is
 * also printed as text, so nothing is readable only by bar length.
 */
export function StatsTab() {
  const [stats, setStats] = useState<AdminStatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setStats(await api.get<AdminStatsResponse>('/admin/stats'));
      setError(null);
    } catch (cause) {
      setError(toUserMessage(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <FormError variant="banner" message={error} />;
  if (!stats) {
    return (
      <p role="status" className="text-sm text-slate-600">
        Loading statistics…
      </p>
    );
  }

  const { totals } = stats;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-600">
          Last {stats.windowDays} days, India time. Updated{' '}
          {new Date(stats.generatedAt).toLocaleTimeString('en-IN', {
            hour: 'numeric',
            minute: '2-digit',
          })}
          .
        </p>
        <Button variant="secondary" fullWidth={false} onClick={() => void load()} loading={loading}>
          Refresh
        </Button>
      </div>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Revenue (all time)" value={formatInr(totals.revenuePaise)} accent />
        <Tile label="Live bookings" value={String(totals.liveBookings)} />
        <Tile label="Completed bookings" value={String(totals.completedBookings)} />
        <Tile label="Users" value={String(totals.users)} />
        <Tile label="Safes in service" value={String(totals.devices)} />
        <Tile label="Refunded" value={formatInr(totals.refundedPaise)} />
        <Tile
          label="Awaiting refund"
          value={String(totals.needsRefund)}
          warn={totals.needsRefund > 0}
        />
        <Tile
          label="Unlocks / failed"
          value={`${stats.activity.unlocks} / ${stats.activity.failedUnlocks}`}
        />
      </dl>

      <Panel title={`Revenue per day (last ${stats.windowDays} days)`}>
        <DayBars days={stats.perDay} />
      </Panel>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Revenue by type (all time)">
          <HorizontalBars
            rows={(['BOOKING', 'EXTENSION', 'OVERSTAY'] as const).map((purpose) => ({
              key: purpose,
              label: PAYMENT_PURPOSE_LABEL[purpose],
              value: stats.revenueByPurpose[purpose],
              text: formatInr(stats.revenueByPurpose[purpose]),
            }))}
          />
        </Panel>

        <Panel title={`Safe activity (last ${stats.windowDays} days)`}>
          <HorizontalBars
            rows={[
              { key: 'u', label: 'Unlocked', value: stats.activity.unlocks },
              { key: 'l', label: 'Locked by renter', value: stats.activity.locks },
              { key: 'a', label: 'Auto-locked', value: stats.activity.autoLocks },
              {
                key: 't',
                label: 'Tamper alerts',
                value: stats.activity.tamperAlerts,
                danger: true,
              },
              { key: 'f', label: 'Failed unlocks', value: stats.activity.failedUnlocks, danger: true },
            ].map((row) => ({ ...row, text: String(row.value) }))}
          />
        </Panel>
      </div>

      <Panel title={`How busy each safe was (last ${stats.windowDays} days)`}>
        {stats.devices.length === 0 ? (
          <p className="text-sm text-slate-600">No safes yet.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {stats.devices.map((device) => (
              <li key={device.serialNumber}>
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="flex items-center gap-2">
                    <span className="font-mono font-semibold text-slate-900">
                      {device.serialNumber}
                    </span>
                    <DeviceStatusBadge status={device.status} />
                  </span>
                  <span className="text-slate-600 tabular-nums">
                    {device.occupiedHours} h · {device.utilisationPct}%
                  </span>
                </div>
                <Bar pct={device.utilisationPct} />
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function Tile({
  label,
  value,
  accent = false,
  warn = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
  warn?: boolean;
}) {
  return (
    <div
      className={
        accent
          ? 'rounded-2xl bg-brand-700 p-4 text-white'
          : warn
            ? 'rounded-2xl border border-amber-300 bg-amber-50 p-4'
            : 'rounded-2xl border border-brand-200 bg-white p-4'
      }
    >
      <dt className={accent ? 'text-xs text-brand-100' : 'text-xs text-slate-500'}>{label}</dt>
      <dd
        className={
          accent
            ? 'mt-1 text-xl font-bold tabular-nums'
            : 'mt-1 text-xl font-bold text-slate-900 tabular-nums'
        }
      >
        {value}
      </dd>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-brand-200 bg-white p-4 sm:p-5">
      <h2 className="mb-4 text-sm font-semibold text-slate-900">{title}</h2>
      {children}
    </section>
  );
}

function Bar({ pct, danger = false }: { pct: number; danger?: boolean }) {
  return (
    <div className="mt-1 h-2.5 w-full overflow-hidden rounded-full bg-brand-50" aria-hidden="true">
      <div
        className={danger ? 'h-full rounded-full bg-red-500' : 'h-full rounded-full bg-brand-600'}
        style={{ width: `${Math.max(pct > 0 ? 2 : 0, Math.min(100, pct))}%` }}
      />
    </div>
  );
}

function HorizontalBars({
  rows,
}: {
  rows: { key: string; label: string; value: number; text: string; danger?: boolean }[];
}) {
  const max = Math.max(1, ...rows.map((row) => row.value));

  return (
    <ul className="flex flex-col gap-3">
      {rows.map((row) => (
        <li key={row.key}>
          <div className="flex justify-between text-sm">
            <span className="text-slate-700">{row.label}</span>
            <span className="font-semibold text-slate-900 tabular-nums">{row.text}</span>
          </div>
          <Bar pct={(row.value / max) * 100} danger={row.danger ?? false} />
        </li>
      ))}
    </ul>
  );
}

/** Vertical bars, one per day, with the figure in each bar's accessible label. */
function DayBars({ days }: { days: AdminStatsDay[] }) {
  const max = Math.max(1, ...days.map((day) => day.revenuePaise));
  const total = days.reduce((sum, day) => sum + day.revenuePaise, 0);
  const bookings = days.reduce((sum, day) => sum + day.bookings, 0);

  return (
    <div>
      <p className="mb-3 text-sm text-slate-600">
        {formatInr(total)} from {bookings} {bookings === 1 ? 'booking' : 'bookings'} in this
        period.
      </p>
      <ol className="flex h-40 items-end gap-1" aria-label="Revenue per day">
        {days.map((day) => {
          const label = new Date(`${day.date}T00:00:00`).toLocaleDateString('en-IN', {
            day: 'numeric',
            month: 'short',
          });
          return (
            <li
              key={day.date}
              className="group relative flex h-full flex-1 flex-col justify-end"
              aria-label={`${label}: ${formatInr(day.revenuePaise)}, ${day.bookings} bookings`}
            >
              <div
                className="w-full rounded-t-md bg-brand-600 transition-colors group-hover:bg-brand-700"
                style={{ height: `${day.revenuePaise > 0 ? Math.max(3, (day.revenuePaise / max) * 100) : 0}%` }}
                title={`${label}: ${formatInr(day.revenuePaise)} · ${day.bookings} bookings`}
              />
              <div className="h-px w-full bg-brand-200" />
            </li>
          );
        })}
      </ol>
      <div className="mt-1 flex justify-between text-[11px] text-slate-500">
        <span>{shortDate(days[0]?.date)}</span>
        <span>{shortDate(days[days.length - 1]?.date)}</span>
      </div>
    </div>
  );
}

function shortDate(date: string | undefined): string {
  if (!date) return '';
  return new Date(`${date}T00:00:00`).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
  });
}
