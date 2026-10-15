import { Router } from 'express';
import type { MyDeviceResponse } from '@safelock/shared';
import { requireAuth } from '../../middleware/auth';
import { requirePaid } from '../../middleware/requirePaid';
import { getDeviceForUser } from './device.service';

/**
 * User-facing device routes, mounted at `/api/v1/devices`.
 *
 * Lock and unlock are **not** here yet. When they arrive they must require
 * both `requirePaid` **and** an assigned device — a refunded user can still be
 * holding hardware, and neither condition implies the other. See
 * docs/decisions.md.
 */
export function createDevicesRouter(): Router {
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

  return router;
}
