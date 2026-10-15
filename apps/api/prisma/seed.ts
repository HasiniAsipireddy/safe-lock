import { emailSchema, phoneSchema } from '@safelock/shared';
import { env, isProduction } from '../src/config/env';
import { prisma } from '../src/lib/prisma';
import { hashPassword } from '../src/modules/auth/password';

/**
 * Creates or updates the ADMIN account from environment variables.
 *
 * Run with:
 *   npm --workspace apps/api run db:seed
 *
 * Required:
 *   SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD, SEED_ADMIN_PHONE
 * Optional:
 *   SEED_ADMIN_NAME (defaults to "Safe Lock Admin")
 *   SEED_ALLOW_PRODUCTION=true  — required to run at all when NODE_ENV=production
 *
 * There is **no default password and no hardcoded fallback**. A seeded admin
 * with a known password is a backdoor into every safe in the fleet, and the
 * one thing nobody ever remembers to change.
 *
 * Idempotent: running it twice updates the existing row (including rotating
 * the password hash) rather than failing on the unique email.
 */

/** Minimum length for the seeded admin password. */
export const MIN_SEED_PASSWORD_LENGTH = 12;

export class SeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedError';
  }
}

export interface SeedAdminInput {
  email?: string | undefined;
  password?: string | undefined;
  name?: string | undefined;
  phone?: string | undefined;
  /** String form of SEED_ALLOW_PRODUCTION, so the check lives in one place. */
  allowProduction?: string | undefined;
}

export interface SeedAdminResult {
  id: string;
  email: string;
  created: boolean;
}

export async function seedAdmin(input: SeedAdminInput): Promise<SeedAdminResult> {
  // Refuse in production unless explicitly unlocked. Seeding is a development
  // convenience; doing it by accident against production creates a privileged
  // account whose password is sitting in someone's shell history.
  if (isProduction && input.allowProduction !== 'true') {
    throw new SeedError(
      'Refusing to seed in production. Set SEED_ALLOW_PRODUCTION=true if this is deliberate.',
    );
  }

  if (!input.email || !input.password || !input.phone) {
    throw new SeedError(
      'SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD and SEED_ADMIN_PHONE must all be set.',
    );
  }

  if (input.password.length < MIN_SEED_PASSWORD_LENGTH) {
    throw new SeedError(
      `SEED_ADMIN_PASSWORD must be at least ${MIN_SEED_PASSWORD_LENGTH} characters ` +
        `(got ${input.password.length}). This account can administer every safe.`,
    );
  }

  // Same validation the signup endpoint applies, so a seeded admin can
  // actually log in through the normal form.
  const email = emailSchema.parse(input.email);
  const phone = phoneSchema.parse(input.phone);
  const name = input.name?.trim() || 'Safe Lock Admin';

  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });

  const passwordHash = await hashPassword(input.password);

  const user = await prisma.user.upsert({
    where: { email },
    create: { name, email, phone, passwordHash, role: 'ADMIN' },
    // Rotates the password and re-asserts the ADMIN role on every run.
    update: { name, phone, passwordHash, role: 'ADMIN' },
    select: { id: true, email: true },
  });

  return { id: user.id, email: user.email, created: existing === null };
}

/** Reads the environment and seeds. Used by the npm script. */
export async function main(): Promise<void> {
  const result = await seedAdmin({
    email: env.SEED_ADMIN_EMAIL,
    password: env.SEED_ADMIN_PASSWORD,
    name: env.SEED_ADMIN_NAME,
    phone: env.SEED_ADMIN_PHONE,
    allowProduction: env.SEED_ALLOW_PRODUCTION,
  });

  // The password is never echoed, not even its length.
  process.stdout.write(
    `${result.created ? 'Created' : 'Updated'} ADMIN ${result.email} (${result.id})\n`,
  );
}

/**
 * Only self-executes when run directly, so the test suite can import
 * `seedAdmin` without seeding as a side effect.
 */
const isDirectRun =
  process.argv[1] !== undefined && /seed\.(ts|js)$/.test(process.argv[1].replace(/\\/g, '/'));

if (isDirectRun) {
  main()
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Seed failed: ${message}\n`);
      process.exitCode = 1;
    })
    .finally(() => void prisma.$disconnect());
}
