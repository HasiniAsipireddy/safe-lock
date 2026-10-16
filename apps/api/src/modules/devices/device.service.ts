import {
  BULK_CREATE_MAX_ROWS,
  ERROR_CODES,
  type AdminDeviceRow,
  type BulkCreateResult,
  type BulkCreateRowResult,
  type DeviceSummary,
  type ListDevicesQuery,
  type Paginated,
  normaliseSerial,
  serialNumberSchema,
} from '@safelock/shared';
import { prisma } from '../../lib/prisma';
import type { PrismaTransaction } from '../../lib/prisma';
import { HttpError, conflict, notFound } from '../../lib/httpError';
import { userHasPaid } from '../users/user.mapper';
import {
  ADMIN_DEVICE_SELECT,
  DEVICE_SUMMARY_SELECT,
  toAdminDeviceRow,
  toDeviceSummary,
} from './device.mapper';

/**
 * Device inventory and allocation.
 *
 * {@link allocateDevice} is deliberately the **only** place a device becomes
 * owned. The admin endpoint calls it today; the payment webhook will call the
 * same function for auto-allocation, so the paid / one-per-user / availability
 * rules cannot drift between the two paths.
 */

// --- Errors ------------------------------------------------------------------

const notPaid = () =>
  new HttpError({
    status: 402,
    code: ERROR_CODES.NOT_PAID,
    message: 'This user has no verified payment, so no safe can be allocated.',
  });

const alreadyHasDevice = () =>
  conflict(
    ERROR_CODES.ALREADY_HAS_DEVICE,
    'This user already has a safe allocated. Unassign it first.',
  );

const deviceNotAvailable = (status: string) =>
  conflict(
    ERROR_CODES.DEVICE_NOT_AVAILABLE,
    `That safe is ${status.toLowerCase()}, so it cannot be allocated.`,
  );

const noStock = () =>
  conflict(
    ERROR_CODES.NO_DEVICES_IN_STOCK,
    'No unassigned safes left in stock. Add more devices to the inventory.',
  );

const userNotFound = () =>
  new HttpError({
    status: 404,
    code: ERROR_CODES.USER_NOT_FOUND,
    message: 'No user with that id.',
  });

function isUniqueViolation(error: unknown): boolean {
  // Duck-typed: Prisma's error classes have moved between major versions, and
  // a missed import would silently turn a safe conflict into a 500.
  return (error as { code?: string } | null)?.code === 'P2002';
}

// --- Allocation --------------------------------------------------------------

export interface AllocationResult {
  device: AdminDeviceRow;
}

/**
 * Allocates a safe to a user.
 *
 * Preconditions, all checked inside one transaction:
 * - the user exists (404 `USER_NOT_FOUND` rather than a foreign-key error),
 * - the user has a `PAID` payment (the same `userHasPaid` rule `requirePaid`
 *   uses, so the middleware and this service cannot disagree),
 * - the user holds no device,
 * - the device is `UNASSIGNED`.
 *
 * With no `deviceId`, the oldest `UNASSIGNED` device is picked with
 * `SELECT … FOR UPDATE SKIP LOCKED`. That is the one raw query in this module:
 * two admins allocating at the same moment each lock a different row and skip
 * the other's, instead of both reading the same "next" device and one failing.
 *
 * `Device.ownerId` is additionally `UNIQUE`, so even if a check were bypassed
 * the database refuses a second device per user; that violation is translated
 * back into `ALREADY_HAS_DEVICE`.
 */
export async function allocateDevice(
  userId: string,
  deviceId?: string,
): Promise<AllocationResult> {
  try {
    const device = await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true },
      });
      if (!user) throw userNotFound();

      if (!(await userHasPaid(userId, tx))) throw notPaid();

      const existing = await tx.device.findUnique({
        where: { ownerId: userId },
        select: { id: true },
      });
      if (existing) throw alreadyHasDevice();

      const targetId = deviceId ?? (await pickNextUnassignedId(tx));

      if (deviceId) {
        const candidate = await tx.device.findUnique({
          where: { id: deviceId },
          select: { id: true, status: true },
        });
        if (!candidate) throw notFound('No safe with that id.');
        if (candidate.status !== 'UNASSIGNED') throw deviceNotAvailable(candidate.status);
      }

      // Conditional update: the `status` precondition is part of the WHERE, so
      // a device claimed between the check above and here cannot be stolen.
      const claimed = await tx.device.updateMany({
        where: { id: targetId, status: 'UNASSIGNED', ownerId: null },
        data: {
          status: 'ASSIGNED',
          ownerId: userId,
          allocatedAt: new Date(),
          // A safe is handed over locked, and an owned device must never be
          // UNKNOWN — the dashboard has no controls to offer in that state.
          // `lockStateUpdatedAt` stays null: this is an assertion about a unit
          // being shipped, not a state the hardware has confirmed.
          lockState: 'LOCKED',
          lockStateUpdatedAt: null,
        },
      });

      if (claimed.count !== 1) throw deviceNotAvailable('ASSIGNED');

      return tx.device.findUniqueOrThrow({
        where: { id: targetId },
        select: ADMIN_DEVICE_SELECT,
      });
    });

    return { device: toAdminDeviceRow(device) };
  } catch (error) {
    if (isUniqueViolation(error)) throw alreadyHasDevice();
    throw error;
  }
}

