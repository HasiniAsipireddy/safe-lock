import { z } from 'zod';
import { env, isTest } from '../../config/env';
import { logger } from '../logger';
import { recordSensorReading } from '../../modules/devices/sensor.service';
import {
  recordSecurityReading,
  type SecurityReadingInput,
} from '../../modules/devices/security.service';
import type { SimulationScenario } from '@safelock/shared';
import {
  canonicalAck,
  canonicalState,
  deriveCommandKey,
  signCanonical,
} from '../deviceProtocol';
import {
  DeviceCommandError,
  type DeviceGateway,
  type DeviceInboundHandler,
  type OutboundCommand,
  type PublishResult,
} from './gateway';
import { SimulatedEsp32 } from './simulatedEsp32';

/**
 * One ESP32 on the local network, reached over plain HTTP by its IP address.
 *
 * ## What this is, and what it is not
 * A **demo bridge** for the college prototype, selected with
 * `DEVICE_GATEWAY=http` and refused in production by the env schema. The
 * production contract is `docs/device-protocol.md` (signed MQTT); this
 * gateway exists so a stock ESP32 sketch with a relay and a DHT22 can be
 * driven by the real app without implementing that protocol in firmware.
 *
 * It stands where the broker would and **translates**: it calls the ESP32's
 * `/lock`, `/unlock` and `/state` endpoints, then hands the inbound handler
 * the same signed ack and state messages a real device would publish, signed
 * with the device's derived `K_d` — the same move `MockDeviceGateway` makes.
 * Everything above the gateway (command rows, sequence numbers, OTP, audit,
 * history, reconcile of an unexpected unlock) runs unchanged.
 *
 * ## The weaker guarantees, stated
 * - The ESP32 authenticates the API with a **shared token** (`X-Device-Token`)
 *   over **unencrypted** HTTP. Anyone on the same Wi-Fi who sniffs one request
 *   has the token. Acceptable on an isolated demo hotspot, nowhere else.
 * - There is no per-command signature or sequence check on the device, so a
 *   captured `/unlock` request can be replayed on that LAN.
 * - The door sensor is a **reed switch** reported as `doorOpen`. Firmware
 *   built without one omits the field and the gateway reports `CLOSED`, as
 *   the mock does, or every safe would be unbookable — a claim that hardware
 *   cannot back.
 * - `vibration` is latched by the firmware between polls, so a knock shorter
 *   than the poll interval is still seen. Door and vibration feed tamper
 *   detection (`security.service.ts`); neither is part of the signed protocol.
 *
 * ## Failure behaviour
 * An HTTP error or timeout on `/lock` / `/unlock` throws, so the command is
 * marked `EXPIRED`. If the request in fact reached the relay before the
 * timeout, the next `/state` poll (every `ESP32_POLL_MS`) records the
 * measured state, and the reconcile in `inbound.service.ts` re-locks a safe
 * that is open with nobody entitled to it.
 */

/** What the firmware's `/state` endpoint returns. */
const esp32StateSchema = z.object({
  lockState: z.enum(['LOCKED', 'UNLOCKED']),
  rssi: z.number().int().min(-200).max(0).catch(-100),
  uptimeMs: z.number().int().min(0),
  bootId: z.string().regex(/^[A-Za-z0-9_-]{4,64}$/),
  firmware: z.string().regex(/^[A-Za-z0-9._+-]{1,32}$/).catch('esp32-http'),
  sensorValid: z.boolean(),
  temperature: z.number().finite().nullable().optional(),
  humidity: z.number().finite().nullable().optional(),
  /** Absent on firmware without a reed switch. */
  doorOpen: z.boolean().optional(),
  /** Any vibration since the previous `/state`. Absent without a sensor. */
  vibration: z.boolean().optional(),
});

type Esp32State = z.infer<typeof esp32StateSchema>;

/** What `/lock` and `/unlock` return. */
const esp32CommandSchema = z.object({
  lockState: z.enum(['LOCKED', 'UNLOCKED']),
  uptimeMs: z.number().int().min(0),
  bootId: z.string().regex(/^[A-Za-z0-9_-]{4,64}$/),
  doorOpen: z.boolean().optional(),
});

/** The door as the protocol states it. No sensor reads as CLOSED; see above. */
function doorStateOf(doorOpen: boolean | undefined): 'OPEN' | 'CLOSED' {
  return doorOpen === true ? 'OPEN' : 'CLOSED';
}

/** Consecutive failed polls before we tell the server the unit is offline. */
const OFFLINE_AFTER_FAILED_POLLS = 3;

export interface HttpGatewayOptions {
  baseUrl: string;
  token: string;
  serialNumber: string;
  pollMs: number;
  timeoutMs: number;
  /** Injected so tests never touch the network (`test/setup.ts` forbids it). */
  fetchImpl?: typeof fetch;
  /** Where sensor readings go. Defaults to the `Device` row. */
  recordSensor?: (reading: SensorReading) => Promise<void>;
  /** Where door/vibration readings go. Defaults to tamper detection. */
  recordSecurity?: (reading: SecurityReadingInput) => Promise<void>;
  /** Delay before a relayed ack is handled, so the command is `SENT` first. */
  ackDelayMs?: number;
}

