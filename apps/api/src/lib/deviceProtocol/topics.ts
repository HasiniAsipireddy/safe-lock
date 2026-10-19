import { SERIAL_NUMBER_REGEX } from '@safelock/shared';

/**
 * The topic tree, and the one place it is spelled.
 *
 * ```
 * safelock/v1/<serial>/cmd      server → device   QoS 1, retain=false
 * safelock/v1/<serial>/ack      device → server   QoS 1, retain=false
 * safelock/v1/<serial>/state    device → server   QoS 1, retain=TRUE
 * safelock/v1/<serial>/status   device → server   QoS 1, retain=TRUE  (+ LWT)
 * ```
 *
 * **Keyed by serial, never by database id.** The `DeviceGateway` interface
 * takes a serial and nothing else, and a transport that can see the database
 * id is a transport that has been handed a join key. The serial is also the
 * one identifier physically stamped on the unit, so a technician holding a
 * safe can find its topic. The device never learns its `Device.id`.
 *
 * **`v1` is in the path, not only in the payload.** A backward-incompatible
 * change gets `v2` topics and a gateway that publishes to both during the
 * rollout. Versioning the payload alone would not help: a v1 device subscribed
 * to one topic cannot be told to stop listening to it.
 */

export const PROTOCOL_VERSION = 1;

const ROOT = `safelock/v${PROTOCOL_VERSION}`;

export type DeviceTopicKind = 'cmd' | 'ack' | 'state' | 'status';

export function deviceTopic(serialNumber: string, kind: DeviceTopicKind): string {
  return `${ROOT}/${serialNumber}/${kind}`;
}

/** The three inbound topics, as wildcards the server subscribes to. */
export const INBOUND_TOPIC_FILTERS = [
  `${ROOT}/+/ack`,
  `${ROOT}/+/state`,
  `${ROOT}/+/status`,
] as const;

/**
 * The serial and kind a message arrived on, or null.
 *
 * Returns null rather than throwing for anything unrecognised, and
 * **validates the serial against the same pattern the inventory uses** — a
 * topic segment is attacker-influenced input in exactly the way a path
 * parameter is, and the serial from here goes on to be used as a database
 * lookup key and as a signing input.
 *
 * The serial is taken from the **topic**, never from the payload. A payload
 * claiming to be another device is precisely what the `serial` field inside
 * the signature exists to catch, and that check needs an independent source of
 * truth to compare against.
 */
export function parseDeviceTopic(
  topic: string,
): { serialNumber: string; kind: DeviceTopicKind } | null {
  const segments = topic.split('/');
  if (segments.length !== 4) return null;

  const [root, version, serialNumber, kind] = segments;
  if (root !== 'safelock' || version !== `v${PROTOCOL_VERSION}`) return null;
  if (!serialNumber || !SERIAL_NUMBER_REGEX.test(serialNumber)) return null;

  if (kind !== 'ack' && kind !== 'state' && kind !== 'status') return null;

  return { serialNumber, kind };
}
