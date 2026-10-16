import type { PublicUser } from '@safelock/shared';
import { prisma } from '../../lib/prisma';
import type { PrismaTransaction } from '../../lib/prisma';

/** The database columns a PublicUser is built from. Never the password hash. */
export interface UserRow {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: 'USER' | 'ADMIN';
  createdAt: Date;
  /** Null until the user confirms a code sent to their number. */
  phoneVerifiedAt: Date | null;
}

/**
 * Whether the user has a server-verified payment.
 *
 * Derived from the Payment table on every call rather than cached on User, so
 * a refund (which flips the row to REFUNDED) takes effect immediately and
 * there is no second copy of the truth to drift.
 */
export async function userHasPaid(
  userId: string,
  client: PrismaTransaction | typeof prisma = prisma,
): Promise<boolean> {
  const paid = await client.payment.findFirst({
    where: { userId, status: 'PAID' },
    select: { id: true },
  });
  return paid !== null;
}

/**
 * Whether a device is currently assigned to this user.
 *
 * Derived, like {@link userHasPaid} — `Device.ownerId` is the single source of
 * truth, so unassigning takes effect on the next request with no second flag
 * to keep in step.
 */
export async function userHasDevice(
  userId: string,
  client: PrismaTransaction | typeof prisma = prisma,
): Promise<boolean> {
  const device = await client.device.findUnique({
    where: { ownerId: userId },
    select: { id: true },
  });
  return device !== null;
}

export function toPublicUser(
  user: UserRow,
  flags: { hasPaid: boolean; deviceAllocated: boolean },
): PublicUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    createdAt: user.createdAt.toISOString(),
    hasPaid: flags.hasPaid,
    deviceAllocated: flags.deviceAllocated,
    // Derived, like the other two flags — not a column a client could set.
    phoneVerified: user.phoneVerifiedAt !== null,
  };
}

/** Loads a user with their payment and allocation state, for `GET /auth/me`. */
export async function loadPublicUser(userId: string): Promise<PublicUser | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      role: true,
      createdAt: true,
      phoneVerifiedAt: true,
    },
  });

  if (!user) return null;

  const [hasPaid, deviceAllocated] = await Promise.all([
    userHasPaid(userId),
    userHasDevice(userId),
  ]);

  return toPublicUser(user, { hasPaid, deviceAllocated });
}
