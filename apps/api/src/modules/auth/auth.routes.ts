import { Router } from 'express';
import {
  changePasswordBodySchema,
  forgotPasswordSchema,
  resetPasswordBodySchema,
  updateProfileSchema,
} from '@safelock/shared';
import { optionalAuth, requireAuth } from '../../middleware/auth';
import type { Limiters } from '../../middleware/rateLimit';
import { validateBody } from '../../middleware/validate';
import { loginBodySchema, signupBodySchema } from './auth.schemas';
import {
  getMe,
  patchProfile,
  postChangePassword,
  postForgotPassword,
  postLogin,
  postLogout,
  postRefresh,
  postResetPassword,
  postSignup,
} from './auth.controller';

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

  /**
   * Password reset — the two halves of a flow for someone who cannot sign in,
   * so neither carries `requireAuth`.
   *
   * `/forgot` has two limiter limbs for the same reason login does: per IP
   * catches one host probing many addresses, per address catches many hosts
   * targeting one. Both run before any database lookup, so a 429 reveals no
   * more than a 200 does.
   */
  router.post(
    '/password/forgot',
    limiters.passwordForgot,
    limiters.passwordForgotIdentifier,
    validateBody(forgotPasswordSchema),
    postForgotPassword,
  );

  router.post(
    '/password/reset',
    limiters.passwordReset,
    validateBody(resetPasswordBodySchema),
    postResetPassword,
  );

  // Changing a password requires knowing the current one, on top of a session.
  router.post(
    '/password/change',
    requireAuth,
    limiters.passwordChange,
    validateBody(changePasswordBodySchema),
    postChangePassword,
  );

  // Name only. `updateProfileSchema` is `.strict()`, so a body that also
  // carries an email or phone is a 400 rather than a silent partial update.
  router.patch(
    '/profile',
    requireAuth,
    limiters.profileUpdate,
    validateBody(updateProfileSchema),
    patchProfile,
  );

  router.post('/logout', optionalAuth, postLogout);
  router.get('/me', requireAuth, getMe);

  return router;
}
