import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import mqtt from 'mqtt';
import { canonicalCommand, deriveCommandKey, verifyCanonical } from '../deviceProtocol';
import { logger } from '../logger';
import { brokerEndpoint, describeMqttError, MqttDeviceGateway } from './mqtt.gateway';
import type { DeviceInboundHandler, OutboundCommand } from './gateway';

/**
 * The MQTT gateway, driven against a stub broker.
 *
 * No network: `test/setup.ts` blocks `fetch` for the whole suite and a real
 * broker has no business in it either, so `mqtt.connect` is stubbed. What is
 * worth asserting here is everything a real broker would not tell us anyway —
 * the publish options, the payload's signature, and which topics an inbound
 * message is accepted from.
 */

const SERIAL = 'SAFE-0001';

interface Published {
  topic: string;
  message: string;
  options: { qos?: number; retain?: boolean };
}

/** Enough of an mqtt.js client to exercise the gateway. */
class StubClient extends EventEmitter {
  connected = true;
  readonly published: Published[] = [];
  readonly subscribed: unknown[] = [];
  ended = false;

  /** Set to reject the next publish, as a broker ACL denial would. */
  publishError: Error | null = null;

  async publishAsync(
    topic: string,
    message: string,
    options: { qos?: number; retain?: boolean },
  ): Promise<void> {
    if (this.publishError) throw this.publishError;
    this.published.push({ topic, message, options });
  }

  async subscribeAsync(filters: unknown, options: unknown): Promise<void> {
    this.subscribed.push({ filters, options });
  }

  async endAsync(): Promise<void> {
    this.ended = true;
  }
}

function stubBroker(): StubClient {
  const client = new StubClient();

  vi.spyOn(mqtt, 'connect').mockImplementation(() => {
    // Connect on the next tick, as a real client does — the gateway awaits the
    // event, so resolving synchronously would not exercise that path.
    setImmediate(() => client.emit('connect'));
    return client as unknown as ReturnType<typeof mqtt.connect>;
  });

  return client;
}

const command: OutboundCommand = {
  commandId: 'cmd_mqtt_0001',
  serialNumber: SERIAL,
  seq: 7,
  keyVersion: 1,
  issuedAt: new Date('2026-10-19T12:00:00.000Z'),
  ttlMs: 15_000,
};

const noopHandler: DeviceInboundHandler = { handleMessage: async () => {} };

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('publishing a command', () => {
  /**
   * The single most important assertion in this file.
   *
   * A retained command is re-delivered on every reconnect, forever. For
   * `UNLOCK` that is a safe which opens itself every time its Wi-Fi flaps —
   * the worst available bug in this system — so the flag is hardcoded and
   * this test is what keeps it that way.
   */
  it('never retains a command, and uses QoS 1', async () => {
    const client = stubBroker();
    const gateway = new MqttDeviceGateway();
    await gateway.start(noopHandler);

    await gateway.sendUnlock(command);
    await gateway.sendLock({ ...command, commandId: 'cmd_mqtt_0002', seq: 8 });

    expect(client.published).toHaveLength(2);
    for (const publish of client.published) {
      expect(publish.options.retain).toBe(false);
      expect(publish.options.qos).toBe(1);
    }
  });

  it('publishes to the device’s own command topic, keyed by serial', async () => {
    const client = stubBroker();
    const gateway = new MqttDeviceGateway();
    await gateway.start(noopHandler);

    await gateway.sendUnlock(command);

    expect(client.published[0]!.topic).toBe('safelock/v1/SAFE-0001/cmd');
    // No database id anywhere on the wire.
    expect(client.published[0]!.message).not.toContain('cmd_mqtt_0001'.replace('cmd', 'dev'));
  });

  it('signs the payload with the device’s derived key', async () => {
    const client = stubBroker();
    const gateway = new MqttDeviceGateway();
    await gateway.start(noopHandler);

    await gateway.sendUnlock(command);

    const payload = JSON.parse(client.published[0]!.message) as Record<string, unknown>;

    expect(payload).toMatchObject({
      v: 1,
      kv: 1,
      commandId: command.commandId,
      type: 'UNLOCK',
      serial: SERIAL,
      seq: 7,
      ttlMs: 15_000,
    });

    const canonical = canonicalCommand({
      keyVersion: 1,
      commandId: command.commandId,
      type: 'UNLOCK',
      serialNumber: SERIAL,
      seq: 7,
      issuedAt: command.issuedAt,
      ttlMs: 15_000,
    });

    expect(verifyCanonical(deriveCommandKey(SERIAL, 1), canonical, payload.sig)).toBe(true);
  });

  /**
   * `sendLock` and `sendUnlock` are two methods rather than one
   * `sendCommand(type)`, and the payload is where that has to show up: a
   * device must never receive something it has to interpret to find out
   * which direction the bolt goes.
   */
  it('distinguishes the two command types in the signed payload', async () => {
    const client = stubBroker();
    const gateway = new MqttDeviceGateway();
    await gateway.start(noopHandler);

    await gateway.sendLock(command);

    expect(JSON.parse(client.published[0]!.message).type).toBe('LOCK');
  });

  it('carries nothing about the user, booking or payment', async () => {
    const client = stubBroker();
    const gateway = new MqttDeviceGateway();
    await gateway.start(noopHandler);

    await gateway.sendUnlock(command);

    expect(Object.keys(JSON.parse(client.published[0]!.message)).sort()).toEqual([
      'commandId',
      'issuedAt',
      'kv',
      'seq',
      'serial',
      'sig',
      'ttlMs',
      'type',
      'v',
    ]);
  });

  it('turns a broker refusal into a DeviceCommandError', async () => {
    const client = stubBroker();
    client.publishError = new Error('not authorized');

    const gateway = new MqttDeviceGateway();
    await gateway.start(noopHandler);

    await expect(gateway.sendUnlock(command)).rejects.toThrow(/rejected a publish/);
  });

  /**
   * A disconnected gateway refuses rather than queues. The command row is
   * then `EXPIRED`/`PUBLISH_FAILED`, which is the truth: nothing left the
   * building, so we know the bolt did not move.
   */
  it('refuses to publish while disconnected', async () => {
    const client = stubBroker();
    const gateway = new MqttDeviceGateway();
    await gateway.start(noopHandler);

    client.connected = false;

    await expect(gateway.sendUnlock(command)).rejects.toThrow(/not connected/);
  });
});

