import { prisma } from '../prisma';
import type { MessageKind } from '../whatsapp/send';

/**
 * Rebuilds a message's template parameters at send time.
 *
 * **This is why `OutboundMessage` stores no parameters.** The alternative —
 * persisting them with the row — would mean writing a one-time code into a
 * table, which is the one thing the OTP design is built to avoid: only an HMAC
 * of a code is ever stored.
 *
 * The consequence is that **the two OTP kinds are never enqueued**. A code
 * exists in memory for the length of one request and cannot be recovered
 * afterwards, so there is nothing for a worker to rebuild. They are sent
 * inline instead, which is correct for a different reason too: the user is
 * waiting for them, and a code that arrives after a retry backoff is a code
 * that has already expired.
 *
 * The outbox therefore carries exactly the messages that are **about something
 * already recorded** — alerts and the reset notice — whose parameters can be
 * read back from the database whenever the send happens.
 */

export interface ParamContext {
  userId: string;
  deviceEventId?: string | null;
}

export async function buildParams(
  kind: MessageKind,
  context: ParamContext,
): Promise<readonly string[]> {
  switch (kind) {
    case 'UNLOCK_ALERT':
    case 'FAILED_ATTEMPTS_ALERT': {
      // The safe's serial and when it happened, both read from the event the
      // message is about. Nothing user-supplied, nothing secret.
      const serialNumber = await serialForEvent(context.deviceEventId);
      return [serialNumber];
    }

    case 'PASSWORD_RESET':
      // The reset *token* is never queued — see the note above. This template
      // tells the user a reset was requested and is parameterless.
      return [];

    case 'UNLOCK_OTP':
    case 'PHONE_OTP':
      /**
       * Unreachable by construction: a one-time code cannot be rebuilt from
       * storage, so these kinds are sent inline and never enqueued. Throwing
       * rather than returning an empty array — a template that silently lost
       * its code would send someone a blank message where a code should be.
       */
      throw new Error(
        `${kind} cannot be sent from the outbox: a one-time code cannot be rebuilt`,
      );

    case 'BOOKING_CONFIRMED':
    case 'BOOKING_ENDING_SOON':
    case 'OVERSTAY_STARTED':
    case 'OVERSTAY_SETTLED':
    case 'COLLECTION_CLOSING':
      /**
       * Booking messages build their parameters elsewhere, and deliberately.
       *
       * Each one has to be **re-validated** against the live booking before it
       * may be sent — a reminder whose booking has ended must be skipped, not
       * sent with recomputed text — so the same read that produces the
       * parameters also decides whether there is a message at all. Splitting
       * that across two functions would let them disagree, and the way they
       * would disagree is a false statement about somebody's safe.
       *
       * Unreachable: the worker routes any row carrying a `bookingId` to
       * `bookingMessages.revalidate` and never reaches here.
       */
      throw new Error(
        `${kind} is a booking message: its parameters come from re-validation, not buildParams`,
      );
  }
}

/** The serial of the safe an event concerns, or a neutral stand-in. */
async function serialForEvent(deviceEventId: string | null | undefined): Promise<string> {
  if (!deviceEventId) return 'your safe';

  const event = await prisma.deviceEvent.findUnique({
    where: { id: deviceEventId },
    select: { device: { select: { serialNumber: true } } },
  });

  return event?.device.serialNumber ?? 'your safe';
}
