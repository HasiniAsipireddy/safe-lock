import { env } from '../../config/env';
import { MockDeviceGateway } from './mock.gateway';
import { MqttDeviceGateway } from './mqtt.gateway';
import type { DeviceGateway } from './gateway';

export {
  DeviceCommandError,
  type DeviceGateway,
  type DeviceInboundHandler,
  type OutboundCommand,
  type PublishResult,
} from './gateway';
export { MockDeviceGateway } from './mock.gateway';
export { MqttDeviceGateway } from './mqtt.gateway';

/**
 * The gateway the application talks to.
 *
 * Everything that moves a bolt goes through this one object, so which
 * implementation is in use is a decision made here and nowhere else — no route
 * and no service knows.
 *
 * Resolved once at module load rather than per call: the MQTT gateway holds a
 * broker connection, and reconnecting per command is not a thing to retrofit
 * later. Note that constructing it does **not** connect — that is `start`,
 * which the server calls, which is what keeps a broker connection out of the
 * test suite.
 */
function resolveGateway(): DeviceGateway {
  switch (env.DEVICE_GATEWAY) {
    case 'mock':
      return new MockDeviceGateway();
    case 'mqtt':
      return new MqttDeviceGateway();
    default:
      // Unreachable: the env schema is an enum. Kept so adding a value to that
      // enum without an implementation fails loudly at boot.
      throw new Error(`No device gateway implementation for '${env.DEVICE_GATEWAY}'`);
  }
}

export const deviceGateway: DeviceGateway = resolveGateway();

/**
 * Waits for every ack the in-process mock still owes. A no-op otherwise.
 *
 * Tests use this to be deterministic about an asynchronous protocol. The
 * alternative — sleeping until the ack has probably landed — is how a suite
 * becomes slow and flaky at the same time, and polling the database for an
 * outcome would make a test that is *waiting* indistinguishable from one that
 * is *failing*.
 *
 * Lives here rather than in a test helper so nothing has to reach into the
 * concrete class, and so it is honestly a no-op in production rather than an
 * import that only exists under test.
 */
export async function drainDeviceAcks(): Promise<void> {
  if (deviceGateway instanceof MockDeviceGateway) await deviceGateway.drain();
}