describe('subscribing', () => {
  /**
   * Wildcards, not per-device topics. A subscription per device is a
   * subscription to maintain as inventory changes, and a device whose
   * subscription was missed is a safe whose acks silently vanish.
   */
  it('subscribes to the three inbound topics at QoS 1', async () => {
    const client = stubBroker();
    const gateway = new MqttDeviceGateway();
    await gateway.start(noopHandler);

    expect(client.subscribed).toEqual([
      {
        filters: [
          'safelock/v1/+/ack',
          'safelock/v1/+/state',
          'safelock/v1/+/status',
        ],
        options: { qos: 1 },
      },
    ]);
  });

  /** The server must not be able to subscribe itself to a command topic. */
  it('does not subscribe to any command topic', async () => {
    const client = stubBroker();
    const gateway = new MqttDeviceGateway();
    await gateway.start(noopHandler);

    expect(JSON.stringify(client.subscribed)).not.toContain('/cmd');
  });
});

describe('inbound messages', () => {
  it('routes a message by the serial and kind in its topic', async () => {
    const client = stubBroker();
    const seen: Array<[string, string, string]> = [];

    const gateway = new MqttDeviceGateway();
    await gateway.start({
      handleMessage: async (serialNumber, kind, raw) => {
        seen.push([serialNumber, kind, raw.toString('utf8')]);
      },
    });

    client.emit('message', 'safelock/v1/SAFE-0001/ack', Buffer.from('{"a":1}'));
    client.emit('message', 'safelock/v1/SAFE-0002/state', Buffer.from('{"b":2}'));
    await vi.waitFor(() => expect(seen).toHaveLength(2));

    expect(seen[0]).toEqual(['SAFE-0001', 'ack', '{"a":1}']);
    expect(seen[1]).toEqual(['SAFE-0002', 'state', '{"b":2}']);
  });

  /**
   * The serial comes from the topic, which the broker ACL binds to an
   * authenticated identity — so it is the one part of an inbound message that
   * is not simply the sender's claim. A topic that is not one of ours is
   * dropped here, so no handler has to decide what `safelock/v1/../ack`
   * means.
   */
  it.each([
    ['a command topic, which no device may publish to', 'safelock/v1/SAFE-0001/cmd'],
    ['a traversal attempt in the serial', 'safelock/v1/../ack'],
    ['a serial that fails the inventory pattern', 'safelock/v1/NOTASAFE/ack'],
    ['an unknown protocol version', 'safelock/v2/SAFE-0001/ack'],
    ['an unrelated topic', 'some/other/topic/entirely'],
  ])('drops %s', async (_label, topic) => {
    const client = stubBroker();
    const handleMessage = vi.fn(async () => {});

    const gateway = new MqttDeviceGateway();
    await gateway.start({ handleMessage });

    client.emit('message', topic, Buffer.from('{}'));
    // Give the dispatch a tick to have done the wrong thing, if it would.
    await new Promise((resolve) => setImmediate(resolve));

    expect(handleMessage).not.toHaveBeenCalled();
  });
});

