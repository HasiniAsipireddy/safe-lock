/**
 * The little the simulator needs from a broker.
 *
 * Two methods, because a device does two things: it subscribes to its own
 * `/cmd` topic and it publishes reports. Deliberately **not** `mqtt.js`'s
 * client interface — the simulator runs over {@link MemoryBroker} in the suite
 * and over a real broker from `scripts/simulate-device.ts`, and a seam that
 * named one of those would make the other the special case.
 *
 * `publish` returns the PUBACK rather than throwing, because a refused publish
 * is something a *test* needs to be able to see: §13's rule is that a
 * misbehaviour must be proved delivered before the server's response is
 * asserted, and "the broker took it" is half of that proof.
 */
export interface SimulatorTransport {
  publish(
    topic: string,
    payload: Buffer,
    options: { qos: 0 | 1 | 2; retain: boolean },
  ): Promise<boolean>;

  subscribe(
    filter: string,
    handler: (message: { topic: string; payload: Buffer }) => void | Promise<void>,
  ): Promise<void>;
}
