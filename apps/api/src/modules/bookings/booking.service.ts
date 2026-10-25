import {
  ERROR_CODES,
  SAFE_SIZES,
  SAFE_SIZE_COPY,
  bookingPricePaise,
  effectiveBookingStatus,
  overstayHourlyPaise,
  reservedUntilFrom,
  type BookingQuote,
  type BookingSummary,
  type ExtensionAvailability,
  type ExtensionRefusalReason,
  type RateSnapshot,
  type SafeSize,
} from '@safelock/shared';
import {
  DEVICE_OFFLINE_AFTER_MS,
  RENTAL_HOURLY_RATE_PAISE_BY_SIZE,
  env,
} from '../../config/env';
import { HttpError, conflict } from '../../lib/httpError';
import { logger } from '../../lib/logger';
import { prisma, type PrismaTransaction } from '../../lib/prisma';
import { createCommand, publishCommand } from '../commands/command.service';
import {
  BOOKING_SELECT,
  outstandingFeePaise,
  snapshotOf,
  toBookingSummary,
  type BookingRow,
} from './booking.mapper';
import { cancelDeadlineMessages, cancelPending, scheduleFor } from './booking.messages';

/**
 * Rental bookings.
 *
 * ## Three invariants
 * 1. **No two bookings occupy one device at once**, and that is enforced by a
 *    Postgres exclusion constraint, not by the checks in this file. The checks
 *    exist to produce a decent error message; the constraint is what is true
 *    under concurrency. Same reasoning as the old `Device.ownerId` unique
 *    index — see docs/decisions.md.
 * 2. **A booking becomes ACTIVE only from a verified payment.** Nothing a
 *    client sends can do it, and the amount and the times are server figures.
 * 3. **Status is derived from the server clock on every read.** The sweeper
 *    reconciles rows and releases devices; it never decides anything, so a
 *    missed sweep cannot leave a safe unlockable.
 *
 * ## The device is held from creation
 * `PENDING_PAYMENT` reserves the safe for `BOOKING_HOLD_MINUTES`, so a user
 * who pays is never told the safe has gone. The abuse that invites — opening
 * unpaid bookings until the pool is empty — is closed by one live booking per
 * user, enforced by a partial unique index.
 */

// --- Errors ------------------------------------------------------------------

/**
 * Every safe is in service and occupied for the requested window.
 *
 * The advice is conditional on there being advice to give. "Try a shorter
 * booking" is useless at the shortest duration the product sells — it names a
 * remedy the user has already taken — so at `RENTAL_MIN_HOURS` the suggestion
 * becomes the one thing that can actually change, which is when they come
 * back.
 */
const noDevicesFree = (hours: number) =>
  conflict(
    ERROR_CODES.NO_DEVICES_AVAILABLE,
    hours > env.RENTAL_MIN_HOURS
      ? 'Every safe is booked for that period. Please try a shorter booking or come back later.'
      : 'Every safe is booked for that period. Please try a later time or check back soon.',
  );

/**
 * Nothing is rentable at all, which is **not** the same fact and must not wear
 * the same words.
 *
 * Saying "every safe is booked" when the truth is "no safe is reachable" is a
 * false claim about our own fleet: it sends the user to retry a duration that
 * was never the problem, and it hides an outage behind a message that reads
 * like ordinary demand. A `503` so that monitoring sees it as the outage it
 * is; the counts go to the log, never to the client, since how small the fleet
 * is is nobody's business but ours.
 */
const noDevicesInService = (fleet: { registered: number; operable: number }) =>
  new HttpError({
    status: 503,
    code: ERROR_CODES.NO_DEVICES_IN_SERVICE,
    message:
      fleet.registered === 0
        ? 'No safes are set up yet. Please check back soon.'
        : 'No safe is available to rent right now. This is a problem at our end, not with your booking. Please check back soon.',
    logContext: { registeredDevices: fleet.registered, operableDevices: fleet.operable },
  });

/**
 * The requested size is not available, but another size is.
 *
 * Its own error rather than `NO_DEVICES_AVAILABLE`, because "every safe is
 * booked, try a shorter stay" is both false and discouraging when a large one
 * is standing empty. The sizes that *are* free go in `fields` so the booking
 * page can offer them as one click rather than making the user guess.
 *
 * `outOfStock` changes only the wording: a size we hold none of is not a size
 * that will free up later, so promising "try again shortly" would be a promise
 * about inventory we do not have.
 */
const sizeNotAvailable = (
  size: SafeSize,
  alternatives: readonly SafeSize[],
  outOfStock: boolean,
) => {
  const requested = SAFE_SIZE_COPY[size].label.toLowerCase();
  const offered = alternatives.map((other) => SAFE_SIZE_COPY[other].label.toLowerCase());
  const last = offered.at(-1) ?? '';
  const list =
    offered.length === 1 ? last : `${offered.slice(0, -1).join(', ')} and ${last}`;

  return new HttpError({
    status: 409,
    code: ERROR_CODES.SIZE_NOT_AVAILABLE,
    message: outOfStock
      ? `We do not have a ${requested} safe available. ${capitalise(list)} ${
          offered.length === 1 ? 'is' : 'are'
        } available for that period.`
      : `Every ${requested} safe is booked for that period. ${capitalise(list)} ${
          offered.length === 1 ? 'is' : 'are'
        } available instead.`,
    /**
     * A machine-readable list beside the sentence, so the page can render
     * buttons rather than parse prose. `fields` is the existing channel for
     * "which input was the problem, and what would be accepted".
     */
    fields: { size: alternatives.join(',') },
    logContext: { requestedSize: size, availableSizes: alternatives, outOfStock },
  });
};

const capitalise = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

const alreadyBooked = () =>
  conflict(
    ERROR_CODES.BOOKING_ALREADY_EXISTS,
    'You already have a booking. Collect your items and complete it before booking again.',
  );

const bookingNotFound = () =>
  new HttpError({
    status: 404,
    code: ERROR_CODES.BOOKING_NOT_FOUND,
    message: 'No booking with that id.',
  });

const stateInvalid = (message: string) =>
  conflict(ERROR_CODES.BOOKING_STATE_INVALID, message);

const overstayDue = (feePaise: number) =>
  new HttpError({
    status: 402,
    code: ERROR_CODES.OVERSTAY_PAYMENT_REQUIRED,
    message: `An overstay fee of ${feePaise} paise is outstanding. Pay it to unlock and collect your items.`,
  });

/** Duck-typed: Prisma's error classes move between majors. */
function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'P2002';
}

