import type { UserRole } from '@safelock/shared';

/**
 * The authenticated principal attached by `requireAuth`.
 *
 * Only the claims carried in the access token — never a password hash and
 * never the full database row.
 */
export interface RequestUser {
  id: string;
  role: UserRole;
}

declare global {
  namespace Express {
    interface Request {
      /**
       * Correlation id for this request, set by the `requestId` middleware.
       * Appears in every log line, the error response body and the
       * `X-Request-Id` response header.
       */
      id: string;
      user?: RequestUser;
      /**
       * Raw body bytes, populated by `express.raw()` on the Razorpay webhook
       * route only. Signature verification must hash these exact bytes — a
       * re-serialised JSON object will not match.
       */
      rawBody?: Buffer;
    }
  }
}
