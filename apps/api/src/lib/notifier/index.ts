import { CompositeNotifier } from './composite.notifier';
import { InAppNotifier } from './inApp.notifier';
import { WhatsAppNotifier } from './whatsApp.notifier';
import type { Notifier } from './notifier';

export type { Notifier, UnlockNotification } from './notifier';
export { InAppNotifier } from './inApp.notifier';
export { WhatsAppNotifier } from './whatsApp.notifier';
export { CompositeNotifier } from './composite.notifier';

/**
 * The notifier the application talks to.
 *
 * Still **no `NOTIFIER` environment variable**, and now for a firmer reason
 * than "there is only one implementation". The second channel turned out to be
 * composite rather than alternative, exactly as the step-3 note predicted: the
 * in-app bell and WhatsApp are both always wanted, and a user with no verified
 * number must still get the in-app record. There is no deployment that would
 * sensibly want one without the other, so there is nothing to configure.
 *
 * Order matters. The in-app notifier runs first: it is the authoritative
 * record and the one whose failure should roll an unlock back. The WhatsApp
 * notifier only queues a row — it makes no network call — so it cannot turn a
 * provider outage into a safe that will not open.
 *
 * Resolved once at module load, as the gateway is.
 */
export const notifier: Notifier = new CompositeNotifier([
  new InAppNotifier(),
  new WhatsAppNotifier(),
]);