export interface SensorReading {
  serialNumber: string;
  temperatureC: number;
  humidityPct: number;
  readAt: Date;
}

/**
 * The latest reading, the thinned history and any alert — see
 * `sensor.service.ts`. Swallowed on failure: this runs inside the state poll,
 * and a telemetry write failing must not count as a missed heartbeat.
 */
async function recordSecurityOnDevice(reading: SecurityReadingInput): Promise<void> {
  try {
    await recordSecurityReading(reading);
  } catch (cause) {
    logger.error(
      {
        serialNumber: reading.serialNumber,
        reason: cause instanceof Error ? cause.message : 'unknown',
      },
      'Could not record a security reading',
    );
  }
}

async function recordSensorOnDevice(reading: SensorReading): Promise<void> {
  try {
    await recordSensorReading(reading);
  } catch (cause) {
    logger.error(
      {
        serialNumber: reading.serialNumber,
        reason: cause instanceof Error ? cause.message : 'unknown',
      },
      'Could not record a sensor reading',
    );
  }
}

export class HttpDeviceGateway implements DeviceGateway {
  readonly name: string = 'http';

  private handler: DeviceInboundHandler | null = null;

  private timer: NodeJS.Timeout | null = null;

  private polling = false;

  private failedPolls = 0;

  private lastSeq = 0;

  /** The key version state reports are signed at; follows the last command's. */
  private keyVersion = env.DEVICE_COMMAND_KEY_VERSION;

  private readonly pending = new Set<Promise<void>>();

  private readonly options: Required<HttpGatewayOptions>;

  /** The in-process board, when this gateway is `DEVICE_GATEWAY=sim`. */
  private board: SimulatedEsp32 | null = null;

  constructor(options: HttpGatewayOptions) {
    this.options = {
      fetchImpl: (...args) => fetch(...args),
      recordSensor: recordSensorOnDevice,
      recordSecurity: recordSecurityOnDevice,
      ackDelayMs: isTest ? 0 : 200,
      ...options,
      baseUrl: options.baseUrl.replace(/\/+$/, ''),
    };
  }

  static fromEnv(): HttpDeviceGateway {
    // Presence is guaranteed by the env schema's superRefine.
    return new HttpDeviceGateway({
      baseUrl: env.ESP32_URL ?? '',
      token: env.ESP32_TOKEN ?? '',
      serialNumber: env.ESP32_SERIAL,
      pollMs: env.ESP32_POLL_MS,
      timeoutMs: env.ESP32_TIMEOUT_MS,
    });
  }

  /**
   * `DEVICE_GATEWAY=sim`: the same gateway, driving an in-process
   * {@link SimulatedEsp32} instead of a board on the network.
   */
  static simulated(): HttpDeviceGateway {
    const token = 'simulated-esp32-token';
    const board = new SimulatedEsp32(token, { heatSpike: env.SIM_HEAT_SPIKE });

    const gateway = new HttpDeviceGateway({
      baseUrl: 'http://simulated-esp32.local',
      token,
      serialNumber: env.ESP32_SERIAL,
      pollMs: env.ESP32_POLL_MS,
      timeoutMs: env.ESP32_TIMEOUT_MS,
      fetchImpl: board.fetch,
    });
    gateway.board = board;
    return gateway;
  }

  /** The serial of the simulated board, or null for real hardware. */
  get simulatedSerial(): string | null {
    return this.board ? this.options.serialNumber : null;
  }

  /**
   * Makes the simulated board misbehave, then polls at once so the result
   * travels the ordinary path — state report, tamper detection, alerts —
   * without waiting for the next tick. Refused for real hardware.
   */
  async simulate(scenario: SimulationScenario): Promise<void> {
    if (!this.board) throw new Error('Not a simulated board');
    this.board.trigger(scenario);
    await this.pollOnce();
  }

