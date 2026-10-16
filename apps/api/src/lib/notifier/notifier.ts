import type { NotificationType } from '@safelock/shared';
import type { PrismaTransaction } from '../prisma';

/**
 * The notification seam.
 *
 * Shaped like {@link ../deviceGateway/gateway DeviceGateway} for the same
 * reason: there is exactly one place the application says "tell this person
 * something happened", so adding a channel (WhatsApp, step 4) is a new file
 * here and nowhere else. `deviceControl.service.ts` must not change to gain
 * one.
 */

/**
 * What happened, in the only terms a notifier needs.
 *
 * Note what is absent: no OTP, no attempt count, no request object, no email
 * address or phone number. A channel that needs a destination looks it up from
 * `userId` itself — passing contact details through here would mean every
 * implementation handled personal data whether or not it used it.
 */
export interface UnlockNotification {
  userId: string;
  type: NotificationType;
  /** The `DeviceEvent` this describes. */
  deviceEventId: string;
  /** For a channel that wants to name the safe in its message. */
  serialNumber: string;
}

export interface Notifier {
  readonly name: string;

  /**
   * Records or sends a notification about an unlock.
   *
   * **Takes the transaction client, and that is the contract.** The caller is
   * inside the transaction that writes the `DeviceEvent`, so an implementation
   * that writes through `client` is atomic with the event it describes: there
   * can be no notification about an unlock that rolled back, and no unlock the
   * owner was never told about.
   *
   * This is also what keeps a future out-of-process channel honest. Sending a
   * WhatsApp message is not transactional and must **not** be done from here —
   * step 4's implementation writes an outbox row through `client` and lets a
   * worker send it after the commit. Firing a real message inside a
   * transaction that can still roll back is how people get told their safe
   * opened when it did not. See docs/decisions.md.
   *
   * Throwing is meaningful: it rolls the whole unlock back. An implementation
   * must only throw when the notification genuinely could not be recorded.
   */
  notifyUnlock(client: PrismaTransaction, event: UnlockNotification): Promise<void>;
}
