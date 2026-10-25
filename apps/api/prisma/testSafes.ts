import type { SafeSize } from '@safelock/shared';
import { prisma } from '../src/lib/prisma';

/**
 * A fleet of fake safes, for driving the website without hardware.
 *
 * ## Why this exists
 * The booking pick is deliberately strict: a safe is offered only if it is
 * `AVAILABLE`, **online**, and reporting a door state (see
 * `bookings/booking.service.ts`). A freshly registered serial satisfies none of
 * the last two — `doorState` defaults to `UNKNOWN` and nothing has ever
 * reported — which is correct for real inventory and leaves a Supabase database
 * with no bookable stock at all. Every size shows unavailable and `/book` is a
 * page of disabled cards.
 *
 * So this writes rows that look like units which **have** connected and said
 * what they are, because on the mock gateway that is the truth: the mock is
 * always reachable and always obeys. It is not pretending the hardware works;
 * it is matching the row to the gateway actually in use.
 *
 * ## Why it refuses outside development
 * Two guards, both of which should be unreachable, which is the point:
 * - `NODE_ENV=production` — this inserts stock that does not exist. An
 *   inventory row claiming a reachable safe is an inventory row a customer can
 *   pay to rent, and there would be nothing at the address.
 * - `DEVICE_GATEWAY` other than `mock` — over a real transport these rows are
 *   simply false: nothing answers for `SAFE-TEST*`, so every completion lock
 *   fails, the sweeper retries it three times and the escalation moves each
 *   device to `NEEDS_INSPECTION`. The seed would quietly eat the inventory it
 *   just created.
 *
 * The guard takes its values as arguments rather than reading `config/env`, so
 * the refusal can be tested without a test mutating the process environment —
 * the same shape as `seedAdmin`'s `allowProduction`.
 */

/**
 * The marker for test stock: the serial prefix, and nothing else.
 *
 * **No schema change.** The alternatives were a boolean column (a migration,
 * and a flag that production rows would carry forever) or `inspectionNote` —
 * which is load-bearing elsewhere: it is the audited note an admin leaves when
 * clearing a safe, and the Devices tab renders it as a flag with a remedy.
 * Writing "test data" into it would put a permanent fake incident on every
 * seeded row.
 *
 * A prefix costs nothing, is visible in every list and log line, and makes the
 * cleanup query exact. It is also the whole reason cleanup can be safe: there
 * is no pattern-match here that could ever select a real serial, because a real
 * serial cannot begin `SAFE-TEST` by accident.
 *
 * Note the shape is constrained by `SERIAL_NUMBER_REGEX`
 * (`/^SAFE-[0-9A-Z]{4,12}$/`) — digits and capitals only after `SAFE-`, so no
 * second hyphen. `SAFE-TESTS001` passes the same validation the admin create
 * form applies; `SAFE-S-001` would not, and a row the admin UI could not have
 * produced is a row that behaves differently from real stock.
 */
export const TEST_SAFE_PREFIX = 'SAFE-TEST';

/** How many of each size, and the letter that identifies it in a serial. */
export const TEST_SAFE_PLAN: ReadonlyArray<{
  size: SafeSize;
  letter: string;
  count: number;
}> = [
  { size: 'SMALL', letter: 'S', count: 12 },
  { size: 'MEDIUM', letter: 'M', count: 12 },
  { size: 'LARGE', letter: 'L', count: 6 },
];

/** `SAFE-TESTS001`. */
export function testSafeSerial(letter: string, index: number): string {
  return `${TEST_SAFE_PREFIX}${letter}${String(index).padStart(3, '0')}`;
}

/** Every serial this seed owns, in order, with its size. */
export function testSafeRoster(): Array<{ serialNumber: string; size: SafeSize }> {
  return TEST_SAFE_PLAN.flatMap(({ size, letter, count }) =>
    Array.from({ length: count }, (_, i) => ({
      serialNumber: testSafeSerial(letter, i + 1),
      size,
    })),
  );
}

export class TestSafeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TestSafeError';
  }
}

export interface DevOnlyGuardInput {
  nodeEnv: string | undefined;
  deviceGateway: string | undefined;
}

/**
 * Refuses anywhere these rows would be a lie.
 *
 * Throws rather than warning: a seed that prints a caution and proceeds is a
 * seed that has already written.
 */
