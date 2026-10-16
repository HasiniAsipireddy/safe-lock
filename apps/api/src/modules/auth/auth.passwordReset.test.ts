import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { RESET_CODE_MAX_ATTEMPTS } from '@safelock/shared';
import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { fakeWhatsAppClient } from '../../lib/whatsapp';
import {
  TEST_ORIGIN,
  app,
  cookieValue,
  createTestUserWithPassword,
  refreshCookie,
  seedRefreshToken,
  verifyUserPhone,
  withCapturedResetCode,
} from '../../test/helpers';
import { ACCESS_COOKIE, REFRESH_COOKIE } from './tokens';
import { hashResetCode, mayPrintResetCode } from './passwordReset.service';
import { hashOtp } from '../devices/otp.service';
import { verifyPassword } from './password';

/**
 * Password reset by one-time code.
 *
 * Two properties carry most of the weight here, and most of the tests:
 *
 * 1. **`/forgot` answers byte-identically for every input.** Registered email,
 *    unknown email, registered phone, unknown phone, a user with no verified
 *    number, a user whose daily cap is spent. Any difference is an
 *    account-enumeration oracle on an unauthenticated endpoint.
 * 2. **The per-account attempt counter is load-bearing.** An 8-digit code is
 *    only safe because five guesses is five guesses — including under
 *    concurrency, and including for the correct code once they are gone.
 */

const FORGOT_URL = '/api/v1/auth/password/forgot';
const RESET_URL = '/api/v1/auth/password/reset';
const LOGIN_URL = '/api/v1/auth/login';

const OLD_PASSWORD = 'OldPassword123';
const NEW_PASSWORD = 'BrandNewPass456';

const fake = fakeWhatsAppClient()!;

function postForgot(identifier: unknown, instance = app()) {
  return request(instance).post(FORGOT_URL).set('Origin', TEST_ORIGIN).send({ identifier });
}

/** Loosely typed so a test can send shapes the schema must reject. */
function postReset(body: Record<string, unknown>, instance = app()) {
  return request(instance).post(RESET_URL).set('Origin', TEST_ORIGIN).send(body);
}

/** Requests a reset for a real user and returns the delivered code. */
async function requestCodeFor(identifier: string): Promise<string> {
  const { code } = await withCapturedResetCode(() => postForgot(identifier));
  return code;
}

/** A user who can actually be messaged. */
async function messageableUser() {
  const user = await createTestUserWithPassword(OLD_PASSWORD);
  await verifyUserPhone(user.id);
  return user;
}

// --- The identical-response property -----------------------------------------

