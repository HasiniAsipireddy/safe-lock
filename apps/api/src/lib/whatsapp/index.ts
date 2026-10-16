import { env } from '../../config/env';
import { CloudApiWhatsAppClient } from './cloudApi.client';
import { FakeWhatsAppClient, mayUseFakeWhatsApp } from './fake.client';
import type { WhatsAppClient } from './client';

export type {
  SendTemplateInput,
  SendTemplateResult,
  WhatsAppClient,
  WhatsAppErrorCategory,
} from './client';
export { WhatsAppError, TERMINAL_CATEGORIES, isRetryable } from './client';
export { FakeWhatsAppClient, mayUseFakeWhatsApp } from './fake.client';
export type { RecordedMessage } from './fake.client';
export { CloudApiWhatsAppClient, categorise } from './cloudApi.client';

/**
 * The WhatsApp client the application talks to.
 *
 * Resolved once at module load, like `deviceGateway`: a client holds
 * configuration (and, for the cloud client, a keep-alive pool), and
 * reconstructing one per message is not a thing to retrofit later.
 */
function resolveClient(): WhatsAppClient {
  switch (env.WHATSAPP_PROVIDER) {
    case 'fake':
      /**
       * Second guard. The env schema already refuses
       * `WHATSAPP_PROVIDER=fake` in production, so reaching this throw means
       * someone bypassed validation — and the right answer is still a hard
       * failure at boot rather than a service that silently sends nothing.
       */
      if (!mayUseFakeWhatsApp(env.NODE_ENV)) {
        throw new Error(
          `The fake WhatsApp client cannot be used with NODE_ENV=${env.NODE_ENV}`,
        );
      }
      return new FakeWhatsAppClient();

    case 'cloud':
      return new CloudApiWhatsAppClient();

    default:
      // Unreachable: the env schema is an enum. Kept so adding a value to that
      // enum without an implementation fails loudly at boot.
      throw new Error(`No WhatsApp client implementation for '${env.WHATSAPP_PROVIDER}'`);
  }
}

export const whatsAppClient: WhatsAppClient = resolveClient();

/**
 * The fake client, when that is what is configured — otherwise null.
 *
 * Lets a test assert on what was sent without reaching into module internals,
 * and lets the dev console print a note. Null in cloud mode by construction,
 * so no production code path can reach the recorded-message list.
 */
export function fakeWhatsAppClient(): FakeWhatsAppClient | null {
  return whatsAppClient instanceof FakeWhatsAppClient ? whatsAppClient : null;
}
