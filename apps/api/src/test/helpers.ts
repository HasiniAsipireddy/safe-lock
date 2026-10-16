import crypto from 'node:crypto';
import { vi } from 'vitest';
import type { Express } from 'express';
import { createApp, type CreateAppOptions } from '../app';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { ACCESS_COOKIE, REFRESH_COOKIE, signAccessToken } from '../modules/auth/tokens';
import { hashRefreshToken } from '../modules/auth/refreshToken.service';
import { hashPassword } from '../modules/auth/password';
import { allocateDevice } from '../modules/devices/device.service';

/**
 * Shared test helpers.
 *
 * Signatures here are computed with the real HMAC construction against the
 * test secrets — nothing about verification is stubbed out, only the network
 * call to Razorpay.
 */

/**
 * A fresh app per call.
 *
 * Rate limiters hold their counters in per-app memory, so a new app means
 * fresh counters — which is what keeps unrelated tests from exhausting each
 * other's quota. A test that needs to *exercise* a limit must hold on to one
 * app instance across its requests (see rateLimit.test.ts).
 *
 * Limits default high here so an incidental limiter never fails a test that
 * is asserting something else.
 */
export function app(options: CreateAppOptions = {}): Express {
  return createApp({
    rateLimits: {
      auth: { windowMs: 60_000, limit: 1000 },
      authIdentifier: { windowMs: 60_000, limit: 1000 },
      passwordForgot: { windowMs: 60_000, limit: 1000 },
      passwordForgotIdentifier: { windowMs: 60_000, limit: 1000 },
      passwordReset: { windowMs: 60_000, limit: 1000 },
      passwordChange: { windowMs: 60_000, limit: 1000 },
      profileUpdate: { windowMs: 60_000, limit: 1000 },
      createOrder: { windowMs: 60_000, limit: 1000 },
      verifyPayment: { windowMs: 60_000, limit: 1000 },
      adminWrite: { windowMs: 60_000, limit: 1000 },
      deviceLock: { windowMs: 60_000, limit: 1000 },
      unlockRequest: { windowMs: 60_000, limit: 1000 },
      unlockRequestIp: { windowMs: 60_000, limit: 1000 },
      unlockConfirm: { windowMs: 60_000, limit: 1000 },
      deviceHistory: { windowMs: 60_000, limit: 1000 },
      notifications: { windowMs: 60_000, limit: 1000 },
      ...options.rateLimits,
    },
  });
}

/**
 * The Origin a browser on the allowed web app would send. `originCheck`
 * rejects a state-changing request that arrives without one while carrying
 * cookies, so every POST in the suite sets it — as a real client would.
 */
export const TEST_ORIGIN = 'http://localhost:3000';

export interface TestUser {
  id: string;
  email: string;
  phone: string;
  /** Ready-to-send Cookie header value carrying a valid access token. */
  cookie: string;
}

let userSequence = 0;

/**
 * Inserts a user directly and mints a valid session cookie.
 *
 * Going through /auth/signup would work but pays argon2's cost on every test;
 * these tests are about payments, not password hashing.
 */
export async function createTestUser(
  overrides: { role?: 'USER' | 'ADMIN'; name?: string } = {},
): Promise<TestUser> {
  userSequence += 1;
  const email = `user${userSequence}.${Date.now()}@example.com`;
  // Valid 10-digit Indian mobile, unique per user.
  const phone = `9${String(100000000 + userSequence).slice(0, 9)}`;

  const user = await prisma.user.create({
    data: {
      name: overrides.name ?? `Test User ${userSequence}`,
      email,
      phone,
      // Never verified in these tests; a syntactically valid argon2 hash.
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FmZWxvY2t0ZXN0c2FsdA$dGVzdGhhc2hwbGFjZWhvbGRlcg',
      role: overrides.role ?? 'USER',
    },
    select: { id: true, email: true, phone: true, role: true },
  });

  const token = signAccessToken({ sub: user.id, role: user.role });

  return { id: user.id, email: user.email, phone: user.phone, cookie: `${ACCESS_COOKIE}=${token}` };
}

// --- Refresh token helpers ---------------------------------------------------

