import { WhatsAppResetSender } from './whatsApp.resetSender';
import type { ResetSender } from './resetSender';

export type { ResetSender, ResetDelivery, ResetDeliveryOutcome } from './resetSender';
export { WhatsAppResetSender } from './whatsApp.resetSender';

/**
 * The reset sender the application talks to.
 *
 * One implementation, so no env switch — the same reasoning as the notifier
 * before WhatsApp arrived. An email sender would make this a composite (both
 * channels, for whoever has them) rather than a choice, so the shape to add it
 * in is a `CompositeResetSender`, not a `RESET_SENDER` enum.
 *
 * The WhatsApp sender resolves its own client lazily through
 * `lib/whatsapp/send.ts`, so in dev and test this is the fake and nothing
 * leaves the process.
 */
export const resetSender: ResetSender = new WhatsAppResetSender();
