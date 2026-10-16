import { afterEach, describe, expect, it, vi } from 'vitest';
import { NETWORK_BLOCKED_MESSAGE } from '../../test/setup';
import { FakeWhatsAppClient, mayUseFakeWhatsApp } from './fake.client';
import { categorise } from './cloudApi.client';
import { WhatsAppError, isRetryable } from './client';

/**
 * The WhatsApp client layer.
 *
 * Everything here runs without a network: the fake client has none, and the
 * Cloud API client is driven against a stubbed `fetch`. The suite blocks
 * `fetch` globally (see `test/setup.ts`), and the first test below proves it.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the suite cannot reach the network', () => {
  /**
   * The guard that makes "no test ever sends a real message" enforceable
   * rather than a promise. If someone writes a client without a fake, or
   * forgets to stub, the test fails instead of messaging a real phone.
   */
  it('blocks fetch unless a test stubs it', async () => {
    await expect(fetch('https://graph.facebook.com/v21.0/x/messages')).rejects.toThrow(
      NETWORK_BLOCKED_MESSAGE,
    );
  });

  it('restores the block after a test stubs fetch', async () => {
    vi.stubGlobal('fetch', vi.fn());
    vi.unstubAllGlobals();

    await expect(fetch('https://example.test')).rejects.toThrow(NETWORK_BLOCKED_MESSAGE);
  });
});

describe('mayUseFakeWhatsApp', () => {
  /**
   * Same shape and same reason as `mayPrintOtp`: the default for anything
   * unrecognised must be "no fake". A production deployment that recorded
   * unlock codes to memory would look healthy and open nothing.
   */
  it('allows only development and test', () => {
    expect(mayUseFakeWhatsApp('development')).toBe(true);
    expect(mayUseFakeWhatsApp('test')).toBe(true);
    expect(mayUseFakeWhatsApp('production')).toBe(false);
    expect(mayUseFakeWhatsApp('Production')).toBe(false);
    expect(mayUseFakeWhatsApp('staging')).toBe(false);
    expect(mayUseFakeWhatsApp('')).toBe(false);
    expect(mayUseFakeWhatsApp('tes')).toBe(false);
  });
});

describe('FakeWhatsAppClient', () => {
  const send = {
    to: '+919876543210',
    templateName: 'safelock_unlock_code',
    language: 'en',
    params: ['123456', 'SAFE-0001'],
  };

  it('records what it was asked to send and returns a message id', async () => {
    const client = new FakeWhatsAppClient();

    const result = await client.sendTemplate(send);

    expect(result.providerMessageId).toMatch(/^wamid\./);
    expect(client.sent()).toHaveLength(1);
    expect(client.last()).toMatchObject({
      to: '+919876543210',
      templateName: 'safelock_unlock_code',
      language: 'en',
      params: ['123456', 'SAFE-0001'],
    });
  });

  it('copies the params rather than holding the caller’s array', async () => {
    const client = new FakeWhatsAppClient();
    const params = ['123456'];

    await client.sendTemplate({ ...send, params });
    params[0] = 'mutated';

    expect(client.last()?.params).toEqual(['123456']);
  });

  it('issues a distinct message id per send', async () => {
    const client = new FakeWhatsAppClient();

    const first = await client.sendTemplate(send);
    const second = await client.sendTemplate(send);

    expect(first.providerMessageId).not.toBe(second.providerMessageId);
  });

  it('can be told to fail a fixed number of sends, then recover', async () => {
    const client = new FakeWhatsAppClient();
    client.failNext('TRANSPORT', 2);

    await expect(client.sendTemplate(send)).rejects.toBeInstanceOf(WhatsAppError);
    await expect(client.sendTemplate(send)).rejects.toBeInstanceOf(WhatsAppError);
    // Third one succeeds — this is what lets a retry test be deterministic.
    await expect(client.sendTemplate(send)).resolves.toMatchObject({
      providerMessageId: expect.stringMatching(/^wamid\./),
    });
    expect(client.sent()).toHaveLength(1);
  });

  it('can fail every send until told to recover', async () => {
    const client = new FakeWhatsAppClient();
    client.failAlways('AUTH');

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(client.sendTemplate(send)).rejects.toMatchObject({ category: 'AUTH' });
    }

    client.recover();
    await expect(client.sendTemplate(send)).resolves.toBeDefined();
  });

  it('records nothing for a failed send', async () => {
    const client = new FakeWhatsAppClient();
    client.failNext();

    await expect(client.sendTemplate(send)).rejects.toThrow();

    expect(client.sent()).toHaveLength(0);
    expect(client.last()).toBeNull();
  });

  it('filters by template, for tests that assert on one kind', async () => {
    const client = new FakeWhatsAppClient();

    await client.sendTemplate(send);
    await client.sendTemplate({ ...send, templateName: 'safelock_unlock_alert', params: [] });

    expect(client.sentWithTemplate('safelock_unlock_code')).toHaveLength(1);
    expect(client.sentWithTemplate('safelock_unlock_alert')).toHaveLength(1);
    expect(client.sentWithTemplate('nope')).toHaveLength(0);
  });

  it('reset forgets both messages and planned failures', async () => {
    const client = new FakeWhatsAppClient();
    await client.sendTemplate(send);
    client.failAlways();

    client.reset();

    expect(client.sent()).toHaveLength(0);
    await expect(client.sendTemplate(send)).resolves.toBeDefined();
  });
});

describe('error categories', () => {
  it('marks only the hopeless ones as terminal', () => {
    expect(isRetryable('TRANSPORT')).toBe(true);
    expect(isRetryable('RATE_LIMITED')).toBe(true);
    // Unknown is retryable on purpose: the attempt cap bounds being wrong.
    expect(isRetryable('UNKNOWN')).toBe(true);

    expect(isRetryable('INVALID_NUMBER')).toBe(false);
    expect(isRetryable('TEMPLATE')).toBe(false);
    expect(isRetryable('AUTH')).toBe(false);
  });

  it('maps Meta status and error codes onto categories', () => {
    expect(categorise(401)).toBe('AUTH');
    expect(categorise(403)).toBe('AUTH');
    expect(categorise(400, 190)).toBe('AUTH');

    expect(categorise(400, 131026)).toBe('INVALID_NUMBER');
    expect(categorise(400, 131047)).toBe('INVALID_NUMBER');

    expect(categorise(400, 132000)).toBe('TEMPLATE');
    expect(categorise(400, 132015)).toBe('TEMPLATE');
    // A 400 we cannot place is still ours to fix, so not worth retrying.
    expect(categorise(400)).toBe('TEMPLATE');

    expect(categorise(429)).toBe('RATE_LIMITED');
    expect(categorise(400, 80007)).toBe('RATE_LIMITED');
    expect(categorise(400, 130429)).toBe('RATE_LIMITED');

    expect(categorise(500)).toBe('TRANSPORT');
    expect(categorise(503)).toBe('TRANSPORT');

    expect(categorise(418)).toBe('UNKNOWN');
  });

  it('never carries message content on the error', () => {
    const error = new WhatsAppError('TEMPLATE', 'WhatsApp rejected the send (400)', {
      status: 400,
      providerCode: 132001,
    });

    const serialised = JSON.stringify({
      message: error.message,
      category: error.category,
      status: error.status,
      providerCode: error.providerCode,
    });
    expect(serialised).not.toContain('123456');
    expect(error.message).not.toMatch(/\d{6}/);
  });
});
