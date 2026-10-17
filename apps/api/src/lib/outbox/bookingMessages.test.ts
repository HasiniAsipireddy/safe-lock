import { describe, expect, it } from 'vitest';
import {
  OVERSTAY_NOTICE_DELAY_SECONDS,
  collectByFrom,
  overstayHourlyPaise,
  overstayStartsAt,
} from '@safelock/shared';
import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { fakeWhatsAppClient } from '../whatsapp';
import {
  createTestUser,
  seedBooking,
  seedDevice,
  verifyUserPhone,
} from '../../test/helpers';
import { BOOKING_SELECT, snapshotOf, type BookingRow } from '../../modules/bookings/booking.mapper';
import { activateBooking, settleOverstay } from '../../modules/bookings/booking.service';
import { revalidate } from './bookingMessages';
import { isStale, processPending } from './outbox.service';

/**
 * Sending a scheduled booking message — and the three ways one gets stopped.
 *
 * The worker is always driven **by hand**, with an explicit `now`. Nothing in
 * this suite waits for a timer, and the poll loop is never started (see the
 * assertion at the bottom), so every result here is a deliberate claim about
 * what the code does at one instant rather than a race with a scheduler.
 */

const fake = fakeWhatsAppClient()!;

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

async function activeBooking(options: {
  hours?: number;
  phoneVerified?: boolean;
  endsAt?: Date;
} = {}) {
  const user = await createTestUser();
  if (options.phoneVerified !== false) await verifyUserPhone(user.id);
  const device = await seedDevice();

  const seeded = await seedBooking({
    userId: user.id,
    deviceId: device.id,
    status: 'PENDING_PAYMENT',
    hours: options.hours ?? 3,
  });

  await activateBooking(seeded.id);

  if (options.endsAt) {
    await prisma.booking.update({
      where: { id: seeded.id },
      data: { endsAt: options.endsAt },
    });
  }

  const row = (await prisma.booking.findUniqueOrThrow({
    where: { id: seeded.id },
    select: BOOKING_SELECT,
  })) as BookingRow;

  return { user, device, booking: row };
}

/** Forces one scheduled row to be due at `sendAt`, leaving everything else. */
async function only(bookingId: string, kind: string, sendAt: Date): Promise<string> {
  await prisma.outboundMessage.updateMany({
    where: { bookingId, kind: { not: kind as never } },
    data: { status: 'SKIPPED', failureCategory: 'CANCELLED' },
  });

  const row = await prisma.outboundMessage.findFirstOrThrow({
    where: { bookingId, kind: kind as never, status: 'PENDING' },
    select: { id: true },
  });

  await prisma.outboundMessage.update({
    where: { id: row.id },
    data: { sendAt, nextAttemptAt: sendAt },
  });

  return row.id;
}

