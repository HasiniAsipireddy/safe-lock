import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ackPayloadSchema,
  ackResultMatchesReason,
  buildCommandPayload,
  canonicalAck,
  canonicalCommand,
  canonicalState,
  deriveCommandKey,
  deviceTopic,
  hashDeviceCredential,
  mintDeviceCredential,
  parseDeviceTopic,
  parsePayload,
  signCanonical,
  statePayloadSchema,
  statusPayloadSchema,
  verifyAckSignature,
  verifyCanonical,
  verifyStateSignature,
} from './index';

/**
 * The protocol layer, tested without a broker, a database or a device.
 *
 * These are the checks that make a compromised broker survivable, so they are
 * worth asserting directly rather than only through an integration path: an
 * end-to-end unlock test passes whether the signature is checked properly or
 * not, because the happy path has a valid signature either way.
 */

const SERIAL = 'SAFE-0001';
const OTHER_SERIAL = 'SAFE-0002';

const key = (serial = SERIAL, version = 1) => deriveCommandKey(serial, version);

function validCommand(overrides: Partial<Parameters<typeof buildCommandPayload>[0]> = {}) {
  return buildCommandPayload({
    key: key(),
    keyVersion: 1,
    commandId: 'cmd_test_0001',
    type: 'UNLOCK',
    serialNumber: SERIAL,
    seq: 42,
    issuedAt: new Date('2026-10-19T12:00:00.000Z'),
    ttlMs: 15_000,
    ...overrides,
  });
}

/** An ack the device would send, signed under whichever key is given. */
function signedAck(
  overrides: Partial<{
    signingKey: Buffer;
    commandId: string;
    seq: number;
    result: 'OK' | 'REJECTED' | 'FAILED';
    reason: string | null;
    lockState: 'LOCKED' | 'UNLOCKED' | 'UNKNOWN';
    doorState: 'CLOSED' | 'OPEN' | 'UNKNOWN';
    bootId: string;
    measuredAtUptimeMs: number;
  }> = {},
) {
  const body = {
    commandId: overrides.commandId ?? 'cmd_test_0001',
    seq: overrides.seq ?? 42,
    result: overrides.result ?? ('OK' as const),
    reason: overrides.reason ?? null,
    lockState: overrides.lockState ?? ('UNLOCKED' as const),
    doorState: overrides.doorState ?? ('CLOSED' as const),
    bootId: overrides.bootId ?? 'a3f1b2c4',
    measuredAtUptimeMs: overrides.measuredAtUptimeMs ?? 918_273,
  };

  return {
    v: 1,
    ...body,
    sig: signCanonical(overrides.signingKey ?? key(), canonicalAck(body)),
  };
}

describe('command key derivation', () => {
  it('derives a different key per device', () => {
    expect(key(SERIAL).equals(key(OTHER_SERIAL))).toBe(false);
  });

  it('derives a different key per key version, so rotation is possible', () => {
    expect(key(SERIAL, 1).equals(key(SERIAL, 2))).toBe(false);
  });

  it('is deterministic, since nothing per-device is stored to look up', () => {
    expect(key(SERIAL).equals(key(SERIAL))).toBe(true);
  });

  it('never returns the master secret itself', () => {
    const master = process.env.DEVICE_COMMAND_HMAC_SECRET ?? '';
    expect(master).not.toBe('');
    expect(key().toString('utf8')).not.toContain(master);
    expect(key().toString('base64url')).not.toContain(master);
  });
});

