import crypto from 'node:crypto';
import type {
  SendTemplateInput,
  SendTemplateResult,
  WhatsAppClient,
  WhatsAppErrorCategory,
} from './client';
import { WhatsAppError } from './client';

/**
 * In-memory WhatsApp client for development and tests.
 *
 * Records what it was asked to send instead of sending it, so a test can
 * assert on the template name and parameters — including that an OTP went to
 * the right number — without a network call. **No test in this repo may make
 * a real network call**, and this is what makes that practical rather than
 * aspirational.
 *
 * It is **refused in production** two ways over: the env schema rejects
 * `WHATSAPP_PROVIDER=fake` when `NODE_ENV=production`, and
 * {@link mayUseFakeWhatsApp} refuses to construct one. The same
 * belt-and-braces as the OTP console print, for the same reason — a
 * deployment that recorded unlock codes to memory and sent nothing would look
 * perfectly healthy and open nothing.
 *
 * Unlike `MockDeviceGateway`, which always acks because a flaky mock makes
 * every test flaky, this one can be *told* to fail. Delivery failure is a path
 * with its own required behaviour (invalidate the challenge, return
 * `OTP_DELIVERY_FAILED`, retry the outbox), so it has to be reachable on
 * demand — deterministically, never randomly.
 */

/** One recorded send. Lives only in memory, only in dev and test. */
export interface RecordedMessage {
  to: string;
  templateName: string;
  language: string;
  params: readonly string[];
  /**
   * The dynamic URL button's variable, when the template had one.
   *
   * Recorded so a test can assert the **exact** suffix: a reminder whose
   * button points at the wrong booking is a link that shows someone a
   * not-found page at the moment they most need the page.
   */
  urlButtonSuffix: string | null;
  providerMessageId: string;
  sentAt: Date;
}

interface PlannedFailure {
  category: WhatsAppErrorCategory;
  /** Remaining sends to fail. `Infinity` for "until cleared". */
  remaining: number;
}

export class FakeWhatsAppClient implements WhatsAppClient {
  readonly name = 'fake';

  private readonly messages: RecordedMessage[] = [];
  private failure: PlannedFailure | null = null;

  async sendTemplate(input: SendTemplateInput): Promise<SendTemplateResult> {
    if (this.failure && this.failure.remaining > 0) {
      this.failure.remaining -= 1;
      const { category } = this.failure;
      if (this.failure.remaining <= 0) this.failure = null;

      throw new WhatsAppError(category, `Fake client failing on purpose (${category})`);
    }

    // Shaped like Meta's ids so nothing downstream can depend on the format
    // of a real one by accident.
    const providerMessageId = `wamid.FAKE${crypto.randomBytes(12).toString('hex')}`;

    this.messages.push({
      to: input.to,
      templateName: input.templateName,
      language: input.language,
      params: [...input.params],
      urlButtonSuffix: input.urlButtonSuffix ?? null,
      providerMessageId,
      sentAt: new Date(),
    });

    return { providerMessageId };
  }

  // --- Test / dev inspection -------------------------------------------------

  /** Every send so far, oldest first. */
  sent(): readonly RecordedMessage[] {
    return this.messages;
  }

  /** The most recent send, or null. */
  last(): RecordedMessage | null {
    return this.messages.at(-1) ?? null;
  }

  /** Sends matching one template name, oldest first. */
  sentWithTemplate(templateName: string): readonly RecordedMessage[] {
    return this.messages.filter((message) => message.templateName === templateName);
  }

  /** Fails the next `count` sends with `category`, then recovers. */
  failNext(category: WhatsAppErrorCategory = 'TRANSPORT', count = 1): void {
    this.failure = { category, remaining: count };
  }

  /** Fails every send until {@link recover} is called. */
  failAlways(category: WhatsAppErrorCategory = 'TRANSPORT'): void {
    this.failure = { category, remaining: Number.POSITIVE_INFINITY };
  }

  recover(): void {
    this.failure = null;
  }

  /** Forgets every recorded message and any planned failure. */
  reset(): void {
    this.messages.length = 0;
    this.failure = null;
  }
}

/**
 * Whether the fake client may be constructed.
 *
 * A pure function of the environment name, exported so the guard itself is
 * testable — including against values that are not in the enum, in case
 * `NODE_ENV` is unset or misspelled. Anything that is not `development` or
 * `test` answers false: the default must be "no fake", exactly as
 * `mayPrintOtp`'s default is silence.
 */
export function mayUseFakeWhatsApp(nodeEnv: string): boolean {
  return nodeEnv === 'development' || nodeEnv === 'test';
}
