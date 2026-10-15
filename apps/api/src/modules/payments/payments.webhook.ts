import crypto from 'node:crypto';
import type { RequestHandler } from 'express';
import { ERROR_CODES, type ApiErrorBody } from '@safelock/shared';
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { AUDIT_ACTIONS, auditContext, writeAudit } from '../audit/audit.service';
import { applyWebhookEvent } from './payments.service';
import { verifyWebhookSignature } from './signature';

/**
 * `POST /api/v1/payments/webhook` — Razorpay's server-to-server callback, and
 * the source of truth for whether money arrived.
 *
 * Mounted with `express.raw()` (see payments.routes.ts) because the signature
 * covers the exact request bytes. There is no auth and no cookie here: the
 * HMAC *is* the authentication.
 *
 * Contract with Razorpay:
 * - 2xx  -> delivered, stop retrying.
 * - 4xx/5xx -> retry later.
 *
 * So a bad signature returns 400 (never retried into a loop) while a genuine
 * processing failure returns 500 so the event is redelivered.
 */

const SIGNATURE_HEADER = 'x-razorpay-signature';
const EVENT_ID_HEADER = 'x-razorpay-event-id';

/** Events this version acts on. Anything else is acknowledged and recorded. */
const HANDLED_EVENTS = new Set(['payment.captured', 'payment.failed', 'refund.processed']);

function isUniqueViolation(error: unknown): boolean {
  // Duck-typed rather than instanceof: Prisma's error classes have moved
  // between major versions and a missed import would silently break dedupe.
  return (error as { code?: string } | null)?.code === 'P2002';
}

export const postWebhook: RequestHandler = async (req, res, next) => {
  const signature = req.get(SIGNATURE_HEADER);

  // express.raw() leaves a Buffer on req.body.
  const rawBody = Buffer.isBuffer(req.body) ? req.body : null;

  if (!rawBody || !signature) {
    await writeAudit({
      action: AUDIT_ACTIONS.WEBHOOK_SIGNATURE_FAILED,
      ...auditContext(req),
      metadata: { reason: !rawBody ? 'missing raw body' : 'missing signature header' },
    });
    sendError(res, 400, ERROR_CODES.INVALID_SIGNATURE, 'Missing or unreadable webhook signature.');
    return;
  }

  if (!verifyWebhookSignature(rawBody, signature)) {
    // The signature itself is never logged or stored.
    await writeAudit({
      action: AUDIT_ACTIONS.WEBHOOK_SIGNATURE_FAILED,
      ...auditContext(req),
      metadata: { reason: 'hmac mismatch', bodyBytes: rawBody.length },
    });
    sendError(res, 400, ERROR_CODES.INVALID_SIGNATURE, 'Invalid webhook signature.');
    return;
  }

  let parsed: { event?: unknown; payload?: unknown };
  try {
    parsed = JSON.parse(rawBody.toString('utf8')) as typeof parsed;
  } catch {
    sendError(res, 400, ERROR_CODES.VALIDATION_ERROR, 'Webhook body is not valid JSON.');
    return;
  }

  const type = typeof parsed.event === 'string' ? parsed.event : null;
  if (!type) {
    sendError(res, 400, ERROR_CODES.VALIDATION_ERROR, 'Webhook body has no event type.');
    return;
  }

  // Razorpay sends a per-delivery event id. If the header is absent, a hash of
  // the body is a stable stand-in so replays of identical payloads still dedupe.
  const eventId =
    req.get(EVENT_ID_HEADER) ?? `body:${crypto.createHash('sha256').update(rawBody).digest('hex')}`;

  try {
    const outcome = await prisma.$transaction(async (tx) => {
      // Recording the event id and applying it share one transaction: if
      // applying throws, the ledger row rolls back too and Razorpay's retry
      // gets a clean attempt rather than being deduped into a no-op.
      await tx.webhookEvent.create({ data: { eventId, type } });
      return applyWebhookEvent(tx, { type, payload: parsed.payload });
    });

    await writeAudit({
      action: AUDIT_ACTIONS.WEBHOOK_PROCESSED,
      ...auditContext(req),
      metadata: {
        eventId,
        type,
        handled: HANDLED_EVENTS.has(type),
        ...(outcome.kind === 'applied'
          ? { result: outcome.action, paymentRowId: outcome.paymentRowId }
          : { result: 'ignored', reason: outcome.reason }),
      },
    });

    res.status(200).json({ received: true, duplicate: false });
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Already processed. Acknowledge so Razorpay stops retrying.
      await writeAudit({
        action: AUDIT_ACTIONS.WEBHOOK_DUPLICATE,
        ...auditContext(req),
        metadata: { eventId, type },
      });
      res.status(200).json({ received: true, duplicate: true });
      return;
    }

    logger.error(
      {
        eventId,
        type,
        reason: error instanceof Error ? error.message : 'unknown',
      },
      'Webhook processing failed',
    );
    // 5xx on purpose: Razorpay should redeliver this one.
    next(error);
  }
};

function sendError(
  res: Parameters<RequestHandler>[1],
  status: number,
  code: string,
  message: string,
): void {
  const body: ApiErrorBody = { error: { code, message } };
  res.status(status).json(body);
}
