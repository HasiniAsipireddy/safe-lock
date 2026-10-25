import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';
import { env } from '../../config/env';
import { logger } from '../logger';
import {
  buildCommandPayload,
  deriveCommandKey,
  deviceTopic,
  INBOUND_TOPIC_FILTERS,
  parseDeviceTopic,
} from '../deviceProtocol';
import { DeviceCommandError } from './gateway';
import type {
  DeviceGateway,
  DeviceInboundHandler,
  OutboundCommand,
  PublishResult,
} from './gateway';

/**
 * The real transport: MQTT 5 over TLS.
 *
 * ## What this class is responsible for, and what it is not
 * It signs a command, puts it on a topic, and hands whatever comes back to the
 * inbound handler. It does **not** decide whether a command should be sent —
 * authorisation is settled long before anything reaches here, which is why the
 * interface takes a serial number and the three fields that make a packet
 * unforgeable, and nothing about a user, a booking or a payment.
 *
 * It also does not interpret a reply. Parsing, signature verification and
 * "what do we do with bytes that are not a message" are policy, and policy
 * lives in `modules/commands/inbound.service.ts`.
 *
 * ## One privileged server client, never a device identity
 * The API connects with its own credential and the ACL that goes with it: it
 * may write to any `cmd` and read any report, and is **denied** write access
 * to `ack`, `state` and `status`. There is no reason for the server to forge a
 * device report, so a compromised API credential cannot fabricate the security
 * record — only issue commands it could issue anyway.
 */
export class MqttDeviceGateway implements DeviceGateway {
  readonly name = 'mqtt';

  private client: MqttClient | null = null;
  private handler: DeviceInboundHandler | null = null;

  /**
   * Inbound messages currently being handled.
   *
   * `client.on('message')` cannot await — it is a library's event callback —
   * so the promise it starts has to be held somewhere or it is unobservable.
   * Two callers need it: `stop()`, because an ack arriving mid-shutdown is a
   * bolt that moved and dropping it would leave the safe recorded wrongly, and
   * {@link drain}, which is how the simulator's tests are deterministic about
   * an asynchronous protocol without sleeping.
   */
  private readonly inFlight = new Set<Promise<void>>();

  async start(handler: DeviceInboundHandler): Promise<void> {
    this.handler = handler;

    if (this.client) return;

    const url = env.MQTT_URL;
    if (!url) {
      // Unreachable: the env schema requires it when DEVICE_GATEWAY=mqtt.
      throw new DeviceCommandError('MQTT_URL is not configured');
    }

    const options: IClientOptions = {
      /**
       * MQTT 5, not 3.1.1. Not for a feature — for the reason codes: a
       * PUBACK carrying "not authorized" instead of a silent success is the
       * difference between a broker ACL misconfiguration being a boot-time
       * discovery and being a safe that quietly never opens.
       */
      protocolVersion: 5,
      clientId: serverClientId(),
      username: env.MQTT_USERNAME,
      password: env.MQTT_PASSWORD,
      /**
       * A persistent session, so the broker holds our subscriptions and any
       * QoS 1 messages across a brief disconnect. A clean session would
       * silently drop every ack published while we were reconnecting — which
       * is exactly the window in which a command we care about is in flight.
       */
      clean: false,
      reconnectPeriod: 2_000,
      connectTimeout: env.MQTT_TIMEOUT_MS,
      /**
       * Deliberately **no** last will for the server.
       *
       * A device's will tells us it vanished. Nothing subscribes to a will
       * from the API — devices do not listen to us except on their own `cmd`
       * — so one would be a message nobody reads.
       */
      resubscribe: true,
    };

    const client = mqtt.connect(url, options);
    this.client = client;

    client.on('message', (topic, payload) => {
      const handling = this.dispatch(topic, payload);

      this.inFlight.add(handling);
      void handling.finally(() => this.inFlight.delete(handling));
    });

    const endpoint = brokerEndpoint(url);

    client.on('error', (error) => {
      // Logged, never thrown: mqtt.js reconnects on its own, and an
      // unhandled error here would take the process down over a broker blip.
      logger.error(
        { ...endpoint, ...describeMqttError(error) },
        'MQTT client error',
      );
    });

    client.on('reconnect', () => {
      logger.warn(endpoint, 'Reconnecting to the MQTT broker');
    });

    client.on('close', () => {
      logger.warn(endpoint, 'MQTT connection closed');
    });

    await new Promise<void>((resolve, reject) => {
      const onConnect = () => {
        client.removeListener('error', onError);
        resolve();
      };
      const onError = (error: Error) => {
        client.removeListener('connect', onConnect);

        /**
         * Logged here as well as rejected, because the rejection is a single
         * string and this is where the diagnosis lives.
         *
         * `server.ts` catches the rejection and logs `error.message` — which
         * for the commonest failure of all, a broker that is simply not
         * running on localhost, is the **empty string**: Node raises an
         * `AggregateError` whose own message is blank and whose `errors` array
         * holds the real `ECONNREFUSED` per address family. That produced the
         * notorious `"reason": ""` log line, which says nothing at all.
         */
        logger.error(
          { ...endpoint, ...describeMqttError(error) },
          'Could not connect to the MQTT broker',
        );

        reject(
          new DeviceCommandError(
            `Could not connect to the broker: ${describeMqttError(error).reason}`,
          ),
        );
      };

      client.once('connect', onConnect);
      client.once('error', onError);
    });

    /**
     * Subscribe at QoS 1, and to wildcards rather than per-device topics.
     *
     * A subscription per device would be a subscription to maintain as
     * inventory changes, and a device whose subscription was missed would be
     * a safe whose acks silently vanished. The wildcard cannot go stale.
     */
    await client.subscribeAsync([...INBOUND_TOPIC_FILTERS], { qos: 1 });

    logger.info({ gateway: this.name, clientId: options.clientId }, 'MQTT gateway connected');
  }

