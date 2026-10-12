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
  type PublicUser,
} from '@safelock/shared';
import { apiErrorFromBody } from './apiError';
import type { HttpMethod } from './api';

const LATENCY_MS = 650;
const SESSION_KEY = 'safelock.mock.session';

interface MockAccount {
  user: PublicUser;
  /** Mock-only, in memory, never persisted and never logged. */
  password: string;
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
    },
    password: 'Demo1234',
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
  };

  accounts.push({ user, password: input.password });
  setSessionUserId(user.id);
  return { user };
}

function handleMe(): AuthResponse {
  const id = getSessionUserId();
  const account = id ? accounts.find((candidate) => candidate.user.id === id) : undefined;

  if (!account) {
    setSessionUserId(null);
    return fail(401, ERROR_CODES.UNAUTHENTICATED, 'You are not signed in.');
  }

  return { user: account.user };
}
