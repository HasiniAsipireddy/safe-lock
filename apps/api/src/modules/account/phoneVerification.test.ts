import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import {
  PHONE_OTP_MAX_ATTEMPTS,
  PHONE_OTP_TTL_MS,
  WHATSAPP_CONSENT_VERSION,
} from '@safelock/shared';
import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { fakeWhatsAppClient } from '../../lib/whatsapp';
import {
  TEST_ORIGIN,
  app,
  createTestUser,
  createTestUserWithPassword,
  createUserWithDevice,
  verifyUserPhone,
} from '../../test/helpers';
import { hashOtp } from '../devices/otp.service';

/**
 * Phone verification.
 *
 * Codes are read back off the dev console line, like the unlock OTP's, so
 * these tests exercise the real issue-and-deliver path — only the HMAC is
 * stored, so nothing else can recover a code.
 */

const REQUEST_URL = '/api/v1/account/phone/request-verification';
const CONFIRM_URL = '/api/v1/account/phone/confirm';
const UNLOCK_REQUEST_URL = '/api/v1/devices/unlock/request';
const LOCK_URL = '/api/v1/devices/lock';

const fake = fakeWhatsAppClient()!;

function post(url: string, cookie?: string, instance = app()) {
  const req = request(instance).post(url).set('Origin', TEST_ORIGIN);
  return cookie ? req.set('Cookie', cookie) : req;
}

/** Runs something that issues a verification code and returns the code. */
async function withCode<T>(run: () => Promise<T>): Promise<{ result: T; code: string }> {
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

  const match = lines.join('\n').match(/Phone verification code for \S+ \S+: (\d{6})/);
  if (!match?.[1]) {
    throw new Error(`No verification code printed. Output:\n${lines.join('\n')}`);
  }
  return { result, code: match[1] };
}

const NEW_PHONE = '9123456780';

