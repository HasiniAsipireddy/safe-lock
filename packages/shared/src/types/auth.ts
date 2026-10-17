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
   * True once the user has confirmed a one-time code sent to their number.
   *
   * Derived from `phoneVerifiedAt != null`, not a second column.
   * **Unlocking is refused without it** (`PHONE_NOT_VERIFIED`) because the
   * code has nowhere to go; locking is not, since locking is the safe
   * direction and refusing it would leave someone unable to secure their own
   * safe.
   */
  phoneVerified: boolean;
}

/** Response body of `POST /account/phone/request-verification`. */
export interface PhoneVerificationRequestResponse {
  /**
   * The number the code was sent to, **masked** (`+91 98****10`).
   *
   * Echoed back on purpose: a request for a number that belongs to someone
   * else answers exactly like a successful one (see docs/decisions.md), so
   * this masked value is the only way a user who mistyped can notice. It
   * reveals nothing — they supplied the number in the request.
   */
  maskedPhone: string;
  expiresAt: string;
  expiresInSeconds: number;
  attemptsAllowed: number;
  resendAfterSeconds: number;
}

/** Response body of `POST /account/phone/confirm`. */
export interface PhoneVerificationConfirmResponse {
  user: PublicUser;
}

/**
 * Response body of `POST /auth/login`, `POST /auth/signup`, `GET /auth/me`,
 * `PATCH /auth/profile` and `POST /auth/password/change`.
 *
 * Note which account endpoint is **not** here: `POST /auth/password/reset`
 * returns {@link PasswordResetResponse} and no user, because completing a
 * reset does not sign anyone in.
 */
export interface AuthResponse {
  user: PublicUser;
}

/**
 * Response body of `POST /auth/password/forgot`.
 *
 * Always exactly this, for a registered address and an unregistered one
 * alike — the endpoint must not become a way to find out who has an account.
 */
export interface ForgotPasswordResponse {
  status: 'ok';
}

/**
 * Response body of `POST /auth/password/reset`.
 *
 * Carries no user and sets no session cookie. Whoever holds a reset link is
 * not yet known to be the account owner — they have proved control of an
 * inbox, which is enough to set a password and then be asked to sign in with
 * it, not enough to be handed a live session to a safe.
 */
export interface PasswordResetResponse {
  status: 'ok';
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
