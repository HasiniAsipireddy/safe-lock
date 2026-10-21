import { describe, expect, it } from 'vitest';
import { maskPhone } from '@safelock/shared';
import { sanitise } from './logger';

/**
 * The log redaction backstop.
 *
 * `sanitise` is what catches a sensitive value whose key nobody remembered to
 * add to pino's `redact` path list. It runs on the merged object of every log
 * call, so these assertions are the difference between "we intend not to log
 * OTPs" and "an OTP cannot reach a log line through a plausible mistake".
 */

const REDACTED = '[redacted]';

function redactedValue(key: string, value: unknown): unknown {
  return (sanitise({ [key]: value }) as Record<string, unknown>)[key];
}

describe('sanitise', () => {
  it('redacts the obvious credential keys', () => {
    for (const key of [
      'password',
      'passwordHash',
      'otp',
      'otpHash',
      'token',
      'rawToken',
      'tokenHash',
      'accessToken',
      'refreshToken',
      'resetToken',
      'secret',
      'appSecret',
      'signature',
      'authorization',
      'cookie',
      'credentialHash',
      'apiKey',
      /**
       * The device command key, added with provisioning. It is the one secret
       * in this system that is **derived and never stored**, which makes a log
       * line the only place it could persist — so the backstop is the whole of
       * its protection rather than a second layer.
       */
      'commandKey',
    ]) {
      expect(redactedValue(key, 'sensitive-value'), key).toBe(REDACTED);
    }
  });

  /** Added with WhatsApp delivery: a log store is no place for customer mobiles. */
  it('redacts phone numbers and message recipients', () => {
    for (const key of ['phone', 'mobile', 'msisdn', 'recipient', 'to', 'phoneNumber']) {
      expect(redactedValue(key, '+919876543210'), key).toBe(REDACTED);
    }
  });

  /** Template params are exactly where an OTP sits in a send payload. */
  it('redacts template parameters and message bodies', () => {
    expect(redactedValue('templateParams', ['123456'])).toBe(REDACTED);
    expect(redactedValue('body', 'Your code is 123456')).toBe(REDACTED);
  });

  it('keeps values that only sound sensitive', () => {
    expect(redactedValue('hasPaid', true)).toBe(true);
    expect(redactedValue('phoneVerified', true)).toBe(true);
    expect(redactedValue('tokenType', 'access')).toBe('access');
    expect(redactedValue('templateName', 'safelock_unlock_code')).toBe(
      'safelock_unlock_code',
    );
  });

  /**
   * The one phone representation that survives, because it is masked by
   * construction — otherwise there would be no way to tie a delivery failure
   * to a number while investigating one.
   */
  it('keeps an already-masked phone number', () => {
    const masked = maskPhone('9876543210');
    expect(redactedValue('maskedPhone', masked)).toBe(masked);
    expect(masked).not.toContain('76543');
  });

  it('redacts at depth, not just at the top level', () => {
    const output = sanitise({
      send: { provider: 'fake', to: '+919876543210', templateParams: ['123456'] },
      nested: [{ otp: '123456' }],
    }) as Record<string, Record<string, unknown>>;

    expect(output.send!.to).toBe(REDACTED);
    expect(output.send!.templateParams).toBe(REDACTED);
    expect(output.send!.provider).toBe('fake');
    expect(JSON.stringify(output)).not.toContain('123456');
    expect(JSON.stringify(output)).not.toContain('9876543210');
  });

  it('is case-insensitive about key names', () => {
    expect(redactedValue('OTP', '123456')).toBe(REDACTED);
    expect(redactedValue('Phone', '+919876543210')).toBe(REDACTED);
    expect(redactedValue('Authorization', 'Bearer x')).toBe(REDACTED);
  });

  it('leaves ordinary diagnostic fields alone', () => {
    const output = sanitise({
      userId: 'usr_1',
      deviceId: 'dev_1',
      serialNumber: 'SAFE-0001',
      status: 'PENDING',
      attempts: 2,
      requestId: 'abc-123',
    });

    expect(output).toEqual({
      userId: 'usr_1',
      deviceId: 'dev_1',
      serialNumber: 'SAFE-0001',
      status: 'PENDING',
      attempts: 2,
      requestId: 'abc-123',
    });
  });

  it('handles the shapes a logger actually receives', () => {
    expect(sanitise(null)).toBeNull();
    expect(sanitise(undefined)).toBeUndefined();
    expect(sanitise('plain')).toBe('plain');
    expect(sanitise(42)).toBe(42);

    const error = new Error('boom');
    const serialised = sanitise(error) as { name: string; message: string };
    expect(serialised.name).toBe('Error');
    expect(serialised.message).toBe('boom');
  });

  /** Guards against a cyclic or absurdly deep object becoming a hang. */
  it('truncates beyond a bounded depth', () => {
    let deep: Record<string, unknown> = { otp: '123456' };
    for (let index = 0; index < 12; index += 1) deep = { level: deep };

    expect(JSON.stringify(sanitise(deep))).not.toContain('123456');
    expect(JSON.stringify(sanitise(deep))).toContain('[truncated]');
  });
});
