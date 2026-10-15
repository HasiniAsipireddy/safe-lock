import type { RequestHandler } from 'express';
import { ERROR_CODES } from '@safelock/shared';
import { HttpError } from '../lib/httpError';
import { AUDIT_ACTIONS, auditContext, writeAudit } from '../modules/audit/audit.service';

/**
 * Restricts a route to `ADMIN` users.
 *
 * Must be mounted **after** `requireAuth`. Without `req.user` there is nothing
 * to check, and that is a programming error rather than a 403 — it fails
 * closed with a 500 and a log line naming the misconfiguration, so a
 * mis-wired admin route can never be publicly reachable.
 *
 * The role comes from the signed access token, so a client cannot assert it.
 * Rejections are audited: someone probing admin routes is worth a record.
 */
export const requireAdmin: RequestHandler = (req, _res, next) => {
  const user = req.user;

  if (!user) {
    next(
      new HttpError({
        status: 500,
        code: ERROR_CODES.INTERNAL_ERROR,
        message: 'Something went wrong. Please try again.',
        logContext: { reason: 'requireAdmin mounted without requireAuth', path: req.path },
      }),
    );
    return;
  }

  if (user.role !== 'ADMIN') {
    void writeAudit({
      action: AUDIT_ACTIONS.ADMIN_ACCESS_DENIED,
      userId: user.id,
      ...auditContext(req),
      metadata: { path: req.path, method: req.method, role: user.role },
    });

    next(
      new HttpError({
        status: 403,
        code: ERROR_CODES.FORBIDDEN,
        message: 'You do not have access to this resource.',
      }),
    );
    return;
  }

  next();
};
