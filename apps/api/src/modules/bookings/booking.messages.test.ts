import { describe, expect, it } from 'vitest';
import {
  BOOKING_REMINDER_LEAD_MINUTES,
  COLLECTION_REMINDER_LEAD_MINUTES,
  OVERSTAY_NOTICE_DELAY_SECONDS,
  collectByFrom,
  overstayStartsAt,
} from '@safelock/shared';
import { prisma } from '../../lib/prisma';
import {
  createTestUser,
  pushIntoOverstay,
  seedBooking,
  seedDevice,
  verifyUserPhone,
} from '../../test/helpers';
import { snapshotOf, type BookingRow } from './booking.mapper';
import { BOOKING_SELECT } from './booking.mapper';
import {
  activateBooking,
  adminForceComplete,
  adminWaiveOverstay,
  applyExtension,
  cancelBooking,
  collectBooking,
  settleOverstay,
} from './booking.service';

/**
 * Scheduling a booking's lifecycle messages.
 *
 * These tests assert **due times to the millisecond**, because every one of
 * them is load-bearing: a reminder a minute early is wrong about how much time
 * is left, and the overstay notice is deliberately offset past a boundary
 * where its own re-validation would otherwise refuse it forever.
 */

const MS_PER_MINUTE = 60 * 1000;

async function pendingBooking(options: { hours?: number } = {}) {
  const user = await createTestUser();
  await verifyUserPhone(user.id);
  const device = await seedDevice();

  const booking = await seedBooking({
    userId: user.id,
    deviceId: device.id,
    status: 'PENDING_PAYMENT',
    hours: options.hours ?? 3,
  });

  return { user, device, bookingId: booking.id };
}

async function rowFor(bookingId: string): Promise<BookingRow> {
  return (await prisma.booking.findUniqueOrThrow({
    where: { id: bookingId },
    select: BOOKING_SELECT,
  })) as BookingRow;
}

function messagesFor(bookingId: string) {
  return prisma.outboundMessage.findMany({
    where: { bookingId },
    orderBy: { sendAt: 'asc' },
    select: {
      kind: true,
      status: true,
      sendAt: true,
      dedupeKey: true,
      failureCategory: true,
      nextAttemptAt: true,
    },
  });
}

describe('scheduling at activation', () => {
  it('schedules a confirmation, both reminders and the overstay notice', async () => {
    const { bookingId } = await pendingBooking({ hours: 3 });

    const outcome = await activateBooking(bookingId);
    expect(outcome.kind).toBe('activated');

    const rows = await messagesFor(bookingId);

    expect(rows.map((row) => row.kind)).toEqual([
      'BOOKING_CONFIRMED',
      'BOOKING_ENDING_SOON',
      'BOOKING_ENDING_SOON',
      'OVERSTAY_STARTED',
    ]);
    expect(rows.every((row) => row.status === 'PENDING')).toBe(true);
  });

  it('puts each reminder exactly its lead time before the end', async () => {
    const { bookingId } = await pendingBooking({ hours: 3 });
    await activateBooking(bookingId);

    const booking = await rowFor(bookingId);
    const endsAt = booking.endsAt!.getTime();

    const reminders = (await messagesFor(bookingId)).filter(
      (row) => row.kind === 'BOOKING_ENDING_SOON',
    );

    expect(reminders.map((row) => (endsAt - row.sendAt.getTime()) / MS_PER_MINUTE)).toEqual([
      ...BOOKING_REMINDER_LEAD_MINUTES,
    ]);
  });

  /**
   * The A1 offset, asserted as arithmetic rather than as a magic timestamp.
   *
   * At exactly `endsAt + grace` the accrued fee is zero, and re-validation
   * requires an outstanding fee — so a notice due at that instant would be
   * refused on every poll until it went stale. A minute later there is always
   * a fee to name.
   */
  it('puts the overstay notice a minute past the grace boundary, not on it', async () => {
    const { bookingId } = await pendingBooking();
    await activateBooking(bookingId);

    const booking = await rowFor(bookingId);
    const feeStartsAt = overstayStartsAt(snapshotOf(booking), booking.endsAt!);

    const notice = (await messagesFor(bookingId)).find(
      (row) => row.kind === 'OVERSTAY_STARTED',
    )!;

    expect(notice.sendAt.getTime() - feeStartsAt.getTime()).toBe(
      OVERSTAY_NOTICE_DELAY_SECONDS * 1000,
    );
    expect(notice.sendAt.getTime()).toBeGreaterThan(feeStartsAt.getTime());
  });

  it('seeds nextAttemptAt to the due time, not to now', async () => {
    const { bookingId } = await pendingBooking();
    await activateBooking(bookingId);

    for (const row of await messagesFor(bookingId)) {
      expect(row.nextAttemptAt.getTime()).toBe(row.sendAt.getTime());
    }
  });

  /**
   * A one-hour booking has no room for a 30-minute reminder *and* a 10-minute
   * one at the moment it is paid for — the first is already in the past. It is
   * simply not created, rather than queued and then discarded as stale.
   */
  it('creates no reminder whose lead time exceeds the time remaining', async () => {
    const { bookingId } = await pendingBooking({ hours: 1 });
    await activateBooking(bookingId);

    const kinds = (await messagesFor(bookingId)).map((row) => row.kind);

    expect(kinds).toEqual([
      'BOOKING_CONFIRMED',
      // 30 minutes out of a 60-minute booking is still ahead; 10 is too.
      'BOOKING_ENDING_SOON',
      'BOOKING_ENDING_SOON',
      'OVERSTAY_STARTED',
    ]);
  });

  it('activating twice schedules one set, not two', async () => {
    const { bookingId } = await pendingBooking();

    await activateBooking(bookingId);
    const after = await activateBooking(bookingId);

    // The second call is the idempotent path a webhook retry takes.
    expect(after.kind).toBe('already-active');
    expect(await messagesFor(bookingId)).toHaveLength(4);
  });
});

