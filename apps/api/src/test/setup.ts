import { afterAll, beforeEach } from 'vitest';
import { prisma } from '../lib/prisma';

/**
 * Per-file test setup: a clean database before every test, and no network.
 *
 * TRUNCATE ... CASCADE is used rather than deleteMany so insertion order and
 * foreign keys do not matter, and it is far faster than row-by-row deletes.
 */

/**
 * Outbound HTTP is blocked for the whole suite.
 *
 * `fetch` is the only way this codebase makes an outbound HTTP request — the
 * WhatsApp Cloud API client uses it, and the Razorpay SDK is mocked at the
 * module level (`test/razorpayMock.ts`). Replacing it with a throwing stub
 * means a test cannot accidentally message a real phone number or spend real
 * money, and that a future client written without a fake is a loud failure
 * rather than a surprising invoice.
 *
 * A test that needs to exercise HTTP behaviour stubs it explicitly with
 * `vi.stubGlobal('fetch', …)`; `vi.unstubAllGlobals()` restores this block.
 *
 * Scope note: this covers `fetch`, not raw `net`/`http` sockets — Postgres
 * needs those. It is a guard against the mistake that is actually likely, not
 * a sandbox.
 */
export const NETWORK_BLOCKED_MESSAGE =
  'Network access is blocked in tests. Stub fetch with vi.stubGlobal, or use the fake client.';

// Rejects rather than throwing synchronously, because that is what real
// `fetch` does — code under test must hit its own error path, not a different
// one that only exists in tests.
globalThis.fetch = (() =>
  Promise.reject(new Error(NETWORK_BLOCKED_MESSAGE))) as unknown as typeof fetch;

const TABLES = [
  'RefreshToken',
  'PasswordResetToken',
  'OutboundMessage',
  'PhoneVerification',
  'Notification',
  'DeviceEvent',
  'UnlockChallenge',
  'Device',
  'Payment',
  'WebhookEvent',
  'AuditLog',
  'User',
] as const;

export async function resetDatabase(): Promise<void> {
  const list = TABLES.map((table) => `"${table}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE;`);
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
});
