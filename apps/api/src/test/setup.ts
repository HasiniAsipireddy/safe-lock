import { afterAll, beforeEach } from 'vitest';
import { prisma } from '../lib/prisma';

/**
 * Per-file test setup: a clean database before every test.
 *
 * TRUNCATE ... CASCADE is used rather than deleteMany so insertion order and
 * foreign keys do not matter, and it is far faster than row-by-row deletes.
 */

const TABLES = [
  'RefreshToken',
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
