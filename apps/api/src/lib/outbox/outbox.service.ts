import { env } from '../../config/env';
import { logger } from '../logger';
import { prisma, type PrismaTransaction } from '../prisma';
import { isRetryable } from '../whatsapp';
import {
  isBookingMessageKind,
  loadRecipient,
  sendWhatsApp,
  type MessageKind,
  type SkipReason,
} from '../whatsapp/send';
import { revalidate } from './bookingMessages';
import { buildParams } from './params';

/**
 * The WhatsApp outbox.
 *
 * ## The one rule
 * **Enqueueing is a database write; sending is not.** `enqueue` takes a
 * transaction client and does nothing but insert a row, so it is atomic with
 * whatever event it accompanies and cannot fail for any reason a network can
 * invent. Everything that can actually fail — the send — happens later, in
 * {@link processPending}, after the commit.
 *
 * That is what lets the unlock flow keep its in-app notification atomic (step
 * 2's trade-off, unchanged) while a WhatsApp outage degrades to a `PENDING`
 * row instead of a safe that will not open.
 *
 * ## Why this is not a queue
 * One table, one poll loop, `FOR UPDATE SKIP LOCKED` to claim. The property
 * that matters — "a rollback cannot unsend a message" — comes from writing the
 * row inside the transaction, not from the transport. A broker would add
 * concurrency and scheduling this workload has no use for, plus a service to
 * run and a second failure domain. The upgrade seam is this file.
 * See docs/decisions.md.
 */

export interface EnqueueInput {
  userId: string;
  kind: MessageKind;
  /** The device event this message is about, when there is one. */
  deviceEventId?: string | null;
  /**
   * When the message becomes due. Defaults to now, which is every
   * pre-rental kind's behaviour and stays byte-identical to it.
   */
  sendAt?: Date;
  /** The booking this message is about, for a scheduled lifecycle kind. */
  bookingId?: string | null;
  /** Idempotency key. See the column comment in schema.prisma. */
  dedupeKey?: string | null;
}

/**
 * A terminal skip reason.
 *
 * Wider than {@link SkipReason}, which is only the three things *sending*
 * can refuse. These four are decided by the worker before or instead of a
 * send: the message was cancelled, re-validation refused it, or it was
 * claimed too late to be true.
 */
export type TerminalSkipReason =
  | SkipReason
  | 'CANCELLED'
  | 'NOT_APPLICABLE'
  | 'STALE';

/**
 * Queues a message. **Must be called inside the transaction it belongs to.**
 *
 * Takes the transaction client for the same reason `Notifier.notifyUnlock`
 * does: if the surrounding transaction rolls back, the message was never
 * queued, so nobody is told about something that did not happen.
 *
 * Note what is *not* stored: the template parameters. They can contain a
 * one-time code, so they are rebuilt from live data at send time. A dump of
 * this table says who was messaged about what, and no codes.
 */
export async function enqueue(
  client: PrismaTransaction,
  input: EnqueueInput,
): Promise<string> {
  const sendAt = input.sendAt ?? new Date();

  const row = await client.outboundMessage.create({
    data: {
      userId: input.userId,
      kind: input.kind,
      status: 'PENDING',
      deviceEventId: input.deviceEventId ?? null,
      sendAt,
      /**
       * Seeded to `sendAt`, not to now.
       *
       * The claim query requires both to have elapsed, so leaving this at the
       * default would make no difference to *when* a message goes out — but it
       * would make the backoff column read as "retryable since before it was
       * due", which is the kind of small lie that costs an hour during an
       * incident.
       */
      nextAttemptAt: sendAt,
      bookingId: input.bookingId ?? null,
      dedupeKey: input.dedupeKey ?? null,
    },
    select: { id: true },
  });

  return row.id;
}

/**
 * Marks a message as deliberately not sent.
 *
 * A terminal state that is **not** `FAILED`: nothing was attempted, so there
 * is nothing to retry and nothing wrong with the provider. Keeping them apart
 * is what stops "this user never verified their phone" from showing up in a
 * delivery-failure count. See the enum comment in schema.prisma.
 */
