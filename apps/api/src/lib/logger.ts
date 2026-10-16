import pino from 'pino';
import { env, isTest } from '../config/env';

/**
 * Structured logging on pino.
 *
 * Two layers of redaction, deliberately overlapping:
 *
 * 1. **pino `redact` paths** — exact, fast, covers the well-known offenders
 *    (`password`, `authorization`, `cookie`, `set-cookie`) wherever they sit
 *    in the standard req/res serialisations.
 * 2. **A regex key filter in `formatters.log`** — catches anything whose *name*
 *    looks sensitive, at any depth, including keys nobody thought to list.
 *    This is the backstop: new code can log a `{ razorpaySignature }` field
 *    without a reviewer having to remember to extend a path list.
 *
 * Neither layer is a licence to pass secrets to the logger. They exist so that
 * a mistake is redacted rather than published.
 */

const REDACTED = '[redacted]';

/**
 * Keys whose values are replaced before anything is written.
 *
 * `hash` is included so a password hash never lands in a log line; `otp` is
 * here ahead of the OTP work so the rule exists before the feature does.
 *
 * `phone`, `mobile`, `recipient`, `to` and `msisdn` cover WhatsApp delivery:
 * a full phone number is personal data and a log aggregator is the wrong place
 * for a list of customer mobiles. Code that genuinely needs to identify a
 * number in a log line passes `maskedPhone` (see `maskPhone` in
 * `@safelock/shared`), which is on the safe list below.
 *
 * `templateParams` is here because a template's parameters are exactly where
 * an OTP would be if anyone ever logged a send payload.
 */
const SENSITIVE_KEY =
  /secret|signature|password|passwd|token|otp|authorization|auth|cookie|hash|credential|apikey|api_key|privatekey|private_key|phone|mobile|msisdn|recipient|templateparams|^to$|^body$/i;

/**
 * Keys that merely *sound* sensitive but are safe and useful to keep.
 *
 * `maskedPhone` is already masked by construction — `maskPhone` returns
 * `+91 98****10` or a constant, never the input — so redacting it again would
 * only remove the one phone representation that is safe to keep.
 */
const SAFE_KEY =
  /^(tokenType|hasPaid|authenticated|authorized|maskedPhone|phoneVerified|templateName)$/;

/**
 * Replaces the value of any sensitive-looking key, at any depth.
 *
 * Exported so the rule itself is directly testable: this is the backstop that
 * catches keys nobody listed, and a backstop nobody has watched work is not a
 * backstop. Not intended to be called outside the logger.
 */
export function sanitise(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => sanitise(item, depth + 1));
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }

  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] =
      SENSITIVE_KEY.test(key) && !SAFE_KEY.test(key) ? REDACTED : sanitise(inner, depth + 1);
  }
  return out;
}

export const logger = pino({
  // Tests stay at `error` rather than `silent`: an unexpected 500 during a
  // test run has to be diagnosable, and the expected ones are few.
  level: isTest ? 'error' : env.LOG_LEVEL,
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,

  formatters: {
    level: (label) => ({ level: label }),
    // Runs on the merged object of every log call — the regex backstop.
    log: (object) => sanitise(object) as Record<string, unknown>,
  },

  redact: {
    censor: REDACTED,
    paths: [
      'password',
      'authorization',
      'cookie',
      'set-cookie',
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      'headers.authorization',
      'headers.cookie',
      'headers["set-cookie"]',
      // Request bodies are never logged on auth routes (see httpLogger), but
      // if one ever reaches pino these are the fields that must not survive.
      'body.password',
      'body.confirmPassword',
      'body.identifier',
    ],
  },
});

/**
 * Logger bound to one request, so every line carries the request id.
 */
export function requestLogger(requestId: string) {
  return logger.child({ requestId });
}