describe('canonical strings', () => {
  it('are pipe-joined field lists, not JSON', () => {
    const canonical = canonicalCommand({
      keyVersion: 1,
      commandId: 'cmd_1',
      type: 'UNLOCK',
      serialNumber: SERIAL,
      seq: 7,
      issuedAt: new Date('2026-10-19T12:00:00.000Z'),
      ttlMs: 15_000,
    });

    expect(canonical).toBe(
      `safelock-cmd:v1|1|cmd_1|UNLOCK|${SERIAL}|7|1792411200000|15000`,
    );
  });

  it('renders a null field as "-" rather than an empty segment', () => {
    const withReason = canonicalAck({
      commandId: 'c',
      seq: 1,
      result: 'FAILED',
      reason: 'JAMMED',
      lockState: 'LOCKED',
      doorState: 'OPEN',
      bootId: 'b',
      measuredAtUptimeMs: 5,
    });
    const withoutReason = canonicalAck({
      commandId: 'c',
      seq: 1,
      result: 'OK',
      reason: null,
      lockState: 'LOCKED',
      doorState: 'OPEN',
      bootId: 'b',
      measuredAtUptimeMs: 5,
    });

    expect(withReason).toContain('|JAMMED|');
    expect(withoutReason).toContain('|-|');
    // The field count must not change with presence, or the string would be
    // ambiguous about which field was omitted.
    expect(withReason.split('|')).toHaveLength(withoutReason.split('|').length);
  });

  it('refuses a field containing a pipe, which could impersonate two fields', () => {
    expect(() =>
      canonicalAck({
        commandId: 'c|LOCKED',
        seq: 1,
        result: 'OK',
        reason: null,
        lockState: 'LOCKED',
        doorState: 'CLOSED',
        bootId: 'b',
        measuredAtUptimeMs: 1,
      }),
    ).toThrow(/may not contain/);
  });

  /**
   * Domain separation. Three message types share one key, so a signature over
   * one must never verify as another — otherwise a captured state report
   * could be replayed as an ack.
   */
  it('gives each message type its own prefix', () => {
    const k = key();

    const ack = canonicalAck({
      commandId: 'x',
      seq: 1,
      result: 'OK',
      reason: null,
      lockState: 'LOCKED',
      doorState: 'CLOSED',
      bootId: 'b',
      measuredAtUptimeMs: 1,
    });
    const state = canonicalState({
      lockState: 'LOCKED',
      doorState: 'CLOSED',
      firmwareVersion: '1.0.0',
      lastSeq: 1,
      bootId: 'b',
      uptimeMs: 1,
      reason: 'BOOT',
    });

    expect(ack.startsWith('safelock-ack:v1|')).toBe(true);
    expect(state.startsWith('safelock-state:v1|')).toBe(true);
    expect(verifyCanonical(k, ack, signCanonical(k, state))).toBe(false);
  });
});

describe('signature verification', () => {
  it('accepts a signature made with the same key', () => {
    const k = key();
    expect(verifyCanonical(k, 'hello', signCanonical(k, 'hello'))).toBe(true);
  });

  it('rejects a signature made with another device key', () => {
    expect(
      verifyCanonical(key(SERIAL), 'hello', signCanonical(key(OTHER_SERIAL), 'hello')),
    ).toBe(false);
  });

  /**
   * Every malformed shape answers false rather than throwing. A forged device
   * report must produce a shrug, not a 500 and a stack trace.
   */
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an empty string', ''],
    ['a number', 1234],
    ['an object', { sig: 'x' }],
    ['the wrong length', 'AAAA'],
    ['a truncated signature', signCanonical(key(), 'hello').slice(0, 20)],
  ])('rejects %s without throwing', (_label, provided) => {
    expect(verifyCanonical(key(), 'hello', provided)).toBe(false);
  });
});

describe('ack payloads', () => {
  it('verifies a well-formed, correctly signed ack', () => {
    const parsed = ackPayloadSchema.parse(signedAck());
    expect(verifyAckSignature(key(), parsed)).toBe(true);
  });

  it('refuses an ack signed by a different device', () => {
    const parsed = ackPayloadSchema.parse(signedAck({ signingKey: key(OTHER_SERIAL) }));
    expect(verifyAckSignature(key(SERIAL), parsed)).toBe(false);
  });

  /**
   * The measured state is inside the signature, so a broker cannot rewrite the
   * security record while leaving the result intact — show `LOCKED` on a safe
   * standing open, say.
   */
  it('refuses an ack whose lock state was altered after signing', () => {
    const ack = signedAck({ lockState: 'UNLOCKED' });
    const tampered = ackPayloadSchema.parse({ ...ack, lockState: 'LOCKED' });

    expect(verifyAckSignature(key(), tampered)).toBe(false);
  });

  it('rejects an unknown field rather than ignoring it', () => {
    const result = ackPayloadSchema.safeParse({ ...signedAck(), masterCode: '1234' });
    expect(result.success).toBe(false);
  });

  it('rejects a payload at the wrong protocol version', () => {
    expect(ackPayloadSchema.safeParse({ ...signedAck(), v: 2 }).success).toBe(false);
  });

  it('treats a nullable door state as a missing field, not a closed door', () => {
    const ack = signedAck();
    expect(ackPayloadSchema.safeParse({ ...ack, doorState: null }).success).toBe(false);
  });
});

