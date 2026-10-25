import crypto from 'node:crypto';
import { vi } from 'vitest';
import type { Express } from 'express';
import {
  WHATSAPP_CONSENT_VERSION,
  bookingPricePaise,
  reservedUntilFrom,
  type SafeSize,
} from '@safelock/shared';
import { createApp, type CreateAppOptions } from '../app';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { ACCESS_COOKIE, REFRESH_COOKIE, signAccessToken } from '../modules/auth/tokens';
import { hashRefreshToken } from '../modules/auth/refreshToken.service';
import { hashPassword } from '../modules/auth/password';
import { currentRates } from '../modules/bookings/booking.service';
import {
  BOOKING_SELECT,
  snapshotOf,
  type BookingRow,
} from '../modules/bookings/booking.mapper';

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
      passwordForgotInterval: { windowMs: 60_000, limit: 1000 },
      passwordReset: { windowMs: 60_000, limit: 1000 },
      passwordResetIdentifier: { windowMs: 60_000, limit: 1000 },
      passwordChange: { windowMs: 60_000, limit: 1000 },
      profileUpdate: { windowMs: 60_000, limit: 1000 },
      phoneVerify: { windowMs: 60_000, limit: 1000 },
      phoneVerifyIp: { windowMs: 60_000, limit: 1000 },
      phoneConfirm: { windowMs: 60_000, limit: 1000 },
      bookingRead: { windowMs: 60_000, limit: 1000 },
      bookingWrite: { windowMs: 60_000, limit: 1000 },
      createOrder: { windowMs: 60_000, limit: 1000 },
      verifyPayment: { windowMs: 60_000, limit: 1000 },
      adminWrite: { windowMs: 60_000, limit: 1000 },
      deviceLock: { windowMs: 60_000, limit: 1000 },
      unlockRequest: { windowMs: 60_000, limit: 1000 },
      unlockRequestIp: { windowMs: 60_000, limit: 1000 },
      unlockConfirm: { windowMs: 60_000, limit: 1000 },
      deviceHistory: { windowMs: 60_000, limit: 1000 },
      notifications: { windowMs: 60_000, limit: 1000 },
      whatsAppWebhook: { windowMs: 60_000, limit: 1000 },
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

/**
 * Adds an AVAILABLE device to the inventory, **online and provisioned**.
 *
 * Online by default because that is the normal state of a rentable safe, and
 * because the API now refuses to issue a command to one it cannot reach and
 * excludes it from the booking pick. A helper that seeded offline devices
 * would make the offline path the default every test exercised without
 * meaning to, and the refusals it produces look like unrelated failures.
 *
 * `lastSeenAt` is stamped **now**, not at `createdAt`: liveness is derived from
 * the age of the last message, so a device backdated for the booking pick's
 * oldest-first ordering must not also be backdated into looking dead.
 *
 * Pass `{ online: false }` to build the state that must be refused.
 */
export async function seedDevice(
  overrides: {
    serialNumber?: string;
    createdAt?: Date;
    online?: boolean;
    lastSeenAt?: Date | null;
    doorState?: 'CLOSED' | 'OPEN' | 'UNKNOWN';
    /** Defaults to MEDIUM, matching the column default and the backfill. */
    size?: SafeSize;
  } = {},
): Promise<{ id: string; serialNumber: string; size: SafeSize }> {
  deviceSequence += 1;
  const serialNumber =
    overrides.serialNumber ?? `SAFE-${String(deviceSequence).padStart(4, '0')}`;

  const online = overrides.online ?? true;

  return prisma.device.create({
    data: {
      serialNumber,
      online,
      lastSeenAt:
        overrides.lastSeenAt !== undefined
          ? overrides.lastSeenAt
          : online
            ? new Date()
            : null,
      doorState: overrides.doorState ?? 'CLOSED',
      size: overrides.size ?? 'MEDIUM',
      // A device that has been provisioned, since every command is signed with
      // a key derived for it. The hash is of nothing in particular: no test
      // authenticates to a broker.
      credentialIssuedAt: new Date(),
      ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
    },
    select: { id: true, serialNumber: true, size: true },
  });
}

