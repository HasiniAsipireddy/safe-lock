import type { Request } from 'express';

/**
 * Reads a single route parameter as a string.
 *
 * Express 5 types `req.params[name]` as `string | string[]`, because a path
 * pattern can bind one name more than once. None of ours do, so this takes the
 * first value and keeps every call site free of the narrowing.
 *
 * It returns `''` rather than `undefined` for a missing parameter: callers pass
 * the result straight to a lookup that answers 404, and an empty id matching
 * nothing is exactly that answer. There is no route that reaches a handler
 * without its parameter bound.
 */
export function routeParam(req: Request, name: string): string {
  const value = req.params[name];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}
