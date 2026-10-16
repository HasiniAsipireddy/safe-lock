import { enqueue } from '../outbox/outbox.service';
import type { PrismaTransaction } from '../prisma';
import type { Notifier, UnlockNotification } from './notifier';

/**
 * Queues a WhatsApp message about an unlock.
 *
 * ## It does not send anything
 * Despite the name, this notifier makes **no network call**. It writes one
 * `OutboundMessage` row through the transaction client it is given, and the
 * poll worker sends after the commit. Everything the `Notifier` contract
 * promises therefore still holds: the write is atomic with the `DeviceEvent`,
 * and a rollback takes the queued message with it, so nobody is told their
 * safe opened when it did not.
 *
 * ## Why that is the whole design
 * The alternative — sending here — breaks in both directions. A message
 * already delivered cannot be unsent by a rollback. And because throwing from
 * a notifier rolls the unlock back (step 2's deliberate trade-off), a WhatsApp
 * outage would mean a safe that refuses to open because a *notification*
 * channel was down. That trade-off is right for the in-app record, which is a
 * single insert on the same connection and effectively cannot fail on its own;
 * it is wrong for a third-party HTTP API.
 *
 * So: the in-app notification stays atomic and blocking, and this one degrades
 * to a `PENDING` row. See docs/decisions.md.
 */
export class WhatsAppNotifier implements Notifier {
  readonly name = 'whatsapp';

  async notifyUnlock(client: PrismaTransaction, event: UnlockNotification): Promise<void> {
    await enqueue(client, {
      userId: event.userId,
      kind:
        event.type === 'UNLOCK_CONFIRMED' ? 'UNLOCK_ALERT' : 'FAILED_ATTEMPTS_ALERT',
      deviceEventId: event.deviceEventId,
    });
  }
}
