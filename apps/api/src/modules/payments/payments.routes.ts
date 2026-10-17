import express, { Router } from 'express';
import { verifyPaymentSchema } from '@safelock/shared';
import { requireAuth } from '../../middleware/auth';
import type { Limiters } from '../../middleware/rateLimit';
import { validateBody } from '../../middleware/validate';
import { postVerify } from './payments.controller';
import { postWebhook } from './payments.webhook';

/**
 * Payment routes, mounted at `/api/v1/payments`.
 *
 * Only two now. **Orders are created from the booking routes**, where the
 * amount can be derived from a booking's snapshotted rates — there is no
 * account-level "activate my safe" purchase any more. What stays here is the
 * webhook (the source of truth for whether money arrived) and the Checkout
 * callback, both of which are about a payment rather than a booking.
 */
export function createPaymentsRouter(limiters: Limiters): Router {
  const router = Router();

  /**
   * Webhook first, and with its own body parser.
   *
   * `express.raw()` is applied to this route only, so signature verification
   * can hash the exact bytes Razorpay signed. It is registered before the
   * router is mounted behind the global `express.json()` (see app.ts) and
   * carries no auth and no cookies — the HMAC is the authentication. It is
   * also exempt from `originCheck` for the same reason.
   */
  router.post('/webhook', express.raw({ type: '*/*', limit: '1mb' }), postWebhook);

  /**
   * TODO(phone-verification): `requireVerifiedPhone` would go here, between
   * `requireAuth` and the limiter. Still deliberately absent — gating payment
   * on verification is a product decision nobody has made.
   */
  router.post(
    '/verify',
    requireAuth,
    limiters.verifyPayment,
    validateBody(verifyPaymentSchema),
    postVerify,
  );

  return router;
}
