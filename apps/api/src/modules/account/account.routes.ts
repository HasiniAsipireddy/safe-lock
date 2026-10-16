import { Router } from 'express';
import {
  confirmPhoneVerificationSchema,
  requestPhoneVerificationSchema,
  type ConfirmPhoneVerificationInput,
  type PhoneVerificationConfirmResponse,
  type RequestPhoneVerificationInput,
} from '@safelock/shared';
import { requireAuth } from '../../middleware/auth';
import type { Limiters } from '../../middleware/rateLimit';
import { validateBody } from '../../middleware/validate';
import { HttpError } from '../../lib/httpError';
import { AUDIT_ACTIONS, auditContext, writeAudit } from '../audit/audit.service';
import {
  confirmPhoneVerification,
  requestPhoneVerification,
} from './phoneVerification.service';

/**
 * Account routes, mounted at `/api/v1/account`.
 *
 * Phone verification sits here rather than under `/auth` because it is not an
 * authentication endpoint — it changes a property of an existing, authenticated
 * account. (`/auth/profile` and `/auth/password/*` stayed where they were; they
 * are the session's own concerns.)
 *
 * Both routes carry **two limiter limbs**, per user and per IP, for the same
 * reason the login routes do: the per-user limb cannot see one host walking
 * through many compromised sessions, and the per-IP limb cannot see one
 * account being hammered from many addresses. On top of those, the per-user
 * daily WhatsApp cap bounds the thing that actually costs money.
 */
export function createAccountRouter(limiters: Limiters): Router {
  const router = Router();

  router.post(
    '/phone/request-verification',
    requireAuth,
    limiters.phoneVerifyIp,
    limiters.phoneVerify,
    validateBody(requestPhoneVerificationSchema),
    async (req, res, next) => {
      const userId = req.user!.id;
      const body = req.body as RequestPhoneVerificationInput;
      const context = auditContext(req);

      try {
        const result = await requestPhoneVerification({
          userId,
          phoneE164: body.phone,
          consent: body.consent,
          currentPassword: body.currentPassword,
          ip: context.ip,
          userAgent: context.userAgent,
        });

        /**
         * The audit row is where the collision is visible — never the
         * response. The number itself is not recorded: the audit service drops
         * any key matching `phone` anyway, and `userId` is how a person is
         * identified in this table.
         */
        await writeAudit({
          action: AUDIT_ACTIONS.PHONE_VERIFICATION_REQUESTED,
          userId,
          ...context,
          metadata: { sent: result.sent, collision: result.collision },
        });

        res.status(200).json(result.response);
      } catch (error) {
        await writeAudit({
          action: AUDIT_ACTIONS.PHONE_VERIFICATION_REFUSED,
          userId,
          ...context,
          metadata: { code: error instanceof HttpError ? error.code : 'INTERNAL_ERROR' },
        });
        next(error);
      }
    },
  );

  router.post(
    '/phone/confirm',
    requireAuth,
    limiters.phoneConfirm,
    validateBody(confirmPhoneVerificationSchema),
    async (req, res, next) => {
      const userId = req.user!.id;
      const { otp } = req.body as ConfirmPhoneVerificationInput;
      const context = auditContext(req);

      try {
        const result = await confirmPhoneVerification({ userId, otp });

        await writeAudit({
          action: AUDIT_ACTIONS.PHONE_VERIFIED,
          userId,
          ...context,
          // Masked, so the trail is useful without holding a mobile number.
          metadata: { maskedPhone: result.maskedPhone },
        });

        const response: PhoneVerificationConfirmResponse = { user: result.user };
        res.status(200).json(response);
      } catch (error) {
        await writeAudit({
          action: AUDIT_ACTIONS.PHONE_VERIFICATION_FAILED,
          userId,
          ...context,
          metadata: { code: error instanceof HttpError ? error.code : 'INTERNAL_ERROR' },
        });
        next(error);
      }
    },
  );

  return router;
}
