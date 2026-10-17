import { effectiveBookingStatus } from '@safelock/shared';
import type {
  AdminAuditRow,
  AdminBookingRow,
  AdminPaymentRow,
  AdminUserRow,
  ListAuditQuery,
  ListBookingsQuery,
  ListPaymentsQuery,
  ListUsersQuery,
  Paginated,
  UserCurrentBooking,
} from '@safelock/shared';
import { prisma } from '../../lib/prisma';
import {
  BOOKING_SELECT,
  outstandingFeePaise,
  snapshotOf,
  type BookingRow,
} from '../bookings/booking.mapper';

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
  phoneVerifiedAt: true,
  /**
   * The user's live booking.
   *
   * `completedAt: null` rather than a status list, for the reason given in
   * `device.mapper.ts`: an `as const` select cannot carry a mutable array, and
   * every terminal transition stamps `completedAt`. At most one row can match
   * — the partial unique index says so.
   */
  bookings: {
    where: { completedAt: null },
    orderBy: { createdAt: 'desc' },
    take: 1,
    select: { ...BOOKING_SELECT, userId: true },
  },
} as const;

interface AdminUserSource {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: 'USER' | 'ADMIN';
  createdAt: Date;
  phoneVerifiedAt: Date | null;
  bookings: BookingRow[];
}

/**
 * The booking column on the Users tab.
 *
 * Kept rather than dropped when the three purchase flags went: an admin
 * looking at a user still needs to know what that person has out and whether
 * it is in trouble. `overstayFeePaise` is what flags the row.
 */
function toUserCurrentBooking(row: BookingRow, now: Date): UserCurrentBooking {
  return {
    id: row.id,
    status: row.status,
    effectiveStatus: effectiveBookingStatus({
      status: row.status,
      endsAt: row.endsAt,
      holdExpiresAt: row.holdExpiresAt,
      overstaySettledAt: row.overstaySettledAt ?? row.overstayWaivedAt,
      snapshot: snapshotOf(row),
      now,
    }),
    serialNumber: row.device.serialNumber,
    endsAt: row.endsAt ? row.endsAt.toISOString() : null,
    overstayFeePaise: outstandingFeePaise(row, now),
  };
}

function toAdminUserRow(user: AdminUserSource, now: Date): AdminUserRow {
  const live = user.bookings[0];

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    createdAt: user.createdAt.toISOString(),
    phoneVerified: user.phoneVerifiedAt !== null,
    currentBooking: live ? toUserCurrentBooking(live, now) : null,
  };
}

/**
 * Paginated user list.
 *
 * Ordering puts the admin's work queue first, as it did before — only the
 * queue has changed. There is no Allocate button to feed any more, so what
 * sorts to the top is trouble: a user who owes an overstay fee, then anyone
 * holding a safe, then everyone else.
 */
