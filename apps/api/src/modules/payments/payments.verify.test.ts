import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { prisma } from '../../lib/prisma';
import { resetRazorpayClient } from '../../lib/razorpay';
import {
  app,
  BAD_SIGNATURE,
  checkoutSignature,
  createTestUser,
  seedDevice,
  TEST_ORIGIN,
  type TestUser,
} from '../../test/helpers';
import { resetRazorpayMock } from '../../test/razorpayMock';

vi.mock('razorpay', () => import('../../test/razorpayMock'));

/**
 * Books a safe and creates its Razorpay order, both through the real
 * endpoints.
 *
 * There is no account-level order endpoint any more: an order always belongs
 * to a booking, which is where the amount comes from. Nothing in the request
 * carries a price.
 */
async function startOrder(
  user: TestUser,
  hours = 2,
): Promise<{ orderId: string; paymentRowId: string; bookingId: string; amount: number }> {
  await seedDevice();

  const created = await request(app())
    .post('/api/v1/bookings')
    .set('Origin', TEST_ORIGIN)
    .set('Cookie', user.cookie)
    .send({ hours });
  expect(created.status).toBe(201);

  const bookingId: string = created.body.booking.id;

  const order = await request(app())
    .post(`/api/v1/bookings/${bookingId}/order`)
    .set('Origin', TEST_ORIGIN)
    .set('Cookie', user.cookie)
    .send({});
  expect(order.status).toBe(200);

  return {
    orderId: order.body.orderId,
    paymentRowId: order.body.paymentId,
    bookingId,
    amount: order.body.amount,
  };
}

const RAZORPAY_PAYMENT_ID = 'pay_TESTverify0001';