describe('connection lifecycle', () => {
  it('rejects start when the broker refuses the connection', async () => {
    const client = new StubClient();
    vi.spyOn(mqtt, 'connect').mockImplementation(() => {
      setImmediate(() => client.emit('error', new Error('bad credentials')));
      return client as unknown as ReturnType<typeof mqtt.connect>;
    });

    const gateway = new MqttDeviceGateway();

    await expect(gateway.start(noopHandler)).rejects.toThrow(/Could not connect/);
  });

  /**
   * A broker error after connecting is logged and swallowed. mqtt.js
   * reconnects on its own, and throwing from an event handler would take the
   * process down over a blip — in a service that authorises opening safes,
   * restarting because a broker hiccuped is the more expensive failure.
   */
  it('survives a broker error after connecting', async () => {
    const client = stubBroker();
    const gateway = new MqttDeviceGateway();
    await gateway.start(noopHandler);

    expect(() => client.emit('error', new Error('transient'))).not.toThrow();

    await gateway.sendLock(command);
    expect(client.published).toHaveLength(1);
  });

  it('lets in-flight traffic settle on stop', async () => {
    const client = stubBroker();
    const gateway = new MqttDeviceGateway();
    await gateway.start(noopHandler);

    await gateway.stop();

    expect(client.ended).toBe(true);
  });

  it('is safe to stop without ever starting', async () => {
    await expect(new MqttDeviceGateway().stop()).resolves.toBeUndefined();
  });
});

/**
 * Logging a broker failure usefully.
 *
 * The bug this fixes: `logger.error({ reason: error.message })` for the single
 * commonest failure in development — nothing listening on localhost:1883 —
 * logged `"reason": ""`. Node resolves localhost to both `::1` and
 * `127.0.0.1`, attempts both, and raises an `AggregateError` whose own
 * `message` is the empty string with the two real `ECONNREFUSED` errors
 * hanging off `.errors`.
 */
describe('describeMqttError', () => {
  /** What Node actually hands us for a refused connection to localhost. */
  function econnrefusedAggregate(): AggregateError {
    const v6 = Object.assign(new Error('connect ECONNREFUSED ::1:1883'), {
      code: 'ECONNREFUSED',
      address: '::1',
      port: 1883,
      syscall: 'connect',
    });
    const v4 = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1883'), {
      code: 'ECONNREFUSED',
      address: '127.0.0.1',
      port: 1883,
      syscall: 'connect',
    });

    // The empty message is the whole point — this is what Node produces.
    return new AggregateError([v6, v4], '');
  }

  it('never reports an empty reason for an AggregateError', () => {
    const detail = describeMqttError(econnrefusedAggregate());

    expect(detail.reason).not.toBe('');
    expect(detail.reason).toBe('AggregateError');
  });

  it('promotes the underlying code when the aggregate has none', () => {
    expect(describeMqttError(econnrefusedAggregate()).code).toBe('ECONNREFUSED');
  });

  it('flattens every entry of errors, with the address each one dialled', () => {
    const detail = describeMqttError(econnrefusedAggregate());

    expect(detail.causes).toEqual([
      {
        code: 'ECONNREFUSED',
        reason: 'connect ECONNREFUSED ::1:1883',
        address: '::1',
        port: 1883,
      },
      {
        code: 'ECONNREFUSED',
        reason: 'connect ECONNREFUSED 127.0.0.1:1883',
        address: '127.0.0.1',
        port: 1883,
      },
    ]);
  });

  it('keeps an ordinary error’s own code and message', () => {
    const error = Object.assign(new Error('Connection refused: Not authorized'), {
      code: 5,
    });

    expect(describeMqttError(error)).toEqual({
      code: '5',
      reason: 'Connection refused: Not authorized',
    });
  });

  it('survives a non-Error, and an aggregate holding non-Errors', () => {
    expect(describeMqttError('socket hang up').reason).toBe('socket hang up');
    expect(describeMqttError(undefined).reason).toBe('unknown');

    const odd = Object.assign(new Error(''), { errors: ['nope'] });
    expect(describeMqttError(odd).causes).toEqual([
      { code: null, reason: 'nope', address: null, port: null },
    ]);
  });

  /** An error detail is a diagnosis. A credential is a device identity. */
  it('carries nothing but code, reason, address and port', () => {
    const detail = describeMqttError(econnrefusedAggregate());

    expect(Object.keys(detail).sort()).toEqual(['causes', 'code', 'reason']);
    for (const cause of detail.causes!) {
      expect(Object.keys(cause).sort()).toEqual(['address', 'code', 'port', 'reason']);
    }
  });
});

