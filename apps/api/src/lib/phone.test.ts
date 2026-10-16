import { describe, expect, it } from 'vitest';
import {
  maskPhone,
  phoneE164Schema,
  toE164,
  toNationalPhone,
} from '@safelock/shared';

/**
 * Phone normalisation lives in `@safelock/shared`, but the only vitest runner
 * in the repo is this workspace's, so its tests live here — the same place the
 * shared OTP and serial schemas are exercised from.
 *
 * These are pure functions over strings: no database, no app, no fixtures.
 */

describe('toE164', () => {
  it('accepts every format a person might type', () => {
    for (const input of [
      '9876543210',
      ' 9876543210 ',
      '98765 43210',
      '98765-43210',
      '(98765) 43210',
      '09876543210',
      '+919876543210',
      '+91 98765 43210',
      '919876543210',
      '00919876543210',
    ]) {
      expect(toE164(input), input).toBe('+919876543210');
    }
  });

  it('accepts every valid Indian mobile prefix', () => {
    for (const first of ['6', '7', '8', '9']) {
      expect(toE164(`${first}876543210`)).toBe(`+91${first}876543210`);
    }
  });

  it('rejects anything that is not an Indian mobile', () => {
    for (const input of [
      '',
      '   ',
      '5876543210', // landline-style prefix
      '1234567890',
      '987654321', // 9 digits
      '98765432101', // 11 digits
      '+14155552671', // valid E.164, wrong country
      '+449876543210',
      '+9198765432100',
      'nine',
      '98765abcde',
      '+91-98765-4321O', // letter O, not zero
      '<script>9876543210</script>',
      "9876543210'; DROP TABLE \"User\"; --",
    ]) {
      expect(toE164(input), JSON.stringify(input)).toBeNull();
    }
  });

  /** A normaliser that is not idempotent will double-strip a country code. */
  it('is idempotent', () => {
    const once = toE164('9876543210')!;
    expect(toE164(once)).toBe(once);
    expect(toE164(toE164(once)!)).toBe(once);
  });
});

describe('toNationalPhone', () => {
  it('returns the 10-digit form the User.phone column stores', () => {
    expect(toNationalPhone('+919876543210')).toBe('9876543210');
  });

  it('refuses anything that is not a +91 mobile', () => {
    for (const input of ['9876543210', '+14155552671', '+91987654321', '', '+91abcdefghij']) {
      expect(toNationalPhone(input), input).toBeNull();
    }
  });

  /** The pair must round-trip, or one physical number could exist twice. */
  it('round-trips with toE164', () => {
    const national = '9876543210';
    expect(toNationalPhone(toE164(national)!)).toBe(national);
  });
});

describe('maskPhone', () => {
  it('shows only the first two and last two digits', () => {
    expect(maskPhone('+919876543210')).toBe('+91 98****10');
    // Accepts either stored representation, and masks both the same way.
    expect(maskPhone('9876543210')).toBe('+91 98****10');
  });

  /**
   * A fixed-width mask, so the output says nothing about how many digits it
   * hides. Indian mobiles are all 10 digits today, but the property should not
   * depend on that.
   */
  it('uses a fixed four asterisks', () => {
    expect(maskPhone('9876543210')).toContain('****');
    expect(maskPhone('9876543210')).not.toContain('*****');
  });

  it('never echoes an unparseable value back', () => {
    // The point: a malformed number cannot be laundered into a log line.
    expect(maskPhone('not-a-number')).toBe('(hidden)');
    expect(maskPhone('+14155552671')).toBe('(hidden)');
    expect(maskPhone('<script>alert(1)</script>')).toBe('(hidden)');
    expect(maskPhone(null)).toBe('(none)');
    expect(maskPhone(undefined)).toBe('(none)');
    expect(maskPhone('')).toBe('(none)');
  });

  it('leaks no more than four of the ten digits', () => {
    const masked = maskPhone('9876543210');
    for (const hidden of ['7654', '543', '76543']) {
      expect(masked).not.toContain(hidden);
    }
  });
});

describe('phoneE164Schema', () => {
  it('normalises inside validation, so a handler never sees a raw format', () => {
    expect(phoneE164Schema.parse('98765 43210')).toBe('+919876543210');
    expect(phoneE164Schema.parse('+91 98765 43210')).toBe('+919876543210');
  });

  it('rejects an invalid number with a message a form can show', () => {
    const result = phoneE164Schema.safeParse('12345');
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/valid 10-digit Indian mobile/i);
  });

  /** Bounded before parsing: a huge string must be cheap to refuse. */
  it('refuses an oversized value on length alone', () => {
    const result = phoneE164Schema.safeParse('9'.repeat(5000));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/too long/i);
  });
});