describe('POST /auth/password/forgot — one answer for every input', () => {
  /**
   * The six cases the endpoint must not distinguish. Asserted as a set so a
   * future seventh case has an obvious place to join.
   */
  it('is byte-identical across all six cases', async () => {
    const verified = await messageableUser();
    const unverified = await createTestUserWithPassword(OLD_PASSWORD);
    const capped = await messageableUser();

    // Spend the capped user's whole daily allowance.
    for (let index = 0; index < env.WHATSAPP_DAILY_SEND_CAP; index += 1) {
      await prisma.outboundMessage.create({
        data: { userId: capped.id, kind: 'UNLOCK_ALERT', status: 'SENT', sentAt: new Date() },
      });
    }

    const cases: Array<[string, string]> = [
      ['registered email', verified.email],
      ['unknown email', 'nobody.at.all@example.com'],
      ['registered phone', verified.phone],
      ['unknown phone', '9000000001'],
      ['unverified phone (email)', unverified.email],
      ['capped user', capped.email],
    ];

    const seen: string[] = [];

    for (const [label, identifier] of cases) {
      // A fresh app per case so the minimum-interval limiter never interferes
      // with what is being measured here.
      const response = await postForgot(identifier, app());
      expect(response.status, label).toBe(200);
      seen.push(`${response.status} ${JSON.stringify(response.body)}`);
    }

    // Every case produced the same status line and the same bytes.
    expect(new Set(seen).size, seen.join('\n')).toBe(1);
    expect(seen[0]).toBe(`200 ${JSON.stringify({ status: 'ok' })}`);
  });

  it('accepts a phone number as well as an email', async () => {
    const user = await messageableUser();
    fake.reset();

    const code = await requestCodeFor(user.phone);

    expect(code).toMatch(/^\d{8}$/);
    expect(fake.sentWithTemplate(env.WHATSAPP_TEMPLATE_PASSWORD_RESET)).toHaveLength(1);
  });

  it('mints no code for an identifier with no account', async () => {
    await postForgot('nobody.at.all@example.com');
    await postForgot('9000000002', app());

    expect(await prisma.passwordResetCode.count()).toBe(0);
  });

  it('sends nothing for a user whose phone is not verified', async () => {
    const user = await createTestUserWithPassword(OLD_PASSWORD);
    fake.reset();

    const response = await postForgot(user.email);

    expect(response.status).toBe(200);
    expect(fake.sent()).toHaveLength(0);
    // The code still exists — only delivery was skipped.
    expect(await prisma.passwordResetCode.count({ where: { userId: user.id } })).toBe(1);
  });

  it('rejects a malformed identifier before looking anything up', async () => {
    for (const identifier of ['not-an-email', '12345', '']) {
      const response = await postForgot(identifier, app());
      expect(response.status, identifier).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect(await prisma.passwordResetCode.count()).toBe(0);
  });
});

// --- Storage and delivery ----------------------------------------------------

describe('the code at rest', () => {
  it('is stored only as a keyed HMAC', async () => {
    const user = await messageableUser();
    const code = await requestCodeFor(user.email);

    const rows = await prisma.passwordResetCode.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.codeHash).not.toContain(code);
    expect(rows[0]!.codeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(rows[0]!.codeHash).toBe(hashResetCode(code));
  });

  /**
   * Domain separation. Both digests use `OTP_HMAC_SECRET`, so without the
   * `pwreset:v1:` prefix the same digits would produce the same digest and a
   * code could in principle be presented across purposes.
   */
  it('never produces the same digest as an unlock code for the same digits', async () => {
    for (const digits of ['12345678', '00000000', '99999999']) {
      expect(hashResetCode(digits)).not.toBe(hashOtp(digits));
    }
  });

  it('is not a bare sha256 — the secret is genuinely in play', async () => {
    const crypto = await import('node:crypto');
    const bare = crypto.createHash('sha256').update('12345678').digest('hex');
    expect(hashResetCode('12345678')).not.toBe(bare);
  });

  it('never appears in a response body', async () => {
    const user = await messageableUser();
    const { result, code } = await withCapturedResetCode(() => postForgot(user.email));

    expect(JSON.stringify(result.body)).not.toContain(code);
  });

  it('is sent as the template parameter, and nothing else', async () => {
    const user = await messageableUser();
    fake.reset();

    const code = await requestCodeFor(user.email);

    const sent = fake.sentWithTemplate(env.WHATSAPP_TEMPLATE_PASSWORD_RESET);
    expect(sent).toHaveLength(1);
    // The whole point of this change: the message now carries the code.
    expect(sent[0]!.params).toEqual([code]);
    expect(sent[0]!.to).toBe(`+91${user.phone}`);
  });

  it('supersedes an earlier outstanding code, so only one is live', async () => {
    const user = await messageableUser();

    const first = await requestCodeFor(user.email);
    const second = await requestCodeFor(user.email);
    expect(second).not.toBe(first);

    const stale = await postReset({
      identifier: user.email,
      code: first,
      password: NEW_PASSWORD,
    });
    expect(stale.status).toBe(400);
    expect(stale.body.error.code).toBe('RESET_CODE_INVALID');

    const fresh = await postReset({
      identifier: user.email,
      code: second,
      password: NEW_PASSWORD,
    });
    expect(fresh.status).toBe(200);
  });
});

// --- Redemption --------------------------------------------------------------

describe('POST /auth/password/reset', () => {
  it('sets the new password and lets the user sign in with it', async () => {
    const user = await messageableUser();
    const code = await requestCodeFor(user.email);

    const response = await postReset({
      identifier: user.email,
      code,
      password: NEW_PASSWORD,
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });

    const row = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { passwordHash: true },
    });
    expect(await verifyPassword(row.passwordHash, NEW_PASSWORD)).toBe(true);
    expect(await verifyPassword(row.passwordHash, OLD_PASSWORD)).toBe(false);

    const login = await request(app())
      .post(LOGIN_URL)
      .set('Origin', TEST_ORIGIN)
      .send({ identifier: user.email, password: NEW_PASSWORD });
    expect(login.status).toBe(200);
  });

  it('works with the phone number as the identifier', async () => {
    const user = await messageableUser();
    const code = await requestCodeFor(user.phone);

    const response = await postReset({
      identifier: user.phone,
      code,
      password: NEW_PASSWORD,
    });

    expect(response.status).toBe(200);
  });

  it('accepts a code pasted with spaces', async () => {
    const user = await messageableUser();
    const code = await requestCodeFor(user.email);

    const spaced = `${code.slice(0, 4)} ${code.slice(4)}`;
    const response = await postReset({
      identifier: user.email,
      code: spaced,
      password: NEW_PASSWORD,
    });

    expect(response.status).toBe(200);
  });

  it('does NOT sign the user in', async () => {
    const user = await messageableUser();
    const code = await requestCodeFor(user.email);

    const response = await postReset({
      identifier: user.email,
      code,
      password: NEW_PASSWORD,
    });

    expect(response.status).toBe(200);
    expect(response.body.user).toBeUndefined();
    // `clearAuthCookies` does emit Set-Cookie, so assert on the value.
    expect(cookieValue(response, ACCESS_COOKIE)).toBeFalsy();
    expect(cookieValue(response, REFRESH_COOKIE)).toBeFalsy();
    expect(await prisma.refreshToken.count({ where: { revokedAt: null } })).toBe(0);
  });

  it('is single-use', async () => {
    const user = await messageableUser();
    const code = await requestCodeFor(user.email);

    expect(
      (await postReset({ identifier: user.email, code, password: NEW_PASSWORD })).status,
    ).toBe(200);

    const replay = await postReset({
      identifier: user.email,
      code,
      password: 'ThirdPassword789',
    });
    expect(replay.status).toBe(400);
    expect(replay.body.error.code).toBe('RESET_CODE_INVALID');

    const row = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { passwordHash: true },
    });
    expect(await verifyPassword(row.passwordHash, NEW_PASSWORD)).toBe(true);
    expect(await verifyPassword(row.passwordHash, 'ThirdPassword789')).toBe(false);
  });

  it('refuses an expired code', async () => {
    const user = await messageableUser();
    const code = await requestCodeFor(user.email);
    await prisma.passwordResetCode.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const response = await postReset({
      identifier: user.email,
      code,
      password: NEW_PASSWORD,
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('RESET_CODE_INVALID');

    const row = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { passwordHash: true },
    });
    expect(await verifyPassword(row.passwordHash, OLD_PASSWORD)).toBe(true);
  });

  it('revokes every refresh token, with the PASSWORD_RESET reason', async () => {
    const user = await messageableUser();
    const phone = await seedRefreshToken({ userId: user.id });
    const laptop = await seedRefreshToken({ userId: user.id });

    const code = await requestCodeFor(user.email);
    await postReset({ identifier: user.email, code, password: NEW_PASSWORD });

    const rows = await prisma.refreshToken.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.revokedAt).toBeInstanceOf(Date);
      // Preserved from step 3: a stale device presenting one of these must get
      // a plain 401, not a false theft signal that cascades.
      expect(row.revokedReason).toBe('PASSWORD_RESET');
    }

    for (const session of [phone, laptop]) {
      const refresh = await request(app())
        .post('/api/v1/auth/refresh')
        .set('Origin', TEST_ORIGIN)
        .set('Cookie', refreshCookie(session.rawToken))
        .send();
      expect(refresh.status).toBe(401);
      expect(refresh.body.error.code).toBe('REFRESH_TOKEN_INVALID');
    }
  });

  it('rejects a password that fails the policy, without consuming the code', async () => {
    const user = await messageableUser();
    const code = await requestCodeFor(user.email);

    const weak = await postReset({ identifier: user.email, code, password: 'short' });
    expect(weak.status).toBe(400);
    expect(weak.body.error.code).toBe('VALIDATION_ERROR');

    // Schema validation happens before any attempt is spent, so the code is
    // untouched — a typo in the new password must not burn it.
    const row = await prisma.passwordResetCode.findFirstOrThrow({
      where: { userId: user.id },
    });
    expect(row.attempts).toBe(0);

    const retry = await postReset({ identifier: user.email, code, password: NEW_PASSWORD });
    expect(retry.status).toBe(200);
  });

  it('rejects a body carrying extra fields', async () => {
    const user = await messageableUser();
    const code = await requestCodeFor(user.email);

    const response = await postReset({
      identifier: user.email,
      code,
      password: NEW_PASSWORD,
      role: 'ADMIN',
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a malformed code at the schema', async () => {
    const user = await messageableUser();
    await requestCodeFor(user.email);

    for (const code of ['123', '123456789', 'abcdefgh', '1234567a', 'x'.repeat(500)]) {
      const response = await postReset({
        identifier: user.email,
        code,
        password: NEW_PASSWORD,
      });
      expect(response.status, code.slice(0, 12)).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }
  });
});

