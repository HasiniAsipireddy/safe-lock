import type { Request, RequestHandler } from 'express';
import {
  ERROR_CODES,
  type AuthResponse,
  type ChangePasswordBody,
  type ForgotPasswordInput,
  type ForgotPasswordResponse,
  type PasswordResetResponse,
  type ResetPasswordBody,
  type UpdateProfileInput,
} from '@safelock/shared';
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
import {
  completePasswordReset,
  requestPasswordReset,
  wasExhausted,
} from './passwordReset.service';
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

/**
 * `POST /auth/password/forgot` — asks for a reset link.
 *
 * **The response is identical whether or not the address has an account**: the
 * same status, the same body, no `requestId` difference, nothing conditional.
 * A "no such user" answer here would turn the endpoint into a way to test
 * whether someone owns a safe, which is a worse disclosure than it first looks
 * for a physical-security product.
 *
 * The difference is recorded server-side instead, as two distinct audit
 * actions — neither of which carries the address (the audit service drops any
 * key matching `email`).
 */
export const postForgotPassword: RequestHandler = async (req, res, next) => {
  const { identifier } = req.body as ForgotPasswordInput;
  const context = auditContext(req);

  try {
    const outcome = await requestPasswordReset({
      identifier,
      ip: context.ip,
      userAgent: context.userAgent,
    });

    await writeAudit({
      action: outcome.userId
        ? AUDIT_ACTIONS.PASSWORD_RESET_REQUESTED
        : AUDIT_ACTIONS.PASSWORD_RESET_REQUESTED_UNKNOWN,
      userId: outcome.userId,
      ...context,
    });

    const response: ForgotPasswordResponse = { status: 'ok' };
    res.status(200).json(response);
  } catch (error) {
    next(error);
  }
};

/**
 * `POST /auth/password/reset` — sets a new password from a reset code.
 *
 * **Does not sign the user in.** No access cookie, no refresh cookie, no user
 * in the body. Holding a reset code proves control of a delivery channel, and
 * the product's answer to that is "you may set a password, now sign in with
 * it" rather than "here is a live session to your safe". It also means a code
 * read off a shared screen cannot be turned straight into access.
 *
 * Cookies are *cleared* rather than left alone, because the service has just
 * revoked every refresh token for the account — leaving a dead session in the
 * browser would show a signed-in shell that 401s on its first request.
 */
export const postResetPassword: RequestHandler = async (req, res, next) => {
  const { identifier, code, password } = req.body as ResetPasswordBody;
  const context = auditContext(req);

  try {
    const { userId } = await completePasswordReset({ identifier, code, password });

    clearAuthCookies(res);

    await writeAudit({
      action: AUDIT_ACTIONS.PASSWORD_RESET_COMPLETED,
      userId,
      ...context,
    });

    const response: PasswordResetResponse = { status: 'ok' };
    res.status(200).json(response);
  } catch (error) {
    /**
     * No userId is recorded: every rejection answers identically, and looking
     * one up here only for the audit row would mean the handler behaving
     * differently depending on whether the account exists — which is the thing
     * this endpoint must not do.
     *
     * `exhausted` is the one distinction worth keeping, and it is kept **only
     * here**: five wrong codes against one reset is either someone who cannot
     * read their message or someone guessing. The code itself is never
     * recorded, and the audit scrubber would drop it anyway.
     */
    await writeAudit({
      action: wasExhausted(error)
        ? AUDIT_ACTIONS.PASSWORD_RESET_CODE_EXHAUSTED
        : AUDIT_ACTIONS.PASSWORD_RESET_REJECTED,
      ...context,
      metadata: { code: error instanceof HttpError ? error.code : 'INTERNAL_ERROR' },
    });
    next(error);
  }
};

/**
 * `POST /auth/password/change` — a signed-in user changing their own password.
 *
 * Every other session is revoked and the caller is handed a fresh refresh
 * family, so they stay signed in here and are signed out everywhere else. See
 * `authService.changePassword` for why that is one transaction.
 */
export const postChangePassword: RequestHandler = async (req, res, next) => {
  const userId = req.user!.id;
  const body = req.body as ChangePasswordBody;
  const context = auditContext(req);

  try {
    const { user, refresh } = await authService.changePassword({
      userId,
      currentPassword: body.currentPassword,
      password: body.password,
      context: { ip: context.ip, userAgent: context.userAgent },
    });

    // Both cookies, with the same attributes and paths as a fresh login — the
    // access token has to be re-minted too, not just the refresh token.
    setAuthCookies(res, { sub: user.id, role: user.role }, refresh.rawToken);

    await writeAudit({
      action: AUDIT_ACTIONS.PASSWORD_CHANGED,
      userId,
      ...context,
      metadata: { familyId: refresh.familyId },
    });

    const response: AuthResponse = { user };
    res.status(200).json(response);
  } catch (error) {
    await writeAudit({
      action: AUDIT_ACTIONS.PASSWORD_CHANGE_FAILED,
      userId,
      ...context,
      metadata: { code: error instanceof HttpError ? error.code : 'INTERNAL_ERROR' },
    });
    next(error);
  }
};

/** `PATCH /auth/profile` — name only; the schema rejects anything else. */
export const patchProfile: RequestHandler = async (req, res, next) => {
  const userId = req.user!.id;
  const { name } = req.body as UpdateProfileInput;

  try {
    const user = await authService.updateProfile({ userId, name });

    await writeAudit({
      action: AUDIT_ACTIONS.PROFILE_UPDATED,
      userId,
      ...auditContext(req),
      // The name itself is not recorded: it is user-supplied free text, and
      // the row only needs to say that a change happened and when.
    });

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
