import { Router } from 'express';
import {
  createBookingSchema,
  emptyBookingBodySchema,
  extendBookingSchema,
  type BookingDetailResponse,
  type CreateBookingInput,
  type CurrentBookingResponse,
  type ExtendBookingInput,
} from '@safelock/shared';
import { requireAuth } from '../../middleware/auth';
import type { Limiters } from '../../middleware/rateLimit';
import { validateBody } from '../../middleware/validate';
import { HttpError } from '../../lib/httpError';
import { routeParam } from '../../lib/routeParam';
import { AUDIT_ACTIONS, auditContext, writeAudit } from '../audit/audit.service';
import {
  createBookingOrder,
  createExtensionOrder,
  createOverstayOrder,
} from '../payments/booking.payments';
import { toBookingSummary } from './booking.mapper';
import {
  cancelBooking,
  collectBooking,
  createBooking,
  currentBookingFor,
  extensionAvailability,
  getBookingForUser,
  quote,
} from './booking.service';

/**
 * Booking routes, mounted at `/api/v1/bookings`.
 *
 * `requireAuth` and nothing else. There is no `requirePaid` any more — paying
 * *is* booking, and eligibility to operate a safe is decided by
 * `assertCanOperate` from the booking itself.
 *
 * Note what no request body carries: **no amount, no start time, no end
 * time.** The duration in hours is the only thing a client chooses; every
 * other figure is the server's, and the schemas are `.strict()` so a body
 * trying to supply one is a 400 rather than a silent ignore.
 */
