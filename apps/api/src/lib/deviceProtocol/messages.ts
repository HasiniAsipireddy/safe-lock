import { z } from 'zod';
import type { CommandFailureCategory } from '@safelock/shared';
import { canonicalAck, canonicalCommand, canonicalState } from './canonical';
import { signCanonical, verifyCanonical } from './sign';
import { PROTOCOL_VERSION } from './topics';

/**
 * What the server will accept from a device, and what it publishes to one.
 *
 * Every inbound payload is parsed by a **`.strict()`** zod schema before a
 * signature is even considered, for the same reason every request body is:
 * the alternative is a hand-rolled series of `typeof` checks that drifts from
 * what the firmware actually sends. An unknown key is a rejection rather than
 * a shrug — a device sending a field this protocol does not define is either
 * a version mismatch or something pretending to be a device, and both deserve
 * a look.
 *
 * Nothing here has a free-text field. Every reason, result and state is a
 * closed enum, so nothing unbounded from a radio can reach a database column
 * or a UI string.
 */

// --- Shared field shapes -----------------------------------------------------

const lockStateSchema = z.enum(['LOCKED', 'UNLOCKED', 'UNKNOWN']);
const doorStateSchema = z.enum(['CLOSED', 'OPEN', 'UNKNOWN']);

/**
 * Why the device refused, or how the mechanism failed.
 *
 * One enum with two groups, so a reason always implies its result — and the
 * server validates that it does (see {@link ackResultMatchesReason}). Two
 * separate enums would let a device report `MOTOR_FAULT` as a `REJECTED`,
 * which would record "nothing moved" about a bolt that had tried to.
 */
const REJECTION_REASONS = [
  'BAD_VERSION',
  'BAD_KEY_VERSION',
  'WRONG_DEVICE',
  'BAD_SIGNATURE',
  'SEQ_REPLAY',
  'DUPLICATE',
  'EXPIRED',
  'UNSUPPORTED',
] as const;

const MECHANISM_REASONS = [
  'MOTOR_FAULT',
  'JAMMED',
  'DOOR_OBSTRUCTED',
  'LOW_POWER',
  'SENSOR_FAULT',
] as const;

const ackReasonSchema = z.enum([...REJECTION_REASONS, ...MECHANISM_REASONS]);

export type AckReason = z.infer<typeof ackReasonSchema>;
export type AckResult = 'OK' | 'REJECTED' | 'FAILED';

/**
 * Whether a result and reason belong together.
 *
 * `OK` must carry no reason, `REJECTED` must carry a refusal reason, `FAILED`
 * must carry a mechanism reason. A mismatch is a malformed message and is
 * dropped — a device whose firmware disagrees with us about which group a
 * reason is in is a device whose acks we cannot interpret, and guessing which
 * half it meant would be guessing about whether a bolt moved.
 */
export function ackResultMatchesReason(
  result: AckResult,
  reason: AckReason | null | undefined,
): boolean {
  if (result === 'OK') return reason === null || reason === undefined;
  if (!reason) return false;

  return result === 'REJECTED'
    ? (REJECTION_REASONS as readonly string[]).includes(reason)
    : (MECHANISM_REASONS as readonly string[]).includes(reason);
}

/**
 * The device's reason, as the `Command.failureCategory` it maps to.
 *
 * A deliberate identity map rather than a cast. The two enums are the same
 * names today and the compiler is what keeps them so: adding a reason to the
 * wire protocol without deciding how it is recorded stops being possible.
 */
export function failureCategoryFor(reason: AckReason): CommandFailureCategory {
  return reason;
}

/**
 * `bootId` as the device sends it: an opaque hex token, bounded.
 *
 * Bounded because it is stored and displayed. A device is free to make it
 * meaningless, which is the point — it exists to be *different* after a
 * restart, not to be read.
 */
const bootIdSchema = z
  .string()
  .min(4)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'bootId must be an opaque token');

const signatureSchema = z.string().min(1).max(128);

/**
 * A monotonic uptime in milliseconds.
 *
 * Capped at roughly a century so a garbage value cannot reach a database
 * column as a plausible-looking integer, and non-negative because
 * `esp_timer_get_time()` starts at zero.
 */
const uptimeSchema = z.number().int().min(0).max(3_000_000_000_000);

const seqSchema = z.number().int().min(0).max(2_147_483_647);

/**
 * A firmware version, as a bounded opaque string.
 *
 * Deliberately not parsed into semver. It is displayed and compared for
 * equality, nothing more, and a device on a hand-built branch should still be
 * able to tell us what it is running rather than having its report rejected.
 */
const firmwareSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9._+-]+$/, 'firmwareVersion must be a plain version token');

// --- Ack ---------------------------------------------------------------------

export const ackPayloadSchema = z
  .object({
    v: z.literal(PROTOCOL_VERSION),
    commandId: z.string().min(1).max(64),
    seq: seqSchema,
    result: z.enum(['OK', 'REJECTED', 'FAILED']),
    reason: ackReasonSchema.nullable().optional(),
    /**
     * The **measured** physical state, not the requested one.
     *
     * That has a consequence worth stating: a `FAILED` ack reporting
     * `lockState: "UNLOCKED"` still moves `Device.lockState` to `UNLOCKED`.
     * The command failed; the safe is open; the dashboard must say the safe is
     * open. Recording the intent instead of the measurement is how a product
     * ends up telling someone their safe is locked while it stands open.
     */
    lockState: lockStateSchema,
    doorState: doorStateSchema,
    measuredAtUptimeMs: uptimeSchema,
    bootId: bootIdSchema,
    sig: signatureSchema,
  })
  .strict()
  .refine(
    (payload) => ackResultMatchesReason(payload.result, payload.reason ?? null),
    { message: 'ack reason does not match its result', path: ['reason'] },
  );

