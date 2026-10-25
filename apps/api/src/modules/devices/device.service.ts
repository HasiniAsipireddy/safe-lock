import {
  ADMIN_COMMAND_HISTORY_LIMIT,
  BULK_CREATE_MAX_ROWS,
  ERROR_CODES,
  type AdminCommandRow,
  type AdminDeviceRow,
  type BulkCreateResult,
  type DeviceCredentialResponse,
  type BulkCreateRowResult,
  type ListDevicesQuery,
  type Paginated,
  type SafeSize,
  normaliseSerial,
  serialNumberSchema,
} from '@safelock/shared';
import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { HttpError, conflict, notFound } from '../../lib/httpError';
import { deriveCommandKey, mintDeviceCredential } from '../../lib/deviceProtocol';
import {
  ADMIN_COMMAND_SELECT,
  ADMIN_DEVICE_SELECT,
  toAdminCommandRow,
  toAdminDeviceRow,
} from './device.mapper';

/**
 * Device inventory.
 *
 * **Allocation is gone.** Under the rental model nobody owns a device: a safe
 * is occupied for the duration of a `Booking` and free otherwise, and which
 * safe a booking gets is decided in `bookings/booking.service.ts` under a row
 * lock, with a Postgres exclusion constraint as the real guarantee. What is
 * left here is stock management — create, bulk import, list, retire — plus
 * clearing a safe for rental after a human has inspected it.
 */

// --- Errors ------------------------------------------------------------------

const deviceNotFound = () => notFound('No safe with that id.');

const notAvailable = (status: string) =>
  conflict(
    ERROR_CODES.DEVICE_NOT_AVAILABLE,
    `That safe is ${status.toLowerCase().replace('_', ' ')}, so it cannot be changed that way.`,
  );

function isUniqueViolation(error: unknown): boolean {
  // Duck-typed: Prisma's error classes have moved between major versions, and
  // a missed import would silently turn a safe conflict into a 500.
  return (error as { code?: string } | null)?.code === 'P2002';
}

// --- Inspection --------------------------------------------------------------

export interface DeviceMutationResult {
  device: AdminDeviceRow;
}

/**
 * Retirement, plus whether it revoked anything.
 *
 * Separate from {@link DeviceMutationResult} because the flag drives two
 * things a boolean on a device row could not: an audit row that is only
 * written when a credential actually existed, and a sentence telling the admin
 * the unit must now be removed at the broker as well. Retiring a never-
 * provisioned safe is paperwork; retiring a live one is a revocation with a
 * second half to perform by hand.
 */
export interface RetireDeviceResult extends DeviceMutationResult {
  credentialRevoked: boolean;
}

/**
 * Returns a safe to the pool after a human has looked inside it.
 *
 * A device reaches `NEEDS_INSPECTION` when a booking ended without the renter
 * confirming they took their belongings — a lapsed collection window, or an
 * admin force-complete. Renting it out again without someone checking would
 * hand the next person a safe containing someone else's property, with the
 * ability to unlock it. So clearing it is a deliberate human action with a
 * **required note**, and it is audited.
 */
export async function clearInspection(
  deviceId: string,
  note: string,
): Promise<DeviceMutationResult> {
  const device = await prisma.$transaction(async (tx) => {
    const current = await tx.device.findUnique({
      where: { id: deviceId },
      select: { id: true, status: true },
    });
    if (!current) throw deviceNotFound();

    if (current.status !== 'NEEDS_INSPECTION') {
      throw notAvailable(current.status);
    }

    return tx.device.update({
      where: { id: deviceId },
      data: {
        status: 'AVAILABLE',
        inspectionNote: note,
        inspectionNotedAt: new Date(),
        // A safe handed back to the pool is locked and empty as far as we
        // know. `lockStateUpdatedAt` stays untouched: this is an assertion
        // about process, not a state the hardware confirmed.
        lockState: 'LOCKED',
      },
      select: ADMIN_DEVICE_SELECT,
    });
  });

  return { device: toAdminDeviceRow(device) };
}

// --- Provisioning ------------------------------------------------------------

