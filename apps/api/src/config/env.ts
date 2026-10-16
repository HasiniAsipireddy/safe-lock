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

    // --- WhatsApp (Meta Cloud API) -------------------------------------------
    /**
     * Which WhatsApp client to use.
     *
     * `fake` records messages in memory and sends nothing; it is **refused in
     * production** by `mayUseFakeWhatsApp` and by the superRefine below, the
     * same belt-and-braces as `mayPrintOtp`. An enum rather than a free string
     * so a typo is a boot failure instead of a silent fallback to the fake.
     */
    WHATSAPP_PROVIDER: z.enum(['fake', 'cloud']).default('fake'),

    /**
     * Graph API credentials. Required when the provider is `cloud` — see the
     * superRefine, which fails the boot rather than discovering a missing
     * token at the first unlock.
     */
    WHATSAPP_ACCESS_TOKEN: z.string().optional(),
    WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
    /** Keys the HMAC on `X-Hub-Signature-256` for the delivery webhook. */
    WHATSAPP_APP_SECRET: z.string().optional(),
    /** Echoed back during Meta's `GET` subscription handshake. */
    WHATSAPP_WEBHOOK_VERIFY_TOKEN: z.string().optional(),

    /**
     * Approved template names, one per message kind.
     *
     * From the environment, not hardcoded: template names are created and
     * approved in Meta's console, and nothing in this codebase should assume a
     * name that may not exist in a given WhatsApp Business account.
     */
    WHATSAPP_TEMPLATE_UNLOCK_OTP: z.string().default('safelock_unlock_code'),
    WHATSAPP_TEMPLATE_PHONE_OTP: z.string().default('safelock_phone_verification'),
    WHATSAPP_TEMPLATE_PASSWORD_RESET: z.string().default('safelock_password_reset'),
    WHATSAPP_TEMPLATE_UNLOCK_ALERT: z.string().default('safelock_unlock_alert'),
    WHATSAPP_TEMPLATE_FAILED_ATTEMPTS: z.string().default('safelock_failed_attempts'),

    /** Template language tag, as registered with Meta. */
    WHATSAPP_LANGUAGE: z.string().default('en'),
    /** Graph API version. Pinned, so Meta rolling forward cannot change behaviour. */
    WHATSAPP_API_VERSION: z.string().default('v21.0'),
    /** Per-request timeout. A send that hangs must not hold an unlock open. */
    WHATSAPP_TIMEOUT_MS: z.coerce.number().int().positive().max(60_000).default(8_000),

    /**
     * Messages per user per rolling 24 hours, across every kind.
     *
     * Each message costs money and lands on someone's phone, so an uncapped
     * send endpoint is both a billing risk and a way to use us to harass
     * someone. 10 clears an ordinary day (a verification, a few unlocks and
     * their alerts) with room to spare.
     */
    WHATSAPP_DAILY_SEND_CAP: z.coerce.number().int().positive().max(1000).default(10),

    /** How often the outbox worker looks for pending messages. */
    OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().max(600_000).default(5_000),
    /** Give-up point for one outbound message. Backoff is exponential. */
    OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().positive().max(20).default(5),

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
    /**
     * Cloud mode needs all four credentials, in every environment.
     *
     * Checked outside the production block on purpose: someone pointing a
     * staging box at the real Cloud API deserves the same fail-fast. A missing
     * app secret in particular would mean the delivery webhook could not
     * verify a signature, and "cannot verify" must never degrade to "accept".
     */
    if (value.WHATSAPP_PROVIDER === 'cloud') {
      const required = [
        ['WHATSAPP_ACCESS_TOKEN', value.WHATSAPP_ACCESS_TOKEN],
        ['WHATSAPP_PHONE_NUMBER_ID', value.WHATSAPP_PHONE_NUMBER_ID],
        ['WHATSAPP_APP_SECRET', value.WHATSAPP_APP_SECRET],
        ['WHATSAPP_WEBHOOK_VERIFY_TOKEN', value.WHATSAPP_WEBHOOK_VERIFY_TOKEN],
      ] as const;

      for (const [name, supplied] of required) {
        if (!supplied?.trim()) {
          ctx.addIssue({
            code: 'custom',
            path: [name],
            message: `${name} is required when WHATSAPP_PROVIDER=cloud`,
          });
        }
      }
    }

    if (value.NODE_ENV !== 'production') return;

    /**
     * The fake client must be unreachable in production.
     *
     * Two independent guards, like the OTP console print: this one refuses the
     * boot, and `mayUseFakeWhatsApp` refuses to construct it. A deployment
     * that silently recorded unlock codes to memory and sent nothing would
     * look healthy and open nothing.
     */
    if (value.WHATSAPP_PROVIDER === 'fake') {
      ctx.addIssue({
        code: 'custom',
        path: ['WHATSAPP_PROVIDER'],
        message:
          'WHATSAPP_PROVIDER=fake is not allowed in production; it sends no messages',
      });
    }

    for (const [name, supplied] of [
      ['WHATSAPP_ACCESS_TOKEN', value.WHATSAPP_ACCESS_TOKEN],
      ['WHATSAPP_APP_SECRET', value.WHATSAPP_APP_SECRET],
      ['WHATSAPP_WEBHOOK_VERIFY_TOKEN', value.WHATSAPP_WEBHOOK_VERIFY_TOKEN],
    ] as const) {
      if (supplied && /change_me|replace_me|placeholder/i.test(supplied)) {
        ctx.addIssue({
          code: 'custom',
          path: [name],
          message: `${name} still holds a placeholder value; set a real secret`,
        });
      }
    }

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
