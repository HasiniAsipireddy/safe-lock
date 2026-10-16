import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
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
  withCapturedResetToken,
} from '../../test/helpers';
import { ACCESS_COOKIE, REFRESH_COOKIE } from './tokens';
import { hashResetToken, mayPrintResetToken } from './passwordReset.service';
import { verifyPassword } from './password';

const FORGOT_URL = '/api/v1/auth/password/forgot';
const RESET_URL = '/api/v1/auth/password/reset';
const LOGIN_URL = '/api/v1/auth/login';

const OLD_PASSWORD = 'OldPassword123';
const NEW_PASSWORD = 'BrandNewPass456';

const fake = fakeWhatsAppClient()!;

function postForgot(email: unknown, instance = app()) {
  return request(instance).post(FORGOT_URL).set('Origin', TEST_ORIGIN).send({ email });
}

/** Loosely typed so a test can send fields and shapes the schema must reject. */
function postReset(body: Record<string, unknown>, instance = app()) {
  return request(instance).post(RESET_URL).set('Origin', TEST_ORIGIN).send(body);
}

/** Requests a reset for a real user and returns the delivered token. */
async function requestTokenFor(email: string): Promise<string> {
  const { token } = await withCapturedResetToken(() => postForgot(email));
  return token;
}

describe('POST /auth/password/forgot', () => {
  it('answers identically for a registered and an unregistered address', async () => {
    const user = await createTestUserWithPassword(OLD_PASSWORD);

    const known = await withCapturedResetToken(() => postForgot(user.email));
    const unknown = await postForgot('nobody.at.all@example.com');

    expect(known.result.status).toBe(200);
    expect(unknown.status).toBe(200);
    // Byte-identical bodies. No timing assertion: equalisation is best-effort
    // and a timing test would be flaky by construction (see the service doc).
    expect(JSON.stringify(unknown.body)).toBe(JSON.stringify(known.result.body));
    expect(unknown.body).toEqual({ status: 'ok' });
  });

  it('mints no token for an address with no account', async () => {
    await postForgot('nobody.at.all@example.com');

    expect(await prisma.passwordResetToken.count()).toBe(0);
  });

  it('stores only a hash — the raw token never reaches the database', async () => {
    const user = await createTestUserWithPassword(OLD_PASSWORD);
    const token = await requestTokenFor(user.email);

    const rows = await prisma.passwordResetToken.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).not.toBe(token);
    expect(rows[0]!.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(rows[0]!.tokenHash).toBe(hashResetToken(token));
  });

  it('never returns the token in the response body', async () => {
    const user = await createTestUserWithPassword(OLD_PASSWORD);
    const { result, token } = await withCapturedResetToken(() => postForgot(user.email));

    expect(JSON.stringify(result.body)).not.toContain(token);
  });

  it('supersedes an earlier outstanding token, so only one link is live', async () => {
    const user = await createTestUserWithPassword(OLD_PASSWORD);

    const first = await requestTokenFor(user.email);
    const second = await requestTokenFor(user.email);
    expect(second).not.toBe(first);

    // The older link is dead on arrival.
    const stale = await postReset({ token: first, password: NEW_PASSWORD });
    expect(stale.status).toBe(400);
    expect(stale.body.error.code).toBe('RESET_TOKEN_INVALID');

    // The newer one still works.
    const fresh = await postReset({ token: second, password: NEW_PASSWORD });
    expect(fresh.status).toBe(200);
  });

  it('audits a known and an unknown address differently, with no address in the row', async () => {
    const user = await createTestUserWithPassword(OLD_PASSWORD);

    await requestTokenFor(user.email);
    await postForgot('nobody.at.all@example.com');

    const known = await prisma.auditLog.findFirst({
      where: { action: 'auth.password.reset_requested' },
    });
    const unknown = await prisma.auditLog.findFirst({
      where: { action: 'auth.password.reset_requested_unknown' },
    });

    expect(known?.userId).toBe(user.id);
    expect(unknown).not.toBeNull();
    expect(unknown?.userId).toBeNull();
    // Neither row may carry the address that was submitted.
    expect(JSON.stringify(known?.metadata)).not.toContain(user.email);
    expect(JSON.stringify(unknown?.metadata)).not.toContain('nobody.at.all@example.com');
  });

  /**
   * The cap must not become the oracle the identical response was built to
   * deny. "This address has an account that has been messaged a lot today" is
   * exactly the disclosure `/forgot` exists to withhold.
   */
  it('answers identically when the user’s daily WhatsApp cap is spent', async () => {
    const user = await createTestUserWithPassword(OLD_PASSWORD);
    await verifyUserPhone(user.id);
    fake.reset();

    // Spend the whole allowance.
    for (let index = 0; index < env.WHATSAPP_DAILY_SEND_CAP; index += 1) {
      await prisma.outboundMessage.create({
        data: { userId: user.id, kind: 'UNLOCK_ALERT', status: 'SENT', sentAt: new Date() },
      });
    }

    const capped = await postForgot(user.email);
    const unknown = await postForgot('definitely.nobody@example.com');

    expect(capped.status).toBe(200);
    expect(JSON.stringify(capped.body)).toBe(JSON.stringify(unknown.body));
    expect(capped.body).toEqual({ status: 'ok' });
    // Nothing was sent, and the token still exists so the link in hand works.
    expect(fake.sent()).toHaveLength(0);
    expect(await prisma.passwordResetToken.count({ where: { userId: user.id } })).toBe(1);
  });

  it('answers identically for a user with no verified phone', async () => {
    const unverified = await createTestUserWithPassword(OLD_PASSWORD);
    const verified = await createTestUserWithPassword(OLD_PASSWORD);
    await verifyUserPhone(verified.id);
    fake.reset();

    const a = await postForgot(unverified.email);
    const b = await postForgot(verified.email);
    const c = await postForgot('definitely.nobody@example.com');

    for (const response of [a, b, c]) {
      expect(response.status).toBe(200);
      expect(JSON.stringify(response.body)).toBe(JSON.stringify({ status: 'ok' }));
    }

    // Only the verified user was actually messaged — invisibly to the caller.
    expect(fake.sentWithTemplate(env.WHATSAPP_TEMPLATE_PASSWORD_RESET)).toHaveLength(1);
  });

  it('sends the reset alert without the token in it', async () => {
    const user = await createTestUserWithPassword(OLD_PASSWORD);
    await verifyUserPhone(user.id);
    fake.reset();

    const token = await requestTokenFor(user.email);

    const sent = fake.sentWithTemplate(env.WHATSAPP_TEMPLATE_PASSWORD_RESET);
    expect(sent).toHaveLength(1);
    // A chat message is persistent and forwardable; a reset token is an
    // account takeover in one string. See docs/decisions.md.
    expect(JSON.stringify(sent[0]!.params)).not.toContain(token);
    expect(sent[0]!.params).toEqual([]);
  });

  it('still answers 200 when the WhatsApp send itself fails', async () => {
    const user = await createTestUserWithPassword(OLD_PASSWORD);
    await verifyUserPhone(user.id);
    fake.reset();
    fake.failAlways('TRANSPORT');

    const response = await postForgot(user.email);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
    fake.recover();
  });

  it('rejects a malformed address before looking anything up', async () => {
    const response = await postForgot('not-an-email');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(await prisma.passwordResetToken.count()).toBe(0);
  });
});

