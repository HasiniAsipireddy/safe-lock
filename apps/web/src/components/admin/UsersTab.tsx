'use client';

import { useCallback, useEffect, useState } from 'react';
import type { AdminDeviceRow, AdminUserRow, Paginated } from '@safelock/shared';
import { api } from '@/lib/api';
import { toUserMessage } from '@/lib/apiError';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';
import { AdminTable, type Column } from './AdminTable';
import { AllocateDialog } from './AllocateDialog';

type Filter = 'ALL' | 'AWAITING' | 'ALLOCATED' | 'UNPAID';

const FILTER_PARAMS: Record<Filter, Record<string, string>> = {
  ALL: {},
  // The admin's actual work queue.
  AWAITING: { paid: 'true', allocated: 'false' },
  ALLOCATED: { allocated: 'true' },
  UNPAID: { paid: 'false' },
};

export function UsersTab({ refreshKey }: { refreshKey?: number }) {
  const toast = useToast();

  const [data, setData] = useState<Paginated<AdminUserRow> | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState<Filter>('ALL');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [allocating, setAllocating] = useState<AdminUserRow | null>(null);
  const [unassigning, setUnassigning] = useState<string | null>(null);

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

  /**
   * Reclaiming hardware from a refunded user.
   *
   * Reachable straight from the row, because the alternative is hunting for
   * the serial in the Devices tab.
   */
  async function reclaim(user: AdminUserRow) {
    if (!user.deviceSerial) return;
    setUnassigning(user.id);

    try {
      // Resolve the serial to a device id through the inventory list.
      const matches = await api.get<Paginated<AdminDeviceRow>>(
        `/admin/devices?q=${encodeURIComponent(user.deviceSerial)}&status=ASSIGNED`,
      );
      const device = matches.items.find((row) => row.serialNumber === user.deviceSerial);

      if (!device) {
        toast.error(`Could not find ${user.deviceSerial} in the inventory.`);
        return;
      }

      await api.post(`/admin/devices/${device.id}/unassign`, {});
      toast.success(`${user.deviceSerial} returned to stock.`);
      void load();
    } catch (error) {
      toast.error(toUserMessage(error));
    } finally {
      setUnassigning(null);
    }
  }

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
          <span className="block text-xs text-slate-500 dark:text-slate-400">{user.phone}</span>
        </span>
      ),
    },
    {
      key: 'state',
      header: 'State',
      cell: (user) => {
        if (user.refundedWithDevice) {
          return <Badge tone="danger">Refunded — device still assigned</Badge>;
        }
        if (!user.hasPaid) return <Badge tone="neutral">Not paid</Badge>;
        if (!user.deviceSerial) return <Badge tone="warning">Awaiting allocation</Badge>;
        return <Badge tone="positive">Allocated</Badge>;
      },
    },
    {
      key: 'device',
      header: 'Device',
      cell: (user) =>
        user.deviceSerial ? (
          <span className="font-mono text-sm">{user.deviceSerial}</span>
        ) : (
          <span className="text-slate-400 dark:text-slate-500">—</span>
        ),
    },
    {
      key: 'actions',
      header: 'Actions',
      hideLabelOnMobile: true,
      cell: (user) => {
        if (user.refundedWithDevice) {
          return (
            <Button
              variant="secondary"
              fullWidth={false}
              className="min-h-10 px-3 text-sm"
              loading={unassigning === user.id}
              loadingText="Working…"
              onClick={() => void reclaim(user)}
            >
              Unassign
            </Button>
          );
        }

        if (user.hasPaid && !user.deviceSerial) {
          return (
            <Button
              fullWidth={false}
              className="min-h-10 px-3 text-sm"
              onClick={() => setAllocating(user)}
            >
              Allocate
            </Button>
          );
        }

        return <span className="text-slate-400 dark:text-slate-500">—</span>;
      },
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
            <option value="AWAITING">Awaiting allocation</option>
            <option value="ALLOCATED">Has a device</option>
            <option value="UNPAID">Not paid</option>
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
          user.refundedWithDevice
            ? 'rounded-xl border-2 border-red-300 bg-red-50 p-4 dark:border-red-800 dark:bg-red-950/30 sm:border-x-0 sm:border-t-0 sm:border-b sm:rounded-none sm:bg-red-50/60 sm:dark:bg-red-950/20'
            : undefined
        }
      />

      {allocating && (
        <AllocateDialog
          user={allocating}
          onClose={() => setAllocating(null)}
          onAllocated={() => {
            setAllocating(null);
            void load();
          }}
        />
      )}
    </div>
  );
}
