import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { app, createTestUser } from '../../test/helpers';

/**
 * The WhatsApp delivery webhook.
 *
 * Authentication is the HMAC and nothing else — no cookies, no Origin check.
 * These tests cover the signature (valid, invalid, missing, tampered body),
 * the handshake, idempotency, and that a bad signature reaches nothing.
 */

const URL = '/api/v1/webhooks/whatsapp';

/** The signature Meta would send for this body. */
function sign(rawBody: string): string {
  return `sha256=${crypto
    .createHmac('sha256', env.WHATSAPP_APP_SECRET!)
    .update(rawBody)
    .digest('hex')}`;
}

/** Meta's status envelope, as nested as the real thing. */
function statusBody(
  providerMessageId: string,
  status: 'sent' | 'delivered' | 'read' | 'failed',
): string {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '100000000000000',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '919999999999', phone_number_id: '1' },
              statuses: [
                {
                  id: providerMessageId,
                  status,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  recipient_id: '919876543210',
                  ...(status === 'failed'
                    ? { errors: [{ code: 131026, title: 'Message undeliverable' }] }
                    : {}),
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

/** Posts a raw body with whatever signature header is given. */
function postRaw(rawBody: string, signature?: string, instance = app()) {
  const req = request(instance).post(URL).set('Content-Type', 'application/json');
  if (signature !== undefined) req.set('X-Hub-Signature-256', signature);
  return req.send(rawBody);
}

/** A SENT outbound message with a known provider id. */
async function sentMessage(providerMessageId: string) {
  const user = await createTestUser();
  return prisma.outboundMessage.create({
    data: {
      userId: user.id,
      kind: 'UNLOCK_ALERT',
      status: 'SENT',
      sentAt: new Date(),
      providerMessageId,
    },
    select: { id: true, userId: true },
  });
}

describe('POST /webhooks/whatsapp — signature', () => {
  it('accepts a valid signature and applies the status', async () => {
    const message = await sentMessage('wamid.VALID1');
    const body = statusBody('wamid.VALID1', 'delivered');

    const response = await postRaw(body, sign(body));

    expect(response.status).toBe(200);
    const row = await prisma.outboundMessage.findUniqueOrThrow({ where: { id: message.id } });
    expect(row.deliveryStatus).toBe('delivered');
    expect(row.deliveryUpdatedAt).toBeInstanceOf(Date);
  });

  it('rejects a wrong signature with 401 and changes nothing', async () => {
    const message = await sentMessage('wamid.WRONG');
    const body = statusBody('wamid.WRONG', 'delivered');

    const response = await postRaw(body, `sha256=${'f'.repeat(64)}`);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('INVALID_SIGNATURE');

    const row = await prisma.outboundMessage.findUniqueOrThrow({ where: { id: message.id } });
    expect(row.deliveryStatus).toBeNull();
  });

  it('rejects a missing signature', async () => {
    const body = statusBody('wamid.NONE', 'delivered');

    const response = await postRaw(body);

    expect(response.status).toBe(401);
  });

  /**
   * The signature covers the bytes, so changing one of them must invalidate
   * it. This is the test that proves the HMAC is over the raw body rather than
   * over something re-serialised.
   */
  it('rejects a tampered body carrying a signature for the original', async () => {
    const message = await sentMessage('wamid.TAMPER');
    const original = statusBody('wamid.TAMPER', 'delivered');
    const signature = sign(original);

    // Same shape, different content: a status the attacker prefers.
    const tampered = original.replace('"delivered"', '"read"');
    expect(tampered).not.toBe(original);

    const response = await postRaw(tampered, signature);

    expect(response.status).toBe(401);
    const row = await prisma.outboundMessage.findUniqueOrThrow({ where: { id: message.id } });
    expect(row.deliveryStatus).toBeNull();
  });

  it('rejects a signature with no sha256= prefix, or a malformed digest', async () => {
    const body = statusBody('wamid.MALFORMED', 'delivered');
    const valid = sign(body).slice('sha256='.length);

    for (const header of [
      valid, // right digest, no prefix
      `sha1=${valid}`,
      'sha256=',
      'sha256=notahexdigest',
      `sha256=${valid.slice(0, 63)}`, // one char short
      `sha256=${valid}00`, // too long
    ]) {
      const response = await postRaw(body, header);
      expect(response.status, header.slice(0, 20)).toBe(401);
    }
  });

  it('accepts an upper-case hex digest', async () => {
    const message = await sentMessage('wamid.UPPER');
    const body = statusBody('wamid.UPPER', 'delivered');
    const signature = sign(body).toUpperCase().replace('SHA256=', 'sha256=');

    const response = await postRaw(body, signature);

    expect(response.status).toBe(200);
    const row = await prisma.outboundMessage.findUniqueOrThrow({ where: { id: message.id } });
    expect(row.deliveryStatus).toBe('delivered');
  });

  /** A bad signature must not reach the parser, let alone the database. */
  it('does not parse the body when the signature fails', async () => {
    // Deliberately not JSON. A 401 proves the signature check ran first — if
    // the body were parsed first this would be a 400.
    const response = await postRaw('this is not json at all', `sha256=${'a'.repeat(64)}`);

    expect(response.status).toBe(401);
  });

  it('needs no Origin header, unlike every other POST', async () => {
    const message = await sentMessage('wamid.NOORIGIN');
    const body = statusBody('wamid.NOORIGIN', 'sent');

    // No Origin set at all: a server-to-server caller has none, and
    // originCheck exempts this path.
    const response = await postRaw(body, sign(body));

    expect(response.status).toBe(200);
    expect(
      (await prisma.outboundMessage.findUniqueOrThrow({ where: { id: message.id } }))
        .deliveryStatus,
    ).toBe('sent');
  });
});

describe('POST /webhooks/whatsapp — idempotency', () => {
  it('applies the same status twice without changing anything the second time', async () => {
    const message = await sentMessage('wamid.TWICE');
    const body = statusBody('wamid.TWICE', 'delivered');

    await postRaw(body, sign(body));
    const first = await prisma.outboundMessage.findUniqueOrThrow({ where: { id: message.id } });

    await postRaw(body, sign(body));
    const second = await prisma.outboundMessage.findUniqueOrThrow({ where: { id: message.id } });

    expect(second.deliveryStatus).toBe('delivered');
    // The timestamp did not move: a repeat is a genuine no-op.
    expect(second.deliveryUpdatedAt?.getTime()).toBe(first.deliveryUpdatedAt?.getTime());
  });

  it('moves the state forward through sent, delivered, read', async () => {
    const message = await sentMessage('wamid.FORWARD');

    for (const status of ['sent', 'delivered', 'read'] as const) {
      const body = statusBody('wamid.FORWARD', status);
      await postRaw(body, sign(body));

      const row = await prisma.outboundMessage.findUniqueOrThrow({ where: { id: message.id } });
      expect(row.deliveryStatus).toBe(status);
    }
  });

  /**
   * Meta retries, and retries can arrive out of order. A redelivered `sent`
   * after a `read` must not walk the record backwards.
   */
  it('never walks the state backwards', async () => {
    const message = await sentMessage('wamid.BACKWARDS');

    const read = statusBody('wamid.BACKWARDS', 'read');
    await postRaw(read, sign(read));

    const sent = statusBody('wamid.BACKWARDS', 'sent');
    const response = await postRaw(sent, sign(sent));

    expect(response.status).toBe(200);
    const row = await prisma.outboundMessage.findUniqueOrThrow({ where: { id: message.id } });
    expect(row.deliveryStatus).toBe('read');
  });

  it('applies a failure whatever the current state, and marks the row FAILED', async () => {
    const message = await sentMessage('wamid.FAILED');

    const delivered = statusBody('wamid.FAILED', 'delivered');
    await postRaw(delivered, sign(delivered));

    const failed = statusBody('wamid.FAILED', 'failed');
    await postRaw(failed, sign(failed));

    const row = await prisma.outboundMessage.findUniqueOrThrow({ where: { id: message.id } });
    expect(row.deliveryStatus).toBe('failed');
    // A send accepted but never delivered is a real failure.
    expect(row.status).toBe('FAILED');
  });

  it('acknowledges a message id it has never seen', async () => {
    const body = statusBody('wamid.UNKNOWN_TO_US', 'delivered');

    const response = await postRaw(body, sign(body));

    // 200, not 404: a retry cannot fix "we never issued that id", and Meta
    // retries anything else forever.
    expect(response.status).toBe(200);
  });

  it('survives an envelope with no statuses, or an unexpected shape', async () => {
    for (const payload of [
      '{}',
      '{"entry":[]}',
      '{"entry":[{"changes":[]}]}',
      '{"entry":[{"changes":[{"value":{}}]}]}',
      '{"entry":[{"changes":[{"value":{"statuses":[{"id":"x"}]}}]}]}',
      '{"entry":"not-an-array"}',
      '[]',
      'null',
    ]) {
      const response = await postRaw(payload, sign(payload));
      expect(response.status, payload).toBe(200);
    }
  });

  it('answers 200 for a signed body that is not JSON', async () => {
    const body = 'definitely not json';

    const response = await postRaw(body, sign(body));

    // Signed by us, so not an attack — but nothing to apply, and a retry
    // cannot change that.
    expect(response.status).toBe(200);
  });

  it('applies several statuses in one delivery', async () => {
    const first = await sentMessage('wamid.BATCH1');
    const second = await sentMessage('wamid.BATCH2');

    const body = JSON.stringify({
      entry: [
        {
          changes: [
            {
              value: {
                statuses: [
                  { id: 'wamid.BATCH1', status: 'delivered' },
                  { id: 'wamid.BATCH2', status: 'read' },
                ],
              },
            },
          ],
        },
      ],
    });

    await postRaw(body, sign(body));

    expect(
      (await prisma.outboundMessage.findUniqueOrThrow({ where: { id: first.id } }))
        .deliveryStatus,
    ).toBe('delivered');
    expect(
      (await prisma.outboundMessage.findUniqueOrThrow({ where: { id: second.id } }))
        .deliveryStatus,
    ).toBe('read');
  });
});

describe('an unconfigured app secret', () => {
  /**
   * `WHATSAPP_APP_SECRET` is required in cloud mode but optional in fake mode,
   * where this endpoint has no legitimate caller. "Cannot verify" must land on
   * the **reject** path — not a 500, and certainly not an accept.
   */
  it('rejects rather than throwing when there is no secret to verify with', async () => {
    const original = env.WHATSAPP_APP_SECRET;
    // Deliberately unset: the variable is optional in the schema (it is only
    // required in cloud mode), so this is a reachable configuration.
    env.WHATSAPP_APP_SECRET = undefined;

    try {
      const body = statusBody('wamid.NOSECRET', 'delivered');
      const response = await postRaw(body, `sha256=${'a'.repeat(64)}`);

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('INVALID_SIGNATURE');
    } finally {
      env.WHATSAPP_APP_SECRET = original;
    }
  });
});

describe('GET /webhooks/whatsapp — the handshake', () => {
  it('echoes the challenge when the verify token matches', async () => {
    const response = await request(app())
      .get(URL)
      .query({
        'hub.mode': 'subscribe',
        'hub.verify_token': env.WHATSAPP_WEBHOOK_VERIFY_TOKEN!,
        'hub.challenge': '1158201444',
      });

    expect(response.status).toBe(200);
    // Verbatim, as text — Meta compares the body byte for byte.
    expect(response.text).toBe('1158201444');
    expect(response.headers['content-type']).toMatch(/text\/plain/);
  });

  it('refuses a wrong, missing or near-miss token', async () => {
    for (const token of [
      undefined,
      '',
      'wrong-token',
      `${env.WHATSAPP_WEBHOOK_VERIFY_TOKEN!}x`,
      env.WHATSAPP_WEBHOOK_VERIFY_TOKEN!.slice(0, -1),
    ]) {
      const response = await request(app())
        .get(URL)
        .query({
          'hub.mode': 'subscribe',
          ...(token === undefined ? {} : { 'hub.verify_token': token }),
          'hub.challenge': 'abc',
        });

      expect(response.status, String(token)).toBe(403);
      expect(response.text).not.toContain('abc');
    }
  });

  it('refuses a mode other than subscribe', async () => {
    const response = await request(app())
      .get(URL)
      .query({
        'hub.mode': 'unsubscribe',
        'hub.verify_token': env.WHATSAPP_WEBHOOK_VERIFY_TOKEN!,
        'hub.challenge': 'abc',
      });

    expect(response.status).toBe(403);
  });
});

describe('raw body handling does not disturb other routes', () => {
  /**
   * The webhook needs `express.raw()`, which is applied per route plus a
   * path-specific bypass of the global JSON parser. This asserts the bypass is
   * exactly that specific — an ordinary endpoint must still parse JSON.
   */
  it('leaves JSON parsing intact on a normal endpoint', async () => {
    const response = await request(app())
      .post('/api/v1/auth/login')
      .set('Origin', 'http://localhost:3000')
      .send({ identifier: 'someone@example.com', password: 'whatever' });

    // 401 means the body was parsed and the credentials were checked. A 400
    // about a missing field would mean the parser had been skipped.
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('leaves the Razorpay webhook’s own raw handling intact', async () => {
    const response = await request(app())
      .post('/api/v1/payments/webhook')
      .set('Content-Type', 'application/json')
      .send('{"event":"payment.captured"}');

    // Rejected for its own missing signature, not for a parsing problem.
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_SIGNATURE');
  });
});
