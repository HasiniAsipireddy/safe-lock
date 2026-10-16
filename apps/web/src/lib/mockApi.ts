/**
 * In-browser fake of the auth API, enabled with NEXT_PUBLIC_USE_MOCK_API=true.
 *
 * It exists so the login/signup UI can be built and tested before the Express
 * API is written. It is refused in production builds — see `lib/env.ts`.
 *
 * Deliberate limitations:
 * - Accounts live in module memory, so anything created by signup disappears
 *   on a full page reload (the seeded demo account always comes back).
 * - The "session" is a user id in sessionStorage. It is not a token and grants
 *   nothing: the real app relies on httpOnly cookies set by the backend.
 */

import {
  DEVICE_EVENT_LABELS,
  ERROR_CODES,
  GENERIC_LOGIN_ERROR,
  HISTORY_DEFAULT_LIMIT,
  HISTORY_MAX_LIMIT,
  NOTIFICATION_COPY,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_SECONDS,
  OTP_TTL_MS,
  PASSWORD_RESET_TTL_MS,
  PHONE_OTP_MAX_ATTEMPTS,
  PHONE_OTP_RESEND_COOLDOWN_SECONDS,
  PHONE_OTP_TTL_MS,
  RESET_TOKEN_BYTES,
  UNLOCK_FAILURE_LABELS,
  changePasswordBodySchema,
  classifyIdentifier,
  confirmPhoneVerificationSchema,
  forgotPasswordSchema,
  maskPhone,
  normaliseSerial,
  otpSchema,
  requestPhoneVerificationSchema,
  resetPasswordBodySchema,
  serialNumberSchema,
  toNationalPhone,
  updateProfileSchema,
  type AdminAuditRow,
  type AdminDeviceRow,
  type AdminPaymentRow,
  type AdminUserRow,
  type ApiErrorBody,
  type AuthResponse,
  type BulkCreateResult,
  type BulkCreateRowResult,
  type CreateOrderResponse,
  type DeviceEventType,
  type DeviceStatus,
  type DeviceSummary,
  type ForgotPasswordResponse,
  type HistoryEvent,
  type HistoryResponse,
  type LockResponse,
  type LockState,
  type MarkNotificationsReadResponse,
  type MyDeviceResponse,
  type NotificationItem,
  type NotificationType,
  type NotificationsResponse,
  type Paginated,
  type PasswordResetResponse,
  type PaymentMeResponse,
  type PhoneVerificationRequestResponse,
  type PaymentSummary,
  type PublicUser,
  type UnlockConfirmResponse,
  type UnlockFailureReason,
  type UnlockRequestResponse,
  type VerifyPaymentResponse,
} from '@safelock/shared';
import { apiErrorFromBody } from './apiError';
import type { HttpMethod } from './api';

const LATENCY_MS = 650;
const SESSION_KEY = 'safelock.mock.session';

/** Mock activation price in paise. Mirrors the API's SAFE_PRICE_PAISE default. */
const MOCK_PRICE_PAISE = 99_900;

/**
 * The only "signature" the mock verify endpoint accepts.
 *
 * It is not a real HMAC and could not pass the API's `timingSafeEqual` check —
 * it exists so the mock /pay flow exercises the same request shape as the real
 * one. The real signature is computed by Razorpay and checked server-side.
 */
export const MOCK_CHECKOUT_SIGNATURE = '0'.repeat(64);

interface MockAccount {
  user: PublicUser;
  /** Mock-only, in memory, never persisted and never logged. */
  password: string;
  /** Payment attempts for this account, newest last. */
  payments: PaymentSummary[];
}

const accounts: MockAccount[] = [
  {
    user: {
      id: 'usr_demo_0001',
      name: 'Demo User',
      email: 'demo@example.com',
      phone: '9876543210',
      role: 'USER',
      createdAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
      // Starts unpaid so the /pay flow can be walked through end to end,
      // and unverified so the phone-verification step can be too.
      hasPaid: false,
      deviceAllocated: false,
      phoneVerified: false,
    },
    password: 'Demo1234',
    payments: [],
  },
];

/** The seeded credentials, surfaced in the dev-only mock banner. */
export const MOCK_DEMO_CREDENTIALS = {
  email: 'demo@example.com',
  password: 'Demo1234',
} as const;

// --- Devices (mock inventory) ------------------------------------------------

interface MockDevice {
  id: string;
  serialNumber: string;
  status: DeviceStatus;
  lockState: LockState;
  lockStateUpdatedAt: string | null;
  online: boolean;
  lastSeenAt: string | null;
  ownerId: string | null;
  allocatedAt: string | null;
  createdAt: string;
}

/**
 * Seeded inventory so the admin panel has something to show in mock mode.
 * Two devices in stock, one already retired.
 */
const devices: MockDevice[] = [
  makeMockDevice('SAFE-0001', 0),
  makeMockDevice('SAFE-0002', 1),
  { ...makeMockDevice('SAFE-0003', 2), status: 'RETIRED' },
];

function makeMockDevice(serialNumber: string, ageIndex: number): MockDevice {
  return {
    id: `dev_mock_${serialNumber.toLowerCase().replace(/[^a-z0-9]/g, '')}`,
    serialNumber,
    status: 'UNASSIGNED',
    // Mirrors the API: a safe in stock is locked, not of unknown state.
    lockState: 'LOCKED',
    lockStateUpdatedAt: null,
    online: false,
    lastSeenAt: null,
    ownerId: null,
    allocatedAt: null,
    // Older index = created earlier, so "next available" ordering is stable.
    createdAt: new Date(Date.UTC(2026, 0, 1) + ageIndex * 60_000).toISOString(),
  };
}

/** A mock audit trail, newest last. */
const auditLog: AdminAuditRow[] = [];

// --- Device events and notifications (mock) ----------------------------------

/**
 * The mock's `DeviceEvent` rows, newest last.
 *
 * Mirrors the API's table closely enough that `/history` exercises the same
 * cursor pagination and day grouping — including the case the real
 * implementation is careful about, several events sharing one timestamp.
 */
interface MockDeviceEvent {
  id: string;
  userId: string;
  serialNumber: string;
  type: DeviceEventType;
  failureReason: UnlockFailureReason | null;
  createdAt: string;
}

const deviceEvents: MockDeviceEvent[] = [];
let eventSequence = 0;

interface MockNotification {
  id: string;
  userId: string;
  type: NotificationType;
  deviceEventId: string | null;
  createdAt: string;
  readAt: string | null;
}

const notifications: MockNotification[] = [];
let notificationSequence = 0;

