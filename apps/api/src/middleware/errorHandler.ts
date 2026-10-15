import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ERROR_CODES, type ApiErrorBody } from '@safelock/shared';
import { HttpError } from '../lib/httpError';
import { logger } from '../lib/logger';
import { isProduction } from '../config/env';
import { AUDIT_ACTIONS, auditContext, writeAudit } from '../modules/audit/audit.service';

/** 404 for anything that matched no route. */
export const notFoundHandler: RequestHandler = (req, res) => {
  const body: ApiErrorBody = {
    error: {
      code: ERROR_CODES.NOT_FOUND,
      message: `No route for ${req.method} ${req.path}.`,
      requestId: req.id,
    },
  };
  res.status(404).json(body);
};

/**
 * The single place an error becomes a response.
 *
 * Only `HttpError` carries a client-safe message. Everything else is logged
 * server-side and answered with a generic 500 — an unexpected throw must not
 * leak a stack trace, a query, or a secret.
 *
 * Every response carries the request id so a user can quote it in a support
 * request and it can be matched to the exact log lines.
 */
export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  if (res.headersSent) return;

  const log = logger.child({ requestId: req.id });

  if (error instanceof HttpError) {
    const context = { path: req.path, method: req.method, code: error.code, ...error.logContext };

    if (error.status >= 500) log.error(context, error.message);
    else log.warn(context, error.message);

    // A blocked state-changing request is a security event worth keeping.
    if (error.code === ERROR_CODES.CSRF_ORIGIN_REJECTED) {
      void writeAudit({
        action: AUDIT_ACTIONS.ORIGIN_REJECTED,
        userId: req.user?.id ?? null,
        ...auditContext(req),
        metadata: { path: req.path, method: req.method, ...error.logContext },
      });
    }

    const body: ApiErrorBody = {
      error: {
        code: error.code,
        message: error.message,
        ...(error.fields ? { fields: error.fields } : {}),
        requestId: req.id,
      },
    };
    res.status(error.status).json(body);
    return;
  }

  // express.json() rejects malformed bodies with a SyntaxError carrying .status.
  const maybeBodyParserError = error as { type?: string; status?: number };
  if (maybeBodyParserError?.type === 'entity.parse.failed') {
    const body: ApiErrorBody = {
      error: {
        code: ERROR_CODES.VALIDATION_ERROR,
        message: 'Request body is not valid JSON.',
        requestId: req.id,
      },
    };
    res.status(400).json(body);
    return;
  }

  log.error(
    {
      path: req.path,
      method: req.method,
      reason: error instanceof Error ? error.message : 'unknown',
      ...(isProduction ? {} : { stack: error instanceof Error ? error.stack : undefined }),
    },
    'Unhandled error',
  );

  const body: ApiErrorBody = {
    error: {
      code: ERROR_CODES.INTERNAL_ERROR,
      message: 'Something went wrong. Please try again.',
      requestId: req.id,
    },
  };
  res.status(500).json(body);
};
