import type { PublicUser } from '@safelock/shared';
import { prisma } from '../../lib/prisma';

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

export function toPublicUser(user: UserRow): PublicUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    createdAt: user.createdAt.toISOString(),
    // Derived, not a column a client could set.
    phoneVerified: user.phoneVerifiedAt !== null,
  };
}

/**
 * Loads a user for `GET /auth/me`.
 *
 * No payment or allocation flags any more: under the rental model what matters
 * is whether the user has a **live booking**, which the dashboard reads from
 * `GET /bookings/current`. Those flags were derived per request anyway, so
 * nothing is lost but two queries.
 */
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

  return toPublicUser(user);
}
