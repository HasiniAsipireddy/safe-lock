import { isTest } from '../../config/env';
import { logger } from '../logger';
import type { DeviceCommandResult, DeviceGateway } from './gateway';

/**
 * A safe that is always reachable and always obeys.
 *
 * Deliberately boring: it adds a small delay so the UI's pending states are
 * real, then acks. It does **not** randomly fail — a flaky mock makes every
 * test flaky, and the failure path is better exercised by a test that stubs
 * the gateway than by a coin flip in production code.
 *
 * What this mock does not model, and the MQTT gateway will have to:
 * - a device that is offline or never answers (hence a command timeout),
 * - an ack that disagrees with what we asked for,
 * - replay protection on the command itself.
 */
export class MockDeviceGateway implements DeviceGateway {
  readonly name = 'mock';

  /** Milliseconds of simulated round trip. Skipped in tests. */
  private readonly delayMs: number;

  constructor(options: { delayMs?: number } = {}) {
    // A real 300ms per command would add minutes to the suite for no signal.
    this.delayMs = options.delayMs ?? (isTest ? 0 : 300);
  }

  sendLock(serialNumber: string): Promise<DeviceCommandResult> {
    return this.ack(serialNumber, 'LOCK');
  }

  sendUnlock(serialNumber: string): Promise<DeviceCommandResult> {
    return this.ack(serialNumber, 'UNLOCK');
  }

  private async ack(serialNumber: string, type: 'LOCK' | 'UNLOCK'): Promise<DeviceCommandResult> {
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }

    // Serial, not the OTP or the user — a transport log has no business
    // holding either.
    logger.info({ gateway: this.name, serialNumber, type }, 'Mock device acked command');

    return { acked: true, ackedAt: new Date() };
  }
}
