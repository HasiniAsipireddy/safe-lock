import { Router } from 'express';
import {
  confirmUnlockSchema,
  historyQuerySchema,
  type ConfirmUnlockInput,
  type HistoryQuery,
  type CommandAcceptedResponse,
  type CommandStatusResponse,
  type HistoryResponse,
  type MyDeviceResponse,
  type UnlockRequestResponse,
} from '@safelock/shared';
import { requireAuth } from '../../middleware/auth';
import { validateBody, validateQuery } from '../../middleware/validate';
import type { Limiters } from '../../middleware/rateLimit';
import { HttpError } from '../../lib/httpError';
import { routeParam } from '../../lib/routeParam';
import { AUDIT_ACTIONS, auditContext, writeAudit } from '../audit/audit.service';
import { readCommandStatus } from '../commands/command.mapper';
import { getHistoryPage } from './history.service';
import {
  UnlockFailed,
  confirmUnlock,
  currentDeviceFor,
  lockDevice,
  recordUnlockFailure,
  requestUnlock,
} from './deviceControl.service';

/**
 * User-facing device routes, mounted at `/api/v1/devices`.
 *
 * **`requirePaid` is gone, along with the middleware itself.** Paying *is*
 * booking now, so there is no account-level paid flag to gate on: eligibility
 * is `assertCanOperate`, which derives it from the caller's live booking and
 * distinguishes "no booking" (409 `NO_ACTIVE_BOOKING`) from "an overstay fee is
 * owed" (402 `OVERSTAY_PAYMENT_REQUIRED`) from "phone not verified" (403). The
 * dashboard shows a different thing for each, which a single collapsed
 * payment-required answer could not support.
 *
 * Unlocking is two calls on purpose. `request` proves nothing and opens
 * nothing; only `confirm`, with a code the requester had to receive out of
 * band, moves the bolt.
 */
export function createDevicesRouter(limiters: Limiters): Router {
  const router = Router();

  /**
   * The safe the caller currently has, or `null` between bookings.
   *
   * `requireAuth` only, and null rather than an error: a user with no booking
   * is not a failure, and the dashboard reads `GET /bookings/current` to find
   * out what to offer them. Authorisation is the query itself — the device is
   * resolved from the caller's own booking, so there is no id a user could
   * substitute to read someone else's safe.
   */
  router.get('/mine', requireAuth, async (req, res, next) => {
    try {
      const device = await currentDeviceFor(req.user!.id);
      const response: MyDeviceResponse = { device };
      res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  });

  /**
   * The caller's lock/unlock activity, newest first, cursor-paginated.
   *
   * `requireAuth` only — deliberately no eligibility check. This is a read of
   * the user's own record: someone who has never booked has no events and gets
   * an empty list, and someone whose booking ended last week can still see
   * what happened to the safe they had. Refusing either would be withholding
   * their own data, and an empty list is the honest answer rather than an
   * error.
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

  /**
   * Asks the safe to lock.
   *
   * **202, not 200**: the command has been accepted and the bolt has not moved
   * yet. An already-locked safe is still a success — idempotent, with
   * `alreadyInState` and no command to wait for.
   *
   * The audit row says a command was *issued*, not that the safe locked. What
   * it actually did is audited by the ack handler, which is the only thing
   * that knows.
   */
  router.post('/lock', requireAuth, limiters.deviceLock, async (req, res, next) => {
    const userId = req.user!.id;

    try {
      const result: CommandAcceptedResponse = await lockDevice({
        userId,
        requestId: req.id ?? null,
      });

      await writeAudit({
        action: AUDIT_ACTIONS.DEVICE_COMMAND_ISSUED,
        userId,
        ...auditContext(req),
        metadata: {
          type: 'LOCK',
          commandId: result.commandId,
          alreadyLocked: result.alreadyInState ?? false,
        },
      });

      res.status(202).json(result);
    } catch (error) {
      await auditOperationFailure(req, AUDIT_ACTIONS.DEVICE_LOCK_FAILED, error);
      next(error);
    }
  });

  /**
   * How a pending command ends.
   *
   * `requireAuth` plus a check that the command belongs to the caller, done in
   * the service by `userId` — a command id must not be a handle on somebody
   * else's safe. Another user's command is a 404, not a 403: a 403 would
   * confirm the id exists.
   *
   * Polled rather than pushed, for the same reason the notification bell is:
   * the dialog is open for at most twenty seconds, and a websocket to carry
   * twenty messages is infrastructure to maintain forever.
   */
  router.get(
    '/commands/:id',
    requireAuth,
    limiters.deviceHistory,
    async (req, res, next) => {
      try {
        const commandId = routeParam(req, 'id');

        const response: CommandStatusResponse = await readCommandStatus(
          req.user!.id,
          commandId,
        );

        res.status(200).json(response);
      } catch (error) {
        next(error);
      }
    },
  );

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

  /**
   * Verifies a code and, only on success, asks the safe to open.
   *
   * **202 with a command id.** The code was right; the bolt has not moved yet,
   * and the honest answer is "we have asked". `DEVICE_UNLOCKED` is audited by
   * the ack handler, because that is where it becomes true.
   */
  router.post(
    '/unlock/confirm',
    requireAuth,
    limiters.unlockConfirm,
    validateBody(confirmUnlockSchema),
    async (req, res, next) => {
      const userId = req.user!.id;
      const { otp } = req.body as ConfirmUnlockInput;

      try {
        const result: CommandAcceptedResponse = await confirmUnlock({
          userId,
          otp,
          requestId: req.id ?? null,
        });

        await writeAudit({
          action: AUDIT_ACTIONS.DEVICE_COMMAND_ISSUED,
          userId,
          ...auditContext(req),
          metadata: { type: 'UNLOCK', commandId: result.commandId },
        });

        res.status(202).json(result);
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
    code === 'NO_ACTIVE_BOOKING' ||
    code === 'OVERSTAY_PAYMENT_REQUIRED' ||
    code === 'PHONE_NOT_VERIFIED';

  await writeAudit({
    action: eligibility ? AUDIT_ACTIONS.DEVICE_OPERATION_DENIED : fallbackAction,
    userId: req.user?.id ?? null,
    ...auditContext(req),
    metadata: { code, path: req.path, method: req.method },
  });
}
