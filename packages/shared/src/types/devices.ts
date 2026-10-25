import type { PaymentStatus } from './payments';
import type { UserRole } from './auth';
import type {
  BookingStatus,
  PaymentPurpose,
  PaymentReviewReason,
  SafeSize,
} from './bookings';
import type {
  CommandActor,
  CommandFailureCategory,
  CommandStatus,
  CommandType,
  DoorState,
} from './commands';

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
  /**
   * How big this cabinet is.
   *
   * Shown on the dashboard beside the serial, because a renter looking at
   * "your safe" should be able to confirm they were given what they booked —
   * and because a booking's `safeSize` is a snapshot, the two disagreeing is
   * exactly the kind of thing worth being able to see.
   */
  size: SafeSize;
  lockState: LockState;
  /** ISO timestamp of the last confirmed lock-state change, or null. */
  lockStateUpdatedAt: string | null;
  /**
   * Whether we can reach the safe right now.
   *
   * **Derived on read** from the age of the last verified device message, not
   * served from a stored boolean — a retained status flag is a claim about a
   * moment, and the question the dashboard is asking is about now. False
   * disables the controls with a reason rather than letting someone tap a
   * button that cannot work.
   */
  online: boolean;
  /** ISO timestamp of the last device heartbeat, or null if never seen. */
  lastSeenAt: string | null;
  /**
   * Whether the door is shut, as last measured by the safe's own sensor.
   *
   * Separate from `lockState` because a bolt can be extended with the door
   * standing open, and a renter is entitled to know the difference. `UNKNOWN`
   * means the sensor did not report — a fault, never "no sensor fitted".
   */
  doorState: DoorState;
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

/**
 * There is no `LockResponse` or `UnlockConfirmResponse` any more.
 *
 * Both returned a `DeviceSummary`, which was honest while a mock gateway acked
 * in process and became a lie the moment a radio was involved: the bolt has
 * not moved when the request returns. They are replaced by
 * `CommandAcceptedResponse` (202, a command id) plus `CommandStatusResponse`
 * from polling — see `types/commands.ts`.
 *
 * Deleted rather than deprecated, deliberately. A type describing a contract
 * the API no longer honours is worse than a missing one: it compiles.
 */

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
  /** How big this cabinet is, and therefore which price list it is rented at. */
  size: SafeSize;
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

  // --- What the hardware reports about itself. Diagnostics, not authority. ---

  firmwareVersion: string | null;
  /**
   * Wi-Fi signal strength in dBm, or null if never reported.
   *
   * Shown because a metal safe is a Faraday cage and the most likely field
   * failure is a unit on the edge of range — a number in a list is an order of
   * magnitude cheaper to act on than a site visit.
   */
  rssi: number | null;
  /**
   * Whether the device's clock synced. Gates nothing: replay protection comes
   * from the sequence number, so a device with no time source still operates
   * normally. Shown so a fleet-wide SNTP problem is visible.
   */
  clockSynced: boolean | null;
  /** Whether a credential has been issued. Never the credential itself. */
  credentialIssued: boolean;
  credentialIssuedAt: string | null;
  /** Set when a system lock exhausted its retries without an ack. */
  lockCommandFailedAt: string | null;
  /**
   * Why this device needs attention, as a closed set. Empty for a healthy one.
   *
   * Surfaced the way the Bookings tab already opens on "needs attention": a
   * safe somebody has paid for and we cannot reach must not require scrolling
   * to discover.
   */
  flags: DeviceFlag[];
}

/**
 * Why a device is flagged.
 *
 * A closed enum rather than a message so the UI owns the wording and the API
 * owns the fact — and so a new reason cannot be added without a decision about
 * how it reads.
 */
export type DeviceFlag =
  /** Offline while somebody holds a live booking on it. They have paid. */
  | 'OFFLINE_WITH_BOOKING'
  /** `COMMAND_FAILURE_FLAG_THRESHOLD` consecutive failed or timed-out commands. */
  | 'CONSECUTIVE_COMMAND_FAILURES'
  /** A system lock exhausted its retries. The safe may be standing open. */
  | 'LOCK_COMMAND_FAILED'
  /** Reported `UNLOCKED` with no booking entitled to have it open (§8.3). */
  | 'UNEXPECTED_UNLOCKED'
  /** The door sensor is not reporting. Units ship with one; this is a fault. */
  | 'DOOR_STATE_UNKNOWN';

