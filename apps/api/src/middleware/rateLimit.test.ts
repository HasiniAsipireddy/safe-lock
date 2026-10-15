import type { Express } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import { TEST_ORIGIN, createTestUser } from '../test/helpers';
import { hashIdentifier, type RateLimitConfig } from './rateLimit';

/**
 * Rate limiter behaviour.
 *
 * These tests build **one** app and reuse it across requests: limiter counters
 * live in per-app memory, so a fresh app per request (what the shared `app()`
 * helper gives) would reset the count every time and nothing would ever 429.
 * That is also why the limiters are no longer skipped under NODE_ENV=test —
 * a disabled limiter is one nobody has seen work.
 */

const LOGIN_URL = '/api/v1/auth/login';
const SIGNUP_URL = '/api/v1/auth/signup';

function appWithLimits(overrides: Partial<RateLimitConfig>): Express {
  return createApp({
    rateLimits: {
      auth: { windowMs: 60_000, limit: 1000 },
      authIdentifier: { windowMs: 60_000, limit: 1000 },
      createOrder: { windowMs: 60_000, limit: 1000 },
      verifyPayment: { windowMs: 60_000, limit: 1000 },
      ...overrides,
    },
  });
}

function login(instance: Express, identifier: string, password = 'WrongPassword1') {
  return request(instance)
    .post(LOGIN_URL)
    .set('Origin', TEST_ORIGIN)
    .send({ identifier, password });
}

describe('per-identifier rate limiter', () => {
  let instance: Express;

  beforeEach(() => {
    instance = appWithLimits({ authIdentifier: { windowMs: 60_000, limit: 2 } });
  });

  it('returns 429 once the identifier limit is exceeded', async () => {
    const identifier = 'target@example.com';

    const first = await login(instance, identifier);
    const second = await login(instance, identifier);
    const third = await login(instance, identifier);

    expect(first.status).toBe(401);
    expect(second.status).toBe(401);

    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe('RATE_LIMITED');
    expect(third.body.error.requestId).toBeTruthy();
  });

  it('counts per identifier, not globally — a different account is unaffected', async () => {
    await login(instance, 'first@example.com');
    await login(instance, 'first@example.com');
    expect((await login(instance, 'first@example.com')).status).toBe(429);

    // A different identifier still has its own quota.
    expect((await login(instance, 'second@example.com')).status).toBe(401);
  });

  it('treats differently-cased and padded identifiers as the same bucket', async () => {
    await login(instance, 'Case@Example.com');
    await login(instance, '  case@example.com  ');

    // Both landed in one bucket, so the third is blocked.
    expect((await login(instance, 'CASE@EXAMPLE.COM')).status).toBe(429);
  });

  it('returns an identical 429 whether or not the account exists', async () => {
    // A real account...
    const real = await createTestUser();
    const realApp = appWithLimits({ authIdentifier: { windowMs: 60_000, limit: 1 } });
    await login(realApp, real.email);
    const realLimited = await login(realApp, real.email);

    // ...and one that does not exist.
    const fakeApp = appWithLimits({ authIdentifier: { windowMs: 60_000, limit: 1 } });
    await login(fakeApp, 'definitely-not-registered@example.com');
    const fakeLimited = await login(fakeApp, 'definitely-not-registered@example.com');

    expect(realLimited.status).toBe(429);
    expect(fakeLimited.status).toBe(429);

    // Byte-identical apart from the per-request correlation id: the endpoint
    // must not become an account-enumeration oracle.
    expect(realLimited.body.error.code).toBe(fakeLimited.body.error.code);
    expect(realLimited.body.error.message).toBe(fakeLimited.body.error.message);
    expect(Object.keys(realLimited.body.error).sort()).toEqual(
      Object.keys(fakeLimited.body.error).sort(),
    );
  });

  it('applies to signup as well', async () => {
    const limited = appWithLimits({ authIdentifier: { windowMs: 60_000, limit: 1 } });

    const body = {
      name: 'Rate Limited',
      email: 'ratelimit@example.com',
      phone: '9812345678',
      password: 'RateLimit1234',
    };

    const first = await request(limited)
      .post(SIGNUP_URL)
      .set('Origin', TEST_ORIGIN)
      .send(body);
    expect(first.status).toBe(201);

    const second = await request(limited)
      .post(SIGNUP_URL)
      .set('Origin', TEST_ORIGIN)
      .send({ ...body, email: 'ratelimit@example.com' });
    expect(second.status).toBe(429);
  });

  it('does not count a blocked attempt as a login failure in the audit log', async () => {
    const identifier = 'audit@example.com';
    await login(instance, identifier);
    await login(instance, identifier);
    await login(instance, identifier);

    // Two handler-reached failures, not three: the limiter short-circuits
    // before the controller runs.
    const failures = await prisma.auditLog.count({ where: { action: 'auth.login.failed' } });
    expect(failures).toBe(2);
  });
});

describe('per-IP rate limiter', () => {
  it('returns 429 once the IP limit is exceeded, across different identifiers', async () => {
    const instance = appWithLimits({ auth: { windowMs: 60_000, limit: 2 } });

    expect((await login(instance, 'one@example.com')).status).toBe(401);
    expect((await login(instance, 'two@example.com')).status).toBe(401);

    // Same IP, third distinct account: the per-identifier limb would not catch
    // this, which is exactly why the per-IP limb exists.
    const third = await login(instance, 'three@example.com');
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe('RATE_LIMITED');
  });
});

describe('hashIdentifier', () => {
  it('hashes rather than storing the identifier in the limiter key', () => {
    const hash = hashIdentifier('user@example.com');

    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain('user@example.com');
    // Stable, so the same identifier keeps hitting the same bucket.
    expect(hashIdentifier('user@example.com')).toBe(hash);
    expect(hashIdentifier('other@example.com')).not.toBe(hash);
  });
});
