import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

/**
 * Prisma 7 moved the Migrate connection URL out of schema.prisma and into this
 * file. The runtime client gets its connection separately, through the pg
 * driver adapter in `src/lib/prisma.ts`.
 *
 * `PRISMA_DATABASE_URL` is an escape hatch so the test setup can run
 * `prisma migrate deploy` against TEST_DATABASE_URL without touching the dev
 * database.
 *
 * ## Why `DIRECT_URL` is read here and not in schema.prisma
 * The conventional Supabase setup puts `url` and `directUrl` in the datasource
 * block, and **Prisma 7 removed both properties from schema files** — it fails
 * with P1012 telling you to move them here. So this file is the whole of it:
 * Migrate connects through `DIRECT_URL`, and the runtime never does.
 *
 * ## Why Migrate must not use the transaction pooler
 * `DATABASE_URL` is a **transaction-mode** pooler connection, where every
 * statement can land on a different backend and nothing session-scoped
 * survives. Migrate needs the opposite: an advisory lock held across the whole
 * run (so two deploys cannot interleave), `CREATE EXTENSION`, and DDL in long
 * transactions. Pointed at port 6543 it fails or, worse, half-applies.
 *
 * `DIRECT_URL` is therefore Supabase's **session-mode** pooler (port 5432),
 * which keeps one backend per connection for the life of the connection.
 * Deliberately the session pooler and not the direct database host: the latter
 * resolves to IPv6 only, which fails outright from most IPv4 networks.
 *
 * Locally the two are the same string — one Postgres, no pooler — so Docker
 * development is unchanged and nothing here needs configuring.
 */
/**
 * Refuses a transaction-mode pooler before Migrate can half-apply something.
 *
 * The failure this prevents is quiet and expensive: set `DATABASE_URL` to the
 * 6543 pooler, forget `DIRECT_URL`, and the fallback below hands Migrate a
 * connection where its advisory lock and its DDL transaction do not survive
 * one statement to the next. Better to name the problem than to find out from
 * a partially-migrated database.
 *
 * Matches on what identifies the pooler — port 6543, or the `pgbouncer` flag —
 * and says nothing about the URL itself, which carries a password.
 */
function assertMigratable(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Let Prisma report an unparsable URL; it does it better than this would.
    return url;
  }

  const pooled = parsed.port === '6543' || parsed.searchParams.get('pgbouncer') === 'true';
  if (!pooled) return url;

  throw new Error(
    'Refusing to run migrations through a transaction-mode pooler (port 6543 / ' +
      'pgbouncer=true). Migrate needs a session it can hold: an advisory lock across the ' +
      'whole run, CREATE EXTENSION, and DDL in long transactions.\n' +
      'Set DIRECT_URL to the Supabase SESSION pooler (same host, port 5432) and leave ' +
      'DATABASE_URL on 6543 for the application. See apps/api/.env.example.',
  );
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    // `prisma db seed` runs this. The same script is also exposed directly as
    // `npm --workspace apps/api run db:seed`.
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    /**
     * Precedence, narrowest first: the test override, then the migration URL,
     * then the runtime one. The `DATABASE_URL` fallback is what keeps a local
     * `.env` that has never heard of `DIRECT_URL` working exactly as before.
     */
    url: assertMigratable(
      process.env.PRISMA_DATABASE_URL ?? process.env.DIRECT_URL ?? env('DATABASE_URL'),
    ),
  },
});
