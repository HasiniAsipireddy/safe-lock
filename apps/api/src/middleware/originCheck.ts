import type { RequestHandler } from 'express';
import { ERROR_CODES } from '@safelock/shared';
import { WEB_ORIGINS } from '../config/env';
import { HttpError } from '../lib/httpError';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '../modules/auth/tokens';

/**
 * CSRF defence: an exact-match `Origin` allowlist on state-changing requests.
 *
 * `sameSite=lax` cookies already block most cross-site POSTs, but "most" is
 * not a security boundary for something that opens a physical safe. This is
 * the second, explicit lock.
 *
 * Rules, in order:
 *
 * - Safe methods (GET/HEAD/OPTIONS) pass. They must not change state anyway.
 * - The Razorpay webhook is exempt: it is a server-to-server call with no
 *   cookies and no browser Origin, authenticated by its own HMAC.
 * - An `Origin` that is present must match `WEB_ORIGIN` by **exact string
 *   equality**. Never a prefix or regex match — a prefix test on
 *   `https://app.example.com` would also accept
 *   `https://app.example.com.attacker.test`.
 * - A *missing* `Origin` is rejected **only if auth cookies are present**.
 *   That is the dangerous combination (a browser that would attach the user's
 *   session). A cookie-less caller with no Origin is a server-to-server client
 *   or curl, which cannot be a CSRF victim because it has no ambient
 *   credentials to abuse.
 */

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function isAllowedOrigin(origin: string): boolean {
  return WEB_ORIGINS.includes(origin);
}

export function createOriginCheck(options: { exemptPaths: readonly string[] }): RequestHandler {
  const exempt = new Set(options.exemptPaths);

  return (req, _res, next) => {
    if (!STATE_CHANGING.has(req.method)) {
      next();
      return;
    }

    if (exempt.has(req.path)) {
      next();
      return;
    }

    const origin = req.get('origin');

    if (origin) {
      if (isAllowedOrigin(origin)) {
        next();
        return;
      }

      next(
        new HttpError({
          status: 403,
          code: ERROR_CODES.CSRF_ORIGIN_REJECTED,
          message: 'Request blocked: unrecognised origin.',
          // The rejected origin is logged, not echoed back to the caller.
          logContext: { rejectedOrigin: origin, path: req.path },
        }),
      );
      return;
    }

    const hasAuthCookies = Boolean(
      req.cookies?.[ACCESS_COOKIE] ?? req.cookies?.[REFRESH_COOKIE],
    );

    if (hasAuthCookies) {
      next(
        new HttpError({
          status: 403,
          code: ERROR_CODES.CSRF_ORIGIN_REJECTED,
          message: 'Request blocked: missing origin.',
          logContext: { reason: 'no Origin header with auth cookies present', path: req.path },
        }),
      );
      return;
    }

    next();
  };
}
