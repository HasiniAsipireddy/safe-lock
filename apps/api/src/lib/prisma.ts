import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Prisma } from '@prisma/client';
import { databaseUrl, isProduction, isTest } from '../config/env';

/**
 * The Prisma client.
 *
 * Prisma 7 connects through a driver adapter rather than a URL in the schema,
 * which is convenient here: the connection string is chosen at runtime, so
 * `NODE_ENV=test` transparently points at TEST_DATABASE_URL.
 */
const adapter = new PrismaPg({ connectionString: databaseUrl() });

export const prisma = new PrismaClient({
  adapter,
  // Query logging would put user data (and, in other modules, OTP lookups) in
  // the logs. Warnings and errors only.
  log: isProduction || isTest ? ['error'] : ['warn', 'error'],
});

/** Transaction client, for services that work inside or outside a transaction. */
export type PrismaTransaction = Prisma.TransactionClient;

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}

/** How long `checkDatabase` waits before calling the database unreachable. */
export const DB_HEALTHCHECK_TIMEOUT_MS = 2000;

/**
 * Liveness probe for `/health`.
 *
 * Runs `SELECT 1` with a hard timeout. The timeout is the point: without it a
 * health check against a wedged connection pool hangs instead of reporting
 * degraded, and a load balancer keeps routing traffic to a broken instance.
 *
 * Never throws — it answers a boolean so the route cannot 500.
 */
export async function checkDatabase(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;

  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error('database health check timed out')),
        DB_HEALTHCHECK_TIMEOUT_MS,
      );
    });

    await Promise.race([prisma.$queryRaw`SELECT 1`, timeout]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
