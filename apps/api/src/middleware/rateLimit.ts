import crypto from 'node:crypto';
import rateLimit, { ipKeyGenerator, type Options, type Store } from 'express-rate-limit';
import { ERROR_CODES, type ApiErrorBody } from '@safelock/shared';

/**
 * Rate limiters, built from a factory so limits and stores are injectable.
 *
 * Deliberately **not** skipped under NODE_ENV=test: a limiter that is disabled
 * in the only environment that could test it is a limiter nobody has ever
 * seen work. Tests build an app with small limits instead and assert the 429.
 *
 * The in-memory store is per-process, so each `createApp()` gets its own
 * counters. A multi-instance deployment needs a shared store or the effective
 * limit is multiplied by the instance count.
 * TODO(scale): swap in a Redis store before running more than one instance.
 */

export interface LimitSpec {
  windowMs: number;
  limit: number;
}

export interface RateLimitConfig {
  /** Per-IP limiter on /auth/login and /auth/signup. */
  auth: LimitSpec;
  /** Per-identifier (hashed email/phone) limiter on the same two routes. */
  authIdentifier: LimitSpec;
  /** Per-IP limb on `POST /auth/password/forgot`. */
  passwordForgot: LimitSpec;
  /**
   * Per-address limb on the same route, keyed on `sha256(email)`.
   *
   * Deliberately its **own** bucket rather than sharing `authIdentifier` with
   * login: sharing would let reset requests exhaust a user's login quota, so
   * anyone could lock a known account out of signing in by asking for reset
   * links. It also bounds mailbox spam at a few messages an hour.
   */
  passwordForgotIdentifier: LimitSpec;
  /** Per-IP limiter on `POST /auth/password/reset`. */
  passwordReset: LimitSpec;
  /** Per-user limiter on `POST /auth/password/change`. */
  passwordChange: LimitSpec;
  /** Per-user limiter on `PATCH /auth/profile`. */
  profileUpdate: LimitSpec;
  /** Per-user limiter on `POST /account/phone/request-verification`. */
  phoneVerify: LimitSpec;
  /**
   * Per-IP limb on the same route. The per-user limb cannot see one host
   * walking through many compromised sessions; this one can.
   */
  phoneVerifyIp: LimitSpec;
  /** Per-user limiter on `POST /account/phone/confirm`. */
  phoneConfirm: LimitSpec;
  /** Per-user limiter on /payments/order. */
  createOrder: LimitSpec;
  /** Per-user limiter on /payments/verify. */
  verifyPayment: LimitSpec;
  /**
   * Per-admin limiter on admin write routes. Generous, because a legitimate
   * bulk import session is bursty — it exists to bound a runaway script or a
   * compromised admin session, not to pace normal work.
   */
  adminWrite: LimitSpec;
  /** Per-user limiter on `POST /devices/lock`. */
  deviceLock: LimitSpec;
  /** Per-user limiter on `POST /devices/unlock/request`. */
  unlockRequest: LimitSpec;
  /**
   * Per-IP limb on the same route. The per-user limb cannot see one host
   * walking through many compromised accounts; this one can.
   */
  unlockRequestIp: LimitSpec;
  /** Per-user limiter on `POST /devices/unlock/confirm`. */
  unlockConfirm: LimitSpec;
  /** Per-user limiter on `GET /devices/history`. */
  deviceHistory: LimitSpec;
  /**
   * Per-user limiter on the notification routes. The web client polls these
   * every 60s per visible tab, so the limit has to clear several tabs doing
   * that and still bound a client stuck in a loop.
   */
  notifications: LimitSpec;
}

