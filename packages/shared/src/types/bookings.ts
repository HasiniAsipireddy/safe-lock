/**
 * Rental booking types.
 *
 * SafeLock is a **rental** product: a user books a safe for a period, pays,
 * uses it, and collects their items. There is no one-time purchase and no
 * permanent device ownership — see docs/decisions.md.
 */

/**
 * Where a booking is in its life.
 *
 * Six states, and the set is deliberately closed. Note what is **not** here: a
 * separate "collection window" state. An overstay whose fee has been paid is
 * still `OVERSTAY` with `overstaySettledAt` set — the window is a property of
 * the settled overstay, not a seventh state to keep in step.
 */
export type BookingStatus =
  /** Device held, payment not yet captured. Expires at `holdExpiresAt`. */
  | 'PENDING_PAYMENT'
  /** Paid and running. The only state (plus settled OVERSTAY) that unlocks. */
  | 'ACTIVE'
  /** Past `endsAt + grace`. Fees accrue; unlock is refused until they are paid. */
  | 'OVERSTAY'
  | 'COMPLETED'
  /** Cancelled by the user while unpaid. */
  | 'CANCELLED'
  /** The payment hold lapsed. The device was released. */
  | 'EXPIRED_UNPAID';

/** Statuses that hold a device and so participate in the overlap constraint. */
export const OCCUPYING_BOOKING_STATUSES: readonly BookingStatus[] = [
  'PENDING_PAYMENT',
  'ACTIVE',
  'OVERSTAY',
];

export const TERMINAL_BOOKING_STATUSES: readonly BookingStatus[] = [
  'COMPLETED',
  'CANCELLED',
  'EXPIRED_UNPAID',
];

/**
 * How a booking ended — and, crucially, whether the safe can be rented again
 * without a human looking inside it.
 *
 * Only `COLLECTED` is the user telling us they have their belongings. The other
 * two mean the booking ended with the safe's contents **unknown**, which is why
 * they send the device to `NEEDS_INSPECTION` rather than back to the pool. A
 * next renter being handed a safe containing someone else's property — and
 * able to unlock it — is the failure this enum exists to prevent.
 */
export type BookingCompletionReason =
  /** The user pressed "I've collected my items". */
  | 'COLLECTED'
  /** The collection window lapsed with no collect. Contents unknown. */
  | 'COLLECTION_WINDOW_LAPSED'
  /** An admin ended it. Contents unknown unless the admin says otherwise. */
  | 'ADMIN_FORCE_COMPLETED';

/** What a payment is for. One Razorpay order per payment, always. */
export type PaymentPurpose = 'BOOKING' | 'EXTENSION' | 'OVERSTAY';

/**
 * Why a captured payment needs a human to look at it.
 *
 * A payment in this state is **real money we have taken** that we could not
 * apply. The row stays `PAID` — never pretend otherwise — and is listed for an
 * admin to refund manually. See docs/decisions.md.
 */
export type PaymentReviewReason =
  /** Captured after the booking's hold lapsed, and the device was taken. */
  | 'BOOKING_EXPIRED_DEVICE_TAKEN'
  /** Captured against a quote older than its TTL, and the fee had outgrown it. */
  | 'OVERSTAY_QUOTE_EXPIRED'
  /** The booking was cancelled or completed before the money arrived. */
  | 'BOOKING_NO_LONGER_PAYABLE';

/**
 * The rates a booking was created under, snapshotted on the row.
 *
 * Config changes must never re-price a live booking, so every figure the
 * pricing math needs is copied here at creation and read from here forever
 * after. All integers: the multiplier is **basis points** (15000 = 1.5×)
 * because money must never touch a float.
 */
export interface RateSnapshot {
  hourlyRatePaise: number;
  /** 10000 = 1.0×. 15000 = 1.5×. */
  overstayMultiplierBps: number;
  /** Minutes after `endsAt` before any fee accrues. */
  graceMinutes: number;
  /** Most hours of overstay that can ever be charged. */
  capHours: number;
  /** Minutes to collect after an overstay fee is settled. */
  collectionWindowMinutes: number;
  currency: string;
}

