import { API_PREFIX, createApp } from './app';
import { WEB_ORIGINS, env } from './config/env';
import { logger } from './lib/logger';
import { disconnectPrisma } from './lib/prisma';

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
