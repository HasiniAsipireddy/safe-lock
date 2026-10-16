import 'dotenv/config';
import { z } from 'zod';

/**
 * Environment loading and validation.
 *
 * The process refuses to boot on a bad or missing variable rather than
 * discovering it at the first payment. Nothing in here is ever logged.
 */

const secret = (label: string) =>
  z.string().min(32, `${label} must be at least 32 characters`);

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().max(65535).default(4000),

    /**
     * Comma-separated browser origins allowed to send credentialed requests.
     *
     * Used for two things: the `cors()` allowlist, and the exact-match
     * `originCheck` CSRF guard. `CORS_ORIGINS` is accepted as a legacy alias
     * (see `webOrigins()` below) so an existing .env keeps working.
     *
     * Matching is **exact string equality** — never a prefix or regex. A
     * prefix match on `https://app.example.com` would also accept
     * `https://app.example.com.attacker.test`.
     */
    WEB_ORIGIN: z.string().optional(),
    CORS_ORIGINS: z.string().optional(),

    /**
     * Whether to trust `X-Forwarded-*`. Off by default: trusting the header
     * when there is no proxy in front lets any client spoof its IP and defeat
     * every per-IP rate limit. Set to the number of proxy hops (or `true`)
     * only when actually behind one.
     */
    TRUST_PROXY: z
      .string()
      .default('false')
      .transform((value) => {
        const normalised = value.trim().toLowerCase();
        if (normalised === 'false' || normalised === '' || normalised === '0') return false;
        if (normalised === 'true') return true;
        const hops = Number(normalised);
        return Number.isInteger(hops) && hops > 0 ? hops : false;
      }),

    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    TEST_DATABASE_URL: z.string().optional(),

    /** Signs the short-lived access token. */
    JWT_ACCESS_SECRET: secret('JWT_ACCESS_SECRET'),
    /**
     * Legacy. Refresh tokens are now opaque random bytes stored hashed, so
     * nothing signs them — kept optional so an existing .env does not fail
     * validation, and so a rollback has its secret still to hand.
     * TODO(cleanup): drop once no deployment runs the JWT-refresh build.
     */
    JWT_REFRESH_SECRET: z.string().optional(),
    ACCESS_TOKEN_TTL: z.string().default('15m'),
    /** Refresh token lifetime in days. */
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().max(365).default(7),

    /**
     * Keys the HMAC that unlock OTPs are stored under.
     *
     * Deliberately **separate** from JWT_ACCESS_SECRET: these protect
     * different things with different lifetimes, and reusing one secret means
     * rotating it breaks both at once. A 6-digit code is only 10^6 values, so
     * the hash function is not what makes the stored digest useless to an
     * attacker — a key that lives outside the database is.
     */
    OTP_HMAC_SECRET: secret('OTP_HMAC_SECRET'),

    /**
     * Which hardware gateway to talk to. Only `mock` exists today; `mqtt`
     * arrives with the real units. An enum rather than a free string so a
     * typo is a boot failure, not a silent fallback to the mock in
     * production.
     */
    DEVICE_GATEWAY: z.enum(['mock']).default('mock'),

    // --- ADMIN seed (prisma/seed.ts) -----------------------------------------
    SEED_ADMIN_EMAIL: z.string().optional(),
    SEED_ADMIN_PASSWORD: z.string().optional(),
    SEED_ADMIN_NAME: z.string().optional(),
    SEED_ADMIN_PHONE: z.string().optional(),
    SEED_ALLOW_PRODUCTION: z.string().optional(),

    /**
     * One-time activation price in PAISE. The single source of truth for what
     * a safe costs — see `payments.service.ts`, which never reads an amount
     * from the request.
     */
    SAFE_PRICE_PAISE: z.coerce
      .number()
      .int('SAFE_PRICE_PAISE must be an integer number of paise')
      .positive()
      // Razorpay's own floor for an INR order is 100 paise (Rs 1).
      .min(100, 'SAFE_PRICE_PAISE must be at least 100 (Rs 1)')
      .default(99900),
    CURRENCY: z.literal('INR').default('INR'),

    RAZORPAY_KEY_ID: z.string().min(1, 'RAZORPAY_KEY_ID is required'),
    RAZORPAY_KEY_SECRET: z.string().min(1, 'RAZORPAY_KEY_SECRET is required'),
    RAZORPAY_WEBHOOK_SECRET: z.string().min(1, 'RAZORPAY_WEBHOOK_SECRET is required'),
  })
  .superRefine((value, ctx) => {
    if (value.NODE_ENV !== 'production') return;

    // Live keys in a test deployment (or the reverse) is a costly mistake to
    // make quietly, and the placeholder secrets must never reach production.
    if (value.JWT_ACCESS_SECRET.includes('change_me')) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_ACCESS_SECRET'],
        message: 'JWT_ACCESS_SECRET still holds its placeholder value; set a real secret',
      });
    }

    if (value.OTP_HMAC_SECRET.includes('change_me')) {
      ctx.addIssue({
        code: 'custom',
        path: ['OTP_HMAC_SECRET'],
        message: 'OTP_HMAC_SECRET still holds its placeholder value; set a real secret',
      });
    }

    if (value.RAZORPAY_KEY_SECRET.includes('replace_me')) {
      ctx.addIssue({
        code: 'custom',
        path: ['RAZORPAY_KEY_SECRET'],
        message: 'RAZORPAY_KEY_SECRET still holds its placeholder value',
      });
    }

    // An empty allowlist in production would make originCheck reject every
    // state-changing request, and cors() refuse every browser.
    if (!value.WEB_ORIGIN && !value.CORS_ORIGINS) {
      ctx.addIssue({
        code: 'custom',
        path: ['WEB_ORIGIN'],
        message: 'WEB_ORIGIN is required in production (comma-separated exact origins)',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    // Prints the variable names and the reason, never the values.
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  return parsed.data;
}

export const env = loadEnv();

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

/**
 * The exact origins allowed to send credentialed, state-changing requests.
 *
 * `WEB_ORIGIN` is the current name; `CORS_ORIGINS` is accepted as a legacy
 * alias. Trailing slashes are stripped because a browser's `Origin` header
 * never carries one, so `https://app.example.com/` would otherwise never match.
 */
export const WEB_ORIGINS: readonly string[] = (env.WEB_ORIGIN ?? env.CORS_ORIGINS ?? 'http://localhost:3000')
  .split(',')
  .map((origin) => origin.trim().replace(/\/+$/, ''))
  .filter(Boolean);

/** Refresh token lifetime as milliseconds. */
export const REFRESH_TOKEN_TTL_MS = env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;

/** Access token / access cookie lifetime as milliseconds (15 minutes). */
export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;

/**
 * The connection string the Prisma client should use. Tests get their own
 * database so a test run can truncate tables without touching dev data.
 */
export function databaseUrl(): string {
  if (!isTest) return env.DATABASE_URL;

  if (!env.TEST_DATABASE_URL) {
    throw new Error('NODE_ENV=test requires TEST_DATABASE_URL to be set');
  }
  return env.TEST_DATABASE_URL;
}