  /**
   * Waits for every inbound message currently being handled.
   *
   * A loop rather than one `Promise.all`, because handling an ack can produce
   * another inbound message: §8.3's reconciling `LOCK` is published from inside
   * a state report's handler, and the device answers it before the first
   * handler has returned. One pass would wait for the first wave only.
   *
   * Lives on the gateway for the same reason `drainDeviceAcks` does: nothing
   * has to reach into a concrete class, and it is honestly useful in
   * production — `stop()` uses it so a shutdown does not drop an ack.
   */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  async stop(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.handler = null;

    await this.drain();

    if (!client) return;

    // `false` = do not force: let in-flight QoS 1 traffic settle. An ack
    // arriving mid-shutdown is a bolt that moved.
    await client.endAsync(false);
  }

  sendLock(command: OutboundCommand): Promise<PublishResult> {
    return this.publish(command, 'LOCK');
  }

  sendUnlock(command: OutboundCommand): Promise<PublishResult> {
    return this.publish(command, 'UNLOCK');
  }

  /**
   * Publishes one signed command.
   *
   * **QoS 1, `retain: false`.** The retain flag is hardcoded and asserted by a
   * test, because a retained command is re-delivered on every reconnect,
   * forever — and for `UNLOCK` that is the worst available bug in this system:
   * a safe that opens itself every time its Wi-Fi flaps. QoS 1 rather than 2
   * because at-least-once plus the `commandId` de-duplication the device needs
   * anyway for replay protection is exactly-once in effect, without a
   * four-packet handshake through the weakest part of every embedded MQTT
   * stack.
   */
  private async publish(
    command: OutboundCommand,
    type: 'LOCK' | 'UNLOCK',
  ): Promise<PublishResult> {
    const client = this.client;

    if (!client?.connected) {
      throw new DeviceCommandError('The MQTT gateway is not connected');
    }

    const payload = buildCommandPayload({
      key: deriveCommandKey(command.serialNumber, command.keyVersion),
      keyVersion: command.keyVersion,
      commandId: command.commandId,
      type,
      serialNumber: command.serialNumber,
      seq: command.seq,
      issuedAt: command.issuedAt,
      ttlMs: command.ttlMs,
    });

    const topic = deviceTopic(command.serialNumber, 'cmd');

    try {
      await client.publishAsync(topic, JSON.stringify(payload), {
        qos: 1,
        retain: false,
      });
    } catch (cause) {
      throw new DeviceCommandError(
        `The broker rejected a publish to ${topic}`,
        { cause },
      );
    }

    // Serial, command id and sequence only. A transport log has no business
    // holding a signature, a key or a user.
    logger.info(
      {
        gateway: this.name,
        serialNumber: command.serialNumber,
        commandId: command.commandId,
        seq: command.seq,
        type,
      },
      'Published a device command',
    );

    return { published: true, publishedAt: new Date() };
  }

  /**
   * Routes an inbound message, having first decided it is one.
   *
   * The serial and the kind come from the **topic**, which the broker ACL
   * binds to an authenticated identity — so they are the one thing about an
   * inbound message that is not simply the sender's claim. An unrecognised
   * topic is dropped here rather than passed on: a handler should not have to
   * decide what a message on `safelock/v1/../ack` means.
   */
  private async dispatch(topic: string, payload: Buffer): Promise<void> {
    const parsed = parseDeviceTopic(topic);

    if (!parsed) {
      logger.warn({ topic }, 'Dropped a message on an unrecognised topic');
      return;
    }

    const handler = this.handler;
    if (!handler) return;

    await handler.handleMessage(parsed.serialNumber, parsed.kind, payload);
  }
}

