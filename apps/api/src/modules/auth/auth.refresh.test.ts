import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '../../lib/prisma';
import {
  TEST_ORIGIN,
  app,
  cookieValue,
  createTestUser,
  refreshCookie,
  seedRefreshToken,
  setCookieFor,
} from '../../test/helpers';
import { ACCESS_COOKIE, REFRESH_COOKIE } from './tokens';
import { REFRESH_GRACE_WINDOW_MS, hashRefreshToken } from './refreshToken.service';

const REFRESH_URL = '/api/v1/auth/refresh';

function postRefresh(rawToken?: string) {
  const req = request(app()).post(REFRESH_URL).set('Origin', TEST_ORIGIN);
  if (rawToken) req.set('Cookie', refreshCookie(rawToken));
  return req.send();
}

/** Moves a row's revokedAt into the past to simulate the window elapsing. */
async function backdateRevocation(tokenId: string, msAgo: number): Promise<void> {
  await prisma.refreshToken.update({
    where: { id: tokenId },
    data: { revokedAt: new Date(Date.now() - msAgo) },
  });
}

describe('POST /api/v1/auth/refresh — rotation', () => {
  it('issues a new token, revokes the old one, and links them', async () => {
    const user = await createTestUser();
    const original = await seedRefreshToken({ userId: user.id });

    const response = await postRefresh(original.rawToken);

    expect(response.status).toBe(200);
    expect(response.body.user.id).toBe(user.id);

    const issued = cookieValue(response, REFRESH_COOKIE);
    expect(issued).toBeTruthy();
    // The rotated token is genuinely new, not the one we sent back.
    expect(issued).not.toBe(original.rawToken);

    // A fresh access token comes with it.
    expect(cookieValue(response, ACCESS_COOKIE)).toBeTruthy();

    const oldRow = await prisma.refreshToken.findUnique({ where: { id: original.id } });
    expect(oldRow?.revokedAt).toBeInstanceOf(Date);
    expect(oldRow?.replacedById).toBeTruthy();

    const successor = await prisma.refreshToken.findUnique({
      where: { tokenHash: hashRefreshToken(issued!) },
    });
    expect(successor).not.toBeNull();
    expect(successor?.id).toBe(oldRow?.replacedById);
    // Same family: one login, one chain.
    expect(successor?.familyId).toBe(original.familyId);
    expect(successor?.revokedAt).toBeNull();

    const audit = await prisma.auditLog.findFirst({
      where: { userId: user.id, action: 'auth.refresh.rotated' },
    });
    expect(audit).not.toBeNull();
  });

  it('stores only a hash — the raw token never appears in the database', async () => {
    const user = await createTestUser();
    const original = await seedRefreshToken({ userId: user.id });

    const response = await postRefresh(original.rawToken);
    const issued = cookieValue(response, REFRESH_COOKIE)!;

    const rows = await prisma.refreshToken.findMany({ where: { userId: user.id } });
    for (const row of rows) {
      expect(row.tokenHash).not.toBe(issued);
      expect(row.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    }
    // The hash of the issued token is what is stored.
    expect(rows.some((row) => row.tokenHash === hashRefreshToken(issued))).toBe(true);
  });

  it('lets the newly issued token rotate again', async () => {
    const user = await createTestUser();
    const original = await seedRefreshToken({ userId: user.id });

    const first = await postRefresh(original.rawToken);
    const second = await postRefresh(cookieValue(first, REFRESH_COOKIE)!);

    expect(second.status).toBe(200);
    expect(cookieValue(second, REFRESH_COOKIE)).toBeTruthy();
    // Three rows now: original, successor, successor's successor.
    expect(await prisma.refreshToken.count({ where: { userId: user.id } })).toBe(3);
  });
});

describe('POST /api/v1/auth/refresh — cookie scoping', () => {
  it('scopes the refresh cookie to the auth path and the access cookie to root', async () => {
    const user = await createTestUser();
    const original = await seedRefreshToken({ userId: user.id });

    const response = await postRefresh(original.rawToken);

    const refreshHeader = setCookieFor(response, REFRESH_COOKIE)!;
    const accessHeader = setCookieFor(response, ACCESS_COOKIE)!;

    // The refresh token must never be sent to payment, device or admin routes.
    expect(refreshHeader).toContain('Path=/api/v1/auth');
    expect(refreshHeader).toContain('HttpOnly');
    expect(refreshHeader).toContain('SameSite=Lax');

    expect(accessHeader).toContain('Path=/');
    expect(accessHeader).toContain('HttpOnly');
    expect(accessHeader).toContain('SameSite=Lax');

    // Not secure in test/development, so http://localhost works.
    expect(refreshHeader).not.toContain('Secure');
  });

  it('sets the same scoping on login', async () => {
    // Signup through the real endpoint so the login path is exercised too.
    const signup = await request(app())
      .post('/api/v1/auth/signup')
      .set('Origin', TEST_ORIGIN)
      .send({
        name: 'Cookie Scope',
        email: 'cookie.scope@example.com',
        phone: '9811122233',
        password: 'ScopeTest1234',
      });

    expect(signup.status).toBe(201);
    expect(setCookieFor(signup, REFRESH_COOKIE)).toContain('Path=/api/v1/auth');

    const login = await request(app())
      .post('/api/v1/auth/login')
      .set('Origin', TEST_ORIGIN)
      .send({ identifier: 'cookie.scope@example.com', password: 'ScopeTest1234' });

    expect(login.status).toBe(200);
    expect(setCookieFor(login, REFRESH_COOKIE)).toContain('Path=/api/v1/auth');
    expect(setCookieFor(login, ACCESS_COOKIE)).toContain('Path=/');
  });
});

describe('POST /api/v1/auth/refresh — reuse detection', () => {
  it('revokes the whole family when a revoked token is replayed after the grace window', async () => {
    const user = await createTestUser();
    const original = await seedRefreshToken({ userId: user.id });

    // Rotate once, then age the revocation past the window.
    const rotated = await postRefresh(original.rawToken);
    const successorToken = cookieValue(rotated, REFRESH_COOKIE)!;
    await backdateRevocation(original.id, REFRESH_GRACE_WINDOW_MS + 5_000);

    const replay = await postRefresh(original.rawToken);

    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('REFRESH_REUSE_DETECTED');

    // Every token in the family is dead, including the legitimate successor.
    const family = await prisma.refreshToken.findMany({
      where: { familyId: original.familyId },
    });
    expect(family.length).toBeGreaterThanOrEqual(2);
    for (const row of family) {
      expect(row.revokedAt).toBeInstanceOf(Date);
    }

    // And the successor can no longer be redeemed.
    const afterKill = await postRefresh(successorToken);
    expect(afterKill.status).toBe(401);

    const audit = await prisma.auditLog.findFirst({
      where: { userId: user.id, action: 'auth.refresh.reuse_detected' },
    });
    expect(audit).not.toBeNull();

    // The cookies are cleared so the browser stops presenting a dead token.
    expect(setCookieFor(replay, REFRESH_COOKIE)).toBeTruthy();
  });

  it('kills grace-window siblings too when the family is revoked', async () => {
    const user = await createTestUser();
    const original = await seedRefreshToken({ userId: user.id });

    // Rotate, then mint a sibling inside the grace window (two tabs racing).
    const rotated = await postRefresh(original.rawToken);
    const successorToken = cookieValue(rotated, REFRESH_COOKIE)!;

    const graced = await postRefresh(original.rawToken);
    expect(graced.status).toBe(200);
    const siblingToken = cookieValue(graced, REFRESH_COOKIE)!;

    // Three live-or-dead rows in one family: original, successor, sibling.
    expect(await prisma.refreshToken.count({ where: { familyId: original.familyId } })).toBe(3);

    // Now replay the original outside the window — a second grace use is
    // refused and treated as theft.
    await backdateRevocation(original.id, REFRESH_GRACE_WINDOW_MS + 5_000);
    const replay = await postRefresh(original.rawToken);
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('REFRESH_REUSE_DETECTED');

    const family = await prisma.refreshToken.findMany({
      where: { familyId: original.familyId },
    });
    for (const row of family) {
      expect(row.revokedAt).toBeInstanceOf(Date);
    }

    // Both the successor and the sibling are now unusable.
    expect((await postRefresh(successorToken)).status).toBe(401);
    expect((await postRefresh(siblingToken)).status).toBe(401);
  });

  it('revokes other families for the same user as well', async () => {
    const user = await createTestUser();
    const sessionA = await seedRefreshToken({ userId: user.id });
    const sessionB = await seedRefreshToken({ userId: user.id });

    await postRefresh(sessionA.rawToken);
    await backdateRevocation(sessionA.id, REFRESH_GRACE_WINDOW_MS + 5_000);
    await postRefresh(sessionA.rawToken);

    // A leaked token means we cannot trust any session for that user.
    const other = await prisma.refreshToken.findUnique({ where: { id: sessionB.id } });
    expect(other?.revokedAt).toBeInstanceOf(Date);
    expect((await postRefresh(sessionB.rawToken)).status).toBe(401);
  });

  it('does not touch another user when a reuse is detected', async () => {
    const victim = await createTestUser();
    const bystander = await createTestUser();
    const victimToken = await seedRefreshToken({ userId: victim.id });
    const bystanderToken = await seedRefreshToken({ userId: bystander.id });

    await postRefresh(victimToken.rawToken);
    await backdateRevocation(victimToken.id, REFRESH_GRACE_WINDOW_MS + 5_000);
    await postRefresh(victimToken.rawToken);

    const untouched = await prisma.refreshToken.findUnique({
      where: { id: bystanderToken.id },
    });
    expect(untouched?.revokedAt).toBeNull();
    expect((await postRefresh(bystanderToken.rawToken)).status).toBe(200);
  });
});

describe('POST /api/v1/auth/refresh — grace window', () => {
  it('returns a working session without revoking the family, inside 10 seconds', async () => {
    const user = await createTestUser();
    const original = await seedRefreshToken({ userId: user.id });

    // Tab 1 rotates.
    const first = await postRefresh(original.rawToken);
    const successorToken = cookieValue(first, REFRESH_COOKIE)!;

    // Tab 2 presents the same old token immediately afterwards.
    const second = await postRefresh(original.rawToken);

    expect(second.status).toBe(200);
    expect(second.body.user.id).toBe(user.id);

    const siblingToken = cookieValue(second, REFRESH_COOKIE)!;
    expect(siblingToken).toBeTruthy();
    expect(siblingToken).not.toBe(successorToken);

    // Nothing was treated as theft: both tabs keep working.
    expect((await postRefresh(successorToken)).status).toBe(200);
    expect((await postRefresh(siblingToken)).status).toBe(200);

    expect(
      await prisma.auditLog.count({
        where: { userId: user.id, action: 'auth.refresh.reuse_detected' },
      }),
    ).toBe(0);
  });

  it('audits the grace use with ip and user agent', async () => {
    const user = await createTestUser();
    const original = await seedRefreshToken({ userId: user.id });

    await postRefresh(original.rawToken);

    await request(app())
      .post(REFRESH_URL)
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', refreshCookie(original.rawToken))
      .set('User-Agent', 'SafeLockTest/1.0')
      .send();

    const audit = await prisma.auditLog.findFirst({
      where: { userId: user.id, action: 'auth.refresh.grace_used' },
    });
    expect(audit).not.toBeNull();
    expect(audit?.userAgent).toBe('SafeLockTest/1.0');
    expect(audit?.ip).toBeTruthy();
  });

  it('marks graceUsedAt and allows only ONE sibling per rotated token', async () => {
    const user = await createTestUser();
    const original = await seedRefreshToken({ userId: user.id });

    await postRefresh(original.rawToken);

    const firstGrace = await postRefresh(original.rawToken);
    expect(firstGrace.status).toBe(200);

    const row = await prisma.refreshToken.findUnique({ where: { id: original.id } });
    expect(row?.graceUsedAt).toBeInstanceOf(Date);

    // A second grace-window presentation of the same token is reuse, even
    // though it is still inside the 10 seconds.
    const secondGrace = await postRefresh(original.rawToken);
    expect(secondGrace.status).toBe(401);
    expect(secondGrace.body.error.code).toBe('REFRESH_REUSE_DETECTED');

    const family = await prisma.refreshToken.findMany({
      where: { familyId: original.familyId },
    });
    for (const member of family) {
      expect(member.revokedAt).toBeInstanceOf(Date);
    }
  });
});

describe('POST /api/v1/auth/refresh — rejections', () => {
  it('rejects an expired token', async () => {
    const user = await createTestUser();
    const expired = await seedRefreshToken({
      userId: user.id,
      expiresAt: new Date(Date.now() - 60_000),
    });

    const response = await postRefresh(expired.rawToken);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('REFRESH_TOKEN_INVALID');
    expect(response.body.error.requestId).toBeTruthy();

    // An expired token is not a theft signal, so nothing else is revoked.
    expect(
      await prisma.auditLog.count({ where: { action: 'auth.refresh.reuse_detected' } }),
    ).toBe(0);
  });

  it('rejects an unknown token', async () => {
    const response = await postRefresh('completely-made-up-token-value');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('REFRESH_TOKEN_INVALID');
  });

  it('rejects a request with no refresh cookie', async () => {
    const response = await postRefresh();

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('REFRESH_TOKEN_INVALID');
  });

  it('rejects a token whose user has been deleted', async () => {
    const user = await createTestUser();
    const token = await seedRefreshToken({ userId: user.id });
    await prisma.user.delete({ where: { id: user.id } });

    const response = await postRefresh(token.rawToken);
    expect(response.status).toBe(401);
  });
});

describe('POST /api/v1/auth/logout', () => {
  it('revokes the presented refresh token server-side', async () => {
    const user = await createTestUser();
    const token = await seedRefreshToken({ userId: user.id });

    const response = await request(app())
      .post('/api/v1/auth/logout')
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', [user.cookie, refreshCookie(token.rawToken)].join('; '))
      .send();

    expect(response.status).toBe(204);

    const row = await prisma.refreshToken.findUnique({ where: { id: token.id } });
    expect(row?.revokedAt).toBeInstanceOf(Date);

    // A copy of the token taken off the wire is now worthless. Note it lands
    // on the reuse path (it is revoked), which is the correct, stricter
    // outcome — not a quiet success.
    const afterLogout = await postRefresh(token.rawToken);
    expect(afterLogout.status).toBe(401);
  });

  it('still clears cookies when no refresh cookie is presented', async () => {
    const user = await createTestUser();

    const response = await request(app())
      .post('/api/v1/auth/logout')
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', user.cookie)
      .send();

    expect(response.status).toBe(204);
    expect(setCookieFor(response, ACCESS_COOKIE)).toBeTruthy();
    expect(setCookieFor(response, REFRESH_COOKIE)).toBeTruthy();
  });
});