// --- No oracle on redemption -------------------------------------------------

describe('every redemption failure answers identically', () => {
  it('cannot be used to tell whether an account exists', async () => {
    const user = await messageableUser();
    const code = await requestCodeFor(user.email);
    const wrong = code === '00000000' ? '11111111' : '00000000';

    const responses = [
      // Real account, wrong code.
      await postReset({ identifier: user.email, code: wrong, password: NEW_PASSWORD }),
      // No such account at all.
      await postReset({
        identifier: 'nobody.at.all@example.com',
        code: wrong,
        password: NEW_PASSWORD,
      }),
      await postReset({ identifier: '9000000003', code: wrong, password: NEW_PASSWORD }),
      // Real account with no outstanding code.
      await postReset({
        identifier: (await createTestUserWithPassword(OLD_PASSWORD)).email,
        code: wrong,
        password: NEW_PASSWORD,
      }),
    ];

    const shapes = responses.map(
      (response) =>
        `${response.status} ${response.body.error.code} ${response.body.error.message}`,
    );

    expect(new Set(shapes).size, shapes.join('\n')).toBe(1);
    expect(shapes[0]).toMatch(/^400 RESET_CODE_INVALID /);
  });
});

// --- The attempt counter (load-bearing) --------------------------------------

describe('the per-account attempt limit', () => {
  it('spends an attempt per wrong guess and dies at the cap', async () => {
    const user = await messageableUser();
    const code = await requestCodeFor(user.email);
    const wrong = code === '00000000' ? '11111111' : '00000000';

    for (let attempt = 1; attempt <= RESET_CODE_MAX_ATTEMPTS; attempt += 1) {
      const response = await postReset({
        identifier: user.email,
        code: wrong,
        password: NEW_PASSWORD,
      });
      expect(response.status, `attempt ${attempt}`).toBe(400);
    }

    const row = await prisma.passwordResetCode.findFirstOrThrow({
      where: { userId: user.id },
    });
    expect(row.attempts).toBe(RESET_CODE_MAX_ATTEMPTS);
    expect(row.consumedAt).toBeInstanceOf(Date);
  });

  /**
   * The property an 8-digit code depends on: once the attempts are gone, the
   * **correct** code is worthless too. There is no branch that checks the
   * digest before spending an attempt.
   */
  it('refuses the correct code once attempts are exhausted', async () => {
    const user = await messageableUser();
    const code = await requestCodeFor(user.email);
    const wrong = code === '00000000' ? '11111111' : '00000000';

    for (let attempt = 0; attempt < RESET_CODE_MAX_ATTEMPTS; attempt += 1) {
      await postReset({ identifier: user.email, code: wrong, password: NEW_PASSWORD });
    }

    const correct = await postReset({
      identifier: user.email,
      code,
      password: NEW_PASSWORD,
    });

    expect(correct.status).toBe(400);
    expect(correct.body.error.code).toBe('RESET_CODE_INVALID');

    const row = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { passwordHash: true },
    });
    expect(await verifyPassword(row.passwordHash, OLD_PASSWORD)).toBe(true);
  });

  /**
   * The limit is **per account**, held on the challenge row, so it cannot be
   * sidestepped by spreading guesses across addresses. Each request here comes
   * from a fresh app instance, which resets every per-IP and per-identifier
   * limiter — the only thing still counting is the row.
   */
  it('holds across many IPs and fresh limiter buckets', async () => {
    const user = await messageableUser();
    const code = await requestCodeFor(user.email);
    const wrong = code === '00000000' ? '11111111' : '00000000';

    // Ten attempts, each on its own app with its own counters.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await request(app())
        .post(RESET_URL)
        .set('Origin', TEST_ORIGIN)
        // A different apparent client each time. TRUST_PROXY is off so this
        // does not change req.ip — the fresh app is what resets the buckets.
        .set('X-Forwarded-For', `203.0.113.${attempt}`)
        .send({ identifier: user.email, code: wrong, password: NEW_PASSWORD });

      expect(response.status).toBe(400);
    }

    // Still exactly five: the row counted, not the limiter.
    const row = await prisma.passwordResetCode.findFirstOrThrow({
      where: { userId: user.id },
    });
    expect(row.attempts).toBe(RESET_CODE_MAX_ATTEMPTS);

    const correct = await postReset({
      identifier: user.email,
      code,
      password: NEW_PASSWORD,
    });
    expect(correct.status).toBe(400);
  });

  /**
   * Concurrency. The increment's `where` carries the limit, so the check and
   * the increment are one statement — twenty parallel guesses can cost at most
   * five attempts, and none of them gets a free evaluation.
   */
  it('never evaluates more than five parallel guesses', async () => {
    const user = await messageableUser();
    const code = await requestCodeFor(user.email);
    const wrong = code === '00000000' ? '11111111' : '00000000';

    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        postReset({ identifier: user.email, code: wrong, password: NEW_PASSWORD }),
      ),
    );

    for (const response of responses) expect(response.status).toBe(400);

    const row = await prisma.passwordResetCode.findFirstOrThrow({
      where: { userId: user.id },
    });
    // The cap was neither overshot nor undercounted.
    expect(row.attempts).toBe(RESET_CODE_MAX_ATTEMPTS);

    const correct = await postReset({
      identifier: user.email,
      code,
      password: NEW_PASSWORD,
    });
    expect(correct.status).toBe(400);
  });

  it('lets only one of two parallel correct submissions win', async () => {
    const user = await messageableUser();
    const code = await requestCodeFor(user.email);

    const [first, second] = await Promise.all([
      postReset({ identifier: user.email, code, password: NEW_PASSWORD }),
      postReset({ identifier: user.email, code, password: 'OtherPassword99' }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 400]);
  });

  /**
   * Burning a victim's attempts is a nuisance, not a lockout: a fresh code is
   * always obtainable, subject only to the minimum interval and the daily cap.
   */
  it('always allows a fresh code after the attempts are burned', async () => {
    const user = await messageableUser();
    const code = await requestCodeFor(user.email);
    const wrong = code === '00000000' ? '11111111' : '00000000';

    for (let attempt = 0; attempt < RESET_CODE_MAX_ATTEMPTS; attempt += 1) {
      await postReset({ identifier: user.email, code: wrong, password: NEW_PASSWORD });
    }

    // A new request works, and its code opens the account.
    const fresh = await requestCodeFor(user.email);
    expect(fresh).not.toBe(code);

    const response = await postReset({
      identifier: user.email,
      code: fresh,
      password: NEW_PASSWORD,
    });
    expect(response.status).toBe(200);
  });

  it('audits exhaustion separately, without the code', async () => {
    const user = await messageableUser();
    const code = await requestCodeFor(user.email);
    const wrong = code === '00000000' ? '11111111' : '00000000';

    for (let attempt = 0; attempt < RESET_CODE_MAX_ATTEMPTS; attempt += 1) {
      await postReset({ identifier: user.email, code: wrong, password: NEW_PASSWORD });
    }

    const exhausted = await prisma.auditLog.findFirst({
      where: { action: 'auth.password.reset_code_exhausted' },
    });
    expect(exhausted).not.toBeNull();

    const dump = JSON.stringify(await prisma.auditLog.findMany());
    expect(dump).not.toContain(code);
    expect(dump).not.toContain(wrong);
    expect(dump).not.toContain(user.email);
  });
});

