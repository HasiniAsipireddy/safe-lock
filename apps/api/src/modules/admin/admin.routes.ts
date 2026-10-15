import { Router } from 'express';
import {
  allocateDeviceSchema,
  bulkCreateDevicesSchema,
  createDeviceSchema,
  emptyBodySchema,
  listAuditQuerySchema,
  listDevicesQuerySchema,
  listPaymentsQuerySchema,
  listUsersQuerySchema,
} from '@safelock/shared';
import { requireAuth } from '../../middleware/auth';
import { requireAdmin } from '../../middleware/requireAdmin';
import type { Limiters } from '../../middleware/rateLimit';
import { validateBody, validateQuery } from '../../middleware/validate';
import {
  getAudit,
  getDevices,
  getPayments,
  getUsers,
  postAllocateDevice,
  postAllocateNext,
  postDevice,
  postDevicesBulk,
  postRetireDevice,
  postUnassignDevice,
} from './admin.controller';

/**
 * Admin routes, mounted at `/api/v1/admin`.
 *
 * `requireAuth` + `requireAdmin` are applied to the **whole router**, so a
 * route added later cannot accidentally be left unprotected. The global
 * `originCheck` already covers every POST here (only the Razorpay webhook is
 * exempt), so these routes need no CSRF handling of their own.
 *
 * Write routes additionally carry the per-admin `adminWrite` limiter.
 */
export function createAdminRouter(limiters: Limiters): Router {
  const router = Router();

  router.use(requireAuth, requireAdmin);

  // --- Devices ---------------------------------------------------------------
  router.get('/devices', validateQuery(listDevicesQuerySchema), getDevices);

  router.post(
    '/devices',
    limiters.adminWrite,
    validateBody(createDeviceSchema),
    postDevice,
  );

  router.post(
    '/devices/bulk',
    limiters.adminWrite,
    validateBody(bulkCreateDevicesSchema),
    postDevicesBulk,
  );

  router.post(
    '/devices/:id/allocate',
    limiters.adminWrite,
    validateBody(allocateDeviceSchema),
    postAllocateDevice,
  );

  /** Allocates whichever device is next in stock — no device id needed. */
  router.post(
    '/allocate-next',
    limiters.adminWrite,
    validateBody(allocateDeviceSchema),
    postAllocateNext,
  );

  router.post(
    '/devices/:id/unassign',
    limiters.adminWrite,
    validateBody(emptyBodySchema),
    postUnassignDevice,
  );

  router.post(
    '/devices/:id/retire',
    limiters.adminWrite,
    validateBody(emptyBodySchema),
    postRetireDevice,
  );

  // --- Read-only listings ----------------------------------------------------
  router.get('/users', validateQuery(listUsersQuerySchema), getUsers);
  router.get('/payments', validateQuery(listPaymentsQuerySchema), getPayments);
  router.get('/audit', validateQuery(listAuditQuerySchema), getAudit);

  return router;
}
