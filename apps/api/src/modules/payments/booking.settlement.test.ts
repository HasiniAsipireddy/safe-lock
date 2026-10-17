import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { overstayHourlyPaise } from '@safelock/shared';
import { prisma } from '../../lib/prisma';
import { resetRazorpayClient } from '../../lib/razorpay';
import {
  TEST_ORIGIN,
  app,
  checkoutSignature,
  createTestUser,
  createUserWithDevice,
  paymentCapturedBody,
  pushIntoOverstay,
  seedBooking,
  seedDevice,
  seedPayment,
  webhookSignature,
} from '../../test/helpers';
import { resetRazorpayMock } from '../../test/razorpayMock';
import { currentRates } from '../bookings/booking.service';

vi.mock('razorpay', () => import('../../test/razorpayMock'));

/** Delivers a signed `payment.captured` for an order. */
async function capture(orderId: string, amount: number, eventId: string) {
  const body = paymentCapturedBody({
    orderId,
    paymentId: `pay_${eventId}`,
    amount,
  });

  return request(app())
    .post('/api/v1/payments/webhook')
    .set('Content-Type', 'application/json')
    .set('X-Razorpay-Signature', webhookSignature(body))
    .set('X-Razorpay-Event-Id', eventId)
    .send(body);
}

// --- Late payment on a lapsed hold -------------------------------------------

/**
 * Assumption (b), both branches.
 *
 * The Razorpay order expiry is set to the hold, so this is rare rather than
 * routine — but "rare" is not "impossible", and money that arrives has to go
 * somewhere honest.
 */
