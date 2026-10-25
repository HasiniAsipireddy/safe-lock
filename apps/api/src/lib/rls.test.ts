import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrl } from '../config/env';
import { prisma } from './prisma';

/**
 * Proof that Row Level Security denies the Data API and not the application.
 *
 * `20261023000000_enable_rls_deny_data_api` rests on a claim about Postgres:
 * that enabling RLS with no policies locks everyone out *except* roles which
 * bypass it, and that the role Prisma connects as is one of those. Both halves
 * matter and they fail in opposite directions — get the first wrong and a
 * public `anon` key reads every password hash; get the second wrong and the
 * application cannot read its own tables. "Probably fine" is not a standard
 * worth applying to either.
 *
 * So this connects as a role deliberately built to be the `anon` key's
 * equivalent: `NOBYPASSRLS`, not the owner of anything, and explicitly
 * **granted** `SELECT` — because the migration also revokes privileges, and
 * granting them back is what isolates RLS as the thing doing the work.
 *
 * Runs against local Docker like every other test. It cannot run against
 * Supabase (the suite refuses a non-local host) and does not need to: the
 * behaviour under test is Postgres's, and Supabase's `postgres` role carries
 * `rolbypassrls` on top of owning the tables, so it bypasses for two
 * independent reasons rather than one.
 */

/** Every table the RLS migration covers. */
const PROTECTED_TABLES = [
  'AuditLog',
  'Booking',
  'Command',
  'Device',
  'DeviceEvent',
  'Notification',
  'OutboundMessage',
  'PasswordResetCode',
  'Payment',
  'PhoneVerification',
  'RefreshToken',
  'UnlockChallenge',
  'User',
  'WebhookEvent',
] as const;

const PROBE_ROLE = 'safelock_rls_probe';
const PROBE_PASSWORD = 'rls_probe_local_only';

/** The suite's database, with the probe role's credentials substituted in. */
function probeConnectionString(): string {
  const url = new URL(databaseUrl());
  url.username = PROBE_ROLE;
  url.password = PROBE_PASSWORD;
  return url.toString();
}

async function asProbe<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: probeConnectionString() });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