  async start(handler: DeviceInboundHandler): Promise<void> {
    this.handler = handler;
    logger.info(
      { gateway: this.name, url: this.options.baseUrl, serialNumber: this.options.serialNumber },
      'ESP32 HTTP gateway started',
    );
    await this.pollOnce();
    this.timer = setInterval(() => void this.pollOnce(), this.options.pollMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.drain();
    this.handler = null;
  }

  async drain(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }

  sendLock(command: OutboundCommand): Promise<PublishResult> {
    return this.command(command, 'lock', 'LOCKED');
  }

  sendUnlock(command: OutboundCommand): Promise<PublishResult> {
    return this.command(command, 'unlock', 'UNLOCKED');
  }

  /** One poll of `/state`. Never throws: a failed poll is a missed heartbeat. */
  async pollOnce(): Promise<void> {
    if (this.polling || !this.handler) return;
    this.polling = true;

    try {
      const state = esp32StateSchema.parse(await this.request('GET', '/state'));
      this.failedPolls = 0;

      await this.deliver('state', this.buildState(state));

      if (state.doorOpen !== undefined || state.vibration !== undefined) {
        await this.options.recordSecurity({
          serialNumber: this.options.serialNumber,
          lockState: state.lockState,
          doorOpen: state.doorOpen ?? null,
          vibration: state.vibration ?? false,
          at: new Date(),
        });
      }

      if (
        state.sensorValid &&
        typeof state.temperature === 'number' &&
        typeof state.humidity === 'number'
      ) {
        await this.options.recordSensor({
          serialNumber: this.options.serialNumber,
          temperatureC: state.temperature,
          humidityPct: state.humidity,
          readAt: new Date(),
        });
      }
    } catch (cause) {
      this.failedPolls += 1;

      if (this.failedPolls === 1 || this.failedPolls === OFFLINE_AFTER_FAILED_POLLS) {
        logger.warn(
          {
            gateway: this.name,
            serialNumber: this.options.serialNumber,
            failedPolls: this.failedPolls,
            reason: cause instanceof Error ? cause.message : 'unknown',
          },
          'ESP32 did not answer a state poll',
        );
      }

      if (this.failedPolls === OFFLINE_AFTER_FAILED_POLLS) {
        await this.deliver('status', { v: 1, online: false });
      }
    } finally {
      this.polling = false;
    }
  }

  private async command(
    command: OutboundCommand,
    path: 'lock' | 'unlock',
    target: 'LOCKED' | 'UNLOCKED',
  ): Promise<PublishResult> {
    logger.info(
      {
        gateway: this.name,
        serialNumber: command.serialNumber,
        commandId: command.commandId,
        seq: command.seq,
      },
      `Sending ${path} to the ESP32`,
    );

    if (command.serialNumber !== this.options.serialNumber) {
      // One gateway, one board. A command for another serial has nowhere to go.
      throw new DeviceCommandError(
        `No ESP32 configured for ${command.serialNumber} (ESP32_SERIAL is ${this.options.serialNumber})`,
      );
    }

    let measured: z.infer<typeof esp32CommandSchema>;
    try {
      measured = esp32CommandSchema.parse(await this.request('POST', `/${path}`));
    } catch (cause) {
      throw new DeviceCommandError(`ESP32 ${path} failed`, { cause });
    }

    const publishedAt = new Date();
    this.lastSeq = Math.max(this.lastSeq, command.seq);
    this.keyVersion = command.keyVersion;

    const ack = this.relayAck(command, target, measured);
    this.pending.add(ack);
    void ack.finally(() => this.pending.delete(ack));

    return { published: true, publishedAt };
  }

  private async relayAck(
    command: OutboundCommand,
    target: 'LOCKED' | 'UNLOCKED',
    measured: z.infer<typeof esp32CommandSchema>,
  ): Promise<void> {
    if (this.options.ackDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.options.ackDelayMs));
    }

    const reached = measured.lockState === target;
    const body = {
      commandId: command.commandId,
      seq: command.seq,
      result: reached ? ('OK' as const) : ('FAILED' as const),
      reason: reached ? null : ('MOTOR_FAULT' as const),
      // The measured state, not the requested one — see `lockState moves only on an ack`.
      lockState: measured.lockState,
      doorState: doorStateOf(measured.doorOpen),
      bootId: measured.bootId,
      measuredAtUptimeMs: measured.uptimeMs,
    };

    await this.deliver('ack', {
      v: 1,
      ...body,
      sig: signCanonical(
        deriveCommandKey(command.serialNumber, command.keyVersion),
        canonicalAck(body),
      ),
    });
  }

  private buildState(state: Esp32State) {
    const body = {
      lockState: state.lockState,
      doorState: doorStateOf(state.doorOpen),
      firmwareVersion: state.firmware,
      lastSeq: this.lastSeq,
      bootId: state.bootId,
      uptimeMs: state.uptimeMs,
      reason: 'HEARTBEAT' as const,
    };

    return {
      v: 1,
      ...body,
      rssi: state.rssi,
      clockSynced: false,
      sig: signCanonical(
        deriveCommandKey(this.options.serialNumber, this.keyVersion),
        canonicalState(body),
      ),
    };
  }

  private async deliver(kind: 'ack' | 'state' | 'status', message: object): Promise<void> {
    const handler = this.handler;
    if (!handler) return;

    try {
      await handler.handleMessage(
        this.options.serialNumber,
        kind,
        Buffer.from(JSON.stringify(message), 'utf8'),
      );
    } catch (cause) {
      logger.error(
        {
          gateway: this.name,
          kind,
          reason: cause instanceof Error ? cause.message : 'unknown',
        },
        'ESP32 message handler threw',
      );
    }
  }

  private async request(method: 'GET' | 'POST', path: string): Promise<unknown> {
    const response = await this.options.fetchImpl(`${this.options.baseUrl}${path}`, {
      method,
      headers: { 'X-Device-Token': this.options.token, Accept: 'application/json' },
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`ESP32 answered ${response.status} on ${path}`);
    }

    return response.json();
  }
}