describe('a payment that arrives after the hold lapsed', () => {
  it('re-activates the booking when the safe is still free', async () => {
    resetRazorpayMock();
    resetRazorpayClient();

    const user = await createTestUser();
    const device = await seedDevice();

    const booking = await seedBooking({
      userId: user.id,
      deviceId: device.id,
      status: 'EXPIRED_UNPAID',
      hours: 2,
      startsAt: new Date(Date.now() - 20 * 60 * 1000),
    });

    const priced = await prisma.booking.findUniqueOrThrow({
      where: { id: booking.id },
      select: { pricePaise: true },
    });

    const payment = await seedPayment({
      userId: user.id,
      bookingId: booking.id,
      purpose: 'BOOKING',
      amount: priced.pricePaise,
    });

    const response = await capture(payment.orderId, priced.pricePaise, 'evt_late_free');
    expect(response.status).toBe(200);

    const after = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(after.status).toBe('ACTIVE');
    // And the user gets their full two hours from now, not from the stale
    // creation time.
    expect(after.endsAt!.getTime()).toBeGreaterThan(Date.now() + 110 * 60 * 1000);

    const row = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(row.status).toBe('PAID');
    expect(row.reviewReason).toBeNull();
  });

  /**
   * The other branch: the safe went to someone else.
   *
   * Nothing is forced. Taking the safe back from a paying renter to give it to
   * an earlier one would just move the problem, so the money is flagged for a
   * manual refund and the caller is told plainly.
   */
  it('flags the payment for refund when the safe has been taken', async () => {
    resetRazorpayMock();
    resetRazorpayClient();

    const user = await createTestUser();
    const nextRenter = await createTestUser();
    const device = await seedDevice();

    const booking = await seedBooking({
      userId: user.id,
      deviceId: device.id,
      status: 'EXPIRED_UNPAID',
      hours: 2,
      startsAt: new Date(Date.now() - 20 * 60 * 1000),
    });

    // The safe was released and immediately rebooked.
    await seedBooking({
      userId: nextRenter.id,
      deviceId: device.id,
      status: 'ACTIVE',
      hours: 2,
    });

    const priced = await prisma.booking.findUniqueOrThrow({
      where: { id: booking.id },
      select: { pricePaise: true },
    });

    const payment = await seedPayment({
      userId: user.id,
      bookingId: booking.id,
      purpose: 'BOOKING',
      amount: priced.pricePaise,
    });

    const response = await capture(payment.orderId, priced.pricePaise, 'evt_late_taken');
    expect(response.status).toBe(200);

    const after = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(after.status).toBe('EXPIRED_UNPAID');

    const row = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    /**
     * The row stays PAID. We never rewrite a payment to pretend it did not
     * happen — that would put a lie in the one table that must not contain
     * one. It is flagged instead.
     */
    expect(row.status).toBe('PAID');
    expect(row.reviewReason).toBe('BOOKING_EXPIRED_DEVICE_TAKEN');
    expect(row.reviewClearedAt).toBeNull();

    // And the second renter keeps their booking.
    const other = await prisma.booking.findFirstOrThrow({
      where: { userId: nextRenter.id },
    });
    expect(other.status).toBe('ACTIVE');

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'payment.needs_review' },
    });
    expect(audit?.metadata).toMatchObject({
      paymentRowId: payment.id,
      reason: 'BOOKING_EXPIRED_DEVICE_TAKEN',
    });

    // It lands on the admin refund queue.
    const admin = await createTestUser({ role: 'ADMIN' });
    const queue = await request(app())
      .get('/api/v1/admin/payments?needsReview=true')
      .set('Cookie', admin.cookie);
    expect(queue.body.items.map((item: { id: string }) => item.id)).toContain(payment.id);
  });

  /** A safe flagged for inspection is not "still free" either. */
  it('flags the payment when the safe was sent for inspection meanwhile', async () => {
    resetRazorpayMock();
    resetRazorpayClient();

    const user = await createTestUser();
    const device = await seedDevice();
    await prisma.device.update({
      where: { id: device.id },
      data: { status: 'NEEDS_INSPECTION', inspectionNotedAt: new Date() },
    });

    const booking = await seedBooking({
      userId: user.id,
      deviceId: device.id,
      status: 'EXPIRED_UNPAID',
      hours: 1,
      startsAt: new Date(Date.now() - 20 * 60 * 1000),
    });

    const payment = await seedPayment({
      userId: user.id,
      bookingId: booking.id,
      purpose: 'BOOKING',
      amount: currentRates().hourlyRatePaise,
    });

    await capture(payment.orderId, currentRates().hourlyRatePaise, 'evt_late_inspect');

    const row = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(row.reviewReason).toBe('BOOKING_EXPIRED_DEVICE_TAKEN');
  });

  it('flags a payment for a booking that was cancelled before the money arrived', async () => {
    resetRazorpayMock();
    resetRazorpayClient();

    const user = await createTestUser();
    const device = await seedDevice();

    const booking = await seedBooking({
      userId: user.id,
      deviceId: device.id,
      status: 'CANCELLED',
      hours: 1,
      startsAt: new Date(Date.now() - 10 * 60 * 1000),
    });

    const payment = await seedPayment({
      userId: user.id,
      bookingId: booking.id,
      purpose: 'BOOKING',
      amount: currentRates().hourlyRatePaise,
    });

    await capture(payment.orderId, currentRates().hourlyRatePaise, 'evt_cancelled');

    const row = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(row.status).toBe('PAID');
    expect(row.reviewReason).toBe('BOOKING_NO_LONGER_PAYABLE');
  });

  /** And the browser callback path gives the same answer, not a false success. */
  it('tells the verify caller the money needs review rather than reporting success', async () => {
    resetRazorpayMock();
    resetRazorpayClient();

    const user = await createTestUser();
    const nextRenter = await createTestUser();
    const device = await seedDevice();

    const booking = await seedBooking({
      userId: user.id,
      deviceId: device.id,
      status: 'EXPIRED_UNPAID',
      hours: 1,
      startsAt: new Date(Date.now() - 20 * 60 * 1000),
    });
    await seedBooking({
      userId: nextRenter.id,
      deviceId: device.id,
      status: 'ACTIVE',
      hours: 2,
    });

    const amount = currentRates().hourlyRatePaise;
    const payment = await seedPayment({
      userId: user.id,
      bookingId: booking.id,
      purpose: 'BOOKING',
      amount,
    });

    const razorpayPaymentId = 'pay_verifylate';

    const response = await request(app())
      .post('/api/v1/payments/verify')
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', user.cookie)
      .send({
        razorpay_order_id: payment.orderId,
        razorpay_payment_id: razorpayPaymentId,
        razorpay_signature: checkoutSignature(payment.orderId, razorpayPaymentId),
      });

    expect(response.status).toBe(200);
    // The one flag the UI must not render as plain success.
    expect(response.body.needsReview).toBe(true);
    expect(response.body.payment.status).toBe('PAID');
  });
});

// --- Overstay quotes ---------------------------------------------------------

/**
 * Open question (6), as decided: the quote is binding for a bounded window,
 * and a capture past it whose amount no longer covers the fee is **rejected at
 * the webhook and flagged for an admin refund** rather than silently settling
 * a larger fee for less money.
 */