describe('POST /api/v1/payments/verify', () => {
  beforeEach(() => {
    resetRazorpayMock();
    resetRazorpayClient();
  });

  it('marks the payment PAID and activates the booking for a valid signature', async () => {
    const user = await createTestUser();
    const { orderId, bookingId, amount } = await startOrder(user);

    const response = await request(app())
      .post('/api/v1/payments/verify')
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', user.cookie)
      .send({
        razorpay_order_id: orderId,
        razorpay_payment_id: RAZORPAY_PAYMENT_ID,
        razorpay_signature: checkoutSignature(orderId, RAZORPAY_PAYMENT_ID),
      });

    expect(response.status).toBe(200);
    expect(response.body.needsReview).toBe(false);
    expect(response.body.payment).toMatchObject({
      status: 'PAID',
      amount,
      razorpayOrderId: orderId,
      purpose: 'BOOKING',
      bookingId,
    });
    expect(response.body.payment.paidAt).not.toBeNull();

    const row = await prisma.payment.findUnique({ where: { razorpayOrderId: orderId } });
    expect(row?.status).toBe('PAID');
    expect(row?.razorpayPaymentId).toBe(RAZORPAY_PAYMENT_ID);
    expect(row?.paidAt).toBeInstanceOf(Date);

    /**
     * The money and its effect commit together.
     *
     * A booking must never be ACTIVE without the payment, and the payment must
     * never settle without either an effect or a review flag — so the booking
     * is already running by the time the response goes out.
     */
    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(booking.status).toBe('ACTIVE');
    expect(booking.endsAt).toBeInstanceOf(Date);

    const audit = await prisma.auditLog.findFirst({
      where: { userId: user.id, action: 'payment.verified' },
    });
    expect(audit).not.toBeNull();
  });

  it('rejects an invalid signature and leaves the payment and booking untouched', async () => {
    const user = await createTestUser();
    const { orderId, bookingId } = await startOrder(user);

    const response = await request(app())
      .post('/api/v1/payments/verify')
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', user.cookie)
      .send({
        razorpay_order_id: orderId,
        razorpay_payment_id: RAZORPAY_PAYMENT_ID,
        razorpay_signature: BAD_SIGNATURE,
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_SIGNATURE');

    // Crucially the row is NOT marked FAILED: anyone who learned an order id
    // could otherwise poison a legitimate payment in progress.
    const row = await prisma.payment.findUnique({ where: { razorpayOrderId: orderId } });
    expect(row?.status).toBe('CREATED');
    expect(row?.razorpayPaymentId).toBeNull();

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(booking.status).toBe('PENDING_PAYMENT');

    const audit = await prisma.auditLog.findFirst({
      where: { userId: user.id, action: 'payment.signature.failed' },
    });
    expect(audit).not.toBeNull();
    // The signature value itself must never be stored.
    expect(JSON.stringify(audit?.metadata)).not.toContain(BAD_SIGNATURE);
  });

  it('rejects a signature computed for a different payment id', async () => {
    const user = await createTestUser();
    const { orderId } = await startOrder(user);

    const response = await request(app())
      .post('/api/v1/payments/verify')
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', user.cookie)
      .send({
        razorpay_order_id: orderId,
        razorpay_payment_id: RAZORPAY_PAYMENT_ID,
        // Valid HMAC, but bound to a different payment id.
        razorpay_signature: checkoutSignature(orderId, 'pay_TESTsomethingelse'),
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_SIGNATURE');
  });

  it("refuses to verify another user's order", async () => {
    const owner = await createTestUser();
    const attacker = await createTestUser();
    const { orderId, bookingId } = await startOrder(owner);

    const response = await request(app())
      .post('/api/v1/payments/verify')
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', attacker.cookie)
      .send({
        razorpay_order_id: orderId,
        razorpay_payment_id: RAZORPAY_PAYMENT_ID,
        // A fully valid signature — ownership, not the HMAC, is what stops this.
        razorpay_signature: checkoutSignature(orderId, RAZORPAY_PAYMENT_ID),
      });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');

    const row = await prisma.payment.findUnique({ where: { razorpayOrderId: orderId } });
    expect(row?.status).toBe('CREATED');

    // And it did not activate somebody else's booking either.
    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(booking.status).toBe('PENDING_PAYMENT');

    const audit = await prisma.auditLog.findFirst({
      where: { userId: attacker.id, action: 'payment.verify.forbidden' },
    });
    expect(audit).not.toBeNull();
  });

  it('is idempotent — a repeated call returns the same result and changes nothing', async () => {
    const user = await createTestUser();
    const { orderId, bookingId } = await startOrder(user);

    const body = {
      razorpay_order_id: orderId,
      razorpay_payment_id: RAZORPAY_PAYMENT_ID,
      razorpay_signature: checkoutSignature(orderId, RAZORPAY_PAYMENT_ID),
    };

    const first = await request(app())
      .post('/api/v1/payments/verify')
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', user.cookie)
      .send(body);
    expect(first.status).toBe(200);

    const afterFirst = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    const paidAtAfterFirst = (
      await prisma.payment.findUnique({ where: { razorpayOrderId: orderId } })
    )?.paidAt;

    const second = await request(app())
      .post('/api/v1/payments/verify')
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', user.cookie)
      .send(body);

    expect(second.status).toBe(200);
    expect(second.body.needsReview).toBe(false);
    expect(second.body.payment).toEqual(first.body.payment);

    const row = await prisma.payment.findUnique({ where: { razorpayOrderId: orderId } });
    expect(row?.status).toBe('PAID');
    // paidAt is not bumped by the second call.
    expect(row?.paidAt?.toISOString()).toBe(paidAtAfterFirst?.toISOString());

    /**
     * And the second call does not re-start the clock.
     *
     * An `endsAt` that moved on every repeated verify would hand out free time
     * to anyone who refreshed the callback page.
     */
    const afterSecond = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(afterSecond.endsAt?.toISOString()).toBe(afterFirst.endsAt?.toISOString());

    // Still exactly one row and one "verified" audit entry.
    expect(await prisma.payment.count()).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: { userId: user.id, action: 'payment.verified' },
      }),
    ).toBe(1);
  });

  it('404s for an order that does not exist', async () => {
    const user = await createTestUser();
    const orderId = 'order_TESTdoesnotexist';

    const response = await request(app())
      .post('/api/v1/payments/verify')
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', user.cookie)
      .send({
        razorpay_order_id: orderId,
        razorpay_payment_id: RAZORPAY_PAYMENT_ID,
        razorpay_signature: checkoutSignature(orderId, RAZORPAY_PAYMENT_ID),
      });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });

  it('requires authentication', async () => {
    const response = await request(app()).post('/api/v1/payments/verify').send({
      razorpay_order_id: 'order_TEST1',
      razorpay_payment_id: 'pay_TEST1',
      razorpay_signature: BAD_SIGNATURE,
    });

    expect(response.status).toBe(401);
  });

  it('rejects a malformed body before touching the database', async () => {
    const user = await createTestUser();

    const response = await request(app())
      .post('/api/v1/payments/verify')
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', user.cookie)
      .send({ razorpay_order_id: 'not-an-order-id' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.fields).toBeDefined();
  });
});

/**
 * `GET /payments/me` is gone.
 *
 * It answered "has this account been activated and what did it cost", which is
 * not a question the rental model has. `GET /bookings/current` replaced it, and
 * returns the live booking plus a quote for a new one. Asserted rather than
 * merely deleted, so the route cannot quietly come back carrying a price the
 * booking rules no longer agree with.
 */
describe('GET /api/v1/payments/me', () => {
  it('no longer exists', async () => {
    const user = await createTestUser();

    const response = await request(app()).get('/api/v1/payments/me').set('Cookie', user.cookie);

    expect(response.status).toBe(404);
  });
});
