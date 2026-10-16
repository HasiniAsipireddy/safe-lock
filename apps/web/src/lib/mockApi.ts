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
  ERROR_CODES,
  GENERIC_LOGIN_ERROR,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_SECONDS,
  OTP_TTL_MS,
  classifyIdentifier,
  normaliseSerial,
  otpSchema,
  serialNumberSchema,
  type AdminAuditRow,
  type AdminDeviceRow,
  type AdminPaymentRow,
  type AdminUserRow,
  type ApiErrorBody,
  type AuthResponse,
  type BulkCreateResult,
  type BulkCreateRowResult,
  type CreateOrderResponse,
  type DeviceStatus,
  type DeviceSummary,
  type LockResponse,
  type LockState,
  type MyDeviceResponse,
  type Paginated,
  type PaymentMeResponse,
  type PaymentSummary,
  type PublicUser,
  type UnlockConfirmResponse,
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
      // Starts unpaid so the /pay flow can be walked through end to end.
      hasPaid: false,
      deviceAllocated: false,
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
    case 'GET /payments/me':
      return handlePaymentMe() as T;
    case 'POST /payments/order':
      return handleCreateOrder() as T;
    case 'POST /payments/verify':
      return handleVerifyPayment(body) as T;
    case 'GET /devices/mine':
      return handleMyDevice() as T;
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
      return fail(
        400,
        ERROR_CODES.OTP_TOO_MANY_ATTEMPTS,
        'Too many incorrect codes. Request a new one.',
      );
    }

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

  return { device: toDeviceSummary(device) };
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
