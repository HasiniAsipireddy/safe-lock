import { describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { verifyPassword } from '../src/modules/auth/password';
import { MIN_SEED_PASSWORD_LENGTH, SeedError, seedAdmin } from './seed';

const VALID = {
  email: 'admin@example.com',
  password: 'a-long-enough-admin-password',
  name: 'Seeded Admin',
  phone: '9876500001',
};

describe('seedAdmin', () => {
  it('creates an ADMIN with a hashed password', async () => {
    const result = await seedAdmin(VALID);

    expect(result.created).toBe(true);
    expect(result.email).toBe(VALID.email);

    const user = await prisma.user.findUnique({ where: { email: VALID.email } });
    expect(user?.role).toBe('ADMIN');
    expect(user?.name).toBe(VALID.name);
    expect(user?.phone).toBe(VALID.phone);

    // Stored as an argon2 hash, never in the clear.
    expect(user?.passwordHash).not.toContain(VALID.password);
    expect(user?.passwordHash.startsWith('$argon2')).toBe(true);
    expect(await verifyPassword(user!.passwordHash, VALID.password)).toBe(true);
  });

  it('is idempotent — running twice updates rather than failing', async () => {
    const first = await seedAdmin(VALID);
    const second = await seedAdmin(VALID);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);

    // Still exactly one user, and still an ADMIN.
    expect(await prisma.user.count()).toBe(1);
    const user = await prisma.user.findUnique({ where: { email: VALID.email } });
    expect(user?.role).toBe('ADMIN');
  });

  it('rotates the password hash on a re-run', async () => {
    await seedAdmin(VALID);
    const before = await prisma.user.findUnique({ where: { email: VALID.email } });

    await seedAdmin({ ...VALID, password: 'a-different-long-password' });
    const after = await prisma.user.findUnique({ where: { email: VALID.email } });

    expect(after?.passwordHash).not.toBe(before?.passwordHash);
    expect(await verifyPassword(after!.passwordHash, 'a-different-long-password')).toBe(true);
    expect(await verifyPassword(after!.passwordHash, VALID.password)).toBe(false);
  });

  it('re-asserts ADMIN if the role was changed by hand', async () => {
    await seedAdmin(VALID);
    await prisma.user.update({ where: { email: VALID.email }, data: { role: 'USER' } });

    await seedAdmin(VALID);

    const user = await prisma.user.findUnique({ where: { email: VALID.email } });
    expect(user?.role).toBe('ADMIN');
  });

  it(`refuses a password shorter than ${MIN_SEED_PASSWORD_LENGTH} characters`, async () => {
    await expect(seedAdmin({ ...VALID, password: 'short123' })).rejects.toThrow(SeedError);

    // Nothing was written.
    expect(await prisma.user.count()).toBe(0);
  });

  it('refuses a password one character under the limit', async () => {
    const tooShort = 'x'.repeat(MIN_SEED_PASSWORD_LENGTH - 1);

    await expect(seedAdmin({ ...VALID, password: tooShort })).rejects.toThrow(
      /at least 12 characters/,
    );
    expect(await prisma.user.count()).toBe(0);
  });

  it('never puts the password in the error message', async () => {
    // 11 characters: one under the limit, so it is actually rejected.
    const secret = 'tiny-secret';
    await expect(seedAdmin({ ...VALID, password: secret })).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining(secret) as unknown as string,
      }),
    );
  });

  it('requires email, password and phone', async () => {
    await expect(seedAdmin({ ...VALID, email: undefined })).rejects.toThrow(SeedError);
    await expect(seedAdmin({ ...VALID, password: undefined })).rejects.toThrow(SeedError);
    await expect(seedAdmin({ ...VALID, phone: undefined })).rejects.toThrow(SeedError);
    expect(await prisma.user.count()).toBe(0);
  });

  it('rejects an invalid email or phone with the same rules as signup', async () => {
    await expect(seedAdmin({ ...VALID, email: 'not-an-email' })).rejects.toThrow();
    await expect(seedAdmin({ ...VALID, phone: '12345' })).rejects.toThrow();
    expect(await prisma.user.count()).toBe(0);
  });

  it('defaults the name when none is given', async () => {
    await seedAdmin({ ...VALID, name: undefined });

    const user = await prisma.user.findUnique({ where: { email: VALID.email } });
    expect(user?.name).toBe('Safe Lock Admin');
  });
});
