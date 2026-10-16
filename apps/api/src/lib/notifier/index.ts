import { InAppNotifier } from './inApp.notifier';
import type { Notifier } from './notifier';

export type { Notifier, UnlockNotification } from './notifier';
export { InAppNotifier } from './inApp.notifier';

/**
 * The notifier the application talks to.
 *
 * There is no `NOTIFIER` environment variable, unlike `DEVICE_GATEWAY`: with
 * one implementation an env switch would have exactly one legal value, which
 * is configuration that cannot be configured. It arrives in step 4 together
 * with the second implementation — probably as a composite (in-app *and*
 * WhatsApp) rather than a choice between them, which is a different shape from
 * the gateway's enum and not worth guessing at now.
 *
 * Resolved once at module load, as the gateway is, so an implementation that
 * holds a connection has somewhere to hold it.
 */
export const notifier: Notifier = new InAppNotifier();
