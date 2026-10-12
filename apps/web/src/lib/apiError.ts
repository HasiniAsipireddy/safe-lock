import { ERROR_CODES, type ApiErrorBody } from '@safelock/shared';

/**
 * Error thrown by the API client for any non-2xx response, carrying the
 * `{ error: { code, message } }` envelope from CLAUDE.md.
 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly fields?: Record<string, string>;

  constructor(opts: {
    code: string;
    message: string;
    status: number;
    fields?: Record<string, string>;
  }) {
    super(opts.message);
    this.name = 'ApiError';
    this.code = opts.code;
    this.status = opts.status;
    this.fields = opts.fields;
  }
}

/** Builds an ApiError from a parsed response body, tolerating a malformed one. */
export function apiErrorFromBody(body: unknown, status: number): ApiError {
  const envelope = (body as ApiErrorBody | null | undefined)?.error;

  if (envelope && typeof envelope.message === 'string') {
    return new ApiError({
      code: typeof envelope.code === 'string' ? envelope.code : ERROR_CODES.INTERNAL_ERROR,
      message: envelope.message,
      status,
      fields: envelope.fields,
    });
  }

  return new ApiError({
    code: ERROR_CODES.INTERNAL_ERROR,
    message: 'Something went wrong. Please try again.',
    status,
  });
}

/** A user-presentable message for anything thrown by the API client. */
export function toUserMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return 'Something went wrong. Please try again.';
}