describe('ack result and reason must agree', () => {
  it.each([
    ['OK with no reason', 'OK', null, true],
    ['OK carrying a reason', 'OK', 'JAMMED', false],
    ['REJECTED with a refusal reason', 'REJECTED', 'SEQ_REPLAY', true],
    ['REJECTED with a mechanism reason', 'REJECTED', 'MOTOR_FAULT', false],
    ['FAILED with a mechanism reason', 'FAILED', 'JAMMED', true],
    ['FAILED with a refusal reason', 'FAILED', 'BAD_SIGNATURE', false],
    ['REJECTED with no reason', 'REJECTED', null, false],
    ['FAILED with no reason', 'FAILED', null, false],
  ] as const)('%s', (_label, result, reason, expected) => {
    expect(
      ackResultMatchesReason(
        result,
        reason as Parameters<typeof ackResultMatchesReason>[1],
      ),
    ).toBe(expected);
  });

  /**
   * Enforced by the schema and not only by the helper, so a mismatched ack is
   * dropped at parse time and never reaches a handler that might interpret
   * half of it.
   */
  it('is enforced by the schema', () => {
    const ack = signedAck({ result: 'REJECTED', reason: 'MOTOR_FAULT' });
    expect(ackPayloadSchema.safeParse(ack).success).toBe(false);
  });
});

describe('state payloads', () => {
  const stateBody = {
    lockState: 'LOCKED' as const,
    doorState: 'CLOSED' as const,
    firmwareVersion: '1.0.3',
    lastSeq: 42,
    bootId: 'a3f1b2c4',
    uptimeMs: 918_273,
    reason: 'HEARTBEAT' as const,
  };

  const signedState = (signingKey = key()) => ({
    v: 1,
    ...stateBody,
    rssi: -62,
    clockSynced: true,
    sig: signCanonical(signingKey, canonicalState(stateBody)),
  });

  it('verifies a correctly signed state report', () => {
    const parsed = statePayloadSchema.parse(signedState());
    expect(verifyStateSignature(key(), parsed)).toBe(true);
  });

  it('refuses one signed by another device', () => {
    const parsed = statePayloadSchema.parse(signedState(key(OTHER_SERIAL)));
    expect(verifyStateSignature(key(SERIAL), parsed)).toBe(false);
  });

  it('rejects an implausible rssi rather than storing it', () => {
    expect(statePayloadSchema.safeParse({ ...signedState(), rssi: 500 }).success).toBe(
      false,
    );
  });

  it('accepts clockSynced false — a device with no time source is not degraded', () => {
    const parsed = statePayloadSchema.safeParse({
      ...signedState(),
      clockSynced: false,
    });
    expect(parsed.success).toBe(true);
  });
});

describe('status payloads', () => {
  it('accepts the minimal last-will shape', () => {
    expect(statusPayloadSchema.safeParse({ v: 1, online: false }).success).toBe(true);
  });

  /**
   * Status is the one unsigned message, so it must not be able to carry
   * anything that moves a lock state. The schema is `.strict()`, which is
   * what enforces that: a `lockState` field here would simply be refused.
   */
  it('refuses a lock state, which it has no authority to report', () => {
    expect(
      statusPayloadSchema.safeParse({ v: 1, online: true, lockState: 'UNLOCKED' })
        .success,
    ).toBe(false);
  });
});