export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  auth: { windowMs: 15 * 60 * 1000, limit: 10 },
  // Tighter than the per-IP limb: a single account being hammered from many
  // addresses is the attack the per-IP limiter cannot see.
  authIdentifier: { windowMs: 15 * 60 * 1000, limit: 5 },

  // Reset requests cost the recipient a message they did not ask for, so the
  // per-address limb is the tight one: 3 an hour is plenty for someone who
  // genuinely cannot find the first mail.
  passwordForgot: { windowMs: 15 * 60 * 1000, limit: 5 },
  passwordForgotIdentifier: { windowMs: 60 * 60 * 1000, limit: 3 },
  // Guessing a 32-byte token is not a threat a rate limit defeats or needs to;
  // this bounds a broken client retrying a dead link.
  passwordReset: { windowMs: 15 * 60 * 1000, limit: 10 },
  // Each attempt costs an argon2 verify, and a wrong current password is a
  // 400 the limiter should not let anyone grind through.
  passwordChange: { windowMs: 15 * 60 * 1000, limit: 10 },
  profileUpdate: { windowMs: 15 * 60 * 1000, limit: 20 },

  // Each verification request sends a WhatsApp message, so this is tight —
  // the daily cap is the hard ceiling, and this paces the burst. Mirrors the
  // unlock OTP's 3-per-10-minutes.
  phoneVerify: { windowMs: 10 * 60 * 1000, limit: 3 },
  phoneVerifyIp: { windowMs: 10 * 60 * 1000, limit: 10 },
  // Above the 5 attempts one challenge allows, so the per-challenge counter is
  // what normally stops a guesser and this is the backstop against cycling.
  phoneConfirm: { windowMs: 10 * 60 * 1000, limit: 15 },

  createOrder: { windowMs: 10 * 60 * 1000, limit: 5 },
  verifyPayment: { windowMs: 10 * 60 * 1000, limit: 20 },
  adminWrite: { windowMs: 5 * 60 * 1000, limit: 60 },

  // Locking is harmless and idempotent — the limit only bounds a runaway
  // client, so it is generous.
  deviceLock: { windowMs: 5 * 60 * 1000, limit: 30 },
  // Per CLAUDE.md's OTP rules: 3 codes per 10 minutes per user. Each request
  // invalidates the previous code, so a loose limit here would hand an
  // attacker a fresh set of 5 guesses on demand.
  unlockRequest: { windowMs: 10 * 60 * 1000, limit: 3 },
  unlockRequestIp: { windowMs: 10 * 60 * 1000, limit: 10 },
  // Above the 5 attempts a single challenge allows, so the per-challenge
  // counter is what normally stops a guesser and this is the backstop against
  // request/confirm cycling.
  unlockConfirm: { windowMs: 10 * 60 * 1000, limit: 15 },

  // Reads of the caller's own data, so the limit only bounds a runaway client
  // or a scraper hammering "Load more". Generous enough that paging through a
  // long history by hand never trips it.
  deviceHistory: { windowMs: 5 * 60 * 1000, limit: 60 },
  // 5 minutes of 60s polling is 5 requests per tab, plus a fetch on every
  // visibility change and bell open. 120 clears a handful of tabs comfortably.
  notifications: { windowMs: 5 * 60 * 1000, limit: 120 },
};

const TOO_MANY_ATTEMPTS = 'Too many attempts. Please wait a few minutes and try again.';
const TOO_MANY_PAYMENTS = 'Too many payment attempts. Please wait a few minutes and try again.';

function rejection(message: string): Pick<Options, 'handler'> {
  return {
    handler: (req, res) => {
      const body: ApiErrorBody = {
        error: { code: ERROR_CODES.RATE_LIMITED, message, requestId: req.id },
      };
      res.status(429).json(body);
    },
  };
}

function build(spec: LimitSpec, message: string, extra: Partial<Options>, store?: Store) {
  return rateLimit({
    windowMs: spec.windowMs,
    limit: spec.limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    ...rejection(message),
    ...(store ? { store } : {}),
    ...extra,
  });
}

/**
 * About the inline `ipKeyGenerator(req.ip)` calls below.
 *
 * It collapses an IPv6 address to its /64 prefix — keying on the raw address
 * would let an IPv6 client rotate through the addresses it already controls
 * and get a fresh quota for each one.
 *
 * The call is repeated inline in every `keyGenerator` rather than factored
 * into a helper on purpose: express-rate-limit statically inspects each
 * keyGenerator's source for this call and emits ERR_ERL_KEY_GEN_IPV6 at
 * startup if it cannot see it. Behind a helper the behaviour is correct but
 * the warning fires anyway, which trains people to ignore startup warnings.
 */

/**
 * Extracts the account identifier a request is attempting, for the
 * per-identifier limiter.
 *
 * Login sends `identifier` (email or phone); signup sends `email` and `phone`.
 * The value is lowercased and trimmed first so `Foo@Example.com ` and
 * `foo@example.com` share one bucket.
 */
function extractIdentifier(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const candidate = body as Record<string, unknown>;

  for (const field of ['identifier', 'email', 'phone'] as const) {
    const value = candidate[field];
    if (typeof value === 'string' && value.trim()) {
      return value.trim().toLowerCase();
    }
  }
  return null;
}

/**
 * Hashes the identifier before it is used as a rate-limit key.
 *
 * The key lives in the limiter's store (and would live in Redis later). A
 * plaintext email there is a list of registered users sitting outside the
 * database; a SHA-256 is not.
 */
export function hashIdentifier(identifier: string): string {
  return crypto.createHash('sha256').update(identifier).digest('hex');
}

