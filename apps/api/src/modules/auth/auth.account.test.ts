import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '../../lib/prisma';
import {
  TEST_ORIGIN,
  app,
  cookieValue,
  createTestUser,
  createTestUserWithPassword,
  refreshCookie,
  seedRefreshToken,
  setCookieFor,
} from '../../test/helpers';
import { ACCESS_COOKIE, REFRESH_COOKIE, verifyAccessToken } from './tokens';
import { hashRefreshToken } from './refreshToken.service';
import { verifyPassword } from './password';

const CHANGE_URL = '/api/v1/auth/password/change';
const PROFILE_URL = '/api/v1/auth/profile';
const REFRESH_URL = '/api/v1/auth/refresh';
const LOGIN_URL = '/api/v1/auth/login';

const OLD_PASSWORD = 'OldPassword123';
const NEW_PASSWORD = 'BrandNewPass456';

function postChange(cookie: string, body: unknown) {
  return request(app()).post(CHANGE_URL).set('Origin', TEST_ORIGIN).set('Cookie', cookie).send(body);
}

function patchProfileRequest(cookie: string, body: unknown) {
  return request(app())
    .patch(PROFILE_URL)
    .set('Origin', TEST_ORIGIN)
    .set('Cookie', cookie)
    .send(body);
}

describe('POST /auth/password/change', () => {
  it('changes the password and lets the user sign in with the new one', async () => {
    const user = await createTestUserWithPassword(OLD_PASSWORD);

    const response = await postChange(user.cookie, {
      currentPassword: OLD_PASSWORD,
      password: NEW_PASSWORD,
    });

    expect(response.status).toBe(200);
    expect(response.body.user.id).toBe(user.id);

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
   * The caller must come out of this still signed in. Revoking every session
   * including the one in front of you is the behaviour that teaches people not
   * to change their password.
   */
  it('keeps the caller signed in with a fresh refresh family', async () => {
    const user = await createTestUserWithPassword(OLD_PASSWORD);
    const before = await seedRefreshToken({ userId: user.id });

    const response = await postChange(user.cookie, {
      currentPassword: OLD_PASSWORD,
      password: NEW_PASSWORD,
    });

    const issued = cookieValue(response, REFRESH_COOKIE);
    expect(issued).toBeTruthy();
    expect(issued).not.toBe(before.rawToken);

    const successor = await prisma.refreshToken.findUnique({
      where: { tokenHash: hashRefreshToken(issued!) },
    });
    expect(successor).not.toBeNull();
    expect(successor?.revokedAt).toBeNull();
    // A new family, not a continuation of the old chain.
    expect(successor?.familyId).not.toBe(before.familyId);
    expect(successor?.replacedById).toBeNull();

    // And the new cookie genuinely works.
    const refreshed = await request(app())
      .post(REFRESH_URL)
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', refreshCookie(issued!))
      .send();
    expect(refreshed.status).toBe(200);
  });

  it('issues a fresh access cookie too', async () => {
    const user = await createTestUserWithPassword(OLD_PASSWORD);

    const response = await postChange(user.cookie, {
      currentPassword: OLD_PASSWORD,
      password: NEW_PASSWORD,
    });

    const access = cookieValue(response, ACCESS_COOKIE);
    expect(access).toBeTruthy();
    const claims = verifyAccessToken(access!);
    expect(claims?.sub).toBe(user.id);
  });

  /**
   * The cookies must be set with the same attributes and path scoping as a
   * login, or the refresh cookie silently stops being sent (wrong path) or
   * becomes readable from JavaScript (missing HttpOnly).
   */
  it('sets both cookies with the same attributes and paths as login', async () => {
    const user = await createTestUserWithPassword(OLD_PASSWORD);

    const changed = await postChange(user.cookie, {
      currentPassword: OLD_PASSWORD,
      password: NEW_PASSWORD,
    });
    const login = await request(app())
      .post(LOGIN_URL)
      .set('Origin', TEST_ORIGIN)
      .send({ identifier: user.email, password: NEW_PASSWORD });

    /**
     * The Set-Cookie attributes, with the secret value itself dropped — and
     * `Expires` too, which is an absolute instant and so differs by a second
     * between two requests. `Max-Age` carries the same lifetime and is
     * compared.
     */
    const attributes = (header: string): string =>
      header
        .split(';')
        .slice(1)
        .map((part) => part.trim())
        .filter((part) => !part.toLowerCase().startsWith('expires='))
        .join('; ');

    for (const name of [ACCESS_COOKIE, REFRESH_COOKIE]) {
      const fromChange = setCookieFor(changed, name);
      const fromLogin = setCookieFor(login, name);
      expect(fromChange).toBeTruthy();
      expect(attributes(fromChange!)).toBe(attributes(fromLogin!));
    }

    expect(setCookieFor(changed, REFRESH_COOKIE)).toContain('Path=/api/v1/auth');
    expect(setCookieFor(changed, ACCESS_COOKIE)).toContain('Path=/');
    expect(setCookieFor(changed, REFRESH_COOKIE)).toContain('HttpOnly');
  });

  it("revokes every other session's refresh token", async () => {
    const user = await createTestUserWithPassword(OLD_PASSWORD);
    const phone = await seedRefreshToken({ userId: user.id });
    const laptop = await seedRefreshToken({ userId: user.id });

    await postChange(user.cookie, {
      currentPassword: OLD_PASSWORD,
      password: NEW_PASSWORD,
    });

    for (const session of [phone, laptop]) {
      const row = await prisma.refreshToken.findUnique({ where: { id: session.id } });
      expect(row?.revokedAt).toBeInstanceOf(Date);

      const refresh = await request(app())
        .post(REFRESH_URL)
        .set('Origin', TEST_ORIGIN)
        .set('Cookie', refreshCookie(session.rawToken))
        .send();
      expect(refresh.status).toBe(401);
    }
  });

  it('leaves another user’s sessions alone', async () => {
    const user = await createTestUserWithPassword(OLD_PASSWORD);
    const other = await createTestUser();
    const otherSession = await seedRefreshToken({ userId: other.id });

    await postChange(user.cookie, {
      currentPassword: OLD_PASSWORD,
      password: NEW_PASSWORD,
    });

    const row = await prisma.refreshToken.findUnique({ where: { id: otherSession.id } });
    expect(row?.revokedAt).toBeNull();
  });

  /**
   * A wrong current password is a **400**, never a 401. The web client treats
   * 401 as "session expired" and runs its refresh-and-retry path, so a 401
   * here would end with the user signed out for mistyping.
   */
  it('refuses a wrong current password with 400 PASSWORD_INCORRECT', async () => {
    const user = await createTestUserWithPassword(OLD_PASSWORD);
    const liveSession = await seedRefreshToken({ userId: user.id });

    const response = await postChange(user.cookie, {
      currentPassword: 'NotMyPassword9',
      password: NEW_PASSWORD,
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('PASSWORD_INCORRECT');

    // Nothing changed and nothing was revoked.
    const row = await prisma.user.findUnique({
      where: { id: user.id },
      select: { passwordHash: true },
    });
    expect(await verifyPassword(row!.passwordHash, OLD_PASSWORD)).toBe(true);
    const session = await prisma.refreshToken.findUnique({ where: { id: liveSession.id } });
    expect(session?.revokedAt).toBeNull();
  });

  it('rejects a new password that fails the policy', async () => {
    const user = await createTestUserWithPassword(OLD_PASSWORD);

    const response = await postChange(user.cookie, {
      currentPassword: OLD_PASSWORD,
      password: 'short',
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('requires a session', async () => {
    const response = await request(app()).post(CHANGE_URL).set('Origin', TEST_ORIGIN).send({
      currentPassword: OLD_PASSWORD,
      password: NEW_PASSWORD,
    });

    expect(response.status).toBe(401);
  });

  it('audits success and failure, with no password in the row', async () => {
    const user = await createTestUserWithPassword(OLD_PASSWORD);

    await postChange(user.cookie, { currentPassword: 'wrong-one-9', password: NEW_PASSWORD });
    await postChange(user.cookie, { currentPassword: OLD_PASSWORD, password: NEW_PASSWORD });

    const failed = await prisma.auditLog.findFirst({
      where: { userId: user.id, action: 'auth.password.change_failed' },
    });
    const changed = await prisma.auditLog.findFirst({
      where: { userId: user.id, action: 'auth.password.changed' },
    });

    expect(failed?.metadata).toMatchObject({ code: 'PASSWORD_INCORRECT' });
    expect(changed).not.toBeNull();

    const dump = JSON.stringify(await prisma.auditLog.findMany());
    expect(dump).not.toContain(OLD_PASSWORD);
    expect(dump).not.toContain(NEW_PASSWORD);
  });
});

describe('PATCH /auth/profile', () => {
  it('updates the name and returns the updated user', async () => {
    const user = await createTestUser();

    const response = await patchProfileRequest(user.cookie, { name: 'Asha Kumar' });

    expect(response.status).toBe(200);
    expect(response.body.user.name).toBe('Asha Kumar');
    expect(response.body.user.email).toBe(user.email);

    const row = await prisma.user.findUnique({
      where: { id: user.id },
      select: { name: true },
    });
    expect(row?.name).toBe('Asha Kumar');
  });

  it('trims the name', async () => {
    const user = await createTestUser();

    const response = await patchProfileRequest(user.cookie, { name: '  Asha Kumar  ' });

    expect(response.body.user.name).toBe('Asha Kumar');
  });

  /**
   * The `.strict()` assertion. Email and phone are identifiers — one carries
   * reset links, the other will carry unlock codes — so changing either needs
   * a verification flow that does not exist. Silently ignoring them would look
   * to the user exactly like a change that worked.
   */
  it('rejects an attempt to change the email or phone', async () => {
    const user = await createTestUser();

    const withEmail = await patchProfileRequest(user.cookie, {
      name: 'Asha Kumar',
      email: 'attacker@example.com',
    });
    expect(withEmail.status).toBe(400);
    expect(withEmail.body.error.code).toBe('VALIDATION_ERROR');

    const withPhone = await patchProfileRequest(user.cookie, {
      name: 'Asha Kumar',
      phone: '9999999999',
    });
    expect(withPhone.status).toBe(400);

    const withRole = await patchProfileRequest(user.cookie, {
      name: 'Asha Kumar',
      role: 'ADMIN',
    });
    expect(withRole.status).toBe(400);

    // None of it was applied — not even the name, which was valid.
    const row = await prisma.user.findUnique({
      where: { id: user.id },
      select: { name: true, email: true, phone: true, role: true },
    });
    expect(row?.email).toBe(user.email);
    expect(row?.phone).toBe(user.phone);
    expect(row?.role).toBe('USER');
    expect(row?.name).not.toBe('Asha Kumar');
  });

  it('rejects a name that fails the policy', async () => {
    const user = await createTestUser();

    const tooShort = await patchProfileRequest(user.cookie, { name: 'A' });
    expect(tooShort.status).toBe(400);
    expect(tooShort.body.error.fields?.name).toBeTruthy();

    const tooLong = await patchProfileRequest(user.cookie, { name: 'A'.repeat(200) });
    expect(tooLong.status).toBe(400);
  });

  it('requires a session', async () => {
    const response = await request(app())
      .patch(PROFILE_URL)
      .set('Origin', TEST_ORIGIN)
      .send({ name: 'Asha Kumar' });

    expect(response.status).toBe(401);
  });

  it('audits the update without recording the name', async () => {
    const user = await createTestUser();

    await patchProfileRequest(user.cookie, { name: 'Asha Kumar' });

    const audit = await prisma.auditLog.findFirst({
      where: { userId: user.id, action: 'auth.profile.updated' },
    });
    expect(audit).not.toBeNull();
    expect(JSON.stringify(audit?.metadata)).not.toContain('Asha Kumar');
  });
});