describe('sending a reminder', () => {
  it('sends the serial and the local end time, with a link to the booking', async () => {
    fake.reset();
    const { booking } = await activeBooking({ hours: 3 });

    const id = await only(booking.id, 'BOOKING_ENDING_SOON', new Date());
    const result = await processPending({ now: new Date() });

    expect(result.sent).toBe(1);

    const sent = fake.last()!;
    expect(sent.templateName).toBe(env.WHATSAPP_TEMPLATE_BOOKING_ENDING_SOON);
    expect(sent.params[0]).toBe(booking.device.serialNumber);
    /**
     * The button suffix is asserted exactly. Meta fixes the URL base in the
     * approved template, so this string decides which booking the reader lands
     * on — and a reminder whose link opens somebody's not-found page is worse
     * than no link at all.
     */
    expect(sent.urlButtonSuffix).toBe(`${booking.id}/extend`);

    const row = await prisma.outboundMessage.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('SENT');
    expect(row.providerMessageId).toBe(sent.providerMessageId);
  });

  it('names the hourly fee in the overstay notice', async () => {
    fake.reset();
    const { booking } = await activeBooking();

    // Put the booking into overstay, then make the notice due.
    const endsAt = new Date(Date.now() - booking.graceMinutes * MS_PER_MINUTE - MS_PER_MINUTE);
    await prisma.booking.update({ where: { id: booking.id }, data: { endsAt } });

    await only(booking.id, 'OVERSTAY_STARTED', new Date());
    await processPending({ now: new Date() });

    const sent = fake.last()!;
    expect(sent.templateName).toBe(env.WHATSAPP_TEMPLATE_OVERSTAY_STARTED);
    expect(sent.params[1]).toContain(
      String(Math.round(overstayHourlyPaise(snapshotOf(booking)) / 100)),
    );
  });

  it('does not claim a message before it is due', async () => {
    fake.reset();
    const { booking } = await activeBooking();

    const due = new Date(Date.now() + 30 * MS_PER_MINUTE);
    await only(booking.id, 'BOOKING_ENDING_SOON', due);

    const result = await processPending({ now: new Date() });

    expect(result.claimed).toBe(0);
    expect(fake.sent()).toHaveLength(0);
  });

  /**
   * A retry backoff may only ever push a message **later**.
   *
   * The claim query requires `sendAt <= now` *and* `nextAttemptAt <= now`, so
   * a row whose backoff has elapsed but whose due time has not stays put. The
   * alternative — claiming on backoff alone — would deliver "your booking ends
   * in 30 minutes" early, which is the one direction a scheduled message must
   * never move.
   */
  it('a lapsed backoff cannot pull a message earlier than its due time', async () => {
    fake.reset();
    const { booking } = await activeBooking();

    const id = await only(booking.id, 'BOOKING_ENDING_SOON', new Date(Date.now() + MS_PER_HOUR));
    await prisma.outboundMessage.update({
      where: { id },
      data: { nextAttemptAt: new Date(Date.now() - MS_PER_HOUR) },
    });

    expect((await processPending({ now: new Date() })).claimed).toBe(0);
  });
});

describe('staleness', () => {
  it('is a pure function of two dates and the tolerance', () => {
    const sendAt = new Date('2026-10-17T12:00:00.000Z');
    const tolerance = env.REMINDER_MAX_LATENESS_MINUTES * MS_PER_MINUTE;

    expect(isStale(sendAt, sendAt)).toBe(false);
    expect(isStale(sendAt, new Date(sendAt.getTime() + tolerance))).toBe(false);
    expect(isStale(sendAt, new Date(sendAt.getTime() + tolerance + 1))).toBe(true);
  });

  it('skips a reminder claimed past the tolerance instead of sending it', async () => {
    fake.reset();
    const { booking } = await activeBooking();

    const lateness = (env.REMINDER_MAX_LATENESS_MINUTES + 1) * MS_PER_MINUTE;
    const id = await only(booking.id, 'BOOKING_ENDING_SOON', new Date(Date.now() - lateness));

    const result = await processPending({ now: new Date() });

    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(1);
    expect(fake.sent()).toHaveLength(0);

    const row = await prisma.outboundMessage.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('SKIPPED');
    expect(row.failureCategory).toBe('STALE');
  });

  it('still sends one claimed inside the tolerance', async () => {
    fake.reset();
    const { booking } = await activeBooking();

    const lateness = (env.REMINDER_MAX_LATENESS_MINUTES - 1) * MS_PER_MINUTE;
    await only(booking.id, 'BOOKING_ENDING_SOON', new Date(Date.now() - lateness));

    expect((await processPending({ now: new Date() })).sent).toBe(1);
  });

  /**
   * The tolerance is for deadlines only. An alert about something that already
   * happened has no deadline to miss, and a user whose safe was opened should
   * hear about it however late the outbox was.
   */
  it('does not apply to a message with no booking', async () => {
    fake.reset();
    const user = await createTestUser();
    await verifyUserPhone(user.id);

    const old = new Date(Date.now() - 48 * MS_PER_HOUR);
    await prisma.outboundMessage.create({
      data: { userId: user.id, kind: 'UNLOCK_ALERT', status: 'PENDING', sendAt: old, nextAttemptAt: old },
    });

    expect((await processPending({ now: new Date() })).sent).toBe(1);
  });
});

/**
 * The A1 boundary, from both sides.
 *
 * The overstay notice is scheduled at `endsAt + grace + 60s`, and the reason
 * is that the fee is **exactly zero** at `endsAt + grace` while re-validation
 * requires an outstanding fee. These tests pin both halves of that: the
 * instant itself refuses, and a second later does not.
 */