export function assertDevOnly(input: DevOnlyGuardInput, action: string): void {
  if (input.nodeEnv === 'production') {
    throw new TestSafeError(
      `Refusing to ${action} test safes with NODE_ENV=production. These rows claim ` +
        'hardware that does not exist, and a customer can pay to rent one. There is ' +
        'no override flag — seed real inventory through the admin panel instead.',
    );
  }

  if (input.deviceGateway !== 'mock') {
    throw new TestSafeError(
      `Refusing to ${action} test safes with DEVICE_GATEWAY=${
        input.deviceGateway ?? '(unset)'
      }. Only the mock gateway answers for a serial with no unit behind it; over a ` +
        'real transport every completion lock would fail and the sweeper would move ' +
        'each of these safes to NEEDS_INSPECTION.',
    );
  }
}

// --- Seed --------------------------------------------------------------------

export interface SeedTestSafesInput extends DevOnlyGuardInput {
  /** Injected so a test can assert the stamped liveness exactly. */
  now?: Date;
}

export interface SeedTestSafesResult {
  created: number;
  /** Already present, and had their liveness stamped forward. */
  refreshed: number;
  total: number;
  bySize: Record<SafeSize, number>;
}

/**
 * Creates the roster if it is absent, and makes it reachable either way.
 *
 * ## What a re-run does and does not touch
 * Re-running **only** advances liveness (`online`, `lastSeenAt`, and
 * `doorState` where it is still `UNKNOWN`). It deliberately leaves `status`,
 * `size` and `lockState` alone, so:
 * - a safe a developer drove into `NEEDS_INSPECTION` stays there to be cleared
 *   through the admin flow, rather than being silently healed by a seed;
 * - a safe reclassified by hand keeps its new size;
 * - a bolt left `UNLOCKED` is not rewritten to `LOCKED`, which would be this
 *   script asserting a physical state no ack confirmed — the one thing
 *   `lockStateUpdatedAt` exists to prevent.
 *
 * So the second and later runs are exactly "make these reachable again", which
 * is the operation a developer actually wants from them.
 */
export async function seedTestSafes(
  input: SeedTestSafesInput,
): Promise<SeedTestSafesResult> {
  assertDevOnly(input, 'seed');

  const now = input.now ?? new Date();
  const roster = testSafeRoster();
  const serials = roster.map((row) => row.serialNumber);

  const existing = await prisma.device.findMany({
    where: { serialNumber: { in: serials } },
    select: { serialNumber: true },
  });
  const present = new Set(existing.map((row) => row.serialNumber));

  const missing = roster.filter((row) => !present.has(row.serialNumber));

  if (missing.length) {
    await prisma.device.createMany({
      data: missing.map((row) => ({
        serialNumber: row.serialNumber,
        size: row.size,
        status: 'AVAILABLE',
        // A safe ships locked, and this one has never been asked to move.
        lockState: 'LOCKED',
        doorState: 'CLOSED',
        online: true,
        lastSeenAt: now,
      })),
      // Covers the narrow race with a second seed running alongside, and makes
      // the whole call idempotent even if the read above went stale.
      skipDuplicates: true,
    });
  }

  /**
   * Liveness, for the rows that already existed.
   *
   * This is the half that matters on a re-run: `lastSeenAt` is compared against
   * `DEVICE_OFFLINE_AFTER_SECONDS` on every read, so yesterday's seed is a
   * fleet of offline safes.
   */
  const refreshed = await prisma.device.updateMany({
    where: { serialNumber: { in: serials.filter((serial) => present.has(serial)) } },
    data: { online: true, lastSeenAt: now },
  });

  /**
   * A door sensor that has never reported excludes a safe from the pick. Only
   * nudged from `UNKNOWN`, never away from a state something actually measured.
   */
  await prisma.device.updateMany({
    where: { serialNumber: { startsWith: TEST_SAFE_PREFIX }, doorState: 'UNKNOWN' },
    data: { doorState: 'CLOSED' },
  });

  const counts = await prisma.device.groupBy({
    by: ['size'],
    where: { serialNumber: { startsWith: TEST_SAFE_PREFIX } },
    _count: { _all: true },
  });

  const bySize: Record<SafeSize, number> = { SMALL: 0, MEDIUM: 0, LARGE: 0 };
  for (const row of counts) bySize[row.size] = row._count._all;

  return {
    created: missing.length,
    refreshed: refreshed.count,
    total: bySize.SMALL + bySize.MEDIUM + bySize.LARGE,
    bySize,
  };
}

