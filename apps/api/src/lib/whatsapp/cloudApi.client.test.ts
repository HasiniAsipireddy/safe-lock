import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudApiWhatsAppClient } from './cloudApi.client';
import { WhatsAppError } from './client';

/**
 * The Cloud API client, driven entirely against a stubbed `fetch`.
 *
 * **No test here touches the network.** The suite blocks `fetch` globally
 * (`test/setup.ts`); each test below replaces it with a stub that returns a
 * canned Graph API response, and `vi.unstubAllGlobals` puts the block back.
 *
 * The client needs `WHATSAPP_ACCESS_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID` to
 * construct, which the vitest env supplies — they are throwaway strings and
 * are never sent anywhere, since nothing leaves the stub.
 */

const SEND = {
  to: '+919876543210',
  templateName: 'safelock_unlock_code',
  language: 'en',
  params: ['123456'],
} as const;

/** A stub standing in for one Graph API response. */
function stubFetch(
  response: { status?: number; body?: unknown } | { throws: Error },
): ReturnType<typeof vi.fn> {
  const stub = vi.fn(async () => {
    if ('throws' in response) throw response.throws;

    const status = response.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => response.body ?? {},
    } as unknown as Response;
  });

  vi.stubGlobal('fetch', stub);
  return stub;
}

function okBody(id = 'wamid.HBgMOTE5ODc2NTQzMjEwFQIAERgS') {
  return { messaging_product: 'whatsapp', messages: [{ id }] };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CloudApiWhatsAppClient', () => {
  it('posts a template message and returns the provider message id', async () => {
    const stub = stubFetch({ body: okBody('wamid.TESTID') });

    const result = await new CloudApiWhatsAppClient().sendTemplate(SEND);

    expect(result.providerMessageId).toBe('wamid.TESTID');
    expect(stub).toHaveBeenCalledTimes(1);

    const [url, init] = stub.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/^https:\/\/graph\.facebook\.com\/v[\d.]+\/.+\/messages$/);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^Bearer /);
  });

  it('sends the shape Meta expects, with the plus stripped from the number', async () => {
    const stub = stubFetch({ body: okBody() });

    await new CloudApiWhatsAppClient().sendTemplate(SEND);

    const [, init] = stub.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(init.body as string);

    expect(payload).toMatchObject({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      // Meta wants E.164 digits with no leading plus.
      to: '919876543210',
      type: 'template',
      template: {
        name: 'safelock_unlock_code',
        language: { code: 'en' },
        components: [{ type: 'body', parameters: [{ type: 'text', text: '123456' }] }],
      },
    });
  });

  it('omits the components array when a template takes no parameters', async () => {
    const stub = stubFetch({ body: okBody() });

    await new CloudApiWhatsAppClient().sendTemplate({ ...SEND, params: [] });

    const [, init] = stub.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).template.components).toEqual([]);
  });

  /**
   * The central rule of this client. A send is not idempotent — Meta may have
   * delivered the message before the response was lost — so a blind retry
   * risks a second unlock code on someone's phone. Retrying is the outbox
   * worker's decision, with a cap.
   */
  it('never retries, whatever the failure', async () => {
    for (const failure of [
      { status: 500, body: {} },
      { status: 429, body: { error: { code: 130429 } } },
      { throws: Object.assign(new Error('timed out'), { name: 'TimeoutError' }) },
    ]) {
      const stub = stubFetch(failure);

      await expect(new CloudApiWhatsAppClient().sendTemplate(SEND)).rejects.toBeInstanceOf(
        WhatsAppError,
      );

      expect(stub).toHaveBeenCalledTimes(1);
      vi.unstubAllGlobals();
    }
  });

  it('classifies a timeout as transport', async () => {
    stubFetch({ throws: Object.assign(new Error('x'), { name: 'TimeoutError' }) });

    await expect(new CloudApiWhatsAppClient().sendTemplate(SEND)).rejects.toMatchObject({
      category: 'TRANSPORT',
      message: 'WhatsApp request timed out',
    });
  });

  it('classifies a socket failure as transport', async () => {
    stubFetch({ throws: new TypeError('fetch failed') });

    await expect(new CloudApiWhatsAppClient().sendTemplate(SEND)).rejects.toMatchObject({
      category: 'TRANSPORT',
    });
  });

  it('classifies an expired token as auth, which the outbox treats as terminal', async () => {
    stubFetch({ status: 401, body: { error: { code: 190, message: 'expired' } } });

    await expect(new CloudApiWhatsAppClient().sendTemplate(SEND)).rejects.toMatchObject({
      category: 'AUTH',
      status: 401,
      providerCode: 190,
    });
  });

  it('classifies an unreachable number as terminal', async () => {
    stubFetch({ status: 400, body: { error: { code: 131026 } } });

    await expect(new CloudApiWhatsAppClient().sendTemplate(SEND)).rejects.toMatchObject({
      category: 'INVALID_NUMBER',
    });
  });

  it('classifies a template problem as terminal', async () => {
    stubFetch({ status: 400, body: { error: { code: 132001 } } });

    await expect(new CloudApiWhatsAppClient().sendTemplate(SEND)).rejects.toMatchObject({
      category: 'TEMPLATE',
    });
  });

  /**
   * A 200 with no message id leaves nothing to match a delivery webhook
   * against, so it is a failure rather than a row we can never resolve.
   */
  it('fails a 200 that carries no message id', async () => {
    stubFetch({ body: { messaging_product: 'whatsapp', messages: [] } });

    await expect(new CloudApiWhatsAppClient().sendTemplate(SEND)).rejects.toMatchObject({
      category: 'UNKNOWN',
    });
  });

  it('survives a response body that is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 502,
        json: async () => {
          throw new Error('not json');
        },
      }) as unknown as Response),
    );

    await expect(new CloudApiWhatsAppClient().sendTemplate(SEND)).rejects.toMatchObject({
      category: 'TRANSPORT',
    });
  });

  /** The OTP must not survive into an error message or a thrown payload. */
  it('keeps the one-time code out of the error it throws', async () => {
    stubFetch({ status: 400, body: { error: { code: 132001, message: 'bad params' } } });

    let error: unknown;
    try {
      await new CloudApiWhatsAppClient().sendTemplate(SEND);
    } catch (cause) {
      error = cause;
    }

    expect(error).toBeInstanceOf(WhatsAppError);
    const thrown = error as WhatsAppError;
    expect(JSON.stringify({ message: thrown.message, stack: thrown.stack })).not.toContain(
      '123456',
    );
  });
});