describe('brokerEndpoint', () => {
  it('reports the host and port', () => {
    expect(brokerEndpoint('mqtt://localhost:1883')).toEqual({
      host: 'localhost',
      port: 1883,
    });
    expect(brokerEndpoint('mqtts://broker.example.test:8883')).toEqual({
      host: 'broker.example.test',
      port: 8883,
    });
  });

  /**
   * `mqtts://user:pass@host` is a legal URL and the sort of thing that ends up
   * in an env file. Logging the URL raw would publish the password; this must
   * drop the userinfo entirely.
   */
  it('drops credentials from a URL that carries them', () => {
    const endpoint = brokerEndpoint('mqtts://someuser:s3cr3t@broker.example.test:8883');

    expect(endpoint).toEqual({ host: 'broker.example.test', port: 8883 });
    expect(JSON.stringify(endpoint)).not.toMatch(/someuser|s3cr3t/);
  });

  /** Nulls, not the raw string — which would reintroduce the leak above. */
  it('yields nulls for an unparseable URL', () => {
    expect(brokerEndpoint('not a url:pass@host')).toEqual({ host: null, port: null });
  });

  it('reports a null port when the URL omits it', () => {
    expect(brokerEndpoint('mqtts://broker.example.test')).toEqual({
      host: 'broker.example.test',
      port: null,
    });
  });
});

describe('what reaches the log on a failed connection', () => {
  /**
   * The end-to-end version of the fix: a broker that refuses the connection
   * must produce a log line an operator can act on — a code, a non-empty
   * reason, the host and the port — and must not produce the credential.
   */
  it('logs the code, reason, causes, host and port but never the credential', async () => {
    const error = new AggregateError(
      [
        Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1883'), {
          code: 'ECONNREFUSED',
          address: '127.0.0.1',
          port: 1883,
        }),
      ],
      '',
    );

    const client = new StubClient();
    vi.spyOn(mqtt, 'connect').mockImplementation(() => {
      setImmediate(() => client.emit('error', error));
      return client as unknown as ReturnType<typeof mqtt.connect>;
    });

    const logged = vi.spyOn(logger, 'error').mockImplementation(() => {});

    await expect(new MqttDeviceGateway().start(noopHandler)).rejects.toThrow(
      /Could not connect/,
    );

    /**
     * Two lines, not one, and both are wanted: the persistent `error` handler
     * logs every broker error for the life of the connection, and the connect
     * path logs the one that defeated `start`. Asserted on the second so the
     * test is about the startup diagnosis rather than about handler ordering.
     */
    expect(logged).toHaveBeenCalledTimes(2);

    const connectFailure = logged.mock.calls.find(([, message]) =>
      /Could not connect to the MQTT broker/.test(String(message)),
    );
    expect(connectFailure).toBeDefined();

    const [context] = connectFailure!;

    expect(context).toMatchObject({
      host: 'localhost',
      port: 1883,
      code: 'ECONNREFUSED',
      reason: 'AggregateError',
      causes: [
        {
          code: 'ECONNREFUSED',
          reason: 'connect ECONNREFUSED 127.0.0.1:1883',
          address: '127.0.0.1',
          port: 1883,
        },
      ],
    });

    // The suite's broker credential. It must appear in neither log line.
    expect(JSON.stringify(logged.mock.calls)).not.toMatch(
      /vitest_mqtt_password|vitest-api-client/,
    );
  });
});
