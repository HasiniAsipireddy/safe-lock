-- Row Level Security on every application table, with **no policies at all**.
--
-- ## What this is defending against
-- Supabase publishes every table in `public` through its Data API (PostgREST),
-- reachable from any browser with the project's `anon` key — a key that is
-- designed to be public and ships in frontend bundles. This application does
-- not use the Data API; it talks to Postgres directly through Prisma. So the
-- Data API is pure attack surface, and on a physical-security product its
-- contents are the worst possible thing to leave readable: password hashes,
-- refresh token hashes, OTP hashes, device serials and every booking.
--
-- RLS with no policies is "deny by default". There is no permissive policy
-- anywhere in this migration and there must never be one added for `anon`.
--
-- ## Why this does not affect the application
-- Postgres exempts two kinds of role from RLS: roles with `BYPASSRLS`, and a
-- table's owner (unless `FORCE ROW LEVEL SECURITY` is set, which this
-- migration deliberately does not set). Prisma connects as `postgres`, which
-- on Supabase is both the owner of these tables and carries `rolbypassrls`, so
-- every application query is unaffected. `apps/api/src/lib/rls.test.ts` proves
-- that rather than trusting it, by reading the same tables through a role that
-- has neither property.
--
-- **`FORCE ROW LEVEL SECURITY` must not be added here.** It would subject the
-- owner to these (non-existent) policies and take the whole application down.
--
-- ## Local Docker
-- Applies cleanly and changes nothing: the `safelock` role owns these tables,
-- and the `anon`/`authenticated` roles do not exist, which the guarded block
-- at the bottom accounts for.

ALTER TABLE "AuditLog"           ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Booking"            ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Command"            ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Device"             ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DeviceEvent"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Notification"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OutboundMessage"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PasswordResetCode"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Payment"            ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PhoneVerification"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RefreshToken"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UnlockChallenge"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "User"               ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WebhookEvent"       ENABLE ROW LEVEL SECURITY;

-- Defence in depth: take the grants away too.
--
-- RLS alone is enough, and it is enough only for as long as nobody adds a
-- policy "just for one table" to make something work. Revoking the privileges
-- means the Data API has no access to revoke-protected tables even then — two
-- independent mechanisms, which is the standard this codebase already applies
-- to the booking overlap rule (a service check *and* a database constraint).
--
-- Guarded on the roles existing, because they are Supabase's and the local
-- Docker database has never heard of them. `pg_catalog` lookups rather than
-- `IF NOT EXISTS`, which Postgres does not offer for roles.
DO $$
DECLARE
  target_role text;
  target_table text;
BEGIN
  FOREACH target_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = target_role) THEN
      FOREACH target_table IN ARRAY ARRAY[
        'AuditLog', 'Booking', 'Command', 'Device', 'DeviceEvent', 'Notification',
        'OutboundMessage', 'PasswordResetCode', 'Payment', 'PhoneVerification',
        'RefreshToken', 'UnlockChallenge', 'User', 'WebhookEvent',
        -- Not RLS-enabled above, so that nothing can interfere with Migrate
        -- itself, but there is no reason for the Data API to read our
        -- migration history either.
        '_prisma_migrations'
      ] LOOP
        EXECUTE format(
          'REVOKE ALL PRIVILEGES ON TABLE public.%I FROM %I',
          target_table,
          target_role
        );
      END LOOP;
    END IF;
  END LOOP;
END
$$;