/**
 * Inserts a refresh token row with a known raw value.
 *
 * Lets a test construct states the API would otherwise take days to reach —
 * an expired token, an already-revoked one — without sleeping.
 */
export async function seedRefreshToken(params: {
  userId: string;
  rawToken?: string;
  familyId?: string;
  expiresAt?: Date;
  revokedAt?: Date | null;
  graceUsedAt?: Date | null;
}): Promise<{ rawToken: string; id: string; familyId: string }> {
  const rawToken = params.rawToken ?? `test_${crypto.randomBytes(24).toString('base64url')}`;
  const familyId = params.familyId ?? crypto.randomUUID();

  const row = await prisma.refreshToken.create({
    data: {
      userId: params.userId,
      tokenHash: hashRefreshToken(rawToken),
      familyId,
      expiresAt: params.expiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      revokedAt: params.revokedAt ?? null,
      graceUsedAt: params.graceUsedAt ?? null,
    },
    select: { id: true, familyId: true },
  });

  return { rawToken, id: row.id, familyId: row.familyId };
}

/** Builds the Cookie header value for a refresh request. */
export function refreshCookie(rawToken: string): string {
  return `${REFRESH_COOKIE}=${rawToken}`;
}

/** Pulls one cookie's full Set-Cookie string out of a response. */
export function setCookieFor(
  response: { headers: Record<string, unknown> },
  name: string,
): string | undefined {
  const raw = response.headers['set-cookie'];
  const list = Array.isArray(raw) ? (raw as string[]) : raw ? [String(raw)] : [];
  return list.find((cookie) => cookie.startsWith(`${name}=`));
}

/** Reads a cookie's value from a response's Set-Cookie headers. */
export function cookieValue(
  response: { headers: Record<string, unknown> },
  name: string,
): string | undefined {
  const header = setCookieFor(response, name);
  if (!header) return undefined;
  const value = header.slice(name.length + 1).split(';')[0];
  return value ? decodeURIComponent(value) : undefined;
}

/** An ADMIN user with a ready-to-send session cookie. */
export function createTestAdmin(): Promise<TestUser> {
  return createTestUser({ role: 'ADMIN', name: 'Test Admin' });
}

// --- Device helpers ----------------------------------------------------------

let deviceSequence = 0;

/** Adds an UNASSIGNED device to the inventory. */
export async function seedDevice(
  overrides: { serialNumber?: string; createdAt?: Date } = {},
): Promise<{ id: string; serialNumber: string }> {
  deviceSequence += 1;
  const serialNumber =
    overrides.serialNumber ?? `SAFE-${String(deviceSequence).padStart(4, '0')}`;

  return prisma.device.create({
    data: {
      serialNumber,
      ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
    },
    select: { id: true, serialNumber: true },
  });
}

/** Adds `count` devices, oldest first so allocation order is predictable. */
export async function seedDevices(count: number): Promise<Array<{ id: string; serialNumber: string }>> {
  const devices: Array<{ id: string; serialNumber: string }> = [];
  const base = Date.now() - count * 1000;

  for (let index = 0; index < count; index += 1) {
    devices.push(await seedDevice({ createdAt: new Date(base + index * 1000) }));
  }
  return devices;
}

/**
 * A paid user holding an allocated, locked safe — the state every lock/unlock
 * test starts from. Goes through the real `allocateDevice`, so the lock-state
 * transition it performs is exercised rather than bypassed.
 */
export async function createUserWithDevice(): Promise<{
  user: TestUser;
  deviceId: string;
  serialNumber: string;
}> {
  const user = await createTestUser();
  await givePaidPayment(user.id);
  const device = await seedDevice();
  await allocateDevice(user.id, device.id);

  return { user, deviceId: device.id, serialNumber: device.serialNumber };
}

// --- Device events / notifications -------------------------------------------

/**
 * Inserts a `DeviceEvent` with a caller-chosen timestamp.
 *
 * `createdAt` is settable because the history page's pagination is defined by
 * the ordering of these rows, and the interesting cases — several events in
 * the same millisecond, a page boundary falling between them — cannot be
 * produced by making real requests fast enough.
 */