/**
 * The exclusion constraint firing.
 *
 * Postgres reports `23P01` for an exclusion violation. Prisma surfaces it as a
 * raw database error rather than a typed one, so this checks both the code and
 * the constraint name — a different exclusion constraint added later must not
 * be mistaken for this one.
 */
function isOverlapViolation(error: unknown): boolean {
  const candidate = error as { code?: string; meta?: { code?: string }; message?: string } | null;
  const code = candidate?.code ?? candidate?.meta?.code;
  const message = candidate?.message ?? '';

  return code === '23P01' || message.includes('Booking_device_no_overlap');
}

// --- Config ------------------------------------------------------------------

/**
 * The live rates for one size, for quoting a **new** booking. Never for
 * re-pricing one.
 *
 * Takes a size because the hourly rate is the only figure that varies by it —
 * the grace period, the cap, the multiplier and the collection window are
 * properties of the rental policy, not of the cabinet. Keeping them shared is
 * what stops "the large safe has a different grace period" becoming true by
 * accident.
 */
export function currentRates(size: SafeSize): RateSnapshot {
  return {
    hourlyRatePaise: RENTAL_HOURLY_RATE_PAISE_BY_SIZE[size],
    overstayMultiplierBps: env.OVERSTAY_MULTIPLIER_BPS,
    graceMinutes: env.OVERSTAY_GRACE_MINUTES,
    capHours: env.OVERSTAY_CAP_HOURS,
    collectionWindowMinutes: env.COLLECTION_WINDOW_MINUTES,
    currency: env.CURRENCY,
  };
}

/** Every allowed duration priced at one size. */
function priceList(rates: RateSnapshot): Array<{ hours: number; pricePaise: number }> {
  const options: Array<{ hours: number; pricePaise: number }> = [];

  for (let hours = env.RENTAL_MIN_HOURS; hours <= env.RENTAL_MAX_HOURS; hours += 1) {
    options.push({ hours, pricePaise: bookingPricePaise(rates, hours) });
  }

  return options;
}

/**
 * What a new booking would cost and the rules that would apply.
 *
 * Every (size, duration) pair the server would accept is priced here so the UI
 * does no money arithmetic of its own — and so the overstay rate can be stated
 * plainly *before* anyone pays, which is the point of showing it at all.
 *
 * ## Why this reads the database now
 * It used to be pure config. It takes an optional availability lookup because
 * the page's first question is "which sizes can I have?", and a size card that
 * cannot be booked should say so rather than lead somebody through a duration
 * picker into a 409. Passing `null` gives the price list with every size
 * marked available, which is what a caller with no database handy wants.
 */
export async function quote(options: { now?: Date } = {}): Promise<BookingQuote> {
  const now = options.now ?? new Date();
  const free = await availableSizes(now);

  const sizes = SAFE_SIZES.map((size) => {
    const rates = currentRates(size);

    return {
      size,
      hourlyRatePaise: rates.hourlyRatePaise,
      available: free.has(size),
      options: priceList(rates),
      overstayHourlyPaise: overstayHourlyPaise(rates),
    };
  });

  // Medium, for the two deprecated fields that predate sizes.
  const mediumRates = currentRates('MEDIUM');

  return {
    rates: mediumRates,
    minHours: env.RENTAL_MIN_HOURS,
    maxHours: env.RENTAL_MAX_HOURS,
    sizes,
    options: priceList(mediumRates),
    overstayHourlyPaise: overstayHourlyPaise(mediumRates),
  };
}

/**
 * Which sizes have at least one safe free for the shortest bookable window.
 *
 * **Advisory, and no locks taken.** The authority on whether a safe is free is
 * the exclusion constraint at creation; this exists so the booking page can
 * grey out a size instead of letting somebody pick a duration for one that is
 * fully booked. It deliberately asks about `RENTAL_MIN_HOURS` rather than a
 * duration the user has not chosen yet: the shortest window is the most
 * permissive, so a size marked unavailable here is unavailable at every
 * duration — which is the only direction in which being approximate is safe.
 */
async function availableSizes(now: Date): Promise<Set<SafeSize>> {
  const minimumEnd = new Date(now.getTime() + env.RENTAL_MIN_HOURS * 60 * 60 * 1000);
  const freshSince = new Date(now.getTime() - DEVICE_OFFLINE_AFTER_MS);
  // The widest reservation the shortest booking could produce, so a size is
  // not called free on a window narrower than one would actually claim.
  const until = reservedUntilFrom(currentRates('MEDIUM'), minimumEnd);

  const rows = await prisma.$queryRaw<Array<{ size: SafeSize }>>`
    SELECT DISTINCT d."size"
    FROM "Device" d
    WHERE d."status" = 'AVAILABLE'
      AND d."online" = true
      AND d."lastSeenAt" IS NOT NULL
      AND d."lastSeenAt" > ${freshSince}::timestamp
      AND d."doorState" <> 'UNKNOWN'
      AND NOT EXISTS (
        SELECT 1 FROM "Booking" b
        WHERE b."deviceId" = d."id"
          AND b."status" IN ('PENDING_PAYMENT', 'ACTIVE', 'OVERSTAY')
          AND tsrange(b."startsAt", b."reservedUntil", '[)')
              && tsrange(${now}::timestamp, ${until}::timestamp, '[)')
      )
  `;

  return new Set(rows.map((row) => row.size));
}

// --- Reads -------------------------------------------------------------------

/**
 * The caller's live booking, or null.
 *
 * "Live" is decided by the **effective** status, so a row the sweeper has not
 * reached yet — an expired hold, a lapsed collection window — is correctly
 * reported as finished rather than as something the user still holds.
 */
export async function currentBookingFor(
  userId: string,
  now = new Date(),
): Promise<{ booking: BookingSummary | null; row: BookingRow | null }> {
  const found = await prisma.booking.findFirst({
    where: { userId, status: { in: ['PENDING_PAYMENT', 'ACTIVE', 'OVERSTAY'] } },
    orderBy: { createdAt: 'desc' },
    select: BOOKING_SELECT,
  });

  if (!found) return { booking: null, row: null };

  const row = found as BookingRow;
  const summary = toBookingSummary(row, now);

  // The stored row still occupies the device, but the clock says it is over.
  // Report the truth; the sweeper will catch up and release it.
  const finished =
    summary.effectiveStatus === 'EXPIRED_UNPAID' || summary.effectiveStatus === 'COMPLETED';

  /**
   * The row comes back alongside the summary so the caller can ask it further
   * questions — today, whether it can be extended — without a second read of
   * the same booking. Null when there is nothing live, so a caller cannot
   * accidentally compute an offer for a booking this function just decided to
   * hide.
   */
  return finished ? { booking: null, row: null } : { booking: summary, row };
}

