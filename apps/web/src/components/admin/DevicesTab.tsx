'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  BULK_CREATE_MAX_ROWS,
  SERIAL_NUMBER_HINT,
  type AdminDeviceRow,
  type BulkCreateResult,
  type DeviceStatus,
  type Paginated,
} from '@safelock/shared';
import { api } from '@/lib/api';
import { toUserMessage } from '@/lib/apiError';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { DeviceStatusBadge, LockStateBadge, OnlineBadge } from '@/components/ui/Badge';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useToast } from '@/components/ui/Toast';
import { AdminTable, type Column } from './AdminTable';

type StatusFilter = DeviceStatus | 'ALL';

interface PendingAction {
  kind: 'unassign' | 'retire';
  device: AdminDeviceRow;
}

export function DevicesTab({ onInventoryChange }: { onInventoryChange?: () => void }) {
  const toast = useToast();

  const [data, setData] = useState<Paginated<AdminDeviceRow> | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<StatusFilter>('ALL');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [acting, setActing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page) });
      if (status !== 'ALL') params.set('status', status);
      if (query) params.set('q', query);

      setData(await api.get<Paginated<AdminDeviceRow>>(`/admin/devices?${params.toString()}`));
    } catch (error) {
      toast.error(toUserMessage(error));
    } finally {
      setLoading(false);
    }
  }, [page, status, query, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  // Debounce the search so each keystroke is not a request.
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search.trim());
      setPage(1);
    }, 350);
    return () => clearTimeout(timer);
  }, [search]);

  const refresh = useCallback(() => {
    void load();
    onInventoryChange?.();
  }, [load, onInventoryChange]);

  async function runPendingAction() {
    if (!pending) return;
    setActing(true);

    try {
      await api.post(`/admin/devices/${pending.device.id}/${pending.kind}`, {});
      toast.success(
        pending.kind === 'unassign'
          ? `${pending.device.serialNumber} returned to stock.`
          : `${pending.device.serialNumber} retired.`,
      );
      setPending(null);
      refresh();
    } catch (error) {
      toast.error(toUserMessage(error));
    } finally {
      setActing(false);
    }
  }

  const columns: Array<Column<AdminDeviceRow>> = [
    {
      key: 'serial',
      header: 'Serial',
      cell: (device) => <span className="font-mono font-semibold">{device.serialNumber}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (device) => <DeviceStatusBadge status={device.status} />,
    },
    {
      key: 'owner',
      header: 'Owner',
      cell: (device) =>
        device.owner ? (
          <span>
            {device.owner.name}
            <span className="block text-xs text-slate-500 dark:text-slate-400">
              {device.owner.email}
            </span>
          </span>
        ) : (
          <span className="text-slate-400 dark:text-slate-500">—</span>
        ),
    },
    {
      key: 'state',
      header: 'Device',
      cell: (device) => (
        <span className="flex flex-wrap gap-1.5">
          <LockStateBadge state={device.lockState} />
          <OnlineBadge online={device.online} />
        </span>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      hideLabelOnMobile: true,
      cell: (device) => (
        <span className="flex flex-wrap gap-2">
          {device.status === 'ASSIGNED' && (
            <Button
              variant="secondary"
              fullWidth={false}
              className="min-h-10 px-3 text-sm"
              onClick={() => setPending({ kind: 'unassign', device })}
            >
              Unassign
            </Button>
          )}
          {device.status !== 'RETIRED' && (
            <Button
              variant="ghost"
              fullWidth={false}
              className="min-h-10 px-3 text-sm"
              onClick={() => setPending({ kind: 'retire', device })}
            >
              Retire
            </Button>
          )}
        </span>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <AddDeviceForm onCreated={refresh} />
      <BulkAddForm onCompleted={refresh} />

      <section className="flex flex-col gap-4">
        <h2 className="text-base font-bold text-slate-900 dark:text-white">Inventory</h2>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Input
              label="Search"
              type="search"
              placeholder="Serial, owner name or email"
              value={search}
              maxLength={100}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>

          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-semibold text-slate-700 dark:text-slate-300">Status</span>
            <select
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as StatusFilter);
                setPage(1);
              }}
              className="min-h-12 rounded-xl border border-slate-300 bg-white px-3 text-base text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            >
              <option value="ALL">All</option>
              <option value="UNASSIGNED">In stock</option>
              <option value="ASSIGNED">Assigned</option>
              <option value="RETIRED">Retired</option>
            </select>
          </label>
        </div>

        <AdminTable
          data={data}
          columns={columns}
          rowKey={(device) => device.id}
          loading={loading}
          emptyMessage="No devices match this filter. Add some to the inventory above."
          onPageChange={setPage}
        />
      </section>

      <ConfirmDialog
        open={pending !== null}
        title={pending?.kind === 'retire' ? 'Retire this safe?' : 'Unassign this safe?'}
        description={
          pending?.kind === 'retire'
            ? `${pending?.device.serialNumber} will be taken permanently out of service. This cannot be undone from the panel.`
            : `${pending?.device.serialNumber} will be returned to stock and ${pending?.device.owner?.name ?? 'its owner'} will lose access.`
        }
        confirmLabel={pending?.kind === 'retire' ? 'Retire safe' : 'Unassign safe'}
        destructive
        pending={acting}
        onConfirm={() => void runPendingAction()}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}