/**
 * This process's broker identity.
 *
 * Unique per process, because two API instances sharing a client id would
 * fight: MQTT disconnects the older session on a duplicate connect, so a
 * two-instance deployment would flap forever and neither would hold a stable
 * subscription. The suffix is random rather than, say, a hostname, so the same
 * image running twice on one host is still two identities.
 */
function serverClientId(): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return `safelock-api-${suffix}`;
}

// --- Logging a broker failure usefully ---------------------------------------

/** One underlying connection failure, as a log line's worth of fields. */
interface MqttErrorCause {
  code: string | null;
  reason: string;
  /** The address actually dialled. A host and port, never a credential. */
  address: string | null;
  port: number | null;
}

/** What we log about a broker failure. Never a username, password or URL. */
export interface MqttErrorDetail {
  /** `ECONNREFUSED`, `ENOTFOUND`, a CONNACK reason code — or null. */
  code: string | null;
  /** Never empty: falls back to the error's name, then to a fixed string. */
  reason: string;
  /** Present when the error is an `AggregateError`. One entry per attempt. */
  causes?: MqttErrorCause[];
}

/**
 * Turns whatever mqtt.js emitted into something a log line can answer with.
 *
 * ## Why this exists
 * `logger.error({ reason: error.message })` is a reasonable thing to write and
 * is useless for the single commonest failure in development: nothing
 * listening on `localhost:1883`. Node resolves localhost to both `::1` and
 * `127.0.0.1`, attempts both, and raises an **`AggregateError` whose own
 * `message` is the empty string** with the two real `ECONNREFUSED` errors
 * hanging off `.errors`. The log then says `"reason": ""` and an operator has
 * no thread to pull.
 *
 * So: the code, a message that is never blank, and every entry of `errors`
 * flattened into its own small object.
 *
 * ## What it deliberately does not carry
 * No username, no password, no connection URL. The caller supplies host and
 * port separately via {@link brokerEndpoint} — an address is a diagnosis, a
 * credential is a device identity, and the two must never share a log line.
 */
export function describeMqttError(error: unknown): MqttErrorDetail {
  if (!(error instanceof Error)) {
    return { code: null, reason: typeof error === 'string' && error ? error : 'unknown' };
  }

  const detail: MqttErrorDetail = {
    code: readCode(error),
    // An AggregateError's message is empty; its name is not.
    reason: error.message || error.name || 'unknown',
  };

  /**
   * `AggregateError` structurally rather than by `instanceof`.
   *
   * mqtt.js and Node both produce aggregate-shaped errors, and an
   * `instanceof` check against the global would miss one constructed in
   * another realm — which is precisely the kind of thing that turns a log
   * message into an empty string again.
   */
  const nested: unknown = (error as { errors?: unknown }).errors;

  if (Array.isArray(nested) && nested.length > 0) {
    detail.causes = nested.map((cause) => ({
      code: readCode(cause),
      reason:
        cause instanceof Error
          ? cause.message || cause.name || 'unknown'
          : String(cause ?? 'unknown'),
      address: readString(cause, 'address'),
      port: readNumber(cause, 'port'),
    }));

    /**
     * Promote the first cause's code when the aggregate has none of its own,
     * so a dashboard filtering on `code` still finds `ECONNREFUSED`.
     */
    detail.code ??= detail.causes[0]?.code ?? null;
  }

  return detail;
}

/**
 * The broker's host and port, and nothing else.
 *
 * Parsed from the URL rather than logged raw, because `MQTT_URL` may carry
 * credentials in its userinfo — `mqtts://user:pass@host` is legal and the sort
 * of thing that ends up in an env file. A log line gets the two fields that
 * help and none that leak. An unparseable URL yields nulls rather than falling
 * back to the raw string, which would reintroduce exactly that risk.
 */
export function brokerEndpoint(url: string): { host: string | null; port: number | null } {
  try {
    const parsed = new URL(url);
    const port = parsed.port ? Number(parsed.port) : null;

    return {
      host: parsed.hostname || null,
      port: Number.isInteger(port) ? port : null,
    };
  } catch {
    return { host: null, port: null };
  }
}

function readCode(value: unknown): string | null {
  const code = (value as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code) return code;
  if (typeof code === 'number') return String(code);
  return null;
}

function readString(value: unknown, key: string): string | null {
  const read = (value as Record<string, unknown> | null)?.[key];
  return typeof read === 'string' && read ? read : null;
}

function readNumber(value: unknown, key: string): number | null {
  const read = (value as Record<string, unknown> | null)?.[key];
  return typeof read === 'number' && Number.isFinite(read) ? read : null;
}