describe('POST /account/phone/request-verification', () => {
  it('sends a code to the candidate number and returns it masked', async () => {
    const user = await createTestUser();
    fake.reset();

    const { result, code } = await withCode(() =>
      post(REQUEST_URL, user.cookie).send({ phone: NEW_PHONE, consent: true }),
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      maskedPhone: '+91 91****80',
      attemptsAllowed: PHONE_OTP_MAX_ATTEMPTS,
      expiresInSeconds: Math.round(PHONE_OTP_TTL_MS / 1000),
    });
    // The code itself is never in the response.
    expect(JSON.stringify(result.body)).not.toContain(code);

    expect(fake.sent()).toHaveLength(1);
    expect(fake.last()).toMatchObject({
      to: `+91${NEW_PHONE}`,
      templateName: env.WHATSAPP_TEMPLATE_PHONE_OTP,
      params: [code],
    });
  });

  it('stores only an HMAC of the code, against the candidate number', async () => {
    const user = await createTestUser();
    const { code } = await withCode(() =>
      post(REQUEST_URL, user.cookie).send({ phone: NEW_PHONE, consent: true }),
    );

    const row = await prisma.phoneVerification.findFirstOrThrow({
      where: { userId: user.id },
    });
    expect(row.otpHash).toBe(hashOtp(code));
    expect(row.otpHash).not.toContain(code);
    expect(row.phoneE164).toBe(`+91${NEW_PHONE}`);
  });

  it('leaves User.phone untouched until the code is confirmed', async () => {
    const user = await createTestUser();
    await withCode(() => post(REQUEST_URL, user.cookie).send({ phone: NEW_PHONE, consent: true }));

    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.phone).toBe(user.phone);
    expect(row.phoneVerifiedAt).toBeNull();
  });

  it('normalises whatever format the user typed', async () => {
    const user = await createTestUser();
    fake.reset();

    await withCode(() =>
      post(REQUEST_URL, user.cookie).send({ phone: '+91 91234 56780', consent: true }),
    );

    expect(fake.last()!.to).toBe(`+91${NEW_PHONE}`);
  });

  it('rejects a number that is not an Indian mobile', async () => {
    const user = await createTestUser();

    for (const phone of ['12345', '+14155552671', 'nope']) {
      const response = await post(REQUEST_URL, user.cookie).send({ phone, consent: true });
      expect(response.status, phone).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('requires a session', async () => {
    const response = await post(REQUEST_URL).send({ phone: NEW_PHONE, consent: true });
    expect(response.status).toBe(401);
  });

  it('rejects extra fields', async () => {
    const user = await createTestUser();
    const response = await post(REQUEST_URL, user.cookie).send({
      phone: NEW_PHONE,
      consent: true,
      phoneVerifiedAt: new Date().toISOString(),
    });
    expect(response.status).toBe(400);
  });
});

// --- Consent -----------------------------------------------------------------

describe('WhatsApp consent', () => {
  /** Meta requires an explicit opt-in before any business-initiated message. */
  it('sends nothing without consent', async () => {
    const user = await createTestUser();
    fake.reset();

    const response = await post(REQUEST_URL, user.cookie).send({
      phone: NEW_PHONE,
      consent: false,
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('CONSENT_REQUIRED');
    expect(fake.sent()).toHaveLength(0);
    // And no challenge was created, so nothing is left half-done.
    expect(await prisma.phoneVerification.count()).toBe(0);
  });

  it('records the consent text version that was agreed to', async () => {
    const user = await createTestUser();
    await withCode(() => post(REQUEST_URL, user.cookie).send({ phone: NEW_PHONE, consent: true }));

    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.whatsappConsentAt).toBeInstanceOf(Date);
    expect(row.whatsappConsentVersion).toBe(WHATSAPP_CONSENT_VERSION);
  });
});

// --- Uniqueness without enumeration ------------------------------------------

describe('a number owned by another account', () => {
  /**
   * The oracle this avoids: anyone could otherwise test whether a given mobile
   * has a Safe Lock account, and therefore probably a safe.
   */
  it('answers identically to a free number, and sends nothing', async () => {
    const owner = await createTestUser();
    await verifyUserPhone(owner.id);
    const caller = await createTestUser();
    fake.reset();

    // Taken: the owner's number.
    const taken = await post(REQUEST_URL, caller.cookie).send({
      phone: owner.phone,
      consent: true,
    });
    // Free: an unused number.
    const { result: free } = await withCode(() =>
      post(REQUEST_URL, caller.cookie).send({ phone: NEW_PHONE, consent: true }),
    );

    expect(taken.status).toBe(free.status);
    // Same keys, same shape — only the masked number and timestamps differ,
    // both of which are derived from the caller's own input.
    expect(Object.keys(taken.body).sort()).toEqual(Object.keys(free.body).sort());
    // Echoed back from what the caller submitted, so a typo is visible.
    expect(taken.body.maskedPhone).toBe(
      `+91 ${owner.phone.slice(0, 2)}****${owner.phone.slice(-2)}`,
    );

    // Nothing went to the number the caller does not own.
    expect(fake.sent().some((message) => message.to === `+91${owner.phone}`)).toBe(false);
  });

  it('creates no challenge for the taken number', async () => {
    const owner = await createTestUser();
    await verifyUserPhone(owner.id);
    const caller = await createTestUser();

    await post(REQUEST_URL, caller.cookie).send({ phone: owner.phone, consent: true });

    expect(await prisma.phoneVerification.count({ where: { userId: caller.id } })).toBe(0);
  });

  it('records the collision in the audit log, where it is safe to see', async () => {
    const owner = await createTestUser();
    await verifyUserPhone(owner.id);
    const caller = await createTestUser();

    await post(REQUEST_URL, caller.cookie).send({ phone: owner.phone, consent: true });

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { userId: caller.id, action: 'account.phone.verification_requested' },
    });
    expect(audit.metadata).toMatchObject({ collision: true, sent: false });
    // The number itself must not be in the row.
    expect(JSON.stringify(audit.metadata)).not.toContain(owner.phone);
  });

  it('allows re-verifying a number the caller already owns but has not verified', async () => {
    const user = await createTestUser();
    fake.reset();

    // Their own signup number, still unverified: not a collision.
    const { result } = await withCode(() =>
      post(REQUEST_URL, user.cookie).send({ phone: user.phone, consent: true }),
    );

    expect(result.status).toBe(200);
    expect(fake.sent()).toHaveLength(1);
  });
});

// --- Confirm -----------------------------------------------------------------

