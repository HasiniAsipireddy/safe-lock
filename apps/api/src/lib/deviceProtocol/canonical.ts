/**
 * The canonical strings every signature is computed over.
 *
 * **Never over the JSON.** JSON is not canonical: key order, whitespace,
 * unicode escaping and number formatting all vary by serialiser, so signing
 * the bytes a particular library happened to produce would make the protocol
 * depend on that library at both ends — and one end is firmware written in C
 * against a different JSON implementation. A pipe-joined field list is
 * unambiguous, trivial to build without a parser, and cannot be made to parse
 * differently by a whitespace change.
 *
 * Each has its own prefix, so a signature computed under one device's key can
 * never be lifted from a command to an ack or a state report. Without that,
 * three message types sharing a key would be one key signing three
 * interchangeable things.
 */

/** A field that is absent in a canonical string. Never an empty segment. */
const ABSENT = '-';

/**
 * Null and empty string both render as `-`, so a missing field cannot be
 * confused with a present-but-empty one — and more importantly, so a field
 * cannot be made to *disappear* from the string by sending it empty, which is
 * how a pipe-joined canonicalisation gets attacked.
 */
function field(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return ABSENT;

  /**
   * A pipe inside a value would let one field impersonate two.
   *
   * Every value in this protocol is an id, an enum member or a number, so this
   * is unreachable today — which is exactly why it is worth refusing rather
   * than escaping. An escape scheme is a thing firmware has to implement
   * identically; a refusal is a bug report.
   */
  if (value.includes('|')) {
    throw new Error('A canonical signing field may not contain "|"');
  }

  return value;
}

/** Command: `safelock-cmd:v1|kv|commandId|type|serial|seq|issuedAtMs|ttlMs` */
export function canonicalCommand(input: {
  keyVersion: number;
  commandId: string;
  type: 'LOCK' | 'UNLOCK';
  serialNumber: string;
  seq: number;
  issuedAt: Date;
  ttlMs: number;
}): string {
  return [
    'safelock-cmd:v1',
    input.keyVersion,
    field(input.commandId),
    field(input.type),
    field(input.serialNumber),
    input.seq,
    input.issuedAt.getTime(),
    input.ttlMs,
  ].join('|');
}

/**
 * Ack: `safelock-ack:v1|commandId|seq|result|reason|lockState|doorState|bootId|uptimeMs`
 *
 * The measured states are inside the signature, not just the result. A
 * compromised broker that could rewrite `lockState` while leaving the result
 * intact could show `LOCKED` on a safe standing open — which is rewriting the
 * security record of a physical safe, and is the thing signing device reports
 * exists to prevent.
 */
export function canonicalAck(input: {
  commandId: string;
  seq: number;
  result: string;
  reason: string | null;
  lockState: string;
  doorState: string;
  bootId: string;
  measuredAtUptimeMs: number;
}): string {
  return [
    'safelock-ack:v1',
    field(input.commandId),
    input.seq,
    field(input.result),
    field(input.reason),
    field(input.lockState),
    field(input.doorState),
    field(input.bootId),
    input.measuredAtUptimeMs,
  ].join('|');
}

/** State: `safelock-state:v1|lockState|doorState|fw|lastSeq|bootId|uptimeMs|reason` */
export function canonicalState(input: {
  lockState: string;
  doorState: string;
  firmwareVersion: string;
  lastSeq: number;
  bootId: string;
  uptimeMs: number;
  reason: string;
}): string {
  return [
    'safelock-state:v1',
    field(input.lockState),
    field(input.doorState),
    field(input.firmwareVersion),
    input.lastSeq,
    field(input.bootId),
    input.uptimeMs,
    field(input.reason),
  ].join('|');
}
