import { execSync } from 'node:child_process';
import { config as loadDotenv } from 'dotenv';

/**
 * Brings the test database's schema up to date once per run.
 *
 * `prisma migrate deploy` applies committed migrations without prompting, and
 * `PRISMA_DATABASE_URL` (honoured by prisma.config.ts) points it at
 * TEST_DATABASE_URL so the dev database is never touched.
 */
export default function globalSetup(): void {
  loadDotenv();

  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Copy apps/api/.env.example to apps/api/.env and start ' +
        'the database with `docker compose up -d`.',
    );
  }

  if (!/safelock_test/.test(url)) {
    // The suite truncates every table between tests. Refuse to do that to a
    // database that is not obviously the test one.
    throw new Error(
      `Refusing to run: TEST_DATABASE_URL does not point at a *_test database (${redactUrl(url)}).`,
    );
  }

  // A single command string (rather than execFileSync with args + shell) keeps
  // Node from warning about unescaped arguments on Windows.
  execSync('npx prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, PRISMA_DATABASE_URL: url },
  });
}

function redactUrl(url: string): string {
  return url.replace(/\/\/[^@]*@/, '//***@');
}