export type AckPayload = z.infer<typeof ackPayloadSchema>;

/** Whether an ack's signature was computed under this device's key. */
export function verifyAckSignature(key: Buffer, payload: AckPayload): boolean {
  return verifyCanonical(
    key,
    canonicalAck({
      commandId: payload.commandId,
      seq: payload.seq,
      result: payload.result,
      reason: payload.reason ?? null,
      lockState: payload.lockState,
      doorState: payload.doorState,
      bootId: payload.bootId,
      measuredAtUptimeMs: payload.measuredAtUptimeMs,
    }),
    payload.sig,
  );
}

// --- State -------------------------------------------------------------------

const stateReasonSchema = z.enum(['BOOT', 'CHANGE', 'HEARTBEAT', 'COMMAND']);

export const statePayloadSchema = z
  .object({
    v: z.literal(PROTOCOL_VERSION),
    lockState: lockStateSchema,
    doorState: doorStateSchema,
    firmwareVersion: firmwareSchema,
    /** dBm. Negative, and bounded well outside anything physically plausible. */
    rssi: z.number().int().min(-200).max(0),
    lastSeq: seqSchema,
    bootId: bootIdSchema,
    /**
     * Whether SNTP synced. Reported, shown to admins, and gates **nothing** —
     * replay protection comes from the sequence number, so a device with no
     * time source is not degraded.
     */
    clockSynced: z.boolean(),
    reason: stateReasonSchema,
    uptimeMs: uptimeSchema,
    sig: signatureSchema,
  })
  .strict();

export type StatePayload = z.infer<typeof statePayloadSchema>;

export function verifyStateSignature(key: Buffer, payload: StatePayload): boolean {
  return verifyCanonical(
    key,
    canonicalState({
      lockState: payload.lockState,
      doorState: payload.doorState,
      firmwareVersion: payload.firmwareVersion,
      lastSeq: payload.lastSeq,
      bootId: payload.bootId,
      uptimeMs: payload.uptimeMs,
      reason: payload.reason,
    }),
    payload.sig,
  );
}

// --- Status ------------------------------------------------------------------

/**
 * Liveness, and the only **unsigned** message in the protocol.
 *
 * Deliberately so. The last will and testament is composed by the device at
 * connect time and published by the *broker*, later — so the broker would have
 * to be trusted to hold a signature anyway, which defeats the purpose. And a
 * forged `online: false` is a denial of service a hostile broker can achieve
 * by simply dropping packets.
 *
 * Liveness is not a security claim here, which is why `online` is derived from
 * the heartbeat age as well: one retained flag is never the whole answer.
 * Nothing in this payload may move a lock state or settle a command.
 */
export const statusPayloadSchema = z
  .object({
    v: z.literal(PROTOCOL_VERSION),
    online: z.boolean(),
    bootId: bootIdSchema.optional(),
    firmwareVersion: firmwareSchema.optional(),
  })
  .strict();

export type StatusPayload = z.infer<typeof statusPayloadSchema>;

// --- Command (outbound) ------------------------------------------------------

export interface CommandPayload {
  v: number;
  kv: number;
  commandId: string;
  type: 'LOCK' | 'UNLOCK';
  serial: string;
  seq: number;
  issuedAt: string;
  ttlMs: number;
  sig: string;
}

/**
 * Builds the signed payload for one command.
 *
 * `serial` is repeated **inside** the signed canonical string, so a command
 * cannot be lifted from one device's topic to another's: a device checks the
 * field against its own identity, and the signature covers it, so neither can
 * be changed without the other.
 *
 * `issuedAt` is advisory and `ttlMs` is authoritative. A freshly booted ESP32
 * has no idea what time it is, so the device enforces the TTL from its
 * monotonic counter — available from the first instruction — and only applies
 * the `issuedAt` skew check once SNTP has synced. The TTL is not a security
 * control in any case: replay protection is `seq`.
 */
export function buildCommandPayload(input: {
  key: Buffer;
  keyVersion: number;
  commandId: string;
  type: 'LOCK' | 'UNLOCK';
  serialNumber: string;
  seq: number;
  issuedAt: Date;
  ttlMs: number;
}): CommandPayload {
  const canonical = canonicalCommand({
    keyVersion: input.keyVersion,
    commandId: input.commandId,
    type: input.type,
    serialNumber: input.serialNumber,
    seq: input.seq,
    issuedAt: input.issuedAt,
    ttlMs: input.ttlMs,
  });

  return {
    v: PROTOCOL_VERSION,
    kv: input.keyVersion,
    commandId: input.commandId,
    type: input.type,
    serial: input.serialNumber,
    seq: input.seq,
    issuedAt: input.issuedAt.toISOString(),
    ttlMs: input.ttlMs,
    sig: signCanonical(input.key, canonical),
  };
}

/**
 * Parses an inbound payload buffer, or returns null.
 *
 * One place for "the bytes were not JSON" and "the JSON was not this message",
 * because the caller's answer to both is identical: drop it, audit it, and do
 * not let it touch a device row. A malformed message from a radio is not an
 * exception to propagate — it is Tuesday.
 */
export function parsePayload<T>(
  schema: z.ZodType<T>,
  raw: Buffer | string,
): T | null {
  let json: unknown;

  try {
    json = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
  } catch {
    return null;
  }

  const parsed = schema.safeParse(json);
  return parsed.success ? parsed.data : null;
}
