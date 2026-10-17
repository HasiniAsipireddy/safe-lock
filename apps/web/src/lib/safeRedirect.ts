import { DEFAULT_REDIRECT, safeInternalPath as validate } from '@safelock/shared';

/**
 * The browser half of `?next=` validation.
 *
 * All the logic — and all the tests — live in `@safelock/shared`, which is a
 * pure function of a value and an origin. This file supplies the one thing
 * only a browser knows, so that the part worth testing is testable and the
 * part that cannot be is a single line.
 *
 * Called on the server render too (Next renders client components once on the
 * server), where there is no `window`. Then there is no origin to compare
 * against, and a value that cannot be checked is refused: the default path is
 * always a correct answer, and guessing an origin would be inventing the fact
 * the whole check rests on.
 */
export function safeInternalPath(raw: unknown): string {
  if (typeof window === 'undefined') return DEFAULT_REDIRECT;

  return validate(raw, window.location.origin);
}

/**
 * The validated `?next=` of the page currently open.
 *
 * Read from `window.location` rather than through `useSearchParams`,
 * deliberately. That hook opts a page out of static prerendering unless every
 * use is wrapped in a Suspense boundary — it broke the production build of
 * `/book` and `/login` when this was first written — and it buys nothing here:
 * these values are only ever read inside an effect or a submit handler, both
 * of which are client-only moments where `window` simply exists.
 */
export function nextFromLocation(): string {
  if (typeof window === 'undefined') return DEFAULT_REDIRECT;

  const raw = new URLSearchParams(window.location.search).get('next');

  return safeInternalPath(raw);
}

/**
 * Where the browser is now, as a path safe to hand to a `next` parameter.
 *
 * Validated like any other value even though it is ours: it costs nothing, and
 * it means no path reaches a `next` parameter unchecked whatever a future
 * caller does with this function.
 */
export function currentInternalPath(): string {
  if (typeof window === 'undefined') return DEFAULT_REDIRECT;

  return safeInternalPath(`${window.location.pathname}${window.location.search}`);
}

export { DEFAULT_REDIRECT };
