import { Router } from 'express';
import { optionalAuth, requireAuth } from '../../middleware/auth';
import type { Limiters } from '../../middleware/rateLimit';
import { validateBody } from '../../middleware/validate';
import { loginBodySchema, signupBodySchema } from './auth.schemas';
import { getMe, postLogin, postLogout, postRefresh, postSignup } from './auth.controller';

/**
 * Auth routes. Mounted at `/api/v1/auth`, which is also the path the refresh
 * cookie is scoped to — see `REFRESH_COOKIE_PATH`.
 *
 * Built as a factory so limiter instances (and therefore their counters) are
 * owned by the app, which is what lets a test construct an app with small
 * limits and actually exercise the 429.
 */
export function createAuthRouter(limiters: Limiters): Router {
  const router = Router();

  // Two limiter limbs on the credential endpoints: per IP, then per
  // identifier. The identifier limb runs after body parsing but before any
  // database lookup, so its 429 cannot reveal whether an account exists.
  router.post(
    '/signup',
    limiters.auth,
    limiters.authIdentifier,
    validateBody(signupBodySchema),
    postSignup,
  );

  router.post(
    '/login',
    limiters.auth,
    limiters.authIdentifier,
    validateBody(loginBodySchema),
    postLogin,
  );

  // No requireAuth: an expired access token is the normal reason to be here.
  router.post('/refresh', postRefresh);

  router.post('/logout', optionalAuth, postLogout);
  router.get('/me', requireAuth, getMe);

  return router;
}