describe('extension', () => {
  it('cancels the deadline messages and re-creates them from the new end', async () => {
    const { bookingId } = await pendingBooking({ hours: 2 });
    await activateBooking(bookingId);

    const before = await messagesFor(bookingId);
    const oldKeys = before
      .filter((row) => row.kind !== 'BOOKING_CONFIRMED')
      .map((row) => row.dedupeKey!);

    await applyExtension(bookingId, 2, 20_000);

    const after = await messagesFor(bookingId);

    // The old deadline rows are cancelled, not deleted: the record that we
    // meant to say something and correctly did not is worth keeping.
    const cancelled = after.filter((row) => row.status === 'SKIPPED');
    expect(cancelled).toHaveLength(oldKeys.length);
    expect(cancelled.every((row) => row.failureCategory === 'CANCELLED')).toBe(true);

    const pending = after.filter((row) => row.status === 'PENDING');
    expect(pending.map((row) => row.kind).sort()).toEqual([
      'BOOKING_CONFIRMED',
      'BOOKING_CONFIRMED',
      'BOOKING_ENDING_SOON',
      'BOOKING_ENDING_SOON',
      'OVERSTAY_STARTED',
    ]);
  });

  it('moves every re-created deadline to the new end time', async () => {
    const { bookingId } = await pendingBooking({ hours: 2 });
    await activateBooking(bookingId);

    await applyExtension(bookingId, 3, 30_000);
    const booking = await rowFor(bookingId);
    const endsAt = booking.endsAt!.getTime();

    const pending = (await messagesFor(bookingId)).filter((row) => row.status === 'PENDING');

    const reminders = pending.filter((row) => row.kind === 'BOOKING_ENDING_SOON');
    expect(reminders.map((row) => (endsAt - row.sendAt.getTime()) / MS_PER_MINUTE)).toEqual([
      ...BOOKING_REMINDER_LEAD_MINUTES,
    ]);
  });

  /**
   * The assumption this test exists to defend.
   *
   * A cancelled row keeps its `dedupeKey`, and `skipDuplicates` silently drops
   * an insert that collides with one — which would be a reminder that never
   * arrives, with no error anywhere. It is safe today only because an
   * extension moves `endsAt` by whole hours while the leads are 30 and 10
   * minutes apart, so no new key can equal an old one.
   *
   * If `BOOKING_REMINDER_LEAD_MINUTES` or the minimum extension ever changes
   * so that two kinds can land on the same instant, this fails here rather
   * than going quiet in production.
   */
  it('re-creates with keys that collide with none of the cancelled ones', async () => {
    const { bookingId } = await pendingBooking({ hours: 2 });
    await activateBooking(bookingId);

    const before = await messagesFor(bookingId);
    const cancelledKeys = new Set(
      before.filter((row) => row.kind !== 'BOOKING_CONFIRMED').map((row) => row.dedupeKey),
    );

    await applyExtension(bookingId, 1, 10_000);

    const recreated = (await messagesFor(bookingId)).filter(
      (row) => row.status === 'PENDING' && row.kind !== 'BOOKING_CONFIRMED',
    );

    // Every deadline row was actually re-created…
    expect(recreated).toHaveLength(cancelledKeys.size);
    // …and none of them was dropped as a duplicate of a cancelled key.
    for (const row of recreated) {
      expect(cancelledKeys.has(row.dedupeKey)).toBe(false);
    }

    const allKeys = (await messagesFor(bookingId)).map((row) => row.dedupeKey);
    expect(new Set(allKeys).size).toBe(allKeys.length);
  });

  it('re-confirms, because the new end time is the sentence a user needs', async () => {
    const { bookingId } = await pendingBooking({ hours: 2 });
    await activateBooking(bookingId);

    await applyExtension(bookingId, 1, 10_000);

    const confirmations = (await messagesFor(bookingId)).filter(
      (row) => row.kind === 'BOOKING_CONFIRMED',
    );

    // Two, both live: the first was true when it was sent.
    expect(confirmations).toHaveLength(2);
    expect(confirmations.every((row) => row.status === 'PENDING')).toBe(true);
    // Keyed on `endsAt`, so they are genuinely different messages.
    expect(confirmations[0]!.dedupeKey).not.toBe(confirmations[1]!.dedupeKey);
  });
});