// --- The minimum interval ----------------------------------------------------

describe('the minimum interval between codes', () => {
  it('is enforced server-side, per account', async () => {
    const user = await messageableUser();
    // One app instance, so the limiter's counters persist across requests.
    const instance = app({
      rateLimits: { passwordForgotInterval: { windowMs: 60_000, limit: 1 } },
    });

    const first = await postForgot(user.email, instance);
    expect(first.status).toBe(200);

    const second = await postForgot(user.email, instance);
    expect(second.status).toBe(429);
    expect(second.body.error.code).toBe('RATE_LIMITED');
  });

  /**
   * And it must not become an oracle: the limb is keyed on the hashed
   * identifier and runs before any lookup, so a real account's cooldown is
   * indistinguishable from a fake one's.
   */
  it('answers the same for a real and a fake account', async () => {
    const user = await messageableUser();
    const instance = app({
      rateLimits: { passwordForgotInterval: { windowMs: 60_000, limit: 1 } },
    });

    await postForgot(user.email, instance);
    const real = await postForgot(user.email, instance);

    await postForgot('nobody.at.all@example.com', instance);
    const fake429 = await postForgot('nobody.at.all@example.com', instance);

    expect(real.status).toBe(fake429.status);
    expect(real.body.error.code).toBe(fake429.body.error.code);
    expect(real.body.error.message).toBe(fake429.body.error.message);
  });

  it('is per account, so one user’s cooldown does not block another', async () => {
    const one = await messageableUser();
    const two = await messageableUser();
    const instance = app({
      rateLimits: { passwordForgotInterval: { windowMs: 60_000, limit: 1 } },
    });

    await postForgot(one.email, instance);
    expect((await postForgot(one.email, instance)).status).toBe(429);
    // A different account is unaffected.
    expect((await postForgot(two.email, instance)).status).toBe(200);
  });
});

