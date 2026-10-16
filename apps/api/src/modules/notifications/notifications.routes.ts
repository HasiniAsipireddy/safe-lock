import { Router } from 'express';
import {
  markNotificationsReadSchema,
  notificationsQuerySchema,
  type MarkNotificationsReadInput,
  type MarkNotificationsReadResponse,
  type NotificationsQuery,
  type NotificationsResponse,
} from '@safelock/shared';
import { requireAuth } from '../../middleware/auth';
import { validateBody, validateQuery } from '../../middleware/validate';
import type { Limiters } from '../../middleware/rateLimit';
import { listNotifications, markNotificationsRead } from './notification.service';

/**
 * In-app notifications, mounted at `/api/v1/notifications`.
 *
 * `requireAuth` and nothing more. These are the caller's own notifications,
 * and a user whose payment was refunded is still entitled to read the record
 * of their own safe being opened — arguably especially then. There is no
 * `requirePaid` here for the same reason there is none on `/devices/history`.
 */
export function createNotificationsRouter(limiters: Limiters): Router {
  const router = Router();

  /**
   * Unread first, newest first, capped by `limit`.
   *
   * The web client polls this while its tab is visible, so it carries the
   * per-user limiter — a client stuck in a tight loop should cost itself, not
   * the database.
   */
  router.get(
    '/',
    requireAuth,
    limiters.notifications,
    validateQuery(notificationsQuerySchema),
    async (req, res, next) => {
      try {
        const { limit } = req.query as unknown as NotificationsQuery;

        const response: NotificationsResponse = await listNotifications({
          userId: req.user!.id,
          limit,
        });

        res.status(200).json(response);
      } catch (error) {
        next(error);
      }
    },
  );

  /**
   * Marks notifications read.
   *
   * Not audited: reading one's own notifications is not a security event, and
   * a row per bell-open would bury the lines that matter. The unlock itself is
   * already in both `AuditLog` and `DeviceEvent`.
   */
  router.post(
    '/read',
    requireAuth,
    limiters.notifications,
    validateBody(markNotificationsReadSchema),
    async (req, res, next) => {
      try {
        const { ids } = req.body as MarkNotificationsReadInput;

        const response: MarkNotificationsReadResponse = await markNotificationsRead({
          userId: req.user!.id,
          ids,
        });

        res.status(200).json(response);
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