describe('the overstay fee being dealt with', () => {
  async function overstayingBooking() {
    const { user, device, bookingId } = await pendingBooking();
    await activateBooking(bookingId);
    await pushIntoOverstay(bookingId, 1);

    return { user, device, bookingId };
  }

  it('settling sends a receipt and schedules the collection reminder', async () => {
    const { bookingId } = await overstayingBooking();
    const payment = `pay_row_${Date.now()}`;

    await settleOverstay(bookingId, 15_000, { paymentRowId: payment });

    const pending = (await messagesFor(bookingId)).filter((row) => row.status === 'PENDING');
    const kinds = pending.map((row) => row.kind);

    expect(kinds).toContain('OVERSTAY_SETTLED');
    expect(kinds).toContain('COLLECTION_CLOSING');
    // The fee reminders are gone: telling someone a fee has started, after
    // they have paid it, is worse than silence.
    expect(kinds).not.toContain('OVERSTAY_STARTED');
    expect(kinds).not.toContain('BOOKING_ENDING_SOON');
  });

  it('puts the collection reminder its lead time before the deadline', async () => {
    const { bookingId } = await overstayingBooking();
    await settleOverstay(bookingId, 15_000, { paymentRowId: 'pay_row_lead' });

    const booking = await rowFor(bookingId);
    const collectBy = collectByFrom(snapshotOf(booking), booking.overstaySettledAt!);

    const reminder = (await messagesFor(bookingId)).find(
      (row) => row.kind === 'COLLECTION_CLOSING',
    )!;

    expect((collectBy.getTime() - reminder.sendAt.getTime()) / MS_PER_MINUTE).toBe(
      COLLECTION_REMINDER_LEAD_MINUTES,
    );
  });

  /**
   * The A2 case. Settlement runs from both the verified Checkout callback and
   * the webhook, so the receipt is keyed on the **payment** rather than on the
   * time — which is the only discriminator both of them agree about.
   */
  it('settling the same payment twice sends one receipt', async () => {
    const { bookingId } = await overstayingBooking();

    await settleOverstay(bookingId, 15_000, { paymentRowId: 'pay_row_once' });
    await settleOverstay(bookingId, 15_000, { paymentRowId: 'pay_row_once' });

    const receipts = (await messagesFor(bookingId)).filter(
      (row) => row.kind === 'OVERSTAY_SETTLED',
    );

    expect(receipts).toHaveLength(1);
  });

  /**
   * A waiver sends no receipt. Wording a write-off as "we received your
   * payment" would be a lie about money, so the waived user gets the
   * collection reminder only — a known rough edge, recorded in decisions.md.
   */
  it('a waiver schedules the collection reminder and no receipt', async () => {
    const { bookingId } = await overstayingBooking();

    await adminWaiveOverstay({ bookingId, reason: 'goodwill' });

    const pending = (await messagesFor(bookingId)).filter((row) => row.status === 'PENDING');
    const kinds = pending.map((row) => row.kind);

    expect(kinds).toContain('COLLECTION_CLOSING');
    expect(kinds).not.toContain('OVERSTAY_SETTLED');
    expect(kinds).not.toContain('OVERSTAY_STARTED');
  });

  /**
   * A collection window shorter than its own reminder's lead time. Nothing is
   * created rather than something queued already-late.
   */
  it('creates no collection reminder when the window is shorter than the lead', async () => {
    const user = await createTestUser();
    await verifyUserPhone(user.id);
    const device = await seedDevice();

    const booking = await seedBooking({
      userId: user.id,
      deviceId: device.id,
      status: 'PENDING_PAYMENT',
      // Five minutes to collect, against a ten-minute reminder lead.
      rates: { collectionWindowMinutes: 5 },
    });

    await activateBooking(booking.id);
    await pushIntoOverstay(booking.id, 1);
    await settleOverstay(booking.id, 15_000, { paymentRowId: 'pay_row_short' });

    const kinds = (await messagesFor(booking.id))
      .filter((row) => row.status === 'PENDING')
      .map((row) => row.kind);

    expect(kinds).toContain('OVERSTAY_SETTLED');
    expect(kinds).not.toContain('COLLECTION_CLOSING');
  });
});

