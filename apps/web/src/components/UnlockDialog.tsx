'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  OTP_LENGTH,
  type DeviceSummary,
  type UnlockConfirmResponse,
  type UnlockRequestResponse,
} from '@safelock/shared';
import { Button } from '@/components/ui/Button';
import { OtpInput } from '@/components/OtpInput';
import { api } from '@/lib/api';
import { ApiError, toUserMessage } from '@/lib/apiError';
import { USE_MOCK_API } from '@/lib/env';
import { peekMockUnlockCode } from '@/lib/mockApi';

/**
 * The unlock flow: send a code, type it in, confirm.
 *
 * Two deliberate properties:
 * - **Nothing is shown as unlocked until the server says so.** There is no
 *   optimistic state here; `onUnlocked` is called with the device the API
 *   returned. For a product that moves a physical bolt, a UI that guesses is
 *   a UI that lies.
 * - **Every outcome is announced.** Status and error live in `aria-live`
 *   regions, and focus moves to the code boxes when the dialog opens, so the
 *   flow is usable without sight of the screen.
 */
export function UnlockDialog({
  open,
  onClose,
  onUnlocked,
}: {
  open: boolean;
  onClose: () => void;
  onUnlocked: (device: DeviceSummary) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [step, setStep] = useState<'sending' | 'entry'>('sending');
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  /** Null once the code is unusable — the user must resend before retrying. */
  const [expired, setExpired] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [devHint, setDevHint] = useState<string | null>(null);

  /**
   * Guards every submit against a second one.
   *
   * A ref rather than the `pending` state: two clicks in the same React batch
   * both read the old state, and the second would get through. A ref is
   * written synchronously.
   */
  const inFlight = useRef(false);

  const sendCode = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;

    setPending(true);
    setError(null);
    setExpired(false);
    setCode('');
    setStatus('Sending a code…');

    try {
      const result = await api.post<UnlockRequestResponse>('/devices/unlock/request');
      setStep('entry');
      setCooldown(result.resendAfterSeconds);
      setStatus(`Code sent. It expires in ${Math.round(result.expiresInSeconds / 60)} minutes.`);
      setDevHint(USE_MOCK_API ? peekMockUnlockCode() : null);
    } catch (cause) {
      setStep('entry');
      setStatus(null);
      setError(toUserMessage(cause));
    } finally {
      setPending(false);
      inFlight.current = false;
    }
  }, []);

  // Opening the dialog requests the first code. Closing resets everything, so
  // a reopened dialog never shows a stale code, error or countdown.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      dialog.showModal();
      setStep('sending');
      setCode('');
      setError(null);
      setExpired(false);
      setDevHint(null);
      void sendCode();
    }

    if (!open && dialog.open) dialog.close();
  }, [open, sendCode]);

  // Resend cooldown.
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((seconds) => seconds - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  async function submit(submitted: string) {
    if (inFlight.current || submitted.length !== OTP_LENGTH) return;
    inFlight.current = true;

    setPending(true);
    setError(null);
    setStatus('Checking your code…');

    try {
      const result = await api.post<UnlockConfirmResponse>('/devices/unlock/confirm', {
        otp: submitted,
      });
      setStatus('Unlocked.');
      onUnlocked(result.device);
      onClose();
    } catch (cause) {
      setCode('');
      setStatus(null);
      setError(toUserMessage(cause));

      // These three mean the challenge is gone, not that the digits were
      // mistyped — retyping cannot help, so the entry boxes are disabled and
      // Resend becomes the only way forward.
      const dead =
        cause instanceof ApiError &&
        ['OTP_EXPIRED', 'OTP_TOO_MANY_ATTEMPTS', 'OTP_NOT_FOUND'].includes(cause.code);
      if (dead) {
        setExpired(true);
        setCooldown(0);
      }
    } finally {
      setPending(false);
      inFlight.current = false;
    }
  }

  const entryDisabled = pending || expired || step === 'sending';

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="unlock-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onClose();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-2xl border border-slate-200 bg-white p-0 text-slate-900 backdrop:bg-slate-900/50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
    >
      <div className="flex flex-col gap-4 p-5">
        <div>
          <h2 id="unlock-dialog-title" className="text-lg font-bold">
            Enter your unlock code
          </h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            We sent a {OTP_LENGTH}-digit code. It is valid once, and only for a few minutes.
          </p>
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit(code);
          }}
          className="flex flex-col gap-4"
        >
          <OtpInput
            value={code}
            onChange={setCode}
            onComplete={(complete) => void submit(complete)}
            disabled={entryDisabled}
            invalid={error !== null}
            autoFocus={step === 'entry'}
          />

          {/* Polite: the countdown and "code sent" should not interrupt. */}
          <p role="status" aria-live="polite" className="min-h-5 text-sm text-slate-600 dark:text-slate-400">
            {status}
          </p>

          {/* Assertive: a failed unlock attempt must be announced at once. */}
          <p
            role="alert"
            aria-live="assertive"
            className="min-h-5 text-sm font-medium text-red-700 dark:text-red-300"
          >
            {error}
          </p>

          {devHint && (
            <p className="rounded-lg bg-amber-100 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
              Mock mode code: <span className="font-mono font-bold">{devHint}</span>
            </p>
          )}

          <div className="flex flex-col gap-2">
            <Button
              type="submit"
              loading={pending}
              loadingText="Checking…"
              disabled={entryDisabled || code.length !== OTP_LENGTH}
            >
              Unlock safe
            </Button>

            <Button
              variant="secondary"
              onClick={() => void sendCode()}
              disabled={pending || cooldown > 0}
            >
              {cooldown > 0 ? `Resend code in ${cooldown}s` : 'Resend code'}
            </Button>

            <Button variant="ghost" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
          </div>
        </form>
      </div>
    </dialog>
  );
}
