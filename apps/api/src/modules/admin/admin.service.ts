import type {
  AdminAuditRow,
  AdminPaymentRow,
  AdminUserRow,
  ListAuditQuery,
  ListPaymentsQuery,
  ListUsersQuery,
  Paginated,
} from '@safelock/shared';
import { prisma } from '../../lib/prisma';

/**
 * Read-only listings for the admin panel.
 *
 * Every query uses an **explicit `select`**. Admin tooling is exactly where a
 * convenient `include: { user: true }` would quietly start shipping password
 * hashes to a browser, so whole rows are never returned.
 *
 * Free-text search always goes through Prisma's parameterised `contains`
 * filters. No query in this file builds SQL from a string.
 */

function paginate<T>(items: T[], total: number, query: { page: number; pageSize: number }): Paginated<T> {
  return {
    items,
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
  };
}

/**
 * The complete set of user columns admin tooling may see.
 *
 * Note the absences: no `passwordHash`, and no `refreshTokens` relation. Both
 * are asserted by a recursive no-hash test over the HTTP responses.
 */
const ADMIN_USER_SELECT = {
  id: true,
  name: true,
  email: true,
  phone: true,
  role: true,
  createdAt: true,
  payments: {
    where: { status: 'PAID' as const },
    select: { id: true },
    take: 1,
  },
  device: {
    select: { serialNumber: true },
  },
} as const;

interface AdminUserSource {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: 'USER' | 'ADMIN';
  createdAt: Date;
  payments: Array<{ id: string }>;
  device: { serialNumber: string } | null;
}

function toAdminUserRow(user: AdminUserSource): AdminUserRow {
  const hasPaid = user.payments.length > 0;
  const deviceSerial = user.device?.serialNumber ?? null;

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    createdAt: user.createdAt.toISOString(),
    hasPaid,
    deviceSerial,
    // The state a refund leaves behind: money returned, hardware still out.
    refundedWithDevice: !hasPaid && deviceSerial !== null,
  };
}

/**
 * Paginated user list.
 *
 * Ordering puts the admin's actual work queue first: users who have paid but
 * hold no device are what the Allocate button exists for, so they sort ahead
 * of everyone else rather than being hunted for across pages.
 *
 * `paid` is derived from the Payment table rather than a column, so the filter
 * is expressed as a relation condition.
 */
export async function listUsers(query: ListUsersQuery): Promise<Paginated<AdminUserRow>> {
  const paidCondition = { payments: { some: { status: 'PAID' as const } } };

  const where = {
    ...(query.paid === true ? paidCondition : {}),
    ...(query.paid === false ? { NOT: paidCondition } : {}),
    ...(query.allocated === true ? { device: { isNot: null } } : {}),
    ...(query.allocated === false ? { device: { is: null } } : {}),
    ...(query.q
      ? {
          OR: [
            { name: { contains: query.q, mode: 'insensitive' as const } },
            { email: { contains: query.q, mode: 'insensitive' as const } },
            { phone: { contains: query.q } },
          ],
        }
      : {}),
  };

  const [total, rows] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      select: ADMIN_USER_SELECT,
      orderBy: [{ createdAt: 'desc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
  ]);

  const items = rows.map(toAdminUserRow);

  /**
   * Work-queue ordering, applied to the page.
   *
   * Sorting across the whole table would need a computed column; within a
   * page this is enough to put the actionable rows at the top, and the
   * `allocated=false&paid=true` filter exists for the precise query.
   */
  const rank = (user: AdminUserRow): number => {
    if (user.refundedWithDevice) return 0; // needs reclaiming
    if (user.hasPaid && !user.deviceSerial) return 1; // needs allocating
    return 2;
  };
  items.sort((a, b) => rank(a) - rank(b));

  return paginate(items, total, query);
}

export async function listPayments(
  query: ListPaymentsQuery,
): Promise<Paginated<AdminPaymentRow>> {
  const where = query.status ? { status: query.status } : {};

  const [total, rows] = await Promise.all([
    prisma.payment.count({ where }),
    prisma.payment.findMany({
      where,
      select: {
        id: true,
        amount: true,
        currency: true,
        status: true,
        razorpayOrderId: true,
        createdAt: true,
        paidAt: true,
        user: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
  ]);

  const items: AdminPaymentRow[] = rows.map((payment) => ({
    id: payment.id,
    amount: payment.amount,
    currency: payment.currency,
    status: payment.status,
    razorpayOrderId: payment.razorpayOrderId,
    createdAt: payment.createdAt.toISOString(),
    paidAt: payment.paidAt ? payment.paidAt.toISOString() : null,
    user: payment.user,
  }));

  return paginate(items, total, query);
}

export async function listAudit(query: ListAuditQuery): Promise<Paginated<AdminAuditRow>> {
  const where = query.action
    ? { action: { contains: query.action, mode: 'insensitive' as const } }
    : {};

  const [total, rows] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({
      where,
      select: {
        id: true,
        action: true,
        userId: true,
        deviceId: true,
        ip: true,
        userAgent: true,
        metadata: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
  ]);

  const items: AdminAuditRow[] = rows.map((entry) => ({
    id: entry.id,
    action: entry.action,
    userId: entry.userId,
    deviceId: entry.deviceId,
    ip: entry.ip,
    userAgent: entry.userAgent,
    metadata: entry.metadata,
    createdAt: entry.createdAt.toISOString(),
  }));

  return paginate(items, total, query);
}
