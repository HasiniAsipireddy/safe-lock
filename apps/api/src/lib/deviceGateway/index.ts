import { env } from '../../config/env';
import { MockDeviceGateway } from './mock.gateway';
import type { DeviceGateway } from './gateway';

export type { DeviceGateway, DeviceCommandResult } from './gateway';
export { MockDeviceGateway } from './mock.gateway';

/**
 * The gateway the application talks to.
 *
 * Everything that moves a bolt goes through this one object, so swapping the
 * mock for a real MQTT gateway (roadmap step 6) is a change here and nowhere
 * else — no route and no service knows which implementation it has.
 *
 * Resolved once at module load rather than per call: a gateway will hold a
 * broker connection, and reconnecting per command is not a thing to retrofit
 * later.
 */
function resolveGateway(): DeviceGateway {
  switch (env.DEVICE_GATEWAY) {
    case 'mock':
      return new MockDeviceGateway();
    default:
      // Unreachable: the env schema is an enum. Kept so adding a value to that
      // enum without an implementation fails loudly at boot.
      throw new Error(`No device gateway implementation for '${env.DEVICE_GATEWAY}'`);
  }
}

export const deviceGateway: DeviceGateway = resolveGateway();
