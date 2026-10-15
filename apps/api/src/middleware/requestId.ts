import crypto from 'node:crypto';
import type { RequestHandler } from 'express';

/**
 * Attaches a request id to every request.
 *
 * An incoming `X-Request-Id` is honoured so a trace survives across services
 * and shows up in the client's own logs — but only if it looks sane. The
 * header is attacker-controlled: it ends up in log lines and in a response
 * header, so an unvalidated value could inject newlines into the log stream
 * (forging entries) or smuggle control characters into the response.
 *
 * Accepted: 1-64 characters of `[A-Za-z0-9._-]`. Anything else is replaced
 * with a fresh UUID rather than rejected — a bad trace header should not fail
 * a user's request.
 */

export const REQUEST_ID_HEADER = 'X-Request-Id';

const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

export function normaliseRequestId(incoming: string | undefined): string {
  if (incoming && VALID_REQUEST_ID.test(incoming)) return incoming;
  return crypto.randomUUID();
}

export const requestId: RequestHandler = (req, res, next) => {
  const id = normaliseRequestId(req.get(REQUEST_ID_HEADER));

  // `req.id` is what the logger and the error handler read.
  req.id = id;
  res.setHeader(REQUEST_ID_HEADER, id);
  next();
};
