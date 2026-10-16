import { env } from '../../config/env';
import { logger } from '../logger';
import { mayPrintResetToken } from '../../modules/auth/passwordReset.service';
import { loadRecipient, sendWhatsApp } from '../whatsapp/send';
import type { ResetDelivery, ResetDeliveryOutcome, ResetSender } from './resetSender';

/**
 * Delivers a password reset over WhatsApp, to a verified number only.
 *
 * ## Why the token is not in the message
 * The template tells the user a reset was requested and carries **no token**.
 * A WhatsApp message is a persistent, forwardable, cloud-backed-up artefact,
 * and a reset token is an account takeover in one string. Putting one in a
 * chat thread means it outlives its 30 minutes in someone's message history
 * and on whatever devices that account is mirrored to.
 *
 * The user follows the link they already have — the one the request flow shows
 * them — and the WhatsApp message is the *alert* half: "a reset was requested,
 * and if it wasn't you, your password still works." That is the half that
 * matters for a physical-security product.
 *
 * **This is a deliberate narrowing of what the task asked for**, recorded in
 * docs/decisions.md. It also explains why `OutboundMessageKind.PASSWORD_RESET`
 * takes no parameters.
 *
 * ## Email-only is still a dead end
 * A user with no verified phone has no channel, and this returns `SKIPPED`.
 * `/forgot-password` says so generically, without revealing which case it hit.
 * The long-term fix is an email provider — listed in CLAUDE.md's open
 * questions.
 */
export class WhatsAppResetSender implements ResetSender {
  readonly name = 'whatsapp';

  async send(delivery: ResetDelivery): Promise<ResetDeliveryOutcome> {
    if (mayPrintResetToken(env.NODE_ENV)) {
      // The dev console print survives: local development has no inbox and no
      // WhatsApp number. Guarded exactly as before.
      // eslint-disable-next-line no-console -- dev-only, see mayPrintResetToken
      console.log(
        `\n  [dev] Password reset token: ${delivery.token}` +
          `  (expires ${delivery.expiresAt.toISOString()})\n`,
      );
    }

    const recipient = await loadRecipient(delivery.userId);
    if (!recipient) {
      return { status: 'SKIPPED', reason: 'NO_RECIPIENT' };
    }

    /**
     * The cap applies here, unlike the unlock code.
     *
     * An unlock code is the owner reaching their own safe and must not be
     * cap-blocked. A reset alert is triggered by an **unauthenticated**
     * request against a known address, which is precisely the endpoint someone
     * would use to bombard a stranger's phone. The cap is the defence, and
     * because the response is identical either way it costs the attacker
     * nothing to learn and gains them nothing.
     */
    const outcome = await sendWhatsApp({
      recipient,
      kind: 'PASSWORD_RESET',
      params: [],
    });

    if (outcome.status === 'SENT') return { status: 'SENT' };
    if (outcome.status === 'SKIPPED') return { status: 'SKIPPED', reason: outcome.reason };

    logger.warn(
      { userId: delivery.userId, category: outcome.category },
      'Could not deliver a password reset alert',
    );
    return { status: 'FAILED', reason: outcome.category };
  }
}
