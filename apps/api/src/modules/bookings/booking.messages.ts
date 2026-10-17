import {
  BOOKING_REMINDER_LEAD_MINUTES,
  COLLECTION_REMINDER_LEAD_MINUTES,
  OVERSTAY_NOTICE_DELAY_SECONDS,
  collectByFrom,
  overstayStartsAt,
} from '@safelock/shared';
import type { PrismaTransaction } from '../../lib/prisma';
import type { BookingMessageKind } from '../../lib/whatsapp/send';
import { snapshotOf, type BookingRow } from './booking.mapper';

/**
 * Scheduling and cancelling a booking's WhatsApp messages.
 *
 * ## Both functions take the transaction client
 * The same contract as `Notifier.notifyUnlock` and `enqueue`, for the same
 * reason: a rollback must not leave a message queued about something that
 * never happened. Scheduling is a local insert, so it stays atomic with the
 * state change that justified it, and nothing is sent until the worker picks
 * the row up after the commit.
 *
 * ## Scheduling is idempotent by key, not by read
 * Every row carries a `dedupeKey` built from stable identifiers, and the
 * insert is `createMany({ skipDuplicates: true })`. No "have we already
 * scheduled this?" query, which could not be made correct anyway: settlement
 * runs from both the verified Checkout callback and the webhook, and two
 * concurrent transactions would both read "no".
 *
 * **The discriminators are deliberately not `now`.** A confirmation is keyed
 * on the booking's `endsAt`, a receipt on the payment that paid it, and the
 * deadline kinds on their own due time — all facts that two racing settlements
 * agree about. Keying on the current time would make the duplicate a different
 * row and send the message twice.
 *
 * ## Nothing here decides whether a message is true
 * These functions schedule from the state in front of them. Whether a message
 * may actually be *sent* is re-decided at send time against the live booking
 * (`lib/outbox/bookingMessages.ts`). The two guards are independent, exactly
 * like the two unlock-eligibility checks: cancellation is the tidy path, and
 * re-validation is what makes a missed cancellation harmless rather than a
 * false statement about somebody's safe.
 */

/** What just happened to the booking, and the facts that only it knows. */
export type SchedulePhase =
  /** Payment captured: the booking is running. */
  | { phase: 'ACTIVATION' }
  /** More hours bought: every deadline moved. */
  | { phase: 'EXTENSION' }
  /** Overstay fee captured. */
  | { phase: 'OVERSTAY_SETTLED'; paymentRowId: string; settledAt: Date }
  /** Overstay fee written off by an admin. */
  | { phase: 'OVERSTAY_WAIVED'; waivedAt: Date };

/** The kinds whose due time is a deadline that an extension moves. */
const DEADLINE_KINDS: readonly BookingMessageKind[] = [
  'BOOKING_ENDING_SOON',
  'OVERSTAY_STARTED',
];

interface PlannedMessage {
  kind: BookingMessageKind;
  sendAt: Date;
  dedupeKey: string;
}

/**
 * Works out which messages this phase wants, with their due times and keys.
 *
 * Pure, and exported for the tests: the due-time arithmetic is the part most
 * worth asserting directly, and driving it through a worker would obscure
 * which number came from where.
 */
