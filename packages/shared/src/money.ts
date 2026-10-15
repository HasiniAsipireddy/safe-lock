/**
 * Money helpers.
 *
 * Every amount in this system is an **integer number of paise** (INR x 100).
 * Floats are never used for money — not in the database, not over the wire.
 */

/** Smallest currency unit per rupee. */
export const PAISE_PER_RUPEE = 100;

/**
 * Formats paise as an Indian-locale rupee string, e.g. `99900` -> `"₹999"`.
 *
 * Whole-rupee amounts drop the decimals; anything else keeps exactly two.
 */
export function formatInr(paise: number): string {
  if (!Number.isFinite(paise)) return '—';

  const hasPaise = paise % PAISE_PER_RUPEE !== 0;

  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: hasPaise ? 2 : 0,
    maximumFractionDigits: hasPaise ? 2 : 0,
  }).format(paise / PAISE_PER_RUPEE);
}
