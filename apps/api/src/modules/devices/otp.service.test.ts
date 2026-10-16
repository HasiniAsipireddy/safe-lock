import { describe, expect, it, vi } from 'vitest';
import { OTP_LENGTH } from '@safelock/shared';
import { deliverOtp, generateOtp, hashOtp, mayPrintOtp, verifyOtp } from './otp.service';

describe('generateOtp', () => {
  it(`returns exactly ${OTP_LENGTH} digits`, () => {
    for (let index = 0; index < 200; index += 1) {
      expect(generateOtp()).toMatch(new RegExp(`^\\d{${OTP_LENGTH}}$`));
    }
  });

  it('keeps leading zeros rather than shortening the code', () => {
    // A code of `000123` must stay six characters. Without padStart it would
    // render as `123`, which the input boxes would reject as too short.
    const padded = Array.from({ length: 2000 }, generateOtp).filter((code) =>
      code.startsWith('0'),
    );

    expect(padded.length).toBeGreaterThan(0);
    for (const code of padded) expect(code).toHaveLength(OTP_LENGTH);
  });

  it('does not repeat itself in a short run', () => {
    // Not a randomness proof — a smoke test that would catch a constant or a
    // counter being returned.
    const codes = new Set(Array.from({ length: 500 }, generateOtp));
    expect(codes.size).toBeGreaterThan(450);
  });
});

describe('hashOtp / verifyOtp', () => {
  it('accepts the right code and rejects a wrong one', () => {
    const hash = hashOtp('123456');

    expect(verifyOtp('123456', hash)).toBe(true);
    expect(verifyOtp('123457', hash)).toBe(false);
    expect(verifyOtp('000000', hash)).toBe(false);
  });

  it('is deterministic, so a stored hash stays verifiable', () => {
    expect(hashOtp('424242')).toBe(hashOtp('424242'));
  });

  it('is keyed, not a bare digest of the code', () => {
    // A plain sha256('123456') is a well-known constant. If this ever matched,
    // the secret would not be in play and a database dump would be reversible
    // with a rainbow table of 10^6 entries.
    expect(hashOtp('123456')).not.toBe(
      '8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92',
    );
  });

  it('never reveals the code in the hash', () => {
    expect(hashOtp('135790')).not.toContain('135790');
  });

  it('returns false for a malformed stored hash instead of throwing', () => {
    // timingSafeEqual throws on a length mismatch. A truncated or corrupted
    // row must be a failed verification, not a 500.
    expect(verifyOtp('123456', 'deadbeef')).toBe(false);
    expect(verifyOtp('123456', '')).toBe(false);
    expect(verifyOtp('123456', 'zz'.repeat(32))).toBe(false);
  });
});

describe('mayPrintOtp — the production guard', () => {
  it('allows the console print only in development and test', () => {
    expect(mayPrintOtp('development')).toBe(true);
    expect(mayPrintOtp('test')).toBe(true);
  });

  it('refuses in production', () => {
    expect(mayPrintOtp('production')).toBe(false);
  });

  it('refuses for any unexpected value, so the default is silence', () => {
    // NODE_ENV unset, misspelled, or set by a platform to something else must
    // never fall through to printing an unlock code.
    for (const value of ['', 'prod', 'Production', 'staging', 'DEVELOPMENT', 'undefined']) {
      expect(mayPrintOtp(value)).toBe(false);
    }
  });
});

describe('deliverOtp', () => {
  it('prints the code under the test environment', async () => {
    // The suite runs with NODE_ENV=test, so the dev branch is the live one
    // here. This asserts the branch works at all — `mayPrintOtp` above is
    // what pins it shut in production.
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      // No such user, so delivery itself is skipped — this test is only about
      // the console branch. The WhatsApp path is covered against the fake
      // client in deviceControl.routes.test.ts.
      await deliverOtp({
        userId: 'usr_does_not_exist',
        code: '987654',
        serialNumber: 'SAFE-0001',
        expiresAt: new Date('2026-10-16T12:00:00.000Z'),
      });

      expect(spy).toHaveBeenCalledOnce();
      expect(String(spy.mock.calls[0]?.[0])).toContain('987654');
    } finally {
      spy.mockRestore();
    }
  });
});
