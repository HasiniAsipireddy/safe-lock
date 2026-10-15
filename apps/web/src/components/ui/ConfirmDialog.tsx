'use client';

import { useEffect, useRef } from 'react';
import { Button } from './Button';

/**
 * Confirmation dialog for destructive admin actions.
 *
 * Uses the native `<dialog>` element so focus trapping, Escape handling and
 * the backdrop come from the platform rather than from hand-written key
 * listeners.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  destructive = false,
  pending = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      // Escape fires `cancel`; route it through the same handler so state stays
      // in step with whether the dialog is actually showing.
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onCancel();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-2xl border border-slate-200 bg-white p-0 text-slate-900 backdrop:bg-slate-900/50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
    >
      <div className="flex flex-col gap-4 p-5">
        <div>
          <h2 className="text-lg font-bold">{title}</h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{description}</p>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row-reverse">
          <Button
            variant={destructive ? 'primary' : 'primary'}
            loading={pending}
            loadingText="Working…"
            onClick={onConfirm}
            className={
              destructive
                ? 'bg-red-600 hover:bg-red-700 active:bg-red-800 dark:bg-red-600 dark:hover:bg-red-500'
                : undefined
            }
          >
            {confirmLabel}
          </Button>
          <Button variant="secondary" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
        </div>
      </div>
    </dialog>
  );
}
