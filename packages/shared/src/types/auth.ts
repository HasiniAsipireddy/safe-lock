import type { ErrorCode } from '../constants';

export type UserRole = 'USER' | 'ADMIN';

/** The only user shape the API ever sends to a client. Never includes a hash. */
export interface PublicUser {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: UserRole;
  createdAt: string;
  /**
   * True once the user has a server-verified `PAID` payment. Derived on every
   * request — it is not a column, and a client cannot set it.
   *
   * The UI uses it to decide whether to show the "Complete payment" banner;
   * actual gating is the API's `requirePaid` middleware.
   */
  hasPaid: boolean;
  /**
   * True when a device is currently assigned to this user. Derived per
   * request, like {@link PublicUser.hasPaid} — not a column.
   *
   * `hasPaid: false` with `deviceAllocated: true` is a real, reachable state:
   * a refunded payment while the hardware is still out. The dashboard has an
   * explicit state for it, and lock/unlock must require **both** flags.
   */
  deviceAllocated: boolean;
}

/** Response body of `POST /auth/login`, `POST /auth/signup` and `GET /auth/me`. */
export interface AuthResponse {
  user: PublicUser;
}

/** The consistent error envelope used by every endpoint. */
export interface ApiErrorBody {
  error: {
    code: ErrorCode | string;
    message: string;
    /** Optional per-field messages for VALIDATION_ERROR. */
    fields?: Record<string, string>;
    /**
     * Correlation id, also sent as the `X-Request-Id` response header. Quote
     * it in a support request to find the exact server-side log lines.
     */
    requestId?: string;
  };
}
