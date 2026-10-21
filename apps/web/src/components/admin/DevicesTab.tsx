'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ADMIN_COMMAND_HISTORY_LIMIT,
  BULK_CREATE_MAX_ROWS,
  DEVICE_FLAG_COPY,
  SERIAL_NUMBER_HINT,
  type AdminCommandRow,
  type AdminDeviceRow,
  type BulkCreateResult,
  type DeviceCredentialResponse,
  type DeviceStatus,
  type Paginated,
} from '@safelock/shared';
import { api } from '@/lib/api';
import { toUserMessage } from '@/lib/apiError';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import {
  BookingStatusBadge,
  DeviceStatusBadge,
  LockStateBadge,
  OnlineBadge,
} from '@/components/ui/Badge';
import { formatShortDateTime } from '@/lib/datetime';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useToast } from '@/components/ui/Toast';
import { AdminTable, type Column } from './AdminTable';

type StatusFilter = DeviceStatus | 'ALL';

/**
 * The three actions a safe has.
 *
 * Unassign is gone with allocation. What replaced it is `clear-inspection`,
 * which is the opposite kind of action: not "take this away from someone" but
 * "a human has looked inside and it is fit to rent again". `credential` joined
 * them with the hardware: a unit cannot speak until it has been given an
 * identity, and that identity is readable exactly once.
 */
interface PendingAction {
  kind: 'clear-inspection' | 'retire' | 'credential';
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
  const [note, setNote] = useState('');

  /**
   * Shows only the rows that need a human, like the Bookings tab's flagged
   * filter — and with the same honest caveat, for the same reason: the flags
   * are derived per row against the clock, so this filters **the page you are
   * looking at** rather than the fleet. A count that claimed otherwise would
   * be a number nobody could reconcile.
   */
  const [attentionOnly, setAttentionOnly] = useState(false);

  /**
   * The credential, held in state for exactly as long as the dialog is open.
   *
   * Never written anywhere else — not sessionStorage, not a URL, not a toast
   * that outlives the dialog. It is shown once by the API and this is the
   * client's half of that promise.
   */
  const [credential, setCredential] = useState<DeviceCredentialResponse | null>(null);

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
      // The note is required for clear-inspection, and is the record that a
      // human looked inside. The other two take no body.
      const result = await api.post<unknown>(
        `/admin/devices/${pending.device.id}/${pending.kind}`,
        pending.kind === 'clear-inspection' ? { note: note.trim() } : {},
      );

      /**
       * A credential is the one action whose *result* matters to the person
       * who asked for it, so the confirmation is replaced by a panel holding
       * it rather than a toast saying it worked. There is no second chance to
       * read it.
       */
      if (pending.kind === 'credential') {
        setCredential(result as DeviceCredentialResponse);
      } else {
        toast.success(
          pending.kind === 'clear-inspection'
            ? `${pending.device.serialNumber} returned to the pool.`
            : `${pending.device.serialNumber} retired.`,
        );
      }

