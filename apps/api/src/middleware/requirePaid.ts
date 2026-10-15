import type { RequestHandler } from 'express';
import { ERROR_CODES } from '@safelock/shared';
import { HttpError } from '../lib/httpError';
import { userHasPaid } from '../modules/users/user.mapper';
import { AUDIT_ACTIONS, auditContext, writeAudit } from '../modules/audit/audit.service';

/**
 * Refuses a request unless the user has a server-verified `PAID` payment.
 *
 * This is the gate that enforces the CLAUDE.md business rule "a user cannot be
 * allocated a device until a payment is verified server-side". It will sit in
 * front of the device, lock/unlock and OTP routes when those are built; it is
 * exported and tested now so those routes can simply use it.
 *
 * Must be mounted *after* `requireAuth` — without `req.user` there is nothing
 * to check, and that is treated as a programming error, not a 401.
 *
 * 402 is deliberate: 403 would say "you may never do this", whereas the user
 * can fix this by paying.
 */
export const requirePaid: RequestHandler = async (req, _res, next) => {
  const user = req.user;

  if (!user) {
    next(
      new HttpError({
        status: 500,
        code: ERROR_CODES.INTERNAL_ERROR,
        message: 'Something went wrong. Please try again.',
        logContext: { reason: 'requirePaid mounted without requireAuth', path: req.path },
      }),
    );
    return;
  }

  try {
    if (await userHasPaid(user.id)) {
      next();
      return;
    }

    await writeAudit({
      action: AUDIT_ACTIONS.PAYMENT_REQUIRED_BLOCKED,
      userId: user.id,
      ...auditContext(req),
      metadata: { path: req.path, method: req.method },
    });

    next(
      new HttpError({
        status: 402,
        code: ERROR_CODES.PAYMENT_REQUIRED,
        message: 'Complete your payment to activate your safe.',
      }),
    );
  } catch (error) {
    next(error);
  }
};
