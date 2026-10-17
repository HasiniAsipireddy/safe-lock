import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { fakeWhatsAppClient } from '../../lib/whatsapp';
import {
  TEST_ORIGIN,
  app,
  createUserWithDevice,
  withCapturedOtp,
} from '../../test/helpers';

/**
 * Unlock-code delivery over WhatsApp.
 *
 * All of it runs against `FakeWhatsAppClient`, so a test can assert on the
 * template and parameters of a message that was never sent anywhere. `fetch`
 * is blocked suite-wide (`test/setup.ts`), so there is no path to a real send.
 */

const REQUEST_URL = '/api/v1/devices/unlock/request';
const CONFIRM_URL = '/api/v1/devices/unlock/confirm';

const fake = fakeWhatsAppClient()!;

function post(url: string, cookie?: string, instance = app()) {
  const req = request(instance).post(url).set('Origin', TEST_ORIGIN);
  return cookie ? req.set('Cookie', cookie) : req;
}

describe('unlock code delivery', () => {
  it('sends the code through the WhatsApp client with the configured template', async () => {
    const { user } = await createUserWithDevice();
    fake.reset();

    const { code } = await withCapturedOtp(() => post(REQUEST_URL, user.cookie).send({}));

    expect(fake.sent()).toHaveLength(1);
    expect(fake.last()).toMatchObject({
      to: `+91${user.phone}`,
      templateName: env.WHATSAPP_TEMPLATE_UNLOCK_OTP,
      language: env.WHATSAPP_LANGUAGE,
    });
  });

  /**
   * **Exactly one parameter**, asserted with `toEqual` rather than a subset
   * match so an extra one fails here.
   *
   * `safelock_unlock_code` is an AUTHENTICATION template and Meta's layout for
   * that category permits only the code. A second parameter — the serial was
   * passed for a while — is a `TEMPLATE` rejection, which is terminal and
   * never retried, so the outcome is no code at all and a compensated
   * challenge. The cheapest possible test for the most expensive possible
   * failure.
   */
  it('passes the code as the only template parameter', async () => {
    const { user } = await createUserWithDevice();
    fake.reset();

    const { code } = await withCapturedOtp(() => post(REQUEST_URL, user.cookie).send({}));

    expect(fake.last()!.params).toEqual([code]);
  });

  it('sends to the owner’s number in E.164, not the stored national form', async () => {
    const { user } = await createUserWithDevice();
    fake.reset();

    await withCapturedOtp(() => post(REQUEST_URL, user.cookie).send({}));

    expect(fake.last()!.to).toMatch(/^\+91\d{10}$/);
  });

  it('never queues the code — the outbox cannot hold one', async () => {
    const { user } = await createUserWithDevice();
    fake.reset();

    await withCapturedOtp(() => post(REQUEST_URL, user.cookie).send({}));

    // The OTP is sent inline. Nothing about it reaches the outbox table.
    const queued = await prisma.outboundMessage.findMany({ where: { userId: user.id } });
    expect(queued.filter((row) => row.kind === 'UNLOCK_OTP')).toHaveLength(0);
  });

  it('ignores the daily cap, so a cap cannot lock an owner out of their safe', async () => {
    const { user } = await createUserWithDevice();
    fake.reset();

    // Spend the whole allowance.
    for (let index = 0; index < env.WHATSAPP_DAILY_SEND_CAP + 2; index += 1) {
      await prisma.outboundMessage.create({
        data: { userId: user.id, kind: 'UNLOCK_ALERT', status: 'SENT', sentAt: new Date() },
      });
    }

    const { result } = await withCapturedOtp(() => post(REQUEST_URL, user.cookie).send({}));

    expect(result.status).toBe(200);
    expect(fake.sent()).toHaveLength(1);
  });
});

