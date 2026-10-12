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
}

/**
 * Thin fetch wrapper for the Safe Lock API.
 *
 * - Base URL from NEXT_PUBLIC_API_URL
 * - JSON in / JSON out
 * - `credentials: 'include'` so the API's httpOnly auth cookies are sent.
 *   Tokens are never read or stored by this client.
 * - Non-2xx responses throw an {@link ApiError} carrying `{ error: { code, message } }`.
 */
export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal, headers } = options;
  const normalisedPath = path.startsWith('/') ? path : `/${path}`;

  if (USE_MOCK_API) {
    return mockRequest<T>(method, normalisedPath, body);
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${normalisedPath}`, {
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
