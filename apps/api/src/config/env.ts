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
     * The one canonical base URL for links we put in messages.
     *
     * Deliberately **not** `WEB_ORIGIN`: that is a comma-separated CSRF/CORS
     * allowlist which may legitimately hold several origins (an apex and a
     * www, a preview host), and a WhatsApp deep link needs exactly one. Taking
     * the first entry of a list would make the link depend on the order
     * someone happened to type an unrelated setting in.
     *
     * Outside production it defaults to `http://localhost:3000`, so local dev
     * needs no setup (see `PUBLIC_WEB_URL` below). In production the boot
     * fails unless it is set, `https:`, not a loopback host, and free of
     * placeholder text — a message carrying a link to `localhost` is a dead
     * end on someone's phone, and the whole point of these messages is the
     * page they point at.
     */
    PUBLIC_WEB_URL: z.string().optional(),

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
     * Which hardware gateway to talk to. An enum rather than a free string so
     * a typo is a boot failure, not a silent fallback to the mock in
     * production — which would look healthy and open nothing.
     */
    DEVICE_GATEWAY: z.enum(['mock', 'mqtt']).default('mock'),

    // --- Device command protocol (docs/device-protocol.md) -------------------

    /**
     * Master secret for per-device command keys.
     *
     * Every device's `K_d` is `HMAC-SHA256(this, "safelock:device-cmd:v1:" +
     * keyVersion + ":" + serial)` — **one secret here, one key per device, no
     * per-device key at rest anywhere**. The same move `OTP_HMAC_SECRET`
     * makes, and for a stronger reason: HMAC verification needs the key
     * itself, not a digest of it, so storing random per-device keys would mean
     * either plaintext secrets in a table or an envelope-encryption
     * dependency. A database leak yields no device key because no device key
     * is in the database.
     *
     * Deliberately **separate** from `OTP_HMAC_SECRET`. These protect
     * different things on different lifecycles, and one secret for both means
     * rotating it breaks both at once — plus rotating this one is a fleet
     * re-provisioning, which is not an operation anyone should trip into while
     * rotating an OTP key.
     *
     * Optional while the gateway is `mock`, required for `mqtt` — see the
     * superRefine. A mock has no signature to verify.
     */
    DEVICE_COMMAND_HMAC_SECRET: z.string().optional(),

    /**
     * The `keyVersion` new credentials are derived at.
     *
     * Part of the derivation *and* of every command on the wire, so the master
     * secret can be rotated without a flag day: the server signs each device
     * at the version that device actually holds (`Device.commandKeyVersion`)
     * while this governs what the next provisioning hands out. Without a
     * version in the message a device could not tell which key to verify
     * against, and rotating the master would brick the fleet.
     */
    DEVICE_COMMAND_KEY_VERSION: z.coerce.number().int().min(1).max(1_000).default(1),

    /**
     * How long a command may take before the server gives up on it.
     *
     * 15 000 ms, the figure CLAUDE.md has carried since step 4, chosen to sit
     * under the ~20s a person will stare at a spinner. Also the `ttlMs` the
     * device is handed, which it enforces from its monotonic counter.
     */
    COMMAND_TTL_MS: z.coerce.number().int().min(1_000).max(120_000).default(15_000),

    /**
     * How long after a command's expiry an ack is still correlated to it.
     *
     * Past ten minutes the correlation is not worth trusting, so the ack is
     * dropped *for command purposes* and audited — but the **state it reports
     * is still applied**, because the measurement is trustworthy even when the
     * correlation is not. The same shape of decision as the reminder staleness
     * floor: late is false, but the underlying thing is still real.
     */
    COMMAND_LATE_ACK_MAX_MS: z.coerce
      .number()
      .int()
      .min(60_000)
      .max(3_600_000)
      .default(600_000),

    /** How often the command timeout sweeper runs. */
    COMMAND_SWEEP_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .max(600_000)
      .default(5_000),

    /**
     * Give-up point for a **system** command's retries. Backoff is 10s, 60s,
     * 300s. A user command never retries: nobody is waiting on a system lock,
     * and the correct end state for it is not a judgement call.
     */
    COMMAND_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),

    /**
     * Consecutive failed commands before a device is flagged for admins.
     *
     * One timeout is a lost packet; three in a row is a safe that needs a
     * human. Flagging on the first would make the flagged list worthless,
     * which is the same failure as a notification per mistyped digit.
     */
    COMMAND_FAILURE_FLAG_THRESHOLD: z.coerce.number().int().min(1).max(20).default(3),

    /** How often a device publishes an unprompted state report, in seconds. */
    DEVICE_HEARTBEAT_SECONDS: z.coerce.number().int().min(10).max(3_600).default(60),

    /**
     * How long since the last verified inbound message before a device counts
     * as offline.
     *
     * Three missed heartbeats, so one lost packet is not an outage. `online`
     * is derived from this on every read rather than trusted from the stored
     * boolean — the same reflex as `effectiveBookingStatus`, and for the same
     * reason: a stored flag is a claim about a moment, and the question is
     * about now.
     */
    DEVICE_OFFLINE_AFTER_SECONDS: z.coerce
      .number()
      .int()
      .min(30)
      .max(86_400)
      .default(180),

    /**
     * The broker, and the API's **own privileged credential** — never a
     * device's. The server may write to any `cmd` and read any report, and is
     * denied the ability to write to `ack`/`state`/`status`: there is no
     * reason for it to forge a device report, so a compromised API credential
     * cannot fabricate the security record, only issue commands it could issue
     * anyway.
     *
     * All three required when `DEVICE_GATEWAY=mqtt`, so a half-configured
     * deploy fails at boot rather than at the first unlock.
     */
    MQTT_URL: z.string().optional(),
    MQTT_USERNAME: z.string().optional(),
    MQTT_PASSWORD: z.string().optional(),
    /** Per-publish timeout. A broker that hangs must not hold a request open. */
    MQTT_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(5_000),

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

    /**
     * Rental lifecycle templates. All UTILITY, all purely informational — a
     * body that urges an upsell risks Meta reclassifying the template as
     * MARKETING, which would make it opt-out-able and stop a fee notice
     * reaching someone who muted promotions.
     */
    WHATSAPP_TEMPLATE_BOOKING_CONFIRMED: z.string().default('safelock_booking_confirmed'),
    WHATSAPP_TEMPLATE_BOOKING_ENDING_SOON: z.string().default('safelock_booking_ending_soon'),
    WHATSAPP_TEMPLATE_OVERSTAY_STARTED: z.string().default('safelock_overstay_started'),
    WHATSAPP_TEMPLATE_OVERSTAY_SETTLED: z.string().default('safelock_overstay_settled'),
    WHATSAPP_TEMPLATE_COLLECTION_CLOSING: z.string().default('safelock_collection_closing'),

    /** Template language tag, as registered with Meta. */
    WHATSAPP_LANGUAGE: z.string().default('en'),
    /** Graph API version. Pinned, so Meta rolling forward cannot change behaviour. */
    WHATSAPP_API_VERSION: z.string().default('v21.0'),
    /** Per-request timeout. A send that hangs must not hold an unlock open. */
    WHATSAPP_TIMEOUT_MS: z.coerce.number().int().positive().max(60_000).default(8_000),

    /**
     * **User-triggered** messages per user per rolling 24 hours.
     *
     * Each message costs money and lands on someone's phone, so an uncapped
     * send endpoint is both a billing risk and a way to use us to harass
     * someone. 10 clears an ordinary day (a verification, a few unlocks and
     * their alerts) with room to spare.
     *
     * Everything a user's own action produces stays under this budget:
     * `PHONE_OTP`, `PASSWORD_RESET`, and — the ones worth being explicit
     * about — `UNLOCK_ALERT` and `FAILED_ATTEMPTS_ALERT`. Those two follow an
     * unlock attempt somebody made, so they are user-triggered traffic and
     * must not drift into the uncapped or the booking budget.
     * `UNLOCK_OTP` alone passes `ignoreCap`, as it always has: a cap that can
     * stop someone opening a safe they are standing at is a lock-out, not
     * abuse protection. Its rows are still counted *against* this budget.
     *
     * Booking lifecycle messages are scoped out of this count and into
     * `WHATSAPP_BOOKING_SEND_CAP` below — letting a chatty rental consume this
     * one would mean a user's verification code dropped by their own
     * extensions. Narrowing what this counts makes the protection sharper,
     * not weaker.
     */
    WHATSAPP_DAILY_SEND_CAP: z.coerce.number().int().positive().max(1000).default(10),

    /**
     * Booking lifecycle messages per user per rolling 24 hours.
     *
     * A separate budget, not an exemption. These rows can only be created by a
     * server-side booking state change — there is no endpoint that emits one —
     * but a pathological day (two dozen extensions) should still be bounded.
     * 20 clears a normal rental several times over: a confirmation, two
     * reminders and an overstay notice is four.
     *
     * **Counts rows actually `SENT`**, never `SKIPPED` or cancelled ones, so
     * repeated extensions — which cancel and re-create unsent reminders — do
     * not eat the budget. A message dropped by this cap is recorded
     * `SKIPPED`/`CAP_REACHED` and shown to admins rather than vanishing.
     */
    WHATSAPP_BOOKING_SEND_CAP: z.coerce.number().int().positive().max(1000).default(20),

    /**
     * How late a *scheduled* booking message may be claimed and still sent.
     *
     * Past it, the row is `SKIPPED`/`STALE` and nothing is sent: "your booking
     * ends in 10 minutes", arriving after it ended, is not a late message but
     * a false one. Must stay comfortably above `OUTBOX_POLL_INTERVAL_MS`
     * (5s by default, so 5 minutes is sixty polls of headroom) or an ordinary
     * restart would start discarding reminders. Only scheduled kinds are
     * subject to it — a message describing an event that already happened has
     * no deadline to miss.
     */
    REMINDER_MAX_LATENESS_MINUTES: z.coerce.number().int().min(1).max(120).default(5),

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

    // --- Rental pricing -------------------------------------------------------
    /**
     * Hourly rental rate in PAISE. The single source of truth for what a safe
     * costs — the booking service never reads an amount from a request.
     *
     * **PROVISIONAL**, exactly like the one-time price it replaces: 10000 paise
     * (Rs 100/hour) is a development placeholder, not a business decision. It
     * is snapshotted onto every booking, so changing it never re-prices a live
     * one. See CLAUDE.md's open questions.
     */
    RENTAL_HOURLY_RATE_PAISE: z.coerce
      .number()
      .int('RENTAL_HOURLY_RATE_PAISE must be an integer number of paise')
      .positive()
      // Razorpay's own floor for an INR order is 100 paise (Rs 1).
      .min(100, 'RENTAL_HOURLY_RATE_PAISE must be at least 100 (Rs 1)')
      .default(10_000),

    /** Shortest and longest a single booking or extension may be. */
    RENTAL_MIN_HOURS: z.coerce.number().int().min(1).max(24).default(1),
    RENTAL_MAX_HOURS: z.coerce.number().int().min(1).max(24).default(24),

    /**
     * Overstay surcharge in **basis points**: 15000 = 1.5x the hourly rate.
     *
     * Basis points rather than a decimal because money must never touch a
     * float, and a fractional paisa cannot be charged.
     */
    OVERSTAY_MULTIPLIER_BPS: z.coerce.number().int().min(10_000).max(100_000).default(15_000),
    /** Minutes after `endsAt` before any fee accrues. */
    OVERSTAY_GRACE_MINUTES: z.coerce.number().int().min(0).max(240).default(15),
    /** Most hours of overstay that can ever be charged. Bounds the bill. */
    OVERSTAY_CAP_HOURS: z.coerce.number().int().min(1).max(168).default(24),
    /** Minutes to collect belongings after an overstay fee is settled. */
    COLLECTION_WINDOW_MINUTES: z.coerce.number().int().min(5).max(240).default(30),

    /**
     * How long an unpaid booking holds its device.
     *
     * The device is reserved from creation so a user who pays is never told
     * "sorry, gone". The Razorpay order expiry is set to match, so a payment
     * cannot easily arrive after the hold has lapsed.
     */
    BOOKING_HOLD_MINUTES: z.coerce.number().int().min(2).max(60).default(10),

    /**
     * How long an overstay quote is binding.
     *
     * Fees keep accruing while the user is at the checkout, so the quoted
     * amount is honoured for this long and the Razorpay order carries the same
     * expiry. A capture after it, whose amount no longer covers the fee, is
     * flagged for a manual refund rather than silently settling less than is
     * owed. See docs/decisions.md.
     */
    OVERSTAY_QUOTE_TTL_MINUTES: z.coerce.number().int().min(5).max(60).default(15),

    /** How often the booking sweeper runs. Correctness never depends on it. */
    BOOKING_SWEEP_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .max(600_000)
      .default(60_000),

    CURRENCY: z.literal('INR').default('INR'),

    RAZORPAY_KEY_ID: z.string().min(1, 'RAZORPAY_KEY_ID is required'),
    RAZORPAY_KEY_SECRET: z.string().min(1, 'RAZORPAY_KEY_SECRET is required'),
    RAZORPAY_WEBHOOK_SECRET: z.string().min(1, 'RAZORPAY_WEBHOOK_SECRET is required'),
  })
  .superRefine((value, ctx) => {
    if (value.RENTAL_MIN_HOURS > value.RENTAL_MAX_HOURS) {
      ctx.addIssue({
        code: 'custom',
        path: ['RENTAL_MIN_HOURS'],
        message: 'RENTAL_MIN_HOURS must not exceed RENTAL_MAX_HOURS',
      });
    }

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

    /**
     * MQTT mode needs a broker, a credential and a command secret, in every
     * environment.
     *
     * Checked outside the production block for the same reason as the WhatsApp
     * credentials: someone pointing a staging box at a real broker deserves
     * the same fail-fast. A missing `DEVICE_COMMAND_HMAC_SECRET` in particular
     * would mean commands could not be signed — and an unsigned command is one
     * a compromised broker could forge, which is the single thing the
     * signature exists to prevent.
     */
    if (value.DEVICE_GATEWAY === 'mqtt') {
      const required = [
        ['MQTT_URL', value.MQTT_URL],
        ['MQTT_USERNAME', value.MQTT_USERNAME],
        ['MQTT_PASSWORD', value.MQTT_PASSWORD],
      ] as const;

      for (const [name, supplied] of required) {
        if (!supplied?.trim()) {
          ctx.addIssue({
            code: 'custom',
            path: [name],
            message: `${name} is required when DEVICE_GATEWAY=mqtt`,
          });
        }
      }

      const commandSecret = value.DEVICE_COMMAND_HMAC_SECRET?.trim();

      if (!commandSecret) {
        ctx.addIssue({
          code: 'custom',
          path: ['DEVICE_COMMAND_HMAC_SECRET'],
          message: 'DEVICE_COMMAND_HMAC_SECRET is required when DEVICE_GATEWAY=mqtt',
        });
      } else if (commandSecret.length < 32) {
        ctx.addIssue({
          code: 'custom',
          path: ['DEVICE_COMMAND_HMAC_SECRET'],
          message: 'DEVICE_COMMAND_HMAC_SECRET must be at least 32 characters',
        });
      }

      /**
       * A plaintext broker would hand every command, every ack and every
       * device credential to anyone on the path. The signature would survive
       * that — it is designed to survive a fully compromised broker — but the
       * credential would not, and a stolen credential is a device identity.
       */
      const url = value.MQTT_URL?.trim();
      if (url && !/^(mqtts|wss|tls|ssl):/i.test(url) && value.NODE_ENV === 'production') {
        ctx.addIssue({
          code: 'custom',
          path: ['MQTT_URL'],
          message: 'MQTT_URL must use TLS (mqtts:// or wss://) in production',
        });
      }
    }

    /**
     * The device command secret must not be reused from the OTP secret.
     *
     * Domain separation in the derivation means an accidental overlap is not
     * immediately exploitable, but it collapses two rotation schedules into
     * one, and the whole point of a separate variable is that rotating a
     * fleet's keys and rotating an OTP key are different operations.
     */
    if (
      value.DEVICE_COMMAND_HMAC_SECRET &&
      value.DEVICE_COMMAND_HMAC_SECRET === value.OTP_HMAC_SECRET
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['DEVICE_COMMAND_HMAC_SECRET'],
        message:
          'DEVICE_COMMAND_HMAC_SECRET must differ from OTP_HMAC_SECRET; they rotate independently',
      });
    }

    if (value.NODE_ENV !== 'production') return;

    /**
     * The mock gateway must be unreachable in production, exactly as the fake
     * WhatsApp client is.
     *
     * A mock that acks every command would report every safe as locked without
     * a single bolt moving — a deployment that looks perfectly healthy and
     * secures nothing. For a product that physically opens safes this is the
     * worst available silent failure, so it is a boot failure instead.
     */
    if (value.DEVICE_GATEWAY === 'mock') {
      ctx.addIssue({
        code: 'custom',
        path: ['DEVICE_GATEWAY'],
        message:
          'DEVICE_GATEWAY=mock is not allowed in production; it acks every command without a device',
      });
    }

    if (value.DEVICE_COMMAND_HMAC_SECRET?.includes('change_me')) {
      ctx.addIssue({
        code: 'custom',
        path: ['DEVICE_COMMAND_HMAC_SECRET'],
        message:
          'DEVICE_COMMAND_HMAC_SECRET still holds its placeholder value; set a real secret',
      });
    }

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

    /**
     * A booking message with a broken link is worse than no message: it tells
     * someone their fee has started and then strands them. So the base URL is
     * checked at boot, not at the first send.
     */
    const publicWebUrl = value.PUBLIC_WEB_URL?.trim();

    if (!publicWebUrl) {
      ctx.addIssue({
        code: 'custom',
        path: ['PUBLIC_WEB_URL'],
        message:
          'PUBLIC_WEB_URL is required in production (the canonical https base for links in messages)',
      });
    } else if (/change_me|replace_me|placeholder|example\.com/i.test(publicWebUrl)) {
      ctx.addIssue({
        code: 'custom',
        path: ['PUBLIC_WEB_URL'],
        message: 'PUBLIC_WEB_URL still holds a placeholder value; set the real site URL',
      });
    } else {
      let parsed: URL | null = null;
      try {
        parsed = new URL(publicWebUrl);
      } catch {
        parsed = null;
      }

      if (!parsed) {
        ctx.addIssue({
          code: 'custom',
          path: ['PUBLIC_WEB_URL'],
          message: 'PUBLIC_WEB_URL must be an absolute URL, e.g. https://app.example.test',
        });
      } else if (parsed.protocol !== 'https:') {
        ctx.addIssue({
          code: 'custom',
          path: ['PUBLIC_WEB_URL'],
          message: 'PUBLIC_WEB_URL must be https: in production',
        });
      } else if (/^(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(parsed.hostname)) {
        ctx.addIssue({
          code: 'custom',
          path: ['PUBLIC_WEB_URL'],
          message: 'PUBLIC_WEB_URL must not be a loopback host in production',
        });
      }
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

/**
 * The canonical site base for links in outbound messages, without a trailing
 * slash.
 *
 * Falls back to `http://localhost:3000` outside production so a fresh clone
 * needs no configuration; production cannot reach the fallback, because the
 * superRefine above refuses to boot without a real value.
 */
export const PUBLIC_WEB_URL: string = (
  env.PUBLIC_WEB_URL?.trim() || 'http://localhost:3000'
).replace(/\/+$/, '');

/** How long since the last verified device message before it counts offline. */
export const DEVICE_OFFLINE_AFTER_MS = env.DEVICE_OFFLINE_AFTER_SECONDS * 1000;

/**
 * Backoff between retries of a **system** command, in milliseconds.
 *
 * In code rather than the environment: these are three numbers that only make
 * sense together with `COMMAND_MAX_ATTEMPTS`, and a deployment that set a
 * 5-second cap and a 300-second backoff would have configured a retry that
 * never happens. Indexed by attempts already made.
 */
export const COMMAND_RETRY_BACKOFF_MS = [10_000, 60_000, 300_000] as const;

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
