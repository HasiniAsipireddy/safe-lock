import jwt from 'jsonwebtoken';
import type { CookieOptions, Response } from 'express';
import type { UserRole } from '@safelock/shared';
import { ACCESS_TOKEN_TTL_MS, REFRESH_TOKEN_TTL_MS, env, isProduction } from '../../config/env';

/**
 * Access tokens and auth cookies.
 *
 * - **Access token**: a short-lived (15 min) signed JWT. Stateless, so every
 *   request can be authorised without a database read.
 * - **Refresh token**: opaque random bytes, stored hashed — see
 *   `refreshToken.service.ts`. Not a JWT, because a JWT cannot be revoked.
 *
 * Both live in httpOnly cookies: the browser never exposes a token to
 * JavaScript, so an XSS on the web app cannot steal a session that opens a
 * physical safe. See docs/decisions.md — "No tokens in web storage".
 */

export const ACCESS_COOKIE = 'safelock_at';
export const REFRESH_COOKIE = 'safelock_rt';

/**
 * Path the refresh cookie is scoped to.
 *
 * The browser only sends a cookie to paths at or below its `Path`, so this
 * keeps the refresh token off `/api/v1/payments/*`, `/api/v1/devices/*` and
 * any future admin route. Those handlers cannot leak or misuse a credential
 * they never receive, and the long-lived token crosses the wire a few times a
 * day instead of on every request.
 *
 * Must stay in step with where the auth router is mounted.
 */
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

export interface AccessClaims {
  sub: string;
  role: UserRole;
}

function baseCookieOptions(path: string): CookieOptions {
  return {
    httpOnly: true,
    // Requires HTTPS in production; left off locally so http://localhost works.
    secure: isProduction,
    // 'lax' still sends the cookie on a top-level navigation back from the
    // Razorpay Checkout redirect flow, while blocking cross-site POSTs.
    // NOTE: this requires web and API to be same-site in production —
    // see docs/decisions.md.
    sameSite: 'lax',
    path,
  };
}

export function signAccessToken(claims: AccessClaims): string {
  return jwt.sign({ role: claims.role }, env.JWT_ACCESS_SECRET, {
    subject: claims.sub,
    expiresIn: env.ACCESS_TOKEN_TTL as jwt.SignOptions['expiresIn'],
  });
}

/** Returns the claims, or null for any expired, tampered or malformed token. */
export function verifyAccessToken(token: string): AccessClaims | null {
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET);
    if (typeof payload === 'string' || !payload.sub) return null;

    const role = (payload as jwt.JwtPayload).role;
    if (role !== 'USER' && role !== 'ADMIN') return null;

    return { sub: payload.sub, role };
  } catch {
    return null;
  }
}

export function setAccessCookie(res: Response, claims: AccessClaims): void {
  res.cookie(ACCESS_COOKIE, signAccessToken(claims), {
    ...baseCookieOptions('/'),
    maxAge: ACCESS_TOKEN_TTL_MS,
  });
}

/** `rawToken` is the opaque refresh token; only its hash is ever persisted. */
export function setRefreshCookie(res: Response, rawToken: string): void {
  res.cookie(REFRESH_COOKIE, rawToken, {
    ...baseCookieOptions(REFRESH_COOKIE_PATH),
    maxAge: REFRESH_TOKEN_TTL_MS,
  });
}

export function setAuthCookies(
  res: Response,
  claims: AccessClaims,
  rawRefreshToken: string,
): void {
  setAccessCookie(res, claims);
  setRefreshCookie(res, rawRefreshToken);
}

/**
 * Clears both cookies.
 *
 * `clearCookie` only matches a cookie whose path is identical, so the refresh
 * cookie must be cleared with the same scoped path it was set with — clearing
 * it at `/` silently leaves it in the browser.
 */
export function clearAuthCookies(res: Response): void {
  res.clearCookie(ACCESS_COOKIE, baseCookieOptions('/'));
  res.clearCookie(REFRESH_COOKIE, baseCookieOptions(REFRESH_COOKIE_PATH));
}