function recordMockEvent(input: {
  userId: string;
  serialNumber: string;
  type: DeviceEventType;
  failureReason?: UnlockFailureReason | null;
  createdAt?: string;
}): MockDeviceEvent {
  eventSequence += 1;
  const event: MockDeviceEvent = {
    id: `evt_mock_${String(eventSequence).padStart(4, '0')}`,
    userId: input.userId,
    serialNumber: input.serialNumber,
    type: input.type,
    failureReason: input.failureReason ?? null,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  deviceEvents.push(event);
  return event;
}

/** Mirrors the API: a notification is created with the event, never alone. */
function recordMockNotification(input: {
  userId: string;
  type: NotificationType;
  deviceEventId: string;
  createdAt?: string;
}): void {
  notificationSequence += 1;
  notifications.push({
    id: `ntf_mock_${String(notificationSequence).padStart(4, '0')}`,
    userId: input.userId,
    type: input.type,
    deviceEventId: input.deviceEventId,
    createdAt: input.createdAt ?? new Date().toISOString(),
    readAt: null,
  });
}

/**
 * Invents a few days of past activity for a freshly allocated safe.
 *
 * Mock-only, and the one place this fake deliberately diverges from the API:
 * without it `/history` is empty until someone clicks Lock twenty times, so
 * day grouping, "Load more" and the unread badge could not be reviewed at all.
 * Two events share a timestamp on purpose — that is the case the real cursor
 * is built to survive.
 */
function seedMockHistory(userId: string, serialNumber: string): void {
  const dayMs = 24 * 60 * 60 * 1000;
  const start = Date.now() - 3 * dayMs;
  const script: Array<{ type: DeviceEventType; failureReason?: UnlockFailureReason }> = [
    { type: 'LOCK' },
    { type: 'UNLOCK_REQUESTED' },
    { type: 'UNLOCK_CONFIRMED' },
    { type: 'UNLOCK_FAILED', failureReason: 'WRONG_CODE' },
    { type: 'UNLOCK_REQUESTED' },
    { type: 'UNLOCK_FAILED', failureReason: 'EXPIRED' },
    { type: 'LOCK' },
    { type: 'UNLOCK_REQUESTED' },
  ];

  for (let index = 0; index < 24; index += 1) {
    const step = script[index % script.length]!;
    // Spread across three days, with every 7th event sharing its predecessor's
    // timestamp so the tie-breaking path is exercised.
    const offset = index % 7 === 0 && index > 0 ? (index - 1) * 2 * 60 * 60 * 1000 : index * 2 * 60 * 60 * 1000;

    recordMockEvent({
      userId,
      serialNumber,
      type: step.type,
      failureReason: step.failureReason ?? null,
      createdAt: new Date(start + offset).toISOString(),
    });
  }
}

function recordAudit(action: string, extra: Partial<AdminAuditRow> = {}): void {
  auditLog.push({
    id: `aud_mock_${auditLog.length + 1}`,
    action,
    userId: extra.userId ?? null,
    deviceId: extra.deviceId ?? null,
    ip: '127.0.0.1',
    userAgent: 'MockApi/1.0',
    metadata: extra.metadata ?? { mock: true },
    createdAt: new Date().toISOString(),
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(status: number, code: string, message: string): never {
  const body: ApiErrorBody = { error: { code, message } };
  throw apiErrorFromBody(body, status);
}

function getSessionUserId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

function setSessionUserId(id: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (id === null) window.sessionStorage.removeItem(SESSION_KEY);
    else window.sessionStorage.setItem(SESSION_KEY, id);
  } catch {
    /* storage unavailable (private mode) — the mock session is then per-page */
  }
}

/**
 * Routes a request from the API client to a fake handler.
 *
 * Paths arrive with their query string attached, and the admin routes carry
 * ids in the path, so this splits the two apart and falls through to pattern
 * matching for the parameterised routes.
 */
export async function mockRequest<T>(
  method: HttpMethod,
  path: string,
  body: unknown,
): Promise<T> {
  await delay(LATENCY_MS);

  const [pathname = path, rawQuery = ''] = path.split('?');
  const query = new URLSearchParams(rawQuery);
  const route = `${method} ${pathname}`;

  switch (route) {
    case 'POST /auth/login':
      return handleLogin(body) as T;
    case 'POST /auth/signup':
      return handleSignup(body) as T;
    case 'POST /auth/logout':
      setSessionUserId(null);
      return null as T;
    case 'GET /auth/me':
      return handleMe() as T;
    case 'POST /auth/refresh':
      return handleRefresh() as T;
    case 'POST /auth/password/forgot':
      return handleMockForgotPassword(body) as T;
    case 'POST /auth/password/reset':
      return handleMockResetPassword(body) as T;
    case 'POST /auth/password/change':
      return handleMockChangePassword(body) as T;
    case 'PATCH /auth/profile':
      return handleMockUpdateProfile(body) as T;
    case 'POST /account/phone/request-verification':
      return handleMockRequestPhoneVerification(body) as T;
    case 'POST /account/phone/confirm':
      return handleMockConfirmPhoneVerification(body) as T;
    case 'GET /payments/me':
      return handlePaymentMe() as T;
    case 'POST /payments/order':
      return handleCreateOrder() as T;
    case 'POST /payments/verify':
      return handleVerifyPayment(body) as T;
    case 'GET /devices/mine':
      return handleMyDevice() as T;
    case 'GET /devices/history':
      return handleMockHistory(query) as T;
    case 'GET /notifications':
      return handleMockNotifications(query) as T;
    case 'POST /notifications/read':
      return handleMockMarkRead(body) as T;
    case 'POST /devices/lock':
      return handleMockLock() as T;
    case 'POST /devices/unlock/request':
      return handleMockUnlockRequest() as T;
    case 'POST /devices/unlock/confirm':
      return handleMockUnlockConfirm(body) as T;
    case 'GET /admin/devices':
      return handleAdminDevices(query) as T;
    case 'POST /admin/devices':
      return handleAdminCreateDevice(body) as T;
    case 'POST /admin/devices/bulk':
      return handleAdminBulkCreate(body) as T;
    case 'POST /admin/allocate-next':
      return handleAdminAllocate(body, undefined) as T;
    case 'GET /admin/users':
      return handleAdminUsers(query) as T;
    case 'GET /admin/payments':
      return handleAdminPayments(query) as T;
    case 'GET /admin/audit':
      return handleAdminAudit(query) as T;
    default:
      break;
  }

  // Parameterised admin device routes.
  const deviceAction = /^\/admin\/devices\/([^/]+)\/(allocate|unassign|retire)$/.exec(pathname);
  if (method === 'POST' && deviceAction) {
    const [, deviceId, action] = deviceAction as unknown as [string, string, string];

    if (action === 'allocate') return handleAdminAllocate(body, deviceId) as T;
    if (action === 'unassign') return handleAdminUnassign(deviceId) as T;
    return handleAdminRetire(deviceId) as T;
  }

  return fail(
    404,
    ERROR_CODES.NOT_FOUND,
    `Mock API has no handler for ${route}. Turn off NEXT_PUBLIC_USE_MOCK_API to use the real API.`,
  );
}

function handleLogin(body: unknown): AuthResponse {
  const { identifier, password } = (body ?? {}) as { identifier?: string; password?: string };

  if (typeof identifier !== 'string' || typeof password !== 'string') {
    return fail(400, ERROR_CODES.VALIDATION_ERROR, 'Email/phone and password are required.');
  }

  const needle = identifier.trim();
  const byPhone = classifyIdentifier(needle) === 'phone';
  const account = accounts.find((candidate) =>
    byPhone
      ? candidate.user.phone === needle
      : candidate.user.email === needle.toLowerCase(),
  );

  // One generic failure for "no such account" and "wrong password" alike, so
  // the response cannot be used to enumerate registered users.
  if (!account || account.password !== password) {
    return fail(401, ERROR_CODES.INVALID_CREDENTIALS, GENERIC_LOGIN_ERROR);
  }

  setSessionUserId(account.user.id);
  return { user: account.user };
}

function handleSignup(body: unknown): AuthResponse {
  const input = (body ?? {}) as {
    name?: string;
    email?: string;
    phone?: string;
    password?: string;
  };

  if (
    typeof input.name !== 'string' ||
    typeof input.email !== 'string' ||
    typeof input.phone !== 'string' ||
    typeof input.password !== 'string'
  ) {
    return fail(400, ERROR_CODES.VALIDATION_ERROR, 'All fields are required.');
  }

  const email = input.email.trim().toLowerCase();
  const phone = input.phone.trim();

  if (accounts.some((candidate) => candidate.user.email === email)) {
    return fail(
      409,
      ERROR_CODES.EMAIL_ALREADY_REGISTERED,
      'An account with this email already exists. Try logging in instead.',
    );
  }

  if (accounts.some((candidate) => candidate.user.phone === phone)) {
    return fail(
      409,
      ERROR_CODES.PHONE_ALREADY_REGISTERED,
      'An account with this phone number already exists. Try logging in instead.',
    );
  }

  const user: PublicUser = {
    id: `usr_mock_${Math.random().toString(36).slice(2, 10)}`,
    name: input.name.trim(),
    email,
    phone,
    role: 'USER',
    createdAt: new Date().toISOString(),
    hasPaid: false,
    deviceAllocated: false,
    phoneVerified: false,
  };

  accounts.push({ user, password: input.password, payments: [] });
  setSessionUserId(user.id);
  return { user };
}

function handleMe(): AuthResponse {
  return { user: requireAccount().user };
}

/**
 * Stand-in for `POST /auth/refresh`.
 *
 * The mock has no access-token expiry to recover from, so this just confirms
 * the fake session is still there. It exists so the API client's
 * refresh-and-retry path resolves in mock mode instead of 404ing.
 */
function handleRefresh(): AuthResponse {
  return { user: requireAccount().user };
}

/** The signed-in mock account, or a 401 exactly as the API would answer. */
function requireAccount(): MockAccount {
  const id = getSessionUserId();
  const account = id ? accounts.find((candidate) => candidate.user.id === id) : undefined;

  if (!account) {
    setSessionUserId(null);
    return fail(401, ERROR_CODES.UNAUTHENTICATED, 'You are not signed in.');
  }

  return account;
}

// --- Password reset / account (mock) ----------------------------------------

/**
 * The mock's in-memory reset token.
 *
 * Unlike the API this keeps the token in plaintext — it has to, because there
 * is nowhere to deliver it and the dev-only panel on `/forgot-password`
 * displays it. That is exactly why mock mode is refused in production builds
 * (`lib/env.ts`): this object would be a working account-takeover credential
 * sitting in browser memory.
 */
interface MockResetToken {
  email: string;
  token: string;
  expiresAt: number;
  consumed: boolean;
}

let mockResetToken: MockResetToken | null = null;

/**
 * The reset token the mock just issued, for the dev-only hint on
 * `/forgot-password`. There is no equivalent in the real flow — the API never
 * returns a token, only a neutral `{ status: 'ok' }`.
 *
 * Guarded exactly like {@link peekMockUnlockCode}: callers gate on
 * `USE_MOCK_API`, which cannot be true in a production build.
 */
export function peekMockResetToken(): string | null {
  if (!mockResetToken || mockResetToken.consumed) return null;
  if (mockResetToken.expiresAt <= Date.now()) return null;
  return mockResetToken.token;
}

/**
 * Mirrors the API: the response is the same for a registered and an
 * unregistered address, and a new request supersedes any older live token.
 */
function handleMockForgotPassword(body: unknown): ForgotPasswordResponse {
  const parsed = forgotPasswordSchema.safeParse(body ?? {});

  if (!parsed.success) {
    return fail(
      400,
      ERROR_CODES.VALIDATION_ERROR,
      parsed.error.issues[0]?.message ?? 'Enter a valid email address',
    );
  }

  const account = accounts.find((candidate) => candidate.user.email === parsed.data.email);

  // A token is only minted for a real account — but the answer below does not
  // depend on that, which is the whole point of the endpoint.
  if (account) {
    mockResetToken = {
      email: account.user.email,
      token: mockRandomToken(),
      expiresAt: Date.now() + PASSWORD_RESET_TTL_MS,
      consumed: false,
    };
    recordAudit('auth.password.reset_requested', { userId: account.user.id });
  } else {
    recordAudit('auth.password.reset_requested_unknown');
  }

  return { status: 'ok' };
}

/** 32 bytes of base64url, the same shape the API issues. */
function mockRandomToken(): string {
  const bytes = new Uint8Array(RESET_TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Mirrors the API, including that a successful reset does **not** sign in. */
function handleMockResetPassword(body: unknown): PasswordResetResponse {
  const parsed = resetPasswordBodySchema.safeParse(body ?? {});

  if (!parsed.success) {
    return fail(
      400,
      ERROR_CODES.VALIDATION_ERROR,
      parsed.error.issues[0]?.message ?? 'Please check the highlighted fields.',
    );
  }

  const live = mockResetToken;
  const usable =
    live !== null &&
    !live.consumed &&
    live.expiresAt > Date.now() &&
    live.token === parsed.data.token;

  // Unknown, expired and already-used all answer identically.
  if (!live || !usable) {
    return fail(
      400,
      ERROR_CODES.RESET_TOKEN_INVALID,
      'That reset link is invalid or has expired. Please request a new one.',
    );
  }

  const account = accounts.find((candidate) => candidate.user.email === live.email);
  if (!account) {
    return fail(
      400,
      ERROR_CODES.RESET_TOKEN_INVALID,
      'That reset link is invalid or has expired. Please request a new one.',
    );
  }

  live.consumed = true;
  account.password = parsed.data.password;
  // Every session ends, like the API revoking all refresh tokens — and the
  // caller is *not* signed in by this.
  setSessionUserId(null);
  recordAudit('auth.password.reset_completed', { userId: account.user.id });

  return { status: 'ok' };
}

function handleMockChangePassword(body: unknown): AuthResponse {
  const account = requireAccount();
  const parsed = changePasswordBodySchema.safeParse(body ?? {});

  if (!parsed.success) {
    return fail(
      400,
      ERROR_CODES.VALIDATION_ERROR,
      parsed.error.issues[0]?.message ?? 'Please check the highlighted fields.',
    );
  }

  // A 400, not a 401 — matching the API, so the client's refresh-and-retry
  // path is never triggered by a mistyped password.
  if (account.password !== parsed.data.currentPassword) {
    return fail(400, ERROR_CODES.PASSWORD_INCORRECT, 'That is not your current password.');
  }

  account.password = parsed.data.password;
  // The caller stays signed in; the mock has no other sessions to revoke.
  recordAudit('auth.password.changed', { userId: account.user.id });

  return { user: account.user };
}

function handleMockUpdateProfile(body: unknown): AuthResponse {
  const account = requireAccount();
  // `.strict()`, so a body also carrying an email or phone is a 400 here too.
  const parsed = updateProfileSchema.safeParse(body ?? {});

  if (!parsed.success) {
    return fail(
      400,
      ERROR_CODES.VALIDATION_ERROR,
      parsed.error.issues[0]?.message ?? 'Please check the highlighted fields.',
    );
  }

  account.user = { ...account.user, name: parsed.data.name };
  recordAudit('auth.profile.updated', { userId: account.user.id });

  return { user: account.user };
}

// --- Phone verification (mock) ----------------------------------------------

/**
 * The mock's in-memory verification challenge.
 *
 * Holds the code in plaintext, as the unlock challenge does and for the same
 * reason: there is nowhere to deliver it and the dev-only panel displays it.
 * Which is exactly why mock mode is refused in production builds.
 */
interface MockPhoneChallenge {
  userId: string;
  phoneE164: string;
  code: string;
  expiresAt: number;
  attempts: number;
  consumed: boolean;
}

let mockPhoneChallenge: MockPhoneChallenge | null = null;

/**
 * The verification code the mock just issued, for the dev-only hint.
 *
 * Guarded exactly like {@link peekMockUnlockCode}: callers gate on
 * `USE_MOCK_API`, which cannot be true in a production build.
 */
export function peekMockPhoneCode(): string | null {
  if (!mockPhoneChallenge || mockPhoneChallenge.consumed) return null;
  if (mockPhoneChallenge.expiresAt <= Date.now()) return null;
  return mockPhoneChallenge.code;
}

function handleMockRequestPhoneVerification(
  body: unknown,
): PhoneVerificationRequestResponse {
  const account = requireAccount();
  const parsed = requestPhoneVerificationSchema.safeParse(body ?? {});

  if (!parsed.success) {
    return fail(
      400,
      ERROR_CODES.VALIDATION_ERROR,
      parsed.error.issues[0]?.message ?? 'Enter a valid mobile number',
    );
  }

  // Consent first and unconditionally, matching the API.
  if (!parsed.data.consent) {
    return fail(
      400,
      ERROR_CODES.CONSENT_REQUIRED,
      'Please agree to receive WhatsApp messages so we can send your code.',
    );
  }

  const national = toNationalPhone(parsed.data.phone)!;

  if (account.user.phoneVerified && account.user.phone === national) {
    return fail(
      409,
      ERROR_CODES.PHONE_ALREADY_VERIFIED,
      'That number is already verified on your account.',
    );
  }

  // Changing an already-verified number needs the password, as on the server.
  if (account.user.phoneVerified) {
    if (parsed.data.currentPassword !== account.password) {
      return fail(
        400,
        ERROR_CODES.PASSWORD_INCORRECT,
        'Enter your current password to change your verified number.',
      );
    }
  }

  /**
   * Uniqueness fails closed, exactly as the API does: a number owned by
   * another account answers identically and sends nothing. The masked number
   * below is what lets a user spot their own typo.
   */
  const takenByAnother = accounts.some(
    (candidate) => candidate.user.id !== account.user.id && candidate.user.phone === national,
  );

  if (!takenByAnother) {
    mockPhoneChallenge = {
      userId: account.user.id,
      phoneE164: parsed.data.phone,
      code: String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0'),
      expiresAt: Date.now() + PHONE_OTP_TTL_MS,
      attempts: 0,
      consumed: false,
    };
    recordAudit('account.phone.verification_requested', { userId: account.user.id });
  } else {
    recordAudit('account.phone.verification_requested', {
      userId: account.user.id,
      metadata: { collision: true, sent: false },
    });
  }

  return {
    maskedPhone: maskPhone(parsed.data.phone),
    expiresAt: new Date(Date.now() + PHONE_OTP_TTL_MS).toISOString(),
    expiresInSeconds: Math.round(PHONE_OTP_TTL_MS / 1000),
    attemptsAllowed: PHONE_OTP_MAX_ATTEMPTS,
    resendAfterSeconds: PHONE_OTP_RESEND_COOLDOWN_SECONDS,
  };
}

function handleMockConfirmPhoneVerification(body: unknown): AuthResponse {
  const account = requireAccount();
  const parsed = confirmPhoneVerificationSchema.safeParse(body ?? {});

  if (!parsed.success) {
    return fail(
      400,
      ERROR_CODES.VALIDATION_ERROR,
      parsed.error.issues[0]?.message ?? 'Enter the 6-digit code',
    );
  }

  const challenge = mockPhoneChallenge;
  const live =
    challenge !== null && !challenge.consumed && challenge.userId === account.user.id;

  if (!challenge || !live) {
    return fail(
      400,
      ERROR_CODES.PHONE_VERIFICATION_NOT_FOUND,
      'That code is no longer valid. Request a new one.',
    );
  }

  if (challenge.expiresAt <= Date.now()) {
    challenge.consumed = true;
    return fail(
      400,
      ERROR_CODES.PHONE_VERIFICATION_EXPIRED,
      'That code has expired. Request a new one.',
    );
  }

  if (parsed.data.otp !== challenge.code) {
    challenge.attempts += 1;

    if (challenge.attempts >= PHONE_OTP_MAX_ATTEMPTS) {
      challenge.consumed = true;
      return fail(
        400,
        ERROR_CODES.PHONE_VERIFICATION_TOO_MANY_ATTEMPTS,
        'Too many incorrect codes. Request a new one.',
      );
    }

    const left = PHONE_OTP_MAX_ATTEMPTS - challenge.attempts;
    return fail(
      400,
      ERROR_CODES.PHONE_VERIFICATION_INVALID,
      `That code is not correct. ${left} attempt${left === 1 ? '' : 's'} left.`,
    );
  }

  challenge.consumed = true;
  // Only now does the number become the account's, as on the server.
  account.user = {
    ...account.user,
    phone: toNationalPhone(challenge.phoneE164)!,
    phoneVerified: true,
  };
  recordAudit('account.phone.verified', { userId: account.user.id });

  return { user: account.user };
}

// --- Payments ----------------------------------------------------------------

function latestPayment(account: MockAccount): PaymentSummary | null {
  return account.payments.at(-1) ?? null;
}

function handlePaymentMe(): PaymentMeResponse {
  const account = requireAccount();

  return {
    hasPaid: account.user.hasPaid,
    payment: latestPayment(account),
    priceInPaise: MOCK_PRICE_PAISE,
    currency: 'INR',
  };
}

function handleCreateOrder(): CreateOrderResponse {
  const account = requireAccount();

  if (account.user.hasPaid) {
    return fail(
      409,
      ERROR_CODES.ALREADY_PAID,
      'This account has already been activated. No further payment is needed.',
    );
  }

  const suffix = Math.random().toString(36).slice(2, 12);
  const payment: PaymentSummary = {
    id: `pay_row_mock_${suffix}`,
    amount: MOCK_PRICE_PAISE,
    currency: 'INR',
    status: 'CREATED',
    razorpayOrderId: `order_mock${suffix}`,
    createdAt: new Date().toISOString(),
    paidAt: null,
  };
  account.payments.push(payment);

  return {
    orderId: payment.razorpayOrderId,
    amount: payment.amount,
    currency: payment.currency,
    // A fake publishable key. The real one comes from the API's config, and
    // the key *secret* exists only on the server in either mode.
    keyId: 'rzp_test_mock_key_id',
    paymentId: payment.id,
  };
}

function handleVerifyPayment(body: unknown): VerifyPaymentResponse {
  const account = requireAccount();
  const input = (body ?? {}) as {
    razorpay_order_id?: string;
    razorpay_payment_id?: string;
    razorpay_signature?: string;
  };

  const payment = account.payments.find(
    (candidate) => candidate.razorpayOrderId === input.razorpay_order_id,
  );

  if (!payment) {
    return fail(
      404,
      ERROR_CODES.NOT_FOUND,
      'We could not find that payment. Please start the payment again.',
    );
  }

  // Idempotent, like the API: a repeat call returns the settled row.
  if (payment.status === 'PAID') {
    return { payment, hasPaid: true };
  }

  if (input.razorpay_signature !== MOCK_CHECKOUT_SIGNATURE) {
    return fail(
      400,
      ERROR_CODES.INVALID_SIGNATURE,
      'We could not verify this payment. Please contact support before paying again.',
    );
  }

  payment.status = 'PAID';
  payment.paidAt = new Date().toISOString();
  // hasPaid is derived from payments on the server; the mock mirrors that by
  // updating the user object the UI reads.
  account.user = { ...account.user, hasPaid: true };

  return { payment, hasPaid: true };
}

// --- Devices -----------------------------------------------------------------

function deviceOwner(device: MockDevice): { id: string; name: string; email: string } | null {
  if (!device.ownerId) return null;
  const account = accounts.find((candidate) => candidate.user.id === device.ownerId);
  if (!account) return null;
  return {
    id: account.user.id,
    name: account.user.name,
    email: account.user.email,
  };
}

/** Mirrors the API's AdminDeviceRow — note there is no credentialHash here. */
function toAdminDevice(device: MockDevice): AdminDeviceRow {
  return {
    id: device.id,
    serialNumber: device.serialNumber,
    status: device.status,
    lockState: device.lockState,
    lockStateUpdatedAt: device.lockStateUpdatedAt,
    online: device.online,
    lastSeenAt: device.lastSeenAt,
    allocatedAt: device.allocatedAt,
    createdAt: device.createdAt,
    owner: deviceOwner(device),
  };
}

function paginateMock<T>(items: T[], query: URLSearchParams): Paginated<T> {
  const page = Math.max(1, Number(query.get('page') ?? 1) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(query.get('pageSize') ?? 20) || 20));
  const start = (page - 1) * pageSize;

  return {
    items: items.slice(start, start + pageSize),
    page,
    pageSize,
    total: items.length,
    totalPages: Math.max(1, Math.ceil(items.length / pageSize)),
  };
}

/** Recomputes `deviceAllocated` on the cached user object the UI reads. */
function syncAllocationFlag(userId: string): void {
  const account = accounts.find((candidate) => candidate.user.id === userId);
  if (!account) return;

  const owns = devices.some((device) => device.ownerId === userId);
  account.user = { ...account.user, deviceAllocated: owns };
}

function handleMyDevice(): MyDeviceResponse {
  const account = requireAccount();

  // Same gate as the real API's requirePaid on this route.
  if (!account.user.hasPaid) {
    return fail(402, ERROR_CODES.PAYMENT_REQUIRED, 'Complete your payment to activate your safe.');
  }

  const device = devices.find((candidate) => candidate.ownerId === account.user.id);
  if (!device) return { device: null };

  return { device: toDeviceSummary(device) };
}

function toDeviceSummary(device: MockDevice): DeviceSummary {
  return {
    id: device.id,
    serialNumber: device.serialNumber,
    lockState: device.lockState,
    lockStateUpdatedAt: device.lockStateUpdatedAt,
    online: device.online,
    lastSeenAt: device.lastSeenAt,
    allocatedAt: device.allocatedAt,
  };
}

// --- Lock / unlock (mock) ----------------------------------------------------

/**
 * The mock's in-memory unlock challenge.
 *
 * Unlike the API this keeps the code in plaintext — it has to, because there
 * is nowhere to send it and the dev-mode panel displays it. That is exactly
 * why mock mode is refused in production builds (`lib/env.ts`): this object
 * would be a working unlock code sitting in browser memory.
 */
interface MockChallenge {
  userId: string;
  deviceId: string;
  code: string;
  expiresAt: number;
  attempts: number;
  consumed: boolean;
}

let mockChallenge: MockChallenge | null = null;

/**
 * The code the mock just issued, for the dev-only hint on the unlock dialog.
 * There is no equivalent in the real flow — the API never returns a code.
 */
export function peekMockUnlockCode(): string | null {
  if (!mockChallenge || mockChallenge.consumed) return null;
  if (mockChallenge.expiresAt <= Date.now()) return null;
  return mockChallenge.code;
}

/** Mirrors assertCanOperate, including the order the states are checked in. */
function requireOperableDevice(): { account: MockAccount; device: MockDevice } {
  const account = requireAccount();
  const device = devices.find((candidate) => candidate.ownerId === account.user.id);

  if (!account.user.hasPaid) {
    if (device) {
      return fail(
        403,
        ERROR_CODES.REFUNDED_CONTACT_SUPPORT,
        'Your payment was refunded, so remote access is disabled. Please contact support about returning your safe.',
      );
    }
    return fail(402, ERROR_CODES.NOT_PAID, 'Complete your payment to activate your safe.');
  }

  if (!device || device.status !== 'ASSIGNED') {
    return fail(
      409,
      ERROR_CODES.NO_DEVICE,
      'No safe is allocated to your account yet. You will be notified once one is assigned.',
    );
  }

  if (device.lockState === 'UNKNOWN') {
    return fail(
      409,
      ERROR_CODES.DEVICE_STATE_UNKNOWN,
      'Your safe is not reporting its state. Please contact support.',
    );
  }

  return { account, device };
}

function handleMockLock(): LockResponse {
  const { account, device } = requireOperableDevice();

  if (device.lockState === 'LOCKED') {
    return { device: toDeviceSummary(device), alreadyLocked: true };
  }

  const now = new Date().toISOString();
  device.lockState = 'LOCKED';
  device.lockStateUpdatedAt = now;
  device.online = true;
  device.lastSeenAt = now;
  recordAudit('device.lock.success', { userId: account.user.id, deviceId: device.id });
  // No notification: locking is the safe state, matching the API.
  recordMockEvent({
    userId: account.user.id,
    serialNumber: device.serialNumber,
    type: 'LOCK',
  });

  return { device: toDeviceSummary(device), alreadyLocked: false };
}

function handleMockUnlockRequest(): UnlockRequestResponse {
  const { account, device } = requireOperableDevice();
  const expiresAt = Date.now() + OTP_TTL_MS;

  // A new request replaces any live code, exactly as the API does.
  mockChallenge = {
    userId: account.user.id,
    deviceId: device.id,
    code: String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0'),
    expiresAt,
    attempts: 0,
    consumed: false,
  };
  recordAudit('device.unlock.otp_requested', {
    userId: account.user.id,
    deviceId: device.id,
  });
  recordMockEvent({
    userId: account.user.id,
    serialNumber: device.serialNumber,
    type: 'UNLOCK_REQUESTED',
  });

  return {
    expiresAt: new Date(expiresAt).toISOString(),
    expiresInSeconds: Math.round(OTP_TTL_MS / 1000),
    attemptsAllowed: OTP_MAX_ATTEMPTS,
    resendAfterSeconds: OTP_RESEND_COOLDOWN_SECONDS,
  };
}

function handleMockUnlockConfirm(body: unknown): UnlockConfirmResponse {
  const { account, device } = requireOperableDevice();
  const parsed = otpSchema.safeParse((body as { otp?: unknown })?.otp ?? '');

  if (!parsed.success) {
    return fail(
      400,
      ERROR_CODES.VALIDATION_ERROR,
      parsed.error.issues[0]?.message ?? 'Enter the 6-digit code',
    );
  }

  const challenge = mockChallenge;
  const live =
    challenge !== null &&
    !challenge.consumed &&
    challenge.userId === account.user.id &&
    challenge.deviceId === device.id;

  if (!challenge || !live) {
    return fail(
      400,
      ERROR_CODES.OTP_NOT_FOUND,
      'That code is no longer valid. Request a new one.',
    );
  }

  if (challenge.expiresAt <= Date.now()) {
    challenge.consumed = true;
    recordMockEvent({
      userId: account.user.id,
      serialNumber: device.serialNumber,
      type: 'UNLOCK_FAILED',
      failureReason: 'EXPIRED',
    });
    return fail(400, ERROR_CODES.OTP_EXPIRED, 'That code has expired. Request a new one.');
  }

  if (parsed.data !== challenge.code) {
    challenge.attempts += 1;
    recordAudit('device.unlock.otp_failed', {
      userId: account.user.id,
      deviceId: device.id,
      metadata: { reason: 'wrong_code' },
    });

    if (challenge.attempts >= OTP_MAX_ATTEMPTS) {
      challenge.consumed = true;
      // Only the burned challenge notifies — a single typo does not.
      const event = recordMockEvent({
        userId: account.user.id,
        serialNumber: device.serialNumber,
        type: 'UNLOCK_FAILED',
        failureReason: 'TOO_MANY_ATTEMPTS',
      });
      recordMockNotification({
        userId: account.user.id,
        type: 'UNLOCK_FAILED_MAX_ATTEMPTS',
        deviceEventId: event.id,
      });
      return fail(
        400,
        ERROR_CODES.OTP_TOO_MANY_ATTEMPTS,
        'Too many incorrect codes. Request a new one.',
      );
    }

    recordMockEvent({
      userId: account.user.id,
      serialNumber: device.serialNumber,
      type: 'UNLOCK_FAILED',
      failureReason: 'WRONG_CODE',
    });

    const left = OTP_MAX_ATTEMPTS - challenge.attempts;
    return fail(
      400,
      ERROR_CODES.OTP_INVALID,
      `That code is not correct. ${left} attempt${left === 1 ? '' : 's'} left.`,
    );
  }

  challenge.consumed = true;
  const now = new Date().toISOString();
  device.lockState = 'UNLOCKED';
  device.lockStateUpdatedAt = now;
  device.online = true;
  device.lastSeenAt = now;
  recordAudit('device.unlock.success', { userId: account.user.id, deviceId: device.id });

  // Event and notification together, as one step — the API writes both in one
  // transaction and neither can exist without the other.
  const event = recordMockEvent({
    userId: account.user.id,
    serialNumber: device.serialNumber,
    type: 'UNLOCK_CONFIRMED',
  });
  recordMockNotification({
    userId: account.user.id,
    type: 'UNLOCK_CONFIRMED',
    deviceEventId: event.id,
  });

  return { device: toDeviceSummary(device) };
}

// --- History (mock) ----------------------------------------------------------

/**
 * Same cursor format as the API: `base64url("<iso>|<id>")`.
 *
 * Deliberately identical so the client's pagination is exercised against a
 * value of the same shape, and so a cursor is just as opaque here.
 */
function encodeMockCursor(event: MockDeviceEvent): string {
  return btoa(`${event.createdAt}|${event.id}`)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function decodeMockCursor(cursor: string): { createdAt: string; id: string } {
  let decoded: string;
  try {
    decoded = atob(cursor.replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    return fail(400, ERROR_CODES.INVALID_CURSOR, 'That page link is no longer valid.');
  }

  const parts = decoded.split('|');
  if (parts.length !== 2) {
    return fail(400, ERROR_CODES.INVALID_CURSOR, 'That page link is no longer valid.');
  }

  const [createdAt, id] = parts as [string, string];
  const parsed = new Date(createdAt);

  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== createdAt) {
    return fail(400, ERROR_CODES.INVALID_CURSOR, 'That page link is no longer valid.');
  }

  return { createdAt, id };
}

function toMockHistoryEvent(event: MockDeviceEvent): HistoryEvent {
  const failureReason = event.type === 'UNLOCK_FAILED' ? event.failureReason : null;

  return {
    id: event.id,
    type: event.type,
    label: DEVICE_EVENT_LABELS[event.type],
    serialNumber: event.serialNumber,
    failureReason,
    failureLabel: failureReason ? UNLOCK_FAILURE_LABELS[failureReason] : null,
    createdAt: event.createdAt,
  };
}

/**
 * The caller's activity, newest first, keyset-paginated.
 *
 * Note there is no paid or device check, matching the API: history is the
 * user's own record, and an empty list is the answer when there is nothing.
 */
function handleMockHistory(query: URLSearchParams): HistoryResponse {
  const account = requireAccount();
  const limit = parseMockLimit(query.get('limit'));
  const rawCursor = query.get('cursor');

  // Same total order as the API: createdAt DESC, then id DESC.
  const ordered = deviceEvents
    .filter((event) => event.userId === account.user.id)
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));

  let start = 0;
  if (rawCursor) {
    const after = decodeMockCursor(rawCursor);
    start = ordered.findIndex(
      (event) =>
        event.createdAt < after.createdAt ||
        (event.createdAt === after.createdAt && event.id < after.id),
    );
    if (start === -1) start = ordered.length;
  }

  const page = ordered.slice(start, start + limit);
  const hasMore = ordered.length > start + limit;
  const last = page.at(-1);

  return {
    items: page.map(toMockHistoryEvent),
    nextCursor: hasMore && last ? encodeMockCursor(last) : null,
  };
}

/** Mirrors the shared limit schema, including refusing rather than clamping. */
function parseMockLimit(raw: string | null): number {
  if (raw === null) return HISTORY_DEFAULT_LIMIT;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > HISTORY_MAX_LIMIT) {
    return fail(
      400,
      ERROR_CODES.VALIDATION_ERROR,
      `Limit must be a whole number between 1 and ${HISTORY_MAX_LIMIT}`,
    );
  }
  return value;
}

// --- Notifications (mock) ----------------------------------------------------

function toMockNotification(notification: MockNotification): NotificationItem {
  const copy = NOTIFICATION_COPY[notification.type];

  return {
    id: notification.id,
    type: notification.type,
    title: copy.title,
    body: copy.body,
    deviceEventId: notification.deviceEventId,
    createdAt: notification.createdAt,
    readAt: notification.readAt,
  };
}

function handleMockNotifications(query: URLSearchParams): NotificationsResponse {
  const account = requireAccount();
  const limit = parseMockLimit(query.get('limit'));

  const mine = notifications.filter(
    (notification) => notification.userId === account.user.id,
  );

  // Unread first, then newest first — the same ordering as the API.
  const ordered = mine.slice().sort((a, b) => {
    const unread = Number(a.readAt !== null) - Number(b.readAt !== null);
    return unread !== 0 ? unread : b.createdAt.localeCompare(a.createdAt);
  });

  return {
    items: ordered.slice(0, limit).map(toMockNotification),
    // The total, not the page's — the badge must not under-report.
    unreadCount: mine.filter((notification) => notification.readAt === null).length,
  };
}

function handleMockMarkRead(body: unknown): MarkNotificationsReadResponse {
  const account = requireAccount();
  const input = (body ?? {}) as { ids?: unknown };
  const ids = Array.isArray(input.ids) ? (input.ids as string[]) : undefined;

  let markedRead = 0;
  for (const notification of notifications) {
    // Ids that are not the caller's never match, exactly as on the server.
    if (notification.userId !== account.user.id) continue;
    if (notification.readAt !== null) continue;
    if (ids && !ids.includes(notification.id)) continue;

    notification.readAt = new Date().toISOString();
    markedRead += 1;
  }

  return {
    markedRead,
    unreadCount: notifications.filter(
      (notification) => notification.userId === account.user.id && notification.readAt === null,
    ).length,
  };
}

// --- Admin -------------------------------------------------------------------

/** Mirrors requireAdmin: 403 for anyone who is not an ADMIN. */
function requireAdminAccount(): MockAccount {
  const account = requireAccount();

  if (account.user.role !== 'ADMIN') {
    return fail(403, ERROR_CODES.FORBIDDEN, 'You do not have access to this resource.');
  }
  return account;
}

function handleAdminDevices(query: URLSearchParams): Paginated<AdminDeviceRow> {
  requireAdminAccount();

  const status = query.get('status');
  const q = (query.get('q') ?? '').trim().toLowerCase();

  const filtered = devices
    .filter((device) => (status ? device.status === status : true))
    .filter((device) => {
      if (!q) return true;
      const owner = deviceOwner(device);
      return (
        device.serialNumber.toLowerCase().includes(q) ||
        (owner?.name.toLowerCase().includes(q) ?? false) ||
        (owner?.email.toLowerCase().includes(q) ?? false)
      );
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(toAdminDevice);

  return paginateMock(filtered, query);
}

function handleAdminCreateDevice(body: unknown): { device: AdminDeviceRow } {
  requireAdminAccount();

  const input = (body ?? {}) as { serialNumber?: string };
  const parsed = serialNumberSchema.safeParse(input.serialNumber ?? '');

  if (!parsed.success) {
    return fail(
      400,
      ERROR_CODES.VALIDATION_ERROR,
      parsed.error.issues[0]?.message ?? 'Invalid serial number',
    );
  }

  if (devices.some((device) => device.serialNumber === parsed.data)) {
    return fail(
      409,
      ERROR_CODES.DUPLICATE_SERIAL,
      `A safe with serial ${parsed.data} is already in the inventory.`,
    );
  }

  const device = makeMockDevice(parsed.data, devices.length);
  // Newest-first ordering needs a real "now" rather than a seeded offset.
  device.createdAt = new Date().toISOString();
  devices.push(device);
  recordAudit('device.created', {
    deviceId: device.id,
    metadata: { serialNumber: device.serialNumber },
  });

  return { device: toAdminDevice(device) };
}

function handleAdminBulkCreate(body: unknown): BulkCreateResult {
  requireAdminAccount();

  const input = (body ?? {}) as { serialNumbers?: unknown };
  const rows = Array.isArray(input.serialNumbers) ? (input.serialNumbers as string[]) : [];

  if (rows.length === 0) {
    return fail(400, ERROR_CODES.VALIDATION_ERROR, 'Provide at least one serial number');
  }
  if (rows.length > 500) {
    return fail(
      400,
      ERROR_CODES.VALIDATION_ERROR,
      'Too many rows: at most 500 serial numbers per request',
    );
  }

  const results: BulkCreateRowResult[] = [];
  const seen = new Set<string>();

  rows.forEach((raw, index) => {
    const row = index + 1;
    const parsed = serialNumberSchema.safeParse(raw);

    if (!parsed.success) {
      results.push({
        row,
        serialNumber: normaliseSerial(String(raw)),
        status: 'invalid',
        message: parsed.error.issues[0]?.message ?? 'Invalid serial number',
      });
      return;
    }

    const serialNumber = parsed.data;

    if (seen.has(serialNumber)) {
      results.push({ row, serialNumber, status: 'duplicate', message: 'Repeated in this list' });
      return;
    }
    seen.add(serialNumber);

    if (devices.some((device) => device.serialNumber === serialNumber)) {
      results.push({ row, serialNumber, status: 'duplicate', message: 'Already in the inventory' });
      return;
    }

    const device = makeMockDevice(serialNumber, devices.length);
    device.createdAt = new Date().toISOString();
    devices.push(device);
    results.push({ row, serialNumber, status: 'created' });
  });

  const created = results.filter((row) => row.status === 'created').length;
  recordAudit('device.bulk_created', { metadata: { submitted: rows.length, created } });

  return {
    created,
    duplicates: results.filter((row) => row.status === 'duplicate').length,
    invalid: results.filter((row) => row.status === 'invalid').length,
    results,
  };
}

function handleAdminAllocate(body: unknown, deviceId?: string): { device: AdminDeviceRow } {
  requireAdminAccount();

  const input = (body ?? {}) as { userId?: string };
  const target = accounts.find((candidate) => candidate.user.id === input.userId);

  if (!target) return fail(404, ERROR_CODES.USER_NOT_FOUND, 'No user with that id.');

  if (!target.user.hasPaid) {
    return fail(
      402,
      ERROR_CODES.NOT_PAID,
      'This user has no verified payment, so no safe can be allocated.',
    );
  }

  if (devices.some((device) => device.ownerId === target.user.id)) {
    return fail(
      409,
      ERROR_CODES.ALREADY_HAS_DEVICE,
      'This user already has a safe allocated. Unassign it first.',
    );
  }

  let device: MockDevice | undefined;

  if (deviceId) {
    device = devices.find((candidate) => candidate.id === deviceId);
    if (!device) return fail(404, ERROR_CODES.NOT_FOUND, 'No safe with that id.');
    if (device.status !== 'UNASSIGNED') {
      return fail(
        409,
        ERROR_CODES.DEVICE_NOT_AVAILABLE,
        `That safe is ${device.status.toLowerCase()}, so it cannot be allocated.`,
      );
    }
  } else {
    // Oldest in stock first, matching the API's ordering.
    device = devices
      .filter((candidate) => candidate.status === 'UNASSIGNED')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];

    if (!device) {
      return fail(
        409,
        ERROR_CODES.NO_DEVICES_IN_STOCK,
        'No unassigned safes left in stock. Add more devices to the inventory.',
      );
    }
  }

  device.status = 'ASSIGNED';
  device.ownerId = target.user.id;
  device.allocatedAt = new Date().toISOString();
  syncAllocationFlag(target.user.id);
  // Mock-only: gives /history something to page through immediately. The real
  // API has no equivalent — a new owner's history starts empty.
  seedMockHistory(target.user.id, device.serialNumber);
  recordAudit('device.allocated', {
    userId: target.user.id,
    deviceId: device.id,
    metadata: { serialNumber: device.serialNumber, mode: deviceId ? 'specific' : 'next' },
  });

  return { device: toAdminDevice(device) };
}

interface MockDeviceMutation {
  device: AdminDeviceRow;
  previousOwnerId: string | null;
}

function handleAdminUnassign(deviceId: string): MockDeviceMutation {
  requireAdminAccount();

  const device = devices.find((candidate) => candidate.id === deviceId);
  if (!device) return fail(404, ERROR_CODES.NOT_FOUND, 'No safe with that id.');

  if (device.status !== 'ASSIGNED' || !device.ownerId) {
    return fail(
      409,
      ERROR_CODES.DEVICE_NOT_AVAILABLE,
      'That safe is not currently assigned to anyone.',
    );
  }

  const previousOwnerId = device.ownerId;
  device.status = 'UNASSIGNED';
  device.ownerId = null;
  device.allocatedAt = null;
  device.lockState = 'UNKNOWN';
  syncAllocationFlag(previousOwnerId);
  recordAudit('device.unassigned', {
    userId: previousOwnerId,
    deviceId: device.id,
    metadata: { serialNumber: device.serialNumber },
  });

  return { device: toAdminDevice(device), previousOwnerId };
}

function handleAdminRetire(deviceId: string): MockDeviceMutation {
  requireAdminAccount();

  const device = devices.find((candidate) => candidate.id === deviceId);
  if (!device) return fail(404, ERROR_CODES.NOT_FOUND, 'No safe with that id.');

  if (device.status === 'ASSIGNED') {
    return fail(
      409,
      ERROR_CODES.DEVICE_STILL_ASSIGNED,
      'That safe is still assigned to a user. Unassign it before retiring it.',
    );
  }
  if (device.status === 'RETIRED') {
    return fail(409, ERROR_CODES.DEVICE_NOT_AVAILABLE, 'That safe is already retired.');
  }

  device.status = 'RETIRED';
  device.online = false;
  recordAudit('device.retired', {
    deviceId: device.id,
    metadata: { serialNumber: device.serialNumber },
  });

  return { device: toAdminDevice(device), previousOwnerId: null };
}

function handleAdminUsers(query: URLSearchParams): Paginated<AdminUserRow> {
  requireAdminAccount();

  const paid = query.get('paid');
  const allocated = query.get('allocated');
  const q = (query.get('q') ?? '').trim().toLowerCase();

  const rows: AdminUserRow[] = accounts.map((account) => {
    const device = devices.find((candidate) => candidate.ownerId === account.user.id);
    const deviceSerial = device?.serialNumber ?? null;

    return {
      id: account.user.id,
      name: account.user.name,
      email: account.user.email,
      phone: account.user.phone,
      role: account.user.role,
      createdAt: account.user.createdAt,
      hasPaid: account.user.hasPaid,
      deviceSerial,
      refundedWithDevice: !account.user.hasPaid && deviceSerial !== null,
    };
  });

  const filtered = rows
    .filter((row) => (paid === null ? true : row.hasPaid === (paid === 'true')))
    .filter((row) =>
      allocated === null ? true : (row.deviceSerial !== null) === (allocated === 'true'),
    )
    .filter((row) => {
      if (!q) return true;
      return (
        row.name.toLowerCase().includes(q) ||
        row.email.toLowerCase().includes(q) ||
        row.phone.includes(q)
      );
    });

  // Same work-queue ordering as the API.
  const rank = (row: AdminUserRow): number => {
    if (row.refundedWithDevice) return 0;
    if (row.hasPaid && !row.deviceSerial) return 1;
    return 2;
  };
  filtered.sort((a, b) => rank(a) - rank(b));

  return paginateMock(filtered, query);
}

function handleAdminPayments(query: URLSearchParams): Paginated<AdminPaymentRow> {
  requireAdminAccount();

  const status = query.get('status');

  const rows: AdminPaymentRow[] = accounts.flatMap((account) =>
    account.payments.map((payment) => ({
      id: payment.id,
      amount: payment.amount,
      currency: payment.currency,
      status: payment.status,
      razorpayOrderId: payment.razorpayOrderId,
      createdAt: payment.createdAt,
      paidAt: payment.paidAt,
      user: {
        id: account.user.id,
        name: account.user.name,
        email: account.user.email,
      },
    })),
  );

  const filtered = rows
    .filter((row) => (status ? row.status === status : true))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return paginateMock(filtered, query);
}

function handleAdminAudit(query: URLSearchParams): Paginated<AdminAuditRow> {
  requireAdminAccount();

  const action = (query.get('action') ?? '').trim().toLowerCase();

  const filtered = auditLog
    .filter((entry) => (action ? entry.action.toLowerCase().includes(action) : true))
    .slice()
    .reverse();

  return paginateMock(filtered, query);
}