export async function markSkipped(
  client: PrismaTransaction | typeof prisma,
  id: string,
  reason: TerminalSkipReason,
): Promise<void> {
  await client.outboundMessage.update({
    where: { id },
    data: { status: 'SKIPPED', failureCategory: reason },
  });
}

/**
 * Whether a due time is too far behind `now` for the message to still be
 * honest.
 *
 * A pure function of two dates and one setting, exported so the boundary can
 * be tested directly rather than inferred from a worker run.
 */
export function isStale(sendAt: Date, now: Date): boolean {
  const toleranceMs = env.REMINDER_MAX_LATENESS_MINUTES * 60 * 1000;
  return now.getTime() - sendAt.getTime() > toleranceMs;
}

/** Backoff for attempt `n`: 30s, 2m, 8m, 32m … capped at an hour. */
export function backoffMs(attempts: number): number {
  const base = 30_000 * 4 ** Math.max(0, attempts - 1);
  return Math.min(base, 60 * 60 * 1000);
}

export interface ProcessResult {
  claimed: number;
  sent: number;
  failed: number;
  skipped: number;
  retrying: number;
}

/**
 * Sends one batch of due messages.
 *
 * Claiming uses `FOR UPDATE SKIP LOCKED`, the same pattern as the device
 * allocation pick: a second worker (or a second API instance later) steps over
 * a row another is holding rather than blocking on it or double-sending.
 *
 * Exported and callable directly, which is how the tests drive it — nothing in
 * the suite waits for a timer.
 */