export function plan(
  row: BookingRow,
  phase: SchedulePhase,
  now: Date,
): readonly PlannedMessage[] {
  const snapshot = snapshotOf(row);
  const planned: PlannedMessage[] = [];

  /**
   * A deadline message whose lead time exceeds the time actually left is not
   * created at all.
   *
   * Load-bearing in two places: a collection window shorter than its own
   * 10-minute lead (`COLLECTION_WINDOW_MINUTES` can be set to 5), and an
   * extension bought with minutes remaining. Scheduling them anyway would
   * queue a row that is already late, which the staleness check would then
   * discard — the same outcome, reached noisily.
   */
  const pushIfFuture = (kind: BookingMessageKind, sendAt: Date) => {
    if (sendAt.getTime() <= now.getTime()) return;
    planned.push({ kind, sendAt, dedupeKey: keyFor(row.id, kind, sendAt.getTime()) });
  };

  if (phase.phase === 'ACTIVATION' || phase.phase === 'EXTENSION') {
    if (!row.endsAt) return planned;

    /**
     * The confirmation is immediate, so it is **not** subject to the
     * future-only rule: it describes something that just happened rather than
     * a deadline, and its due time being "now" is the whole point.
     *
     * Keyed on `endsAt`, which is what makes an extension's confirmation a
     * new message and a double settlement's confirmation the same one.
     */
    planned.push({
      kind: 'BOOKING_CONFIRMED',
      sendAt: now,
      dedupeKey: keyFor(row.id, 'BOOKING_CONFIRMED', row.endsAt.getTime()),
    });

    for (const leadMinutes of BOOKING_REMINDER_LEAD_MINUTES) {
      pushIfFuture(
        'BOOKING_ENDING_SOON',
        new Date(row.endsAt.getTime() - leadMinutes * 60 * 1000),
      );
    }

    /**
     * A minute past the start of the fee, never at it.
     *
     * At exactly `endsAt + grace` the accrued fee is zero, and re-validation
     * requires an outstanding fee — so a message due at that instant would be
     * refused on every poll until it went stale, and the notice that matters
     * most would never arrive. See `OVERSTAY_NOTICE_DELAY_SECONDS`.
     */
    pushIfFuture(
      'OVERSTAY_STARTED',
      new Date(
        overstayStartsAt(snapshot, row.endsAt).getTime() +
          OVERSTAY_NOTICE_DELAY_SECONDS * 1000,
      ),
    );

    return planned;
  }

  // The fee is dealt with: what is left is collecting.
  const settledAt = phase.phase === 'OVERSTAY_SETTLED' ? phase.settledAt : phase.waivedAt;
  const collectBy = collectByFrom(snapshot, settledAt);

  if (phase.phase === 'OVERSTAY_SETTLED') {
    /**
     * A receipt, keyed on the **payment**.
     *
     * The verified Checkout callback and the webhook both settle, so a key
     * carrying the time would send two receipts for one payment. A waiver
     * gets no receipt at all — see `OVERSTAY_WAIVED` below.
     */
    planned.push({
      kind: 'OVERSTAY_SETTLED',
      sendAt: now,
      dedupeKey: keyFor(row.id, 'OVERSTAY_SETTLED', phase.paymentRowId),
    });
  }

  /**
   * A waived fee sends **only** this, and no receipt.
   *
   * Wording a write-off as "we received your payment of ₹0" would be a lie
   * about money, and a sixth approved template to say "no fee is outstanding"
   * buys one sentence. So a waived user gets the collection reminder and
   * nothing immediate; the admin who waived is expected to tell them. Recorded
   * in docs/decisions.md as a known rough edge.
   */
  pushIfFuture(
    'COLLECTION_CLOSING',
    new Date(collectBy.getTime() - COLLECTION_REMINDER_LEAD_MINUTES * 60 * 1000),
  );

  return planned;
}

/**
 * The idempotency key for one scheduled message.
 *
 * `<bookingId>:<kind>:<discriminator>` — see the `dedupeKey` column comment.
 * Exported so a test can assert that re-scheduling after an extension produces
 * keys that differ from the cancelled ones: a collision would be silently
 * dropped by `skipDuplicates`, which is a reminder that never arrives.
 */
export function keyFor(
  bookingId: string,
  kind: BookingMessageKind,
  discriminator: string | number,
): string {
  return `${bookingId}:${kind}:${discriminator}`;
}

/**
 * Schedules everything this phase calls for. **Inside the caller's
 * transaction.**
 *
 * Returns how many rows were created, which is less than the plan whenever a
 * key already existed — the normal outcome of a double settlement, and not an
 * error.
 */
export async function scheduleFor(
  client: PrismaTransaction,
  row: BookingRow,
  phase: SchedulePhase,
  now = new Date(),
): Promise<number> {
  const planned = plan(row, phase, now);
  if (planned.length === 0) return 0;

  const result = await client.outboundMessage.createMany({
    data: planned.map((message) => ({
      userId: row.userId,
      bookingId: row.id,
      kind: message.kind,
      status: 'PENDING' as const,
      sendAt: message.sendAt,
      // Seeded to the due time, like `enqueue` does, so the backoff column
      // never reads as "retryable since before it was due".
      nextAttemptAt: message.sendAt,
      dedupeKey: message.dedupeKey,
    })),
    skipDuplicates: true,
  });

  return result.count;
}

/**
 * Cancels unsent messages for a booking. **Inside the caller's transaction.**
 *
 * `SKIPPED`/`CANCELLED` rather than deleted: the row is the record that we
 * meant to tell someone something and then correctly did not, which is worth
 * being able to read afterwards. Only `PENDING` rows are touched — a message
 * already sent cannot be unsent, and pretending otherwise in the data would
 * make the outbox a worse record than the user's own phone.
 *
 * Omit `kinds` to cancel everything outstanding, which is what ending a
 * booking means.
 */
export async function cancelPending(
  client: PrismaTransaction,
  bookingId: string,
  kinds?: readonly BookingMessageKind[],
): Promise<number> {
  const result = await client.outboundMessage.updateMany({
    where: {
      bookingId,
      status: 'PENDING',
      ...(kinds ? { kind: { in: [...kinds] } } : {}),
    },
    data: { status: 'SKIPPED', failureCategory: 'CANCELLED' },
  });

  return result.count;
}

/**
 * What an extension invalidates: every deadline message, because every
 * deadline moved. The confirmation is not cancelled — it was true when it was
 * sent, and the new one supersedes it.
 */
export async function cancelDeadlineMessages(
  client: PrismaTransaction,
  bookingId: string,
): Promise<number> {
  return cancelPending(client, bookingId, DEADLINE_KINDS);
}
