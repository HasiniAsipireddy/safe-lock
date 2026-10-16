/**
 * The hardware seam.
 *
 * One interface, two implementations over time: a mock today, MQTT when the
 * physical units exist. Nothing above this line may import a driver directly —
 * routes and services depend on {@link DeviceGateway} only, so the real
 * gateway can be dropped in without touching a single route.
 *
 * Note what the interface does **not** take: a user id, a payment state or a
 * request. Authorisation is settled before anything reaches a gateway; a
 * transport should not be in a position to make or re-make that decision.
 */

/** What a gateway reports back after a command. */
export interface DeviceCommandResult {
  /** True when the device acknowledged the command. */
  acked: boolean;
  /** When the ack arrived. Becomes `lockStateUpdatedAt`. */
  ackedAt: Date;
}

export interface DeviceGateway {
  /** Human-readable name, for logs and the admin panel. */
  readonly name: string;

  /**
   * Drives the bolt closed.
   *
   * Implementations must be safe to call on an already-locked safe: locking
   * is idempotent at the API level, and a retry must not be an error.
   */
  sendLock(serialNumber: string): Promise<DeviceCommandResult>;

  /**
   * Drives the bolt open.
   *
   * Only ever called after an OTP has been verified. A gateway must never
   * expose a path to this that skips that check.
   */
  sendUnlock(serialNumber: string): Promise<DeviceCommandResult>;
}

/**
 * Thrown when a gateway cannot deliver a command. Translated to
 * `DEVICE_COMMAND_FAILED` (502) by the device service — the user's safe did
 * not move, and the UI must say so rather than showing an optimistic state.
 */
export class DeviceCommandError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DeviceCommandError';
  }
}
