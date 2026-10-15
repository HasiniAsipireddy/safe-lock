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
  classifyIdentifier,
  type ApiErrorBody,
  type AuthResponse,
  type CreateOrderResponse,
  type PaymentMeResponse,
  type PaymentSummary,
  type PublicUser,
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

/** Routes a request from the API client to a fake handler. */
export async function mockRequest<T>(
  method: HttpMethod,
  path: string,
  body: unknown,
): Promise<T> {
  await delay(LATENCY_MS);
  const route = `${method} ${path}`;

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
    default:
      return fail(
        404,
        ERROR_CODES.NOT_FOUND,
        `Mock API has no handler for ${route}. Turn off NEXT_PUBLIC_USE_MOCK_API to use the real API.`,
      );
  }
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