/** Adds `count` devices, oldest first so the booking pick order is predictable. */
export async function seedDevices(
  count: number,
  overrides: { size?: SafeSize } = {},
): Promise<Array<{ id: string; serialNumber: string; size: SafeSize }>> {
  const devices: Array<{ id: string; serialNumber: string; size: SafeSize }> = [];
  const base = Date.now() - count * 1000;

  for (let index = 0; index < count; index += 1) {
    devices.push(
      await seedDevice({ createdAt: new Date(base + index * 1000), ...overrides }),
    );
  }
  return devices;
}

/**
 * Marks a user's phone verified and records WhatsApp consent.
 *
 * Required before any message can be sent to them — including an unlock code —
 * so most lock/unlock tests need it. Separate from {@link createTestUser} so a
 * test can deliberately construct the *unverified* state and assert it is
 * refused.
 */
export async function verifyUserPhone(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: {
      phoneVerifiedAt: new Date(),
      whatsappConsentAt: new Date(),
      whatsappConsentVersion: WHATSAPP_CONSENT_VERSION,
    },
  });
}

/**
 * A user with a verified phone holding an **ACTIVE booking** on a locked safe —
 * the state every lock/unlock test starts from.
 *
 * Goes through {@link seedBooking}, which writes the row the real flow would
 * write, rate snapshot included. The phone is verified here because unlocking
 * requires it: the one-time code has to have somewhere to go. Pass
 * `{ phoneVerified: false }` to build the state that must be refused.
 */
export async function createUserWithDevice(
  options: { phoneVerified?: boolean; hours?: number; size?: SafeSize } = {},
): Promise<{
  user: TestUser;
  deviceId: string;
  serialNumber: string;
  bookingId: string;
  size: SafeSize;
}> {
  const user = await createTestUser();
  if (options.phoneVerified !== false) await verifyUserPhone(user.id);
  const size = options.size ?? 'MEDIUM';
  const device = await seedDevice({ size });

  // The booking's snapshotted size matches the cabinet it is in, which is what
  // the service guarantees. A test that wants them to disagree — an admin
  // reclassifying mid-rental — sets them apart explicitly.
  const booking = await seedBooking({
    userId: user.id,
    deviceId: device.id,
    status: 'ACTIVE',
    hours: options.hours ?? 2,
    safeSize: size,
  });

  return {
    user,
    deviceId: device.id,
    serialNumber: device.serialNumber,
    bookingId: booking.id,
    size,
  };
}

/**
 * The device a user currently holds, read through their live booking.
 *
 * Replaces `findUniqueOrThrow({ where: { ownerId } })`, which no longer has a
 * column to look at. Throws if they hold nothing, which is what a test
 * asserting against "their safe" wants.
 */
export async function deviceHeldBy(userId: string): Promise<{
  id: string;
  serialNumber: string;
  lockState: 'LOCKED' | 'UNLOCKED' | 'UNKNOWN';
  lockStateUpdatedAt: Date | null;
}> {
  const booking = await prisma.booking.findFirstOrThrow({
    where: { userId, completedAt: null },
    orderBy: { createdAt: 'desc' },
    select: { deviceId: true },
  });

  return prisma.device.findUniqueOrThrow({
    where: { id: booking.deviceId },
    select: { id: true, serialNumber: true, lockState: true, lockStateUpdatedAt: true },
  });
}

// --- Booking helpers ---------------------------------------------------------

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_MINUTE = 60 * 1000;

export type SeedBookingStatus =
  | 'PENDING_PAYMENT'
  | 'ACTIVE'
  | 'OVERSTAY'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'EXPIRED_UNPAID';

/**
 * Inserts a `Booking` row in a chosen state at a chosen point in time.
 *
 * Every timestamp is settable, and that is the point: an overstay, a lapsed
 * hold and a closed collection window are all **clock** states, and the suite
 * has to construct them without sleeping. Where the real flow computes
 * `endsAt` and `reservedUntil`, this runs the same shared helpers rather than
 * hardcoding offsets — so a change to the turnaround rule reaches the fixtures
 * too instead of silently diverging from them.
 *
 * The rate snapshot defaults to the live config, which is what a booking
 * created right now would carry.
 */
