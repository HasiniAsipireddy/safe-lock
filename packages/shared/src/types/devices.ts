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
  online: boolean;
  /** ISO timestamp of the last device heartbeat, or null if never seen. */
  lastSeenAt: string | null;
  allocatedAt: string | null;
}

/** Response body of `GET /devices/mine`. */
export interface MyDeviceResponse {
  device: DeviceSummary | null;
}

/** The device as an admin sees it — adds inventory state and the owner. */
export interface AdminDeviceRow {
  id: string;
  serialNumber: string;
  status: DeviceStatus;
  lockState: LockState;
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
