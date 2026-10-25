import { env } from '../src/config/env';
import { prisma } from '../src/lib/prisma';
import { TEST_SAFE_PREFIX, cleanupTestSafes } from './testSafes';

/**
 * Removes the seeded test fleet.
 *
 *   npm --workspace apps/api run db:cleanup-safes
 *
 * Deletes what is free to go, retires what a booking is holding. Touches
 * nothing whose serial does not begin `SAFE-TEST`, and is refused in production
 * and on any gateway but `mock` — the same two guards as the seed, because
 * running this against real inventory is the worse of the two accidents.
 */

export async function main(): Promise<void> {
  const result = await cleanupTestSafes({
    nodeEnv: env.NODE_ENV,
    deviceGateway: env.DEVICE_GATEWAY,
  });

  process.stdout.write(
    `Test safes (${TEST_SAFE_PREFIX}*): ${result.deleted} deleted, ` +
      `${result.retired} retired (they have bookings, which must survive them), ` +
      `${result.untouched} already retired\n`,
  );

  if (result.liveBookings.length) {
    process.stderr.write(
      `Warning: retired with a LIVE booking: ${result.liveBookings.join(', ')}. ` +
        'Whoever is renting one has just lost the safe from under them. ' +
        'Force-complete those bookings in /admin.\n',
    );
  }
}

const isDirectRun =
  process.argv[1] !== undefined &&
  /cleanupSafes\.(ts|js)$/.test(process.argv[1].replace(/\\/g, '/'));

if (isDirectRun) {
  main()
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Cleanup failed: ${message}\n`);
      process.exitCode = 1;
    })
    .finally(() => void prisma.$disconnect());
}