/**
 * Mints a unit's broker password and hands over its command key. **Once.**
 *
 * The one endpoint in this API that returns a secret, and the reason is
 * physical rather than a convenience: a device cannot be *told* its identity
 * over a channel it does not yet have. So both secrets are generated here,
 * returned exactly once, and what is kept is a `sha256` of the password and
 * nothing of the key at all — `K_d` is derived from the master secret and the
 * serial every time it is needed, so a database leak yields no device key
 * because no device key is in the database.
 *
 * **Re-issuing is a revocation.** The previous password stops working the
 * moment the broker is updated, and a unit in the field that is not
 * re-provisioned goes silent — which is why the response says `reissued` and
 * the UI warns before the button is pressed. It is also how both rotations in
 * §2.3 are performed: the row's `commandKeyVersion` is set to the master
 * secret's current version here, so a re-provisioned device and its row move
 * together. That matters more than it looks — a device holding one version
 * while its row says another cannot even have its *rejection* read (§2.3's
 * open note), so provisioning is the only place the two are brought into
 * step.
 *
 * Refused for a `RETIRED` device, and allowed for `NEEDS_INSPECTION`: that
 * status means a safe is in the field with unknown contents, which is the one
 * safe an admin most needs to be able to reach.
 */
export async function issueDeviceCredential(
  deviceId: string,
): Promise<DeviceCredentialResponse> {
  const { password, hash } = mintDeviceCredential();
  const keyVersion = env.DEVICE_COMMAND_KEY_VERSION;
  const issuedAt = new Date();

  const device = await prisma.$transaction(async (tx) => {
    const current = await tx.device.findUnique({
      where: { id: deviceId },
      select: { id: true, serialNumber: true, status: true, credentialIssuedAt: true },
    });
    if (!current) throw deviceNotFound();

    if (current.status === 'RETIRED') {
      throw conflict(
        ERROR_CODES.DEVICE_NOT_AVAILABLE,
        'That safe is retired. Its credential was revoked and a new one cannot be issued.',
      );
    }

    await tx.device.update({
      where: { id: deviceId },
      data: {
        credentialHash: hash,
        credentialIssuedAt: issuedAt,
        commandKeyVersion: keyVersion,
      },
    });

    return current;
  });

  return {
    deviceId: device.id,
    serialNumber: device.serialNumber,
    password,
    /**
     * Returned as base64url rather than hex: it is what the installer pastes
     * or scans, and the derivation returns raw bytes precisely so the key has
     * no useful default rendering to leak through a stray template literal.
     */
    commandKey: deriveCommandKey(device.serialNumber, keyVersion).toString('base64url'),
    keyVersion,
    issuedAt: issuedAt.toISOString(),
    reissued: device.credentialIssuedAt !== null,
  };
}

/**
 * Takes a device permanently out of service.
 *
 * Refuses while a booking still occupies it: retiring hardware out of
 * somebody's rental would leave a renter with a safe the system has forgotten.
 * Wait for the booking to end, or force-complete it first.
 */
export async function retireDevice(deviceId: string): Promise<RetireDeviceResult> {
  const retired = await prisma.$transaction(async (tx) => {
    const current = await tx.device.findUnique({
      where: { id: deviceId },
      select: { id: true, status: true, credentialHash: true },
    });
    if (!current) throw deviceNotFound();

    if (current.status === 'RETIRED') {
      throw conflict(ERROR_CODES.DEVICE_NOT_AVAILABLE, 'That safe is already retired.');
    }

    const live = await tx.booking.findFirst({
      where: {
        deviceId,
        status: { in: ['PENDING_PAYMENT', 'ACTIVE', 'OVERSTAY'] },
      },
      select: { id: true },
    });

    if (live) {
      throw conflict(
        ERROR_CODES.DEVICE_HAS_LIVE_BOOKING,
        'That safe has a live booking. Wait for it to end, or force-complete it first.',
      );
    }

    const hadCredential = current.credentialHash !== null;

    const device = await tx.device.update({
      where: { id: deviceId },
      data: {
        status: 'RETIRED',
        online: false,
        /**
         * Retirement **revokes the credential**, and this is the half of that
         * the database can do.
         *
         * The other half is at the broker, where the password row is deleted
         * or the certificate revoked — and that is the half that actually
         * stops the unit connecting, because nothing here is consulted on a
         * connect. Nulling the hash is what makes the two impossible to drift
         * apart silently: there is no stored value left for anyone to compare
         * a password against, so a retired serial cannot be quietly
         * re-authenticated by restoring a broker entry.
         *
         * `credentialIssuedAt` goes with it. A retired unit showing
         * "provisioned" in the admin list would be a claim about a credential
         * that no longer authenticates anything; that it once had one is in
         * the audit log, which is where a question about the past belongs.
         *
         * `NEEDS_INSPECTION` deliberately does **not** do this — see §2.3. A
         * safe whose contents are unknown is the one safe an admin most needs
         * to be able to reach.
         */
        credentialHash: null,
        credentialIssuedAt: null,
      },
      select: ADMIN_DEVICE_SELECT,
    });

    return { device, hadCredential };
  });

  return {
    device: toAdminDeviceRow(retired.device),
    credentialRevoked: retired.hadCredential,
  };
}

