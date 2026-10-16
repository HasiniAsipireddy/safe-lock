import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { maskPhone } from '@safelock/shared';
import type {
  SendTemplateInput,
  SendTemplateResult,
  WhatsAppClient,
  WhatsAppErrorCategory,
} from './client';
import { WhatsAppError } from './client';

/**
 * Meta WhatsApp Cloud API client.
 *
 * `POST https://graph.facebook.com/<version>/<phoneNumberId>/messages` with a
 * bearer token. The API version is pinned from configuration so Meta rolling
 * forward cannot change behaviour under us.
 *
 * ## No retries, deliberately
 * A send is **not idempotent**: Meta may have accepted and delivered a message
 * before the response was lost to a timeout. Retrying inside the client would
 * risk a second unlock code arriving on someone's phone, which is both
 * confusing and a small security event (two live-looking codes). Retrying is
 * the outbox worker's decision — it knows how many attempts a message has had
 * and whether the failure category makes another attempt worth anything.
 *
 * ## What never leaves this file
 * The template parameters. They can contain a one-time code, so no log line
 * here carries `params`, and a {@link WhatsAppError} is constructed from the
 * status and Meta's error code only. The destination is logged **masked**.
 */
export class CloudApiWhatsAppClient implements WhatsAppClient {
  readonly name = 'cloud';

  private readonly endpoint: string;
  private readonly accessToken: string;

  constructor() {
    // Unreachable unless the env schema let a cloud boot through without
    // credentials; thrown rather than asserted so the failure is loud and at
    // startup, not at the first unlock.
    if (!env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) {
      throw new Error(
        'CloudApiWhatsAppClient requires WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID',
      );
    }

    this.accessToken = env.WHATSAPP_ACCESS_TOKEN;
    this.endpoint = `https://graph.facebook.com/${env.WHATSAPP_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  }

  async sendTemplate(input: SendTemplateInput): Promise<SendTemplateResult> {
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      // Meta wants the E.164 digits without the leading plus.
      to: input.to.replace(/^\+/, ''),
      type: 'template',
      template: {
        name: input.templateName,
        language: { code: input.language },
        components: input.params.length
          ? [
              {
                type: 'body',
                parameters: input.params.map((text) => ({ type: 'text', text })),
              },
            ]
          : [],
      },
    };

    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        // A send that hangs must not hold a worker tick — or, worse, an
        // unlock request — open indefinitely.
        signal: AbortSignal.timeout(env.WHATSAPP_TIMEOUT_MS),
      });
    } catch (cause) {
      const timedOut = cause instanceof Error && cause.name === 'TimeoutError';
      throw new WhatsAppError(
        'TRANSPORT',
        timedOut ? 'WhatsApp request timed out' : 'WhatsApp request failed',
      );
    }

    const body = (await readJson(response)) as GraphResponse | null;

    if (!response.ok) {
      const providerCode = body?.error?.code;
      const category = categorise(response.status, providerCode);

      // Masked destination and Meta's own codes only — never the params.
      logger.error(
        {
          category,
          status: response.status,
          providerCode,
          templateName: input.templateName,
          maskedPhone: maskPhone(input.to),
        },
        'WhatsApp send was rejected',
      );

      throw new WhatsAppError(category, `WhatsApp rejected the send (${response.status})`, {
        status: response.status,
        ...(providerCode === undefined ? {} : { providerCode }),
      });
    }

    const providerMessageId = body?.messages?.[0]?.id;
    if (!providerMessageId) {
      // A 200 with no message id means we cannot correlate a delivery webhook
      // to this send. Treat it as a failure rather than record an unusable row.
      throw new WhatsAppError('UNKNOWN', 'WhatsApp accepted the send but returned no message id');
    }

    return { providerMessageId };
  }
}

interface GraphResponse {
  messages?: Array<{ id?: string }>;
  error?: { code?: number; message?: string; type?: string };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

/**
 * Maps an HTTP status and Meta error code onto a category.
 *
 * The specific codes are the documented ones that matter for the retry
 * decision. Anything unrecognised is `UNKNOWN`, which is **retryable** — the
 * conservative direction, since the cap bounds how many times we can be wrong.
 *
 * - `131026` message undeliverable (not on WhatsApp, or cannot receive)
 * - `131047` re-engagement required (outside the 24h window)
 * - `132000`-`132015` template problems: not found, paused, mismatched params
 * - `190` expired or invalid access token
 * - `80007`/`130429` rate limits
 */
export function categorise(status: number, providerCode?: number): WhatsAppErrorCategory {
  if (providerCode === 190 || status === 401 || status === 403) return 'AUTH';
  if (providerCode === 131026 || providerCode === 131047) return 'INVALID_NUMBER';
  if (providerCode !== undefined && providerCode >= 132000 && providerCode <= 132015) {
    return 'TEMPLATE';
  }
  if (providerCode === 80007 || providerCode === 130429 || status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'TRANSPORT';
  // A 400 that is none of the above is most likely a malformed request — ours
  // to fix, and not worth retrying.
  if (status === 400) return 'TEMPLATE';
  return 'UNKNOWN';
}