export async function getBookingForUser(
  bookingId: string,
  userId: string,
): Promise<BookingRow> {
  const row = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: BOOKING_SELECT,
  });

  // Ownership is folded into the not-found answer: a booking belonging to
  // someone else must not be distinguishable from one that does not exist.
  if (!row || row.userId !== userId) throw bookingNotFound();

  return row as BookingRow;
}

// --- Create ------------------------------------------------------------------

export interface CreateBookingResult {
  booking: BookingSummary;
}

/**
 * Creates a `PENDING_PAYMENT` booking and holds a safe for it.
 *
 * `startsAt` is now; `endsAt` is **null** until the payment lands, so nobody
 * loses purchased time to a slow checkout. The hold still has to reserve the
 * whole intended window — otherwise another booking could be sold into it and
 * the payment would have nowhere to land — so `reservedUntil` is computed from
 * a *provisional* end of `now + hours`, plus the turnaround.
 */
export async function createBooking(input: {
  userId: string;
  hours: number;
  size: SafeSize;
  now?: Date;
}): Promise<CreateBookingResult> {
  const now = input.now ?? new Date();
  // Priced from the requested size, and snapshotted below, so this booking's
  // rate is fixed before a device is even chosen.
  const rates = currentRates(input.size);

  if (input.hours < env.RENTAL_MIN_HOURS || input.hours > env.RENTAL_MAX_HOURS) {
    throw new HttpError({
      status: 400,
      code: ERROR_CODES.VALIDATION_ERROR,
      message: `A booking must be between ${env.RENTAL_MIN_HOURS} and ${env.RENTAL_MAX_HOURS} hours.`,
    });
  }

  const provisionalEnd = new Date(now.getTime() + input.hours * 60 * 60 * 1000);
  const holdExpiresAt = new Date(now.getTime() + env.BOOKING_HOLD_MINUTES * 60 * 1000);

  try {
    const row = await prisma.$transaction(async (tx) => {
      // Cheap, friendly pre-check. The partial unique index is what actually
      // guarantees it.
      const live = await tx.booking.findFirst({
        where: { userId: input.userId, status: { in: ['PENDING_PAYMENT', 'ACTIVE', 'OVERSTAY'] } },
        select: { id: true },
      });
      if (live) throw alreadyBooked();

      await releaseLapsedHolds(tx, now);

      const deviceId = await pickAvailableDeviceId(
        tx,
        now,
        reservedUntilFrom(rates, provisionalEnd),
        input.hours,
        input.size,
      );

      const created = await tx.booking.create({
        data: {
          userId: input.userId,
          deviceId,
          status: 'PENDING_PAYMENT',
          hours: input.hours,
          startsAt: now,
          // Null on purpose: the clock starts when the money arrives.
          endsAt: null,
          holdExpiresAt,
          reservedUntil: reservedUntilFrom(rates, provisionalEnd),
          pricePaise: bookingPricePaise(rates, input.hours),
          currency: rates.currency,
          // Snapshot, so later config changes never touch this booking — and
          // so re-classifying the cabinet never changes what was booked.
          safeSize: input.size,
          hourlyRatePaise: rates.hourlyRatePaise,
          overstayMultiplierBps: rates.overstayMultiplierBps,
          graceMinutes: rates.graceMinutes,
          capHours: rates.capHours,
          collectionWindowMinutes: rates.collectionWindowMinutes,
        },
        select: BOOKING_SELECT,
      });

      return created as BookingRow;
    });

    return { booking: toBookingSummary(row, now) };
  } catch (error) {
    if (isUniqueViolation(error)) throw alreadyBooked();
    // Two users racing for the last safe: the loser gets a clean answer. This
    // one really is "taken" — the constraint fired on an overlap, so a safe
    // was there and somebody else got it.
    if (isOverlapViolation(error)) throw noDevicesFree(input.hours);
    throw error;
  }
}

/**
 * Releases holds whose deadline has passed, in the booking's own transaction.
 *
 * Every other read in the system derives a booking's status from the clock
 * (`effectiveBookingStatus`) and the sweeper only writes down what a read
 * already knows. The pick cannot do that, for a reason worth recording: the
 * safe is held by `Booking_device_no_overlap`, whose predicate is
 * `status IN (…)`, and an exclusion constraint cannot consult `now()` — so
 * ignoring a lapsed hold in the query would merely move the refusal from the
 * pick to the constraint. The row has to actually be released.
 *
 * Which makes this the one place the booking path reconciles rather than
 * derives, and it is the same conditional update the sweeper's first step
 * performs — `status` is a precondition, so a payment landing in this instant
 * cannot be overwritten. Without it a lapsed hold withholds a safe for up to
 * `BOOKING_SWEEP_INTERVAL_MS`, which is the sweeper deciding something.
 */
async function releaseLapsedHolds(tx: PrismaTransaction, now: Date): Promise<void> {
  await tx.booking.updateMany({
    where: { status: 'PENDING_PAYMENT', holdExpiresAt: { lte: now } },
    data: { status: 'EXPIRED_UNPAID', completedAt: now, reservedUntil: now },
  });
}

/**
 * Which **other** sizes have a safe free for this exact window.
 *
 * Runs only on the failure path, so it costs nothing in the normal case, and
 * takes no locks: it answers "what should we offer this person instead", and a
 * suggestion does not need to be reserved. The same window as the pick that
 * just failed, rather than the minimum window {@link availableSizes} uses —
 * here we know the duration the user actually asked for, so the offer can be
 * true of it.
 */
async function freeSizesExcluding(
  tx: PrismaTransaction,
  from: Date,
  until: Date,
  freshSince: Date,
  exclude: SafeSize,
): Promise<SafeSize[]> {
  const rows = await tx.$queryRaw<Array<{ size: SafeSize }>>`
    SELECT DISTINCT d."size"
    FROM "Device" d
    WHERE d."status" = 'AVAILABLE'
      AND d."size" <> ${exclude}::"SafeSize"
      AND d."online" = true
      AND d."lastSeenAt" IS NOT NULL
      AND d."lastSeenAt" > ${freshSince}::timestamp
      AND d."doorState" <> 'UNKNOWN'
      AND NOT EXISTS (
        SELECT 1 FROM "Booking" b
        WHERE b."deviceId" = d."id"
          AND b."status" IN ('PENDING_PAYMENT', 'ACTIVE', 'OVERSTAY')
          AND tsrange(b."startsAt", b."reservedUntil", '[)')
              && tsrange(${from}::timestamp, ${until}::timestamp, '[)')
      )
  `;

  const found = new Set(rows.map((row) => row.size));

  // Returned in the canonical small-to-large order, not whatever order the
  // planner produced, so the sentence reads the same way every time.
  return SAFE_SIZES.filter((size) => found.has(size));
}