export function createBookingsRouter(limiters: Limiters): Router {
  const router = Router();

  /**
   * The caller's live booking plus a quote for a new one.
   *
   * One endpoint because the dashboard always needs both: either "here is your
   * booking" or "here is what one would cost", and a second round trip to find
   * out which would show the user a flicker.
   */
  router.get('/current', requireAuth, limiters.bookingRead, async (req, res, next) => {
    try {
      const now = new Date();
      const { booking, row } = await currentBookingFor(req.user!.id, now);

      /**
       * The extension offer rides along with the booking.
       *
       * The dashboard offers extensions too, and before this it priced them
       * itself — `hourlyRatePaise * hours` in the browser, against a rule that
       * says the client does no money arithmetic. Now both it and the
       * extension page read the same server-computed options, so neither can
       * offer a duration or a price the order endpoint would refuse.
       */
      const response: CurrentBookingResponse = {
        booking,
        extension: row ? await extensionAvailability(row, now) : null,
        quote: quote(),
      };
      res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  });

  /**
   * One booking, with whether it can be extended and at what price.
   *
   * The extension block is here rather than behind its own endpoint so the
   * page cannot render a stale offer: the same read that says "your booking
   * ends at 9:30" says what extending it would cost. Ownership is folded into
   * a 404 by `getBookingForUser`, so a link to someone else's booking — the
   * link a WhatsApp message carries — says only "we couldn't find that".
   */
  router.get('/:id', requireAuth, limiters.bookingRead, async (req, res, next) => {
    try {
      const now = new Date();
      const row = await getBookingForUser(routeParam(req, 'id'), req.user!.id);

      const response: BookingDetailResponse = {
        booking: toBookingSummary(row, now),
        extension: await extensionAvailability(row, now),
      };

      res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  });

  /**
   * Creates a booking and holds a safe for it.
   *
   * No payment yet: the hold gives the user time to pay without the safe being
   * sold from under them. It lapses on its own.
   */
  router.post(
    '/',
    requireAuth,
    limiters.bookingWrite,
    validateBody(createBookingSchema),
    async (req, res, next) => {
      const userId = req.user!.id;
      const { hours } = req.body as CreateBookingInput;
      const context = auditContext(req);

      try {
        const { booking } = await createBooking({ userId, hours });

        await writeAudit({
          action: AUDIT_ACTIONS.BOOKING_CREATED,
          userId,
          deviceId: booking.deviceId,
          ...context,
          metadata: { bookingId: booking.id, hours, pricePaise: booking.pricePaise },
        });

        res.status(201).json({ booking });
      } catch (error) {
        await writeAudit({
          action: AUDIT_ACTIONS.BOOKING_CREATED,
          userId,
          ...context,
          metadata: {
            failed: true,
            code: error instanceof HttpError ? error.code : 'INTERNAL_ERROR',
          },
        });
        next(error);
      }
    },
  );

  /** The Razorpay order for the booking. Amount from the booking, never the body. */
  router.post(
    '/:id/order',
    requireAuth,
    limiters.bookingWrite,
    validateBody(emptyBookingBodySchema),
    async (req, res, next) => {
      try {
        const order = await createBookingOrder({
          userId: req.user!.id,
          bookingId: routeParam(req, 'id'),
        });
        res.status(200).json(order);
      } catch (error) {
        next(error);
      }
    },
  );

  /**
   * An order for an extension.
   *
   * Priced from the booking's **snapshotted** rate, so a config change since
   * the booking started cannot alter it. Refused if a later booking would
   * collide, or if an overstay fee is already owed.
   */
  router.post(
    '/:id/extend/order',
    requireAuth,
    limiters.bookingWrite,
    validateBody(extendBookingSchema),
    async (req, res, next) => {
      const { hours } = req.body as ExtendBookingInput;

      try {
        const order = await createExtensionOrder({
          userId: req.user!.id,
          bookingId: routeParam(req, 'id'),
          hours,
        });
        res.status(200).json(order);
      } catch (error) {
        next(error);
      }
    },
  );

  /**
   * An order for the outstanding overstay fee.
   *
   * The amount is computed here, server-side, from the snapshot — and the
   * webhook verifies the capture against it. The quote is binding for
   * `OVERSTAY_QUOTE_TTL_MINUTES`; see docs/decisions.md for what happens to a
   * payment that arrives after that.
   */
  router.post(
    '/:id/overstay/order',
    requireAuth,
    limiters.bookingWrite,
    validateBody(emptyBookingBodySchema),
    async (req, res, next) => {
      try {
        const order = await createOverstayOrder({
          userId: req.user!.id,
          bookingId: routeParam(req, 'id'),
        });
        res.status(200).json(order);
      } catch (error) {
        next(error);
      }
    },
  );

  /**
   * "I've collected my items."
   *
   * An explicit user action because **the safe cannot tell whether it is
   * empty**. Refused while an overstay fee is outstanding — the fee is the
   * only leverage the product has, and letting someone collect without paying
   * would discard it.
   */
  router.post(
    '/:id/collect',
    requireAuth,
    limiters.bookingWrite,
    validateBody(emptyBookingBodySchema),
    async (req, res, next) => {
      const userId = req.user!.id;
      const context = auditContext(req);

      try {
        const booking = await collectBooking({ bookingId: routeParam(req, 'id'), userId });

        await writeAudit({
          action: AUDIT_ACTIONS.BOOKING_COLLECTED,
          userId,
          deviceId: booking.deviceId,
          ...context,
          metadata: { bookingId: booking.id },
        });

        res.status(200).json({ booking });
      } catch (error) {
        next(error);
      }
    },
  );

  /** Cancelling an unpaid booking. Releases the hold at once. */
  router.post(
    '/:id/cancel',
    requireAuth,
    limiters.bookingWrite,
    validateBody(emptyBookingBodySchema),
    async (req, res, next) => {
      const userId = req.user!.id;

      try {
        const booking = await cancelBooking({ bookingId: routeParam(req, 'id'), userId });

        await writeAudit({
          action: AUDIT_ACTIONS.BOOKING_CANCELLED,
          userId,
          deviceId: booking.deviceId,
          ...auditContext(req),
          metadata: { bookingId: booking.id },
        });

        res.status(200).json({ booking });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