describe('an overstay payment against an expired quote', () => {
  it('settles normally while the quote is still live', async () => {
    resetRazorpayMock();
    resetRazorpayClient();

    const { user, bookingId } = await createUserWithDevice();
    await pushIntoOverstay(bookingId, 2);

    const fee = 2 * overstayHourlyPaise(currentRates());
    const payment = await seedPayment({
      userId: user.id,
      bookingId,
      purpose: 'OVERSTAY',
      amount: fee,
      quoteExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });

    await capture(payment.orderId, fee, 'evt_quote_live');

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(booking.overstaySettledAt).toBeInstanceOf(Date);
    expect(booking.overstayPaidPaise).toBe(fee);

    const row = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(row.reviewReason).toBeNull();
  });

  /**
   * Growth **within** the quote window is absorbed.
   *
   * The alternative — settling partially and leaving a residue — creates a
   * loop in which the user can never finish paying, which is worse than giving
   * away at most one started hour.
   */
  it('absorbs a fee that grew while the user was at the checkout', async () => {
    resetRazorpayMock();
    resetRazorpayClient();

    const { user, bookingId } = await createUserWithDevice();

    // Quoted at one hour, but by capture time three have accrued.
    const quotedFee = overstayHourlyPaise(currentRates());
    const payment = await seedPayment({
      userId: user.id,
      bookingId,
      purpose: 'OVERSTAY',
      amount: quotedFee,
      quoteExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });

    await pushIntoOverstay(bookingId, 3);

    await capture(payment.orderId, quotedFee, 'evt_quote_grew');

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(booking.overstaySettledAt).toBeInstanceOf(Date);
    expect(booking.overstayPaidPaise).toBe(quotedFee);

    const row = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(row.reviewReason).toBeNull();

    // The audit row records what was absorbed, so the giveaway is visible.
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'booking.overstay.settled' },
    });
    expect((audit?.metadata as { absorbedPaise?: number })?.absorbedPaise).toBeGreaterThan(0);
  });

  /**
   * The case the user asked about: an expired quote whose fee has since grown.
   *
   * Settling it would open the collection window on a part payment, so it is
   * refused and flagged. The fee stays outstanding, so the user is still
   * refused an unlock and can request a fresh quote.
   */
  it('refuses to settle, flags for refund, and leaves the fee outstanding', async () => {
    resetRazorpayMock();
    resetRazorpayClient();

    const { user, bookingId, deviceId } = await createUserWithDevice();

    const quotedFee = overstayHourlyPaise(currentRates());
    const payment = await seedPayment({
      userId: user.id,
      bookingId,
      purpose: 'OVERSTAY',
      amount: quotedFee,
      // The quote expired twenty minutes ago.
      quoteExpiresAt: new Date(Date.now() - 20 * 60 * 1000),
    });

    // And four chargeable hours have now accrued, well past what was paid.
    await pushIntoOverstay(bookingId, 4);

    const response = await capture(payment.orderId, quotedFee, 'evt_quote_expired');
    expect(response.status).toBe(200);

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    // Not settled: a part payment must not open the collection window.
    expect(booking.overstaySettledAt).toBeNull();
    expect(booking.overstayPaidPaise).toBe(0);

    const row = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(row.status).toBe('PAID');
    expect(row.reviewReason).toBe('OVERSTAY_QUOTE_EXPIRED');

    // The fee is still owed, so unlock is still refused.
    const unlock = await request(app())
      .post('/api/v1/devices/unlock/request')
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', user.cookie)
      .send({});
    expect(unlock.status).toBe(402);
    expect(unlock.body.error.code).toBe('OVERSTAY_PAYMENT_REQUIRED');

    // And collect is still refused, so the safe stays reserved.
    const collect = await request(app())
      .post(`/api/v1/bookings/${bookingId}/collect`)
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', user.cookie)
      .send({});
    expect(collect.status).toBe(402);

    const device = await prisma.device.findUniqueOrThrow({ where: { id: deviceId } });
    expect(device.status).toBe('AVAILABLE');

    // The user can ask for a fresh quote, at the current fee.
    const requote = await request(app())
      .post(`/api/v1/bookings/${bookingId}/overstay/order`)
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', user.cookie)
      .send({});
    expect(requote.status).toBe(200);
    expect(requote.body.amount).toBe(4 * overstayHourlyPaise(currentRates()));
  });

  /**
   * An expired quote whose amount **still covers** the fee is honoured.
   *
   * Refusing money that is sufficient would be pedantry at the user's expense:
   * the TTL exists to stop us accepting too little, not to punish lateness.
   */
  it('settles an expired quote whose amount still covers the fee', async () => {
    resetRazorpayMock();
    resetRazorpayClient();

    const { user, bookingId } = await createUserWithDevice();
    await pushIntoOverstay(bookingId, 1);

    const fee = overstayHourlyPaise(currentRates());
    const payment = await seedPayment({
      userId: user.id,
      bookingId,
      purpose: 'OVERSTAY',
      amount: fee,
      quoteExpiresAt: new Date(Date.now() - 20 * 60 * 1000),
    });

    await capture(payment.orderId, fee, 'evt_quote_expired_ok');

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(booking.overstaySettledAt).toBeInstanceOf(Date);

    const row = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(row.reviewReason).toBeNull();
  });

  it('is idempotent when an overstay has already been settled', async () => {
    resetRazorpayMock();
    resetRazorpayClient();

    const { user, bookingId } = await createUserWithDevice();
    await pushIntoOverstay(bookingId, 1);

    const fee = overstayHourlyPaise(currentRates());
    await prisma.booking.update({
      where: { id: bookingId },
      data: { status: 'OVERSTAY', overstaySettledAt: new Date(), overstayPaidPaise: fee },
    });

    const payment = await seedPayment({
      userId: user.id,
      bookingId,
      purpose: 'OVERSTAY',
      amount: fee,
      quoteExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });

    await capture(payment.orderId, fee, 'evt_already_settled');

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    // Not double-counted.
    expect(booking.overstayPaidPaise).toBe(fee);
  });

  /** A waive got there first; the money is not applied twice. */
  it('does not re-settle an overstay an admin already waived', async () => {
    resetRazorpayMock();
    resetRazorpayClient();

    const { user, bookingId } = await createUserWithDevice();
    await pushIntoOverstay(bookingId, 1);
    await prisma.booking.update({
      where: { id: bookingId },
      data: { status: 'OVERSTAY', overstayWaivedAt: new Date() },
    });

    const fee = overstayHourlyPaise(currentRates());
    const payment = await seedPayment({
      userId: user.id,
      bookingId,
      purpose: 'OVERSTAY',
      amount: fee,
      quoteExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });

    await capture(payment.orderId, fee, 'evt_waived_then_paid');

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(booking.overstayPaidPaise).toBe(0);
    expect(booking.overstaySettledAt).toBeNull();
  });
});