/**
 * Picks a bookable safe and locks it for the rest of the transaction.
 *
 * `FOR UPDATE SKIP LOCKED` on the **device** row, the same pattern the old
 * allocation pick used: two users booking at the same moment each lock a
 * different device and step over the other's, rather than both reading the
 * same "next free" row and one failing.
 *
 * Raw SQL because Prisma has no row-locking API. The interpolated values are
 * three timestamps this function computed — there is no caller input in the
 * query. `NEEDS_INSPECTION` and `RETIRED` devices are excluded by the status
 * filter, so a safe nobody has looked inside cannot be rented out.
 *
 * ## Three conditions, not one, since the hardware became real
 * A safe is bookable only if it is `AVAILABLE` **and we can reach it** **and
 * it can tell us whether its door is shut**. Renting someone a safe we cannot
 * command, or one whose closure we cannot verify, is selling a product that
 * does not work — and both failures are invisible at the moment of sale and
 * obvious an hour later when somebody is standing in front of it.
 *
 * The liveness condition duplicates `isDeviceOnline`, which is a duplication
 * worth naming: it has to be expressed in SQL because the pick is a
 * row-locking query that must not fetch the fleet to filter it in TypeScript.
 * The cutoff is computed by the caller from `DEVICE_OFFLINE_AFTER_MS`, so the
 * *threshold* lives in one place even though the comparison is written twice.
 */
