import type { PublicUser } from '@safelock/shared';
import {
  ERROR_CODES,
  GENERIC_LOGIN_ERROR,
  classifyIdentifier,
} from '@safelock/shared';
import { prisma } from '../../lib/prisma';
import { HttpError, conflict, unauthenticated } from '../../lib/httpError';
import { hashPassword, verifyPassword } from './password';
import { toPublicUser, userHasDevice, userHasPaid } from '../users/user.mapper';
import { issueRefreshToken, type IssueContext, type IssuedToken } from './refreshToken.service';

const SELECT = {
  id: true,
  name: true,
  email: true,
  phone: true,
  role: true,
  createdAt: true,
} as const;

export async function signup(input: {
  name: string;
  email: string;
  phone: string;
  password: string;
}): Promise<PublicUser> {
  const existing = await prisma.user.findFirst({
    where: { OR: [{ email: input.email }, { phone: input.phone }] },
    select: { email: true, phone: true },
  });

  if (existing?.email === input.email) {
    throw conflict(
      ERROR_CODES.EMAIL_ALREADY_REGISTERED,
      'An account with this email already exists. Try logging in instead.',
    );
  }
  if (existing?.phone === input.phone) {
    throw conflict(
      ERROR_CODES.PHONE_ALREADY_REGISTERED,
      'An account with this phone number already exists. Try logging in instead.',
    );
  }

  const user = await prisma.user.create({
    data: {
      name: input.name,
      email: input.email,
      phone: input.phone,
      passwordHash: await hashPassword(input.password),
    },
    select: SELECT,
  });

  // A brand-new account cannot have a payment or a device yet.
  return toPublicUser(user, { hasPaid: false, deviceAllocated: false });
}

/**
 * Authenticates an email-or-phone identifier.
 *
 * Both "no such account" and "wrong password" return the same
 * `INVALID_CREDENTIALS` / {@link GENERIC_LOGIN_ERROR} response so the endpoint
 * cannot be used to discover which emails or numbers are registered.
 */
export async function login(input: {
  identifier: string;
  password: string;
}): Promise<PublicUser> {
  const byPhone = classifyIdentifier(input.identifier) === 'phone';
  const needle = input.identifier.trim();

  const user = await prisma.user.findUnique({
    where: byPhone ? { phone: needle } : { email: needle.toLowerCase() },
    select: { ...SELECT, passwordHash: true },
  });

  const invalid = new HttpError({
    status: 401,
    code: ERROR_CODES.INVALID_CREDENTIALS,
    message: GENERIC_LOGIN_ERROR,
  });

  if (!user) {
    // Spend comparable time on an unknown identifier so response timing does
    // not reveal whether the account exists.
    await verifyPassword(
      '$argon2id$v=19$m=19456,t=2,p=1$c2FmZWxvY2tkdW1teXNhbHQ$Zm9yY2VkZmFpbHVyZXBsYWNlaG9sZGVy',
      input.password,
    );
    throw invalid;
  }

  if (!(await verifyPassword(user.passwordHash, input.password))) {
    throw invalid;
  }

  const { passwordHash: _ignored, ...row } = user;
  const [hasPaid, deviceAllocated] = await Promise.all([
    userHasPaid(row.id),
    userHasDevice(row.id),
  ]);
  return toPublicUser(row, { hasPaid, deviceAllocated });
}

/**
 * Changes a signed-in user's password, then ends every session and starts one.
 *
 * ## Revoke-all-then-reissue
 * Changing a password is how someone evicts a session they no longer trust, so
 * **every** refresh token for the user is revoked — and then a brand-new
 * family is issued to the caller, who stays signed in. Anything else is wrong
 * in one direction or the other: revoking nothing makes the change cosmetic,
 * and revoking everything without reissuing logs people out of the tab they
 * just used, which trains them not to change passwords.
 *
 * All three steps are one transaction. Revoking and reissuing separately would
 * leave a window where the caller holds no valid refresh token, and a parallel
 * request in that window would be indistinguishable from a replay.
 *
 * ## The 15-minute caveat
 * Access tokens are stateless 15-minute JWTs, so another session's *access*
 * token keeps working until it expires — it just cannot be renewed. That
 * window is documented in docs/decisions.md and is deliberately not closed.
 */
export async function changePassword(input: {
  userId: string;
  currentPassword: string;
  password: string;
  context?: IssueContext;
}): Promise<{ user: PublicUser; refresh: IssuedToken }> {
  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { ...SELECT, passwordHash: true },
  });

  // A valid access token for a user who no longer exists: treat as signed out.
  if (!user) throw unauthenticated();

  if (!(await verifyPassword(user.passwordHash, input.currentPassword))) {
    throw new HttpError({
      status: 400,
      code: ERROR_CODES.PASSWORD_INCORRECT,
      message: 'That is not your current password.',
    });
  }

  // Hashed before the transaction: argon2 costs real time by design, and
  // holding a transaction open across it pins a connection for no reason.
  const passwordHash = await hashPassword(input.password);

  const refresh = await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: { passwordHash },
      select: { id: true },
    });

    await tx.refreshToken.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    // A new family, not a rotation: the old chain is gone, and this login is
    // a new one as far as reuse detection is concerned.
    return issueRefreshToken(user.id, input.context ?? {}, tx);
  });

  const { passwordHash: _ignored, ...row } = user;
  const [hasPaid, deviceAllocated] = await Promise.all([
    userHasPaid(row.id),
    userHasDevice(row.id),
  ]);

  return { user: toPublicUser(row, { hasPaid, deviceAllocated }), refresh };
}

/**
 * Updates the profile. **Name only** — see `updateProfileSchema`, which
 * rejects anything else rather than ignoring it.
 */
export async function updateProfile(input: {
  userId: string;
  name: string;
}): Promise<PublicUser> {
  const user = await prisma.user.update({
    where: { id: input.userId },
    data: { name: input.name },
    select: SELECT,
  });

  const [hasPaid, deviceAllocated] = await Promise.all([
    userHasPaid(user.id),
    userHasDevice(user.id),
  ]);

  return toPublicUser(user, { hasPaid, deviceAllocated });
}
