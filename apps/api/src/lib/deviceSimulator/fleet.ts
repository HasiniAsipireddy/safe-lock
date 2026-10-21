import { MemoryBroker } from './memoryBroker';
import { SimulatedDevice, type AppliedMisbehaviour, type SimulatedDeviceOptions } from './simulatedDevice';
import type { AckRecord, ReceivedRecord, SentRecord } from './simulatedDevice';
import type { SimulatorTransport } from './transport';

/**
 * Several simulated safes on one broker, and the record a test points at.
 *
 * The serial-keyed accessors are the ones §13 specifies, and they exist as a
 * fleet rather than hanging off each device for one reason: the misbehaviour
 * rule is *global*. `appliedMisbehaviours()` answers "which flags actually
 * fired, anywhere", so a test that armed the wrong device's flag fails on the
 * delivery assertion instead of quietly passing on the server's silence.
 *
 * It is also how the cross-device cases are reachable at all — a command
 * lifted from one safe's topic to another's, an ack quoting a neighbour's
 * command id — and those are the checks that stop a valid credential from
 * being a valid credential for the whole fleet.
 */
export class DeviceSimulator {
  readonly broker: MemoryBroker;

  private readonly devices = new Map<string, SimulatedDevice>();

  constructor(broker: MemoryBroker = new MemoryBroker()) {
    this.broker = broker;
  }

  /**
   * Adds a safe and connects it.
   *
   * Connected on creation because a disconnected simulator is the single most
   * common way a misbehaviour test passes vacuously: nothing arrives, the
   * server records nothing, and the assertion is satisfied by the absence of
   * the thing it exists to exercise. A test that wants a device *offline* says
   * so explicitly with `lastWill()`.
   */
  async add(
    serialNumber: string,
    options: Omit<SimulatedDeviceOptions, 'serialNumber' | 'transport'> = {},
  ): Promise<SimulatedDevice> {
    const device = new SimulatedDevice({
      serialNumber,
      transport: this.broker as SimulatorTransport,
      ...options,
    });

    this.devices.set(serialNumber, device);
    await device.connect();

    return device;
  }

  /**
   * One safe, or a throw.
   *
   * Throws rather than returning undefined because every caller is a test
   * asserting on it, and `undefined.sent` reads as a broken assertion rather
   * than as the typo it is.
   */
  device(serialNumber: string): SimulatedDevice {
    const device = this.devices.get(serialNumber);
    if (!device) throw new Error(`No simulated device for ${serialNumber}`);

    return device;
  }

  /** Every publish that safe made, in order. */
  sent(serialNumber: string): SentRecord[] {
    return this.device(serialNumber).sent;
  }

  /** Its last ack, as published. Null if it has never acked. */
  lastAck(serialNumber: string): AckRecord | null {
    return this.device(serialNumber).lastAck();
  }

  /** Every command it received, including ones it refused or ignored. */
  received(serialNumber: string): ReceivedRecord[] {
    return this.device(serialNumber).received;
  }

  /**
   * Which misbehaviours actually fired, fleet-wide, with their command ids.
   *
   * Recorded at the point a device *branches on the flag*, so it cannot be
   * satisfied by a flag that was set and never reached. A PUBACK alone would
   * not do: it proves a packet left, not that it left corrupted.
   */
  appliedMisbehaviours(): AppliedMisbehaviour[] {
    return [...this.devices.values()].flatMap((device) => device.applied);
  }
}
