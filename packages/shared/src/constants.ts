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