export async function processPending(
  options: { limit?: number; now?: Date } = {},
): Promise<ProcessResult> {
  const limit = options.limit ?? 10;
  const now = options.now ?? new Date();

  const result: ProcessResult = { claimed: 0, sent: 0, failed: 0, skipped: 0, retrying: 0 };

  /**
   * Claim inside a short transaction and commit before sending.
   *
   * The row is marked as attempted (`attempts + 1`, backoff pushed out) and
   * the transaction closes. Holding it open across the HTTP call would pin a
   * connection for the length of a Meta round trip, which is exactly the
   * mistake the `Command` deferral note warns about for MQTT.
   */
  const claimed = await prisma.$transaction(async (tx) => {
    /**
     * Both clauses, and the pair is the point.
     *
     * `sendAt` is when the message became due; `nextAttemptAt` is retry
     * backoff. Requiring both means a backoff can only ever push a message
     * later, never pull one earlier than its due time — so a retry cannot
     * deliver "your booking ends in 30 minutes" an hour early, which is the
     * one direction a scheduled message must never move.
     *
     * Ordered by `sendAt` rather than `createdAt`: a reminder queued at
     * activation is due hours after a receipt queued later, and the queue
     * should drain in the order things are *due*.
     */
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "OutboundMessage"
      WHERE "status" = 'PENDING'
        AND "sendAt" <= ${now}
        AND "nextAttemptAt" <= ${now}
      ORDER BY "sendAt" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `;

    const ids = rows.map((row) => row.id);
    if (ids.length === 0) return [];

    // Push the backoff out before releasing the lock, so a crash between here
    // and the send cannot produce a hot retry loop.
    await tx.outboundMessage.updateMany({
      where: { id: { in: ids } },
      data: { attempts: { increment: 1 }, nextAttemptAt: new Date(now.getTime() + 30_000) },
    });

    return tx.outboundMessage.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        userId: true,
        kind: true,
        attempts: true,
        deviceEventId: true,
        bookingId: true,
        sendAt: true,
      },
    });
  });

  result.claimed = claimed.length;

  for (const message of claimed) {
    /**
     * Too late to be true? Then say nothing.
     *
     * A deadline message delivered long after its deadline is not a late
     * message, it is a false one: "your booking ends in 10 minutes", arriving
     * forty minutes after it ended, actively misinforms somebody about a safe
     * holding their things. Applies only to booking kinds — a message about
     * something that already happened (an unlock alert, a receipt) has no
     * deadline to miss, and those should go out however late they are.
     *
     * The tolerance is generous relative to the poll interval (5 minutes
     * against 5 seconds), so an ordinary restart or a slow deploy loses
     * nothing; only a worker that was genuinely down for minutes does.
     */
    if (message.bookingId && isStale(message.sendAt, now)) {
      await markSkipped(prisma, message.id, 'STALE');
      result.skipped += 1;
      logger.warn(
        {
          outboundMessageId: message.id,
          kind: message.kind,
          bookingId: message.bookingId,
          latenessMs: now.getTime() - message.sendAt.getTime(),
          toleranceMinutes: env.REMINDER_MAX_LATENESS_MINUTES,
        },
        'Skipped a scheduled message claimed past its lateness tolerance',
      );
      continue;
    }

    const recipient = await loadRecipient(message.userId);

    if (!recipient) {
      // The user was deleted between enqueue and send. Nothing to do, ever.
      await markSkipped(prisma, message.id, 'NO_VERIFIED_PHONE');
      result.skipped += 1;
      continue;
    }

    /**
     * A booking message earns its send here, every time.
     *
     * The booking is re-read and the parameters come out of that same read, so
     * there is no window in which a message could be sent with text built from
     * one state and a decision made from another. A refusal is `SKIPPED`, not a
     * failure: nothing was attempted and nothing should be retried.
     */
    let params: readonly string[];
    let urlButtonSuffix: string | undefined;

    if (message.bookingId && isBookingMessageKind(message.kind)) {
      const check = await revalidate(message.kind, message.bookingId, now);

      if (!check.ok) {
        await markSkipped(prisma, message.id, 'NOT_APPLICABLE');
        result.skipped += 1;
        logger.info(
          {
            outboundMessageId: message.id,
            kind: message.kind,
            bookingId: message.bookingId,
            reason: check.reason,
          },
          'Scheduled message no longer applies; not sent',
        );
        continue;
      }

      params = check.params;
      urlButtonSuffix = check.urlButtonSuffix;
    } else {
      params = await buildParams(message.kind, {
        userId: message.userId,
        deviceEventId: message.deviceEventId,
      });
    }

    const outcome = await sendWhatsApp({
      recipient,
      kind: message.kind,
      params,
      ...(urlButtonSuffix === undefined ? {} : { urlButtonSuffix }),
    });

    if (outcome.status === 'SENT') {
      await prisma.outboundMessage.update({
        where: { id: message.id },
        data: {
          status: 'SENT',
          sentAt: new Date(),
          providerMessageId: outcome.providerMessageId,
          failureCategory: null,
        },
      });
      result.sent += 1;
      continue;
    }

    if (outcome.status === 'SKIPPED') {
      await markSkipped(prisma, message.id, outcome.reason);
      result.skipped += 1;
      continue;
    }

    // Failed. Retry only if the category says another attempt could differ
    // and there are attempts left.
    const exhausted = message.attempts >= env.OUTBOX_MAX_ATTEMPTS;
    const giveUp = exhausted || !isRetryable(outcome.category);

    await prisma.outboundMessage.update({
      where: { id: message.id },
      data: {
        status: giveUp ? 'FAILED' : 'PENDING',
        failureCategory: outcome.category,
        nextAttemptAt: new Date(now.getTime() + backoffMs(message.attempts)),
      },
    });

    if (giveUp) {
      result.failed += 1;
      logger.error(
        {
          outboundMessageId: message.id,
          kind: message.kind,
          category: outcome.category,
          attempts: message.attempts,
          reason: exhausted ? 'attempts exhausted' : 'not retryable',
        },
        'Giving up on an outbound WhatsApp message',
      );
    } else {
      result.retrying += 1;
    }
  }

  return result;
}
