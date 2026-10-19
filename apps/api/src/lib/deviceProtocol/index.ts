/**
 * The device wire protocol: topics, canonical signing strings, keys and
 * payload schemas.
 *
 * Deliberately separate from `lib/deviceGateway/`, which is the *transport*.
 * This module knows what a message looks like and how it is signed; the
 * gateway knows how to put one on a wire. The split is what lets the
 * simulator and the server share one definition of the protocol while running
 * on opposite ends of it — a protocol tested only against its own transport is
 * a protocol with one implementation.
 *
 * Nothing in here touches the database, and nothing in here decides
 * eligibility. Authorisation is settled before anything reaches a gateway.
 */

export {
  canonicalAck,
  canonicalCommand,
  canonicalState,
} from './canonical';

export {
  canDeriveDeviceKeys,
  deriveCommandKey,
  DeviceKeyUnavailable,
  hashDeviceCredential,
  mintDeviceCredential,
} from './keys';

export { signCanonical, verifyCanonical } from './sign';

export {
  ackPayloadSchema,
  ackResultMatchesReason,
  buildCommandPayload,
  failureCategoryFor,
  parsePayload,
  statePayloadSchema,
  statusPayloadSchema,
  verifyAckSignature,
  verifyStateSignature,
  type AckPayload,
  type AckReason,
  type AckResult,
  type CommandPayload,
  type StatePayload,
  type StatusPayload,
} from './messages';

export {
  deviceTopic,
  INBOUND_TOPIC_FILTERS,
  parseDeviceTopic,
  PROTOCOL_VERSION,
  type DeviceTopicKind,
} from './topics';