      setPending(null);
      setNote('');
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
      cell: (device) => (
        <span className="flex flex-col gap-1">
          <DeviceStatusBadge status={device.status} />
          {/* Why it needs inspecting, so an admin knows what to look for
              before opening it. */}
          {device.status === 'NEEDS_INSPECTION' && device.inspectionNote ? (
            <span className="text-xs text-amber-700 dark:text-amber-300">
              {device.inspectionNote}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: 'booking',
      header: 'Rented by',
      cell: (device) =>
        device.currentBooking ? (
          <span>
            {device.currentBooking.user.name}
            <span className="block text-xs text-slate-500 dark:text-slate-400">
              {device.currentBooking.user.email}
            </span>
            <span className="mt-1 block">
              <BookingStatusBadge status={device.currentBooking.effectiveStatus} />
            </span>
            {device.currentBooking.endsAt ? (
              <span className="block text-xs text-slate-500 dark:text-slate-400">
                until {formatShortDateTime(device.currentBooking.endsAt)}
              </span>
            ) : null}
          </span>
        ) : (
          <span className="text-slate-400 dark:text-slate-500">Free</span>
        ),
    },
    {
      key: 'state',
      header: 'Device',
      cell: (device) => (
        <span className="flex flex-col gap-1.5">
          <span className="flex flex-wrap gap-1.5">
            <LockStateBadge state={device.lockState} />
            <OnlineBadge online={device.online} />
          </span>
          <DeviceHealth device={device} />
        </span>
      ),
    },
    {
      key: 'attention',
      header: 'Needs attention',
      cell: (device) =>
        device.flags.length === 0 ? (
          <span className="text-slate-400 dark:text-slate-500">—</span>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {device.flags.map((flag) => (
              <li key={flag}>
                <span className="block text-xs font-bold text-amber-800 dark:text-amber-200">
                  {DEVICE_FLAG_COPY[flag].label}
                </span>
                <span className="block text-xs text-slate-600 dark:text-slate-400">
                  {DEVICE_FLAG_COPY[flag].action}
                </span>
              </li>
            ))}
          </ul>
        ),
    },
    {
      key: 'commands',
      header: 'Recent commands',
      cell: (device) => <CommandsExpander device={device} />,
    },
    {
      key: 'actions',
      header: 'Actions',
      hideLabelOnMobile: true,
      cell: (device) => (
        <span className="flex flex-wrap gap-2">
          {device.status === 'NEEDS_INSPECTION' && (
            <Button
              variant="secondary"
              fullWidth={false}
              className="min-h-10 px-3 text-sm"
              onClick={() => {
                setNote('');
                setPending({ kind: 'clear-inspection', device });
              }}
            >
              Clear inspection
            </Button>
          )}
          {/*
            Allowed for NEEDS_INSPECTION as well as AVAILABLE, and refused for
            RETIRED — matching the API, which revoked that unit's credential on
            purpose. A safe awaiting inspection is the one most likely to need
            re-provisioning in the field.
          */}
          {device.status !== 'RETIRED' && (
            <Button
              variant="secondary"
              fullWidth={false}
              className="min-h-10 px-3 text-sm"
              onClick={() => setPending({ kind: 'credential', device })}
            >
              {device.credentialIssued ? 'Re-issue credential' : 'Issue credential'}
            </Button>
          )}
          {device.status !== 'RETIRED' && !device.currentBooking && (
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

  /**
   * Filtered after the fetch, which is what makes the caveat above true: the
   * `total` the pager shows still counts the unfiltered set, exactly as the
   * Bookings tab's flagged filter does.
   */
  const visible =
    data && attentionOnly
      ? { ...data, items: data.items.filter((device) => device.flags.length > 0) }
      : data;

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
              placeholder="Serial number"
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
              <option value="AVAILABLE">In pool</option>
              <option value="NEEDS_INSPECTION">Needs inspection</option>
              <option value="RETIRED">Retired</option>
            </select>
          </label>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={attentionOnly}
            onChange={(event) => setAttentionOnly(event.target.checked)}
            className="size-5 rounded border-slate-300 dark:border-slate-700"
          />
          <span className="text-slate-700 dark:text-slate-300">
            Only safes needing attention{' '}
            <span className="text-slate-500 dark:text-slate-400">(filters this page)</span>
          </span>
        </label>

        <AdminTable
          data={visible}
          columns={columns}
          rowKey={(device) => device.id}
          loading={loading}
          emptyMessage={
            attentionOnly
              ? 'Nothing on this page needs attention.'
              : 'No devices match this filter. Add some to the inventory above.'
          }
          onPageChange={setPage}
        />
      </section>

      <ConfirmDialog
        open={pending !== null}
        title={PENDING_TITLE[pending?.kind ?? 'retire']}
        description={describePending(pending)}
        confirmLabel={PENDING_CONFIRM[pending?.kind ?? 'retire']}
        destructive
        pending={acting}
        confirmDisabled={pending?.kind === 'clear-inspection' && note.trim().length < 3}
        onConfirm={() => void runPendingAction()}
        onCancel={() => {
          setPending(null);
          setNote('');
        }}
      >
        {/*
          A required note, not an optional one. It is the only record that a
          human actually looked, and it is audited.
        */}
        {pending?.kind === 'clear-inspection' ? (
          <Input
            label="What did you find?"
            hint="Recorded in the audit log. At least 3 characters."
            value={note}
            maxLength={500}
            onChange={(event) => setNote(event.target.value)}
          />
        ) : null}
      </ConfirmDialog>

      <CredentialPanel credential={credential} onClose={() => setCredential(null)} />
    </div>
  );
}

const PENDING_TITLE: Record<PendingAction['kind'], string> = {
  retire: 'Retire this safe?',
  'clear-inspection': 'Return this safe to the pool?',
  credential: 'Issue a new credential?',
};

const PENDING_CONFIRM: Record<PendingAction['kind'], string> = {
  retire: 'Retire safe',
  'clear-inspection': 'Return to pool',
  credential: 'Issue credential',
};

function describePending(pending: PendingAction | null): string {
  if (!pending) return '';

  const serial = pending.device.serialNumber;

  if (pending.kind === 'retire') {
    return `${serial} will be taken permanently out of service and its credential revoked. This cannot be undone from the panel.`;
  }

  if (pending.kind === 'clear-inspection') {
    return `Only do this once you have opened ${serial} and confirmed it is empty. The next renter will be able to unlock whatever is inside.`;
  }

  /**
   * The re-issue warning, which is the only reason this dialog exists.
   *
   * Issuing for the first time is harmless. Re-issuing **revokes the password
   * the unit is currently using**, so a safe in the field that is not then
   * re-provisioned goes silent — and silent means unbookable and unopenable
   * remotely. That has to be said before the button, not after.
   */
  return pending.device.credentialIssued
    ? `${serial} already has a credential. Issuing a new one revokes the old password, so the unit will go offline until it is re-provisioned in the field. Only do this if you are holding it.`
    : `${serial} will be given its broker password and command key. They are shown once and cannot be read again.`;
}

/**
 * The hardware's own account of itself. Diagnostics, never authority.
 *
 * `rssi` is here because a metal safe is a Faraday cage and the most likely
 * field failure is a unit on the edge of range — a number in a list is an
 * order of magnitude cheaper to act on than a site visit. `clockSynced` gates
 * nothing and is shown anyway, so a fleet-wide SNTP problem is visible rather
 * than inferred.
 */
function DeviceHealth({ device }: { device: AdminDeviceRow }) {
  return (
    <span className="flex flex-col text-xs text-slate-600 dark:text-slate-400">
      <span>
        {device.lastSeenAt ? `Last seen ${formatShortDateTime(device.lastSeenAt)}` : 'Never seen'}
      </span>
      <span>
        {device.firmwareVersion ? `fw ${device.firmwareVersion}` : 'fw unknown'}
        {device.rssi === null ? '' : ` · ${device.rssi} dBm`}
        {device.clockSynced === false ? ' · clock not synced' : ''}
      </span>
      <span>
        {device.credentialIssued
          ? `Provisioned ${device.credentialIssuedAt ? formatShortDateTime(device.credentialIssuedAt) : ''}`
          : 'Not provisioned'}
      </span>
    </span>
  );
}

/**
 * The last few commands, fetched when the row is opened.
 *
 * Lazily, because a fleet page would otherwise be twenty extra requests for
 * lists nobody expanded — and a `<details>` element rather than a bespoke
 * disclosure, so the keyboard and screen-reader behaviour is the platform's
 * and not ours to get wrong.
 */
function CommandsExpander({ device }: { device: AdminDeviceRow }) {
  const [commands, setCommands] = useState<AdminCommandRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (commands || loading) return;
    setLoading(true);

    try {
      const result = await api.get<{ items: AdminCommandRow[] }>(
        `/admin/devices/${device.id}/commands`,
      );
      setCommands(result.items);
    } catch (cause) {
      setError(toUserMessage(cause));
    } finally {
      setLoading(false);
    }
  }

  return (
    <details
      className="text-xs"
      onToggle={(event) => {
        if (event.currentTarget.open) void load();
      }}
    >
      <summary className="cursor-pointer py-1 font-semibold text-slate-700 dark:text-slate-300">
        Last {ADMIN_COMMAND_HISTORY_LIMIT}
      </summary>

      {loading ? <p className="py-1 text-slate-500">Loading…</p> : null}
      {error ? <p className="py-1 text-red-700 dark:text-red-300">{error}</p> : null}

      {commands && commands.length === 0 ? (
        <p className="py-1 text-slate-500 dark:text-slate-400">
          This safe has never been sent a command.
        </p>
      ) : null}

      {commands && commands.length > 0 ? (
        <ul className="flex flex-col gap-1 py-1">
          {commands.map((command) => (
            <li key={command.id} className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-semibold text-slate-800 dark:text-slate-200">
                {command.type}
              </span>
              <span className="text-slate-700 dark:text-slate-300">{command.status}</span>
              {command.failureCategory ? (
                <span className="text-red-700 dark:text-red-300">
                  {command.failureCategory}
                </span>
              ) : null}
              <span className="text-slate-500 dark:text-slate-400">
                {command.actor === 'USER' ? 'by the renter' : `by ${command.actor.toLowerCase()}`}
              </span>
              <span className="text-slate-500 dark:text-slate-400">
                {command.latencyMs === null ? 'no ack' : `${command.latencyMs} ms`}
              </span>
              {/* A late ack is worth marking: the row says ACKED and the user
                  was told it failed, and that is not a contradiction. */}
              {command.lateAcked ? (
                <span className="text-amber-700 dark:text-amber-300">late</span>
              ) : null}
              <span className="text-slate-400 dark:text-slate-500">
                {formatShortDateTime(command.issuedAt)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </details>
  );
}

/**
 * A credential, shown once.
 *
 * Not a toast and not a row in the table: it has to be *read and transcribed*
 * before it is dismissed, and nothing in the app can show it again. The
 * wording says so plainly rather than hinting, because the recovery from
 * dismissing it too early is re-issuing — which takes the unit offline until
 * somebody walks to it.
 */
function CredentialPanel({
  credential,
  onClose,
}: {
  credential: DeviceCredentialResponse | null;
  onClose: () => void;
}) {
  if (!credential) return null;

  return (
    <section
      role="alertdialog"
      aria-labelledby="credential-title"
      className="rounded-2xl border-2 border-amber-400 bg-amber-50 p-5 dark:border-amber-600 dark:bg-amber-950"
    >
      <h3 id="credential-title" className="text-base font-bold text-amber-900 dark:text-amber-100">
        {credential.serialNumber} — provisioning details, shown once
      </h3>
      <p className="mt-1 text-sm text-amber-900 dark:text-amber-200">
        Copy these into the installer now. They cannot be read again, and issuing another
        credential takes this unit offline until it is re-provisioned.
        {credential.reissued
          ? ' This replaced an existing credential: the old password has stopped working.'
          : ''}
      </p>

      <dl className="mt-4 flex flex-col gap-3 text-sm">
        <div>
          <dt className="font-semibold text-amber-900 dark:text-amber-200">
            MQTT username and client id
          </dt>
          <dd className="font-mono break-all text-amber-950 dark:text-amber-50">
            {credential.serialNumber}
          </dd>
        </div>
        <div>
          <dt className="font-semibold text-amber-900 dark:text-amber-200">MQTT password</dt>
          <dd className="font-mono break-all text-amber-950 dark:text-amber-50">
            {credential.password}
          </dd>
        </div>
        <div>
          <dt className="font-semibold text-amber-900 dark:text-amber-200">
            Command key (K_d), key version {credential.keyVersion}
          </dt>
          <dd className="font-mono break-all text-amber-950 dark:text-amber-50">
            {credential.commandKey}
          </dd>
        </div>
      </dl>

      <div className="mt-4">
        <Button variant="secondary" fullWidth={false} onClick={onClose}>
          I have copied these
        </Button>
      </div>
    </section>
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
