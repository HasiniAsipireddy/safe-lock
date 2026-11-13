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
 * Mirrors the API's `PHONE_VERIFICATION_REQUIRED`. Defaults to true; set
 * `NEXT_PUBLIC_REQUIRE_PHONE_VERIFICATION=false` only alongside the API flag,
 * for a local demo without WhatsApp. The API is what actually enforces it —
 * this only stops the UI disabling Unlock and nagging about a number.
 */
/**
 * Show "Simulate a successful payment" instead of opening Razorpay Checkout.
 * True in browser mock mode, or with `NEXT_PUBLIC_FAKE_PAYMENTS=true` against
 * an API running `PAYMENT_PROVIDER=fake`. Demo only; refused in production.
 */
export const FAKE_PAYMENTS =
  USE_MOCK_API || process.env.NEXT_PUBLIC_FAKE_PAYMENTS === 'true';

if (FAKE_PAYMENTS && process.env.NODE_ENV === 'production') {
  throw new Error('Fake payments (NEXT_PUBLIC_FAKE_PAYMENTS=true) are not allowed in production.');
}

export const REQUIRE_PHONE_VERIFICATION =
  process.env.NEXT_PUBLIC_REQUIRE_PHONE_VERIFICATION !== 'false';

if (!REQUIRE_PHONE_VERIFICATION && process.env.NODE_ENV === 'production') {
  throw new Error('NEXT_PUBLIC_REQUIRE_PHONE_VERIFICATION=false is not allowed in production.');
}

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
