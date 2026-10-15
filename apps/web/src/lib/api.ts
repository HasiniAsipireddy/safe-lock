import { ERROR_CODES } from '@safelock/shared';
import { API_BASE_URL, USE_MOCK_API } from './env';
import { ApiError, apiErrorFromBody } from './apiError';
import { mockRequest } from './mockApi';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface RequestOptions {
  method?: HttpMethod;
  /** Serialised as a JSON body. */
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  /** Internal: set when this call is already a post-refresh retry. */
  _isRetry?: boolean;
}

/**
 * Paths that must never trigger the refresh-and-retry flow.
 *
 * - `/auth/refresh` would recurse into itself.
 * - `/auth/login` and `/auth/signup` return 401 to mean "wrong credentials",
 *   which is a real answer, not an expired session. Refreshing there would
 *   turn a bad password into a confusing round trip.
 */
const NO_REFRESH_PATHS = ['/auth/refresh', '/auth/login', '/auth/signup'];

/**
 * Single in-flight refresh promise.
 *
 * Several requests can 401 at the same moment — a dashboard that loads the
 * user and the payment state together, say. Without this, each would POST
 * `/auth/refresh` with the same cookie; the first would rotate it and the rest
 * would present a just-revoked token. Inside the 10 second grace window the
 * server forgives exactly one of those, and any beyond that trip reuse
 * detection and log the user out of every session. So: one refresh, shared.
 */
let inFlightRefresh: Promise<boolean> | null = null;

type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler | null = null;

/**
 * Registers what to do when a session cannot be recovered. AuthContext uses
 * this to drop the cached user so the route guards send them to /login.
 */
export function registerUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  onUnauthorized = handler;
}

/** Test seam: forgets any shared refresh promise. */
export function resetRefreshState(): void {
  inFlightRefresh = null;
}

function shouldAttemptRefresh(path: string, options: RequestOptions): boolean {
  if (options._isRetry) return false;
  return !NO_REFRESH_PATHS.some((candidate) => path.startsWith(candidate));
}

/** Runs at most one refresh at a time; concurrent callers await the same one. */
async function refreshSession(): Promise<boolean> {
  inFlightRefresh ??= (async () => {
    try {
      await rawFetch<unknown>('/auth/refresh', { method: 'POST', _isRetry: true });
      return true;
    } catch {
      return false;
    } finally {
      // Cleared in a microtask so every caller that is already awaiting this
      // promise resolves from it, rather than starting a second refresh.
      queueMicrotask(() => {
        inFlightRefresh = null;
      });
    }
  })();

  return inFlightRefresh;
}

/**
 * Thin fetch wrapper for the Safe Lock API.
 *
 * - Base URL from NEXT_PUBLIC_API_URL
 * - JSON in / JSON out
 * - `credentials: 'include'` so the API's httpOnly auth cookies are sent.
 *   Tokens are never read or stored by this client.
 * - A 401 triggers one shared refresh and one retry (see above).
 * - Non-2xx responses throw an {@link ApiError} carrying `{ error: { code, message } }`.
 */
export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const normalisedPath = path.startsWith('/') ? path : `/${path}`;

  if (USE_MOCK_API) {
    return mockRequest<T>(options.method ?? 'GET', normalisedPath, options.body);
  }

  try {
    return await rawFetch<T>(normalisedPath, options);
  } catch (error) {
    const isAuthFailure = error instanceof ApiError && error.status === 401;

    if (!isAuthFailure || !shouldAttemptRefresh(normalisedPath, options)) {
      throw error;
    }

    const refreshed = await refreshSession();

    if (!refreshed) {
      // The session is genuinely over. Tell the app once, then surface the
      // original error to the caller.
      onUnauthorized?.();
      throw error;
    }

    // One retry only. If it 401s again the session is not recoverable.
    try {
      return await rawFetch<T>(normalisedPath, { ...options, _isRetry: true });
    } catch (retryError) {
      if (retryError instanceof ApiError && retryError.status === 401) {
        onUnauthorized?.();
      }
      throw retryError;
    }
  }
}

/** One HTTP round trip, with no refresh handling. */
async function rawFetch<T>(path: string, options: RequestOptions): Promise<T> {
  const { method = 'GET', body, signal, headers } = options;

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiError({
      code: ERROR_CODES.NETWORK_ERROR,
      message: 'Could not reach the server. Check your connection and try again.',
      status: 0,
    });
  }

  const payload = await readJson(response);

  if (!response.ok) {
    throw apiErrorFromBody(payload, response.status);
  }

  return payload as T;
}

async function readJson(response: Response): Promise<unknown> {
  if (response.status === 204) return null;

  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export const api = {
  get: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    apiFetch<T>(path, { ...options, method: 'GET' }),
  post: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    apiFetch<T>(path, { ...options, method: 'POST', body }),
};
