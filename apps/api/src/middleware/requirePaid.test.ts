import express from 'express';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { errorHandler } from './errorHandler';
import { requireAuth } from './auth';
import { requirePaid } from './requirePaid';
import { createTestUser, givePaidPayment } from '../test/helpers';

/**
 * `requirePaid` has no routes of its own yet — it is built for the device,
 * lock/unlock and OTP endpoints. These tests mount it on a throwaway route so
 * its behaviour is pinned down before anything depends on it.
 */
function appWithProtectedRoute() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.get('/protected', requireAuth, requirePaid, (_req, res) => {
    res.status(200).json({ ok: true });
  });
  app.use(errorHandler);
  return app;
}

/** Mounted without requireAuth, which is a programming error, not a 401. */
function appWithMisconfiguredRoute() {
  const app = express();
  app.use(cookieParser());
  app.get('/broken', requirePaid, (_req, res) => {
    res.status(200).json({ ok: true });
  });
  app.use(errorHandler);
  return app;
}

describe('requirePaid', () => {
  it('blocks an unauthenticated caller at requireAuth', async () => {
    const response = await request(appWithProtectedRoute()).get('/protected');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('blocks an authenticated user who has not paid', async () => {
    const user = await createTestUser();

    const response = await request(appWithProtectedRoute())
      .get('/protected')
      .set('Cookie', user.cookie);

    expect(response.status).toBe(402);
    expect(response.body.error.code).toBe('PAYMENT_REQUIRED');

    const audit = await prisma.auditLog.findFirst({
      where: { userId: user.id, action: 'payment.required.blocked' },
    });
    expect(audit).not.toBeNull();
  });

  it('blocks a user whose only payment is still CREATED', async () => {
    const user = await createTestUser();
    await prisma.payment.create({
      data: {
        userId: user.id,
        razorpayOrderId: 'order_TESTunpaid',
        amount: env.SAFE_PRICE_PAISE,
        status: 'CREATED',
      },
    });

    const response = await request(appWithProtectedRoute())
      .get('/protected')
      .set('Cookie', user.cookie);

    expect(response.status).toBe(402);
  });

  it('blocks a user whose payment was refunded', async () => {
    const user = await createTestUser();
    await prisma.payment.create({
      data: {
        userId: user.id,
        razorpayOrderId: 'order_TESTrefunded',
        razorpayPaymentId: 'pay_TESTrefunded',
        amount: env.SAFE_PRICE_PAISE,
        status: 'REFUNDED',
        paidAt: new Date(),
      },
    });

    const response = await request(appWithProtectedRoute())
      .get('/protected')
      .set('Cookie', user.cookie);

    expect(response.status).toBe(402);
  });

  it('lets a paid user through', async () => {
    const user = await createTestUser();
    await givePaidPayment(user.id);

    const response = await request(appWithProtectedRoute())
      .get('/protected')
      .set('Cookie', user.cookie);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });

  it("does not leak another user's payment", async () => {
    const payer = await createTestUser();
    const freeloader = await createTestUser();
    await givePaidPayment(payer.id);

    const response = await request(appWithProtectedRoute())
      .get('/protected')
      .set('Cookie', freeloader.cookie);

    expect(response.status).toBe(402);
  });

  it('fails closed with a 500 when mounted without requireAuth', async () => {
    const response = await request(appWithMisconfiguredRoute()).get('/broken');

    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe('INTERNAL_ERROR');
  });
});