async function pickAvailableDeviceId(
  tx: PrismaTransaction,
  from: Date,
  until: Date,
  /** Only ever used to word the refusal — never to choose a safe. */
  hours: number,
  /** The size the renter asked for. A hard filter, never a preference. */
  size: SafeSize,
): Promise<string> {
  /**
   * The same two-part test `isDeviceOnline` applies: the device's own claim,
   * and a message recent enough to believe it. Each misses what the other
   * catches — a will that the broker lost, or a wedged device still holding a
   * TCP connection.
   */
  const freshSince = new Date(Date.now() - DEVICE_OFFLINE_AFTER_MS);

  /**
   * And the door sensor, which is the §11.8 half.
   *
   * Units ship with one, and one that is not reporting is a *fault* rather
   * than a configuration — so `UNKNOWN` means "we do not know whether the
   * door is shut", which is exactly the check the completion flow has to make
   * before handing a safe to the next renter. A unit that cannot answer it
   * cannot be rented, on the same footing as an offline one.
   *
   * This also excludes a brand-new unit that has never reported, whose
   * `doorState` defaults to `UNKNOWN`. Correct, and not a side effect:
   * registering a serial is inventory, and a safe is genuinely bookable only
   * once it has connected and said what it is (§2.4).
   */

  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT d."id"
    FROM "Device" d
    WHERE d."status" = 'AVAILABLE'
      -- The requested size, and only it. A renter who asked for a small safe
      -- is not handed a large one: they would be charged the small rate for
      -- stock worth more, and a size nobody can book because it keeps being
      -- given away as an upgrade is stock that earns nothing.
      AND d."size" = ${size}::"SafeSize"
      AND d."online" = true
      AND d."lastSeenAt" IS NOT NULL
      AND d."lastSeenAt" > ${freshSince}::timestamp
      -- A door sensor that is not reporting. See the note above the query.
      AND d."doorState" <> 'UNKNOWN'
      AND NOT EXISTS (
        SELECT 1 FROM "Booking" b
        WHERE b."deviceId" = d."id"
          AND b."status" IN ('PENDING_PAYMENT', 'ACTIVE', 'OVERSTAY')
          AND tsrange(b."startsAt", b."reservedUntil", '[)')
              && tsrange(${from}::timestamp, ${until}::timestamp, '[)')
      )
    ORDER BY d."createdAt" ASC
    LIMIT 1
    FOR UPDATE OF d SKIP LOCKED
  `;

  const next = rows[0];
  if (next) return next.id;

  /**
   * Nothing matched — and *why* decides what the user is told.
   *
   * The query above folds five conditions into one empty result, so on its own
   * it cannot distinguish a fully-booked fleet from a fleet that is entirely
   * offline. One of those is the user's problem and one is ours. A second
   * query, run only on the failure path, counts how many safes are rentable
   * **ignoring bookings entirely**: if that is zero, no window of any length
   * would have found one.
   *
   * It costs a count on a path that was about to throw, and it takes no locks.
   */
  const [fleet] = await tx.$queryRaw<
    Array<{ registered: bigint; operable: bigint; operableAtSize: bigint }>
  >`
    SELECT
      count(*) FILTER (WHERE d."status" <> 'RETIRED') AS registered,
      count(*) FILTER (
        WHERE d."status" = 'AVAILABLE'
          AND d."online" = true
          AND d."lastSeenAt" IS NOT NULL
          AND d."lastSeenAt" > ${freshSince}::timestamp
          AND d."doorState" <> 'UNKNOWN'
      ) AS operable,
      count(*) FILTER (
        WHERE d."status" = 'AVAILABLE'
          AND d."size" = ${size}::"SafeSize"
          AND d."online" = true
          AND d."lastSeenAt" IS NOT NULL
          AND d."lastSeenAt" > ${freshSince}::timestamp
          AND d."doorState" <> 'UNKNOWN'
      ) AS "operableAtSize"
    FROM "Device" d
  `;

  const registered = Number(fleet?.registered ?? 0);
  const operable = Number(fleet?.operable ?? 0);
  const operableAtSize = Number(fleet?.operableAtSize ?? 0);

  if (operable === 0) throw noDevicesInService({ registered, operable });

  /**
   * Nothing of this size is rentable at all — we stock none, or every one is
   * retired, inspecting or unreachable — while other sizes are fine.
   *
   * Told apart from "this size is booked out" because the remedy differs: no
   * duration and no amount of waiting produces a size we do not have, so the
   * only useful thing to say is which sizes exist. The counts stay in the log;
   * how much stock we hold is nobody's business but ours.
   */
  const alternatives = await freeSizesExcluding(tx, from, until, freshSince, size);

  if (alternatives.length > 0) {
    throw sizeNotAvailable(size, alternatives, operableAtSize === 0);
  }

  throw noDevicesFree(hours);
}

// --- Activation (payment captured) -------------------------------------------

export type ActivationOutcome =
  | { kind: 'activated'; booking: BookingRow }
  | { kind: 'already-active'; booking: BookingRow }
  /** The hold lapsed and the safe has since been taken. Money needs refunding. */
  | { kind: 'device-taken' }
  /** Cancelled or completed before the money arrived. */
  | { kind: 'not-payable' };

/**
 * Turns a paid booking `ACTIVE`. **The only path to `ACTIVE`.**
 *
 * `endsAt` is set to `paidAt + hours` — not creation time — so a slow checkout
 * never eats into what the user bought.
 *
 * A payment can arrive after the hold lapsed (the Razorpay order expiry is set
 * to match the hold, so the window is small, but it is not zero). Then:
 * - if the safe is still free, the booking is **re-activated** — the exclusion
 *   constraint is re-checked by the write itself, so this is safe;
 * - if it has been taken, nothing is forced: the caller flags the payment for
 *   a manual refund and the user is told plainly.
 */
export async function activateBooking(
  bookingId: string,
  options: { now?: Date; client?: PrismaTransaction } = {},
): Promise<ActivationOutcome> {
  const now = options.now ?? new Date();
  const run = async (tx: PrismaTransaction): Promise<ActivationOutcome> => {
    const row = (await tx.booking.findUnique({
      where: { id: bookingId },
      select: BOOKING_SELECT,
    })) as BookingRow | null;

    if (!row) return { kind: 'not-payable' };

    if (row.status === 'ACTIVE' || row.status === 'OVERSTAY') {
      return { kind: 'already-active', booking: row };
    }

    if (row.status !== 'PENDING_PAYMENT' && row.status !== 'EXPIRED_UNPAID') {
      // CANCELLED or COMPLETED. Money arrived for something that is over.
      return { kind: 'not-payable' };
    }

    const snapshot = snapshotOf(row);
    const endsAt = new Date(now.getTime() + row.hours * 60 * 60 * 1000);
    const reservedUntil = reservedUntilFrom(snapshot, endsAt);

    /**
     * Re-check availability for the *new* window.
     *
     * `endsAt` moves later than the provisional end the hold reserved, so the
     * window this booking now needs may have been sold to someone else in the
     * meantime. The exclusion constraint would reject the write anyway — this
     * read exists so the answer is a clean outcome rather than an exception.
     */
    const clash = await tx.booking.findFirst({
      where: {
        deviceId: row.deviceId,
        id: { not: row.id },
        status: { in: ['PENDING_PAYMENT', 'ACTIVE', 'OVERSTAY'] },
        startsAt: { lt: reservedUntil },
        reservedUntil: { gt: now },
      },
      select: { id: true },
    });

    if (clash) return { kind: 'device-taken' };

    // The device must also still be rentable — an admin may have retired it or
    // flagged it for inspection while the payment was in flight.
    const device = await tx.device.findUnique({
      where: { id: row.deviceId },
      select: { status: true },
    });
    if (device?.status !== 'AVAILABLE') return { kind: 'device-taken' };

    const updated = (await tx.booking.update({
      where: { id: row.id },
      data: {
        status: 'ACTIVE',
        startsAt: now,
        endsAt,
        reservedUntil,
        holdExpiresAt: null,
      },
      select: BOOKING_SELECT,
    })) as BookingRow;

    /**
     * The booking's whole message schedule, written in this transaction.
     *
     * Atomic with activation, so there is no state in which a booking is
     * running and nobody will be reminded about it — and none in which a
     * rollback leaves reminders for a booking that never started.
     */
    await scheduleFor(tx, updated, { phase: 'ACTIVATION' }, now);

    return { kind: 'activated', booking: updated };
  };

  try {
    return options.client ? await run(options.client) : await prisma.$transaction(run);
  } catch (error) {
    // The constraint caught a race the read above missed. Same answer.
    if (isOverlapViolation(error)) return { kind: 'device-taken' };
    throw error;
  }
}

// --- Extension ---------------------------------------------------------------

/**
 * Checks that an extension is possible, and returns what it would cost.
 *
 * Allowed from `ACTIVE` **and during the grace period** — someone who is five
 * minutes over and wants another hour should be able to buy one rather than be
 * pushed into an overstay fee. Not allowed once a fee is actually owed: that
 * would re-price time already charged at the overstay rate, and the answer to
 * an overstay is to pay it.
 */
/**
 * Whether an extension is possible, **without throwing**.
 *
 * The single source of that answer. The page that offers extensions, the
 * dashboard and the order endpoint all end up here, so none of them can offer
 * a duration another would refuse — three implementations of one rule is three
 * chances to show a button that 409s.
 *
 * Refusals are reasons rather than messages: the server decides *why*, the
 * client decides how to say it, and the remedy differs per reason.
 */
export async function extensionAvailability(
  row: BookingRow,
  now = new Date(),
): Promise<ExtensionAvailability> {
  const snapshot = snapshotOf(row);
  const refused = (reason: ExtensionRefusalReason): ExtensionAvailability => ({
    allowed: false,
    reason,
    options: [],
    maxHours: 0,
  });

  if (!row.endsAt || (row.status !== 'ACTIVE' && row.status !== 'OVERSTAY')) {
    return refused('NOT_RUNNING');
  }

  /**
   * A fee owed is not an extendable situation.
   *
   * The hour being extended has already been charged at the overstay rate, so
   * extending would re-price time already billed. The answer to an overstay is
   * to pay it and collect.
   */
  if (outstandingFeePaise(row, now) > 0) return refused('OVERSTAY_FEE_DUE');

  // Past the grace period there is a fee by definition, so the check above
  // covers it — but a waived fee could leave us here, and extending then would
  // confuse the accounting. Refuse explicitly.
  if (row.overstayWaivedAt || row.overstaySettledAt) return refused('IN_COLLECTION_WINDOW');

  /**
   * How far the reservation may be pushed before it meets the next booking.
   *
   * The earliest following booking is read once and turned into a maximum
   * number of hours, rather than a yes/no per duration: "you can have two more
   * hours but not five" is a far better answer than "no", and it is the same
   * query either way. The bound is on `reservedUntil`, not `endsAt`, because
   * the safe also needs its grace period and collection window back before the
   * next renter arrives.
   */
  const following = await prisma.booking.findFirst({
    where: {
      deviceId: row.deviceId,
      id: { not: row.id },
      status: { in: ['PENDING_PAYMENT', 'ACTIVE', 'OVERSTAY'] },
      reservedUntil: { gt: row.startsAt },
    },
    orderBy: { startsAt: 'asc' },
    select: { startsAt: true },
  });

  const turnaroundMs =
    (snapshot.graceMinutes + snapshot.collectionWindowMinutes) * 60 * 1000;

  const maxHoursByCollision = following
    ? Math.floor(
        (following.startsAt.getTime() - turnaroundMs - row.endsAt.getTime()) /
          (60 * 60 * 1000),
      )
    : Number.POSITIVE_INFINITY;

  const maxHours = Math.min(env.RENTAL_MAX_HOURS, maxHoursByCollision);

  if (maxHours < env.RENTAL_MIN_HOURS) return refused('FOLLOWING_BOOKING');

  const options: Array<{ hours: number; pricePaise: number }> = [];
  for (let hours = env.RENTAL_MIN_HOURS; hours <= maxHours; hours += 1) {
    // Priced from the **snapshot**, not the live config.
    options.push({ hours, pricePaise: bookingPricePaise(snapshot, hours) });
  }

  return { allowed: true, reason: null, options, maxHours };
}

export async function assertExtendable(
  row: BookingRow,
  hours: number,
  now = new Date(),
): Promise<{ pricePaise: number; newEndsAt: Date; newReservedUntil: Date }> {
  const snapshot = snapshotOf(row);

  if (hours < env.RENTAL_MIN_HOURS || hours > env.RENTAL_MAX_HOURS) {
    throw new HttpError({
      status: 400,
      code: ERROR_CODES.VALIDATION_ERROR,
      message: `An extension must be between ${env.RENTAL_MIN_HOURS} and ${env.RENTAL_MAX_HOURS} hours.`,
    });
  }

  /**
   * The same answer the page was given, turned into an error.
   *
   * Deliberately *not* a second implementation: this function exists to map
   * one refusal onto a status code and a sentence, and that mapping is the
   * only thing it adds.
   */
  const availability = await extensionAvailability(row, now);

  if (!availability.allowed || hours > availability.maxHours) {
    throw extensionRefusal(availability.reason ?? 'FOLLOWING_BOOKING');
  }

  // Unreachable: NOT_RUNNING covers a null `endsAt`, and `allowed` is false
  // in that case. Narrowing for the arithmetic below.
  if (!row.endsAt) throw stateInvalid('Only a paid, running booking can be extended.');

  const newEndsAt = new Date(row.endsAt.getTime() + hours * 60 * 60 * 1000);

  return {
    pricePaise: bookingPricePaise(snapshot, hours),
    newEndsAt,
    newReservedUntil: reservedUntilFrom(snapshot, newEndsAt),
  };
}

/** One refusal reason, as the HTTP error the write paths throw. */
function extensionRefusal(reason: ExtensionRefusalReason): HttpError {
  if (reason === 'NOT_RUNNING') {
    return stateInvalid('Only a paid, running booking can be extended.');
  }

  const message =
    reason === 'OVERSTAY_FEE_DUE'
      ? 'An overstay fee is outstanding, so this booking cannot be extended. Pay the fee and collect your items.'
      : reason === 'IN_COLLECTION_WINDOW'
        ? 'This booking is in its collection window and cannot be extended.'
        : 'This safe is booked by someone else after you, so it cannot be extended.';

  return new HttpError({
    status: 409,
    code: ERROR_CODES.EXTENSION_NOT_AVAILABLE,
    message,
  });
}

/** Applies a paid extension. Called only after the money is confirmed. */
export async function applyExtension(
  bookingId: string,
  hours: number,
  amountPaise: number,
  client?: PrismaTransaction,
): Promise<BookingRow> {
  const run = async (tx: PrismaTransaction): Promise<BookingRow> => {
    const row = (await tx.booking.findUniqueOrThrow({
      where: { id: bookingId },
      select: BOOKING_SELECT,
    })) as BookingRow;

    if (!row.endsAt) throw stateInvalid('Only a paid booking can be extended.');

    const snapshot = snapshotOf(row);
    const newEndsAt = new Date(row.endsAt.getTime() + hours * 60 * 60 * 1000);

    const updated = (await tx.booking.update({
      where: { id: row.id },
      data: {
        hours: row.hours + hours,
        endsAt: newEndsAt,
        reservedUntil: reservedUntilFrom(snapshot, newEndsAt),
        pricePaise: row.pricePaise + amountPaise,
        // Back to ACTIVE if the extension cleared an in-grace overstay.
        status: 'ACTIVE',
      },
      select: BOOKING_SELECT,
    })) as BookingRow;

    /**
     * Every deadline just moved, so every deadline message is wrong.
     *
     * Cancelled first and re-created from the new `endsAt`, in that order and
     * in this transaction. The old rows do not block the new ones: the keys
     * carry their due times, which have all shifted by whole hours. The
     * confirmation is re-sent rather than cancelled — "yours until 11pm" is
     * exactly the sentence an extension needs, and it was true when it was
     * sent the first time.
     */
    await cancelDeadlineMessages(tx, updated.id);
    await scheduleFor(tx, updated, { phase: 'EXTENSION' });

    return updated;
  };

  return client ? run(client) : prisma.$transaction(run);
}

// --- Overstay settlement -----------------------------------------------------

/** Marks an overstay fee paid, opening the collection window. */
export async function settleOverstay(
  bookingId: string,
  paidPaise: number,
  options: {
    now?: Date;
    client?: PrismaTransaction;
    /**
     * The payment that settled it, which keys the receipt message.
     *
     * Required for the message to be scheduled at all: settlement runs from
     * both the verified callback and the webhook, and the payment id is the
     * only discriminator both of them agree about. Omitting it schedules no
     * receipt rather than risking two.
     */
    paymentRowId?: string;
  } = {},
): Promise<BookingRow> {
  const now = options.now ?? new Date();

  const run = async (tx: PrismaTransaction): Promise<BookingRow> => {
    const updated = (await tx.booking.update({
      where: { id: bookingId },
      data: {
        status: 'OVERSTAY',
        /**
         * Accrual stops **here**, at capture.
         *
         * Any growth between the quote and the money landing is absorbed. The
         * alternative — settling partially and leaving a residue — creates a
         * loop in which the user can never finish paying, which is worse than
         * giving away at most one started hour. See docs/decisions.md.
         */
        overstaySettledAt: now,
        overstayPaidPaise: { increment: paidPaise },
      },
      select: BOOKING_SELECT,
    })) as BookingRow;

    /**
     * The fee is dealt with, so the reminders about it are wrong.
     *
     * Cancel the deadline messages — an `OVERSTAY_STARTED` still queued would
     * tell someone who has just paid that a fee has started — then send a
     * receipt and schedule the collection reminder.
     */
    await cancelDeadlineMessages(tx, updated.id);

    if (options.paymentRowId) {
      await scheduleFor(
        tx,
        updated,
        { phase: 'OVERSTAY_SETTLED', paymentRowId: options.paymentRowId, settledAt: now },
        now,
      );
    }

    return updated;
  };

  return options.client ? run(options.client) : prisma.$transaction(run);
}

// --- Completion --------------------------------------------------------------

export type CompletionReason =
  | 'COLLECTED'
  | 'COLLECTION_WINDOW_LAPSED'
  | 'ADMIN_FORCE_COMPLETED';

export interface CompleteResult {
  booking: BookingRow;
  /** True when the device went to NEEDS_INSPECTION rather than back to the pool. */
  needsInspection: boolean;
}

/**
 * Ends a booking and decides what happens to the safe.
 *
 * **Only `COLLECTED` returns the device to the pool.** The other two reasons
 * mean the booking ended with the contents unknown, and a safe whose contents
 * are unknown must not be handed to the next renter — who would be able to
 * unlock it. Those go to `NEEDS_INSPECTION` until a human clears them.
 *
 * The lock command is **not** sent from here: it is a gateway round trip and
 * must not happen inside the transaction. The caller sends it after the commit
 * (see {@link lockAfterCompletion}).
 */
export async function completeBooking(input: {
  bookingId: string;
  reason: CompletionReason;
  adminNote?: string | null;
  needsInspection?: boolean;
  now?: Date;
  client?: PrismaTransaction;
}): Promise<CompleteResult> {
  const now = input.now ?? new Date();
  // Collected means the user told us they have their things. Anything else
  // leaves the contents unknown, so inspection is the default.
  const needsInspection = input.needsInspection ?? input.reason !== 'COLLECTED';

  const run = async (tx: PrismaTransaction): Promise<CompleteResult> => {
    const row = (await tx.booking.findUniqueOrThrow({
      where: { id: input.bookingId },
      select: BOOKING_SELECT,
    })) as BookingRow;

    const updated = (await tx.booking.update({
      where: { id: row.id },
      data: {
        status: 'COMPLETED',
        completedAt: now,
        completionReason: input.reason,
        ...(input.adminNote ? { adminNote: input.adminNote } : {}),
        // Leaving the constraint frees the device for the next booking.
        reservedUntil: now,
      },
      select: BOOKING_SELECT,
    })) as BookingRow;

    await tx.device.update({
      where: { id: row.deviceId },
      data: needsInspection
        ? {
            status: 'NEEDS_INSPECTION',
            inspectionNote:
              input.reason === 'COLLECTION_WINDOW_LAPSED'
                ? 'Collection window lapsed with no confirmation — check for belongings'
                : (input.adminNote ?? 'Force-completed by an admin — check for belongings'),
            inspectionNotedAt: now,
          }
        : { status: 'AVAILABLE', inspectionNote: null, inspectionNotedAt: null },
    });

    /**
     * Any open unlock code dies with the booking.
     *
     * Without this, a code requested while the booking was live would still
     * verify afterwards — the challenge has its own five-minute life and knows
     * nothing about bookings. The unlock path re-checks eligibility too, so
     * this is the second of two independent guards.
     */
    await tx.unlockChallenge.updateMany({
      where: { userId: row.userId, deviceId: row.deviceId, consumedAt: null },
      data: { consumedAt: now },
    });

    /**
     * A booking that is over has nothing left to say.
     *
     * All three completion reasons, including a force-complete: telling
     * somebody their booking ends in ten minutes, after an admin ended it, is
     * worse than silence. Re-validation would refuse these anyway — this is
     * the tidy path, and the two are independent on purpose.
     */
    await cancelPending(tx, row.id);

    return { booking: updated, needsInspection };
  };

  return input.client ? run(input.client) : prisma.$transaction(run);
}

/**
 * Locks the safe after a booking has ended.
 *
 * **After the commit, never inside the transaction** — the same rule the
 * outbox follows, for the same reason: a publish is a network round trip and a
 * transaction cannot un-send one.
 *
 * ## No longer best effort
 * It used to call the gateway, log a failure and shrug. That was tolerable
 * against a mock that always acked and is not tolerable against hardware: a
 * safe between renters could be recorded closed while standing physically
 * open, which is the one outcome worth any amount of machinery to avoid, and
 * is what the roadmap meant by owing this path a real guarantee.
 *
 * Now it issues a **system** command (`systemActor: COMPLETION`, no `userId`),
 * and the system half of the lifecycle takes over: no ack in 15s means a
 * retry, three failed attempts means `lockCommandFailedAt`, an admin flag, an
 * audit row and `NEEDS_INSPECTION`. Nobody is waiting on this command, which
 * is exactly what licenses it to retry where a user's lock may not.
 *
 * Still does not throw. A booking that has ended has ended whether or not the
 * bolt moved, and failing the user's request would leave the database and
 * their view disagreeing about a booking that is definitely over.
 */
export async function lockAfterCompletion(deviceId: string): Promise<void> {
  try {
    const issued = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Device" WHERE "id" = ${deviceId} FOR UPDATE`;

      const device = await tx.device.findUnique({
        where: { id: deviceId },
        select: { id: true },
      });
      if (!device) return null;

      /**
       * At most one live system command per device, which the partial unique
       * index also enforces. Checked here so the ordinary case is a clean skip
       * rather than a caught constraint violation — a completion lock racing a
       * reconcile is two commands asking for the same end state, and the
       * device would reject the second as a duplicate.
       */
      const inFlight = await tx.command.findFirst({
        where: {
          deviceId,
          systemActor: { not: null },
          status: { in: ['PENDING', 'SENT'] },
        },
        select: { id: true },
      });
      if (inFlight) return null;

      return createCommand(tx, {
        deviceId,
        type: 'LOCK',
        systemActor: 'COMPLETION',
      });
    });

    if (!issued) return;

    await publishCommand(issued);
  } catch (cause) {
    logger.error(
      { deviceId, reason: cause instanceof Error ? cause.message : 'unknown' },
      'Failed to issue a lock after a booking completed',
    );
  }
}