/**
 * One row of a device's recent-commands expander.
 *
 * Carries no signature, no sequence number and no signing input. A sequence
 * number is not a secret, but it is an input to a signed canonical string, and
 * the rule for this codebase is that nothing feeding a signature is serialised
 * to a client — the same discipline that keeps `credentialHash` out of every
 * `select`.
 */
export interface AdminCommandRow {
  id: string;
  type: CommandType;
  status: CommandStatus;
  failureCategory: CommandFailureCategory | null;
  /** `'USER'` when a person asked, otherwise which system actor did. */
  actor: CommandActor | 'USER';
  issuedAt: string;
  /** Milliseconds from publish to ack, or null if it never acked. */
  latencyMs: number | null;
  lateAcked: boolean;
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

/**
 * Response body of `POST /admin/devices/:id/credential`. **Shown once.**
 *
 * The only place in this API where a secret is returned to a caller, and the
 * reason is physical: a unit has to be *given* its identity before it can
 * speak, and there is no channel to a device that does not yet have one. So
 * the secrets are minted, returned exactly once, and only a `sha256` of the
 * password is kept. There is no endpoint that reads one back, and re-issuing
 * mints a new pair rather than revealing the old.
 *
 * The client's obligation is the other half of "once": display it for
 * provisioning and never store it. It is deliberately not in
 * {@link AdminDeviceRow}, so the device list cannot carry it by accident.
 */
export interface DeviceCredentialResponse {
  deviceId: string;
  /** Also the MQTT username and client id. One identity, no lookup table. */
  serialNumber: string;
  /** The broker password, in full, for the only time it exists in readable form. */
  password: string;
  /**
   * The device's command key `K_d`, base64url.
   *
   * Derived from one server-side master secret and the serial, never stored —
   * so this response is the only way it can be handed to an installer, and a
   * database leak yields no device key because no device key is in the
   * database.
   */
  commandKey: string;
  /** Which `K_d` version the device is being provisioned at. */
  keyVersion: number;
  issuedAt: string;
  /**
   * True when this device already had a credential.
   *
   * A re-issue is also a **revocation**: the previous password stops working
   * the moment the broker is updated, and a unit in the field that was not
   * re-provisioned goes silent. The UI says so before the button is pressed.
   */
  reissued: boolean;
}

/**
 * What each device flag means, in a sentence an admin can act on.
 *
 * Here rather than in the panel for the reason `NOTIFICATION_COPY` is: the API
 * owns the fact and the wording is a product decision, so a new flag cannot be
 * added without someone deciding how it reads. `action` is the part that makes
 * the flag worth having — a list of problems with no suggested next step is a
 * list people stop opening.
 */
export const DEVICE_FLAG_COPY: Record<DeviceFlag, { label: string; action: string }> = {
  OFFLINE_WITH_BOOKING: {
    label: 'Offline with a paid booking',
    action: 'Somebody has paid for this safe and we cannot reach it. Check power and Wi-Fi first.',
  },
  CONSECUTIVE_COMMAND_FAILURES: {
    label: 'Several commands in a row failed',
    action: 'Open the recent commands below — the failure reasons say whether it is the radio or the mechanism.',
  },
  LOCK_COMMAND_FAILED: {
    label: 'Could not be locked',
    action: 'This safe may be standing open. It is out of the pool until someone confirms it is shut.',
  },
  UNEXPECTED_UNLOCKED: {
    label: 'Reported open with nobody entitled to it',
    action: 'A lock was sent automatically. Check it physically — the contents are unaccounted for.',
  },
  DOOR_STATE_UNKNOWN: {
    label: 'Door sensor not reporting',
    action: 'Units ship with a sensor, so this is a fault. The safe cannot be rented until it reports again.',
  },
};
