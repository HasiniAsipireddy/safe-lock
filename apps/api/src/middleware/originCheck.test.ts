import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { TEST_ORIGIN, app, createTestUser, webhookSignature } from '../test/helpers';
import { resetRazorpayClient } from '../lib/razorpay';

vi.mock('razorpay', () => import('../test/razorpayMock'));

/**
 * The Origin allowlist is the explicit CSRF lock that sits behind
 * `sameSite=lax`. These tests use /auth/login because it is a state-changing
 * route that needs no prior session.
 */
const LOGIN_URL = '/api/v1/auth/login';
const CREDENTIALS = { identifier: 'nobody@example.com', password: 'whatever12345' };

describe('originCheck', () => {
  it('accepts an exact-match allowed origin', async () => {
    const response = await request(app())
      .post(LOGIN_URL)
      .set('Origin', TEST_ORIGIN)
      .send(CREDENTIALS);

    // 401 (no such account) proves it reached the handler rather than being
    // blocked at the origin gate.
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('accepts any origin in the comma-separated allowlist', async () => {
    const response = await request(app())
      .post(LOGIN_URL)
      .set('Origin', 'http://localhost:3001')
      .send(CREDENTIALS);

    expect(response.status).toBe(401);
  });

  it('rejects a wrong origin with 403 CSRF_ORIGIN_REJECTED', async () => {
    const response = await request(app())
      .post(LOGIN_URL)
      .set('Origin', 'https://evil.example.com')
      .send(CREDENTIALS);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('CSRF_ORIGIN_REJECTED');
    // The rejected origin is logged, never echoed back.
    expect(JSON.stringify(response.body)).not.toContain('evil.example.com');
  });

  it('rejects an origin that merely has the allowed one as a prefix', async () => {
    // The classic bug this guards: a prefix or regex match would accept this.
    const response = await request(app())
      .post(LOGIN_URL)
      .set('Origin', `${TEST_ORIGIN}.attacker.test`)
      .send(CREDENTIALS);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('CSRF_ORIGIN_REJECTED');
  });

  it('rejects a missing origin when auth cookies are present', async () => {
    const user = await createTestUser();

    const response = await request(app())
      .post('/api/v1/payments/order')
      .set('Cookie', user.cookie)
      .send({});

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('CSRF_ORIGIN_REJECTED');
    expect(await prisma.payment.count()).toBe(0);
  });

  it('allows a missing origin when there are no cookies to abuse', async () => {
    // curl or a server-to-server client: no ambient credentials, so it cannot
    // be a CSRF victim. It still has to get past authentication.
    const response = await request(app()).post(LOGIN_URL).send(CREDENTIALS);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('writes an audit entry when a request is blocked', async () => {
    await request(app())
      .post(LOGIN_URL)
      .set('Origin', 'https://evil.example.com')
      .send(CREDENTIALS);

    // The audit write is fire-and-forget; give the event loop a turn.
    await new Promise((resolve) => setTimeout(resolve, 150));

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'security.origin.rejected' },
    });
    expect(audit).not.toBeNull();
    expect(audit?.metadata).toMatchObject({ method: 'POST' });
  });

  it('does not apply to safe methods', async () => {
    const user = await createTestUser();

    // No Origin, cookies present, but GET changes nothing.
    const response = await request(app())
      .get('/api/v1/auth/me')
      .set('Cookie', user.cookie);

    expect(response.status).toBe(200);
  });

  it('skips the Razorpay webhook, which has no browser origin', async () => {
    resetRazorpayClient();
    const user = await createTestUser();
    await prisma.payment.create({
      data: {
        userId: user.id,
        razorpayOrderId: 'order_TESTorigin',
        purpose: 'BOOKING',
        amount: env.RENTAL_HOURLY_RATE_PAISE,
        status: 'CREATED',
      },
    });

    const body = JSON.stringify({
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_TESTorigin',
            order_id: 'order_TESTorigin',
            amount: env.RENTAL_HOURLY_RATE_PAISE,
          },
        },
      },
    });

    // No Origin header at all — exactly how Razorpay calls it.
    const response = await request(app())
      .post('/api/v1/payments/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', webhookSignature(body))
      .set('X-Razorpay-Event-Id', 'evt_origin_skip')
      .send(body);

    expect(response.status).toBe(200);

    const row = await prisma.payment.findUnique({
      where: { razorpayOrderId: 'order_TESTorigin' },
    });
    expect(row?.status).toBe('PAID');
  });

  it('rejects a cross-origin webhook-shaped request to a normal route', async () => {
    // Being exempt is a property of the webhook path only.
    const response = await request(app())
      .post(LOGIN_URL)
      .set('Origin', 'null')
      .send(CREDENTIALS);

    expect(response.status).toBe(403);
  });
});
