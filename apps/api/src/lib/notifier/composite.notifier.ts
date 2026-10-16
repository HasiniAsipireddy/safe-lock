import { logger } from '../logger';
import type { PrismaTransaction } from '../prisma';
import type { Notifier, UnlockNotification } from './notifier';

/**
 * Runs several notifiers for one event.
 *
 * ## Why a composite rather than an env switch
 * `DEVICE_GATEWAY` picks *one* gateway because a device has one transport.
 * Notification is not like that: the in-app bell and WhatsApp are both wanted,
 * always, and a user with no verified number should still get the in-app
 * record. "Which notifier?" was never the question — it is "all of them".
 *
 * ## Failure semantics, and why they are not uniform
 * Notifiers run **in order**, and a throw propagates — which rolls the unlock
 * back, per the `Notifier` contract. That is deliberate for the in-app
 * notifier: it is a single insert on the same connection, so if it cannot be
 * written something is badly wrong, and "the safe opened and we never recorded
 * it" is the worse failure.
 *
 * The WhatsApp notifier cannot trigger that, by construction rather than by a
 * try/catch here: it only writes an outbox row, so it fails for the same
 * reasons the in-app insert would. There is no `catch` in this class on
 * purpose — a swallowed error here would silently convert a real database
 * problem into a successful unlock with no record.
 */
export class CompositeNotifier implements Notifier {
  readonly name: string;

  private readonly notifiers: readonly Notifier[];

  constructor(notifiers: readonly Notifier[]) {
    this.notifiers = notifiers;
    this.name = `composite(${notifiers.map((one) => one.name).join('+')})`;
  }

  async notifyUnlock(client: PrismaTransaction, event: UnlockNotification): Promise<void> {
    for (const notifier of this.notifiers) {
      await notifier.notifyUnlock(client, event);
    }

    logger.debug(
      { userId: event.userId, type: event.type, channels: this.notifiers.length },
      'Recorded unlock notifications',
    );
  }
}
