import { Router } from 'express';
import type { Limiters } from './middleware/rateLimit';
import { checkDatabase } from './lib/prisma';
import { createAccountRouter } from './modules/account/account.routes';
import { createAdminRouter } from './modules/admin/admin.routes';
import { createAuthRouter } from './modules/auth/auth.routes';
import { createBookingsRouter } from './modules/bookings/bookings.routes';
import { createDevicesRouter } from './modules/devices/devices.routes';
import { createNotificationsRouter } from './modules/notifications/notifications.routes';
import { createPaymentsRouter } from './modules/payments/payments.routes';
import { createWebhooksRouter } from './modules/webhooks/webhooks.routes';

/** Everything under `/api/v1`. */
export function createApiRouter(limiters: Limiters): Router {
  const router = Router();

  /**
   * Readiness probe. Reports the database, because an API that cannot reach
   * Postgres can serve nothing useful and should be pulled out of rotation.
   *
   * The body carries no internal detail — no error message, no connection
   * string, no timings. This endpoint is typically public.
   *
   * ## It reports the database and **only** the database, on purpose
   * Not the device gateway, not the outbox, not the sweepers. Two reasons, and
   * the second is the one that keeps this endpoint honest:
   *
   * 1. It is a *readiness* probe. The question a load balancer is asking is
   *    "can this instance serve requests", and an API with no hardware layer
   *    still serves almost everything — a dashboard, a booking, a payment, a
   *    history. That is an alerting concern, not a reason to drain traffic.
   * 2. A public endpoint must not describe how the server is wired. "Which
   *    gateway is this running?" is an inventory question with an admin answer
   *    (the Devices tab), not something to publish to anyone who can curl.
   *
   * **So `degraded` here always means Postgres** — never a device, never a
   * broker. Worth knowing when diagnosing one: against a remote database the
   * 2s `checkDatabase` timeout is the thing that trips, not anything to do
   * with safes.
   */
  router.get('/health', async (_req, res) => {
    const databaseUp = await checkDatabase();

    if (databaseUp) {
      res.status(200).json({ status: 'ok' });
      return;
    }
    res.status(503).json({ status: 'degraded' });
  });

  router.use('/auth', createAuthRouter(limiters));
  router.use('/bookings', createBookingsRouter(limiters));
  router.use('/payments', createPaymentsRouter(limiters));
  router.use('/devices', createDevicesRouter(limiters));
  router.use('/account', createAccountRouter(limiters));
  router.use('/notifications', createNotificationsRouter(limiters));
  router.use('/admin', createAdminRouter(limiters));
  // Server-to-server, authenticated by an HMAC over the raw body. Mounted
  // last so nothing above can shadow it.
  router.use('/webhooks', createWebhooksRouter(limiters));

  return router;
}