describe('POST /account/phone/confirm', () => {
  it('verifies the number and returns the updated user', async () => {
    const user = await createTestUser();
    const { code } = await withCode(() =>
      post(REQUEST_URL, user.cookie).send({ phone: NEW_PHONE, consent: true }),
    );

    const response = await post(CONFIRM_URL, user.cookie).send({ otp: code });

    expect(response.status).toBe(200);
    expect(response.body.user.phoneVerified).toBe(true);
    expect(response.body.user.phone).toBe(NEW_PHONE);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.phone).toBe(NEW_PHONE);
    expect(row.phoneVerifiedAt).toBeInstanceOf(Date);
  });

  it('is single-use', async () => {
    const user = await createTestUser();
    const { code } = await withCode(() =>
      post(REQUEST_URL, user.cookie).send({ phone: NEW_PHONE, consent: true }),
    );

    expect((await post(CONFIRM_URL, user.cookie).send({ otp: code })).status).toBe(200);

    const replay = await post(CONFIRM_URL, user.cookie).send({ otp: code });
    expect(replay.status).toBe(400);
    expect(replay.body.error.code).toBe('PHONE_VERIFICATION_NOT_FOUND');
  });

  it('rejects a wrong code and counts the attempt', async () => {
    const user = await createTestUser();
    await withCode(() => post(REQUEST_URL, user.cookie).send({ phone: NEW_PHONE, consent: true }));

    const response = await post(CONFIRM_URL, user.cookie).send({ otp: '000000' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('PHONE_VERIFICATION_INVALID');
    expect(response.body.error.message).toMatch(/4 attempts left/);

    const row = await prisma.phoneVerification.findFirstOrThrow({
      where: { userId: user.id },
    });
    expect(row.attempts).toBe(1);
    expect(row.consumedAt).toBeNull();
  });

  it('invalidates the challenge after the attempt limit', async () => {
    const user = await createTestUser();
    const { code } = await withCode(() =>
      post(REQUEST_URL, user.cookie).send({ phone: NEW_PHONE, consent: true }),
    );

    for (let attempt = 0; attempt < PHONE_OTP_MAX_ATTEMPTS - 1; attempt += 1) {
      await post(CONFIRM_URL, user.cookie).send({ otp: '000000' });
    }

    const last = await post(CONFIRM_URL, user.cookie).send({ otp: '000000' });
    expect(last.body.error.code).toBe('PHONE_VERIFICATION_TOO_MANY_ATTEMPTS');

    // Even the correct code is dead now.
    const correct = await post(CONFIRM_URL, user.cookie).send({ otp: code });
    expect(correct.status).toBe(400);
    expect(correct.body.error.code).toBe('PHONE_VERIFICATION_NOT_FOUND');

    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.phoneVerifiedAt).toBeNull();
  });

  it('refuses an expired code', async () => {
    const user = await createTestUser();
    const { code } = await withCode(() =>
      post(REQUEST_URL, user.cookie).send({ phone: NEW_PHONE, consent: true }),
    );
    await prisma.phoneVerification.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const response = await post(CONFIRM_URL, user.cookie).send({ otp: code });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('PHONE_VERIFICATION_EXPIRED');
  });

  it('answers when there is no challenge at all', async () => {
    const user = await createTestUser();

    const response = await post(CONFIRM_URL, user.cookie).send({ otp: '123456' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('PHONE_VERIFICATION_NOT_FOUND');
  });

  it('a new request supersedes the old code', async () => {
    const user = await createTestUser();
    const { code: first } = await withCode(() =>
      post(REQUEST_URL, user.cookie).send({ phone: NEW_PHONE, consent: true }),
    );
    const { code: second } = await withCode(() =>
      post(REQUEST_URL, user.cookie).send({ phone: NEW_PHONE, consent: true }),
    );
    expect(second).not.toBe(first);

    const stale = await post(CONFIRM_URL, user.cookie).send({ otp: first });
    expect(stale.status).toBe(400);

    const fresh = await post(CONFIRM_URL, user.cookie).send({ otp: second });
    expect(fresh.status).toBe(200);
  });

  it('rejects another user’s code', async () => {
    const mine = await createTestUser();
    const theirs = await createTestUser();
    const { code } = await withCode(() =>
      post(REQUEST_URL, theirs.cookie).send({ phone: NEW_PHONE, consent: true }),
    );

    const response = await post(CONFIRM_URL, mine.cookie).send({ otp: code });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('PHONE_VERIFICATION_NOT_FOUND');
  });
});

// --- Changing an already-verified number -------------------------------------

describe('changing a verified number', () => {
  it('requires the current password', async () => {
    const user = await createTestUserWithPassword('RightPassword1');
    await verifyUserPhone(user.id);
    fake.reset();

    const noPassword = await post(REQUEST_URL, user.cookie).send({
      phone: NEW_PHONE,
      consent: true,
    });
    expect(noPassword.status).toBe(400);
    expect(noPassword.body.error.code).toBe('PASSWORD_INCORRECT');

    const wrongPassword = await post(REQUEST_URL, user.cookie).send({
      phone: NEW_PHONE,
      consent: true,
      currentPassword: 'WrongPassword9',
    });
    expect(wrongPassword.status).toBe(400);

    expect(fake.sent()).toHaveLength(0);
  });

  it('does not require a password for a first verification', async () => {
    const user = await createTestUserWithPassword('RightPassword1');

    const { result } = await withCode(() =>
      post(REQUEST_URL, user.cookie).send({ phone: NEW_PHONE, consent: true }),
    );

    expect(result.status).toBe(200);
  });

  /**
   * The old number keeps working until the new one is proved. A change that is
   * started and abandoned must not leave the account unable to unlock.
   */
  it('keeps the old number active until the new one is confirmed', async () => {
    const user = await createTestUserWithPassword('RightPassword1');
    await verifyUserPhone(user.id);
    const originalPhone = user.phone;

    const { code } = await withCode(() =>
      post(REQUEST_URL, user.cookie).send({
        phone: NEW_PHONE,
        consent: true,
        currentPassword: 'RightPassword1',
      }),
    );

    // Mid-flow: still the old number, still verified.
    let row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.phone).toBe(originalPhone);
    expect(row.phoneVerifiedAt).toBeInstanceOf(Date);

    await post(CONFIRM_URL, user.cookie).send({ otp: code });

    row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.phone).toBe(NEW_PHONE);
    expect(row.phoneVerifiedAt).toBeInstanceOf(Date);
  });

  it('leaves the account untouched if the change is abandoned', async () => {
    const user = await createTestUserWithPassword('RightPassword1');
    await verifyUserPhone(user.id);

    await withCode(() =>
      post(REQUEST_URL, user.cookie).send({
        phone: NEW_PHONE,
        consent: true,
        currentPassword: 'RightPassword1',
      }),
    );
    // No confirm. The challenge simply expires.

    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.phone).toBe(user.phone);
    expect(row.phoneVerifiedAt).toBeInstanceOf(Date);
  });

  it('refuses re-verifying the number that is already verified', async () => {
    const user = await createTestUserWithPassword('RightPassword1');
    await verifyUserPhone(user.id);

    const response = await post(REQUEST_URL, user.cookie).send({
      phone: user.phone,
      consent: true,
      currentPassword: 'RightPassword1',
    });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('PHONE_ALREADY_VERIFIED');
  });

  it('revokes no sessions', async () => {
    const user = await createTestUserWithPassword('RightPassword1');
    await verifyUserPhone(user.id);

    const { code } = await withCode(() =>
      post(REQUEST_URL, user.cookie).send({
        phone: NEW_PHONE,
        consent: true,
        currentPassword: 'RightPassword1',
      }),
    );
    await post(CONFIRM_URL, user.cookie).send({ otp: code });

    // Changing a number is not a credential rotation — unlike a password
    // change, it leaves other sessions alone.
    expect(await prisma.refreshToken.count({ where: { userId: user.id, revokedAt: { not: null } } })).toBe(0);
  });
});

