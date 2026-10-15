import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { resetRazorpayClient } from '../../lib/razorpay';
import {
  app,
  BAD_SIGNATURE,
  checkoutSignature,
  createTestUser,
  TEST_ORIGIN,
  type TestUser,
} from '../../test/helpers';
import { resetRazorpayMock } from '../../test/razorpayMock';

vi.mock('razorpay', () => import('../../test/razorpayMock'));

/** Creates an order through the real endpoint and returns its ids. */
async function startOrder(user: TestUser): Promise<{ orderId: string; paymentRowId: string }> {
  const response = await request(app())
    .post('/api/v1/payments/order')
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', user.cookie)
    .send({});

  expect(response.status).toBe(201);
  return { orderId: response.body.orderId, paymentRowId: response.body.paymentId };
}

const RAZORPAY_PAYMENT_ID = 'pay_TESTverify0001';

describe('POST /api/v1/payments/verify', () => {
  beforeEach(() => {
    resetRazorpayMock();
    resetRazorpayClient();
  });

  it('marks the payment PAID for a valid signature', async () => {
    const user = await createTestUser();
    const { orderId } = await startOrder(user);

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
    expect(response.body.hasPaid).toBe(true);
    expect(response.body.payment).toMatchObject({
      status: 'PAID',
      amount: env.SAFE_PRICE_PAISE,
      razorpayOrderId: orderId,
    });
    expect(response.body.payment.paidAt).not.toBeNull();

    const row = await prisma.payment.findUnique({ where: { razorpayOrderId: orderId } });
    expect(row?.status).toBe('PAID');
    expect(row?.razorpayPaymentId).toBe(RAZORPAY_PAYMENT_ID);
    expect(row?.paidAt).toBeInstanceOf(Date);

    const audit = await prisma.auditLog.findFirst({
      where: { userId: user.id, action: 'payment.verified' },
    });
    expect(audit).not.toBeNull();
  });

  it('rejects an invalid signature and leaves the payment untouched', async () => {
    const user = await createTestUser();
    const { orderId } = await startOrder(user);

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

    const audit = await prisma.auditLog.findFirst({
      where: { userId: user.id, action: 'payment.signature.failed' },
    });
    expect(audit).not.toBeNull();
    // The signature value itself must never be stored.
    expect(JSON.stringify(audit?.metadata)).not.toContain(BAD_SIGNATURE);
  });

  it("rejects a signature computed for a different payment id", async () => {
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
    const { orderId } = await startOrder(owner);

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

    const audit = await prisma.auditLog.findFirst({
      where: { userId: attacker.id, action: 'payment.verify.forbidden' },
    });
    expect(audit).not.toBeNull();
  });

  it('is idempotent — a repeated call returns the same result and changes nothing', async () => {
    const user = await createTestUser();
    const { orderId } = await startOrder(user);

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

    const paidAtAfterFirst = (
      await prisma.payment.findUnique({ where: { razorpayOrderId: orderId } })
    )?.paidAt;

    const second = await request(app())
      .post('/api/v1/payments/verify')
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', user.cookie)
      .send(body);

    expect(second.status).toBe(200);
    expect(second.body.hasPaid).toBe(true);
    expect(second.body.payment).toEqual(first.body.payment);

    const row = await prisma.payment.findUnique({ where: { razorpayOrderId: orderId } });
    expect(row?.status).toBe('PAID');
    // paidAt is not bumped by the second call.
    expect(row?.paidAt?.toISOString()).toBe(paidAtAfterFirst?.toISOString());

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

describe('GET /api/v1/payments/me', () => {
  beforeEach(() => {
    resetRazorpayMock();
    resetRazorpayClient();
  });

  it('reports no payment for a new user, with the server price', async () => {
    const user = await createTestUser();

    const response = await request(app()).get('/api/v1/payments/me').set('Cookie', user.cookie);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      hasPaid: false,
      payment: null,
      priceInPaise: env.SAFE_PRICE_PAISE,
      currency: 'INR',
    });
  });

  it('reports hasPaid once the payment is verified', async () => {
    const user = await createTestUser();
    const { orderId } = await startOrder(user);

    await request(app())
      .post('/api/v1/payments/verify')
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', user.cookie)
      .send({
        razorpay_order_id: orderId,
        razorpay_payment_id: RAZORPAY_PAYMENT_ID,
        razorpay_signature: checkoutSignature(orderId, RAZORPAY_PAYMENT_ID),
      });

    const response = await request(app()).get('/api/v1/payments/me').set('Cookie', user.cookie);

    expect(response.status).toBe(200);
    expect(response.body.hasPaid).toBe(true);
    expect(response.body.payment).toMatchObject({ status: 'PAID', razorpayOrderId: orderId });
  });
});

describe('GET /api/v1/auth/me', () => {
  beforeEach(() => {
    resetRazorpayClient();
  });

  it('includes hasPaid in the public user', async () => {
    const user = await createTestUser();

    const before = await request(app()).get('/api/v1/auth/me').set('Cookie', user.cookie);
    expect(before.status).toBe(200);
    expect(before.body.user.hasPaid).toBe(false);
    // The password hash must never appear in a response.
    expect(before.body.user.passwordHash).toBeUndefined();

    await prisma.payment.create({
      data: {
        userId: user.id,
        razorpayOrderId: 'order_TESTauthme',
        amount: env.SAFE_PRICE_PAISE,
        status: 'PAID',
        paidAt: new Date(),
      },
    });

    const after = await request(app()).get('/api/v1/auth/me').set('Cookie', user.cookie);
    expect(after.body.user.hasPaid).toBe(true);
  });
});
