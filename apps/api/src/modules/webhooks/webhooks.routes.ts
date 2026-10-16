import express, { Router } from 'express';
import { ERROR_CODES, type ApiErrorBody } from '@safelock/shared';
import type { Limiters } from '../../middleware/rateLimit';
import { logger } from '../../lib/logger';
import { verifyHandshakeToken, verifySignature } from './whatsapp.signature';
import { postWhatsAppWebhook } from './whatsapp.webhook';

/**
 * Webhook routes, mounted at `/api/v1/webhooks`.
 *
 * Server-to-server only: no cookies, no session, no Origin check. See
 * `whatsapp.webhook.ts` for why CSRF does not apply, and `app.ts` for the two
 * places this path is listed — the JSON-parser bypass and the originCheck
 * exemption, exactly as the Razorpay webhook already is.
 */
export function createWebhooksRouter(limiters: Limiters): Router {
  const router = Router();

  /**
   * Meta's subscription handshake.
   *
   * A public GET that echoes `hub.challenge` when `hub.verify_token` matches.
   * Rate limited like the POST: it is unauthenticated and callable by anyone,
   * and each call costs a constant-time comparison.
   */
  router.get('/whatsapp', limiters.whatsAppWebhook, (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode !== 'subscribe' || !verifyHandshakeToken(typeof token === 'string' ? token : undefined)) {
      // 403 is what Meta's documentation expects for a failed handshake.
      logger.warn({ mode: typeof mode === 'string' ? mode : null }, 'WhatsApp webhook handshake rejected');
      res.status(403).json({ error: { code: ERROR_CODES.FORBIDDEN, message: 'Verification failed.' } });
      return;
    }

    // Echoed verbatim as text/plain — Meta compares the body byte for byte.
    res.status(200).type('text/plain').send(typeof challenge === 'string' ? challenge : '');
  });

  /**
   * Delivery statuses.
   *
   * `express.raw()` on this route only, so the signature can be checked
   * against the exact bytes Meta signed. The check runs as middleware **ahead
   * of the handler**, so an unauthenticated caller never reaches `JSON.parse`,
   * let alone the database.
   */
  router.post(
    '/whatsapp',
    limiters.whatsAppWebhook,
    express.raw({ type: '*/*', limit: '1mb' }),
    (req, res, next) => {
      const signature = req.get('x-hub-signature-256');
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

      if (!verifySignature(rawBody, signature)) {
        /**
         * 401, and nothing else happens.
         *
         * The rejected signature is never echoed back, and the body is never
         * parsed. A caller learns only that the signature was wrong — not
         * which part of it, and nothing about whether any message id in the
         * payload exists.
         */
        logger.warn(
          { hasSignature: Boolean(signature), bytes: rawBody.length },
          'WhatsApp webhook signature rejected',
        );

        const body: ApiErrorBody = {
          error: {
            code: ERROR_CODES.INVALID_SIGNATURE,
            message: 'Invalid signature.',
            requestId: req.id,
          },
        };
        res.status(401).json(body);
        return;
      }

      next();
    },
    postWhatsAppWebhook,
  );

  return router;
}
