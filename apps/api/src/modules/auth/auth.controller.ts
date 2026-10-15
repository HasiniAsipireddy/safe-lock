import type { Request, RequestHandler } from 'express';
import { ERROR_CODES, type AuthResponse } from '@safelock/shared';
import { HttpError, unauthenticated } from '../../lib/httpError';
import { AUDIT_ACTIONS, auditContext, writeAudit } from '../audit/audit.service';
import { loadPublicUser } from '../users/user.mapper';
import * as authService from './auth.service';
import { REFRESH_COOKIE, clearAuthCookies, setAuthCookies } from './tokens';
import {
  issueRefreshToken,
  redeemRefreshToken,
  revokeByRawToken,
} from './refreshToken.service';
import type { SignupBody } from './auth.schemas';
import type { LoginInput } from '@safelock/shared';

/** Issue context recorded against a refresh token, for the audit trail. */
function issueContext(req: Request) {
  const { ip, userAgent } = auditContext(req);
  return { ip, userAgent };
}

export const postSignup: RequestHandler = async (req, res, next) => {
  try {
    const body = req.body as SignupBody;
    const user = await authService.signup(body);

    const refresh = await issueRefreshToken(user.id, issueContext(req));
    setAuthCookies(res, { sub: user.id, role: user.role }, refresh.rawToken);

    await writeAudit({
      action: AUDIT_ACTIONS.SIGNUP,
      userId: user.id,
      ...auditContext(req),
    });

    const response: AuthResponse = { user };
    res.status(201).json(response);
  } catch (error) {
    next(error);
  }
};

export const postLogin: RequestHandler = async (req, res, next) => {
  const body = req.body as LoginInput;

  try {
    const user = await authService.login(body);

    const refresh = await issueRefreshToken(user.id, issueContext(req));
    setAuthCookies(res, { sub: user.id, role: user.role }, refresh.rawToken);

    await writeAudit({
      action: AUDIT_ACTIONS.LOGIN_SUCCESS,
      userId: user.id,
      ...auditContext(req),
    });

    const response: AuthResponse = { user };
    res.status(200).json(response);
  } catch (error) {
    // Records the attempt without storing the identifier's password or
    // revealing whether the account exists.
    await writeAudit({
      action: AUDIT_ACTIONS.LOGIN_FAILED,
      ...auditContext(req),
      metadata: { identifierKind: body?.identifier?.includes('@') ? 'email' : 'phone' },
    });
    next(error);
  }
};

/**
 * Logout revokes the presented refresh token server-side before clearing the
 * cookies. Clearing a cookie only affects the browser that asked — a copy
 * taken from the wire would otherwise keep working for up to 7 days.
 */
export const postLogout: RequestHandler = async (req, res, next) => {
  try {
    const rawToken = req.cookies?.[REFRESH_COOKIE] as string | undefined;
    if (rawToken) await revokeByRawToken(rawToken);

    clearAuthCookies(res);

    if (req.user) {
      await writeAudit({
        action: AUDIT_ACTIONS.LOGOUT,
        userId: req.user.id,
        ...auditContext(req),
      });
    }
    res.status(204).end();
  } catch (error) {
    next(error);
  }
};

/**
 * `POST /auth/refresh` — exchanges a refresh token for a new access token and
 * a rotated refresh token.
 *
 * Needs no access token: it is precisely the endpoint a client calls when its
 * access token has expired.
 */
export const postRefresh: RequestHandler = async (req, res, next) => {
  const rawToken = req.cookies?.[REFRESH_COOKIE] as string | undefined;
  const context = auditContext(req);

  try {
    if (!rawToken) {
      clearAuthCookies(res);
      await writeAudit({
        action: AUDIT_ACTIONS.REFRESH_REJECTED,
        ...context,
        metadata: { reason: 'no refresh cookie' },
      });
      next(
        new HttpError({
          status: 401,
          code: ERROR_CODES.REFRESH_TOKEN_INVALID,
          message: 'Your session has expired. Please sign in again.',
        }),
      );
      return;
    }

    const result = await redeemRefreshToken(rawToken, {
      ip: context.ip,
      userAgent: context.userAgent,
    });

    if (result.outcome === 'reuse') {
      // Every session for this user has already been revoked by the service.
      clearAuthCookies(res);
      await writeAudit({
        action: AUDIT_ACTIONS.REFRESH_REUSE_DETECTED,
        userId: result.userId,
        ...context,
        metadata: { familyId: result.familyId },
      });
      next(
        new HttpError({
          status: 401,
          code: ERROR_CODES.REFRESH_REUSE_DETECTED,
          message: 'Your session was ended for security reasons. Please sign in again.',
        }),
      );
      return;
    }

    if (result.outcome === 'invalid') {
      clearAuthCookies(res);
      await writeAudit({
        action: AUDIT_ACTIONS.REFRESH_REJECTED,
        ...context,
        metadata: { reason: result.reason },
      });
      next(
        new HttpError({
          status: 401,
          code: ERROR_CODES.REFRESH_TOKEN_INVALID,
          message: 'Your session has expired. Please sign in again.',
        }),
      );
      return;
    }

    // Rotated, or a grace-window sibling: both are a valid continuing session.
    setAuthCookies(res, { sub: result.userId, role: result.role }, result.token.rawToken);

    await writeAudit({
      action:
        result.outcome === 'grace'
          ? AUDIT_ACTIONS.REFRESH_GRACE_USED
          : AUDIT_ACTIONS.REFRESH_ROTATED,
      userId: result.userId,
      ...context,
      metadata: { familyId: result.familyId },
    });

    const user = await loadPublicUser(result.userId);
    if (!user) {
      clearAuthCookies(res);
      next(unauthenticated());
      return;
    }

    const response: AuthResponse = { user };
    res.status(200).json(response);
  } catch (error) {
    next(error);
  }
};

export const getMe: RequestHandler = async (req, res, next) => {
  try {
    const user = await loadPublicUser(req.user!.id);

    // Valid token, deleted user: treat as signed out rather than 500.
    if (!user) {
      clearAuthCookies(res);
      next(unauthenticated());
      return;
    }

    const response: AuthResponse = { user };
    res.status(200).json(response);
  } catch (error) {
    next(error);
  }
};
