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
  paymentCapturedBody,
  paymentFailedBody,
  refundProcessedBody,
  TEST_ORIGIN,
  webhookSignature,
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

/** A CREATED payment row, as `/payments/order` would have left it. */
async function seedCreatedPayment(userId: string, orderId: string) {
  return prisma.payment.create({
    data: {
      userId,
      razorpayOrderId: orderId,
      amount: env.SAFE_PRICE_PAISE,
      currency: 'INR',
      status: 'CREATED',
    },
    select: { id: true },
  });
}

describe('POST /api/v1/payments/webhook', () => {
  beforeEach(() => {
    resetRazorpayMock();
    resetRazorpayClient();
  });

  it('rejects a bad signature with 400 and applies nothing', async () => {
    const user = await createTestUser();
    const orderId = 'order_TESTwh0001';
    await seedCreatedPayment(user.id, orderId);

    const body = paymentCapturedBody({
      orderId,
      paymentId: 'pay_TESTwh0001',
      amount: env.SAFE_PRICE_PAISE,
    });

    const response = await postWebhook(body, {
      signature: BAD_SIGNATURE,
      eventId: 'evt_bad_signature',
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_SIGNATURE');

    const row = await prisma.payment.findUnique({ where: { razorpayOrderId: orderId } });
    expect(row?.status).toBe('CREATED');

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

  it('processes a valid payment.captured event exactly once', async () => {
    const user = await createTestUser();
    const orderId = 'order_TESTwh0002';
    await seedCreatedPayment(user.id, orderId);

    const body = paymentCapturedBody({
      orderId,
      paymentId: 'pay_TESTwh0002',
      amount: env.SAFE_PRICE_PAISE,
    });

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

    const ledger = await prisma.webhookEvent.findUnique({
      where: { eventId: 'evt_captured_once' },
    });
    expect(ledger?.type).toBe('payment.captured');

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'payment.webhook.processed' },
    });
    expect(audit).not.toBeNull();
  });

  it('ignores a duplicate delivery of an event it already processed', async () => {
    const user = await createTestUser();
    const orderId = 'order_TESTwh0003';
    await seedCreatedPayment(user.id, orderId);

    const body = paymentCapturedBody({
      orderId,
      paymentId: 'pay_TESTwh0003',
      amount: env.SAFE_PRICE_PAISE,
    });
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

  it('marks the payment PAID even when /payments/verify was never called', async () => {
    const user = await createTestUser();

    // Order created through the real endpoint, then the browser vanishes —
    // no verify call ever happens.
    const order = await request(app())
      .post('/api/v1/payments/order')
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', user.cookie)
      .send({});
    expect(order.status).toBe(201);

    const beforeMe = await request(app()).get('/api/v1/auth/me').set('Cookie', user.cookie);
    expect(beforeMe.body.user.hasPaid).toBe(false);

    const body = paymentCapturedBody({
      orderId: order.body.orderId,
      paymentId: 'pay_TESTwh0004',
      amount: env.SAFE_PRICE_PAISE,
    });

    const response = await postWebhook(body, {
      signature: webhookSignature(body),
      eventId: 'evt_no_verify',
    });
    expect(response.status).toBe(200);

    // The webhook alone is enough: the user is activated.
    const afterMe = await request(app()).get('/api/v1/auth/me').set('Cookie', user.cookie);
    expect(afterMe.body.user.hasPaid).toBe(true);

    const row = await prisma.payment.findUnique({
      where: { razorpayOrderId: order.body.orderId },
    });
    expect(row?.status).toBe('PAID');
  });

  it('marks the payment REFUNDED on refund.processed and revokes hasPaid', async () => {
    const user = await createTestUser();
    const orderId = 'order_TESTwh0005';
    const razorpayPaymentId = 'pay_TESTwh0005';

    await prisma.payment.create({
      data: {
        userId: user.id,
        razorpayOrderId: orderId,
        razorpayPaymentId,
        amount: env.SAFE_PRICE_PAISE,
        currency: 'INR',
        status: 'PAID',
        paidAt: new Date(),
      },
    });

    const body = refundProcessedBody({
      paymentId: razorpayPaymentId,
      amount: env.SAFE_PRICE_PAISE,
      orderId,
    });

    const response = await postWebhook(body, {
      signature: webhookSignature(body),
      eventId: 'evt_refund',
    });

    expect(response.status).toBe(200);

    const row = await prisma.payment.findUnique({ where: { razorpayOrderId: orderId } });
    expect(row?.status).toBe('REFUNDED');

    // A refunded payment no longer counts as paid.
    const me = await request(app()).get('/api/v1/auth/me').set('Cookie', user.cookie);
    expect(me.body.user.hasPaid).toBe(false);
  });

  it('marks an unsettled payment FAILED on payment.failed', async () => {
    const user = await createTestUser();
    const orderId = 'order_TESTwh0006';
    await seedCreatedPayment(user.id, orderId);

    const body = paymentFailedBody({
      orderId,
      paymentId: 'pay_TESTwh0006',
      amount: env.SAFE_PRICE_PAISE,
    });

    const response = await postWebhook(body, {
      signature: webhookSignature(body),
      eventId: 'evt_failed',
    });

    expect(response.status).toBe(200);
    const row = await prisma.payment.findUnique({ where: { razorpayOrderId: orderId } });
    expect(row?.status).toBe('FAILED');
  });

  it('does not let a late payment.failed undo a captured payment', async () => {
    const user = await createTestUser();
    const orderId = 'order_TESTwh0007';
    const paymentId = 'pay_TESTwh0007';
    await seedCreatedPayment(user.id, orderId);

    const captured = paymentCapturedBody({ orderId, paymentId, amount: env.SAFE_PRICE_PAISE });
    await postWebhook(captured, {
      signature: webhookSignature(captured),
      eventId: 'evt_race_captured',
    });

    const failed = paymentFailedBody({ orderId, paymentId, amount: env.SAFE_PRICE_PAISE });
    const response = await postWebhook(failed, {
      signature: webhookSignature(failed),
      eventId: 'evt_race_failed',
    });

    expect(response.status).toBe(200);
    const row = await prisma.payment.findUnique({ where: { razorpayOrderId: orderId } });
    expect(row?.status).toBe('PAID');
  });

  it('refuses to settle a payment captured for less than the order amount', async () => {
    const user = await createTestUser();
    const orderId = 'order_TESTwh0008';
    await seedCreatedPayment(user.id, orderId);

    // 1 rupee against a 999 rupee order.
    const body = paymentCapturedBody({ orderId, paymentId: 'pay_TESTwh0008', amount: 100 });

    const response = await postWebhook(body, {
      signature: webhookSignature(body),
      eventId: 'evt_underpaid',
    });

    // Acknowledged (there is nothing for Razorpay to retry) but not applied.
    expect(response.status).toBe(200);
    const row = await prisma.payment.findUnique({ where: { razorpayOrderId: orderId } });
    expect(row?.status).toBe('CREATED');
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
    const user = await createTestUser();
    const orderId = 'order_TESTwh0009';
    await seedCreatedPayment(user.id, orderId);

    const body = paymentCapturedBody({
      orderId,
      paymentId: 'pay_TESTwh0009',
      amount: env.SAFE_PRICE_PAISE,
    });

    // No Cookie header at all — the HMAC is the authentication.
    const response = await postWebhook(body, {
      signature: webhookSignature(body),
      eventId: 'evt_no_cookie',
    });

    expect(response.status).toBe(200);
  });

  it('dedupes by body hash when the event id header is absent', async () => {
    const user = await createTestUser();
    const orderId = 'order_TESTwh0010';
    await seedCreatedPayment(user.id, orderId);

    const body = paymentCapturedBody({
      orderId,
      paymentId: 'pay_TESTwh0010',
      amount: env.SAFE_PRICE_PAISE,
    });
    const signature = webhookSignature(body);

    const first = await postWebhook(body, { signature });
    const second = await postWebhook(body, { signature });

    expect(first.body.duplicate).toBe(false);
    expect(second.body.duplicate).toBe(true);
    expect(await prisma.webhookEvent.count()).toBe(1);
  });

  it('is unaffected by a verify call that arrives after the webhook', async () => {
    const user = await createTestUser();
    const order = await request(app())
      .post('/api/v1/payments/order')
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', user.cookie)
      .send({});

    const orderId: string = order.body.orderId;
    const paymentId = 'pay_TESTwh0011';

    const body = paymentCapturedBody({ orderId, paymentId, amount: env.SAFE_PRICE_PAISE });
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
    expect(verify.body.hasPaid).toBe(true);
    expect(await prisma.payment.count({ where: { status: 'PAID' } })).toBe(1);
  });
});
