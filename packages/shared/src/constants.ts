/**
 * Shared constants for the Safe Lock platform.
 * Imported by both the web app and (later) the Express API.
 */

/** Error codes used in the `{ error: { code, message } }` response shape. */
export const ERROR_CODES = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  EMAIL_ALREADY_REGISTERED: 'EMAIL_ALREADY_REGISTERED',
  PHONE_ALREADY_REGISTERED: 'PHONE_ALREADY_REGISTERED',
  RATE_LIMITED: 'RATE_LIMITED',
  NETWORK_ERROR: 'NETWORK_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',

  // --- Payments -------------------------------------------------------------
  /** The user already has a PAID payment, so a second order is refused. */
  ALREADY_PAID: 'ALREADY_PAID',
  /** A feature was requested that requires a completed payment. */
  PAYMENT_REQUIRED: 'PAYMENT_REQUIRED',
  /** HMAC check on a Checkout callback or webhook body failed. */
  INVALID_SIGNATURE: 'INVALID_SIGNATURE',
  /** No Payment row matches the supplied Razorpay order id. */
  PAYMENT_NOT_FOUND: 'PAYMENT_NOT_FOUND',
  /** Razorpay's API could not be reached or returned an error. */
  PAYMENT_GATEWAY_ERROR: 'PAYMENT_GATEWAY_ERROR',

  // --- Sessions / CSRF ------------------------------------------------------
  /**
   * A state-changing request carried cookies but no acceptable `Origin`.
   * Returned by the `originCheck` middleware.
   */
  CSRF_ORIGIN_REJECTED: 'CSRF_ORIGIN_REJECTED',
  /**
   * The refresh token was missing, unknown, expired or revoked. The client
   * should treat this as "signed out" and stop retrying.
   */
  REFRESH_TOKEN_INVALID: 'REFRESH_TOKEN_INVALID',
  /**
   * A revoked refresh token was replayed outside the grace window. The whole
   * token family has been revoked as a precaution.
   */
  REFRESH_REUSE_DETECTED: 'REFRESH_REUSE_DETECTED',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export const PASSWORD_RULES = {
  minLength: 8,
  maxLength: 128,
} as const;

export const NAME_RULES = {
  minLength: 2,
  maxLength: 80,
} as const;

/**
 * Generic message for any failed login. Deliberately does not say whether the
 * identifier or the password was wrong — that would let an attacker enumerate
 * registered accounts.
 */
export const GENERIC_LOGIN_ERROR = 'Invalid credentials. Please check your details and try again.';
