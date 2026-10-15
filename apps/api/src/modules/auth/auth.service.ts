import type { PublicUser } from '@safelock/shared';
import {
  ERROR_CODES,
  GENERIC_LOGIN_ERROR,
  classifyIdentifier,
} from '@safelock/shared';
import { prisma } from '../../lib/prisma';
import { HttpError, conflict } from '../../lib/httpError';
import { hashPassword, verifyPassword } from './password';
import { toPublicUser, userHasDevice, userHasPaid } from '../users/user.mapper';

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
