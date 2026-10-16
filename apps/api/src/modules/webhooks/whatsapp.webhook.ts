import type { RequestHandler } from 'express';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';

/**
 * WhatsApp delivery-status webhook.
 *
 * ## Authentication is the HMAC, and nothing else
 * No cookies, no session, no Origin check. It is a server-to-server callback
 * from Meta, so there is no browser and no ambient credential to protect —
 * which is exactly why CSRF does not apply: a forged cross-site request cannot
 * produce a valid `X-Hub-Signature-256` without the app secret. The Razorpay
 * webhook is exempt for the identical reason. Documented in docs/decisions.md.
 *
 * ## The signature is checked before the body is parsed
 * `verifySignature` runs on the raw bytes; `JSON.parse` only happens after it
 * passes. An unauthenticated caller therefore cannot reach the parser, let
 * alone the database — which keeps the attack surface of a public endpoint to
 * one HMAC comparison.
 *
 * ## Idempotency
 * Meta retries, and statuses can arrive out of order. Updates are keyed on
 * `providerMessageId` and applied only when they move the state **forward**
 * (sent → delivered → read), so a redelivered `sent` after a `read` cannot
 * walk the record backwards and a repeat of the same status is a no-op.
 */

/** Delivery states Meta reports, ordered by progress. */
const STATUS_RANK: Record<string, number> = {
  sent: 1,
  delivered: 2,
  read: 3,
};

interface StatusEntry {
  id?: string;
  status?: string;
  errors?: Array<{ code?: number; title?: string }>;
}

/**
 * Meta's envelope, which is deeply nested and almost entirely optional.
 *
 * Read defensively: every level is checked, and anything unrecognised is
 * ignored rather than throwing. A webhook that 500s on an unexpected shape
 * gets retried forever, and Meta adds fields without warning.
 */
function extractStatuses(payload: unknown): StatusEntry[] {
  if (!payload || typeof payload !== 'object') return [];

  const entries = (payload as { entry?: unknown }).entry;
  if (!Array.isArray(entries)) return [];

  const out: StatusEntry[] = [];

  for (const entry of entries) {
    const changes = (entry as { changes?: unknown }).changes;
    if (!Array.isArray(changes)) continue;

    for (const change of changes) {
      const statuses = (change as { value?: { statuses?: unknown } }).value?.statuses;
      if (!Array.isArray(statuses)) continue;

      for (const status of statuses) {
        if (status && typeof status === 'object') out.push(status as StatusEntry);
      }
    }
  }

  return out;
}

/**
 * `POST /api/v1/webhooks/whatsapp`.
 *
 * Always answers **200 once the signature is valid**, even for a payload that
 * matched no message. Meta retries anything else, and "we have never heard of
 * this message id" is not a condition a retry can fix — it is an outbound
 * message from another environment, or one whose row has been pruned.
 */
export const postWhatsAppWebhook: RequestHandler = async (req, res, next) => {
  try {
    let payload: unknown;
    try {
      // `express.raw()` gives a Buffer. The signature has already been checked
      // against these exact bytes by the middleware ahead of this handler.
      payload = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '{}');
    } catch {
      // Signed by us but not JSON: nothing to apply, and a retry will not help.
      logger.warn({}, 'WhatsApp webhook body was not valid JSON');
      res.status(200).json({ received: true });
      return;
    }

    const statuses = extractStatuses(payload);
    let applied = 0;

    for (const status of statuses) {
      if (!status.id || !status.status) continue;

      const message = await prisma.outboundMessage.findUnique({
        where: { providerMessageId: status.id },
        select: { id: true, deliveryStatus: true },
      });

      // An id we never issued, or a row already pruned. Acknowledged and
      // dropped — the same shape as the Razorpay duplicate path.
      if (!message) continue;

      const incoming = STATUS_RANK[status.status] ?? 0;
      const current = message.deliveryStatus ? (STATUS_RANK[message.deliveryStatus] ?? 0) : 0;

      /**
       * `failed` is applied whatever the current state, because it is the one
       * status that is not progress — it is news. Everything else must move
       * forward, so a retried `sent` arriving after `read` changes nothing.
       */
      const isFailure = status.status === 'failed';
      if (!isFailure && incoming <= current) continue;

      await prisma.outboundMessage.update({
        where: { id: message.id },
        data: {
          deliveryStatus: status.status,
          deliveryUpdatedAt: new Date(),
          // A delivery failure reported after the fact is a real failure: the
          // send was accepted but never arrived.
          ...(isFailure ? { status: 'FAILED' as const, failureCategory: 'UNKNOWN' as const } : {}),
        },
      });

      applied += 1;
    }

    if (applied > 0) {
      logger.info({ applied, received: statuses.length }, 'WhatsApp delivery statuses applied');
    }

    res.status(200).json({ received: true });
  } catch (error) {
    // A genuine failure (the database is down) should 500 so Meta retries.
    next(error);
  }
};
