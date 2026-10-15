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
