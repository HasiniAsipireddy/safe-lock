/**
 * The hardware seam.
 *
 * One interface, two implementations: a mock, and MQTT. Nothing above this
 * line may import an implementation directly — routes and services depend on
 * {@link DeviceGateway} only.
 *
 * ## What changed with real hardware
 * The old interface returned `{ acked, ackedAt }`: the mock answered
 * synchronously, so a command was finished by the time the call returned. That
 * cannot survive a radio. A publish and an ack are now two events separated by
 * an unbounded amount of time, and either can be lost — so a gateway's job
 * ends at **"the broker took it"**, and the ack arrives later through
 * {@link DeviceInboundHandler}.
 *
 * ## What the interface still does not take
 * No user id, no booking, no payment state, no request. Authorisation is
 * settled before anything reaches a gateway, and a transport should not be in
 * a position to make or re-make that decision. What it gained is the opposite
 * of context: a command id, a sequence number and a key version — the three
 * things that make a packet unforgeable and unreplayable, and nothing that
 * says who it is for or why.
 */

/** One command, in the only terms a transport needs to put it on a wire. */
export interface OutboundCommand {
  /** `Command.id`. The only correlation key, and the device's dedupe key. */
  commandId: string;
  /** Which safe. The topic is built from this; the database id never leaves. */
  serialNumber: string;
  /** Monotonic per device, allocated under the device row lock. */
  seq: number;
  /** Which `K_d` version to sign with — this device's, not the current one. */
  keyVersion: number;
  issuedAt: Date;
  /** Relative lifetime. Authoritative on the device, from its monotonic clock. */
  ttlMs: number;
}

/**
 * What a gateway reports after attempting to publish.
 *
 * Note the absence of anything about the bolt. A gateway cannot know whether a
 * safe opened; it knows whether a broker accepted a packet. Conflating the two
 * is how `lockState` would start moving on a publish.
 */
export interface PublishResult {
  /** True when the broker acknowledged the publish (PUBACK). */
  published: boolean;
  /** When it did, for `Command.sentAt` and the latency figure admins see. */
  publishedAt: Date;
}

/**
 * Where a gateway delivers whatever a device says.
 *
 * A single sink rather than an event emitter per topic: every inbound message
 * takes the same four steps — parse, verify, advance `lastSeenAt`, apply — and
 * three separate subscriptions would be three places to forget the second one.
 */
export interface DeviceInboundHandler {
  /**
   * @param serialNumber Taken from the **topic**, never the payload.
   * @param raw The unparsed bytes. Parsing and signature checking belong to
   *   the handler, not the transport: a transport that parsed would have to
   *   decide what to do with bytes that are not a message, and the answer
   *   ("drop and audit") is a policy.
   */
  handleMessage(
    serialNumber: string,
    kind: 'ack' | 'state' | 'status',
    raw: Buffer,
  ): Promise<void>;
}

export interface DeviceGateway {
  /** Human-readable name, for logs and the admin panel. */
  readonly name: string;

  /**
   * Connects, and registers where inbound messages go.
   *
   * Separate from construction so the gateway can be built at module load —
   * it holds a broker connection, and reconnecting per command is not a thing
   * to retrofit — while the handler, which reaches the database, is wired up
   * when the server starts. Tests never call this, which is what keeps a
   * broker connection out of the suite.
   */
  start(handler: DeviceInboundHandler): Promise<void>;

  /** Disconnects. Must be safe to call without a prior `start`. */
  stop(): Promise<void>;

  /**
   * Publishes a lock.
   *
   * Idempotent at the API level: locking an already-locked safe is a success,
   * and a retry must not be an error.
   */
  sendLock(command: OutboundCommand): Promise<PublishResult>;

  /**
   * Publishes an unlock.
   *
   * **Two methods, not one `sendCommand(type)`.** Unlocking has a precondition
   * — a verified one-time code — that locking does not, and that asymmetry
   * should be visible at every call site rather than hidden in an argument.
   */
  sendUnlock(command: OutboundCommand): Promise<PublishResult>;
}

/**
 * Thrown when a gateway cannot publish.
 *
 * The command row is marked `EXPIRED` / `PUBLISH_FAILED` — we know nothing
 * moved, because nothing left the building — and the user is told their safe
 * did not respond rather than shown an optimistic state.
 */
export class DeviceCommandError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DeviceCommandError';
  }
}
