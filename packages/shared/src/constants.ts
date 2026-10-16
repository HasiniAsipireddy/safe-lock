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

  // --- Account / password ---------------------------------------------------
  /**
   * A password reset code that could not be redeemed.
   *
   * **One code for every reason, on purpose.** Unknown identifier, no
   * outstanding code, wrong code, expired code, already-used code and
   * attempts-exhausted all answer with this and an identical message. Telling
   * the caller which it was would say whether the account exists — and this
   * endpoint is unauthenticated, so that is an enumeration oracle for who owns
   * a safe.
   */
  RESET_CODE_INVALID: 'RESET_CODE_INVALID',
  /**
   * The `currentPassword` supplied to `POST /auth/password/change` was wrong.
   *
   * Deliberately a **400, not a 401**: the session is perfectly valid, and a
   * 401 would send the web client through its refresh-and-retry path and end
   * with the user signed out for mistyping a password.
   */
  PASSWORD_INCORRECT: 'PASSWORD_INCORRECT',

  // --- Phone verification / WhatsApp ----------------------------------------
  /**
   * Unlock requires a verified phone number, because that is where the
   * one-time code goes. Distinct from `NO_DEVICE` and `NOT_PAID`: the user has
   * something to *do* about it, and the dashboard shows them how.
   */
  PHONE_NOT_VERIFIED: 'PHONE_NOT_VERIFIED',
  /**
   * A one-time code was generated but could not be delivered. The challenge it
   * belonged to has been invalidated, so there is no code in flight — the
   * caller should simply try again.
   */
  OTP_DELIVERY_FAILED: 'OTP_DELIVERY_FAILED',
  /** The submitted verification code did not match. The challenge is open. */
  PHONE_VERIFICATION_INVALID: 'PHONE_VERIFICATION_INVALID',
  PHONE_VERIFICATION_EXPIRED: 'PHONE_VERIFICATION_EXPIRED',
  PHONE_VERIFICATION_TOO_MANY_ATTEMPTS: 'PHONE_VERIFICATION_TOO_MANY_ATTEMPTS',
  /** No open verification challenge — never requested, used, or superseded. */
  PHONE_VERIFICATION_NOT_FOUND: 'PHONE_VERIFICATION_NOT_FOUND',
  /** The submitted number is already the caller's verified number. */
  PHONE_ALREADY_VERIFIED: 'PHONE_ALREADY_VERIFIED',
  /**
   * The per-user daily WhatsApp send cap is spent. Messages cost money, and an
   * uncapped send endpoint is a way to bill us for someone else's spam.
   *
   * **Never returned by `/auth/password/forgot`** — doing so would turn the cap
   * into an account-enumeration oracle. That endpoint stays byte-identical and
   * silently skips the send.
   */
  WHATSAPP_SEND_CAP_REACHED: 'WHATSAPP_SEND_CAP_REACHED',
  /** WhatsApp opt-in is required before any message may be sent. */
  CONSENT_REQUIRED: 'CONSENT_REQUIRED',

  // --- Devices / allocation -------------------------------------------------
  /** Allocation attempted for a user with no server-verified payment. */
  NOT_PAID: 'NOT_PAID',
  /** The user already holds a device (one per user for now). */
  ALREADY_HAS_DEVICE: 'ALREADY_HAS_DEVICE',
  /** The requested device is not `UNASSIGNED`. */
  DEVICE_NOT_AVAILABLE: 'DEVICE_NOT_AVAILABLE',
  /** No `UNASSIGNED` device left to allocate. */
  NO_DEVICES_IN_STOCK: 'NO_DEVICES_IN_STOCK',
  /** Retire was attempted on a device that is still assigned to a user. */
  DEVICE_STILL_ASSIGNED: 'DEVICE_STILL_ASSIGNED',
  /** The `userId` supplied to an admin action matches no user. */
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  /** A serial number that already exists in the inventory. */
  DUPLICATE_SERIAL: 'DUPLICATE_SERIAL',

  // --- Lock / unlock --------------------------------------------------------
  /**
   * The caller is paid but holds no device yet — still waiting for an admin to
   * allocate one. Distinct from NOT_PAID: paying again would not help.
   */
  NO_DEVICE: 'NO_DEVICE',
  /**
   * The caller's payment was refunded while they still hold hardware. Remote
   * operation is withdrawn; reclaiming the safe is a deliberate admin action.
   * See docs/decisions.md.
   */
  REFUNDED_CONTACT_SUPPORT: 'REFUNDED_CONTACT_SUPPORT',
  /** The submitted OTP did not match. The challenge is still open. */
  OTP_INVALID: 'OTP_INVALID',
  /** The challenge passed its 5-minute expiry. Request a new code. */
  OTP_EXPIRED: 'OTP_EXPIRED',
  /** The challenge burned its 5 attempts and has been invalidated. */
  OTP_TOO_MANY_ATTEMPTS: 'OTP_TOO_MANY_ATTEMPTS',
  /**
   * No open challenge for this user and device — never requested, already
   * used, or superseded by a newer request.
   */
  OTP_NOT_FOUND: 'OTP_NOT_FOUND',
  /** The device gateway refused or failed to deliver the command. */
  DEVICE_COMMAND_FAILED: 'DEVICE_COMMAND_FAILED',
  /**
   * The device's lock state is UNKNOWN, so no command can be reasoned about.
   * Should not occur for an owned device — allocation sets LOCKED.
   */
  DEVICE_STATE_UNKNOWN: 'DEVICE_STATE_UNKNOWN',

  // --- History / notifications ----------------------------------------------
  /**
   * A pagination cursor that was malformed, tampered with or oversized. The
   * client should drop it and reload the list from the start.
   */
  INVALID_CURSOR: 'INVALID_CURSOR',
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
