import type { PaymentStatus } from './payments';
import type { UserRole } from './auth';
import type { BookingStatus, PaymentPurpose, PaymentReviewReason } from './bookings';

/**
 * Mirrors the Prisma `DeviceStatus` enum.
 *
 * `ASSIGNED` is gone with the purchase model — nobody owns a safe, and
 * occupancy is a property of its bookings rather than a column. What replaced
 * it is `NEEDS_INSPECTION`, which is **not** the same thing: it means a booking
 * ended without the renter confirming they took their belongings, so the safe
 * must not be rented again until a human has looked inside it.
 */
export type DeviceStatus = 'AVAILABLE' | 'NEEDS_INSPECTION' | 'RETIRED';

/** Mirrors the Prisma `LockState` enum. `UNKNOWN` until hardware reports in. */
export type LockState = 'LOCKED' | 'UNLOCKED' | 'UNKNOWN';

/**
 * The device as its current renter sees it.
 *
 * Note what is absent: `credentialHash` and anything about ownership. The
 * hardware credential is never serialised to any client, and there is no owner
 * — which safe a user may operate is decided by their booking, not by a column
 * on the device.
 */
export interface DeviceSummary {
  id: string;
  serialNumber: string;
  lockState: LockState;
  /** ISO timestamp of the last confirmed lock-state change, or null. */
  lockStateUpdatedAt: string | null;
  online: boolean;
  /** ISO timestamp of the last device heartbeat, or null if never seen. */
  lastSeenAt: string | null;
}

/**
 * Response body of `GET /devices/mine`.
 *
 * Null when the caller has no live booking. There is no "waiting for
 * allocation" state any more: paying for a booking *is* getting a safe.
 */
export interface MyDeviceResponse {
  device: DeviceSummary | null;
}

// --- Lock / unlock -----------------------------------------------------------

/**
 * A recorded lock/unlock event. Append-only and user-visible — this is what
 * the `/history` page will read.
 *
 * `UNLOCK_REQUESTED` means a code was sent, not that anything opened.
 * `UNLOCK_FAILED` covers a wrong, expired or exhausted code.
 */
export type DeviceEventType = 'LOCK' | 'UNLOCK_REQUESTED' | 'UNLOCK_CONFIRMED' | 'UNLOCK_FAILED';

/** Where a device event originated. Only the web app for now. */
export type DeviceEventSource = 'WEB';

/** Response body of `POST /devices/lock`. */
export interface LockResponse {
  device: DeviceSummary;
  /**
   * True when the safe was already locked and no command was sent. Locking is
   * idempotent, so this is a success, not an error — the UI can say
   * "already locked" rather than claiming it just locked it.
   */
  alreadyLocked: boolean;
}

/**
 * Response body of `POST /devices/unlock/request`.
 *
 * Carries no code and nothing derived from one — only when it expires and how
 * many tries the user gets.
 */
export interface UnlockRequestResponse {
  /** ISO timestamp the challenge expires at. */
  expiresAt: string;
  /** Seconds until expiry, so a client with a skewed clock still counts down. */
  expiresInSeconds: number;
  /** Attempts allowed against this challenge before it is invalidated. */
  attemptsAllowed: number;
  /** Seconds the client should disable "Resend" for. */
  resendAfterSeconds: number;
}

/** Response body of `POST /devices/unlock/confirm`. */
export interface UnlockConfirmResponse {
  device: DeviceSummary;
}

/**
 * The device as an admin sees it — adds inventory state and who holds it now.
 *
 * `currentBooking` replaces the old `owner`/`allocatedAt` pair. The difference
 * is not cosmetic: a safe has a renter for a bounded period rather than an
 * owner, so the useful question is "who has it and until when", which is a
 * property of a booking.
 */
export interface AdminDeviceRow {
  id: string;
  serialNumber: string;
  status: DeviceStatus;
  lockState: LockState;
  lockStateUpdatedAt: string | null;
  online: boolean;
  lastSeenAt: string | null;
  createdAt: string;
  /** The live booking occupying this safe, or null when it is free. */
  currentBooking: DeviceCurrentBooking | null;
  /**
   * Why this safe is awaiting inspection. Set with the status and shown in the
   * flagged list, so an admin knows what to look for before opening it.
   */
  inspectionNote: string | null;
  inspectionNotedAt: string | null;
}

/** The occupying booking, as shown on a device or user row. */
export interface DeviceCurrentBooking {
  id: string;
  status: BookingStatus;
  effectiveStatus: BookingStatus;
  endsAt: string | null;
  user: { id: string; name: string; email: string };
}

/**
 * The user as an admin sees them.
 *
 * Deliberately the complete list of what admin tooling may see: no password
 * hash, no refresh token data, nothing else. Enforced by an explicit Prisma
 * `select` and asserted by a recursive no-hash test.
 *
 * `hasPaid`, `deviceSerial` and `refundedWithDevice` are gone: all three were
 * answers to "has this account been activated and does it hold hardware",
 * which is not a question the rental model has. `currentBooking` answers the
 * one that replaced it — what this user has out right now, and in what state.
 */
export interface AdminUserRow {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: UserRole;
  createdAt: string;
  phoneVerified: boolean;
  /** The user's live booking, or null. */
  currentBooking: UserCurrentBooking | null;
}

/** A user's live booking, as shown on the admin Users tab. */
export interface UserCurrentBooking {
  id: string;
  status: BookingStatus;
  effectiveStatus: BookingStatus;
  serialNumber: string;
  endsAt: string | null;
  /** Non-zero when this user owes an overstay fee. Flags the row. */
  overstayFeePaise: number;
}

export interface AdminPaymentRow {
  id: string;
  amount: number;
  currency: string;
  status: PaymentStatus;
  razorpayOrderId: string;
  createdAt: string;
  paidAt: string | null;
  user: { id: string; name: string; email: string } | null;
  purpose: PaymentPurpose;
  bookingId: string | null;
  /**
   * Set when this money could not be applied to its booking.
   *
   * The row stays `PAID` — we never rewrite a payment to pretend it did not
   * happen — and appears in the admin "needs refund" list until an admin
   * refunds it by hand and clears the flag with a note.
   */
  reviewReason: PaymentReviewReason | null;
  reviewClearedAt: string | null;
}

export interface AdminAuditRow {
  id: string;
  action: string;
  userId: string | null;
  deviceId: string | null;
  ip: string | null;
  userAgent: string | null;
  metadata: unknown;
  createdAt: string;
}

/** Standard envelope for every paginated admin list. */
export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/** Outcome for one row of a bulk device import. */
export interface BulkCreateRowResult {
  /** 1-based position in the submitted list, so the UI can point at a line. */
  row: number;
  /** The normalised serial, or the raw input when it could not be normalised. */
  serialNumber: string;
  status: 'created' | 'duplicate' | 'invalid';
  /** Why it was rejected. Absent for `created`. */
  message?: string;
}

export interface BulkCreateResult {
  created: number;
  duplicates: number;
  invalid: number;
  results: BulkCreateRowResult[];
}
