import { Router } from 'express';
import type { Limiters } from './middleware/rateLimit';
import { checkDatabase } from './lib/prisma';
import { createAdminRouter } from './modules/admin/admin.routes';
import { createAuthRouter } from './modules/auth/auth.routes';
import { createDevicesRouter } from './modules/devices/devices.routes';
import { createPaymentsRouter } from './modules/payments/payments.routes';

/** Everything under `/api/v1`. */
export function createApiRouter(limiters: Limiters): Router {
  const router = Router();

  /**
   * Readiness probe. Reports the database, because an API that cannot reach
   * Postgres can serve nothing useful and should be pulled out of rotation.
   *
   * The body carries no internal detail — no error message, no connection
   * string, no timings. This endpoint is typically public.
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
  router.use('/payments', createPaymentsRouter(limiters));
  router.use('/devices', createDevicesRouter());
  router.use('/admin', createAdminRouter(limiters));

  return router;
}