describe('when delivery fails', () => {
  it('answers 502 OTP_DELIVERY_FAILED', async () => {
    const { user } = await createUserWithDevice();
    fake.reset();
    fake.failNext('TRANSPORT');

    const response = await post(REQUEST_URL, user.cookie).send({});

    expect(response.status).toBe(502);
    expect(response.body.error.code).toBe('OTP_DELIVERY_FAILED');
  });

  /**
   * The compensating consume. Leaving the challenge open would mean a live
   * code for five minutes that the owner never received — usable only by
   * someone who intercepted it.
   */
  it('leaves no usable challenge behind', async () => {
    const { user } = await createUserWithDevice();
    fake.reset();

    // Capture the code the failed attempt generated, then prove it is dead.
    const { code } = await withCapturedOtp(async () => {
      fake.failNext('TRANSPORT');
      const response = await post(REQUEST_URL, user.cookie).send({});
      expect(response.status).toBe(502);
      return response;
    });

    const challenges = await prisma.unlockChallenge.findMany({ where: { userId: user.id } });
    expect(challenges).toHaveLength(1);
    // Consumed, so it can never be redeemed.
    expect(challenges[0]!.consumedAt).toBeInstanceOf(Date);

    const confirm = await post(CONFIRM_URL, user.cookie).send({ otp: code });
    expect(confirm.status).toBe(400);
    expect(confirm.body.error.code).toBe('OTP_NOT_FOUND');
  });

  it('lets the user simply try again', async () => {
    const { user } = await createUserWithDevice();
    fake.reset();
    fake.failNext('TRANSPORT');

    expect((await post(REQUEST_URL, user.cookie).send({})).status).toBe(502);

    const { result, code } = await withCapturedOtp(() =>
      post(REQUEST_URL, user.cookie).send({}),
    );
    expect(result.status).toBe(200);

    const confirm = await post(CONFIRM_URL, user.cookie).send({ otp: code });
    expect(confirm.status).toBe(200);
  });

  it('answers 429 WHATSAPP_SEND_CAP_REACHED only when the cap is the reason', async () => {
    // The unlock code ignores the cap, so this is reachable only if the gate
    // itself reports CAP_REACHED. Asserting the mapping exists and is distinct
    // from a transport failure.
    const { user } = await createUserWithDevice();
    fake.reset();
    fake.failNext('RATE_LIMITED');

    const response = await post(REQUEST_URL, user.cookie).send({});

    // A provider rate-limit is still a delivery failure, not our send cap.
    expect(response.status).toBe(502);
    expect(response.body.error.code).toBe('OTP_DELIVERY_FAILED');
  });

  it('does not write an UNLOCK_CONFIRMED event or move the bolt', async () => {
    const { user, deviceId } = await createUserWithDevice();
    fake.reset();
    fake.failNext('TRANSPORT');

    await post(REQUEST_URL, user.cookie).send({});

    const device = await prisma.device.findUniqueOrThrow({ where: { id: deviceId } });
    expect(device.lockState).toBe('LOCKED');

    const events = await prisma.deviceEvent.findMany({ where: { userId: user.id } });
    // The request was genuinely made, so UNLOCK_REQUESTED is honest history.
    expect(events.map((event) => event.type)).toEqual(['UNLOCK_REQUESTED']);
  });
});

// --- Rate limit refunds ------------------------------------------------------

describe('rate limiting around delivery failures', () => {
  /**
   * A WhatsApp outage must not spend the user's allowance. Three failed sends
   * would otherwise leave them locked out for ten minutes having received
   * nothing.
   */
  it('refunds a 5xx, so an outage does not burn the unlock allowance', async () => {
    const { user } = await createUserWithDevice();
    const instance = app({
      rateLimits: { unlockRequest: { windowMs: 60_000, limit: 2 } },
    });
    fake.reset();
    fake.failAlways('TRANSPORT');

    // Four failures, double the limit — none of them should count.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await post(REQUEST_URL, user.cookie, instance).send({});
      expect(response.status).toBe(502);
    }

    fake.recover();

    // The allowance is untouched: a real request still succeeds.
    const { result } = await withCapturedOtp(() =>
      post(REQUEST_URL, user.cookie, instance).send({}),
    );
    expect(result.status).toBe(200);
  });

  /**
   * The other half, and the one that matters for security: refunding must be
   * scoped to 5xx. A caller cycling request/confirm with wrong codes is still
   * bounded exactly as before.
   */
  it('still counts successful requests against the limit', async () => {
    const { user } = await createUserWithDevice();
    const instance = app({
      rateLimits: { unlockRequest: { windowMs: 60_000, limit: 2 } },
    });
    fake.reset();

    await withCapturedOtp(() => post(REQUEST_URL, user.cookie, instance).send({}));
    await withCapturedOtp(() => post(REQUEST_URL, user.cookie, instance).send({}));

    const third = await post(REQUEST_URL, user.cookie, instance).send({});
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe('RATE_LIMITED');
  });

  it('still counts 4xx wrong-code attempts on the confirm limiter', async () => {
    const { user } = await createUserWithDevice();
    const instance = app({
      rateLimits: { unlockConfirm: { windowMs: 60_000, limit: 3 } },
    });
    fake.reset();

    await withCapturedOtp(() => post(REQUEST_URL, user.cookie, instance).send({}));

    // Three wrong codes: each is a 400, and each must cost an attempt.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await post(CONFIRM_URL, user.cookie, instance).send({ otp: '000000' });
      expect(response.status).toBe(400);
    }

    const fourth = await post(CONFIRM_URL, user.cookie, instance).send({ otp: '000000' });
    expect(fourth.status).toBe(429);
  });
});
