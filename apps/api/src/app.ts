import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import { WEB_ORIGINS, env } from './config/env';
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
 * Razorpay's webhook. Exempt from two things:
 * - the JSON body parser (its signature covers the raw bytes), and
 * - the Origin check (server-to-server, no cookies, own HMAC).
 */
const WEBHOOK_PATH = `${API_PREFIX}/payments/webhook`;

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
   * JSON everywhere except the Razorpay webhook.
   *
   * The webhook signature covers the raw request bytes, so that route parses
   * its own body with `express.raw()` (see payments.routes.ts). If
   * `express.json()` ran first it would consume the stream and the HMAC could
   * never be reproduced.
   */
  const jsonParser = express.json({ limit: '100kb' });
  app.use((req, res, next) => {
    if (req.path === WEBHOOK_PATH) {
      next();
      return;
    }
    jsonParser(req, res, next);
  });

  app.use(cookieParser());

  app.use(createOriginCheck({ exemptPaths: [WEBHOOK_PATH] }));

  app.use(API_PREFIX, createApiRouter(limiters));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