describe('the overstay notice boundary', () => {
  async function overstaying() {
    const { user, booking } = await activeBooking();

    // An end time whose grace period expires in a known place.
    const endsAt = new Date(Date.now() - booking.graceMinutes * MS_PER_MINUTE - MS_PER_HOUR);
    await prisma.booking.update({ where: { id: booking.id }, data: { endsAt } });

    const row = (await prisma.booking.findUniqueOrThrow({
      where: { id: booking.id },
      select: BOOKING_SELECT,
    })) as BookingRow;

    return { user, booking: row, feeStartsAt: overstayStartsAt(snapshotOf(row), endsAt) };
  }

  it('refuses at exactly endsAt + grace, which is why the offset exists', async () => {
    const { booking, feeStartsAt } = await overstaying();

    const check = await revalidate('OVERSTAY_STARTED', booking.id, feeStartsAt);

    expect(check.ok).toBe(false);
  });

  it('allows one second later', async () => {
    const { booking, feeStartsAt } = await overstaying();

    const check = await revalidate(
      'OVERSTAY_STARTED',
      booking.id,
      new Date(feeStartsAt.getTime() + 1000),
    );

    expect(check.ok).toBe(true);
  });

  /**
   * Nothing between the boundary and the scheduled offset — nor anywhere after
   * it — can refuse the notice for a rounding reason. Every instant from one
   * second past the boundary onward has a whole started hour of fee, because
   * accrual is `Math.ceil` per started hour.
   */
  it('never refuses for clock rounding, at any offset the worker might claim it', async () => {
    const { booking, feeStartsAt } = await overstaying();

    const offsetsMs = [
      1,
      999,
      1000,
      OVERSTAY_NOTICE_DELAY_SECONDS * 1000 - 1,
      OVERSTAY_NOTICE_DELAY_SECONDS * 1000,
      OVERSTAY_NOTICE_DELAY_SECONDS * 1000 + 1,
      5 * MS_PER_MINUTE,
    ];

    for (const offset of offsetsMs) {
      const check = await revalidate(
        'OVERSTAY_STARTED',
        booking.id,
        new Date(feeStartsAt.getTime() + offset),
      );

      expect(check.ok, `offset ${offset}ms past the fee boundary`).toBe(true);
    }
  });

  it('sends when the worker claims it at the scheduled offset', async () => {
    fake.reset();
    const { booking, feeStartsAt } = await overstaying();

    const due = new Date(feeStartsAt.getTime() + OVERSTAY_NOTICE_DELAY_SECONDS * 1000);
    await only(booking.id, 'OVERSTAY_STARTED', due);

    expect((await processPending({ now: due })).sent).toBe(1);
  });
});

