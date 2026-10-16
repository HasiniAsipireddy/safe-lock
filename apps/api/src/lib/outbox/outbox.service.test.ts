import { describe, expect, it } from 'vitest';
import { WHATSAPP_CONSENT_VERSION } from '@safelock/shared';
import { env } from '../../config/env';
import { prisma } from '../prisma';
import { createTestUser, seedDeviceEvent, createUserWithDevice } from '../../test/helpers';
import { fakeWhatsAppClient } from '../whatsapp';
import { backoffMs, enqueue, processPending } from './outbox.service';
import { buildParams } from './params';

/**
 * The outbox.
 *
 * Every test here drives `processPending()` directly. The poll loop is started
 * from `server.ts` and never from `createApp()`, so nothing in the suite sends
 * on a timer.
 */

const fake = fakeWhatsAppClient()!;

/** A user who may actually be messaged: verified number plus consent. */
async function messageableUser() {
  const user = await createTestUser();
  await prisma.user.update({
    where: { id: user.id },
    data: {
      phoneVerifiedAt: new Date(),
      whatsappConsentAt: new Date(),
      whatsappConsentVersion: WHATSAPP_CONSENT_VERSION,
    },
  });
  return user;
}

async function queue(userId: string, deviceEventId?: string) {
  fake.reset();
  return prisma.$transaction((tx) =>
    enqueue(tx, {
      userId,
      kind: 'UNLOCK_ALERT',
      deviceEventId: deviceEventId ?? null,
    }),
  );
}

