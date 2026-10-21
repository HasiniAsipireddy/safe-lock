import {
  COMMAND_POLL_INTERVAL_MS,
  COMMAND_POLL_TIMEOUT_MS,
  isCommandSettled,
  type CommandAcceptedResponse,
  type CommandStatusResponse,
} from '@safelock/shared';
import { api } from './api';

/**
 * Waits for a command to settle, by polling.
 *
 * A lock or an unlock used to be one round trip: the mock gateway acked in
 * process, so the response carried the device in its new state. Over a radio
 * that answer does not exist yet when the request returns — so the server
 * hands back a command id and this follows it to an outcome.
 *
 * **Polled rather than pushed**, for the same reason the notification bell is:
 * the dialog is open for at most twenty seconds, and a websocket to carry
 * twenty messages is infrastructure to maintain forever.
 *
 * It does not interpret the outcome. Every caller needs a different sentence
 * and a different side effect, and `commandOutcomeCopy` is where the wording
 * lives.
 */

/** Why polling stopped. */
export type CommandWaitResult =
  /** The server reported a terminal status. The normal case. */
  | { kind: 'settled'; command: CommandStatusResponse }
  /**
   * The client gave up first.
   *
   * Should be unreachable — `COMMAND_POLL_TIMEOUT_MS` is deliberately longer
   * than the server's command TTL, and the status endpoint derives a timeout
   * from the clock rather than waiting for the sweeper, so a terminal answer
   * is always available before this. Kept because "unreachable" plus a
   * stopped laptop is reachable, and a spinner with no end is worse than an
   * honest "we do not know".
   */
  | { kind: 'gave-up' }
  /** The caller aborted — the dialog closed, or the component unmounted. */
  | { kind: 'aborted' };

export async function awaitCommand(
  accepted: CommandAcceptedResponse,
  options: { signal?: AbortSignal } = {},
): Promise<CommandWaitResult> {
  const { commandId } = accepted;

  /**
   * Nothing to wait for: the safe was already in the requested state, so no
   * command was issued. The id is null rather than pointing at nothing,
   * precisely so this is a branch and not a 404.
   */
  if (!commandId) return { kind: 'gave-up' };

  const deadline = Date.now() + COMMAND_POLL_TIMEOUT_MS;

  // The server names the first delay, because only it knows how long the
  // publish took. After that it is a fixed cadence.
  let wait = accepted.pollAfterMs;

  while (Date.now() < deadline) {
    if (options.signal?.aborted) return { kind: 'aborted' };

    await sleep(wait, options.signal);
    if (options.signal?.aborted) return { kind: 'aborted' };

    wait = COMMAND_POLL_INTERVAL_MS;

    const command = await api.get<CommandStatusResponse>(`/devices/commands/${commandId}`, {
      ...(options.signal ? { signal: options.signal } : {}),
    });

    /**
     * `settled` is the server's own answer rather than a status the client
     * matches against a list. Both are available and they agree; trusting the
     * field means a status added later stops the client waiting forever
     * instead of silently falling through to a poll loop.
     */
    if (command.settled || isCommandSettled(command.status)) {
      return { kind: 'settled', command };
    }
  }

  return { kind: 'gave-up' };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    // Resolving on abort rather than rejecting: the caller checks the signal
    // on the next line, so an aborted wait is an early return and not an
    // exception to thread through three call sites.
    function onAbort() {
      clearTimeout(timer);
      resolve();
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
