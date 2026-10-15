'use client';

import type { ReactNode } from 'react';
import type { Paginated } from '@safelock/shared';
import { Button } from '@/components/ui/Button';

/**
 * Responsive admin list shell.
 *
 * One definition of the rows renders two ways: a real `<table>` from `sm` up,
 * and a stack of cards below it. Phones get labelled key/value pairs instead
 * of a horizontally scrolling table — an admin reclaiming a safe should not
 * have to pan sideways to find the button.
 */

export interface Column<T> {
  key: string;
  header: string;
  /** Cell content for the table layout. */
  cell: (row: T) => ReactNode;
  /** Hide this column's label in the mobile card (for action columns). */
  hideLabelOnMobile?: boolean;
}

export function AdminTable<T>({
  data,
  columns,
  rowKey,
  emptyMessage,
  loading = false,
  onPageChange,
  rowClassName,
}: {
  data: Paginated<T> | null;
  columns: Array<Column<T>>;
  rowKey: (row: T) => string;
  emptyMessage: string;
  loading?: boolean;
  onPageChange: (page: number) => void;
  /** Lets a row be highlighted — used for rows needing attention. */
  rowClassName?: (row: T) => string | undefined;
}) {
  if (loading && !data) {
    return (
      <p className="py-8 text-center text-sm text-slate-600 dark:text-slate-400" role="status">
        Loading…
      </p>
    );
  }

  if (!data || data.items.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-slate-300 py-10 text-center text-sm text-slate-600 dark:border-slate-700 dark:text-slate-400">
        {emptyMessage}
      </p>
    );
  }

  return (
    <div className={loading ? 'opacity-60 transition-opacity' : undefined}>
      {/* Mobile: cards */}
      <ul className="flex flex-col gap-3 sm:hidden">
        {data.items.map((row) => (
          <li
            key={rowKey(row)}
            className={
              rowClassName?.(row) ??
              'rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900'
            }
          >
            <dl className="flex flex-col gap-2">
              {columns.map((column) => (
                <div key={column.key} className="flex flex-wrap items-center gap-2">
                  {!column.hideLabelOnMobile && (
                    <dt className="min-w-24 text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
                      {column.header}
                    </dt>
                  )}
                  <dd className="flex-1 text-sm text-slate-900 dark:text-slate-100">
                    {column.cell(row)}
                  </dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>

      {/* Desktop: table. Still scrollable if a cell runs long. */}
      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 dark:border-slate-800">
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className="px-3 py-2 text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400"
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.items.map((row) => (
              <tr
                key={rowKey(row)}
                className={
                  rowClassName?.(row) ??
                  'border-b border-slate-100 last:border-0 dark:border-slate-800/60'
                }
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className="px-3 py-3 align-middle text-slate-900 dark:text-slate-100"
                  >
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Pagination data={data} onPageChange={onPageChange} />
    </div>
  );
}

function Pagination<T>({
  data,
  onPageChange,
}: {
  data: Paginated<T>;
  onPageChange: (page: number) => void;
}) {
  if (data.totalPages <= 1) {
    return (
      <p className="mt-4 text-xs text-slate-500 dark:text-slate-400">
        {data.total} {data.total === 1 ? 'row' : 'rows'}
      </p>
    );
  }

  return (
    <nav className="mt-4 flex items-center justify-between gap-3" aria-label="Pagination">
      <Button
        variant="secondary"
        fullWidth={false}
        disabled={data.page <= 1}
        onClick={() => onPageChange(data.page - 1)}
        className="min-h-10 px-3 text-sm"
      >
        Previous
      </Button>

      <p className="text-xs text-slate-600 dark:text-slate-400" aria-live="polite">
        Page {data.page} of {data.totalPages} · {data.total} rows
      </p>

      <Button
        variant="secondary"
        fullWidth={false}
        disabled={data.page >= data.totalPages}
        onClick={() => onPageChange(data.page + 1)}
        className="min-h-10 px-3 text-sm"
      >
        Next
      </Button>
    </nav>
  );
}
