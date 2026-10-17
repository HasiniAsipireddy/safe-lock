import { formatInr } from '@safelock/shared';

/**
 * Rendering times and money for a WhatsApp message.
 *
 * ## Why the API formats these and not the client
 * A message is not a client render. There is no browser locale to read, no
 * component to re-render when the timezone changes, and the string is baked
 * into something that sits in someone's chat history — so it has to be right
 * when it is sent, in a timezone chosen deliberately.
 *
 * **Asia/Kolkata, always.** This product rents physical safes in one country;
 * a renter standing at a safe cares what time their local clock says. A UTC
 * timestamp in a reminder would be technically accurate and practically
 * useless. Written as an explicit `timeZone` rather than relying on the
 * server's: a deployment in another region must not change what a message
 * says. If the product ever leaves IST, this is the one place that changes,
 * and the open question in CLAUDE.md is where that decision belongs.
 */

const IST = 'Asia/Kolkata';

/** `9:30 pm` — a time on a day the reader already knows about. */
export function formatIstTime(when: Date): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: IST,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
    .format(when)
    // en-IN renders `am`/`pm` separated by a narrow no-break space, and which
    // invisible space it picks varies with the ICU build. Collapsed to plain
    // single spaces so the string in Meta's template sample and the string we
    // send cannot differ by a character nobody can see. JavaScript's `\s`
    // covers U+00A0 and U+202F, so one pass is enough.
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * `17 Oct 2026, 9:30 pm` — used where the day matters.
 *
 * A booking confirmed at 11pm for eight hours ends tomorrow, and a bare
 * "7:00 am" would read as this morning.
 */
export function formatIstDateTime(when: Date): string {
  const date = new Intl.DateTimeFormat('en-IN', {
    timeZone: IST,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(when);

  return `${date}, ${formatIstTime(when)}`;
}

/**
 * `₹150` — paise formatted for a message.
 *
 * Delegates to the shared helper so a message and the UI can never disagree
 * about what an amount says, and so no call site is tempted to divide by 100
 * itself.
 */
export function formatMoney(paise: number): string {
  return formatInr(paise);
}
