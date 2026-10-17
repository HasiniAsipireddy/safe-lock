import {
  BULK_CREATE_MAX_ROWS,
  ERROR_CODES,
  type AdminDeviceRow,
  type BulkCreateResult,
  type BulkCreateRowResult,
  type ListDevicesQuery,
  type Paginated,
  normaliseSerial,
  serialNumberSchema,
} from '@safelock/shared';
import { prisma } from '../../lib/prisma';
import { HttpError, conflict, notFound } from '../../lib/httpError';
import { ADMIN_DEVICE_SELECT, toAdminDeviceRow } from './device.mapper';

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

/**
 * Takes a device permanently out of service.
 *
 * Refuses while a booking still occupies it: retiring hardware out of
 * somebody's rental would leave a renter with a safe the system has forgotten.
 * Wait for the booking to end, or force-complete it first.
 */
export async function retireDevice(deviceId: string): Promise<DeviceMutationResult> {
  const device = await prisma.$transaction(async (tx) => {
    const current = await tx.device.findUnique({
      where: { id: deviceId },
      select: { id: true, status: true },
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

    return tx.device.update({
      where: { id: deviceId },
      data: { status: 'RETIRED', online: false },
      select: ADMIN_DEVICE_SELECT,
    });
  });

  return { device: toAdminDeviceRow(device) };
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

  return {
    items: rows.map(toAdminDeviceRow),
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
  };
}
