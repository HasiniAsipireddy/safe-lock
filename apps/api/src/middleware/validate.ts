import type { RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { badRequest } from '../lib/httpError';

/**
 * Validates `req.body` against a zod schema and replaces it with the parsed
 * result, so handlers only ever see trimmed, typed, schema-shaped input.
 *
 * Per-field messages are returned under `error.fields` so a form can attach
 * them to the right input.
 */
export function validateBody(schema: ZodType): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req.body ?? {});

    if (!result.success) {
      const fields: Record<string, string> = {};
      for (const issue of result.error.issues) {
        const key = issue.path.join('.') || '_';
        // First message per field wins — enough for a form to act on.
        fields[key] ??= issue.message;
      }
      next(badRequest('Please check the highlighted fields.', fields));
      return;
    }

    req.body = result.data;
    next();
  };
}

/**
 * Validates `req.query` and replaces it with the parsed result, so handlers
 * receive coerced, bounded values — a `page` that is a number, a `q` that is
 * within the length cap — rather than raw strings.
 *
 * Express 5 makes `req.query` a getter, so it is redefined rather than
 * assigned.
 */
export function validateQuery(schema: ZodType): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req.query ?? {});

    if (!result.success) {
      const fields: Record<string, string> = {};
      for (const issue of result.error.issues) {
        const key = issue.path.join('.') || '_';
        fields[key] ??= issue.message;
      }
      next(badRequest('Please check the request parameters.', fields));
      return;
    }

    Object.defineProperty(req, 'query', {
      value: result.data,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    next();
  };
}