export interface Limiters {
  auth: ReturnType<typeof rateLimit>;
  authIdentifier: ReturnType<typeof rateLimit>;
  passwordForgot: ReturnType<typeof rateLimit>;
  passwordForgotIdentifier: ReturnType<typeof rateLimit>;
  passwordReset: ReturnType<typeof rateLimit>;
  passwordChange: ReturnType<typeof rateLimit>;
  profileUpdate: ReturnType<typeof rateLimit>;
  phoneVerify: ReturnType<typeof rateLimit>;
  phoneVerifyIp: ReturnType<typeof rateLimit>;
  phoneConfirm: ReturnType<typeof rateLimit>;
  createOrder: ReturnType<typeof rateLimit>;
  verifyPayment: ReturnType<typeof rateLimit>;
  adminWrite: ReturnType<typeof rateLimit>;
  deviceLock: ReturnType<typeof rateLimit>;
  unlockRequest: ReturnType<typeof rateLimit>;
  unlockRequestIp: ReturnType<typeof rateLimit>;
  unlockConfirm: ReturnType<typeof rateLimit>;
  deviceHistory: ReturnType<typeof rateLimit>;
  notifications: ReturnType<typeof rateLimit>;
}

export function createLimiters(
  config: RateLimitConfig = DEFAULT_RATE_LIMITS,
  stores: Partial<Record<keyof RateLimitConfig, Store>> = {},
): Limiters {
  return {
    auth: build(
      config.auth,
      TOO_MANY_ATTEMPTS,
      { keyGenerator: (req) => (req.ip ? `ip:${ipKeyGenerator(req.ip)}` : 'ip:unknown') },
      stores.auth,
    ),

    /**
     * Per-identifier limb.
     *
     * The 429 is byte-identical whether or not the account exists — the
     * limiter runs before any database lookup, and the response carries no
     * account-specific detail. Otherwise this endpoint would become an
     * account-enumeration oracle: "rate limited" would mean "real account".
     *
     * A request with no parseable identifier (malformed body) is keyed by IP
     * so it still costs the caller something.
     */
    authIdentifier: build(
      config.authIdentifier,
      TOO_MANY_ATTEMPTS,
      {
        keyGenerator: (req) => {
          const identifier = extractIdentifier(req.body);
          if (identifier) return `id:${hashIdentifier(identifier)}`;
          return req.ip ? `ip:${ipKeyGenerator(req.ip)}` : 'ip:unknown';
        },
      },
      stores.authIdentifier,
    ),

    passwordForgot: build(
      config.passwordForgot,
      TOO_MANY_ATTEMPTS,
      { keyGenerator: (req) => (req.ip ? `ip:${ipKeyGenerator(req.ip)}` : 'ip:unknown') },
      stores.passwordForgot,
    ),

    /**
     * Per-address limb. Like `authIdentifier` it runs before any database
     * lookup, so its 429 cannot reveal whether the address has an account —
     * which would undo the whole point of the endpoint's identical responses.
     */
    passwordForgotIdentifier: build(
      config.passwordForgotIdentifier,
      TOO_MANY_ATTEMPTS,
      {
        keyGenerator: (req) => {
          const identifier = extractIdentifier(req.body);
          if (identifier) return `reset:${hashIdentifier(identifier)}`;
          return req.ip ? `ip:${ipKeyGenerator(req.ip)}` : 'ip:unknown';
        },
      },
      stores.passwordForgotIdentifier,
    ),

    passwordReset: build(
      config.passwordReset,
      TOO_MANY_ATTEMPTS,
      { keyGenerator: (req) => (req.ip ? `ip:${ipKeyGenerator(req.ip)}` : 'ip:unknown') },
      stores.passwordReset,
    ),

    passwordChange: build(
      config.passwordChange,
      TOO_MANY_ATTEMPTS,
      {
        keyGenerator: (req) => {
          if (req.user?.id) return `u:${req.user.id}`;
          return req.ip ? `ip:${ipKeyGenerator(req.ip)}` : 'ip:unknown';
        },
      },
      stores.passwordChange,
    ),

    profileUpdate: build(
      config.profileUpdate,
      TOO_MANY_ATTEMPTS,
      {
        keyGenerator: (req) => {
          if (req.user?.id) return `u:${req.user.id}`;
          return req.ip ? `ip:${ipKeyGenerator(req.ip)}` : 'ip:unknown';
        },
      },
      stores.profileUpdate,
    ),

    /**
     * Phone verification refunds a 5xx on the per-user limb, like the unlock
     * request does: a WhatsApp outage answering 502 must not spend the user's
     * three-per-ten-minutes. Every 4xx still counts.
     */
    phoneVerify: build(
      config.phoneVerify,
      'Too many verification codes requested. Please wait a few minutes and try again.',
      {
        keyGenerator: (req) => {
          if (req.user?.id) return `u:${req.user.id}`;
          return req.ip ? `ip:${ipKeyGenerator(req.ip)}` : 'ip:unknown';
        },
        skipFailedRequests: true,
        requestWasSuccessful: (_req, res) => res.statusCode < 500,
      },
      stores.phoneVerify,
    ),

    phoneVerifyIp: build(
      config.phoneVerifyIp,
      'Too many verification codes requested. Please wait a few minutes and try again.',
      {
        keyGenerator: (req) => (req.ip ? `ip:${ipKeyGenerator(req.ip)}` : 'ip:unknown'),
        skipFailedRequests: true,
        requestWasSuccessful: (_req, res) => res.statusCode < 500,
      },
      stores.phoneVerifyIp,
    ),

    phoneConfirm: build(
      config.phoneConfirm,
      'Too many code attempts. Please wait a few minutes and try again.',
      {
        keyGenerator: (req) => {
          if (req.user?.id) return `u:${req.user.id}`;
          return req.ip ? `ip:${ipKeyGenerator(req.ip)}` : 'ip:unknown';
        },
      },
      stores.phoneConfirm,
    ),

    createOrder: build(
      config.createOrder,
      TOO_MANY_PAYMENTS,
      {
        keyGenerator: (req) => {
          if (req.user?.id) return `u:${req.user.id}`;
          return req.ip ? `ip:${ipKeyGenerator(req.ip)}` : 'ip:unknown';
        },
      },
      stores.createOrder,
    ),

    verifyPayment: build(
      config.verifyPayment,
      'Too many verification attempts. Please wait a few minutes and try again.',
      {
        keyGenerator: (req) => {
          if (req.user?.id) return `u:${req.user.id}`;
          return req.ip ? `ip:${ipKeyGenerator(req.ip)}` : 'ip:unknown';
        },
      },
      stores.verifyPayment,
    ),

    adminWrite: build(
      config.adminWrite,
      'Too many admin actions in a short time. Please wait a moment and try again.',
      {
        keyGenerator: (req) => {
          if (req.user?.id) return `admin:${req.user.id}`;
          return req.ip ? `ip:${ipKeyGenerator(req.ip)}` : 'ip:unknown';
        },
      },
      stores.adminWrite,
    ),

    deviceLock: build(
      config.deviceLock,
      'Too many lock requests. Please wait a moment and try again.',
      {
        keyGenerator: (req) => {
          if (req.user?.id) return `u:${req.user.id}`;
          return req.ip ? `ip:${ipKeyGenerator(req.ip)}` : 'ip:unknown';
        },
      },
      stores.deviceLock,
    ),

    /**
     * Both unlock-request limbs **refund a 5xx**.
     *
     * A WhatsApp outage answers 502 `OTP_DELIVERY_FAILED`. Charging that
     * against the user's three-codes-per-ten-minutes allowance would mean our
     * upstream failure locking them out of their own safe — three failed
     * sends and they are done for ten minutes, having received nothing.
     *
     * Scoped to 5xx deliberately, via `requestWasSuccessful`: every 4xx still
     * counts, so a caller cycling request/confirm with wrong codes is still
     * bounded exactly as before. There is a test for both halves.
     */
    unlockRequest: build(
      config.unlockRequest,
      'Too many unlock codes requested. Please wait a few minutes and try again.',
      {
        keyGenerator: (req) => {
          if (req.user?.id) return `u:${req.user.id}`;
          return req.ip ? `ip:${ipKeyGenerator(req.ip)}` : 'ip:unknown';
        },
        skipFailedRequests: true,
        requestWasSuccessful: (_req, res) => res.statusCode < 500,
      },
      stores.unlockRequest,
    ),

    unlockRequestIp: build(
      config.unlockRequestIp,
      'Too many unlock codes requested. Please wait a few minutes and try again.',
      {
        keyGenerator: (req) => (req.ip ? `ip:${ipKeyGenerator(req.ip)}` : 'ip:unknown'),
        skipFailedRequests: true,
        requestWasSuccessful: (_req, res) => res.statusCode < 500,
      },
      stores.unlockRequestIp,
    ),

    unlockConfirm: build(
      config.unlockConfirm,
      'Too many code attempts. Please wait a few minutes and try again.',
      {
        keyGenerator: (req) => {
          if (req.user?.id) return `u:${req.user.id}`;
          return req.ip ? `ip:${ipKeyGenerator(req.ip)}` : 'ip:unknown';
        },
      },
      stores.unlockConfirm,
    ),

    deviceHistory: build(
      config.deviceHistory,
      'Too many history requests. Please wait a moment and try again.',
      {
        keyGenerator: (req) => {
          if (req.user?.id) return `u:${req.user.id}`;
          return req.ip ? `ip:${ipKeyGenerator(req.ip)}` : 'ip:unknown';
        },
      },
      stores.deviceHistory,
    ),

    notifications: build(
      config.notifications,
      'Too many notification requests. Please wait a moment and try again.',
      {
        keyGenerator: (req) => {
          if (req.user?.id) return `u:${req.user.id}`;
          return req.ip ? `ip:${ipKeyGenerator(req.ip)}` : 'ip:unknown';
        },
      },
      stores.notifications,
    ),
  };
}
