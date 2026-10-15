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
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

/** Request-derived context, truncated so a hostile header cannot bloat a row. */
export function auditContext(req: Request): { ip: string | null; userAgent: string | null } {
  const userAgent = req.get('user-agent');
  return {
    ip: req.ip ?? null,
    userAgent: userAgent ? userAgent.slice(0, 500) : null,
  };
}

export async function writeAudit(input: {
  action: AuditAction;
  userId?: string | null;
  deviceId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        action: input.action,
        userId: input.userId ?? null,
        deviceId: input.deviceId ?? null,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        metadata: (input.metadata ?? undefined) as never,
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