export async function seedDeviceEvent(input: {
  userId: string;
  deviceId: string;
  type?: 'LOCK' | 'UNLOCK_REQUESTED' | 'UNLOCK_CONFIRMED' | 'UNLOCK_FAILED';
  failureReason?: 'WRONG_CODE' | 'EXPIRED' | 'TOO_MANY_ATTEMPTS' | 'NO_CHALLENGE' | null;
  createdAt?: Date;
  requestId?: string | null;
}): Promise<{ id: string; createdAt: Date }> {
  return prisma.deviceEvent.create({
    data: {
      userId: input.userId,
      deviceId: input.deviceId,
      type: input.type ?? 'LOCK',
      source: 'WEB',
      failureReason: input.failureReason ?? null,
      requestId: input.requestId ?? null,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    },
    select: { id: true, createdAt: true },
  });
}

/**
 * Inserts `count` events for one user, newest last, one second apart.
 *
 * Returns them in insertion order (oldest first), so a test can assert against
 * the reverse of this list — which is what the API should return.
 */
export async function seedDeviceEvents(
  input: { userId: string; deviceId: string; count: number; startedAt?: Date },
): Promise<Array<{ id: string; createdAt: Date }>> {
  const base = (input.startedAt ?? new Date(Date.now() - input.count * 1000)).getTime();
  const events: Array<{ id: string; createdAt: Date }> = [];

  for (let index = 0; index < input.count; index += 1) {
    events.push(
      await seedDeviceEvent({
        userId: input.userId,
        deviceId: input.deviceId,
        createdAt: new Date(base + index * 1000),
      }),
    );
  }
  return events;
}

/** Inserts an unread notification. */
export async function seedNotification(input: {
  userId: string;
  type?: 'UNLOCK_CONFIRMED' | 'UNLOCK_FAILED_MAX_ATTEMPTS';
  deviceEventId?: string | null;
  createdAt?: Date;
  readAt?: Date | null;
}): Promise<{ id: string }> {
  return prisma.notification.create({
    data: {
      userId: input.userId,
      type: input.type ?? 'UNLOCK_CONFIRMED',
      deviceEventId: input.deviceEventId ?? null,
      readAt: input.readAt ?? null,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    },
    select: { id: true },
  });
}

/** Marks a user's payment PAID the way a settled payment would look. */
export async function givePaidPayment(userId: string): Promise<{ id: string; orderId: string }> {
  const orderId = `order_PAID${crypto.randomBytes(6).toString('hex')}`;
  const payment = await prisma.payment.create({
    data: {
      userId,
      razorpayOrderId: orderId,
      razorpayPaymentId: `pay_PAID${crypto.randomBytes(6).toString('hex')}`,
      amount: env.SAFE_PRICE_PAISE,
      currency: 'INR',
      status: 'PAID',
      paidAt: new Date(),
    },
    select: { id: true },
  });
  return { id: payment.id, orderId };
}

// --- OTP capture -------------------------------------------------------------

/**
 * Runs something that sends an unlock code and returns the code.
 *
 * The code is read back off the dev console line, which means these tests
 * exercise the **real** delivery path rather than reaching into the service.
 * Nothing else can recover it: only the HMAC is stored.
 *
 * It also means a test fails loudly if the console print is ever removed or
 * accidentally gated off in the test environment.
 */
export async function withCapturedOtp<T>(
  run: () => Promise<T>,
): Promise<{ result: T; code: string; lines: string[] }> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });

  let result: T;
  try {
    result = await run();
  } finally {
    spy.mockRestore();
  }

  const match = lines.join('\n').match(/Unlock code for \S+: (\d{6})/);
  if (!match?.[1]) {
    throw new Error(`No unlock code was printed. Console output:\n${lines.join('\n')}`);
  }

  return { result, code: match[1], lines };
}

/**
 * Runs something that mints a password reset token and returns the token.
 *
 * Read back off the dev console line, exactly like {@link withCapturedOtp} and
 * for the same reasons: it exercises the **real** delivery path rather than
 * reaching into the service, nothing else can recover the value (only the
 * SHA-256 is stored), and a test fails loudly if the print is ever removed or
 * accidentally gated off in the test environment.
 */
