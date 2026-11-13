import {
  ADMIN_STATS_WINDOW_DAYS,
  type AdminStatsDay,
  type AdminStatsResponse,
  type PaymentPurpose,
} from '@safelock/shared';
import { prisma } from '../../lib/prisma';

/**
 * Figures for the admin Stats tab.
 *
 * Aggregates only — counts, sums and serial numbers. No user is named here,
 * so the tab can be left open on a shared screen.
 *
 * Days are bucketed in **India Standard Time** (UTC+05:30, no DST), because a
 * payment at 01:00 IST is "today" to the business and "yesterday" in UTC.
 */

const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;
const DAY_MS = 86_400_000;

function istDate(at: Date): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Midnight IST at the start of the day `daysAgo` before `now`, as a UTC instant. */
function istMidnight(now: Date, daysAgo: number): Date {
  const shifted = new Date(now.getTime() + IST_OFFSET_MS);
  const midnight = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate() - daysAgo,
  );
  return new Date(midnight - IST_OFFSET_MS);
}

const round1 = (value: number) => Math.round(value * 10) / 10;

export async function adminStats(now: Date = new Date()): Promise<AdminStatsResponse> {
  const windowDays = ADMIN_STATS_WINDOW_DAYS;
  const windowStart = istMidnight(now, windowDays - 1);
  const windowMs = now.getTime() - windowStart.getTime();

  const [
    users,
    devices,
    liveBookings,
    completedBookings,
    paidByPurpose,
    refunded,
    needsRefund,
    windowPayments,
    windowBookings,
    events,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.device.findMany({
      orderBy: { serialNumber: 'asc' },
      select: { id: true, serialNumber: true, status: true },
    }),
    prisma.booking.count({ where: { status: { in: ['ACTIVE', 'OVERSTAY'] } } }),
    prisma.booking.count({ where: { status: 'COMPLETED' } }),
    prisma.payment.groupBy({
      by: ['purpose'],
      where: { status: 'PAID' },
      _sum: { amount: true },
    }),
    prisma.payment.aggregate({ where: { status: 'REFUNDED' }, _sum: { amount: true } }),
    prisma.payment.count({
      where: { status: 'PAID', reviewReason: { not: null }, reviewClearedAt: null },
    }),
    prisma.payment.findMany({
      where: { status: 'PAID', paidAt: { gte: windowStart } },
      select: { purpose: true, amount: true, paidAt: true },
    }),
    // Anything that held a safe at some point in the window.
    prisma.booking.findMany({
      where: {
        status: { notIn: ['CANCELLED', 'EXPIRED_UNPAID'] },
        startsAt: { lt: now },
        OR: [{ completedAt: null }, { completedAt: { gt: windowStart } }],
      },
      select: { deviceId: true, startsAt: true, completedAt: true, reservedUntil: true },
    }),
    prisma.deviceEvent.groupBy({
      by: ['type'],
      where: { createdAt: { gte: windowStart } },
      _count: { _all: true },
    }),
  ]);

  // --- Per day ---------------------------------------------------------------
  const perDay = new Map<string, AdminStatsDay>();
  for (let i = windowDays - 1; i >= 0; i -= 1) {
    const date = istDate(new Date(now.getTime() - i * DAY_MS));
    perDay.set(date, { date, bookings: 0, revenuePaise: 0 });
  }
  for (const payment of windowPayments) {
    if (!payment.paidAt) continue;
    const day = perDay.get(istDate(payment.paidAt));
    if (!day) continue;
    day.revenuePaise += payment.amount;
    // A booking is counted on the day its first payment landed; extensions and
    // overstay fees are revenue but not new bookings.
    if (payment.purpose === 'BOOKING') day.bookings += 1;
  }

  // --- Utilisation -----------------------------------------------------------
  const occupiedMs = new Map<string, number>();
  for (const booking of windowBookings) {
    const end = booking.completedAt ?? (booking.reservedUntil < now ? booking.reservedUntil : now);
    const from = Math.max(booking.startsAt.getTime(), windowStart.getTime());
    const to = Math.min(end.getTime(), now.getTime());
    if (to <= from) continue;
    occupiedMs.set(booking.deviceId, (occupiedMs.get(booking.deviceId) ?? 0) + (to - from));
  }

  // --- Revenue ---------------------------------------------------------------
  const revenueByPurpose: Record<PaymentPurpose, number> = {
    BOOKING: 0,
    EXTENSION: 0,
    OVERSTAY: 0,
  };
  for (const row of paidByPurpose) {
    revenueByPurpose[row.purpose] = row._sum.amount ?? 0;
  }

  const eventCount = (type: string) =>
    events.find((row) => row.type === type)?._count._all ?? 0;

  return {
    generatedAt: now.toISOString(),
    windowDays,
    totals: {
      users,
      devices: devices.filter((device) => device.status !== 'RETIRED').length,
      liveBookings,
      completedBookings,
      revenuePaise: revenueByPurpose.BOOKING + revenueByPurpose.EXTENSION + revenueByPurpose.OVERSTAY,
      refundedPaise: refunded._sum.amount ?? 0,
      needsRefund,
    },
    revenueByPurpose,
    perDay: [...perDay.values()],
    devices: devices.map((device) => {
      const ms = occupiedMs.get(device.id) ?? 0;
      return {
        serialNumber: device.serialNumber,
        status: device.status,
        occupiedHours: round1(ms / 3_600_000),
        utilisationPct: windowMs > 0 ? Math.min(100, round1((ms / windowMs) * 100)) : 0,
      };
    }),
    activity: {
      unlocks: eventCount('UNLOCK_CONFIRMED'),
      failedUnlocks: eventCount('UNLOCK_FAILED'),
      locks: eventCount('LOCK'),
      autoLocks: eventCount('AUTO_LOCK'),
      tamperAlerts: eventCount('VIBRATION_DETECTED') + eventCount('DOOR_FORCED'),
    },
  };
}
