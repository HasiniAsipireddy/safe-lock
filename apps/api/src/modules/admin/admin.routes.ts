import { Router } from 'express';
import {
  bulkCreateDevicesSchema,
  clearInspectionSchema,
  createDeviceSchema,
  emptyBodySchema,
  forceCompleteBookingSchema,
  listAuditQuerySchema,
  listBookingsQuerySchema,
  listDevicesQuerySchema,
  listPaymentsQuerySchema,
  listUsersQuerySchema,
  waiveOverstaySchema,
} from '@safelock/shared';
import { requireAuth } from '../../middleware/auth';
import { requireAdmin } from '../../middleware/requireAdmin';
import type { Limiters } from '../../middleware/rateLimit';
import { validateBody, validateQuery } from '../../middleware/validate';
import {
  getAudit,
  getBookings,
  getDevices,
  getPayments,
  getUsers,
  postClearInspection,
  postClearPaymentReview,
  postDevice,
  postDevicesBulk,
  postForceCompleteBooking,
  postRetireDevice,
  postWaiveOverstay,
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

  /**
   * Returns an inspected safe to the pool.
   *
   * **Allocation is gone**, and so are `/devices/:id/allocate`,
   * `/allocate-next` and `/devices/:id/unassign`. Nobody is allocated a safe
   * any more: paying for a booking is what gets you one, and which safe is
   * decided under a row lock by the booking service. What an admin still
   * decides is the opposite question — whether a safe that came back with its
   * contents unknown is fit to rent again.
   */
  router.post(
    '/devices/:id/clear-inspection',
    limiters.adminWrite,
    validateBody(clearInspectionSchema),
    postClearInspection,
  );

  router.post(
    '/devices/:id/retire',
    limiters.adminWrite,
    validateBody(emptyBodySchema),
    postRetireDevice,
  );

  // --- Bookings --------------------------------------------------------------
  router.get('/bookings', validateQuery(listBookingsQuerySchema), getBookings);

  router.post(
    '/bookings/:id/force-complete',
    limiters.adminWrite,
    validateBody(forceCompleteBookingSchema),
    postForceCompleteBooking,
  );

  router.post(
    '/bookings/:id/waive-overstay',
    limiters.adminWrite,
    validateBody(waiveOverstaySchema),
    postWaiveOverstay,
  );

  // --- Payments --------------------------------------------------------------
  /** Records that a flagged payment has been refunded by hand. */
  router.post(
    '/payments/:id/clear-review',
    limiters.adminWrite,
    validateBody(clearInspectionSchema),
    postClearPaymentReview,
  );

  // --- Read-only listings ----------------------------------------------------
  router.get('/users', validateQuery(listUsersQuerySchema), getUsers);
  router.get('/payments', validateQuery(listPaymentsQuerySchema), getPayments);
  router.get('/audit', validateQuery(listAuditQuerySchema), getAudit);

  return router;
}
