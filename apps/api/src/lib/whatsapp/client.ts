/**
 * The WhatsApp seam.
 *
 * Shaped like {@link ../deviceGateway/gateway DeviceGateway} and
 * {@link ../notifier/notifier Notifier}: one interface, one place the
 * application says "send this person a message", so the fake and the real
 * Cloud API client are interchangeable and no caller knows which it has.
 *
 * ## Templates only, never free text
 * Meta requires a pre-approved template for any business-initiated message,
 * and that constraint is encoded here rather than worked around: the interface
 * takes a template name and positional parameters, and there is no method that
 * sends arbitrary text. A caller therefore cannot invent a message at runtime,
 * which also means no user-supplied string can become message content.
 *
 * ## What it does not take
 * No user id, no device, no request object. A client is handed a destination
 * and a template; everything about *whether* to send — eligibility, consent,
 * the daily cap — is settled before anything reaches here, by `sendTemplate`
 * in `lib/whatsapp/send.ts`.
 */

/**
 * Why a send failed, in the only terms a caller can act on.
 *
 * A closed set rather than a provider error code, because the decisions that
 * depend on it are ours, not Meta's: whether to retry (`TRANSPORT`,
 * `RATE_LIMITED`), whether retrying is pointless (`INVALID_NUMBER`,
 * `TEMPLATE`, `AUTH`), and what to record. The raw provider detail is logged
 * once and never surfaced to a user.
 */
export type WhatsAppErrorCategory =
  /** The number is not on WhatsApp, or Meta rejected it outright. Terminal. */
  | 'INVALID_NUMBER'
  /** Unknown, unapproved or mis-parameterised template. Terminal, and ours to fix. */
  | 'TEMPLATE'
  /** Bad or expired credentials. Terminal until someone rotates a token. */
  | 'AUTH'
  /** Meta is throttling us. Retryable, with backoff. */
  | 'RATE_LIMITED'
  /** Timeout, socket error, 5xx. Retryable. */
  | 'TRANSPORT'
  /** Anything we could not classify. Retryable, conservatively. */
  | 'UNKNOWN';

/** Categories where retrying cannot help, so the outbox stops immediately. */
export const TERMINAL_CATEGORIES: readonly WhatsAppErrorCategory[] = [
  'INVALID_NUMBER',
  'TEMPLATE',
  'AUTH',
];

export function isRetryable(category: WhatsAppErrorCategory): boolean {
  return !TERMINAL_CATEGORIES.includes(category);
}

/**
 * A failed send.
 *
 * Carries the category and a short provider detail for the log. **It must
 * never carry the template parameters** — those are where the OTP is.
 */
export class WhatsAppError extends Error {
  readonly category: WhatsAppErrorCategory;
  /** Provider status, for the log only. */
  readonly status?: number;
  /** Meta's numeric error code, for the log only. */
  readonly providerCode?: number;

  constructor(
    category: WhatsAppErrorCategory,
    message: string,
    extra: { status?: number; providerCode?: number } = {},
  ) {
    super(message);
    this.name = 'WhatsAppError';
    this.category = category;
    if (extra.status !== undefined) this.status = extra.status;
    if (extra.providerCode !== undefined) this.providerCode = extra.providerCode;
  }
}

export interface SendTemplateInput {
  /** E.164, already normalised and validated by the caller. */
  to: string;
  /** An approved template name, from configuration — never a literal. */
  templateName: string;
  /** Language tag as registered with Meta, e.g. `en`. */
  language: string;
  /**
   * Positional body parameters, in template order.
   *
   * May contain a one-time code, so this value must not be logged, stored, or
   * attached to an error. Keep it short-lived.
   */
  params: readonly string[];

  /**
   * The variable half of a dynamic URL button, when the template has one.
   *
   * Meta fixes the *base* of the URL in the approved template and appends one
   * variable at send time, so a template approved with
   * `https://app.example.test/bookings/` can only ever produce a link under
   * that path — this field cannot redirect anyone off-site, whatever it
   * contains. Omit it for a template with no button; supplying one for a
   * template Meta has no button on is a `TEMPLATE` error, which is terminal
   * and ours to fix.
   *
   * **Never a code, a token or an amount.** Every caller builds it from a
   * booking id and a fixed path segment, so there is no shape it could take
   * that leaks a credential into a chat message.
   */
  urlButtonSuffix?: string;
}

export interface SendTemplateResult {
  /**
   * The provider's message id (`wamid.…`).
   *
   * Recorded against the outbox row so a later delivery-status webhook can be
   * matched to the message it describes.
   */
  providerMessageId: string;
}

export interface WhatsAppClient {
  readonly name: string;

  /**
   * Sends one template message.
   *
   * Throws {@link WhatsAppError} on failure. **Never retries internally**: a
   * send is not idempotent — Meta may have delivered the message before the
   * response was lost — so a blind retry risks a duplicate code on someone's
   * phone. Retrying is the outbox worker's decision, made from the error
   * category, with a cap.
   */
  sendTemplate(input: SendTemplateInput): Promise<SendTemplateResult>;
}
