import { logger } from '../logger';
import { loadRecipient, sendWhatsApp } from '../whatsapp/send';
import type { ResetDelivery, ResetDeliveryOutcome, ResetSender } from './resetSender';

/**
 * Delivers a password reset **code** over WhatsApp, to a verified number only.
 *
 * ## What changed from step 4, and why
 * This used to send a parameterless "a reset was requested" notice, because
 * the credential of the day was a 32-byte token and putting one in a chat
 * message is an account takeover that outlives its expiry in someone's
 * history. The notice was safe and **useless**: there was nothing in it the
 * user could act on, so reset did not work in production.
 *
 * A code is different in kind. It is 8 digits, dead in 15 minutes, spent on
 * first use, worthless without the account identifier, and bounded by five
 * attempts. That is a credential a forwardable message can carry.
 *
 * ## Email-only is still a dead end
 * A user with no verified phone has no channel, and this returns `SKIPPED`.
 * `/forgot-password` says so generically, without revealing which case it hit.
 * The long-term fix is an email sender — see CLAUDE.md's open questions.
 */
export class WhatsAppResetSender implements ResetSender {
  readonly name = 'whatsapp';

  async send(delivery: ResetDelivery): Promise<ResetDeliveryOutcome> {
    const recipient = await loadRecipient(delivery.userId);
    if (!recipient) {
      return { status: 'SKIPPED', reason: 'NO_RECIPIENT' };
    }

    /**
     * The cap applies here, unlike to an unlock code.
     *
     * An unlock code is the owner reaching their own safe and must not be
     * cap-blocked. A reset code is triggered by an **unauthenticated** request
     * against a known identifier, which is precisely the endpoint someone
     * would use to bombard a stranger's phone. Because the response is
     * identical either way, the cap costs an attacker nothing to learn and
     * gains them nothing.
     */
    const outcome = await sendWhatsApp({
      recipient,
      kind: 'PASSWORD_RESET',
      params: [delivery.code],
    });

    if (outcome.status === 'SENT') return { status: 'SENT' };
    if (outcome.status === 'SKIPPED') return { status: 'SKIPPED', reason: outcome.reason };

    logger.warn(
      { userId: delivery.userId, category: outcome.category },
      'Could not deliver a password reset code',
    );
    return { status: 'FAILED', reason: outcome.category };
  }
}