describe('Row Level Security', () => {
  beforeAll(async () => {
    // Roles are cluster-wide and survive the suite's truncation, so this is
    // idempotent rather than a plain CREATE.
    await prisma.$executeRawUnsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '${PROBE_ROLE}') THEN
          CREATE ROLE ${PROBE_ROLE} LOGIN PASSWORD '${PROBE_PASSWORD}' NOBYPASSRLS;
        END IF;
      END
      $$;
    `);

    // Granted on purpose. The migration revokes privileges from anon as
    // defence in depth; handing them back here is what makes this a test of
    // RLS rather than a test of GRANT.
    await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${PROBE_ROLE};`);
    for (const table of PROTECTED_TABLES) {
      await prisma.$executeRawUnsafe(`GRANT SELECT ON TABLE "${table}" TO ${PROBE_ROLE};`);
    }
  });

  afterAll(async () => {
    for (const table of PROTECTED_TABLES) {
      await prisma.$executeRawUnsafe(`REVOKE ALL ON TABLE "${table}" FROM ${PROBE_ROLE};`);
    }
    await prisma.$executeRawUnsafe(`REVOKE USAGE ON SCHEMA public FROM ${PROBE_ROLE};`);
  });

  /**
   * **Asserted before any "it saw nothing" claim below**, and the reason is
   * the one in `docs/device-protocol.md` §13: a test that proves an absence
   * fails by *passing*. An unreachable probe — no schema `USAGE`, no `SELECT`,
   * a typo in a table name — returns nothing just as convincingly as RLS
   * does, and the first draft of this file did exactly that. If the grants
   * below are not in place, the emptiness downstream means nothing at all.
   */
  it('gives the probe role real access, so an empty result can only be RLS', async () => {
    const rows = await prisma.$queryRaw<
      Array<{ schema_usage: boolean; table_select: boolean; bypasses: boolean }>
    >`
      SELECT
        has_schema_privilege(${PROBE_ROLE}, 'public', 'USAGE') AS schema_usage,
        has_table_privilege(${PROBE_ROLE}, 'public."User"', 'SELECT') AS table_select,
        (SELECT rolbypassrls FROM pg_roles WHERE rolname = ${PROBE_ROLE}) AS bypasses
    `;

    const grants = rows[0];
    if (!grants) expect.unreachable('the privilege query returned no row');

    expect(grants.schema_usage).toBe(true);
    expect(grants.table_select).toBe(true);
    // And it must not be exempt, or the test proves nothing in either direction.
    expect(grants.bypasses).toBe(false);

    // Reachability, demonstrated rather than inferred: a table with RLS
    // disabled is readable through the very same connection.
    const readable = await asProbe(async (client) => {
      await client.query('CREATE TEMP TABLE rls_reachability (n int)');
      await client.query('INSERT INTO rls_reachability VALUES (1)');
      const result = await client.query('SELECT count(*)::int AS n FROM rls_reachability');
      return result.rows[0].n as number;
    });

    expect(readable).toBe(1);
  });

  it('has RLS enabled on every application table', async () => {
    const rows = await prisma.$queryRaw<Array<{ relname: string; relrowsecurity: boolean }>>`
      SELECT c."relname", c."relrowsecurity"
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
      ORDER BY c."relname"
    `;

    const unprotected = rows
      .filter((row) => PROTECTED_TABLES.includes(row.relname as (typeof PROTECTED_TABLES)[number]))
      .filter((row) => !row.relrowsecurity)
      .map((row) => row.relname);

    expect(unprotected).toEqual([]);
    // And the list itself is complete: a table added later without RLS should
    // fail this, not slip through because the constant was never updated.
    const present = rows.map((row) => row.relname).filter((name) => name !== '_prisma_migrations');
    expect([...present].sort()).toEqual([...PROTECTED_TABLES].sort());
  });

  /**
   * `FORCE ROW LEVEL SECURITY` would subject the owner to the (non-existent)
   * policies and take the application down. Pinned so nobody adds it while
   * tightening something.
   */
  it('does not force RLS on the owner', async () => {
    const rows = await prisma.$queryRaw<Array<{ relname: string; relforcerowsecurity: boolean }>>`
      SELECT c."relname", c."relforcerowsecurity"
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c."relforcerowsecurity"
    `;

    expect(rows).toEqual([]);
  });

  it('has no policies at all — deny by default, not deny by filter', async () => {
    const rows = await prisma.$queryRaw<Array<{ tablename: string; policyname: string }>>`
      SELECT "tablename", "policyname" FROM pg_policies WHERE "schemaname" = 'public'
    `;

    expect(rows).toEqual([]);
  });

  it('shows a non-bypassing role nothing, even with SELECT granted and rows present', async () => {
    const user = await prisma.user.create({
      data: {
        name: 'RLS Probe Subject',
        email: 'rls-probe@example.com',
        phone: '9800000777',
        passwordHash: 'not-a-real-hash',
      },
      select: { id: true },
    });

    // The application sees its own row.
    expect(await prisma.user.count()).toBeGreaterThan(0);

    const seen = await asProbe(async (client) => {
      const result = await client.query('SELECT "id", "email", "passwordHash" FROM "User"');
      return result.rows;
    });

    // The Data API's equivalent sees nothing. Not a filtered subset — nothing.
    expect(seen).toEqual([]);
    expect(JSON.stringify(seen)).not.toContain(user.id);
  });

  it('shows a non-bypassing role nothing on any protected table', async () => {
    await prisma.device.create({ data: { serialNumber: 'SAFE-RLS01' } });
    await prisma.webhookEvent.create({ data: { eventId: 'evt_rls_probe', type: 'probe' } });

    const counts = await asProbe(async (client) => {
      const entries: Array<[string, number]> = [];
      for (const table of PROTECTED_TABLES) {
        const result = await client.query(`SELECT count(*)::int AS n FROM "${table}"`);
        entries.push([table, result.rows[0].n as number]);
      }
      return entries;
    });

    expect(counts.filter(([, n]) => n !== 0)).toEqual([]);
  });

  /**
   * The other half of the claim, stated as a fact about the role rather than
   * an inference from the queries above: this is *why* the application is
   * unaffected, and it is what would differ if someone pointed Prisma at a
   * restricted role on Supabase.
   */
  it('connects as a role that bypasses RLS, by ownership or attribute', async () => {
    const rows = await prisma.$queryRaw<
      Array<{ current_role: string; bypassrls: boolean; owns_user_table: boolean }>
    >`
      SELECT
        current_user AS current_role,
        (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypassrls,
        (SELECT pg_catalog.pg_get_userbyid(c.relowner) = current_user
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = 'User') AS owns_user_table
    `;

    const row = rows[0];
    if (!row) expect.unreachable('the role query returned no row');

    expect(row.bypassrls || row.owns_user_table).toBe(true);
  });
});
