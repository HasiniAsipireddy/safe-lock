import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { prisma } from '../../lib/prisma';
import { resetRazorpayClient } from '../../lib/razorpay';
import {
  app,
  BAD_SIGNATURE,
  checkoutSignature,
  createTestUser,
  paymentCapturedBody,
  paymentFailedBody,
  refundProcessedBody,
  seedBooking,
  seedDevice,
  TEST_ORIGIN,
  webhookSignature,
  type TestUser,
} from '../../test/helpers';
import { resetRazorpayMock } from '../../test/razorpayMock';

vi.mock('razorpay', () => import('../../test/razorpayMock'));

const WEBHOOK_URL = '/api/v1/payments/webhook';

/** Posts a raw body the way Razorpay does, with a chosen signature. */
function postWebhook(body: string, options: { signature: string; eventId?: string }) {
  const req = request(app())
    .post(WEBHOOK_URL)
    .set('Content-Type', 'application/json')
    .set('X-Razorpay-Signature', options.signature);

  if (options.eventId !== undefined) req.set('X-Razorpay-Event-Id', options.eventId);

  return req.send(body);
}

/**
 * A `PENDING_PAYMENT` booking with a `CREATED` payment row against it — the
 * state `POST /bookings/:id/order` leaves behind.
 *
 * Every payment belongs to a booking now, so there is no "a payment, standing
 * alone" fixture to write: a webhook that settles money is always also
 * activating something, and these tests assert both halves.
 */
async function seedPendingBooking(
  orderId: string,
  options: { status?: 'PENDING_PAYMENT' | 'EXPIRED_UNPAID' } = {},
): Promise<{
  user: TestUser;
  bookingId: string;
  deviceId: string;
  paymentRowId: string;
  amount: number;
}> {
  const user = await createTestUser();
  const device = await seedDevice();

  const booking = await seedBooking({
    userId: user.id,
    deviceId: device.id,
    status: options.status ?? 'PENDING_PAYMENT',
    hours: 2,
  });

  const priced = await prisma.booking.findUniqueOrThrow({
    where: { id: booking.id },
    select: { pricePaise: true },
  });

  const payment = await prisma.payment.create({
    data: {
      userId: user.id,
      bookingId: booking.id,
      purpose: 'BOOKING',
      razorpayOrderId: orderId,
      amount: priced.pricePaise,
      currency: 'INR',
      status: 'CREATED',
    },
    select: { id: true },
  });

  return {
    user,
    bookingId: booking.id,
    deviceId: device.id,
    paymentRowId: payment.id,
    amount: priced.pricePaise,
  };
}

