import { env } from '../../config/env';
import { logger } from '../logger';
import { processPending } from './outbox.service';

/**
 * The outbox poll loop.
 *
 * Started from `server.ts` only — **never** from `createApp()`. A worker that
 * started with the app would tick during the test suite, racing every
 * assertion about outbox state and sending on a timer nobody asked for. Tests
 * call {@link processPending} directly instead.
 *
 * Deliberately a `setInterval`, not a queue consumer: see the note in
 * `outbox.service.ts` for why this workload does not need a broker.
 */

let timer: NodeJS.Timeout | null = null;
/** Guards against a slow tick overlapping the next one. */
let running = false;

export function startOutboxWorker(): void {
  if (timer) return;

  timer = setInterval(() => {
    void tick();
  }, env.OUTBOX_POLL_INTERVAL_MS);

  // Must not hold the process open during a graceful shutdown.
  timer.unref();

  logger.info({ intervalMs: env.OUTBOX_POLL_INTERVAL_MS }, 'Outbox worker started');
}

export function stopOutboxWorker(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;

  try {
    const result = await processPending();
    // Only worth a line when it actually did something.
    if (result.claimed > 0) logger.info(result, 'Outbox batch processed');
  } catch (cause) {
    // A failed tick must never take the process down: the next one will try
    // again, and the rows are still PENDING with their backoff intact.
    logger.error(
      { reason: cause instanceof Error ? cause.message : 'unknown' },
      'Outbox worker tick failed',
    );
  } finally {
    running = false;
  }
}