// --- The unlock gate ---------------------------------------------------------

describe('PHONE_NOT_VERIFIED gates unlock only', () => {
  it('refuses an unlock request from an unverified user', async () => {
    const { user } = await createUserWithDevice({ phoneVerified: false });

    const response = await post(UNLOCK_REQUEST_URL, user.cookie).send({});

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('PHONE_NOT_VERIFIED');
    // No challenge and no code were created.
    expect(await prisma.unlockChallenge.count({ where: { userId: user.id } })).toBe(0);
  });

  it('refuses an unlock confirm from an unverified user', async () => {
    const { user } = await createUserWithDevice({ phoneVerified: false });

    const response = await post('/api/v1/devices/unlock/confirm', user.cookie).send({
      otp: '123456',
    });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('PHONE_NOT_VERIFIED');
  });

  /**
   * Locking stays open on purpose: it is the safe direction and needs no code.
   * Blocking it would leave an unverified user unable to secure their safe.
   */
  it('still lets an unverified user LOCK their safe', async () => {
    const { user, deviceId } = await createUserWithDevice({ phoneVerified: false });
    // Start from unlocked so the lock is a real state change.
    await prisma.device.update({
      where: { id: deviceId },
      data: { lockState: 'UNLOCKED' },
    });

    const response = await post(LOCK_URL, user.cookie).send({});

    expect(response.status).toBe(200);
    expect(response.body.device.lockState).toBe('LOCKED');
  });

  it('lets the user unlock once verified', async () => {
    const { user } = await createUserWithDevice({ phoneVerified: false });

    expect((await post(UNLOCK_REQUEST_URL, user.cookie).send({})).status).toBe(403);

    await verifyUserPhone(user.id);

    const response = await post(UNLOCK_REQUEST_URL, user.cookie).send({});
    expect(response.status).toBe(200);
  });

  it('is checked after payment state, so an unpaid user hears about paying first', async () => {
    const user = await createTestUser();

    const response = await post(UNLOCK_REQUEST_URL, user.cookie).send({});

    expect(response.status).toBe(402);
    expect(response.body.error.code).toBe('NOT_PAID');
  });
});

