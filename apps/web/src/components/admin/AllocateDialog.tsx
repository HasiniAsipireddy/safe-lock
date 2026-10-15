'use client';

import { useEffect, useRef, useState } from 'react';
import type { AdminDeviceRow, AdminUserRow, Paginated } from '@safelock/shared';
import { api } from '@/lib/api';
import { toUserMessage } from '@/lib/apiError';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';

/**
 * Allocates a safe to a paid user.
 *
 * Two routes, deliberately distinct:
 * - **next available** → `POST /admin/allocate-next`, which picks the oldest
 *   unassigned device under a row lock. The right default: it cannot race
 *   another admin.
 * - **a specific device** → `POST /admin/devices/:id/allocate`, for when the
 *   physical unit in hand has to match the record.
 */
export function AllocateDialog({
  user,
  onClose,
  onAllocated,
}: {
  user: AdminUserRow;
  onClose: () => void;
  onAllocated: () => void;
}) {
  const toast = useToast();
  const ref = useRef<HTMLDialogElement>(null);

  const [stock, setStock] = useState<AdminDeviceRow[] | null>(null);
  const [choice, setChoice] = useState<string>('next');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        const response = await api.get<Paginated<AdminDeviceRow>>(
          '/admin/devices?status=UNASSIGNED&pageSize=100',
          { signal: controller.signal },
        );
        setStock(response.items);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        toast.error(toUserMessage(error));
        setStock([]);
      }
    })();

    return () => controller.abort();
  }, [toast]);

  async function submit() {
    if (submitting) return;
    setSubmitting(true);

    try {
      const path =
        choice === 'next' ? '/admin/allocate-next' : `/admin/devices/${choice}/allocate`;
      const result = await api.post<{ device: AdminDeviceRow }>(path, { userId: user.id });

      toast.success(`${result.device.serialNumber} allocated to ${user.name}.`);
      onAllocated();
    } catch (error) {
      toast.error(toUserMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  const noStock = stock !== null && stock.length === 0;

  return (
    <dialog
      ref={ref}
      onCancel={(event) => {
        event.preventDefault();
        if (!submitting) onClose();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-2xl border border-slate-200 bg-white p-0 text-slate-900 backdrop:bg-slate-900/50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
    >
      <div className="flex flex-col gap-4 p-5">
        <div>
          <h2 className="text-lg font-bold">Allocate a safe</h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            To {user.name} ({user.email})
          </p>
        </div>

        {stock === null ? (
          <p className="text-sm text-slate-600 dark:text-slate-400" role="status">
            Loading available safes…
          </p>
        ) : noStock ? (
          <p
            role="alert"
            className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
          >
            No safes in stock. Add devices to the inventory in the Devices tab first.
          </p>
        ) : (
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-semibold text-slate-700 dark:text-slate-300">Device</span>
            <select
              value={choice}
              onChange={(event) => setChoice(event.target.value)}
              className="min-h-12 rounded-xl border border-slate-300 bg-white px-3 text-base text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            >
              <option value="next">Next available ({stock.length} in stock)</option>
              {stock.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.serialNumber}
                </option>
              ))}
            </select>
          </label>
        )}

        <div className="flex flex-col gap-2 sm:flex-row-reverse">
          <Button
            loading={submitting}
            loadingText="Allocating…"
            disabled={noStock || stock === null}
            onClick={() => void submit()}
          >
            Allocate
          </Button>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
        </div>
      </div>
    </dialog>
  );
}