// --- Inventory ---------------------------------------------------------------

/**
 * Creates one device. Serial is normalised by the schema before it gets here.
 *
 * The size is required by the schema rather than defaulted, so registering
 * stock is always a deliberate statement about which shelf it is: the column's
 * `MEDIUM` default exists for the backfill of rows that predate sizes, not as
 * a guess to apply to new hardware.
 */
export async function createDevice(
  serialNumber: string,
  size: SafeSize,
): Promise<AdminDeviceRow> {
  try {
    const device = await prisma.device.create({
      data: { serialNumber, size },
      select: ADMIN_DEVICE_SELECT,
    });
    return toAdminDeviceRow(device);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw conflict(
        ERROR_CODES.DUPLICATE_SERIAL,
        `A safe with serial ${serialNumber} is already in the inventory.`,
      );
    }
    throw error;
  }
}

/** The size on record, for an audit row that can say what changed. */
export async function getDeviceSize(deviceId: string): Promise<SafeSize | null> {
  const device = await prisma.device.findUnique({
    where: { id: deviceId },
    select: { size: true },
  });

  return device?.size ?? null;
}

/**
 * Reclassifies a cabinet already in the inventory.
 *
 * **Deliberately does not touch any booking.** A live booking snapshotted its
 * own `safeSize` and `hourlyRatePaise` at creation, so correcting a mislabelled
 * shelf cannot retroactively change what a renter is recorded as having booked
 * or what they were charged — the same property that stops an env change
 * re-pricing a running rental. The new size applies to the *next* booking.
 *
 * Which is why this is allowed while a safe is occupied: the alternative is an
 * admin unable to fix a data-entry error for up to 24 hours, and there is
 * nothing to protect by refusing.
 */
export async function updateDeviceSize(
  deviceId: string,
  size: SafeSize,
): Promise<AdminDeviceRow> {
  const existing = await prisma.device.findUnique({
    where: { id: deviceId },
    select: { id: true, status: true },
  });

  if (!existing) throw notFound('No safe with that id.');

  /**
   * A retired safe is off the fleet and will never be booked again, so
   * reclassifying one is a write with no effect — and accepting it would let
   * the inventory list imply retired stock is being kept current.
   */
  if (existing.status === 'RETIRED') {
    throw conflict(
      ERROR_CODES.DEVICE_NOT_OPERABLE,
      'This safe has been retired. Its size can no longer be changed.',
    );
  }

  const device = await prisma.device.update({
    where: { id: deviceId },
    data: { size },
    select: ADMIN_DEVICE_SELECT,
  });

  return toAdminDeviceRow(device);
}

/**
 * Bulk import, reported per row.
 *
 * One bad line must not reject a 400-row paste, so each row is validated and
 * reported individually. Serials are normalised (trimmed, uppercased) before
 * both the duplicate check and insertion, so `safe-0001` and `SAFE-0001`
 * collide as the same device rather than creating two.
 */
