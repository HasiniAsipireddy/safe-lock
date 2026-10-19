import crypto from 'node:crypto';
import { env } from '../../config/env';

/**
 * Per-device command keys, derived rather than stored.
 *
 * ```
 * K_d = HMAC-SHA256(DEVICE_COMMAND_HMAC_SECRET,
 *                   "safelock:device-cmd:v1:" + keyVersion + ":" + serial)
 * ```
 *
 * One server-side master secret, one key per device, **no per-device key at
 * rest anywhere on the server**. This is the same move `OTP_HMAC_SECRET`
 * makes, and the same domain separation the `pwreset:v1:` prefix makes.
 *
 * The alternative — a random per-device key — would have to be stored
 * *reversibly*, because HMAC verification needs the key itself and not a
 * digest of it. That means either plaintext secrets in a table or an
 * envelope-encryption dependency, and both are worse than one secret held in
 * the environment where the OTP secret already lives. A database leak yields
 * no device key here, because no device key is in the database.
 *
 * `keyVersion` is part of the derivation **and** of every command on the wire,
 * so the master secret can be rotated without a flag day: the server signs
 * `kv=2` for re-provisioned devices while `kv=1` devices keep working until
 * they are re-provisioned. Without a version in the message a device could not
 * tell which key to verify against, and rotating the master would brick the
 * fleet.
 */

/** Domain separation. A change here is a protocol version, not a tweak. */
const KEY_DERIVATION_PREFIX = 'safelock:device-cmd:v1';

/**
 * Thrown when the master secret is absent.
 *
 * Reachable only with `DEVICE_GATEWAY=mock`, where there is no device to verify
 * a signature and no key to derive — the env schema requires the secret for
 * `mqtt` in every environment. Throwing rather than returning a zero key: a
 * key derived from nothing would produce signatures that verify against each
 * other and prove nothing, which is the failure mode worth making loud.
 */
export class DeviceKeyUnavailable extends Error {
  constructor() {
    super(
      'DEVICE_COMMAND_HMAC_SECRET is not configured, so no device command key can be derived',
    );
    this.name = 'DeviceKeyUnavailable';
  }
}

/** Whether command signing is possible at all. */
export function canDeriveDeviceKeys(): boolean {
  return Boolean(env.DEVICE_COMMAND_HMAC_SECRET?.trim());
}

/**
 * The command key for one device at one key version.
 *
 * Returns raw bytes, never hex or base64. A key that has been through a string
 * is a key that can end up in a log line by way of a stray template literal;
 * a `Buffer` has no useful default rendering.
 */
export function deriveCommandKey(serialNumber: string, keyVersion: number): Buffer {
  const master = env.DEVICE_COMMAND_HMAC_SECRET?.trim();
  if (!master) throw new DeviceKeyUnavailable();

  return crypto
    .createHmac('sha256', master)
    .update(`${KEY_DERIVATION_PREFIX}:${keyVersion}:${serialNumber}`)
    .digest();
}

/**
 * A device's MQTT password, and the `sha256` the server keeps of it.
 *
 * The password is returned to exactly one caller — the admin minting it — and
 * shown once. Only the digest is stored, and there is no endpoint that reads
 * one back. Unkeyed `sha256` is correct here and would not be for an OTP: this
 * is 32 random bytes, so there is no input space to enumerate. The same
 * reasoning the refresh token's `tokenHash` follows.
 */
export function mintDeviceCredential(): { password: string; hash: string } {
  const password = crypto.randomBytes(32).toString('base64url');

  return { password, hash: hashDeviceCredential(password) };
}

export function hashDeviceCredential(password: string): string {
  return crypto.createHash('sha256').update(password).digest('hex');
}
