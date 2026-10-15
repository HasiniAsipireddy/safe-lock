import { ERROR_CODES, type ErrorCode } from '@safelock/shared';

/**
 * An error that maps cleanly onto the `{ error: { code, message } }` envelope.
 * Anything else that reaches the error handler becomes a generic 500, so
 * internal details never leak to a client.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields?: Record<string, string>;
  /** Extra context for the server log only — never serialised to the client. */
  readonly logContext?: Record<string, unknown>;

  constructor(opts: {
    status: number;
    code: ErrorCode | string;
    message: string;
    fields?: Record<string, string>;
    logContext?: Record<string, unknown>;
  }) {
    super(opts.message);
    this.name = 'HttpError';
    this.status = opts.status;
    this.code = opts.code;
    if (opts.fields) this.fields = opts.fields;
    if (opts.logContext) this.logContext = opts.logContext;
  }
}

export const badRequest = (message: string, fields?: Record<string, string>) =>
  new HttpError({
    status: 400,
    code: ERROR_CODES.VALIDATION_ERROR,
    message,
    ...(fields ? { fields } : {}),
  });

export const unauthenticated = (message = 'You are not signed in.') =>
  new HttpError({ status: 401, code: ERROR_CODES.UNAUTHENTICATED, message });

export const forbidden = (message = 'You do not have access to this resource.') =>
  new HttpError({ status: 403, code: ERROR_CODES.FORBIDDEN, message });

export const notFound = (message = 'Not found.') =>
  new HttpError({ status: 404, code: ERROR_CODES.NOT_FOUND, message });

export const conflict = (code: string, message: string) =>
  new HttpError({ status: 409, code, message });

export const internalError = (message = 'Something went wrong. Please try again.') =>
  new HttpError({ status: 500, code: ERROR_CODES.INTERNAL_ERROR, message });