describe('enqueue', () => {
  it('writes a PENDING row and sends nothing', async () => {
    const user = await messageableUser();

    const id = await queue(user.id);

    const row = await prisma.outboundMessage.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('PENDING');
    expect(row.attempts).toBe(0);
    expect(row.providerMessageId).toBeNull();
    // The critical half: enqueueing is a database write, not a send.
    expect(fake.sent()).toHaveLength(0);
  });

  /**
   * The reason the outbox exists. A send inside the transaction could not be
   * undone by a rollback, so someone could be told their safe opened when it
   * did not.
   */
  it('is rolled back with its transaction, and still sends nothing', async () => {
    const user = await messageableUser();
    fake.reset();

    await expect(
      prisma.$transaction(async (tx) => {
        await enqueue(tx, { userId: user.id, kind: 'UNLOCK_ALERT' });
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');

    expect(await prisma.outboundMessage.count()).toBe(0);
    expect(fake.sent()).toHaveLength(0);
  });

  /**
   * The structural guarantee that no one-time code can reach this table:
   * there is nowhere to put one. Asserted as an exact column allow-list so
   * adding a `params` or `body` column later fails here and has to be a
   * deliberate decision rather than a quiet one.
   *
   * (Deliberately not a `/\d{6}/` scan over the serialised row — a random cuid
   * can contain six consecutive digits, which would make this flaky and prove
   * nothing.)
   */
  it('has no column that could hold a template parameter', async () => {
    const user = await messageableUser();
    const id = await queue(user.id);

    const row = await prisma.outboundMessage.findUniqueOrThrow({ where: { id } });

    expect(Object.keys(row).sort()).toEqual(
      [
        'attempts',
        'createdAt',
        'deliveryStatus',
        'deliveryUpdatedAt',
        'deviceEventId',
        'failureCategory',
        'id',
        'kind',
        'nextAttemptAt',
        'providerMessageId',
        'sentAt',
        'status',
        'updatedAt',
        'userId',
      ].sort(),
    );
  });
});

describe('processPending', () => {
  it('sends a due message and records the provider id', async () => {
    const user = await messageableUser();
    const id = await queue(user.id);

    const result = await processPending();

    expect(result).toMatchObject({ claimed: 1, sent: 1, failed: 0, skipped: 0 });
    expect(fake.sent()).toHaveLength(1);

    const row = await prisma.outboundMessage.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('SENT');
    expect(row.providerMessageId).toBe(fake.last()!.providerMessageId);
    expect(row.sentAt).toBeInstanceOf(Date);
    expect(row.failureCategory).toBeNull();
  });

  it('uses the configured template and the safe’s serial', async () => {
    const { user, deviceId } = await createUserWithDevice();
    await prisma.user.update({
      where: { id: user.id },
      data: { phoneVerifiedAt: new Date(), whatsappConsentAt: new Date() },
    });
    const event = await seedDeviceEvent({ userId: user.id, deviceId, type: 'UNLOCK_CONFIRMED' });

    await queue(user.id, event.id);
    await processPending();

    expect(fake.last()).toMatchObject({
      templateName: env.WHATSAPP_TEMPLATE_UNLOCK_ALERT,
      language: env.WHATSAPP_LANGUAGE,
      params: ['SAFE-0001'],
    });
  });

  it('leaves a message alone until its backoff has elapsed', async () => {
    const user = await messageableUser();
    const id = await queue(user.id);
    await prisma.outboundMessage.update({
      where: { id },
      data: { nextAttemptAt: new Date(Date.now() + 60_000) },
    });

    const result = await processPending();

    expect(result.claimed).toBe(0);
    expect(fake.sent()).toHaveLength(0);
  });

  it('retries a transport failure, with a growing backoff', async () => {
    const user = await messageableUser();
    const id = await queue(user.id);
    fake.failNext('TRANSPORT', 1);

    const first = await processPending();
    expect(first).toMatchObject({ sent: 0, retrying: 1, failed: 0 });

    let row = await prisma.outboundMessage.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('PENDING');
    expect(row.attempts).toBe(1);
    expect(row.failureCategory).toBe('TRANSPORT');
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    // Let the backoff elapse; the fake has recovered by now.
    await prisma.outboundMessage.update({
      where: { id },
      data: { nextAttemptAt: new Date(Date.now() - 1000) },
    });
    const second = await processPending();

    expect(second.sent).toBe(1);
    row = await prisma.outboundMessage.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('SENT');
    expect(row.attempts).toBe(2);
  });

  it('gives up after OUTBOX_MAX_ATTEMPTS', async () => {
    const user = await messageableUser();
    const id = await queue(user.id);
    fake.failAlways('TRANSPORT');

    // Walk right up to the cap, clearing the backoff between attempts.
    for (let attempt = 0; attempt < env.OUTBOX_MAX_ATTEMPTS; attempt += 1) {
      await prisma.outboundMessage.updateMany({
        where: { id },
        data: { nextAttemptAt: new Date(Date.now() - 1000) },
      });
      await processPending();
    }

    const row = await prisma.outboundMessage.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('FAILED');
    expect(row.attempts).toBe(env.OUTBOX_MAX_ATTEMPTS);
    expect(row.failureCategory).toBe('TRANSPORT');

    // And it is not picked up again.
    await prisma.outboundMessage.updateMany({
      where: { id },
      data: { nextAttemptAt: new Date(Date.now() - 1000) },
    });
    expect((await processPending()).claimed).toBe(0);

    fake.recover();
  });

  it('does not retry a terminal failure, however many attempts remain', async () => {
    for (const category of ['INVALID_NUMBER', 'TEMPLATE', 'AUTH'] as const) {
      const user = await messageableUser();
      const id = await queue(user.id);
      fake.failNext(category, 1);

      const result = await processPending();

      expect(result, category).toMatchObject({ failed: 1, retrying: 0 });
      const row = await prisma.outboundMessage.findUniqueOrThrow({ where: { id } });
      expect(row.status, category).toBe('FAILED');
      expect(row.attempts, category).toBe(1);
      expect(row.failureCategory, category).toBe(category);
    }
  });

  it('claims a batch and each message once', async () => {
    const user = await messageableUser();
    fake.reset();
    for (let index = 0; index < 3; index += 1) {
      await prisma.$transaction((tx) => enqueue(tx, { userId: user.id, kind: 'UNLOCK_ALERT' }));
    }

    const result = await processPending();

    expect(result.claimed).toBe(3);
    expect(fake.sent()).toHaveLength(3);
    // No row left PENDING, so nothing can be sent twice.
    expect(await prisma.outboundMessage.count({ where: { status: 'PENDING' } })).toBe(0);
  });

  it('honours the batch limit', async () => {
    const user = await messageableUser();
    fake.reset();
    for (let index = 0; index < 4; index += 1) {
      await prisma.$transaction((tx) => enqueue(tx, { userId: user.id, kind: 'UNLOCK_ALERT' }));
    }

    expect((await processPending({ limit: 2 })).claimed).toBe(2);
    expect(fake.sent()).toHaveLength(2);
  });

  it('is a no-op when there is nothing due', async () => {
    expect(await processPending()).toMatchObject({ claimed: 0, sent: 0 });
  });
});

// --- Skips (not failures) ----------------------------------------------------

describe('skipping rather than failing', () => {
  it('skips a user with no verified phone, and never retries', async () => {
    const user = await createTestUser();
    await prisma.user.update({
      where: { id: user.id },
      data: { whatsappConsentAt: new Date() },
    });
    const id = await queue(user.id);

    const result = await processPending();

    expect(result).toMatchObject({ skipped: 1, sent: 0, failed: 0, retrying: 0 });
    const row = await prisma.outboundMessage.findUniqueOrThrow({ where: { id } });
    // SKIPPED, not FAILED: nothing was attempted and nothing is wrong.
    expect(row.status).toBe('SKIPPED');
    expect(row.failureCategory).toBe('NO_VERIFIED_PHONE');
    expect(fake.sent()).toHaveLength(0);

    // Terminal — the worker must not pick it up again.
    await prisma.outboundMessage.updateMany({
      where: { id },
      data: { nextAttemptAt: new Date(Date.now() - 1000) },
    });
    expect((await processPending()).claimed).toBe(0);
  });

  it('skips a user who has not consented', async () => {
    const user = await createTestUser();
    await prisma.user.update({
      where: { id: user.id },
      data: { phoneVerifiedAt: new Date() },
    });
    const id = await queue(user.id);

    await processPending();

    const row = await prisma.outboundMessage.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('SKIPPED');
    expect(row.failureCategory).toBe('NO_CONSENT');
    expect(fake.sent()).toHaveLength(0);
  });

  it('skips when the daily cap is spent', async () => {
    const user = await messageableUser();

    // Fill the window with already-sent messages.
    for (let index = 0; index < env.WHATSAPP_DAILY_SEND_CAP; index += 1) {
      await prisma.outboundMessage.create({
        data: { userId: user.id, kind: 'UNLOCK_ALERT', status: 'SENT', sentAt: new Date() },
      });
    }

    const id = await queue(user.id);
    await processPending();

    const row = await prisma.outboundMessage.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('SKIPPED');
    expect(row.failureCategory).toBe('CAP_REACHED');
    expect(fake.sent()).toHaveLength(0);
  });

  it('does not count SKIPPED rows against the cap', async () => {
    const user = await messageableUser();

    // A pile of skips cost nothing and must not consume the allowance.
    for (let index = 0; index < env.WHATSAPP_DAILY_SEND_CAP + 5; index += 1) {
      await prisma.outboundMessage.create({
        data: {
          userId: user.id,
          kind: 'UNLOCK_ALERT',
          status: 'SKIPPED',
          failureCategory: 'NO_CONSENT',
        },
      });
    }

    const id = await queue(user.id);
    await processPending();

    expect(
      (await prisma.outboundMessage.findUniqueOrThrow({ where: { id } })).status,
    ).toBe('SENT');
  });

  it('counts only the last 24 hours', async () => {
    const user = await messageableUser();
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);

    for (let index = 0; index < env.WHATSAPP_DAILY_SEND_CAP; index += 1) {
      await prisma.outboundMessage.create({
        data: {
          userId: user.id,
          kind: 'UNLOCK_ALERT',
          status: 'SENT',
          sentAt: old,
          createdAt: old,
        },
      });
    }

    const id = await queue(user.id);
    await processPending();

    expect(
      (await prisma.outboundMessage.findUniqueOrThrow({ where: { id } })).status,
    ).toBe('SENT');
  });

  it('caps per user, not globally', async () => {
    const capped = await messageableUser();
    const other = await messageableUser();

    for (let index = 0; index < env.WHATSAPP_DAILY_SEND_CAP; index += 1) {
      await prisma.outboundMessage.create({
        data: { userId: capped.id, kind: 'UNLOCK_ALERT', status: 'SENT', sentAt: new Date() },
      });
    }

    const id = await queue(other.id);
    await processPending();

    expect(
      (await prisma.outboundMessage.findUniqueOrThrow({ where: { id } })).status,
    ).toBe('SENT');
  });

  it('skips a message whose user was deleted after it was queued', async () => {
    const user = await messageableUser();
    const id = await queue(user.id);
    // Cascades the outbound row away unless it survives on its own; it does
    // not, so re-create it detached from a user that no longer exists is not
    // possible — instead assert the cascade, which is the real behaviour.
    await prisma.user.delete({ where: { id: user.id } });

    expect(await prisma.outboundMessage.findUnique({ where: { id } })).toBeNull();
    expect((await processPending()).claimed).toBe(0);
  });
});

describe('backoffMs', () => {
  it('grows exponentially and stops at an hour', () => {
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(2)).toBe(120_000);
    expect(backoffMs(3)).toBe(480_000);
    expect(backoffMs(4)).toBe(1_920_000);
    // Capped, so a stuck message retries hourly rather than monthly.
    expect(backoffMs(5)).toBe(3_600_000);
    expect(backoffMs(50)).toBe(3_600_000);
  });

  it('never returns a negative or zero delay', () => {
    expect(backoffMs(0)).toBeGreaterThan(0);
    expect(backoffMs(-5)).toBeGreaterThan(0);
  });
});

describe('buildParams', () => {
  /**
   * The structural reason no one-time code can be queued: the parameters are
   * rebuilt from storage, and a code is never stored.
   */
  it('refuses to build params for an OTP kind', async () => {
    for (const kind of ['UNLOCK_OTP', 'PHONE_OTP'] as const) {
      await expect(buildParams(kind, { userId: 'usr_1' })).rejects.toThrow(
        /cannot be rebuilt/,
      );
    }
  });

  it('falls back to a neutral phrase when the event is gone', async () => {
    expect(await buildParams('UNLOCK_ALERT', { userId: 'usr_1' })).toEqual(['your safe']);
    expect(
      await buildParams('UNLOCK_ALERT', { userId: 'usr_1', deviceEventId: 'missing' }),
    ).toEqual(['your safe']);
  });

  it('sends no parameters for the password reset notice', async () => {
    expect(await buildParams('PASSWORD_RESET', { userId: 'usr_1' })).toEqual([]);
  });
});
