import { describe, expect, it, vi } from 'vitest';
import {
  ackPayloadSchema,
  deriveCommandKey,
  parsePayload,
  statePayloadSchema,
  statusPayloadSchema,
  verifyAckSignature,
  verifyStateSignature,
} from '../deviceProtocol';
import { DeviceCommandError, type DeviceInboundHandler, type OutboundCommand } from './gateway';
import type { SecurityReadingInput } from '../../modules/devices/security.service';
import { HttpDeviceGateway, type SensorReading } from './http.gateway';

const SERIAL = 'SAFE-0001';
const TOKEN = 'test-token-0123456789';

interface Delivered {
  kind: 'ack' | 'state' | 'status';
  raw: Buffer;
}

function harness(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const delivered: Delivered[] = [];
  const sensors: SensorReading[] = [];
  const security: SecurityReadingInput[] = [];
  const calls: Array<{ url: string; init: RequestInit }> = [];

  const handler: DeviceInboundHandler = {
    handleMessage: async (serialNumber, kind, raw) => {
      expect(serialNumber).toBe(SERIAL);
      delivered.push({ kind, raw });
    },
  };

  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return respond(url, init ?? {});
  }) as unknown as typeof fetch;

  const gateway = new HttpDeviceGateway({
    baseUrl: 'http://192.168.4.20/',
    token: TOKEN,
    serialNumber: SERIAL,
    pollMs: 60_000,
    timeoutMs: 1_000,
    fetchImpl,
    recordSensor: async (reading) => {
      sensors.push(reading);
    },
    recordSecurity: async (reading) => {
      security.push(reading);
    },
    ackDelayMs: 0,
  });

  return { gateway, handler, delivered, sensors, security, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const stateBody = {
  lockState: 'LOCKED',
  rssi: -61,
  uptimeMs: 12_345,
  bootId: 'a1b2c3d4e5f60718',
  firmware: 'esp32-http-1.0',
  sensorValid: true,
  temperature: 27.4,
  humidity: 61.2,
};

function command(seq: number): OutboundCommand {
  return {
    commandId: `cmd_${seq}`,
    serialNumber: SERIAL,
    seq,
    keyVersion: 1,
    issuedAt: new Date(),
    ttlMs: 15_000,
  };
}

describe('HttpDeviceGateway', () => {
  it('polls /state with the token and relays a signed state report plus the sensor reading', async () => {
    const h = harness(() => json(stateBody));
    await h.gateway.start(h.handler);
    await h.gateway.stop();

    expect(h.calls[0]?.url).toBe('http://192.168.4.20/state');
    expect((h.calls[0]?.init.headers as Record<string, string>)['X-Device-Token']).toBe(TOKEN);

    const state = h.delivered.find((d) => d.kind === 'state');
    expect(state).toBeDefined();
    const payload = parsePayload(statePayloadSchema, state!.raw);
    expect(payload).not.toBeNull();
    expect(payload!.lockState).toBe('LOCKED');
    expect(payload!.rssi).toBe(-61);
    expect(verifyStateSignature(deriveCommandKey(SERIAL, 1), payload!)).toBe(true);

    expect(h.sensors).toHaveLength(1);
    expect(h.sensors[0]).toMatchObject({ serialNumber: SERIAL, temperatureC: 27.4, humidityPct: 61.2 });
  });

  it('reports the reed switch as doorState and passes door and vibration to tamper detection', async () => {
    const h = harness(() => json({ ...stateBody, doorOpen: true, vibration: true }));
    await h.gateway.start(h.handler);
    await h.gateway.stop();

    const state = h.delivered.find((d) => d.kind === 'state');
    const payload = parsePayload(statePayloadSchema, state!.raw);
    expect(payload!.doorState).toBe('OPEN');
    // Signed over the real door state, so the server accepts it.
    expect(verifyStateSignature(deriveCommandKey(SERIAL, 1), payload!)).toBe(true);

    expect(h.security).toHaveLength(1);
    expect(h.security[0]).toMatchObject({
      serialNumber: SERIAL,
      lockState: 'LOCKED',
      doorOpen: true,
      vibration: true,
    });
  });

  it('treats firmware without door or vibration sensors as a closed door, with no tamper check', async () => {
    const h = harness(() => json(stateBody));
    await h.gateway.start(h.handler);
    await h.gateway.stop();

    const payload = parsePayload(
      statePayloadSchema,
      h.delivered.find((d) => d.kind === 'state')!.raw,
    );
    expect(payload!.doorState).toBe('CLOSED');
    expect(h.security).toHaveLength(0);
  });

  it('does not record a sensor reading the ESP32 marked invalid', async () => {
    const h = harness(() =>
      json({ ...stateBody, sensorValid: false, temperature: null, humidity: null }),
    );
    await h.gateway.start(h.handler);
    await h.gateway.stop();

    expect(h.delivered.some((d) => d.kind === 'state')).toBe(true);
    expect(h.sensors).toHaveLength(0);
  });

  it('POSTs /unlock and relays a signed OK ack carrying the measured state', async () => {
    const h = harness((url) =>
      url.endsWith('/unlock')
        ? json({ lockState: 'UNLOCKED', uptimeMs: 20_000, bootId: 'a1b2c3d4e5f60718' })
        : json(stateBody),
    );
    await h.gateway.start(h.handler);

    const result = await h.gateway.sendUnlock(command(7));
    await h.gateway.stop();

    expect(result.published).toBe(true);
    const unlockCall = h.calls.find((c) => c.url.endsWith('/unlock'));
    expect(unlockCall?.init.method).toBe('POST');

    const ack = h.delivered.find((d) => d.kind === 'ack');
    const payload = parsePayload(ackPayloadSchema, ack!.raw);
    expect(payload).toMatchObject({ commandId: 'cmd_7', seq: 7, result: 'OK', lockState: 'UNLOCKED' });
    expect(verifyAckSignature(deriveCommandKey(SERIAL, 1), payload!)).toBe(true);
  });

  it('acks FAILED with the measured state when the relay did not reach the target', async () => {
    const h = harness((url) =>
      url.endsWith('/lock')
        ? json({ lockState: 'UNLOCKED', uptimeMs: 1, bootId: 'a1b2c3d4e5f60718' })
        : json(stateBody),
    );
    await h.gateway.start(h.handler);
    await h.gateway.sendLock(command(3));
    await h.gateway.stop();

    const payload = parsePayload(ackPayloadSchema, h.delivered.find((d) => d.kind === 'ack')!.raw);
    expect(payload).toMatchObject({ result: 'FAILED', reason: 'MOTOR_FAULT', lockState: 'UNLOCKED' });
  });

  it('throws when the ESP32 refuses the token, so the command is never marked sent', async () => {
    const h = harness((url) =>
      url.endsWith('/unlock') ? json({ error: 'unauthorised' }, 401) : json(stateBody),
    );
    await h.gateway.start(h.handler);

    await expect(h.gateway.sendUnlock(command(9))).rejects.toBeInstanceOf(DeviceCommandError);
    await h.gateway.stop();
    expect(h.delivered.some((d) => d.kind === 'ack')).toBe(false);
  });

  it('refuses a command for a serial it is not configured for', async () => {
    const h = harness(() => json(stateBody));
    await h.gateway.start(h.handler);

    await expect(
      h.gateway.sendLock({ ...command(1), serialNumber: 'SAFE-0002' }),
    ).rejects.toBeInstanceOf(DeviceCommandError);
    await h.gateway.stop();
    expect(h.calls.some((c) => c.url.endsWith('/lock'))).toBe(false);
  });

  it('reports the unit offline after three consecutive failed polls, once', async () => {
    const h = harness(() => {
      throw new TypeError('fetch failed');
    });
    await h.gateway.start(h.handler);
    for (let i = 0; i < 4; i += 1) await h.gateway.pollOnce();
    await h.gateway.stop();

    const statuses = h.delivered.filter((d) => d.kind === 'status');
    expect(statuses).toHaveLength(1);
    expect(parsePayload(statusPayloadSchema, statuses[0]!.raw)).toEqual({ v: 1, online: false });
  });
});