// --- Nothing leaks -----------------------------------------------------------

describe('the code never escapes', () => {
  it('appears in no audit row, no user column and no response', async () => {
    const user = await messageableUser();
    const code = await requestCodeFor(user.email);
    const response = await postReset({
      identifier: user.email,
      code,
      password: NEW_PASSWORD,
    });

    expect(JSON.stringify(response.body)).not.toContain(code);

    const audits = JSON.stringify(await prisma.auditLog.findMany());
    expect(audits).not.toContain(code);
    expect(audits).not.toContain(NEW_PASSWORD);

    const rows = JSON.stringify(await prisma.passwordResetCode.findMany());
    expect(rows).not.toContain(code);
  });

  it('audits a known and an unknown identifier differently, with neither recorded', async () => {
    const user = await messageableUser();

    await requestCodeFor(user.email);
    await postForgot('nobody.at.all@example.com', app());

    const known = await prisma.auditLog.findFirst({
      where: { action: 'auth.password.reset_requested' },
    });
    const unknown = await prisma.auditLog.findFirst({
      where: { action: 'auth.password.reset_requested_unknown' },
    });

    expect(known?.userId).toBe(user.id);
    expect(unknown?.userId).toBeNull();
    expect(JSON.stringify(known?.metadata)).not.toContain(user.email);
    expect(JSON.stringify(unknown?.metadata)).not.toContain('nobody.at.all@example.com');
  });

  it('still answers 200 when the WhatsApp send itself fails', async () => {
    const user = await messageableUser();
    fake.reset();
    fake.failAlways('TRANSPORT');

    const response = await postForgot(user.email);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
    fake.recover();
  });
});

describe('mayPrintResetCode', () => {
  it('allows only development and test', () => {
    expect(mayPrintResetCode('development')).toBe(true);
    expect(mayPrintResetCode('test')).toBe(true);
    expect(mayPrintResetCode('production')).toBe(false);
    expect(mayPrintResetCode('Production')).toBe(false);
    expect(mayPrintResetCode('staging')).toBe(false);
    expect(mayPrintResetCode('')).toBe(false);
    expect(mayPrintResetCode('developmen')).toBe(false);
  });
});
