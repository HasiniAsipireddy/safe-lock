/**
 * A safe's firmware, standing in for the ESP32 that does not exist yet.
 *
 * Firmware is out of scope (docs/device-protocol.md §0), and a protocol with
 * one implementation is not a protocol — it is a function calling itself. This
 * module is the other end: a device that subscribes to its own `/cmd` topic,
 * runs §3.4's checks in §3.4's order, signs its reports with the real `K_d`
 * over the real canonical strings, and can be told to misbehave on purpose.
 *
 * Two transports, one device. {@link MemoryBroker} in the suite, so the
 * protocol is exercised on **every** run rather than on the runs where a
 * container happens to be up; the Mosquitto in `docker-compose.yml` from
 * `src/scripts/simulateDevice.ts`, which is where TLS and the real ACLs get
 * tested.
 *
 * It lives in `lib/` rather than in `test/` deliberately. It is a development
 * tool like `MockDeviceGateway` and `FakeWhatsAppClient` — run by hand against
 * a real broker, not only imported by a spec file — and it must share one
 * definition of the protocol with the server, which is what `lib/deviceProtocol`
 * is for.
 */

export { MemoryBroker, BrokerBackedMqttClient, matches } from './memoryBroker';
export type { BrokerMessage, BrokerPublishOptions } from './memoryBroker';

export { DeviceSimulator } from './fleet';

export { SimulatedDevice, CLOCK_SKEW_MS } from './simulatedDevice';
export type {
  AckRecord,
  AppliedMisbehaviour,
  MisbehaviourKind,
  ReceivedRecord,
  SentRecord,
  SimulatedDeviceOptions,
} from './simulatedDevice';

export type { SimulatorTransport } from './transport';