// --- The daily cap -----------------------------------------------------------

describe('the daily WhatsApp cap', () => {
  it('refuses a verification request with a retry time once spent', async () => {
    const user = await createTestUser();
    fake.reset();

    for (let index = 0; index < env.WHATSAPP_DAILY_SEND_CAP; index += 1) {
      await prisma.outboundMessage.create({
        data: { userId: user.id, kind: 'UNLOCK_ALERT', status: 'SENT', sentAt: new Date() },
      });
    }

    const response = await post(REQUEST_URL, user.cookie).send({
      phone: NEW_PHONE,
      consent: true,
    });

    expect(response.status).toBe(429);
    expect(response.body.error.code).toBe('WHATSAPP_SEND_CAP_REACHED');
    // Clear user-facing copy, with a time attached.
    expect(response.body.error.message).toMatch(/limit for WhatsApp messages/i);
    expect(response.body.error.message).toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(fake.sent()).toHaveLength(0);
  });
});

// --- Delivery failure --------------------------------------------------------

describe('when the verification code cannot be delivered', () => {
  it('answers 502 and leaves no usable challenge', async () => {
    const user = await createTestUser();
    fake.reset();
    fake.failNext('TRANSPORT');

    const response = await post(REQUEST_URL, user.cookie).send({
      phone: NEW_PHONE,
      consent: true,
    });

    expect(response.status).toBe(502);
    expect(response.body.error.code).toBe('OTP_DELIVERY_FAILED');

    const challenges = await prisma.phoneVerification.findMany({
      where: { userId: user.id },
    });
    expect(challenges).toHaveLength(1);
    expect(challenges[0]!.consumedAt).toBeInstanceOf(Date);
  });
});

// --- Nothing leaks -----------------------------------------------------------

describe('the verification code never escapes', () => {
  it('appears in no response, audit row or user column', async () => {
    const user = await createTestUser();
    const { code } = await withCode(() =>
      post(REQUEST_URL, user.cookie).send({ phone: NEW_PHONE, consent: true }),
    );
    const confirm = await post(CONFIRM_URL, user.cookie).send({ otp: code });

    expect(JSON.stringify(confirm.body)).not.toContain(code);

    const audits = await prisma.auditLog.findMany();
    expect(JSON.stringify(audits)).not.toContain(code);
    // Audit rows carry the masked number, never the full one.
    expect(JSON.stringify(audits)).not.toContain(NEW_PHONE);

    const rows = await prisma.phoneVerification.findMany();
    expect(JSON.stringify(rows)).not.toContain(code);
  });

  it('records the verified number masked in the audit trail', async () => {
    const user = await createTestUser();
    const { code } = await withCode(() =>
      post(REQUEST_URL, user.cookie).send({ phone: NEW_PHONE, consent: true }),
    );
    await post(CONFIRM_URL, user.cookie).send({ otp: code });

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { userId: user.id, action: 'account.phone.verified' },
    });
    expect(audit.metadata).toMatchObject({ maskedPhone: '+91 91****80' });
  });
});