/**
 * Oldest `UNASSIGNED` device id, row-locked for the rest of the transaction.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes concurrent allocation correct: a
 * second transaction skips the locked row and takes the next one rather than
 * blocking on it or colliding.
 *
 * This is raw SQL because Prisma has no row-locking API. It takes **no
 * interpolated input** — there is nothing here for a caller to influence.
 */
async function pickNextUnassignedId(tx: PrismaTransaction): Promise<string> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "Device"
    WHERE "status" = 'UNASSIGNED' AND "ownerId" IS NULL
    ORDER BY "createdAt" ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  `;

  const next = rows[0];
  if (!next) throw noStock();
  return next.id;
}

// --- Unassign / retire -------------------------------------------------------

export interface DeviceMutationResult {
  device: AdminDeviceRow;
  /** The user who held the device before this change, if any. */
  previousOwnerId: string | null;
}

/**
 * Returns a device to stock.
 *
 * Also the route out of the refunded-but-still-holding state: the payment and
 * the hardware are separate facts, so reclaiming the device is an explicit
 * admin action rather than a side effect of a refund webhook.
 */
export async function unassignDevice(deviceId: string): Promise<DeviceMutationResult> {
  const result = await prisma.$transaction(async (tx) => {
    const current = await tx.device.findUnique({
      where: { id: deviceId },
      select: { id: true, status: true, ownerId: true },
    });
    if (!current) throw notFound('No safe with that id.');

    if (current.status !== 'ASSIGNED' || current.ownerId === null) {
      throw conflict(
        ERROR_CODES.DEVICE_NOT_AVAILABLE,
        'That safe is not currently assigned to anyone.',
      );
    }

    const device = await tx.device.update({
      where: { id: deviceId },
      data: {
        status: 'UNASSIGNED',
        ownerId: null,
        allocatedAt: null,
        // The lock state of a safe nobody owns is not something we know — it
        // is in transit, in a cupboard, or in someone's hands.
        lockState: 'UNKNOWN',
        lockStateUpdatedAt: null,
      },
      select: ADMIN_DEVICE_SELECT,
    });

    return { device, previousOwnerId: current.ownerId };
  });

  return { device: toAdminDeviceRow(result.device), previousOwnerId: result.previousOwnerId };
}

/**
 * Takes a device permanently out of service.
 *
 * Refuses while the device is `ASSIGNED`: retiring hardware out of someone's
 * hands would leave a user believing they still have a working safe. Unassign
 * first, deliberately.
 */
export async function retireDevice(deviceId: string): Promise<DeviceMutationResult> {
  const result = await prisma.$transaction(async (tx) => {
    const current = await tx.device.findUnique({
      where: { id: deviceId },
      select: { id: true, status: true, ownerId: true },
    });
    if (!current) throw notFound('No safe with that id.');

    if (current.status === 'ASSIGNED') {
      throw conflict(
        ERROR_CODES.DEVICE_STILL_ASSIGNED,
        'That safe is still assigned to a user. Unassign it before retiring it.',
      );
    }

    if (current.status === 'RETIRED') {
      throw conflict(ERROR_CODES.DEVICE_NOT_AVAILABLE, 'That safe is already retired.');
    }

    const device = await tx.device.update({
      where: { id: deviceId },
      data: { status: 'RETIRED', ownerId: null, allocatedAt: null, online: false },
      select: ADMIN_DEVICE_SELECT,
    });

    return { device, previousOwnerId: current.ownerId };
  });

  return { device: toAdminDeviceRow(result.device), previousOwnerId: result.previousOwnerId };
}

// --- Inventory ---------------------------------------------------------------

/** Creates one device. Serial is normalised by the schema before it gets here. */
export async function createDevice(serialNumber: string): Promise<AdminDeviceRow> {
  try {
    const device = await prisma.device.create({
      data: { serialNumber },
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

/**
 * Bulk import, reported per row.
 *
 * One bad line must not reject a 400-row paste, so each row is validated and
 * reported individually. Serials are normalised (trimmed, uppercased) before
 * both the duplicate check and insertion, so `safe-0001` and `SAFE-0001`
 * collide as the same device rather than creating two.
 */
export async function bulkCreateDevices(rawSerials: string[]): Promise<BulkCreateResult> {
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
      data: toInsert.map((serialNumber) => ({ serialNumber })),
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
    ...(query.q
      ? {
          OR: [
            { serialNumber: { contains: query.q, mode: 'insensitive' as const } },
            { owner: { name: { contains: query.q, mode: 'insensitive' as const } } },
            { owner: { email: { contains: query.q, mode: 'insensitive' as const } } },
          ],
        }
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

  return {
    items: rows.map(toAdminDeviceRow),
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
  };
}

/** The device a user owns, or null. Ownership is the `ownerId` lookup itself. */
export async function getDeviceForUser(userId: string): Promise<DeviceSummary | null> {
  const device = await prisma.device.findUnique({
    where: { ownerId: userId },
    select: DEVICE_SUMMARY_SELECT,
  });

  return device ? toDeviceSummary(device) : null;
}

// NOTE: "does this user hold a device" lives in `users/user.mapper.ts`
// (`userHasDevice`), not here. This module already imports `userHasPaid` from
// there, and putting the reverse lookup here too would make the two modules
// circularly dependent.