// --- Heartbeat ---------------------------------------------------------------

/**
 * Stamps every test safe as seen just now.
 *
 * ## Why a loop is needed at all
 * `isDeviceOnline` requires `lastSeenAt` within `DEVICE_OFFLINE_AFTER_SECONDS`
 * (180s by default), and on the mock gateway the **only** thing that advances
 * it is an ack — there is no heartbeat, because there is no device to send one.
 * So a seeded fleet is bookable for three minutes and then goes dark, and it
 * cannot recover on its own: `lockDevice` and `requestUnlock` both pass
 * `requireOnline: true`, so the one thing that would refresh liveness is the
 * one thing a stale row refuses.
 *
 * This is the smallest fix that does not touch a request path: a dev-only
 * `updateMany` on rows matching the test prefix, driven from the seed script
 * with `--heartbeat`. No production code changed, nothing about `online`
 * derivation relaxed, and real inventory is untouched because the `where`
 * cannot match a real serial.
 */
export async function heartbeatTestSafes(now: Date = new Date()): Promise<number> {
  const result = await prisma.device.updateMany({
    // Not `status: AVAILABLE` — a safe in NEEDS_INSPECTION is still physically
    // present and reachable, and an admin clearing it needs it to be.
    where: { serialNumber: { startsWith: TEST_SAFE_PREFIX }, status: { not: 'RETIRED' } },
    data: { online: true, lastSeenAt: now },
  });

  return result.count;
}

// --- Cleanup -----------------------------------------------------------------

export interface CleanupTestSafesResult {
  deleted: number;
  retired: number;
  /**
   * Retired while a booking still occupied them. Surfaced rather than refused:
   * these are fake safes, but a renter's dashboard is about to change under
   * them, and that should be said out loud.
   */
  liveBookings: string[];
  /** Already `RETIRED`, so nothing to do. */
  untouched: number;
}

/**
 * Removes the seeded fleet, and only it.
 *
 * Delete where the row is free to go; retire where it is not. `Booking.device`
 * is `onDelete: Restrict` — on purpose, since a booking is the record of a
 * contract and must not vanish with the hardware — so a safe anyone has ever
 * booked cannot be deleted without destroying that record. `RETIRED` is the
 * supported way to take a unit off the fleet, and it is what the admin panel
 * does.
 *
 * Deleting cascades `DeviceEvent`, `UnlockChallenge` and `Command`, which is
 * the schema's existing decision and correct here: those rows describe a safe
 * that never existed. `AuditLog.deviceId` has no foreign key and is left
 * alone — an audit log that edits itself when its subject is removed is not an
 * audit log.
 */
export async function cleanupTestSafes(
  input: DevOnlyGuardInput,
): Promise<CleanupTestSafesResult> {
  assertDevOnly(input, 'clean up');

  const devices = await prisma.device.findMany({
    where: { serialNumber: { startsWith: TEST_SAFE_PREFIX } },
    select: {
      id: true,
      serialNumber: true,
      status: true,
      bookings: {
        select: { id: true, status: true },
      },
    },
  });

  const deletable = devices.filter((device) => device.bookings.length === 0);
  const retirable = devices.filter(
    (device) => device.bookings.length > 0 && device.status !== 'RETIRED',
  );
  const untouched = devices.filter(
    (device) => device.bookings.length > 0 && device.status === 'RETIRED',
  );

  const liveBookings = retirable
    .filter((device) =>
      device.bookings.some((booking) =>
        (['PENDING_PAYMENT', 'ACTIVE', 'OVERSTAY'] as string[]).includes(booking.status),
      ),
    )
    .map((device) => device.serialNumber);

  if (deletable.length) {
    await prisma.device.deleteMany({
      where: { id: { in: deletable.map((device) => device.id) } },
    });
  }

  if (retirable.length) {
    await prisma.device.updateMany({
      where: { id: { in: retirable.map((device) => device.id) } },
      data: {
        status: 'RETIRED',
        online: false,
        // Retirement revokes the credential, exactly as `retireDevice` does.
        // A test safe is the last place to leave a usable broker password.
        credentialHash: null,
        credentialIssuedAt: null,
      },
    });
  }

  return {
    deleted: deletable.length,
    retired: retirable.length,
    liveBookings,
    untouched: untouched.length,
  };
}
