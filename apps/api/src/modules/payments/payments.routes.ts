import express, { Router } from 'express';
import { createOrderSchema, verifyPaymentSchema } from '@safelock/shared';
import { requireAuth } from '../../middleware/auth';
import type { Limiters } from '../../middleware/rateLimit';
import { validateBody } from '../../middleware/validate';
import { getMyPayment, postOrder, postVerify } from './payments.controller';
import { postWebhook } from './payments.webhook';

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
   * TODO(phone-verification): once WhatsApp/SMS phone verification exists,
   * insert `requireVerifiedPhone` here, between `requireAuth` and the rate
   * limiter, so an unverified number cannot start a payment. Intentionally
   * absent for now — there is no verification flow to satisfy it.
   */
  router.post(
    '/order',
    requireAuth,
    limiters.createOrder,
    // Rejects any body, including one trying to smuggle in its own amount.
    validateBody(createOrderSchema),
    postOrder,
  );

  /**
   * TODO(phone-verification): `requireVerifiedPhone` goes here too, after
   * `requireAuth`.
   */
  router.post(
    '/verify',
    requireAuth,
    limiters.verifyPayment,
    validateBody(verifyPaymentSchema),
    postVerify,
  );

  router.get('/me', requireAuth, getMyPayment);

  return router;
}
