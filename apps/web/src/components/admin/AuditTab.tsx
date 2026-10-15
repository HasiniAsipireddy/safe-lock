'use client';

import { useCallback, useEffect, useState } from 'react';
import type { AdminAuditRow, Paginated } from '@safelock/shared';
import { api } from '@/lib/api';
import { toUserMessage } from '@/lib/apiError';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';
import { AdminTable, type Column } from './AdminTable';

/**
 * The security log.
 *
 * Metadata is rendered as formatted JSON rather than parsed into fields: the
 * shape varies per action, and an admin investigating an incident wants to see
 * exactly what was recorded, including the `requestId` that ties the row back
 * to the server logs.
 */
export function AuditTab() {
  const toast = useToast();

  const [data, setData] = useState<Paginated<AdminAuditRow> | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [action, setAction] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page) });
      if (action) params.set('action', action);

      setData(await api.get<Paginated<AdminAuditRow>>(`/admin/audit?${params.toString()}`));
    } catch (error) {
      toast.error(toUserMessage(error));
    } finally {
      setLoading(false);
    }
  }, [page, action, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setAction(search.trim());
      setPage(1);
    }, 350);
    return () => clearTimeout(timer);
  }, [search]);

  const columns: Array<Column<AdminAuditRow>> = [
    {
      key: 'when',
      header: 'When',
      cell: (entry) => (
        <span className="text-sm whitespace-nowrap">
          {new Date(entry.createdAt).toLocaleString('en-IN')}
        </span>
      ),
    },
    {
      key: 'action',
      header: 'Action',
      cell: (entry) => <span className="font-mono text-xs font-semibold">{entry.action}</span>,
    },
    {
      key: 'subject',
      header: 'Subject',
      cell: (entry) => (
        <span className="font-mono text-xs break-all text-slate-600 dark:text-slate-400">
          {entry.userId ? `user:${entry.userId}` : '—'}
          {entry.deviceId ? ` device:${entry.deviceId}` : ''}
        </span>
      ),
    },
    {
      key: 'metadata',
      header: 'Details',
      cell: (entry) =>
        entry.metadata ? (
          <pre className="max-w-xs overflow-x-auto rounded-lg bg-slate-50 p-2 text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-300">
            {JSON.stringify(entry.metadata, null, 1)}
          </pre>
        ) : (
          <span className="text-slate-400 dark:text-slate-500">—</span>
        ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="max-w-sm">
        <Input
          label="Filter by action"
          type="search"
          placeholder="device.allocated"
          hint="Partial match, e.g. “device.” or “refresh”"
          value={search}
          maxLength={100}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      <AdminTable
        data={data}
        columns={columns}
        rowKey={(entry) => entry.id}
        loading={loading}
        emptyMessage="No audit entries match this filter."
        onPageChange={setPage}
      />
    </div>
  );
}