export async function seedBooking(input: {
  userId: string;
  deviceId: string;
  status?: SeedBookingStatus;
  hours?: number;
  /** When the booking started. Defaults to now. */
  startsAt?: Date;
  /** Overrides the computed `startsAt + hours`. */
  endsAt?: Date | null;
  holdExpiresAt?: Date | null;
  reservedUntil?: Date;
  overstaySettledAt?: Date | null;
  overstayWaivedAt?: Date | null;
  completedAt?: Date | null;
  completionReason?: 'COLLECTED' | 'COLLECTION_WINDOW_LAPSED' | 'ADMIN_FORCE_COMPLETED' | null;
  /**
   * The size booked. Defaults to MEDIUM, which is what every device defaults
   * to — so a test that does not care about sizes gets a booking whose size
   * matches its safe, and the old flat rate.
   */
  safeSize?: SafeSize;
  rates?: Partial<ReturnType<typeof currentRates>>;
}): Promise<{ id: string; endsAt: Date | null; reservedUntil: Date }> {
  const safeSize = input.safeSize ?? 'MEDIUM';
  const rates = { ...currentRates(safeSize), ...input.rates };
  const status = input.status ?? 'ACTIVE';
  const hours = input.hours ?? 2;
  const startsAt = input.startsAt ?? new Date();

  // `endsAt` is null until a payment lands, exactly as the service leaves it.
  const paid = status !== 'PENDING_PAYMENT' && status !== 'EXPIRED_UNPAID';
  const endsAt =
    input.endsAt !== undefined
      ? input.endsAt
      : paid
        ? new Date(startsAt.getTime() + hours * MS_PER_HOUR)
        : null;

  // Terminal rows leave the exclusion constraint, so their reservation
  // collapses; live ones must still cover grace plus the collection window.
  const terminal = status === 'COMPLETED' || status === 'CANCELLED' || status === 'EXPIRED_UNPAID';
  const reservedUntil =
    input.reservedUntil ??
    (terminal
      ? startsAt
      : reservedUntilFrom(rates, endsAt ?? new Date(startsAt.getTime() + hours * MS_PER_HOUR)));

  const holdExpiresAt =
    input.holdExpiresAt !== undefined
      ? input.holdExpiresAt
      : status === 'PENDING_PAYMENT'
        ? new Date(startsAt.getTime() + env.BOOKING_HOLD_MINUTES * MS_PER_MINUTE)
        : null;

  return prisma.booking.create({
    data: {
      userId: input.userId,
      deviceId: input.deviceId,
      status,
      hours,
      startsAt,
      endsAt,
      holdExpiresAt,
      reservedUntil,
      pricePaise: bookingPricePaise(rates, hours),
      currency: rates.currency,
      safeSize,
      hourlyRatePaise: rates.hourlyRatePaise,
      overstayMultiplierBps: rates.overstayMultiplierBps,
      graceMinutes: rates.graceMinutes,
      capHours: rates.capHours,
      collectionWindowMinutes: rates.collectionWindowMinutes,
      overstaySettledAt: input.overstaySettledAt ?? null,
      overstayWaivedAt: input.overstayWaivedAt ?? null,
      completedAt: input.completedAt ?? (terminal ? startsAt : null),
      completionReason: input.completionReason ?? null,
    },
    select: { id: true, endsAt: true, reservedUntil: true },
  });
}

