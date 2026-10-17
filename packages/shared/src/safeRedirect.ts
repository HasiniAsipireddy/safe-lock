/**
 * Validating a `?next=` redirect target.
 *
 * ## Why this is not a regex
 * A `next` parameter is attacker-controlled input that a browser will navigate
 * to, which makes a careless one an open redirect: a link to our own login
 * page that lands the user on a convincing copy of it, already primed to type
 * a password. The classic bypasses are all *shapes that look relative*:
 * `//evil.test` (protocol-relative), `/\evil.test` (backslash, which WHATWG
 * URL parsing treats as a slash for http(s)), `/%5Cevil.test`,
 * `https:/evil.test`. Pattern-matching has to anticipate every one of them.
 *
 * So the real check is not a pattern at all: **resolve the value against the
 * current origin and require the result to still be on that origin.** Any
 * value that escapes — by scheme, by authority, by backslash, by a parsing
 * quirk we have not thought of — produces a different origin and is refused.
 * The cheap textual rules are kept as well, in front of the parse, because
 * they refuse a few things an origin check alone would allow but no honest
 * link needs.
 *
 * Anything refused falls back to a fixed internal path. There is no "refuse
 * and show an error" case: a bad `next` is not the user's fault and is not
 * worth a dead end.
 */

/** Where a refused or absent target goes. */
export const DEFAULT_REDIRECT = '/dashboard';

/**
 * A `next` value longer than this is refused outright.
 *
 * Every legitimate target in this product is a short path. A long one is
 * either an attempt to smuggle something past a check or a URL that will not
 * survive being put in a link anyway.
 */
const MAX_LENGTH = 200;

/**
 * Percent-encoded separators, refused before the parse.
 *
 * `%2F` and `%5C` survive `new URL` as literal path characters, so an origin
 * check would pass them — `/%2F%2Fevil.test` really is same-origin, and would
 * simply 404. They are refused anyway: no internal path in this product needs
 * an encoded slash or backslash, so the only reason to send one is to get a
 * check to disagree with whatever reads the path next.
 */
const ENCODED_SEPARATORS = /%2f|%5c/i;

/**
 * Turns an untrusted `next` value into a path that is definitely on `origin`.
 *
 * `origin` is passed in rather than read from `window` so this stays pure and
 * testable; the browser wrapper supplies `window.location.origin`.
 *
 * Returns {@link DEFAULT_REDIRECT} for anything it will not vouch for.
 */
export function safeInternalPath(
  raw: unknown,
  origin: string,
  fallback: string = DEFAULT_REDIRECT,
): string {
  if (typeof raw !== 'string') return fallback;

  const value = raw.trim();

  if (value.length === 0 || value.length > MAX_LENGTH) return fallback;

  /**
   * Control characters, including tabs and newlines.
   *
   * URL parsers *strip* tabs and newlines rather than rejecting them, so
   * `/\tjavascript:alert(1)` and `java\nscript:` can both become something
   * else entirely after parsing. A value containing one was not written by
   * anything of ours.
   */
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return fallback;

  // Must be a single-slash-prefixed relative path. Catches `//evil.test` and
  // every absolute URL before the parser is involved at all.
  if (!value.startsWith('/') || value.startsWith('//')) return fallback;

  // A colon anywhere means a scheme or a port: `javascript:`, `data:`,
  // `https:`. No internal path in this product contains one.
  if (value.includes(':')) return fallback;

  // Backslashes, raw or encoded, plus encoded slashes.
  if (value.includes('\\') || ENCODED_SEPARATORS.test(value)) return fallback;

  /**
   * The check that actually guarantees it.
   *
   * Everything above is a shortcut. This is the part that holds: resolved
   * against our own origin, a safe value stays on our own origin.
   */
  let url: URL;
  try {
    url = new URL(value, origin);
  } catch {
    return fallback;
  }

  if (url.origin !== new URL(origin).origin) return fallback;

  // Re-derived from the parse, not echoed from the input, so what is returned
  // is the normalised path the URL parser agreed with.
  const path = `${url.pathname}${url.search}${url.hash}`;

  if (!path.startsWith('/') || path.startsWith('//')) return fallback;

  return path;
}