/**
 * The user collecting their belongings.
 *
 * Refused while an overstay fee is outstanding: collecting would be the user
 * walking away with their things and the fee unpaid, and the fee is the only
 * leverage the product has. Allowed from `ACTIVE`, and from `OVERSTAY` once
 * the fee is settled or waived.
 */
export async function collectBooking(input: {
  bookingId: string;
  userId: string;
  now?: Date;
}): Promise<BookingSummary> {
  const now = input.now ?? new Date();
  const row = await getBookingForUser(input.bookingId, input.userId);

  const effective = effectiveBookingStatus({
    status: row.status,
    endsAt: row.endsAt,
    holdExpiresAt: row.holdExpiresAt,
    overstaySettledAt: row.overstaySettledAt ?? row.overstayWaivedAt,
    snapshot: snapshotOf(row),
    now,
  });

  if (effective !== 'ACTIVE' && effective !== 'OVERSTAY') {
    throw stateInvalid('This booking is not running, so there is nothing to collect.');
  }

  const fee = outstandingFeePaise(row, now);
  if (fee > 0) throw overstayDue(fee);

  const result = await completeBooking({
    bookingId: row.id,
    reason: 'COLLECTED',
    now,
  });

  // After the commit, deliberately.
  await lockAfterCompletion(row.deviceId);

  return toBookingSummary(result.booking, now);
}