/**
 * Pushes a live booking into overstay by moving its window into the past.
 *
 * A **direct row edit**, deliberately. The alternative is faking the clock,
 * and the services read the real time in several places that a partial fake
 * would desynchronise — including Postgres, for the exclusion constraint.
 * Moving `endsAt` back produces exactly the state the sweeper would observe an
 * hour from now, without waiting an hour for it.
 *
 * `hoursOver` is the number of **chargeable hours accrued**, which is not the
 * same as hours elapsed: overstay is billed per *started* hour, so one second
 * past the grace period already costs an hour. Landing the clock exactly on a
 * boundary would make every caller a coin flip between n and n+1, so this aims
 * one minute into the `hoursOver`-th hour — `hoursOver = 2` means "two hours
 * are owed", unambiguously.
 *
 * `reservedUntil` is pulled back with `endsAt`, because that is the state a
 * real booking would be in: the reservation is derived from the end, and the
 * sweeper pushing it back out is precisely the behaviour under test.
 */
export async function pushIntoOverstay(
  bookingId: string,
  hoursOver = 1,
): Promise<{ endsAt: Date }> {
  const row = await prisma.booking.findUniqueOrThrow({
    where: { id: bookingId },
    select: BOOKING_SELECT,
  });

  const booking = row as BookingRow;
  const elapsedIntoOverstayMs = (hoursOver - 1) * MS_PER_HOUR + MS_PER_MINUTE;

  const endsAt = new Date(
    Date.now() - booking.graceMinutes * MS_PER_MINUTE - elapsedIntoOverstayMs,
  );

  await prisma.booking.update({
    where: { id: bookingId },
    data: {
      endsAt,
      startsAt: new Date(endsAt.getTime() - booking.hours * MS_PER_HOUR),
      reservedUntil: reservedUntilFrom(snapshotOf(booking), endsAt),
    },
  });

  return { endsAt };
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

/**
 * Inserts a `Payment` row for a booking, in a chosen state.
 *
 * Every payment belongs to a booking now and `purpose` is NOT NULL, so there
 * is no account-level "this user has paid" fixture to seed any more — which is
 * the whole shape of the change: eligibility comes from a booking, not a flag.
 */
export async function seedPayment(input: {
  userId: string;
  bookingId?: string | null;
  purpose?: 'BOOKING' | 'EXTENSION' | 'OVERSTAY';
  amount: number;
  status?: 'CREATED' | 'PAID' | 'FAILED' | 'REFUNDED';
  quoteExpiresAt?: Date | null;
  reviewReason?:
    | 'BOOKING_EXPIRED_DEVICE_TAKEN'
    | 'OVERSTAY_QUOTE_EXPIRED'
    | 'BOOKING_NO_LONGER_PAYABLE'
    | null;
}): Promise<{ id: string; orderId: string; paymentId: string }> {
  const orderId = `order_${crypto.randomBytes(8).toString('hex')}`;
  const paymentId = `pay_${crypto.randomBytes(8).toString('hex')}`;
  const status = input.status ?? 'CREATED';
  const settled = status === 'PAID' || status === 'REFUNDED';

  const row = await prisma.payment.create({
    data: {
      userId: input.userId,
      bookingId: input.bookingId ?? null,
      purpose: input.purpose ?? 'BOOKING',
      razorpayOrderId: orderId,
      ...(settled ? { razorpayPaymentId: paymentId } : {}),
      amount: input.amount,
      currency: 'INR',
      status,
      paidAt: settled ? new Date() : null,
      quoteExpiresAt: input.quoteExpiresAt ?? null,
      reviewReason: input.reviewReason ?? null,
    },
    select: { id: true },
  });

  return { id: row.id, orderId, paymentId };
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
 * Runs something that mints a password reset code and returns the code.
 *
 * Read back off the dev console line, exactly like {@link withCapturedOtp} and
 * for the same reasons: it exercises the **real** issue-and-deliver path rather
 * than reaching into the service, nothing else can recover the value (only the
 * HMAC is stored), and a test fails loudly if the print is ever removed or
 * accidentally gated off in the test environment.
 */
export async function withCapturedResetCode<T>(
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

  const match = lines.join('\n').match(/Password reset code: (\d{8})/);
  if (!match?.[1]) {
    throw new Error(`No reset code was printed. Console output:\n${lines.join('\n')}`);
  }

  return { result, code: match[1], lines };
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
