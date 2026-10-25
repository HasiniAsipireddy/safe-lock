/**
 * The suite is only ever allowed to touch a local database.
 *
 * Every test file truncates all fourteen tables in `beforeEach`, and the
 * global setup runs `prisma migrate deploy`. Both are catastrophic against a
 * hosted database and neither asks first. Before Supabase existed in this
 * repo, `TEST_DATABASE_URL` naming a `*_test` database was enough of a guard;
 * now a single mistyped variable, or a `.env` edited for a migration and not
 * changed back, can point that name at a production host.
 *
 * So the host is checked as well as the database name. The two guards catch
 * different mistakes: the name catches `safelock` instead of `safelock_test`
 * on the right server, and the host catches `safelock_test` on the wrong one.
 *
 * This is deliberately an allow-list. A deny-list containing "supabase" would
 * be satisfied by a direct AWS RDS hostname, and the failure mode of being
 * wrong here is losing a production database.
 */

/** Hosts a test run may truncate. */
const LOCAL_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
  '0.0.0.0',
  // Compose/CI runners reaching a database container by service name.
  'host.docker.internal',
  'postgres',
  'safelock-postgres',
]);

/** Strips credentials, so a thrown message can never carry a password. */
export function redactUrl(url: string): string {
  return url.replace(/\/\/[^@/]*@/, '//***:***@');
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    throw new Error(`Refusing to run: a database URL could not be parsed (${redactUrl(url)}).`);
  }
}

/**
 * Throws unless `url` names a local host.
 *
 * `label` is the variable's name, so the message says which one to fix.
 */
export function assertLocalDatabaseUrl(label: string, url: string): void {
  const host = hostOf(url);

  if (LOCAL_HOSTS.has(host)) return;

  throw new Error(
    `Refusing to run the test suite: ${label} points at the non-local host "${host}".\n` +
      'The suite truncates every table and runs migrations, which would destroy a hosted ' +
      'database. Point it back at the local Docker Postgres (npm run db:up) and keep the ' +
      'Supabase URLs out of the variables the tests read.\n' +
      `Saw: ${redactUrl(url)}`,
  );
}

/**
 * Checks the variables a test run actually connects through.
 *
 * **`DATABASE_URL` and `DIRECT_URL` are deliberately not checked.** Pointing
 * those at Supabase while running the suite against Docker is the supported
 * arrangement — it is the entire reason `DIRECT_URL` exists — and refusing to
 * run the tests because the dev server talks to a hosted database would make
 * the guard a worse problem than the one it prevents. What stops Migrate from
 * following them is `globalSetup`, which passes `PRISMA_DATABASE_URL` and
 * removes both from the child's environment so the fallback chain in
 * `prisma.config.ts` cannot reach past it.
 */
export function assertLocalTestDatabases(source: NodeJS.ProcessEnv = process.env): void {
  const url = source.TEST_DATABASE_URL;

  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Copy apps/api/.env.example to apps/api/.env and start ' +
        'the database with `npm run db:up`.',
    );
  }

  if (!/safelock_test/.test(url)) {
    throw new Error(
      `Refusing to run: TEST_DATABASE_URL does not point at a *_test database (${redactUrl(url)}).`,
    );
  }

  assertLocalDatabaseUrl('TEST_DATABASE_URL', url);

  // The override Migrate runs under, when something has set it explicitly.
  const override = source.PRISMA_DATABASE_URL;
  if (override) assertLocalDatabaseUrl('PRISMA_DATABASE_URL', override);
}
