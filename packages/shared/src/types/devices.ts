import type { PaymentStatus } from './payments';
import type { UserRole } from './auth';

/** Mirrors the Prisma `DeviceStatus` enum. */
export type DeviceStatus = 'UNASSIGNED' | 'ASSIGNED' | 'RETIRED';

/** Mirrors the Prisma `LockState` enum. `UNKNOWN` until hardware reports in. */
export type LockState = 'LOCKED' | 'UNLOCKED' | 'UNKNOWN';

/**
 * The device as its owner sees it.
 *
 * Note what is absent: `credentialHash` and `ownerId`. The hardware credential
 * is never serialised to any client, and a user learning their own id from a
 * device payload serves no purpose.
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
  allocatedAt: string | null;
}

/** Response body of `GET /devices/mine`. */
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

/** The device as an admin sees it — adds inventory state and the owner. */
export interface AdminDeviceRow {
  id: string;
  serialNumber: string;
  status: DeviceStatus;
  lockState: LockState;
  lockStateUpdatedAt: string | null;
  online: boolean;
  lastSeenAt: string | null;
  allocatedAt: string | null;
  createdAt: string;
  owner: { id: string; name: string; email: string } | null;
}

/**
 * The user as an admin sees them.
 *
 * Deliberately the complete list of what admin tooling may see: no password
 * hash, no refresh token data, nothing else. Enforced by an explicit Prisma
 * `select` and asserted by a recursive no-hash test.
 */
export interface AdminUserRow {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: UserRole;
  createdAt: string;
  hasPaid: boolean;
  /** Serial of the device they hold, or null. */
  deviceSerial: string | null;
  /**
   * True when the user's payment was refunded but they still hold a device.
   * Surfaced prominently so an admin can reclaim the hardware — see
   * docs/decisions.md on why this is not automatic.
   */
  refundedWithDevice: boolean;
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
