'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  OTP_LENGTH,
  type CommandAcceptedResponse,
  type CommandStatusResponse,
  type UnlockRequestResponse,
} from '@safelock/shared';
import { Button } from '@/components/ui/Button';
import { OtpInput } from '@/components/OtpInput';
import { api } from '@/lib/api';
import { ApiError, toUserMessage } from '@/lib/apiError';
import { awaitCommand } from '@/lib/awaitCommand';
import { USE_MOCK_API } from '@/lib/env';
import { peekMockUnlockCode } from '@/lib/mockApi';

/**
 * The unlock flow: send a code, type it in, confirm.
 *
 * Three deliberate properties:
 * - **Nothing is shown as unlocked until the safe says so.** A correct code
 *   now buys a *command*, and the dialog waits for it: the confirm returns 202
 *   with a command id, this polls it, and `onSettled` is called with the
 *   outcome the device reported. For a product that moves a physical bolt, a
 *   UI that guesses is a UI that lies.
 * - **A code that was right is never reported as wrong.** Once the confirm has
 *   been accepted the code is spent as far as this dialog is concerned, and
 *   every failure after that point is about the safe. So the entry boxes go
 *   away rather than inviting a retype — retyping a correct code cannot help,
 *   and a motor fault must not read as "you mistyped it".
 * - **Every outcome is announced.** Status and error live in `aria-live`
 *   regions, and focus moves to the code boxes when the dialog opens, so the
 *   flow is usable without sight of the screen.
 */
export function UnlockDialog({
  open,
  onClose,
  onSettled,
}: {
  open: boolean;
  onClose: () => void;
  /**
   * Called once with the settled command, whatever it says.
   *
   * Not `onUnlocked`: the dialog no longer knows whether the safe opened, and
   * pretending the callback only fires on success would mean the card never
   * hears about the outcomes that matter most.
   */
  onSettled: (command: CommandStatusResponse) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [step, setStep] = useState<'sending' | 'entry' | 'waiting'>('sending');
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

  /** Abandons a poll when the dialog closes or unmounts. */
  const pollAbort = useRef<AbortController | null>(null);

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

  // Nothing is left polling behind a closed dialog.
  useEffect(() => () => pollAbort.current?.abort(), []);

  // Resend cooldown.
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((seconds) => seconds - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  async function submit(submitted: string) {
    if (inFlight.current || submitted.length !== OTP_LENGTH) return;
    inFlight.current = true;

    pollAbort.current?.abort();
    const abort = new AbortController();
    pollAbort.current = abort;

    setPending(true);
    setError(null);
    setStatus('Checking your code…');

    try {
      const accepted = await api.post<CommandAcceptedResponse>('/devices/unlock/confirm', {
        otp: submitted,
      });

      /**
       * The code was right. Everything from here is about the safe, so the
       * code entry is finished with — see the note on this component.
       */
      setStep('waiting');
      setCode('');
      setStatus('Your code was accepted. Asking your safe to open…');

      const outcome = await awaitCommand(accepted, { signal: abort.signal });

      if (outcome.kind === 'aborted') return;

      if (outcome.kind === 'gave-up') {
        setStatus(null);
        setError('We stopped waiting for your safe to answer. Check it, then refresh the page.');
        return;
      }

      /**
       * Handed up whatever it says, and the dialog closes either way.
       *
       * The card is where the outcome belongs: it is the thing showing the
       * safe's state, and a failure reported inside a dialog the user is about
       * to dismiss is a failure they will not read. Closing on a bad outcome
       * is deliberate for the same reason — there is nothing left to do here,
       * because there is no second attempt with this code.
       */
      onSettled(outcome.command);
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

  const waiting = step === 'waiting';
  const entryDisabled = pending || expired || step !== 'entry';

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
            {waiting
              ? 'Your safe is working on it. This takes a few seconds.'
              : `We sent a ${OTP_LENGTH}-digit code. It is valid once, and only for a few minutes.`}
          </p>
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit(code);
          }}
          className="flex flex-col gap-4"
        >
          {/* Gone once the code has been accepted: there is no second attempt
              with it, so a set of boxes to retype it into would be a lie about
              what the user can still do. */}
          {waiting ? null : (
            <OtpInput
              value={code}
              onChange={setCode}
              onComplete={(complete) => void submit(complete)}
              disabled={entryDisabled}
              invalid={error !== null}
              autoFocus={step === 'entry'}
            />
          )}

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

          {devHint && !waiting && (
            <p className="rounded-lg bg-amber-100 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
              Mock mode code: <span className="font-mono font-bold">{devHint}</span>
            </p>
          )}

          <div className="flex flex-col gap-2">
            {waiting ? null : (
              <>
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
              </>
            )}

            {/*
              Dismissable while waiting, and that is the honest shape: closing
              stops the *polling*, not the command. The safe will do what it
              was asked, the result lands in the activity feed and a
              notification, and the dashboard renders the state it reported.
            */}
            <Button variant="ghost" onClick={onClose} disabled={pending && !waiting}>
              {waiting ? 'Close and check later' : 'Cancel'}
            </Button>
          </div>
        </form>
      </div>
    </dialog>
  );
}
