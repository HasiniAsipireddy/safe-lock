import { Router } from 'express';
import {
  confirmUnlockSchema,
  historyQuerySchema,
  type ConfirmUnlockInput,
  type HistoryQuery,
  type HistoryResponse,
  type LockResponse,
  type MyDeviceResponse,
  type UnlockConfirmResponse,
  type UnlockRequestResponse,
} from '@safelock/shared';
import { requireAuth } from '../../middleware/auth';
import { requirePaid } from '../../middleware/requirePaid';
import { validateBody, validateQuery } from '../../middleware/validate';
import type { Limiters } from '../../middleware/rateLimit';
import { HttpError } from '../../lib/httpError';
import { AUDIT_ACTIONS, auditContext, writeAudit } from '../audit/audit.service';
import { getDeviceForUser } from './device.service';
import { getHistoryPage } from './history.service';
import {
  UnlockFailed,
  confirmUnlock,
  lockDevice,
  recordUnlockFailure,
  requestUnlock,
} from './deviceControl.service';

/**
 * User-facing device routes, mounted at `/api/v1/devices`.
 *
 * Note which routes do and do not carry `requirePaid`:
 *
 * - `GET /mine` keeps it. It is a read, and 402 PAYMENT_REQUIRED is the right
 *   answer for anyone without a settled payment.
 * - The three **write** routes do not. Eligibility there is
 *   `assertCanOperate`, which separates "never paid" (402 `NOT_PAID`) from
 *   "refunded while still holding the hardware" (403
 *   `REFUNDED_CONTACT_SUPPORT`) from "paid, awaiting allocation" (409
 *   `NO_DEVICE`). `requirePaid` collapses the first two into one answer, and
 *   the dashboard needs to tell them apart. The check is no weaker — it is
 *   the same `userHasPaid` rule plus an ownership check.
 *
 * Unlocking is two calls on purpose. `request` proves nothing and opens
 * nothing; only `confirm`, with a code the requester had to receive out of
 * band, moves the bolt.
 */
export function createDevicesRouter(limiters: Limiters): Router {
  const router = Router();

  /**
   * The caller's own device, or `null` while they are waiting for allocation.
   *
   * Authorisation is the query itself: the lookup is by `ownerId`, so there is
   * no device id a user could substitute to read someone else's safe.
   */
  router.get('/mine', requireAuth, requirePaid, async (req, res, next) => {
    try {
      const device = await getDeviceForUser(req.user!.id);
      const response: MyDeviceResponse = { device };
      res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  });

  /**
   * The caller's lock/unlock activity, newest first, cursor-paginated.
   *
   * `requireAuth` only — deliberately **no** `requirePaid` and no eligibility
   * check. This is a read of the user's own record: someone waiting for
   * allocation has no events and gets an empty list, and someone whose payment
   * was refunded can still see what happened to the safe they were holding.
   * Refusing either would be withholding their own data, and an empty list is
   * the honest answer rather than an error.
   */
  router.get(
    '/history',
    requireAuth,
    limiters.deviceHistory,
    validateQuery(historyQuerySchema),
    async (req, res, next) => {
      try {
        const { cursor, limit } = req.query as unknown as HistoryQuery;

        const response: HistoryResponse = await getHistoryPage({
          userId: req.user!.id,
          limit,
          cursor,
        });

        res.status(200).json(response);
      } catch (error) {
        next(error);
      }
    },
  );

  /** Locks the safe. Idempotent — locking a locked safe is a 200, not a 409. */
  router.post('/lock', requireAuth, limiters.deviceLock, async (req, res, next) => {
    const userId = req.user!.id;

    try {
      const result: LockResponse = await lockDevice({ userId, requestId: req.id ?? null });

      await writeAudit({
        action: AUDIT_ACTIONS.DEVICE_LOCKED,
        userId,
        deviceId: result.device.id,
        ...auditContext(req),
        metadata: { alreadyLocked: result.alreadyLocked },
      });

      res.status(200).json(result);
    } catch (error) {
      await auditOperationFailure(req, AUDIT_ACTIONS.DEVICE_LOCK_FAILED, error);
      next(error);
    }
  });

  /**
   * Sends a one-time code. Two limiter limbs: per user and per IP.
   *
   * The response deliberately carries no code, no hash, no challenge id and
   * nothing derived from the code — only when it expires and how many tries
   * it allows.
   */
  router.post(
    '/unlock/request',
    requireAuth,
    limiters.unlockRequestIp,
    limiters.unlockRequest,
    async (req, res, next) => {
      const userId = req.user!.id;

      try {
        const result: UnlockRequestResponse = await requestUnlock({
          userId,
          requestId: req.id ?? null,
        });

        await writeAudit({
          action: AUDIT_ACTIONS.UNLOCK_OTP_REQUESTED,
          userId,
          ...auditContext(req),
          metadata: { expiresAt: result.expiresAt },
        });

        res.status(200).json(result);
      } catch (error) {
        await auditOperationFailure(req, AUDIT_ACTIONS.UNLOCK_OTP_REFUSED, error);
        next(error);
      }
    },
  );

  /** Verifies a code and, only on success, opens the safe. */
  router.post(
    '/unlock/confirm',
    requireAuth,
    limiters.unlockConfirm,
    validateBody(confirmUnlockSchema),
    async (req, res, next) => {
      const userId = req.user!.id;
      const { otp } = req.body as ConfirmUnlockInput;

      try {
        const result: UnlockConfirmResponse = await confirmUnlock({
          userId,
          otp,
          requestId: req.id ?? null,
        });

        await writeAudit({
          action: AUDIT_ACTIONS.DEVICE_UNLOCKED,
          userId,
          deviceId: result.device.id,
          ...auditContext(req),
        });

        res.status(200).json(result);
      } catch (error) {
        if (error instanceof UnlockFailed) {
          // A failed attempt is still the owner's history, and still a
          // security event. Both are written before the 400 goes out.
          await recordUnlockFailure({
            deviceId: error.deviceId,
            userId,
            reason: error.reason,
            requestId: req.id ?? null,
          });

          await writeAudit({
            action: AUDIT_ACTIONS.UNLOCK_OTP_FAILED,
            userId,
            deviceId: error.deviceId,
            ...auditContext(req),
            // The reason is a fixed enum string. Nothing the user typed, and
            // nothing derived from it, reaches this row.
            metadata: { reason: error.reason, code: error.httpError.code },
          });

          next(error.httpError);
          return;
        }

        await auditOperationFailure(req, AUDIT_ACTIONS.UNLOCK_OTP_FAILED, error);
        next(error);
      }
    },
  );

  return router;
}

/**
 * Audits a refused lock/unlock with its error code.
 *
 * Eligibility refusals get their own action so a run of them against one
 * account is visible as a pattern rather than buried among command failures.
 */
async function auditOperationFailure(
  req: Parameters<typeof auditContext>[0] & { user?: { id: string } },
  fallbackAction: (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS],
  error: unknown,
): Promise<void> {
  const code = error instanceof HttpError ? error.code : 'INTERNAL_ERROR';
  const eligibility =
    code === 'NOT_PAID' || code === 'REFUNDED_CONTACT_SUPPORT' || code === 'NO_DEVICE';

  await writeAudit({
    action: eligibility ? AUDIT_ACTIONS.DEVICE_OPERATION_DENIED : fallbackAction,
    userId: req.user?.id ?? null,
    ...auditContext(req),
    metadata: { code, path: req.path, method: req.method },
  });
}