describe('re-validation at send time', () => {
  it('suppresses a reminder whose booking has been collected', async () => {
    fake.reset();
    const { booking } = await activeBooking();

    const id = await only(booking.id, 'BOOKING_ENDING_SOON', new Date());

    // Completed *after* the row was made due, and without going through
    // `cancelPending` — exactly the gap re-validation exists to cover.
    await prisma.booking.update({
      where: { id: booking.id },
      data: { status: 'COMPLETED', completedAt: new Date(), completionReason: 'COLLECTED' },
    });

    const result = await processPending({ now: new Date() });

    expect(result.sent).toBe(0);
    expect(fake.sent()).toHaveLength(0);

    const row = await prisma.outboundMessage.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('SKIPPED');
    expect(row.failureCategory).toBe('NOT_APPLICABLE');
  });

  it('suppresses a reminder whose booking has already ended', async () => {
    fake.reset();
    const { booking } = await activeBooking();

    await only(booking.id, 'BOOKING_ENDING_SOON', new Date());
    await prisma.booking.update({
      where: { id: booking.id },
      data: { endsAt: new Date(Date.now() - MS_PER_MINUTE) },
    });

    expect((await processPending({ now: new Date() })).sent).toBe(0);
  });

  /**
   * Settling cancels the notice outright, so the *first* guard catches this
   * one and the reason recorded is `CANCELLED`. Asserted as such rather than
   * forced into `NOT_APPLICABLE`: which guard fired is exactly the
   * distinction the two reasons exist to preserve.
   */
  it('settling the fee cancels the overstay notice before the worker sees it', async () => {
    fake.reset();
    const { booking } = await activeBooking();

    const endsAt = new Date(Date.now() - booking.graceMinutes * MS_PER_MINUTE - MS_PER_HOUR);
    await prisma.booking.update({ where: { id: booking.id }, data: { endsAt } });

    const id = await only(booking.id, 'OVERSTAY_STARTED', new Date());
    await settleOverstay(booking.id, 15_000);

    await processPending({ now: new Date() });

    const row = await prisma.outboundMessage.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('SKIPPED');
    expect(row.failureCategory).toBe('CANCELLED');
    expect(fake.sentWithTemplate(env.WHATSAPP_TEMPLATE_OVERSTAY_STARTED)).toHaveLength(0);
  });

  /**
   * The *second* guard, in isolation: the fee is settled by a write that does
   * not cancel anything, which is what a missed cancellation path would look
   * like. The notice is still not sent, and the reason says re-validation
   * caught it.
   */
  it('refuses an overstay notice on a settled fee even with nothing cancelled', async () => {
    fake.reset();
    const { booking } = await activeBooking();

    const id = await only(booking.id, 'OVERSTAY_STARTED', new Date());

    // A direct row edit: no cancellation runs, so the row stays PENDING and
    // due, and re-validation is the only thing standing between it and a
    // message telling someone a fee has started that they have already paid.
    await prisma.booking.update({
      where: { id: booking.id },
      data: {
        endsAt: new Date(Date.now() - booking.graceMinutes * MS_PER_MINUTE - MS_PER_HOUR),
        status: 'OVERSTAY',
        overstaySettledAt: new Date(),
        overstayPaidPaise: 15_000,
      },
    });

    await processPending({ now: new Date() });

    const row = await prisma.outboundMessage.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('SKIPPED');
    expect(row.failureCategory).toBe('NOT_APPLICABLE');
    expect(fake.sent()).toHaveLength(0);
  });

  it('refuses a receipt for a waived fee, because nothing was collected', async () => {
    const { booking } = await activeBooking();

    const endsAt = new Date(Date.now() - booking.graceMinutes * MS_PER_MINUTE - MS_PER_HOUR);
    await prisma.booking.update({
      where: { id: booking.id },
      data: { endsAt, overstayWaivedAt: new Date(), status: 'OVERSTAY' },
    });

    const check = await revalidate('OVERSTAY_SETTLED', booking.id, new Date());

    expect(check.ok).toBe(false);
  });

  it('allows a collection reminder for a waived fee, which is the only message that path sends', async () => {
    const { booking } = await activeBooking();

    const endsAt = new Date(Date.now() - booking.graceMinutes * MS_PER_MINUTE - MS_PER_HOUR);
    await prisma.booking.update({
      where: { id: booking.id },
      data: { endsAt, overstayWaivedAt: new Date(), status: 'OVERSTAY' },
    });

    const check = await revalidate('COLLECTION_CLOSING', booking.id, new Date());

    expect(check.ok).toBe(true);
  });

  it('refuses a collection reminder once the window has closed', async () => {
    const { booking } = await activeBooking();

    const settledAt = new Date(
      Date.now() - (booking.collectionWindowMinutes + 5) * MS_PER_MINUTE,
    );
    await prisma.booking.update({
      where: { id: booking.id },
      data: {
        endsAt: new Date(Date.now() - booking.graceMinutes * MS_PER_MINUTE - MS_PER_HOUR),
        overstaySettledAt: settledAt,
        overstayPaidPaise: 15_000,
        status: 'OVERSTAY',
      },
    });

    const check = await revalidate('COLLECTION_CLOSING', booking.id, new Date());

    expect(check.ok).toBe(false);
  });

  it('refuses everything for a booking that no longer exists', async () => {
    const check = await revalidate('BOOKING_CONFIRMED', 'clx_does_not_exist', new Date());

    expect(check.ok).toBe(false);
  });

  /**
   * The weakest precondition of the five, and deliberately so: a confirmation
   * describes a payment that was captured, which stays true even once the
   * booking is running late.
   */
  it('still confirms a booking that has slipped into overstay', async () => {
    const { booking } = await activeBooking();

    await prisma.booking.update({
      where: { id: booking.id },
      data: {
        endsAt: new Date(Date.now() - booking.graceMinutes * MS_PER_MINUTE - MS_PER_HOUR),
        status: 'OVERSTAY',
      },
    });

    const check = await revalidate('BOOKING_CONFIRMED', booking.id, new Date());

    expect(check.ok).toBe(true);
  });

  it('includes what was actually collected in the receipt', async () => {
    const { booking } = await activeBooking();

    const settledAt = new Date();
    await prisma.booking.update({
      where: { id: booking.id },
      data: {
        endsAt: new Date(Date.now() - booking.graceMinutes * MS_PER_MINUTE - MS_PER_HOUR),
        overstaySettledAt: settledAt,
        overstayPaidPaise: 15_000,
        status: 'OVERSTAY',
      },
    });

    const check = await revalidate('OVERSTAY_SETTLED', booking.id, new Date());

    expect(check.ok).toBe(true);
    if (!check.ok) return;

    // ₹150 from 15000 paise, the safe's serial, and the collection deadline.
    expect(check.params[0]).toContain('150');
    expect(check.params[1]).toBe(booking.device.serialNumber);
    expect(check.params).toHaveLength(3);
    // No button on this template, so no suffix may be sent.
    expect(check.urlButtonSuffix).toBeUndefined();

    const collectBy = collectByFrom(snapshotOf(booking), settledAt);
    expect(collectBy.getTime()).toBeGreaterThan(settledAt.getTime());
  });
});

