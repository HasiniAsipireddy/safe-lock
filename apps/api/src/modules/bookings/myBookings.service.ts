import {
  MY_BOOKINGS_LIMIT,
  maskPhone,
  toE164,
  type BookingReceiptResponse,
  type MyBookingItem,
  type MyBookingsResponse,
  type MyPaymentLine,
} from '@safelock/shared';
import { prisma } from '../../lib/prisma';
import { BOOKING_SELECT, toBookingSummary, type BookingRow } from './booking.mapper';
import { getBookingForUser } from './booking.service';

/**
 * The renter's own bookings and receipts.
 *
 * Everything is scoped to the session's user. A receipt for someone else's
 * booking is the same 404 as one that does not exist, via `getBookingForUser`.
 *
 * Only `PAID` and `REFUNDED` payments are listed: a checkout that was opened
 * and abandoned (`CREATED`) or declined (`FAILED`) is not a charge, and a
 * receipt that showed one would be wrong about money.
 */

const PAYMENT_LINE_SELECT = {
  id: true,
  bookingId: true,
  purpose: true,
  amount: true,
  currency: true,
  status: true,
  razorpayPaymentId: true,
  paidAt: true,
} as const;

interface PaymentRow {
  id: string;
  bookingId: string | null;
  purpose: MyPaymentLine['purpose'];
  amount: number;
  currency: string;
  status: string;
  razorpayPaymentId: string | null;
  paidAt: Date | null;
}

function toPaymentLine(row: PaymentRow): MyPaymentLine {
  return {
    id: row.id,
    purpose: row.purpose,
    amountPaise: row.amount,
    currency: row.currency,
    status: row.status === 'REFUNDED' ? 'REFUNDED' : 'PAID',
    // Fake-provider ids are a demo artefact, not something to quote to support.
    razorpayPaymentId:
      row.razorpayPaymentId && !row.razorpayPaymentId.includes('FAKE')
        ? row.razorpayPaymentId
        : null,
    paidAt: row.paidAt ? row.paidAt.toISOString() : null,
  };
}

function toItem(row: BookingRow, payments: PaymentRow[], now: Date): MyBookingItem {
  const lines = payments
    .filter((payment) => payment.bookingId === row.id)
    .sort((a, b) => (a.paidAt?.getTime() ?? 0) - (b.paidAt?.getTime() ?? 0))
    .map(toPaymentLine);

  return {
    booking: toBookingSummary(row, now),
    payments: lines,
    totalPaidPaise: lines
      .filter((line) => line.status === 'PAID')
      .reduce((sum, line) => sum + line.amountPaise, 0),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
}

export async function myBookings(userId: string, now = new Date()): Promise<MyBookingsResponse> {
  const rows = (await prisma.booking.findMany({
    where: { userId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: MY_BOOKINGS_LIMIT,
    select: BOOKING_SELECT,
  })) as BookingRow[];

  if (rows.length === 0) return { items: [] };

  const payments = (await prisma.payment.findMany({
    where: {
      userId,
      bookingId: { in: rows.map((row) => row.id) },
      status: { in: ['PAID', 'REFUNDED'] },
    },
    select: PAYMENT_LINE_SELECT,
  })) as PaymentRow[];

  return { items: rows.map((row) => toItem(row, payments, now)) };
}

export async function bookingReceipt(
  bookingId: string,
  userId: string,
  now = new Date(),
): Promise<BookingReceiptResponse> {
  const row = await getBookingForUser(bookingId, userId);

  const [payments, user] = await Promise.all([
    prisma.payment.findMany({
      where: { userId, bookingId: row.id, status: { in: ['PAID', 'REFUNDED'] } },
      select: PAYMENT_LINE_SELECT,
    }) as Promise<PaymentRow[]>,
    prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { name: true, email: true, phone: true },
    }),
  ]);

  return {
    item: toItem(row, payments, now),
    customer: {
      name: user.name,
      email: user.email,
      phoneMasked: maskPhone(toE164(user.phone) ?? user.phone),
    },
    issuedAt: now.toISOString(),
  };
}
