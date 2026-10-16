import type { PrismaTransaction } from '../prisma';
import type { Notifier, UnlockNotification } from './notifier';

/**
 * Writes a row to `Notification` for the web app's bell to read.
 *
 * The only implementation today, and the only one that can be truly atomic
 * with the event it describes — it is a single insert on the same connection
 * and inside the same transaction.
 *
 * No message text is stored. The wording comes from `NOTIFICATION_COPY` in
 * `@safelock/shared` when the notification is read, so a copy fix is a deploy
 * rather than a migration, and nothing user-supplied is ever persisted here.
 */
export class InAppNotifier implements Notifier {
  readonly name = 'in-app';

  async notifyUnlock(client: PrismaTransaction, event: UnlockNotification): Promise<void> {
    await client.notification.create({
      data: {
        userId: event.userId,
        type: event.type,
        deviceEventId: event.deviceEventId,
      },
    });
  }
}
