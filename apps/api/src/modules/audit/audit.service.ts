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

  // --- Account / password ---------------------------------------------------
  /** A reset link was requested for an address that has an account. */
  PASSWORD_RESET_REQUESTED: 'auth.password.reset_requested',
  /**
   * A reset link was requested for an address that has no account. Nothing was
   * sent, and the HTTP response was identical to the case above — the two are
   * distinguishable **here and nowhere else**. A run of these from one IP is
   * someone probing for registered users.
   */
  PASSWORD_RESET_REQUESTED_UNKNOWN: 'auth.password.reset_requested_unknown',
  /** A reset token was redeemed: the password changed and all sessions ended. */
  PASSWORD_RESET_COMPLETED: 'auth.password.reset_completed',
  /** A reset code that was unknown, wrong, expired or already used. */
  PASSWORD_RESET_REJECTED: 'auth.password.reset_rejected',
  /**
   * A reset code burned all five attempts.
   *
   * Audited separately because it is the one reset failure that is a signal
   * rather than noise — somebody guessing, or a user who cannot read their
   * message. The HTTP response is identical to any other failure; this row is
   * the only place the difference exists.
   */
  PASSWORD_RESET_CODE_EXHAUSTED: 'auth.password.reset_code_exhausted',
  /** A signed-in user changed their own password. */
  PASSWORD_CHANGED: 'auth.password.changed',
  /** A change-password attempt that failed — usually a wrong current password. */
  PASSWORD_CHANGE_FAILED: 'auth.password.change_failed',
  /** A profile field (today: the name) was updated. */
  PROFILE_UPDATED: 'auth.profile.updated',

  // --- Phone verification ---------------------------------------------------
  /**
   * A verification code was requested. Metadata records whether one was
   * actually sent and whether the number belongs to another account — the
   * **only** place that collision is visible, since the HTTP response is
   * identical either way.
   */
  PHONE_VERIFICATION_REQUESTED: 'account.phone.verification_requested',
  /** A request refused before any code was sent (no consent, wrong password, cap). */
  PHONE_VERIFICATION_REFUSED: 'account.phone.verification_refused',
  /** A number was confirmed and promoted onto the account. */
  PHONE_VERIFIED: 'account.phone.verified',
  /** A wrong, expired or exhausted verification code. */
  PHONE_VERIFICATION_FAILED: 'account.phone.verification_failed',

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

  // --- Lock / unlock --------------------------------------------------------
  /** A lock command was acked by the device. */
  DEVICE_LOCKED: 'device.lock.success',
  /** A lock attempt that never reached the device. Metadata has the code. */
  DEVICE_LOCK_FAILED: 'device.lock.failed',
  /** An unlock code was generated and handed to the notifier. */
  UNLOCK_OTP_REQUESTED: 'device.unlock.otp_requested',
  /** An unlock code could not be issued (not eligible, rate limited, …). */
  UNLOCK_OTP_REFUSED: 'device.unlock.otp_refused',
  /** A correct code was presented and the safe opened. */
  DEVICE_UNLOCKED: 'device.unlock.success',
  /**
   * A wrong, expired, exhausted or already-used code. The single most
   * security-relevant line in this table: a run of these against one account
   * is someone guessing at a physical safe.
   */
  UNLOCK_OTP_FAILED: 'device.unlock.otp_failed',
  /**
   * A lock/unlock request from someone not entitled to operate the device —
   * unpaid, refunded, or holding no device.
   */
  DEVICE_OPERATION_DENIED: 'device.operation.denied',
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

/**
 * Keys that match the forbidden pattern but are safe by construction.
 *
 * `maskedPhone` only ever holds the output of `maskPhone` — `+91 98****10`, or
 * a constant for anything unparseable. Four digits of a number, which is what
 * makes a verification trail investigable ("which number was verified?")
 * without storing a mobile number. The logger allowlists exactly this value
 * for exactly this reason; this keeps the two consistent.
 *
 * Add to this list only for a value that *cannot* contain the sensitive form,
 * never for one that merely usually doesn't.
 */
const ALLOWED_METADATA_KEY = /^maskedPhone$/;

function scrubMetadata(
  metadata: Record<string, unknown> | undefined,
  action: string,
): Record<string, unknown> | undefined {
  if (!metadata) return undefined;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (FORBIDDEN_METADATA_KEY.test(key) && !ALLOWED_METADATA_KEY.test(key)) {
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