function AddDeviceForm({ onCreated }: { onCreated: () => void }) {
  const toast = useToast();
  const [serial, setSerial] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);

    try {
      await api.post('/admin/devices', { serialNumber: serial });
      toast.success(`Added ${serial.trim().toUpperCase()} to the inventory.`);
      setSerial('');
      onCreated();
    } catch (error) {
      toast.error(toUserMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
      <h2 className="text-base font-bold text-slate-900 dark:text-white">Add a device</h2>
      <form onSubmit={submit} className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <Input
            label="Serial number"
            placeholder="SAFE-0001"
            hint={SERIAL_NUMBER_HINT}
            value={serial}
            onChange={(event) => setSerial(event.target.value)}
            autoCapitalize="characters"
            spellCheck={false}
          />
        </div>
        <Button
          type="submit"
          fullWidth={false}
          loading={submitting}
          loadingText="Adding…"
          disabled={!serial.trim()}
          className="sm:w-auto"
        >
          Add
        </Button>
      </form>
    </section>
  );
}

function BulkAddForm({ onCompleted }: { onCompleted: () => void }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<BulkCreateResult | null>(null);

  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const tooMany = lines.length > BULK_CREATE_MAX_ROWS;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting || tooMany || lines.length === 0) return;
    setSubmitting(true);
    setResult(null);

    try {
      const response = await api.post<BulkCreateResult>('/admin/devices/bulk', {
        serialNumbers: lines,
      });
      setResult(response);

      if (response.created > 0) {
        toast.success(`Added ${response.created} device${response.created === 1 ? '' : 's'}.`);
      }
      if (response.created === 0) {
        toast.error('No devices were added. See the per-row results.');
      }
      onCompleted();
    } catch (error) {
      toast.error(toUserMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
      <h2 className="text-base font-bold text-slate-900 dark:text-white">Bulk add</h2>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
        One serial per line, up to {BULK_CREATE_MAX_ROWS}. Each row is reported back
        individually, so one bad line does not reject the rest.
      </p>

      <form onSubmit={submit} className="mt-3 flex flex-col gap-3">
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-semibold text-slate-700 dark:text-slate-300">Serial numbers</span>
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={6}
            spellCheck={false}
            placeholder={'SAFE-0001\nSAFE-0002\nSAFE-0003'}
            className="rounded-xl border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          />
        </label>

        <p
          className={
            tooMany
              ? 'text-sm font-semibold text-red-700 dark:text-red-400'
              : 'text-xs text-slate-500 dark:text-slate-400'
          }
          role={tooMany ? 'alert' : undefined}
        >
          {lines.length} row{lines.length === 1 ? '' : 's'}
          {tooMany && ` — too many. Remove ${lines.length - BULK_CREATE_MAX_ROWS} to continue.`}
        </p>

        <Button
          type="submit"
          loading={submitting}
          loadingText="Adding…"
          disabled={lines.length === 0 || tooMany}
        >
          Add {lines.length > 0 ? `${lines.length} ` : ''}device{lines.length === 1 ? '' : 's'}
        </Button>
      </form>

      {result && <BulkResults result={result} />}
    </section>
  );
}

function BulkResults({ result }: { result: BulkCreateResult }) {
  return (
    <div className="mt-4">
      <p className="text-sm font-semibold text-slate-900 dark:text-white">
        {result.created} added · {result.duplicates} duplicate · {result.invalid} invalid
      </p>

      <ul className="mt-2 flex max-h-64 flex-col gap-1 overflow-y-auto text-sm">
        {result.results.map((row) => (
          <li
            key={`${row.row}-${row.serialNumber}`}
            className="flex flex-wrap items-center gap-2 border-b border-slate-100 py-1 last:border-0 dark:border-slate-800/60"
          >
            <span className="w-10 shrink-0 text-xs text-slate-500 dark:text-slate-400">
              #{row.row}
            </span>
            <span className="font-mono">{row.serialNumber || '(blank)'}</span>
            <span
              className={
                row.status === 'created'
                  ? 'text-xs font-semibold text-emerald-700 dark:text-emerald-400'
                  : row.status === 'duplicate'
                    ? 'text-xs font-semibold text-amber-700 dark:text-amber-400'
                    : 'text-xs font-semibold text-red-700 dark:text-red-400'
              }
            >
              {row.status}
            </span>
            {row.message && (
              <span className="text-xs text-slate-500 dark:text-slate-400">{row.message}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