/** A booking as the owner sees it. */
export interface BookingSummary {
  id: string;
  status: BookingStatus;
  /**
   * The status derived from the **server clock** right now.
   *
   * May differ from `status` when the sweeper has not yet caught up. Clients
   * must branch on this, never on `status`: the stored value lags by design.
   */
  effectiveStatus: BookingStatus;
  serialNumber: string;
  deviceId: string;
  startsAt: string;
  /** Null while `PENDING_PAYMENT`: the clock starts when the money lands. */
  endsAt: string | null;
  /** When an unpaid hold lapses. Null once paid. */
  holdExpiresAt: string | null;
  hours: number;
  pricePaise: number;
  currency: string;
  /** The snapshotted rates, so the UI can state the overstay rule exactly. */
  rates: RateSnapshot;
  /** Fee outstanding right now, in paise. 0 unless overstaying. */
  overstayFeePaise: number;
  /** Hours of overstay charged so far, capped. */
  overstayHours: number;
  /** When an overstay fee was settled, opening the collection window. */
  overstaySettledAt: string | null;
  /** When the collection window closes. Null unless settled. */
  collectBy: string | null;
  completionReason: BookingCompletionReason | null;
  createdAt: string;
}

/** `GET /bookings/current`. Null when the user has no live booking. */
export interface CurrentBookingResponse {
  booking: BookingSummary | null;
  /**
   * Whether the live booking can be extended, and at what price. Null when
   * there is no live booking.
   *
   * Here so the dashboard offers exactly what the extension page and the order
   * endpoint would accept, and so no client multiplies an hourly rate by a
   * number of hours itself.
   */
  extension: ExtensionAvailability | null;
  /** Live config, for quoting a *new* booking. Never used to price an old one. */
  quote: BookingQuote;
}

/** What a new booking would cost, and the rules that would apply to it. */
export interface BookingQuote {
  rates: RateSnapshot;
  minHours: number;
  maxHours: number;
  /** Price per allowed duration, so the UI does no money arithmetic. */
  options: Array<{ hours: number; pricePaise: number }>;
  /** Per-hour overstay charge, derived from the rate and multiplier. */
  overstayHourlyPaise: number;
}

export interface CreateBookingResponse {
  booking: BookingSummary;
}

/** Why an extension is not on offer. Null when it is. */
export type ExtensionRefusalReason =
  /** The booking is not running: never paid, cancelled, or already over. */
  | 'NOT_RUNNING'
  /** A fee is owed. The remedy is to pay it and collect, not to extend. */
  | 'OVERSTAY_FEE_DUE'
  /** The fee was settled or waived, so the booking is in its collection window. */
  | 'IN_COLLECTION_WINDOW'
  /** Someone else has this safe booked after this booking. */
  | 'FOLLOWING_BOOKING';

/**
 * Whether this booking can be extended, and by how much.
 *
 * Computed by one **non-throwing** function on the server, which the
 * throwing guard then calls. That is what stops the extension page, the
 * dashboard and the order endpoint from disagreeing about whether extending
 * is possible — three implementations of the same rule is three chances to
 * offer a button that 409s.
 *
 * `options` is empty whenever `allowed` is false, and prices come **from the
 * booking's snapshot**: the client does no money arithmetic, and a config
 * change since the booking started cannot re-price it.
 */
export interface ExtensionAvailability {
  allowed: boolean;
  reason: ExtensionRefusalReason | null;
  /** Price per offerable duration, cheapest first. Empty when refused. */
  options: Array<{ hours: number; pricePaise: number }>;
  /**
   * The longest extension on offer, in hours. 0 when refused.
   *
   * Can be shorter than the configured maximum when another booking follows
   * this one — the safe has to be free again, including its turnaround, by
   * the time the next renter arrives.
   */
  maxHours: number;
}

/** `GET /bookings/:id`. */
export interface BookingDetailResponse {
  booking: BookingSummary;
  extension: ExtensionAvailability;
}

/** The Razorpay order for a booking, extension or overstay fee. */
export interface BookingOrderResponse {
  orderId: string;
  amount: number;
  currency: string;
  keyId: string;
  paymentId: string;
  purpose: PaymentPurpose;
  /** When this quote stops being honoured. Only set for OVERSTAY. */
  quoteExpiresAt: string | null;
}

// --- Admin -------------------------------------------------------------------

export interface AdminBookingRow {
  id: string;
  status: BookingStatus;
  effectiveStatus: BookingStatus;
  serialNumber: string;
  user: { id: string; name: string; email: string };
  startsAt: string;
  endsAt: string | null;
  hours: number;
  pricePaise: number;
  currency: string;
  overstayFeePaise: number;
  overstaySettledAt: string | null;
  completionReason: BookingCompletionReason | null;
  /**
   * Lifecycle messages that were dropped rather than withdrawn — spent send
   * budget, or claimed too late to be true.
   *
   * Surfaced because the alternative is silence: a dropped overstay notice
   * means a renter was never told a fee had started, and the first anyone
   * would hear of it is the renter disputing the fee.
   */
  undeliveredMessages: number;
  /**
   * True when this row needs a human: unpaid overstay, inspection due, or a
   * notice the renter should have had and did not.
   */
  flagged: boolean;
  createdAt: string;
}
