import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { resetRazorpayClient } from '../../lib/razorpay';
import {
  app,
  createTestUser,
  givePaidPayment,
  TEST_ORIGIN,
} from '../../test/helpers';
import { createdOrders, resetRazorpayMock } from '../../test/razorpayMock';

vi.mock('razorpay', () => import('../../test/razorpayMock'));

describe('POST /api/v1/payments/order', () => {
  beforeEach(() => {
    resetRazorpayMock();
    resetRazorpayClient();
  });

  it('requires authentication', async () => {
    const response = await request(app()).post('/api/v1/payments/order').send({});

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('creates an order priced from server config and saves a CREATED payment', async () => {
    const user = await createTestUser();

    const response = await request(app())
      .post('/api/v1/payments/order')
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', user.cookie)
      .send({});

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      amount: env.SAFE_PRICE_PAISE,
      currency: 'INR',
      keyId: env.RAZORPAY_KEY_ID,
    });
    expect(response.body.orderId).toMatch(/^order_/);

    // The amount handed to Razorpay came from config, not the request.
    expect(createdOrders).toHaveLength(1);
    expect(createdOrders[0]?.amount).toBe(env.SAFE_PRICE_PAISE);
    // receipt is our own Payment row id, so a webhook can be traced back.
    expect(createdOrders[0]?.receipt).toBe(response.body.paymentId);
    expect(createdOrders[0]?.notes).toEqual({ userId: user.id });

    const row = await prisma.payment.findUnique({
      where: { razorpayOrderId: response.body.orderId },
    });
    expect(row).toMatchObject({
      userId: user.id,
      amount: env.SAFE_PRICE_PAISE,
      currency: 'INR',
      status: 'CREATED',
      razorpayPaymentId: null,
      paidAt: null,
    });
  });

  it('never exposes the Razorpay key secret', async () => {
    const user = await createTestUser();

    const response = await request(app())
      .post('/api/v1/payments/order')
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', user.cookie)
      .send({});

    expect(JSON.stringify(response.body)).not.toContain(env.RAZORPAY_KEY_SECRET);
  });

  it('ignores a client-supplied amount and charges the server price', async () => {
    const user = await createTestUser();

    const response = await request(app())
      .post('/api/v1/payments/order')
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', user.cookie)
      // A tampered client trying to pay Rs 1.
      .send({ amount: 100, currency: 'INR', priceInPaise: 100 });

    // The schema is strict, so the attempt is rejected outright rather than
    // silently ignored — either behaviour is safe, but this one is louder.
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(createdOrders).toHaveLength(0);
    expect(await prisma.payment.count()).toBe(0);
  });

  it('refuses with 409 when the user has already paid', async () => {
    const user = await createTestUser();
    await givePaidPayment(user.id);

    const response = await request(app())
      .post('/api/v1/payments/order')
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', user.cookie)
      .send({});

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('ALREADY_PAID');
    expect(createdOrders).toHaveLength(0);

    const audit = await prisma.auditLog.findFirst({
      where: { userId: user.id, action: 'payment.order.refused' },
    });
    expect(audit).not.toBeNull();
  });

  it('writes an audit entry when an order is created', async () => {
    const user = await createTestUser();

    await request(app()).post('/api/v1/payments/order').set('Origin', TEST_ORIGIN).set('Cookie', user.cookie).send({});

    const audit = await prisma.auditLog.findFirst({
      where: { userId: user.id, action: 'payment.order.created' },
    });
    expect(audit).not.toBeNull();
    expect(audit?.metadata).toMatchObject({ amount: env.SAFE_PRICE_PAISE });
  });
});
