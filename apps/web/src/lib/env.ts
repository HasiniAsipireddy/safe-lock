/**
 * Public (client-visible) configuration.
 *
 * Only NEXT_PUBLIC_* values belong here. Nothing secret may ever be read in
 * this file — it is bundled into the browser.
 */

const rawApiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

export const API_BASE_URL = rawApiUrl.replace(/\/+$/, '');

export const USE_MOCK_API = process.env.NEXT_PUBLIC_USE_MOCK_API === 'true';

/**
 * Hard stop: the fake auth backend must never be reachable in a production
 * build. This module is imported by the API client, so the error is thrown at
 * startup (build time on the server, first load in the browser) rather than
 * silently letting anyone in with the demo credentials.
 */
if (USE_MOCK_API && process.env.NODE_ENV === 'production') {
  throw new Error(
    'NEXT_PUBLIC_USE_MOCK_API=true is not allowed in production. ' +
      'The mock API accepts seeded demo credentials and bypasses all real authentication. ' +
      'Unset NEXT_PUBLIC_USE_MOCK_API (or set it to false) and point NEXT_PUBLIC_API_URL at the real API.',
  );
}