export async function listUsers(query: ListUsersQuery): Promise<Paginated<AdminUserRow>> {
  const now = new Date();
  const liveBooking = { bookings: { some: { completedAt: null } } };

  const where = {
    ...(query.booked === true ? liveBooking : {}),
    ...(query.booked === false ? { NOT: liveBooking } : {}),
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

  const items = rows.map((row) => toAdminUserRow(row as AdminUserSource, now));

  /**
   * Work-queue ordering, applied to the page.
   *
   * Sorting across the whole table would need a computed column; within a page
   * this is enough to put the actionable rows at the top, and
   * `?booked=true` plus the Bookings tab's `flagged` filter exist for the
   * precise queries.
   */
  const rank = (user: AdminUserRow): number => {
    if ((user.currentBooking?.overstayFeePaise ?? 0) > 0) return 0; // owes money
    if (user.currentBooking) return 1; // holds a safe
    return 2;
  };
  items.sort((a, b) => rank(a) - rank(b));

  return paginate(items, total, query);
}

// --- Bookings ----------------------------------------------------------------

/**
 * Paginated booking list, with a `flagged` filter.
 *
 * **`flagged` is the point of this endpoint.** Two situations need a human and
 * must not be reachable only by scrolling:
 *
 * - an **unpaid overstay**, which is deliberately left alone forever by the
 *   sweeper: the fee is capped, the safe stays reserved, and nothing completes
 *   it automatically, because quietly releasing a safe that may still hold
 *   somebody's belongings is the one outcome worth avoiding at any cost;
 * - a booking that ended with the contents unknown, whose device is sitting in
 *   `NEEDS_INSPECTION`.
 *
 * Both are computed from the clock, so the list is right even if the sweeper
 * is behind.
 */
export async function listBookings(
  query: ListBookingsQuery,
): Promise<Paginated<AdminBookingRow>> {
  const now = new Date();

  const where = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.q
      ? {
          OR: [
            { device: { serialNumber: { contains: query.q, mode: 'insensitive' as const } } },
            { user: { email: { contains: query.q, mode: 'insensitive' as const } } },
            { user: { name: { contains: query.q, mode: 'insensitive' as const } } },
          ],
        }
      : {}),
  };

  const [total, rows] = await Promise.all([
    prisma.booking.count({ where }),
    prisma.booking.findMany({
      where,
      select: {
        ...BOOKING_SELECT,
        adminNote: true,
        user: { select: { id: true, name: true, email: true } },
        device: { select: { serialNumber: true, status: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
  ]);

  type Row = BookingRow & {
    adminNote: string | null;
    user: { id: string; name: string; email: string };
    device: { serialNumber: string; status: string };
  };

  let items = (rows as Row[]).map((row): AdminBookingRow => {
    const snapshot = snapshotOf(row);
    const effective = effectiveBookingStatus({
      status: row.status,
      endsAt: row.endsAt,
      holdExpiresAt: row.holdExpiresAt,
      overstaySettledAt: row.overstaySettledAt ?? row.overstayWaivedAt,
      snapshot,
      now,
    });

    const fee = outstandingFeePaise(row, now);

    return {
      id: row.id,
      status: row.status,
      effectiveStatus: effective,
      serialNumber: row.device.serialNumber,
      user: row.user,
      startsAt: row.startsAt.toISOString(),
      endsAt: row.endsAt ? row.endsAt.toISOString() : null,
      hours: row.hours,
      pricePaise: row.pricePaise,
      currency: row.currency,
      overstayFeePaise: fee,
      overstaySettledAt: row.overstaySettledAt ? row.overstaySettledAt.toISOString() : null,
      completionReason: row.completionReason,
      // Needs a human: money owed, or a safe nobody has looked inside.
      flagged: fee > 0 || row.device.status === 'NEEDS_INSPECTION',
      createdAt: row.createdAt.toISOString(),
    };
  });

  /**
   * `flagged` is filtered after mapping, not in SQL.
   *
   * The fee depends on `now` against a per-row snapshot, which is not
   * expressible as a Prisma `where` without duplicating the pricing rules in
   * SQL — two copies of money arithmetic being exactly what `@safelock/shared`
   * exists to prevent. The cost is that `total` counts the unfiltered set; the
   * UI says "flagged on this page" rather than claiming a total it does not
   * have.
   */
  if (query.flagged !== undefined) {
    items = items.filter((row) => row.flagged === query.flagged);
  }

  return paginate(items, total, query);
}

/** One booking, for the admin detail view. Throws nothing — null if absent. */
export async function getBookingRow(bookingId: string): Promise<BookingRow | null> {
  const row = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: BOOKING_SELECT,
  });

  return (row as BookingRow | null) ?? null;
}


/**
 * Paginated payment list.
 *
 * `needsReview=true` is the admin's refund queue: money we captured and could
 * not apply. Those rows stay `PAID` — rewriting a payment to pretend it did
 * not happen would put a lie in the one table that must not contain one — so
 * the flag is the only thing distinguishing them, and it is filterable in SQL
 * rather than computed, unlike the bookings `flagged` filter.
 */
export async function listPayments(
  query: ListPaymentsQuery,
): Promise<Paginated<AdminPaymentRow>> {
  const where = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.purpose ? { purpose: query.purpose } : {}),
    ...(query.needsReview === true
      ? { reviewReason: { not: null }, reviewClearedAt: null }
      : {}),
    ...(query.needsReview === false
      ? { OR: [{ reviewReason: null }, { reviewClearedAt: { not: null } }] }
      : {}),
  };

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
        purpose: true,
        bookingId: true,
        reviewReason: true,
        reviewClearedAt: true,
        user: { select: { id: true, name: true, email: true } },
      },
      /**
       * Newest first, and deliberately **not** "flagged first".
       *
       * A flagged row is `reviewReason != null AND reviewClearedAt == null`,
       * which is a conjunction Prisma cannot express as an ordering — and the
       * near-miss (`reviewClearedAt` nulls first) would sort every ordinary
       * payment to the top too, since theirs is null as well. The
       * `?needsReview=true` filter is the work queue; this is the ledger.
       */
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
    purpose: payment.purpose,
    bookingId: payment.bookingId,
    reviewReason: payment.reviewReason,
    reviewClearedAt: payment.reviewClearedAt
      ? payment.reviewClearedAt.toISOString()
      : null,
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