describe('the two send budgets', () => {
  /** Fills a user's rolling window with rows of one kind. */
  async function fill(userId: string, kind: 'UNLOCK_ALERT' | 'BOOKING_CONFIRMED', count: number) {
    for (let index = 0; index < count; index += 1) {
      await prisma.outboundMessage.create({
        data: { userId, kind, status: 'SENT', sentAt: new Date() },
      });
    }
  }

  it('booking messages are not blocked by a spent user budget', async () => {
    fake.reset();
    const { user, booking } = await activeBooking();

    await fill(user.id, 'UNLOCK_ALERT', env.WHATSAPP_DAILY_SEND_CAP + 2);
    await only(booking.id, 'BOOKING_ENDING_SOON', new Date());

    expect((await processPending({ now: new Date() })).sent).toBe(1);
  });

  it('booking messages do not consume the user budget', async () => {
    fake.reset();
    const { user, booking } = await activeBooking();

    await only(booking.id, 'BOOKING_ENDING_SOON', new Date());
    await processPending({ now: new Date() });

    // A verification code is still sendable: the reminder spent nothing of
    // the budget it draws on.
    const { remainingSends } = await import('../whatsapp/send');
    expect(await remainingSends(user.id)).toBe(env.WHATSAPP_DAILY_SEND_CAP);
  });

  it('a user-triggered alert is still blocked by the user budget', async () => {
    fake.reset();
    const user = await createTestUser();
    await verifyUserPhone(user.id);

    await fill(user.id, 'UNLOCK_ALERT', env.WHATSAPP_DAILY_SEND_CAP);

    const row = await prisma.outboundMessage.create({
      data: { userId: user.id, kind: 'UNLOCK_ALERT', status: 'PENDING' },
      select: { id: true },
    });

    await processPending({ now: new Date() });

    const after = await prisma.outboundMessage.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('SKIPPED');
    expect(after.failureCategory).toBe('CAP_REACHED');
    expect(fake.sent()).toHaveLength(0);
  });

  /**
   * A dropped booking message is recorded, not silent — and the admin bookings
   * row counts it, which is the only way a renter who was never warned about a
   * fee becomes visible to a human.
   */
  it('a booking message dropped by its own budget is recorded as CAP_REACHED', async () => {
    fake.reset();
    const { user, booking } = await activeBooking();

    await fill(user.id, 'BOOKING_CONFIRMED', env.WHATSAPP_BOOKING_SEND_CAP);
    const id = await only(booking.id, 'OVERSTAY_STARTED', new Date());

    // Put the booking in overstay so re-validation would otherwise allow it.
    await prisma.booking.update({
      where: { id: booking.id },
      data: { endsAt: new Date(Date.now() - booking.graceMinutes * MS_PER_MINUTE - MS_PER_HOUR) },
    });

    await processPending({ now: new Date() });

    const row = await prisma.outboundMessage.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('SKIPPED');
    expect(row.failureCategory).toBe('CAP_REACHED');
    expect(fake.sent()).toHaveLength(0);
  });

  /**
   * Cancelled and skipped rows cost nothing. Without this, a user extending
   * repeatedly would spend their booking budget on reminders that were never
   * delivered, and the one message that matters — the overstay notice — would
   * be the one dropped.
   */
  it('cancelled rows do not consume the booking budget', async () => {
    fake.reset();
    const { user, booking } = await activeBooking();

    for (let index = 0; index < env.WHATSAPP_BOOKING_SEND_CAP + 5; index += 1) {
      await prisma.outboundMessage.create({
        data: {
          userId: user.id,
          kind: 'BOOKING_ENDING_SOON',
          status: 'SKIPPED',
          failureCategory: 'CANCELLED',
        },
      });
    }

    await only(booking.id, 'BOOKING_ENDING_SOON', new Date());

    expect((await processPending({ now: new Date() })).sent).toBe(1);
  });
});

