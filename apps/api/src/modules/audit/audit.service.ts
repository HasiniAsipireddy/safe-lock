import type { Request } from 'express';
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';

/**
 * Append-only security log.
 *
 * Writing an audit row must never break the request that caused it — a failed
 * insert is logged and swallowed. Conversely, nothing secret may be stored
 * here: no key secrets, no signatures, no OTPs, no tokens. Store identifiers
 * and outcomes, which is what an investigation actually needs.
 */

export const AUDIT_ACTIONS = {
  SIGNUP: 'auth.signup',
  LOGIN_SUCCESS: 'auth.login.success',
  LOGIN_FAILED: 'auth.login.failed',
  LOGOUT: 'auth.logout',

  /** A refresh token was redeemed and rotated normally. */
  REFRESH_ROTATED: 'auth.refresh.rotated',
  /**
   * An already-rotated token was replayed inside the grace window and allowed
   * to mint one sibling. Benign in the two-tabs-racing case, but recorded so
   * an unusual pattern is visible after the fact.
   */
  REFRESH_GRACE_USED: 'auth.refresh.grace_used',
  /**
   * A revoked token was replayed outside the grace window, or a second grace
   * use was attempted. Treated as theft: the family and all of the user's
   * refresh tokens are revoked.
   */
  REFRESH_REUSE_DETECTED: 'auth.refresh.reuse_detected',
  /** A refresh attempt with an unknown, expired or malformed token. */
  REFRESH_REJECTED: 'auth.refresh.rejected',

  /** A state-changing request was blocked by the Origin allowlist. */
  ORIGIN_REJECTED: 'security.origin.rejected',

  PAYMENT_ORDER_CREATED: 'payment.order.created',
  PAYMENT_ORDER_REFUSED: 'payment.order.refused',
  PAYMENT_VERIFIED: 'payment.verified',
  PAYMENT_SIGNATURE_FAILED: 'payment.signature.failed',
  PAYMENT_VERIFY_FORBIDDEN: 'payment.verify.forbidden',
  WEBHOOK_PROCESSED: 'payment.webhook.processed',
  WEBHOOK_DUPLICATE: 'payment.webhook.duplicate',
  WEBHOOK_SIGNATURE_FAILED: 'payment.webhook.signature.failed',
  PAYMENT_REQUIRED_BLOCKED: 'payment.required.blocked',

  // --- Devices / allocation -------------------------------------------------
  DEVICE_CREATED: 'device.created',
  DEVICE_BULK_CREATED: 'device.bulk_created',
  DEVICE_ALLOCATED: 'device.allocated',
  /** An allocation attempt that was refused. Metadata carries the error code. */
  DEVICE_ALLOCATION_FAILED: 'device.allocation.failed',
  DEVICE_UNASSIGNED: 'device.unassigned',
  DEVICE_UNASSIGN_FAILED: 'device.unassign.failed',
  DEVICE_RETIRED: 'device.retired',
  DEVICE_RETIRE_FAILED: 'device.retire.failed',
  /** A non-admin tried to reach an admin route. */
  ADMIN_ACCESS_DENIED: 'admin.access.denied',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

/**
 * Request-derived context, truncated so a hostile header cannot bloat a row.
 *
 * `requestId` ties an audit row to the exact log lines for that request.
 */
export function auditContext(req: Request): {
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
} {
  const userAgent = req.get('user-agent');
  return {
    ip: req.ip ?? null,
    userAgent: userAgent ? userAgent.slice(0, 500) : null,
    requestId: req.id ?? null,
  };
}

/**
 * Metadata keys that must never be written.
 *
 * An audit log is a long-lived, widely-readable record. Identify a person by
 * `userId` and look the rest up when an investigation actually needs it —
 * copying emails and phone numbers into every row spreads personal data into
 * a table nobody thinks of as holding any.
 */
const FORBIDDEN_METADATA_KEY = /email|phone|mobile|password|secret|token|signature|otp|hash/i;

function scrubMetadata(
  metadata: Record<string, unknown> | undefined,
  action: string,
): Record<string, unknown> | undefined {
  if (!metadata) return undefined;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (FORBIDDEN_METADATA_KEY.test(key)) {
      logger.warn({ action, key }, 'Dropped a forbidden key from audit metadata');
      continue;
    }
    out[key] = value;
  }
  return out;
}

export async function writeAudit(input: {
  action: AuditAction;
  userId?: string | null;
  deviceId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    const metadata = scrubMetadata(input.metadata, input.action);

    await prisma.auditLog.create({
      data: {
        action: input.action,
        userId: input.userId ?? null,
        deviceId: input.deviceId ?? null,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        metadata: ({
          ...(metadata ?? {}),
          ...(input.requestId ? { requestId: input.requestId } : {}),
        }) as never,
      },
    });
  } catch (cause) {
    logger.error(
      {
        action: input.action,
        reason: cause instanceof Error ? cause.message : 'unknown',
      },
      'Failed to write audit log',
    );
  }
}
