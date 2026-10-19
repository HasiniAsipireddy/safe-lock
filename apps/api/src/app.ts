import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import { WEB_ORIGINS, env } from './config/env';
import { deviceGateway } from './lib/deviceGateway';
import { deviceInboundHandler } from './modules/commands/inbound.service';
import { createApiRouter } from './routes';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { createOriginCheck } from './middleware/originCheck';
import { requestId } from './middleware/requestId';
import {
  DEFAULT_RATE_LIMITS,
  createLimiters,
  type RateLimitConfig,
} from './middleware/rateLimit';

export const API_PREFIX = '/api/v1';

/**
 * Webhook paths, exempt from two things each:
 * - the JSON body parser (their signatures cover the raw bytes), and
 * - the Origin check (server-to-server, no cookies, own HMAC).
 *
 * Both verify an HMAC over the raw body instead, which is a stronger claim
 * than an Origin header: a forged cross-site request cannot produce a valid
 * signature without the shared secret. See docs/decisions.md.
 */
const RAZORPAY_WEBHOOK_PATH = `${API_PREFIX}/payments/webhook`;
const WHATSAPP_WEBHOOK_PATH = `${API_PREFIX}/webhooks/whatsapp`;

const RAW_BODY_PATHS = [RAZORPAY_WEBHOOK_PATH, WHATSAPP_WEBHOOK_PATH];

export interface CreateAppOptions {
  /**
   * Override rate limits. Tests pass small numbers to exercise the 429 path;
   * production uses {@link DEFAULT_RATE_LIMITS}.
   */
  rateLimits?: Partial<RateLimitConfig>;
}

/**
 * Builds the Express app. Separated from `server.ts` so tests can mount it
 * with supertest without opening a port.
 *
 * Middleware order matters here:
 *  1. `requestId`  — everything downstream logs the same id
 *  2. `helmet`     — security headers even on an error response
 *  3. `cors`       — must answer preflights before any rejection logic
 *  4. body parsers — the Origin check reads cookies, the limiter reads body
 *  5. `cookieParser` — originCheck needs parsed cookies
 *  6. `originCheck`  — reject CSRF before a handler can act on it
 *  7. routes, 404, error handler
 */
export function createApp(options: CreateAppOptions = {}): Express {
  /**
   * The in-process mock gateway is wired up here, unlike the workers.
   *
   * The outbox worker and the sweepers are started from `server.ts` only,
   * because a *loop* that ticked during the test suite would race every
   * assertion. This is not a loop: the mock produces one ack in response to
   * one command a caller has just issued, and `drainDeviceAcks()` makes that
   * deterministic. Leaving it unwired in tests would instead make the entire
   * ack path — signature verification, command correlation, the state update,
   * the event and the notification — unreachable from any test that goes
   * through a route, which is the half of this feature most worth testing.
   *
   * A real gateway is **not** started here: `start` opens a broker connection,
   * and a test suite must not. `server.ts` does that.
   */
  if (env.DEVICE_GATEWAY === 'mock') {
    void deviceGateway.start(deviceInboundHandler);
  }

  const app = express();

  const limiters = createLimiters({ ...DEFAULT_RATE_LIMITS, ...options.rateLimits });

  /**
   * Only trust `X-Forwarded-*` when configured to. Trusting it with no proxy
   * in front lets any client set its own apparent IP and walk straight past
   * every per-IP rate limit.
   */
  app.set('trust proxy', env.TRUST_PROXY);
  app.disable('x-powered-by');

  app.use(requestId);
  app.use(helmet());

  app.use(
    cors({
      // Credentialed requests cannot use a wildcard origin. Same allowlist the
      // originCheck middleware enforces, from the same env var.
      origin: WEB_ORIGINS as string[],
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      exposedHeaders: ['X-Request-Id'],
    }),
  );

  /**
   * JSON everywhere except the webhooks.
   *
   * A webhook signature covers the raw request bytes, so those routes parse
   * their own bodies with `express.raw()` (see payments.routes.ts and
   * webhooks.routes.ts). If `express.json()` ran first it would consume the
   * stream and the HMAC could never be reproduced.
   *
   * Only these exact paths are skipped, so every other route — including any
   * future one — keeps ordinary JSON parsing. There is a test asserting a
   * normal endpoint still parses its body with the WhatsApp webhook mounted.
   */
  const jsonParser = express.json({ limit: '100kb' });
  app.use((req, res, next) => {
    if (RAW_BODY_PATHS.includes(req.path)) {
      next();
      return;
    }
    jsonParser(req, res, next);
  });

  app.use(cookieParser());

  app.use(createOriginCheck({ exemptPaths: RAW_BODY_PATHS }));

  app.use(API_PREFIX, createApiRouter(limiters));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