describe('POST /api/v1/payments/webhook', () => {
  beforeEach(() => {
    resetRazorpayMock();
    resetRazorpayClient();
  });

  it('rejects a bad signature with 400 and applies nothing', async () => {
    const orderId = 'order_TESTwh0001';
    const { amount, bookingId } = await seedPendingBooking(orderId);

    const body = paymentCapturedBody({ orderId, paymentId: 'pay_TESTwh0001', amount });

    const response = await postWebhook(body, {
      signature: BAD_SIGNATURE,
      eventId: 'evt_bad_signature',
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_SIGNATURE');

    const row = await prisma.payment.findUnique({ where: { razorpayOrderId: orderId } });
    expect(row?.status).toBe('CREATED');

    // And the booking is untouched: an unsigned body cannot activate anything.
    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(booking.status).toBe('PENDING_PAYMENT');

    // Nothing recorded in the idempotency ledger, so a correctly signed
    // delivery of the same event can still be processed.
    expect(await prisma.webhookEvent.count()).toBe(0);

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'payment.webhook.signature.failed' },
    });
    expect(audit).not.toBeNull();
  });

  it('rejects a request with no signature header', async () => {
    const response = await request(app())
      .post(WEBHOOK_URL)
      .set('Content-Type', 'application/json')
      .send(paymentCapturedBody({ orderId: 'order_x', paymentId: 'pay_x', amount: 100 }));

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_SIGNATURE');
  });

  /**
   * The webhook is the source of truth, so this is the normal path by which a
   * booking becomes ACTIVE — the browser may never call `/verify` at all.
   */
  it('activates the booking on payment.captured, exactly once', async () => {
    const orderId = 'order_TESTwh0002';
    const { amount, bookingId } = await seedPendingBooking(orderId);

    const body = paymentCapturedBody({ orderId, paymentId: 'pay_TESTwh0002', amount });

    const response = await postWebhook(body, {
      signature: webhookSignature(body),
      eventId: 'evt_captured_once',
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true, duplicate: false });

    const row = await prisma.payment.findUnique({ where: { razorpayOrderId: orderId } });
    expect(row?.status).toBe('PAID');
    expect(row?.razorpayPaymentId).toBe('pay_TESTwh0002');
    expect(row?.paidAt).toBeInstanceOf(Date);

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(booking.status).toBe('ACTIVE');
    // The hold is released and the clock has started.
    expect(booking.holdExpiresAt).toBeNull();
    expect(booking.endsAt).toBeInstanceOf(Date);

    const ledger = await prisma.webhookEvent.findUnique({
      where: { eventId: 'evt_captured_once' },
    });
    expect(ledger?.type).toBe('payment.captured');

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'payment.webhook.processed' },
    });
    expect(audit).not.toBeNull();
  });

  /**
   * The clock starts at capture, not at creation.
   *
   * This is assumption (c) made testable: a booking created an hour ago and
   * paid for now must still get its full two hours, or a slow checkout quietly
   * costs the user time they bought.
   */
  it('sets endsAt from the capture time, not the creation time', async () => {
    const user = await createTestUser();
    const device = await seedDevice();
    const createdAt = new Date(Date.now() - 55 * 60 * 1000);

    const booking = await seedBooking({
      userId: user.id,
      deviceId: device.id,
      status: 'PENDING_PAYMENT',
      hours: 2,
      startsAt: createdAt,
      // Still inside its hold, just only barely.
      holdExpiresAt: new Date(Date.now() + 60 * 1000),
    });

    const orderId = 'order_TESTwhClock';
    const priced = await prisma.booking.findUniqueOrThrow({
      where: { id: booking.id },
      select: { pricePaise: true },
    });
    await prisma.payment.create({
      data: {
        userId: user.id,
        bookingId: booking.id,
        purpose: 'BOOKING',
        razorpayOrderId: orderId,
        amount: priced.pricePaise,
        currency: 'INR',
        status: 'CREATED',
      },
    });

    const body = paymentCapturedBody({
      orderId,
      paymentId: 'pay_TESTwhClock',
      amount: priced.pricePaise,
    });
    await postWebhook(body, { signature: webhookSignature(body), eventId: 'evt_clock' });

    const settled = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(settled.status).toBe('ACTIVE');

    // Two full hours from *now*, not one hour and five minutes from creation.
    const remainingMs = settled.endsAt!.getTime() - Date.now();
    expect(remainingMs).toBeGreaterThan(115 * 60 * 1000);
  });

  it('ignores a duplicate delivery of an event it already processed', async () => {
    const orderId = 'order_TESTwh0003';
    const { amount } = await seedPendingBooking(orderId);

    const body = paymentCapturedBody({ orderId, paymentId: 'pay_TESTwh0003', amount });
    const options = { signature: webhookSignature(body), eventId: 'evt_duplicate' };

    const first = await postWebhook(body, options);
    expect(first.status).toBe(200);
    expect(first.body.duplicate).toBe(false);

    const paidAtAfterFirst = (
      await prisma.payment.findUnique({ where: { razorpayOrderId: orderId } })
    )?.paidAt;

    const second = await postWebhook(body, options);

    // 200 so Razorpay stops retrying, but flagged as a duplicate.
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ received: true, duplicate: true });

    expect(await prisma.webhookEvent.count()).toBe(1);

    const row = await prisma.payment.findUnique({ where: { razorpayOrderId: orderId } });
    expect(row?.paidAt?.toISOString()).toBe(paidAtAfterFirst?.toISOString());

    const duplicateAudit = await prisma.auditLog.findFirst({
      where: { action: 'payment.webhook.duplicate' },
    });
    expect(duplicateAudit).not.toBeNull();
  });

  it('activates the booking even when /payments/verify was never called', async () => {
    const user = await createTestUser();
    await seedDevice();

    // Booking and order created through the real endpoints, then the browser
    // vanishes — no verify call ever happens.
    const created = await request(app())
      .post('/api/v1/bookings')
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', user.cookie)
      .send({ hours: 2, size: 'MEDIUM' });
    expect(created.status).toBe(201);

    const bookingId: string = created.body.booking.id;

    const order = await request(app())
      .post(`/api/v1/bookings/${bookingId}/order`)
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', user.cookie)
      .send({});
    expect(order.status).toBe(200);

    const before = await request(app())
      .get('/api/v1/bookings/current')
      .set('Cookie', user.cookie);
    expect(before.body.booking.status).toBe('PENDING_PAYMENT');

    const body = paymentCapturedBody({
      orderId: order.body.orderId,
      paymentId: 'pay_TESTwh0004',
      amount: order.body.amount,
    });

    const response = await postWebhook(body, {
      signature: webhookSignature(body),
      eventId: 'evt_no_verify',
    });
    expect(response.status).toBe(200);

    // The webhook alone is enough: the booking is running.
    const after = await request(app())
      .get('/api/v1/bookings/current')
      .set('Cookie', user.cookie);
    expect(after.body.booking.status).toBe('ACTIVE');
    expect(after.body.booking.effectiveStatus).toBe('ACTIVE');

    const row = await prisma.payment.findUnique({
      where: { razorpayOrderId: order.body.orderId },
    });
    expect(row?.status).toBe('PAID');
  });

  /**
   * A refund marks the money returned and **does not touch the booking**.
   *
   * A safe someone is physically using cannot be taken back by a webhook, and
   * reclaiming is a deliberate admin action. See docs/decisions.md.
   */
  it('marks the payment REFUNDED without ending the booking', async () => {
    const user = await createTestUser();
    const device = await seedDevice();
    const orderId = 'order_TESTwh0005';
    const razorpayPaymentId = 'pay_TESTwh0005';

    const booking = await seedBooking({
      userId: user.id,
      deviceId: device.id,
      status: 'ACTIVE',
      hours: 2,
    });

    await prisma.payment.create({
      data: {
        userId: user.id,
        bookingId: booking.id,
        purpose: 'BOOKING',
        razorpayOrderId: orderId,
        razorpayPaymentId,
        amount: 20_000,
        currency: 'INR',
        status: 'PAID',
        paidAt: new Date(),
      },
    });

    const body = refundProcessedBody({ paymentId: razorpayPaymentId, amount: 20_000, orderId });

    const response = await postWebhook(body, {
      signature: webhookSignature(body),
      eventId: 'evt_refund',
    });

    expect(response.status).toBe(200);

    const row = await prisma.payment.findUnique({ where: { razorpayOrderId: orderId } });
    expect(row?.status).toBe('REFUNDED');

    const after = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(after.status).toBe('ACTIVE');
  });

  /**
   * A refund landing on a flagged payment clears the flag.
   *
   * The list exists to say "this money needs refunding by hand"; leaving a
   * refunded row on it is wrong in the direction that gets a second refund
   * issued.
   */
  it('clears a review flag when the refund it was flagged for arrives', async () => {
    const user = await createTestUser();
    const orderId = 'order_TESTwhReview';
    const razorpayPaymentId = 'pay_TESTwhReview';

    const payment = await prisma.payment.create({
      data: {
        userId: user.id,
        purpose: 'BOOKING',
        razorpayOrderId: orderId,
        razorpayPaymentId,
        amount: 20_000,
        currency: 'INR',
        status: 'PAID',
        paidAt: new Date(),
        reviewReason: 'BOOKING_EXPIRED_DEVICE_TAKEN',
      },
      select: { id: true },
    });

    const body = refundProcessedBody({ paymentId: razorpayPaymentId, amount: 20_000, orderId });
    await postWebhook(body, { signature: webhookSignature(body), eventId: 'evt_review_refund' });

    const row = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(row.status).toBe('REFUNDED');
    expect(row.reviewClearedAt).toBeInstanceOf(Date);
    // The reason stays: it is the record of *why* money was returned.
    expect(row.reviewReason).toBe('BOOKING_EXPIRED_DEVICE_TAKEN');
  });

  it('marks an unsettled payment FAILED on payment.failed', async () => {
    const orderId = 'order_TESTwh0006';
    const { amount, bookingId } = await seedPendingBooking(orderId);

    const body = paymentFailedBody({ orderId, paymentId: 'pay_TESTwh0006', amount });

    const response = await postWebhook(body, {
      signature: webhookSignature(body),
      eventId: 'evt_failed',
    });

    expect(response.status).toBe(200);
    const row = await prisma.payment.findUnique({ where: { razorpayOrderId: orderId } });
    expect(row?.status).toBe('FAILED');

    // A failed payment does not activate, and does not cancel either: the hold
    // simply lapses on its own and the sweeper releases the safe.
    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(booking.status).toBe('PENDING_PAYMENT');
  });

  it('does not let a late payment.failed undo a captured payment', async () => {
    const orderId = 'order_TESTwh0007';
    const paymentId = 'pay_TESTwh0007';
    const { amount, bookingId } = await seedPendingBooking(orderId);

    const captured = paymentCapturedBody({ orderId, paymentId, amount });
    await postWebhook(captured, {
      signature: webhookSignature(captured),
      eventId: 'evt_race_captured',
    });

    const failed = paymentFailedBody({ orderId, paymentId, amount });
    const response = await postWebhook(failed, {
      signature: webhookSignature(failed),
      eventId: 'evt_race_failed',
    });

    expect(response.status).toBe(200);
    const row = await prisma.payment.findUnique({ where: { razorpayOrderId: orderId } });
    expect(row?.status).toBe('PAID');

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(booking.status).toBe('ACTIVE');
  });

  it('refuses to settle a payment captured for less than the order amount', async () => {
    const orderId = 'order_TESTwh0008';
    const { bookingId } = await seedPendingBooking(orderId);

    // 1 rupee against a two-hour booking.
    const body = paymentCapturedBody({ orderId, paymentId: 'pay_TESTwh0008', amount: 100 });

    const response = await postWebhook(body, {
      signature: webhookSignature(body),
      eventId: 'evt_underpaid',
    });

    // Acknowledged (there is nothing for Razorpay to retry) but not applied.
    expect(response.status).toBe(200);
    const row = await prisma.payment.findUnique({ where: { razorpayOrderId: orderId } });
    expect(row?.status).toBe('CREATED');

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(booking.status).toBe('PENDING_PAYMENT');
  });

  it('acknowledges a correctly signed event type it does not handle', async () => {
    const body = JSON.stringify({
      entity: 'event',
      event: 'subscription.charged',
      payload: {},
    });

    const response = await postWebhook(body, {
      signature: webhookSignature(body),
      eventId: 'evt_unhandled',
    });

    expect(response.status).toBe(200);
    // Recorded so repeat deliveries are deduped rather than re-examined.
    expect(await prisma.webhookEvent.count()).toBe(1);
  });

  it('does not require auth cookies', async () => {
    const orderId = 'order_TESTwh0009';
    const { amount } = await seedPendingBooking(orderId);

    const body = paymentCapturedBody({ orderId, paymentId: 'pay_TESTwh0009', amount });

    // No Cookie header at all — the HMAC is the authentication.
    const response = await postWebhook(body, {
      signature: webhookSignature(body),
      eventId: 'evt_no_cookie',
    });

    expect(response.status).toBe(200);
  });

  it('dedupes by body hash when the event id header is absent', async () => {
    const orderId = 'order_TESTwh0010';
    const { amount } = await seedPendingBooking(orderId);

    const body = paymentCapturedBody({ orderId, paymentId: 'pay_TESTwh0010', amount });
    const signature = webhookSignature(body);

    const first = await postWebhook(body, { signature });
    const second = await postWebhook(body, { signature });

    expect(first.body.duplicate).toBe(false);
    expect(second.body.duplicate).toBe(true);
    expect(await prisma.webhookEvent.count()).toBe(1);
  });

  it('is unaffected by a verify call that arrives after the webhook', async () => {
    const orderId = 'order_TESTwh0011';
    const paymentId = 'pay_TESTwh0011';
    const { user, amount, bookingId } = await seedPendingBooking(orderId);

    const body = paymentCapturedBody({ orderId, paymentId, amount });
    await postWebhook(body, { signature: webhookSignature(body), eventId: 'evt_then_verify' });

    const verify = await request(app())
      .post('/api/v1/payments/verify')
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', user.cookie)
      .send({
        razorpay_order_id: orderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: checkoutSignature(orderId, paymentId),
      });

    expect(verify.status).toBe(200);
    expect(verify.body.needsReview).toBe(false);
    expect(await prisma.payment.count({ where: { status: 'PAID' } })).toBe(1);

    // Activated exactly once: the second path is idempotent, not additive.
    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(booking.status).toBe('ACTIVE');
  });
});
