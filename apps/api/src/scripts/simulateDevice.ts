import mqtt from 'mqtt';
import { DEVICE_HEARTBEAT_MS, env } from '../config/env';
import { logger } from '../lib/logger';
import {
  SimulatedDevice,
  type MisbehaviourKind,
  type SimulatorTransport,
} from '../lib/deviceSimulator';

/**
 * One simulated safe, on the **real** broker.
 *
 * The suite runs the same `SimulatedDevice` over an in-memory broker, which is
 * what makes the protocol testable on every run rather than on the runs where
 * a container happens to be up. This is the other half, and it tests what
 * memory cannot: that a device authenticating with its own credential, under
 * the ACL in `docker/mosquitto/aclfile`, can reach its own topics and no
 * others.
 *
 * ```
 * npm run db:up                                   # broker on :1883
 * DEVICE_GATEWAY=mqtt npm run dev:api             # the API, on the broker
 * npm --workspace apps/api run simulate -- SAFE-0001
 * npm --workspace apps/api run simulate -- SAFE-0001 --misbehave DROP_ACK
 * ```
 *
 * It is a development tool and refuses to run in production, where a process
 * pretending to be a safe is a process that can answer for one.
 */

interface Options {
  serialNumber: string;
  password: string;
  url: string;
  misbehaviours: MisbehaviourKind[];
  heartbeatMs: number;
}

const MISBEHAVIOURS: readonly MisbehaviourKind[] = [
  'DROP_ACK',
  'HOLD_ACK',
  'FORGE_SIGNATURE',
  'WRONG_COMMAND_ID',
  'REPLAY_ACK',
  'DISAGREE_STATE',
  'REBOOT',
  'GO_SILENT',
];

function parseArgs(argv: string[]): Options {
  const positional = argv.filter((argument) => !argument.startsWith('--'));
  const serialNumber = positional[0];

  if (!serialNumber) {
    throw new Error(
      'Usage: simulate -- <SERIAL> [--misbehave KIND]… [--password P] [--url mqtt://host:1883]',
    );
  }

  const misbehaviours: MisbehaviourKind[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--misbehave') continue;

    const kind = argv[index + 1];
    if (!kind || !MISBEHAVIOURS.includes(kind as MisbehaviourKind)) {
      throw new Error(`--misbehave needs one of: ${MISBEHAVIOURS.join(', ')}`);
    }

    misbehaviours.push(kind as MisbehaviourKind);
  }

  const flag = (name: string): string | undefined => {
    const at = argv.indexOf(`--${name}`);
    return at === -1 ? undefined : argv[at + 1];
  };

  return {
    serialNumber,
    /**
     * The dev fleet's shared password, which is a local-only convenience and
     * is documented as such in `docker/mosquitto/passwordfile`. A real unit's
     * credential is minted per device, shown once, and stored only as a hash.
     */
    password: flag('password') ?? 'safelock_dev_only',
    url: flag('url') ?? env.MQTT_URL ?? 'mqtt://localhost:1883',
    misbehaviours,
    heartbeatMs: DEVICE_HEARTBEAT_MS,
  };
}

/**
 * `mqtt.js` as the simulator's transport.
 *
 * The device's identity is its **serial**: client id, username and (in
 * production) certificate CN are one value, which is what lets the broker's
 * ACL be a pattern rather than a table — and what makes a stolen credential
 * useless from another client id.
 */
async function connectTransport(
  options: Options,
): Promise<{ transport: SimulatorTransport; end: () => Promise<void> }> {
  const client = await mqtt.connectAsync(options.url, {
    protocolVersion: 5,
    clientId: options.serialNumber,
    username: options.serialNumber,
    password: options.password,
    clean: true,
    /**
     * The last will, registered at connect time and published by the broker if
     * this process vanishes without saying goodbye. Retained, unsigned, and
     * the reason the server never lets a status message move a lock state.
     */
    will: {
      topic: `safelock/v1/${options.serialNumber}/status`,
      payload: Buffer.from(JSON.stringify({ v: 1, online: false }), 'utf8'),
      qos: 1,
      retain: true,
    },
  });

  const handlers: Array<{
    filter: string;
    handler: (message: { topic: string; payload: Buffer }) => void | Promise<void>;
  }> = [];

  client.on('message', (topic, payload) => {
    for (const entry of handlers) {
      if (entry.filter === topic) void entry.handler({ topic, payload });
    }
  });

  return {
    transport: {
      async publish(topic, payload, publishOptions) {
        try {
          await client.publishAsync(topic, payload, publishOptions);
          return true;
        } catch (cause) {
          // A refused publish is the ACL working. Reported, never thrown: the
          // simulator's job is to tell us what the broker did.
          logger.warn(
            { topic, reason: cause instanceof Error ? cause.message : 'unknown' },
            'The broker refused a publish',
          );
          return false;
        }
      },
      async subscribe(filter, handler) {
        handlers.push({ filter, handler });
        await client.subscribeAsync(filter, { qos: 1 });
      },
    },
    end: () => client.endAsync(false),
  };
}

async function main(): Promise<void> {
  if (env.NODE_ENV === 'production') {
    throw new Error('The device simulator must never run in production');
  }

  const options = parseArgs(process.argv.slice(2));
  const { transport, end } = await connectTransport(options);

  const device = new SimulatedDevice({ serialNumber: options.serialNumber, transport });

  // Armed for the whole run rather than for one command: a developer watching
  // a dashboard wants the behaviour to persist while they look at it.
  for (const kind of options.misbehaviours) {
    device.misbehave(kind, { times: Infinity });
  }

  await device.connect();

  logger.info(
    {
      serialNumber: options.serialNumber,
      url: options.url,
      misbehaviours: options.misbehaviours,
    },
    'Simulated safe online',
  );

  const heartbeat = setInterval(() => {
    void device.heartbeat().catch((cause: unknown) => {
      logger.error(
        { reason: cause instanceof Error ? cause.message : 'unknown' },
        'Heartbeat failed',
      );
    });
  }, options.heartbeatMs);

  const shutdown = async (): Promise<void> => {
    clearInterval(heartbeat);
    await device.disconnectCleanly();
    await end();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((error: unknown) => {
  logger.error(
    { reason: error instanceof Error ? error.message : 'unknown' },
    'The device simulator could not start',
  );
  process.exit(1);
});