describe('command payloads', () => {
  it('repeats the serial inside the signed payload', () => {
    const payload = validCommand();
    expect(payload.serial).toBe(SERIAL);

    /**
     * Lifting a command from one topic to another must fail. Re-verifying the
     * signature against the *other* device's serial and key is exactly what
     * that device's firmware does on receipt.
     */
    const asOtherDevice = canonicalCommand({
      keyVersion: payload.kv,
      commandId: payload.commandId,
      type: payload.type,
      serialNumber: OTHER_SERIAL,
      seq: payload.seq,
      issuedAt: new Date(payload.issuedAt),
      ttlMs: payload.ttlMs,
    });

    expect(verifyCanonical(key(OTHER_SERIAL), asOtherDevice, payload.sig)).toBe(false);
  });

  it('carries the key version, so a rotated fleet can be mixed', () => {
    expect(validCommand({ keyVersion: 2, key: key(SERIAL, 2) }).kv).toBe(2);
  });

  it('never includes anything about the user, booking or payment', () => {
    const payload = validCommand();
    const keys = Object.keys(payload).sort();

    expect(keys).toEqual([
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
});

describe('topics', () => {
  it('builds a topic from the serial, never the database id', () => {
    expect(deviceTopic(SERIAL, 'cmd')).toBe('safelock/v1/SAFE-0001/cmd');
  });

  it('round-trips an inbound topic', () => {
    expect(parseDeviceTopic('safelock/v1/SAFE-0001/ack')).toEqual({
      serialNumber: SERIAL,
      kind: 'ack',
    });
  });

  /**
   * A topic segment is attacker-influenced input in the way a path parameter
   * is, and the serial taken from it becomes a database lookup key and a
   * signing input.
   */
  it.each([
    ['the command topic, which a device may not publish to', 'safelock/v1/SAFE-0001/cmd'],
    ['an unknown kind', 'safelock/v1/SAFE-0001/unlock'],
    ['a wrong protocol version', 'safelock/v2/SAFE-0001/ack'],
    ['a malformed serial', 'safelock/v1/../ack'],
    ['a serial that fails the inventory pattern', 'safelock/v1/NOTASAFE/ack'],
    ['extra segments', 'safelock/v1/SAFE-0001/ack/extra'],
    ['an empty topic', ''],
  ])('refuses %s', (_label, topic) => {
    expect(parseDeviceTopic(topic)).toBeNull();
  });
});

describe('payload parsing', () => {
  it('returns null for bytes that are not JSON', () => {
    expect(parsePayload(statusPayloadSchema, Buffer.from('not json'))).toBeNull();
  });

  it('returns null for JSON that is not this message', () => {
    expect(parsePayload(statusPayloadSchema, '{"hello":"world"}')).toBeNull();
  });

  it('parses a valid payload', () => {
    expect(parsePayload(statusPayloadSchema, '{"v":1,"online":true}')).toEqual({
      v: 1,
      online: true,
    });
  });
});

describe('device credentials', () => {
  it('stores only a digest of the minted password', () => {
    const { password, hash } = mintDeviceCredential();

    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain(password);
    expect(hashDeviceCredential(password)).toBe(hash);
  });

  it('mints a distinct credential every time', () => {
    const first = mintDeviceCredential();
    const second = mintDeviceCredential();

    expect(first.password).not.toBe(second.password);
  });

  it('mints enough entropy that the unkeyed digest is not enumerable', () => {
    // 32 random bytes is why sha256 is correct here and would not be for a
    // 6-digit code: there is no input space to walk.
    expect(Buffer.from(mintDeviceCredential().password, 'base64url')).toHaveLength(32);
  });
});

describe('signing is not reversible from what we store', () => {
  /**
   * The server stores no device key at all, which is the property worth
   * asserting: a leak of every row yields nothing that can sign a command.
   */
  it('derives the same key from the master secret alone', () => {
    const derived = deriveCommandKey(SERIAL, 1);
    const again = crypto
      .createHmac('sha256', process.env.DEVICE_COMMAND_HMAC_SECRET ?? '')
      .update(`safelock:device-cmd:v1:1:${SERIAL}`)
      .digest();

    expect(derived.equals(again)).toBe(true);
  });
});
