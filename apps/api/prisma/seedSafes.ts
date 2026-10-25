import { env, DEVICE_HEARTBEAT_MS, DEVICE_OFFLINE_AFTER_MS } from '../src/config/env';
import { prisma } from '../src/lib/prisma';
import {
  TEST_SAFE_PREFIX,
  heartbeatTestSafes,
  seedTestSafes,
} from './testSafes';

/**
 * Seeds 30 test safes so the website can be driven end to end without hardware.
 *
 *   npm --workspace apps/api run db:seed:safes
 *   npm --workspace apps/api run db:seed:safes -- --heartbeat
 *
 * Idempotent. Refused when `NODE_ENV=production` or `DEVICE_GATEWAY` is not
 * `mock` — see `testSafes.ts` for why both.
 *
 * `--heartbeat` stays in the foreground and keeps the fleet online. It is not a
 * nicety: nothing advances `lastSeenAt` on the mock gateway except an ack, so
 * without it the fleet is bookable for `DEVICE_OFFLINE_AFTER_SECONDS` and then
 * goes dark with no way back — lock and unlock both require the safe to be
 * reachable, so the one action that would refresh liveness is the one a stale
 * row refuses. Ctrl-C to stop; the rows stay.
 */

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const keepAlive = argv.includes('--heartbeat');

  const result = await seedTestSafes({
    nodeEnv: env.NODE_ENV,
    deviceGateway: env.DEVICE_GATEWAY,
  });

  process.stdout.write(
    `Test safes (${TEST_SAFE_PREFIX}*): ${result.created} created, ` +
      `${result.refreshed} refreshed — ${result.total} total ` +
      `(${result.bySize.SMALL} small, ${result.bySize.MEDIUM} medium, ` +
      `${result.bySize.LARGE} large)\n`,
  );

  if (!keepAlive) {
    process.stdout.write(
      `They go offline ${Math.round(DEVICE_OFFLINE_AFTER_MS / 1000)}s from now and ` +
        'stay that way. Re-run this, or run it with --heartbeat to hold them online.\n',
    );
    return;
  }

  /**
   * Half the offline threshold, so one missed tick is not an outage — the same
   * reasoning `DEVICE_HEARTBEAT_SECONDS` is set against for real firmware.
   */
  const interval = Math.min(DEVICE_HEARTBEAT_MS, Math.floor(DEVICE_OFFLINE_AFTER_MS / 2));

  process.stdout.write(
    `Heartbeating every ${Math.round(interval / 1000)}s. Ctrl-C to stop.\n`,
  );

  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  while (!stopping) {
    await new Promise((resolve) => setTimeout(resolve, interval));
    if (stopping) break;

    try {
      const touched = await heartbeatTestSafes();
      process.stdout.write(`  heartbeat: ${touched} safes\n`);
    } catch (cause) {
      // A dropped connection to a dev database should not end the loop.
      const message = cause instanceof Error ? cause.message : String(cause);
      process.stderr.write(`  heartbeat failed: ${message}\n`);
    }
  }

  process.stdout.write('Stopped heartbeating. The safes stay in the inventory.\n');
}

const isDirectRun =
  process.argv[1] !== undefined &&
  /seedSafes\.(ts|js)$/.test(process.argv[1].replace(/\\/g, '/'));

if (isDirectRun) {
  main()
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Seed failed: ${message}\n`);
      process.exitCode = 1;
    })
    .finally(() => void prisma.$disconnect());
}