describe('POST /auth/password/reset', () => {
  it('sets the new password and lets the user sign in with it', async () => {
    const user = await createTestUserWithPassword(OLD_PASSWORD);
    const token = await requestTokenFor(user.email);

    const response = await postReset({ token, password: NEW_PASSWORD });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });

    const row = await prisma.user.findUnique({
      where: { id: user.id },
      select: { passwordHash: true },
    });
    expect(await verifyPassword(row!.passwordHash, NEW_PASSWORD)).toBe(true);
    expect(await verifyPassword(row!.passwordHash, OLD_PASSWORD)).toBe(false);

    const login = await request(app())
      .post(LOGIN_URL)
      .set('Origin', TEST_ORIGIN)
      .send({ identifier: user.email, password: NEW_PASSWORD });
    expect(login.status).toBe(200);
  });

  /**
   * The point of assumption 6 in the plan: a reset link proves control of a
   * delivery channel, not that the holder is the owner. It may set a password;
   * it may not be exchanged for a live session to a safe.
   */
  it('does NOT sign the user in', async () => {
    const user = await createTestUserWithPassword(OLD_PASSWORD);
    const token = await requestTokenFor(user.email);

    const response = await postReset({ token, password: NEW_PASSWORD });

    expect(response.status).toBe(200);
    // No user object to act on.
    expect(response.body.user).toBeUndefined();
    // And no session cookie with a value in it. `clearAuthCookies` does emit
    // Set-Cookie headers, so the assertion is on the value, not the header.
    expect(cookieValue(response, ACCESS_COOKIE)).toBeFalsy();
    expect(cookieValue(response, REFRESH_COOKIE)).toBeFalsy();
    // Nothing was issued server-side either.
    expect(await prisma.refreshToken.count({ where: { revokedAt: null } })).toBe(0);
  });

  it('is single-use: the same token cannot be redeemed twice', async () => {
    const user = await createTestUserWithPassword(OLD_PASSWORD);
    const token = await requestTokenFor(user.email);

    expect((await postReset({ token, password: NEW_PASSWORD })).status).toBe(200);

    const replay = await postReset({ token, password: 'ThirdPassword789' });
    expect(replay.status).toBe(400);
    expect(replay.body.error.code).toBe('RESET_TOKEN_INVALID');

    // The replay must not have changed the password again.
    const row = await prisma.user.findUnique({
      where: { id: user.id },
      select: { passwordHash: true },
    });
    expect(await verifyPassword(row!.passwordHash, NEW_PASSWORD)).toBe(true);
    expect(await verifyPassword(row!.passwordHash, 'ThirdPassword789')).toBe(false);
  });

  it('refuses an expired token', async () => {
    const user = await createTestUserWithPassword(OLD_PASSWORD);
    const token = await requestTokenFor(user.email);

    await prisma.passwordResetToken.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const response = await postReset({ token, password: NEW_PASSWORD });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('RESET_TOKEN_INVALID');

    const row = await prisma.user.findUnique({
      where: { id: user.id },
      select: { passwordHash: true },
    });
    expect(await verifyPassword(row!.passwordHash, OLD_PASSWORD)).toBe(true);
  });

  it('gives an unknown, an expired and a used token the same answer', async () => {
    const user = await createTestUserWithPassword(OLD_PASSWORD);

    const used = await requestTokenFor(user.email);
    await postReset({ token: used, password: NEW_PASSWORD });

    const unknownToken = crypto.randomBytes(32).toString('base64url');
    const unknown = await postReset({ token: unknownToken, password: NEW_PASSWORD });
    const replayed = await postReset({ token: used, password: NEW_PASSWORD });

    expect(unknown.status).toBe(replayed.status);
    expect(unknown.body.error.code).toBe(replayed.body.error.code);
    expect(unknown.body.error.message).toBe(replayed.body.error.message);
  });

  it('revokes every refresh token for the user', async () => {
    const user = await createTestUserWithPassword(OLD_PASSWORD);
    // Two other live sessions, as if signed in on a phone and a laptop.
    const phone = await seedRefreshToken({ userId: user.id });
    const laptop = await seedRefreshToken({ userId: user.id });

    const token = await requestTokenFor(user.email);
    await postReset({ token, password: NEW_PASSWORD });

    const rows = await prisma.refreshToken.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.revokedAt).toBeInstanceOf(Date);

    // And neither can be refreshed any more.
    for (const session of [phone, laptop]) {
      const refresh = await request(app())
        .post('/api/v1/auth/refresh')
        .set('Origin', TEST_ORIGIN)
        .set('Cookie', refreshCookie(session.rawToken))
        .send();
      expect(refresh.status).toBe(401);
    }
  });

  /**
   * Same reasoning as the change-password case: a device still holding a
   * token revoked by the reset will present it shortly, and that is ordinary.
   * Reading it as theft would audit a false theft signal on every reset — and
   * "your session was ended for security reasons" is the wrong thing to tell
   * someone who just reset their own password.
   */
  it('treats a revoked token presented afterwards as an ended session, not theft', async () => {
    const user = await createTestUserWithPassword(OLD_PASSWORD);
    const otherDevice = await seedRefreshToken({ userId: user.id });

    const token = await requestTokenFor(user.email);
    await postReset({ token, password: NEW_PASSWORD });

    const stale = await request(app())
      .post('/api/v1/auth/refresh')
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', refreshCookie(otherDevice.rawToken))
      .send();

    expect(stale.status).toBe(401);
    expect(stale.body.error.code).toBe('REFRESH_TOKEN_INVALID');
    expect(stale.body.error.code).not.toBe('REFRESH_REUSE_DETECTED');

    const row = await prisma.refreshToken.findUnique({ where: { id: otherDevice.id } });
    expect(row?.revokedReason).toBe('PASSWORD_RESET');

    const cascade = await prisma.auditLog.findFirst({
      where: { userId: user.id, action: 'auth.refresh.reuse_detected' },
    });
    expect(cascade).toBeNull();
  });

  it('rejects a password that fails the policy, without consuming the token', async () => {
    const user = await createTestUserWithPassword(OLD_PASSWORD);
    const token = await requestTokenFor(user.email);

    const weak = await postReset({ token, password: 'short' });
    expect(weak.status).toBe(400);
    expect(weak.body.error.code).toBe('VALIDATION_ERROR');

    // The link still works — a typo in the new password must not burn it.
    const retry = await postReset({ token, password: NEW_PASSWORD });
    expect(retry.status).toBe(200);
  });

  it('rejects an oversized or non-base64url token before hashing it', async () => {
    const tooLong = await postReset({ token: 'a'.repeat(500), password: NEW_PASSWORD });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error.code).toBe('VALIDATION_ERROR');

    const badAlphabet = await postReset({ token: 'not a token!', password: NEW_PASSWORD });
    expect(badAlphabet.status).toBe(400);
    expect(badAlphabet.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a body carrying extra fields', async () => {
    const user = await createTestUserWithPassword(OLD_PASSWORD);
    const token = await requestTokenFor(user.email);

    const response = await postReset({
      token,
      password: NEW_PASSWORD,
      // A client trying to promote itself while it is at it.
      role: 'ADMIN',
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('audits the completion against the user, and a rejection without one', async () => {
    const user = await createTestUserWithPassword(OLD_PASSWORD);
    const token = await requestTokenFor(user.email);

    await postReset({ token, password: NEW_PASSWORD });
    await postReset({ token, password: NEW_PASSWORD });

    const completed = await prisma.auditLog.findFirst({
      where: { action: 'auth.password.reset_completed' },
    });
    const rejected = await prisma.auditLog.findFirst({
      where: { action: 'auth.password.reset_rejected' },
    });

    expect(completed?.userId).toBe(user.id);
    expect(rejected).not.toBeNull();
    expect(rejected?.userId).toBeNull();
  });

  it('writes nothing resembling the token into an audit row', async () => {
    const user = await createTestUserWithPassword(OLD_PASSWORD);
    const token = await requestTokenFor(user.email);
    await postReset({ token, password: NEW_PASSWORD });

    const rows = await prisma.auditLog.findMany();
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(hashResetToken(token));
    expect(dump).not.toContain(NEW_PASSWORD);
  });
});

describe('mayPrintResetToken', () => {
  /**
   * The same shape of guard as `mayPrintOtp`, and the same reason for testing
   * it directly: the default for anything unrecognised must be silence, not
   * printing a credential that can take over an account.
   */
  it('allows only development and test', () => {
    expect(mayPrintResetToken('development')).toBe(true);
    expect(mayPrintResetToken('test')).toBe(true);
    expect(mayPrintResetToken('production')).toBe(false);
    expect(mayPrintResetToken('Production')).toBe(false);
    expect(mayPrintResetToken('staging')).toBe(false);
    expect(mayPrintResetToken('')).toBe(false);
    expect(mayPrintResetToken('developmen')).toBe(false);
  });
});
