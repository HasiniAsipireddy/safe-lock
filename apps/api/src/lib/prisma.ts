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

/**
 * Pool size, read out of the connection string.
 *
 * **`connection_limit` is a Prisma *engine* parameter, and this app does not
 * use the engine's pool** — it uses `node-postgres` through the driver
 * adapter, which parses unknown query parameters into inert strings and
 * ignores them. Measured, not assumed: four concurrent `pg_sleep(0.5)` queries
 * through a URL carrying `connection_limit=1` finished in 535ms (parallel),
 * while `PrismaPg({ max: 1 })` took 2046ms (serialised).
 *
 * Every Supabase guide tells you to append `?pgbouncer=true&connection_limit=1`,
 * so the parameter will be in the URL and somebody will reasonably believe it
 * is doing something. Reading it here is what makes that belief true. Absent,
 * `node-postgres` keeps its own default of 10.
 *
 * `pgbouncer=true` is left inert on purpose, and is **not** a gap: it told the
 * Rust engine to stop using named prepared statements, which is the thing
 * transaction-mode pooling breaks. `node-postgres` only creates a named
 * statement when a query supplies a `name`, and the adapter never does — so
 * every statement goes out unnamed, which is exactly what the flag was for.
 */
function poolSizeFrom(connectionString: string): number | undefined {
  const value = (() => {
    try {
      return new URL(connectionString).searchParams.get('connection_limit');
    } catch {
      // Not a parsable URL. The adapter will complain about it far more
      // usefully than this function could.
      return null;
    }
  })();

  if (value === null) return undefined;

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

const connectionString = databaseUrl();
const poolSize = poolSizeFrom(connectionString);

const adapter = new PrismaPg({
  connectionString,
  ...(poolSize === undefined ? {} : { max: poolSize }),
});

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
