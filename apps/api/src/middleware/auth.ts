import type { RequestHandler } from 'express';
import { unauthenticated } from '../lib/httpError';
import { ACCESS_COOKIE, verifyAccessToken } from '../modules/auth/tokens';

/**
 * Rejects any request without a valid access-token cookie and attaches
 * `req.user`.
 *
 * This is the real access control. The web app's `<Protected>` wrapper is a
 * UX convenience that cannot see the httpOnly cookie.
 */
export const requireAuth: RequestHandler = (req, _res, next) => {
  const token = req.cookies?.[ACCESS_COOKIE] as string | undefined;

  if (!token) {
    next(unauthenticated());
    return;
  }

  const claims = verifyAccessToken(token);
  if (!claims) {
    next(unauthenticated('Your session has expired. Please sign in again.'));
    return;
  }

  req.user = { id: claims.sub, role: claims.role };
  next();
};

/**
 * Attaches `req.user` when a valid token is present but never rejects.
 *
 * Used by `POST /auth/logout`, which must clear cookies and succeed even for a
 * caller whose session has already expired.
 */
export const optionalAuth: RequestHandler = (req, _res, next) => {
  const token = req.cookies?.[ACCESS_COOKIE] as string | undefined;
  const claims = token ? verifyAccessToken(token) : null;
  if (claims) req.user = { id: claims.sub, role: claims.role };
  next();
};