describe('a user with no verified phone', () => {
  it('is skipped with nothing attempted', async () => {
    fake.reset();
    const { booking } = await activeBooking({ phoneVerified: false });

    const id = await only(booking.id, 'BOOKING_ENDING_SOON', new Date());

    const result = await processPending({ now: new Date() });

    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(1);
    expect(fake.sent()).toHaveLength(0);

    const row = await prisma.outboundMessage.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('SKIPPED');
    expect(row.failureCategory).toBe('NO_VERIFIED_PHONE');
    // Terminal: nothing is retried, so no attempt is ever made.
    expect(row.sentAt).toBeNull();
  });
});

describe('what a scheduled send may never leak', () => {
  /**
   * A scan over every message the lifecycle can send, asserting none of them
   * carries a credential. The template parameters are rebuilt at send time, so
   * this is the only place the actual strings exist — and the fake client is
   * the only place they can be inspected.
   */
  it('no booking message parameter looks like a code, a token or a phone number', async () => {
    fake.reset();
    const { booking } = await activeBooking();

    const endsAt = new Date(Date.now() - booking.graceMinutes * MS_PER_MINUTE - MS_PER_HOUR);
    await prisma.booking.update({
      where: { id: booking.id },
      data: { endsAt, overstaySettledAt: new Date(), overstayPaidPaise: 15_000, status: 'OVERSTAY' },
    });

    for (const kind of ['BOOKING_CONFIRMED', 'OVERSTAY_SETTLED', 'COLLECTION_CLOSING'] as const) {
      const check = await revalidate(kind, booking.id, new Date());
      expect(check.ok, kind).toBe(true);
      if (!check.ok) continue;

      for (const param of check.params) {
        // No 6-digit code, no 8-digit reset code, no 10-digit mobile number,
        // and no long opaque token.
        expect(param, `${kind}: ${param}`).not.toMatch(/\b\d{6}\b/);
        expect(param, `${kind}: ${param}`).not.toMatch(/\b\d{8,}\b/);
        expect(param, `${kind}: ${param}`).not.toMatch(/[A-Za-z0-9_-]{32,}/);
      }
    }
  });
});

describe('the worker loop', () => {
  /**
   * **The poll loop never runs under test.**
   *
   * Every send in this suite is a direct `processPending` call with an explicit
   * `now`. If the loop were started by `createApp` rather than by `server.ts`,
   * these tests would race it: rows would be claimed by a background tick and
   * assertions would pass or fail depending on timing. Asserting the module's
   * own view of whether it is running makes that impossible to introduce
   * quietly.
   */
  it('is not running', async () => {
    const { isOutboxWorkerRunning } = await import('./worker');

    expect(isOutboxWorkerRunning()).toBe(false);
  });
});
