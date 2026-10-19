import { API_PREFIX, createApp } from './app';
import { WEB_ORIGINS, env } from './config/env';
import { logger } from './lib/logger';
import { disconnectPrisma } from './lib/prisma';
import { deviceGateway } from './lib/deviceGateway';
import { startOutboxWorker, stopOutboxWorker } from './lib/outbox/worker';
import {
  startBookingSweeper,
  stopBookingSweeper,
} from './modules/bookings/booking.sweeper';
import { deviceInboundHandler } from './modules/commands/inbound.service';

/**
 * Process entry point: listen, then shut down cleanly.
 *
 * "Cleanly" means: stop accepting new work, let in-flight requests finish,
 * drop idle keep-alive sockets (which would otherwise hold the server open
 * indefinitely), close the database pool, and — if any of that stalls — exit
 * anyway rather than wait for the orchestrator's SIGKILL.
 */

/** How long in-flight work gets before the process exits regardless. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info(
    {
      port: env.PORT,
      prefix: API_PREFIX,
      env: env.NODE_ENV,
      webOrigins: WEB_ORIGINS,
      trustProxy: env.TRUST_PROXY,
    },
    'API listening',
  );

  /**
   * The outbox poll loop starts here and **only** here — not in
   * `createApp()`. A worker that started with the app would tick during the
   * test suite, racing every assertion about outbox state and sending on a
   * timer nobody asked for. Tests call `processPending()` directly.
   */
  startOutboxWorker();

  /**
   * The booking sweeper, started here and **only** here, for the same reason
   * the outbox worker is: a loop that started with the app would tick during
   * the test suite and race every assertion about booking state. Tests call
   * `sweepBookings()` directly.
   *
   * Correctness does not depend on it — every read derives a booking's status
   * from the server clock — so a late or dead sweeper cannot leave a safe
   * unlockable. It reconciles rows and releases devices.
   */
  startBookingSweeper();

  /**
   * Connect to the broker and register where device messages land.
   *
   * Here and not in `createApp()`, because this opens a network connection and
   * a test suite must not. (The in-process mock *is* wired up by `createApp`,
   * which is how the ack path stays reachable from tests — see the comment
   * there. Calling `start` twice on the mock simply re-registers the same
   * handler.)
   *
   * Failing to connect does not stop the server. The API has plenty to do
   * without a broker — someone mid-booking can still see their dashboard and
   * pay an overstay fee — and a gateway that reconnects on its own turns a
   * broker restart into a blip rather than an outage. Commands issued
   * meanwhile fail honestly as `EXPIRED`/`PUBLISH_FAILED`, which is the truth:
   * nothing reached the device.
   */
  void deviceGateway.start(deviceInboundHandler).catch((error: unknown) => {
    logger.error(
      { reason: error instanceof Error ? error.message : 'unknown' },
      'Device gateway failed to start; commands will not reach any safe until it connects',
    );
  });
});

let shuttingDown = false;

async function shutdown(reason: string, exitCode = 0): Promise<void> {
  // A second SIGTERM (or an impatient operator pressing Ctrl-C twice) must not
  // start a second shutdown and race the first one's timers.
  if (shuttingDown) {
    logger.warn({ reason }, 'Shutdown already in progress; ignoring');
    return;
  }
  shuttingDown = true;

  logger.info({ reason }, 'Shutting down');

  // Stop claiming new outbound messages first. A row already claimed keeps its
  // pushed-out backoff, so the next process picks it up rather than losing it.
  stopOutboxWorker();
  stopBookingSweeper();

  /**
   * Disconnect from the broker, after in-flight acks have been handled.
   *
   * An ack arriving mid-shutdown is a bolt that moved, and dropping it would
   * leave the record disagreeing with a physical safe. A command whose ack we
   * never get times out and is reconciled by the next process, which is the
   * designed behaviour rather than a loss.
   */
  void deviceGateway.stop();

  // Hard deadline. unref'd so it never by itself keeps the process alive.
  const forceExit = setTimeout(() => {
    logger.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'Shutdown timed out; forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  try {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));

      // Sockets sitting idle between keep-alive requests would otherwise keep
      // server.close() pending until they time out on their own.
      server.closeIdleConnections();

      // Give in-flight requests most of the budget, then cut the rest off so
      // close() can actually complete.
      setTimeout(() => server.closeAllConnections(), SHUTDOWN_TIMEOUT_MS * 0.8).unref();
    });

    await disconnectPrisma();

    clearTimeout(forceExit);
    logger.info('Shutdown complete');
    process.exit(exitCode);
  } catch (error) {
    clearTimeout(forceExit);
    logger.error(
      { reason: error instanceof Error ? error.message : 'unknown' },
      'Shutdown failed',
    );
    process.exit(1);
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void shutdown(signal));
}

/**
 * An unhandled rejection or uncaught exception leaves the process in an
 * unknown state. For a service that authorises opening a safe, "unknown
 * state" is not something to keep serving traffic from: log it and exit 1 so
 * the orchestrator restarts a clean process.
 */
process.on('unhandledRejection', (reason) => {
  logger.error(
    { reason: reason instanceof Error ? reason.message : String(reason) },
    'Unhandled promise rejection',
  );
  void shutdown('unhandledRejection', 1);
});

process.on('uncaughtException', (error) => {
  logger.error({ reason: error.message, stack: error.stack }, 'Uncaught exception');
  void shutdown('uncaughtException', 1);
});