/** Cancelling an unpaid booking. Releases the hold immediately. */
export async function cancelBooking(input: {
  bookingId: string;
  userId: string;
  now?: Date;
}): Promise<BookingSummary> {
  const now = input.now ?? new Date();
  const row = await getBookingForUser(input.bookingId, input.userId);

  if (row.status !== 'PENDING_PAYMENT') {
    // A paid booking is not cancellable here: that is a refund, and the refund
    // policy is an open question. See CLAUDE.md.
    throw stateInvalid('Only an unpaid booking can be cancelled.');
  }

  /**
   * A transaction now, for the message cancellation.
   *
   * An unpaid booking has nothing scheduled — the schedule starts at
   * activation — so this cancels nothing today. It is here because the
   * alternative is a rule that holds by coincidence: if cancellation ever
   * becomes reachable from a paid state (the refund policy is still open),
   * the cancel would quietly stop happening.
   */
  const updated = await prisma.$transaction(async (tx) => {
    const next = (await tx.booking.update({
      where: { id: row.id },
      data: { status: 'CANCELLED', completedAt: now, reservedUntil: now },
      select: BOOKING_SELECT,
    })) as BookingRow;

    await cancelPending(tx, next.id);

    return next;
  });

  return toBookingSummary(updated, now);
}

// --- Admin actions -----------------------------------------------------------