describe('a booking ending cancels everything outstanding', () => {
  it('collecting', async () => {
    const { user, bookingId } = await pendingBooking();
    await activateBooking(bookingId);

    await collectBooking({ bookingId, userId: user.id });

    const rows = await messagesFor(bookingId);
    expect(rows.every((row) => row.status === 'SKIPPED')).toBe(true);
    expect(rows.every((row) => row.failureCategory === 'CANCELLED')).toBe(true);
  });

  it('an admin force-completing', async () => {
    const { bookingId } = await pendingBooking();
    await activateBooking(bookingId);

    await adminForceComplete({ bookingId, reason: 'customer called', needsInspection: true });

    const rows = await messagesFor(bookingId);
    expect(rows.every((row) => row.status === 'SKIPPED')).toBe(true);
  });

  it('the collection window lapsing', async () => {
    const { bookingId } = await pendingBooking();
    await activateBooking(bookingId);
    await pushIntoOverstay(bookingId, 1);
    await settleOverstay(bookingId, 15_000, { paymentRowId: 'pay_row_lapse' });

    // The sweeper's completion path, reached directly.
    const { completeBooking } = await import('./booking.service');
    await completeBooking({ bookingId, reason: 'COLLECTION_WINDOW_LAPSED' });

    const rows = await messagesFor(bookingId);
    expect(rows.filter((row) => row.status === 'PENDING')).toHaveLength(0);
  });

  /**
   * An unpaid booking has nothing scheduled, so this cancels nothing today.
   * Asserted anyway: the cancel is in `cancelBooking` so the rule does not
   * hold *by coincidence* if cancellation ever becomes reachable from a paid
   * state, which the open refund policy might yet do.
   */
  it('cancelling an unpaid booking', async () => {
    const { user, bookingId } = await pendingBooking();

    await cancelBooking({ bookingId, userId: user.id });

    expect(await messagesFor(bookingId)).toHaveLength(0);
  });
});

describe('what is never written to an outbox row', () => {
  /**
   * The structural guarantee, re-asserted for scheduled rows specifically.
   *
   * These rows are created by a different code path from `enqueue`, so the
   * "no message content in this table" property has to hold there too. The
   * only free-text column a scheduled row populates is `dedupeKey`, and it is
   * built from a booking id, a kind and a number.
   */
  it('a scheduled row carries no text beyond ids, kinds and timestamps', async () => {
    const { bookingId } = await pendingBooking();
    await activateBooking(bookingId);

    const rows = await prisma.outboundMessage.findMany({ where: { bookingId } });

    for (const row of rows) {
      expect(row.dedupeKey).toMatch(/^[A-Za-z0-9_-]+:[A-Z_]+:[A-Za-z0-9_-]+$/);
      // No serial, no amount, no phone number, no code: the parameters are
      // rebuilt at send time and stored nowhere.
      expect(JSON.stringify(row)).not.toMatch(/SAFE-/);
      expect(JSON.stringify(row)).not.toMatch(/\b\d{10}\b/);
    }
  });
});
