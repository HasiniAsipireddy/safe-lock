import { EventEmitter } from 'node:events';

/**
 * An MQTT broker, in memory, for the tests the real protocol deserves.
 *
 * ## Why this exists rather than dialling Mosquitto
 * `test/setup.ts` blocks `fetch` for the whole suite and the same rule applies
 * here: a unit test that opens a socket is a unit test that fails when Docker
 * is not running, and the device protocol needs to be exercised on **every**
 * run, not on the runs where a container happens to be up. The dev broker in
 * `docker-compose.yml` is still the thing the gateway is pointed at by hand
 * (`DEVICE_GATEWAY=mqtt`, `npm --workspace apps/api run simulate`), which is
 * where the ACLs and TLS get tested.
 *
 * What this *is* faithful about is the behaviour the server's correctness rests
 * on: wildcard subscriptions, the retain flag, retained messages replayed to a
 * new subscriber, and a PUBACK a publisher can be refused. Those are the parts
 * a stub that simply calls the handler back would quietly get right by
 * accident.
 *
 * ## Delivery is awaited, so tests never sleep
 * `publish` resolves once every matching subscriber has finished handling the
 * message. A real broker is asynchronous, and a test that slept 50ms hoping an
 * ack had landed would be a test that fails on a loaded CI box — so the one
 * liberty taken here is the one that makes assertions deterministic.
 */

export interface BrokerPublishOptions {
  qos?: number;
  retain?: boolean;
}

export interface BrokerMessage {
  topic: string;
  payload: Buffer;
  qos: number;
  retain: boolean;
}

type Subscriber = (message: BrokerMessage) => void | Promise<void>;

export class MemoryBroker {
  /** Every publish, in order. The record a test can point at. */
  readonly published: BrokerMessage[] = [];

  private readonly retained = new Map<string, BrokerMessage>();
  private readonly subscriptions: Array<{ filter: string; handler: Subscriber }> = [];

  /**
   * Topics a publish is refused on, as a broker ACL would refuse it.
   *
   * The dev broker enforces the real thing; this is here so a test can assert
   * that the *server* handles a denied publish, which is otherwise only
   * reachable by misconfiguring a container.
   */
  private readonly denied = new Set<string>();

  deny(topic: string): void {
    this.denied.add(topic);
  }

  /** @returns the PUBACK: false when the broker refused the message. */
  async publish(
    topic: string,
    payload: Buffer,
    options: BrokerPublishOptions = {},
  ): Promise<boolean> {
    if (this.denied.has(topic)) return false;

    const message: BrokerMessage = {
      topic,
      payload,
      qos: options.qos ?? 0,
      retain: options.retain ?? false,
    };

    this.published.push(message);

    /**
     * A retained message replaces the topic's held value — and an empty
     * payload clears it, which is MQTT's way of saying "forget this". Kept
     * because a `/cmd` published with retain by mistake is the worst available
     * bug in this system, and a broker that silently dropped retention would
     * make the test asserting against it meaningless.
     */
    if (message.retain) {
      if (message.payload.length === 0) this.retained.delete(topic);
      else this.retained.set(topic, message);
    }

    for (const subscription of this.subscriptions) {
      if (matches(subscription.filter, topic)) await subscription.handler(message);
    }

    return true;
  }

  async subscribe(filter: string, handler: Subscriber): Promise<void> {
    this.subscriptions.push({ filter, handler });

    // A new subscriber gets the current truth immediately, which is the whole
    // reason `/state` and `/status` are retained: the server must learn a
    // device's state on its own reconnect without waiting for a heartbeat.
    for (const message of this.retained.values()) {
      if (matches(filter, message.topic)) await handler(message);
    }
  }

  /** What the broker is holding for a topic, if anything. */
  retainedFor(topic: string): BrokerMessage | null {
    return this.retained.get(topic) ?? null;
  }

  publishedTo(topic: string): BrokerMessage[] {
    return this.published.filter((message) => message.topic === topic);
  }

  reset(): void {
    this.published.length = 0;
    this.retained.clear();
    this.subscriptions.length = 0;
    this.denied.clear();
  }
}

/** MQTT single-level wildcard matching. Enough of it: this protocol uses `+`. */
export function matches(filter: string, topic: string): boolean {
  const filterSegments = filter.split('/');
  const topicSegments = topic.split('/');

  if (filterSegments.length !== topicSegments.length) return false;

  return filterSegments.every(
    (segment, index) => segment === '+' || segment === topicSegments[index],
  );
}

/**
 * Just enough of an `mqtt.js` client to put {@link MqttDeviceGateway} on top of
 * a {@link MemoryBroker}.
 *
 * The point of the exercise is that the **real gateway** is under test — its
 * publish options, its signing, its topic parsing, its dispatch — rather than a
 * second implementation written to agree with it. A fake that stood in for the
 * gateway would pass while the gateway retained a command.
 */
export class BrokerBackedMqttClient extends EventEmitter {
  connected = true;
  ended = false;

  constructor(private readonly broker: MemoryBroker) {
    super();
  }

  async publishAsync(
    topic: string,
    message: string | Buffer,
    options: BrokerPublishOptions = {},
  ): Promise<void> {
    const payload = typeof message === 'string' ? Buffer.from(message, 'utf8') : message;
    const accepted = await this.broker.publish(topic, payload, options);

    // MQTT 5's reason codes are the reason the gateway speaks 5 rather than
    // 3.1.1: a refused publish must be an error the caller sees, not a silent
    // success that leaves a safe waiting for a command the broker dropped.
    if (!accepted) throw new Error(`Not authorized to publish to ${topic}`);
  }

  async subscribeAsync(filters: string | readonly string[]): Promise<void> {
    const list = typeof filters === 'string' ? [filters] : [...filters];

    for (const filter of list) {
      await this.broker.subscribe(filter, (message) => {
        this.emit('message', message.topic, message.payload);
      });
    }
  }

  async endAsync(): Promise<void> {
    this.ended = true;
    this.connected = false;
  }
}