/**
 * An admin ending a booking by hand.
 *
 * **`needsInspection` defaults to true and the admin chooses.** Defaulting the
 * other way would send a possibly-occupied safe back into the pool on a
 * careless click; making it unconditional would leave an admin who *has* just
 * looked inside unable to say so, and would push them towards clearing the
 * inspection flag immediately afterwards without looking — which is worse,
 * because it is the same two clicks with the check skipped.
 *
 * The reason is required by the schema and recorded on the booking and in the
 * audit log.
 */
export async function adminForceComplete(input: {
  bookingId: string;
  reason: string;
  needsInspection: boolean;
  now?: Date;
}): Promise<{ booking: BookingSummary; needsInspection: boolean; deviceId: string }> {
  const now = input.now ?? new Date();

  const row = (await prisma.booking.findUnique({
    where: { id: input.bookingId },
    select: BOOKING_SELECT,
  })) as BookingRow | null;

  if (!row) throw bookingNotFound();

  if (row.status !== 'PENDING_PAYMENT' && row.status !== 'ACTIVE' && row.status !== 'OVERSTAY') {
    throw stateInvalid('That booking has already ended.');
  }

  const result = await completeBooking({
    bookingId: row.id,
    reason: 'ADMIN_FORCE_COMPLETED',
    adminNote: input.reason,
    needsInspection: input.needsInspection,
    now,
  });

  // After the commit, deliberately.
  await lockAfterCompletion(row.deviceId);

  return {
    booking: toBookingSummary(result.booking, now),
    needsInspection: result.needsInspection,
    deviceId: row.deviceId,
  };
}

/**
 * An admin writing off an overstay fee.
 *
 * Sets `overstayWaivedAt`, which the fee arithmetic treats exactly like a
 * settlement — so the user can unlock and collect — but records **zero
 * collected**, because nothing was. Keeping the two timestamps separate is
 * what stops a waive looking like revenue in `overstayPaidPaise`.
 *
 * It does not complete the booking: the user still has to collect, and the
 * collection window starts from the waive just as it would from a payment.
 */
export async function adminWaiveOverstay(input: {
  bookingId: string;
  reason: string;
  now?: Date;
}): Promise<{ booking: BookingSummary; deviceId: string; waivedPaise: number }> {
  const now = input.now ?? new Date();

  const row = (await prisma.booking.findUnique({
    where: { id: input.bookingId },
    select: BOOKING_SELECT,
  })) as BookingRow | null;

  if (!row) throw bookingNotFound();

  if (row.overstaySettledAt || row.overstayWaivedAt) {
    throw stateInvalid('That overstay has already been settled or waived.');
  }

  const waivedPaise = outstandingFeePaise(row, now);
  if (waivedPaise <= 0) {
    throw conflict(
      ERROR_CODES.NOTHING_TO_PAY,
      'There is no overstay fee outstanding on that booking.',
    );
  }

  const updated = await prisma.$transaction(async (tx) => {
    const next = (await tx.booking.update({
      where: { id: row.id },
      data: {
        status: 'OVERSTAY',
        overstayWaivedAt: now,
        adminNote: input.reason,
      },
      select: BOOKING_SELECT,
    })) as BookingRow;

    /**
     * A waiver sends **no receipt**, only the collection reminder.
     *
     * Wording a write-off as a payment would be a lie about money, and a
     * sixth approved template to say "nothing is owed" buys one sentence. The
     * consequence is real and accepted: a waived user gets no immediate
     * message, so the admin who waived is expected to tell them. Recorded in
     * docs/decisions.md.
     */
    await cancelDeadlineMessages(tx, next.id);
    await scheduleFor(tx, next, { phase: 'OVERSTAY_WAIVED', waivedAt: now }, now);

    return next;
  });

  return {
    booking: toBookingSummary(updated, now),
    deviceId: row.deviceId,
    waivedPaise,
  };
}

export {
  bookingNotFound,
  noDevicesFree,
  noDevicesInService,
  overstayDue,
  stateInvalid,
  isOverlapViolation,
};