export async function withCapturedResetToken<T>(
  run: () => Promise<T>,
): Promise<{ result: T; token: string; lines: string[] }> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });

  let result: T;
  try {
    result = await run();
  } finally {
    spy.mockRestore();
  }

  const match = lines.join('\n').match(/Password reset token: ([A-Za-z0-9_-]+)/);
  if (!match?.[1]) {
    throw new Error(`No reset token was printed. Console output:\n${lines.join('\n')}`);
  }

  return { result, token: match[1], lines };
}

/**
 * A user with a known password, created through the real hashing path.
 *
 * {@link createTestUser} plants a placeholder hash that no password verifies
 * against, which is fine for tests that never sign in — but change-password
 * and reset both have to *verify* a password, so they need the real thing.
 */
export async function createTestUserWithPassword(
  password: string,
): Promise<TestUser & { password: string }> {
  userSequence += 1;
  const email = `pw${userSequence}.${Date.now()}@example.com`;
  const phone = `9${String(200000000 + userSequence).slice(0, 9)}`;

  const user = await prisma.user.create({
    data: {
      name: `Password User ${userSequence}`,
      email,
      phone,
      passwordHash: await hashPassword(password),
    },
    select: { id: true, email: true, phone: true, role: true },
  });

  const token = signAccessToken({ sub: user.id, role: user.role });

  return {
    id: user.id,
    email: user.email,
    phone: user.phone,
    cookie: `${ACCESS_COOKIE}=${token}`,
    password,
  };
}

// --- Signatures (computed for real, with the test secrets) -------------------

/** The signature Razorpay Checkout would return for this order/payment pair. */
export function checkoutSignature(orderId: string, paymentId: string): string {
  return crypto
    .createHmac('sha256', env.RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
}

/** The signature Razorpay would put in X-Razorpay-Signature for this body. */
export function webhookSignature(rawBody: string): string {
  return crypto
    .createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
}

/** A syntactically valid but wrong 64-char hex signature. */
export const BAD_SIGNATURE = 'f'.repeat(64);

// --- Webhook payload builders ------------------------------------------------

export function paymentCapturedBody(params: {
  orderId: string;
  paymentId: string;
  amount: number;
}): string {
  return JSON.stringify({
    entity: 'event',
    account_id: 'acc_test',
    event: 'payment.captured',
    contains: ['payment'],
    payload: {
      payment: {
        entity: {
          id: params.paymentId,
          entity: 'payment',
          amount: params.amount,
          currency: 'INR',
          status: 'captured',
          order_id: params.orderId,
          method: 'card',
          captured: true,
        },
      },
    },
    created_at: Math.floor(Date.now() / 1000),
  });
}

export function paymentFailedBody(params: {
  orderId: string;
  paymentId: string;
  amount: number;
}): string {
  return JSON.stringify({
    entity: 'event',
    event: 'payment.failed',
    contains: ['payment'],
    payload: {
      payment: {
        entity: {
          id: params.paymentId,
          entity: 'payment',
          amount: params.amount,
          currency: 'INR',
          status: 'failed',
          order_id: params.orderId,
          error_code: 'BAD_REQUEST_ERROR',
          error_description: 'Payment failed because of insufficient funds',
          error_reason: 'payment_failed',
        },
      },
    },
    created_at: Math.floor(Date.now() / 1000),
  });
}

export function refundProcessedBody(params: {
  paymentId: string;
  amount: number;
  orderId?: string;
}): string {
  return JSON.stringify({
    entity: 'event',
    event: 'refund.processed',
    contains: ['refund', 'payment'],
    payload: {
      refund: {
        entity: {
          id: `rfnd_${crypto.randomBytes(6).toString('hex')}`,
          entity: 'refund',
          amount: params.amount,
          currency: 'INR',
          payment_id: params.paymentId,
          status: 'processed',
        },
      },
      payment: {
        entity: {
          id: params.paymentId,
          entity: 'payment',
          amount: params.amount,
          currency: 'INR',
          status: 'refunded',
          ...(params.orderId ? { order_id: params.orderId } : {}),
        },
      },
    },
    created_at: Math.floor(Date.now() / 1000),
  });
}