export async function bulkCreateDevices(
  rawSerials: string[],
  size: SafeSize,
): Promise<BulkCreateResult> {
  if (rawSerials.length > BULK_CREATE_MAX_ROWS) {
    // Also enforced by the zod schema; kept here so a direct service call
    // cannot bypass the cap.
    throw new HttpError({
      status: 400,
      code: ERROR_CODES.VALIDATION_ERROR,
      message: `Too many rows: at most ${BULK_CREATE_MAX_ROWS} serial numbers per request.`,
    });
  }

  const results: BulkCreateRowResult[] = [];
  const valid: string[] = [];
  /** Catches duplicates *within* the submitted list, not just against the DB. */
  const seen = new Set<string>();

  rawSerials.forEach((raw, index) => {
    const row = index + 1;
    const parsed = serialNumberSchema.safeParse(raw);

    if (!parsed.success) {
      results.push({
        row,
        serialNumber: normaliseSerial(raw),
        status: 'invalid',
        message: parsed.error.issues[0]?.message ?? 'Invalid serial number',
      });
      return;
    }

    const serialNumber = parsed.data;

    if (seen.has(serialNumber)) {
      results.push({
        row,
        serialNumber,
        status: 'duplicate',
        message: 'Repeated in this list',
      });
      return;
    }

    seen.add(serialNumber);
    valid.push(serialNumber);
    results.push({ row, serialNumber, status: 'created' });
  });

  // Which of the valid serials already exist in the inventory.
  const existing = valid.length
    ? await prisma.device.findMany({
        where: { serialNumber: { in: valid } },
        select: { serialNumber: true },
      })
    : [];
  const existingSerials = new Set(existing.map((device) => device.serialNumber));

  const toInsert: string[] = [];
  for (const result of results) {
    if (result.status !== 'created') continue;

    if (existingSerials.has(result.serialNumber)) {
      result.status = 'duplicate';
      result.message = 'Already in the inventory';
      continue;
    }
    toInsert.push(result.serialNumber);
  }

  if (toInsert.length) {
    // skipDuplicates covers the narrow race where another admin inserts the
    // same serial between the check above and this write.
    await prisma.device.createMany({
      data: toInsert.map((serialNumber) => ({ serialNumber, size })),
      skipDuplicates: true,
    });
  }

  return {
    created: results.filter((row) => row.status === 'created').length,
    duplicates: results.filter((row) => row.status === 'duplicate').length,
    invalid: results.filter((row) => row.status === 'invalid').length,
    results,
  };
}

/**
 * Paginated inventory list.
 *
 * `q` goes through Prisma's parameterised `contains` filter — it is never
 * interpolated into SQL. Its length is capped by the query schema.
 */
export async function listDevices(query: ListDevicesQuery): Promise<Paginated<AdminDeviceRow>> {
  const where = {
    ...(query.status ? { status: query.status } : {}),
    // Serial only: there is no owner to search by any more. A safe's renter
    // is found through the bookings list instead.
    ...(query.q
      ? { serialNumber: { contains: query.q, mode: 'insensitive' as const } }
      : {}),
  };

  const [total, rows] = await Promise.all([
    prisma.device.count({ where }),
    prisma.device.findMany({
      where,
      select: ADMIN_DEVICE_SELECT,
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
  ]);

  // One clock reading for the whole page, so two rows cannot disagree about
  // whether the same moment counts as offline.
  const now = new Date();

  return {
    items: rows.map((row) => toAdminDeviceRow(row, now)),
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
  };
}

/**
 * The last few commands for one device, newest first.
 *
 * The §7 expander. Capped rather than paginated: an admin opening this is
 * asking "what has this safe been doing lately", and a page-2 button on a
 * diagnostic panel is a page nobody clicks. The whole history is in the audit
 * log for the rare case that matters.
 *
 * `ADMIN_COMMAND_SELECT` is an explicit allow-list like every other admin
 * read, and note what it leaves out: `seq`. A sequence number is not a secret,
 * but it is an input to a signed canonical string, and the rule here is that
 * nothing feeding a signature is serialised to a client.
 */
export async function listDeviceCommands(deviceId: string): Promise<AdminCommandRow[]> {
  const device = await prisma.device.findUnique({
    where: { id: deviceId },
    select: { id: true },
  });
  if (!device) throw deviceNotFound();

  const commands = await prisma.command.findMany({
    where: { deviceId },
    orderBy: { issuedAt: 'desc' },
    take: ADMIN_COMMAND_HISTORY_LIMIT,
    select: ADMIN_COMMAND_SELECT,
  });

  return commands.map(toAdminCommandRow);
}