// --- Extensions --------------------------------------------------------------

describe('an extension payment', () => {
  it('adds the purchased hours and extends the reservation', async () => {
    resetRazorpayMock();
    resetRazorpayClient();

    const { user, bookingId } = await createUserWithDevice({ hours: 2 });

    const before = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });

    const amount = currentRates().hourlyRatePaise * 2;
    const payment = await seedPayment({
      userId: user.id,
      bookingId,
      purpose: 'EXTENSION',
      amount,
    });

    await capture(payment.orderId, amount, 'evt_extension');

    const after = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(after.hours).toBe(4);
    expect(after.pricePaise).toBe(before.pricePaise + amount);
    expect(after.endsAt!.getTime()).toBe(before.endsAt!.getTime() + 2 * 60 * 60 * 1000);
    expect(after.reservedUntil.getTime()).toBeGreaterThan(before.reservedUntil.getTime());

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'booking.extended' },
    });
    expect(audit?.metadata).toMatchObject({ bookingId, hours: 2 });
  });

  /**
   * An extension bought once a fee is owed is **not** applied: the hour being
   * extended has already been charged at the overstay rate, so that money is
   * refundable rather than applicable.
   */
  it('is flagged rather than applied when an overstay fee is owed', async () => {
    resetRazorpayMock();
    resetRazorpayClient();

    const { user, bookingId } = await createUserWithDevice();
    await pushIntoOverstay(bookingId, 1);

    const before = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });

    const amount = currentRates().hourlyRatePaise;
    const payment = await seedPayment({
      userId: user.id,
      bookingId,
      purpose: 'EXTENSION',
      amount,
    });

    await capture(payment.orderId, amount, 'evt_extension_overstay');

    const after = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(after.hours).toBe(before.hours);
    expect(after.endsAt!.getTime()).toBe(before.endsAt!.getTime());

    const row = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(row.reviewReason).toBe('BOOKING_NO_LONGER_PAYABLE');
  });

  it('is flagged when the booking ended before the money arrived', async () => {
    resetRazorpayMock();
    resetRazorpayClient();

    const { user, bookingId } = await createUserWithDevice();
    await prisma.booking.update({
      where: { id: bookingId },
      data: { status: 'COMPLETED', completedAt: new Date(), completionReason: 'COLLECTED' },
    });

    const amount = currentRates().hourlyRatePaise;
    const payment = await seedPayment({
      userId: user.id,
      bookingId,
      purpose: 'EXTENSION',
      amount,
    });

    await capture(payment.orderId, amount, 'evt_extension_done');

    const row = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(row.reviewReason).toBe('BOOKING_NO_LONGER_PAYABLE');
  });
});
