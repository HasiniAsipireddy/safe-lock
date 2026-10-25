import { execSync } from 'node:child_process';
import { config as loadDotenv } from 'dotenv';
import { assertLocalTestDatabases } from './localDatabaseGuard';

/**
 * Brings the test database's schema up to date once per run.
 *
 * `prisma migrate deploy` applies committed migrations without prompting, and
 * `PRISMA_DATABASE_URL` (honoured by prisma.config.ts) points it at
 * TEST_DATABASE_URL so the dev database is never touched.
 */
export default function globalSetup(): void {
  loadDotenv();

  // Refuses a non-local host as well as a non-`*_test` database name. The
  // message explains which variable to fix; see localDatabaseGuard.ts.
  assertLocalTestDatabases();

  const url = process.env.TEST_DATABASE_URL as string;

  /**
   * The child's environment is built rather than inherited.
   *
   * `prisma.config.ts` resolves its URL as
   * `PRISMA_DATABASE_URL ?? DIRECT_URL ?? DATABASE_URL`, and on a machine set
   * up for Supabase the latter two are hosted. Setting the override is enough
   * today, but it is the kind of enough that survives exactly until someone
   * reorders that expression — so the fallbacks are removed outright. Migrate
   * cannot reach a hosted database from here even if the precedence changes.
   */
  const childEnv: NodeJS.ProcessEnv = { ...process.env, PRISMA_DATABASE_URL: url };
  delete childEnv.DIRECT_URL;
  delete childEnv.DATABASE_URL;

  // A single command string (rather than execFileSync with args + shell) keeps
  // Node from warning about unescaped arguments on Windows.
  execSync('npx prisma migrate deploy', {
    stdio: 'inherit',
    env: childEnv,
  });
}
