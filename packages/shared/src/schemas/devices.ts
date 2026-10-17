import { z } from 'zod';

/**
 * Device and admin request schemas.
 *
 * The serial format and the normalisation rule live here and nowhere else, so
 * the web form, the API and the bulk importer cannot disagree about what a
 * valid serial is.
 */

/**
 * Safe lock serial number format. **Provisional** — see docs/decisions.md.
 * Example: `SAFE-0001`, `SAFE-A1B2C3`.
 */
export const SERIAL_NUMBER_REGEX = /^SAFE-[0-9A-Z]{4,12}$/;

export const SERIAL_NUMBER_HINT = 'Serial must look like SAFE-0001 (4-12 digits/capitals)';

/** Largest number of rows one bulk-create request may carry. */
export const BULK_CREATE_MAX_ROWS = 500;

/** Admin list pagination. */
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/** Longest accepted free-text search term on admin lists. */
export const MAX_SEARCH_LENGTH = 100;

/**
 * A serial number, normalised then validated.
 *
 * Trim and uppercase happen **before** the regex check, so `" safe-0001 "` and
 * `"SAFE-0001"` both parse to the same stored value and cannot become two
 * devices for one physical safe.
 */
export const serialNumberSchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(1, 'Serial number is required')
  .max(32, 'Serial number is too long')
  .regex(SERIAL_NUMBER_REGEX, SERIAL_NUMBER_HINT);

/** Normalises a serial without asserting validity — for per-row bulk reports. */
export function normaliseSerial(raw: string): string {
  return raw.trim().toUpperCase();
}

// --- Admin write bodies ------------------------------------------------------

export const createDeviceSchema = z
  .object({
    serialNumber: serialNumberSchema,
  })
  .strict();

export const bulkCreateDevicesSchema = z
  .object({
    /**
     * Raw, unvalidated serials. Each row is reported on individually, so one
     * bad line does not reject the whole import — hence `z.string()` here
     * rather than `serialNumberSchema`.
     */
    serialNumbers: z
      .array(z.string().max(64, 'Serial number is too long'))
      .min(1, 'Provide at least one serial number')
      .max(
        BULK_CREATE_MAX_ROWS,
        `Too many rows: at most ${BULK_CREATE_MAX_ROWS} serial numbers per request`,
      ),
  })
  .strict();

/** `POST /admin/devices/:id/retire` takes no body. */
export const emptyBodySchema = z.object({}).strict();

// --- Unlock OTP --------------------------------------------------------------

/**
 * OTP parameters, defined once so the API, the UI copy and the countdown
 * cannot disagree about them. Rationale in docs/decisions.md.
 */
export const OTP_LENGTH = 6;
/** 5 minutes. Long enough to read a message, short enough to matter. */
export const OTP_TTL_MS = 5 * 60 * 1000;
/** Wrong guesses allowed before the challenge is invalidated outright. */
export const OTP_MAX_ATTEMPTS = 5;
/** How long the UI disables "Resend" after a code is sent. */
export const OTP_RESEND_COOLDOWN_SECONDS = 30;

/**
 * A submitted one-time code.
 *
 * Exactly six digits, with spaces and dashes stripped first so a pasted
 * `123 456` is accepted. The length check is on the cleaned value, so padding
 * cannot be used to smuggle a longer string through.
 */
export const otpSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/[\s-]/g, ''))
  .pipe(
    z
      .string()
      .regex(new RegExp(`^\\d{${OTP_LENGTH}}$`), `Enter the ${OTP_LENGTH}-digit code`),
  );

/** Body of `POST /devices/unlock/confirm`. */
export const confirmUnlockSchema = z
  .object({
    otp: otpSchema,
  })
  .strict();

export type ConfirmUnlockInput = z.infer<typeof confirmUnlockSchema>;

// --- Admin list queries ------------------------------------------------------

const pageSchema = z.coerce.number().int().min(1).default(1);
const pageSizeSchema = z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE);

/**
 * Free-text search.
 *
 * Capped at {@link MAX_SEARCH_LENGTH}. It is always applied through Prisma's
 * parameterised `contains` filters — never interpolated into SQL.
 */
const searchSchema = z
  .string()
  .trim()
  .max(MAX_SEARCH_LENGTH, `Search term must be at most ${MAX_SEARCH_LENGTH} characters`)
  .optional();

export const deviceStatusFilterSchema = z
  .enum(['AVAILABLE', 'NEEDS_INSPECTION', 'RETIRED'])
  .optional();

/** Tri-state filters: absent means "don't filter". */
const booleanFilterSchema = z
  .enum(['true', 'false'])
  .optional()
  .transform((value) => (value === undefined ? undefined : value === 'true'));

export const listDevicesQuerySchema = z.object({
  status: deviceStatusFilterSchema,
  /** Only safes that are occupied by a live booking right now. */
  occupied: booleanFilterSchema,
  q: searchSchema,
  page: pageSchema,
  pageSize: pageSizeSchema,
});

export const listUsersQuerySchema = z.object({
  /** Only users holding a live booking. Replaces the old paid/allocated pair. */
  booked: booleanFilterSchema,
  q: searchSchema,
  page: pageSchema,
  pageSize: pageSizeSchema,
});

export const listPaymentsQuerySchema = z.object({
  status: z.enum(['CREATED', 'PAID', 'FAILED', 'REFUNDED']).optional(),
  purpose: z.enum(['BOOKING', 'EXTENSION', 'OVERSTAY']).optional(),
  /**
   * Only payments awaiting a manual refund.
   *
   * This is the list an admin works through: money we took and could not
   * apply. Flagged rows must not be findable only by scrolling.
   */
  needsReview: booleanFilterSchema,
  page: pageSchema,
  pageSize: pageSizeSchema,
});

export const listAuditQuerySchema = z.object({
  action: z.string().trim().max(MAX_SEARCH_LENGTH).optional(),
  page: pageSchema,
  pageSize: pageSizeSchema,
});

export type CreateDeviceInput = z.infer<typeof createDeviceSchema>;
export type BulkCreateDevicesInput = z.infer<typeof bulkCreateDevicesSchema>;
export type ListDevicesQuery = z.infer<typeof listDevicesQuerySchema>;
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
export type ListPaymentsQuery = z.infer<typeof listPaymentsQuerySchema>;
export type ListAuditQuery = z.infer<typeof listAuditQuerySchema>;
