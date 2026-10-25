import { describe, expect, it } from 'vitest';
import { assertLocalDatabaseUrl, assertLocalTestDatabases, redactUrl } from './localDatabaseGuard';

/**
 * The guard that stops `TRUNCATE` and `migrate deploy` reaching a hosted
 * database.
 *
 * Tested because it is the one piece of this codebase whose failure is
 * unrecoverable: everything else can be fixed by fixing the code and running
 * it again.
 */
describe('assertLocalDatabaseUrl', () => {
  const local = 'postgresql://safelock:pw@localhost:5433/safelock_test';

  it('accepts the local Docker database', () => {
    expect(() => assertLocalDatabaseUrl('TEST_DATABASE_URL', local)).not.toThrow();
  });

  it.each([
    'postgresql://postgres.ref:pw@aws-0-ap-northeast-2.pooler.supabase.com:6543/postgres',
    'postgresql://postgres.ref:pw@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres',
    'postgresql://postgres:pw@db.ref.supabase.co:5432/postgres',
    // Not Supabase, and still not somewhere a test may truncate. The guard is
    // an allow-list for exactly this reason.
    'postgresql://admin:pw@safelock-prod.abc123.ap-south-1.rds.amazonaws.com:5432/safelock_test',
  ])('refuses the non-local host in %s', (url) => {
    expect(() => assertLocalDatabaseUrl('TEST_DATABASE_URL', url)).toThrow(/non-local host/);
  });

  it('never puts credentials in the message it throws', () => {
    const url = 'postgresql://postgres.abcdef:sup3r-s3cret@aws-0-x.pooler.supabase.com:6543/postgres';

    expect(() => assertLocalDatabaseUrl('TEST_DATABASE_URL', url)).toThrow(/\*\*\*/);
    try {
      assertLocalDatabaseUrl('TEST_DATABASE_URL', url);
      expect.unreachable('should have thrown');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain('sup3r-s3cret');
      expect(message).not.toContain('postgres.abcdef');
    }
  });

  it('redacts user and password together, not just the password', () => {
    expect(redactUrl('postgresql://someone:hunter2@host:5432/db')).toBe(
      'postgresql://***:***@host:5432/db',
    );
  });
});

describe('assertLocalTestDatabases', () => {
  const localTest = 'postgresql://safelock:pw@localhost:5433/safelock_test';

  it('passes for the committed local setup', () => {
    expect(() =>
      assertLocalTestDatabases({ TEST_DATABASE_URL: localTest } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  it('still refuses a local database that is not the *_test one', () => {
    expect(() =>
      assertLocalTestDatabases({
        TEST_DATABASE_URL: 'postgresql://safelock:pw@localhost:5433/safelock',
      } as NodeJS.ProcessEnv),
    ).toThrow(/_test database/);
  });

  it('refuses a hosted database even when it is named like the test one', () => {
    expect(() =>
      assertLocalTestDatabases({
        TEST_DATABASE_URL:
          'postgresql://postgres.ref:pw@aws-0-ap-northeast-2.pooler.supabase.com:5432/safelock_test',
      } as NodeJS.ProcessEnv),
    ).toThrow(/non-local host/);
  });

  /**
   * The supported arrangement: the API talks to Supabase while the suite talks
   * to Docker. A guard that broke this would be turned off within a day.
   */
  it('allows Supabase in DATABASE_URL and DIRECT_URL while the test database is local', () => {
    expect(() =>
      assertLocalTestDatabases({
        TEST_DATABASE_URL: localTest,
        DATABASE_URL:
          'postgresql://postgres.ref:pw@aws-0-ap-northeast-2.pooler.supabase.com:6543/postgres',
        DIRECT_URL:
          'postgresql://postgres.ref:pw@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres',
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  it('refuses a hosted PRISMA_DATABASE_URL, which is what Migrate would follow', () => {
    expect(() =>
      assertLocalTestDatabases({
        TEST_DATABASE_URL: localTest,
        PRISMA_DATABASE_URL:
          'postgresql://postgres.ref:pw@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres',
      } as NodeJS.ProcessEnv),
    ).toThrow(/PRISMA_DATABASE_URL/);
  });

  it('refuses an unset TEST_DATABASE_URL', () => {
    expect(() => assertLocalTestDatabases({} as NodeJS.ProcessEnv)).toThrow(/not set/);
  });
});
