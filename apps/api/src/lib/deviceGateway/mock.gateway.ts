import { isTest } from '../../config/env';
import { logger } from '../logger';
import {
  canonicalAck,
  canDeriveDeviceKeys,
  deriveCommandKey,
  signCanonical,
} from '../deviceProtocol';
import type {
  DeviceGateway,
  DeviceInboundHandler,
  OutboundCommand,
  PublishResult,
} from './gateway';

/**
 * A safe that is always reachable and always obeys.
 *
 * ## It now answers like a device, not like a function
 * The old mock returned `{ acked: true }` from `sendUnlock`, which made the
 * whole ack path — signature verification, command correlation, the state
 * update, the `DeviceEvent`, the notification — unreachable in development and
 * in every test that did not call the handler by hand. The ack was the return
 * value, so there was nothing to lose, nothing to time out and nothing to
 * forge.
 *
 * So this publishes to itself: it signs a real ack with the device's real
 * derived key and hands it to the same {@link DeviceInboundHandler} the MQTT
 * gateway uses. Dev and test exercise the production path, and the only
 * difference from a real device is that this one is never slow, never wrong and
 * never absent.
 *
 * ## Deliberately boring
 * It does **not** randomly fail. A flaky mock makes every test flaky, and the
 * failure paths are better exercised by a simulator that can be *told* to
 * misbehave and asked to prove it did — see `lib/deviceSim/`. A coin flip in
 * production code gives a test no way to assert what it was testing.
 *
 * Refused in production by the env schema: a gateway that acks every command
 * would report every safe as locked without a bolt moving.
 */
export class MockDeviceGateway implements DeviceGateway {
  readonly name = 'mock';

  private handler: DeviceInboundHandler | null = null;

  /** Milliseconds of simulated round trip. Zero in tests. */
  private readonly delayMs: number;

  /**
   * Acks still in flight, so {@link stop} can wait for them.
   *
   * Without this a test that finishes while a `setTimeout` is pending would
   * have its ack land during the *next* test's truncated database — a failure
   * that looks like flakiness and is really a missing join.
   */
  private readonly pending = new Set<Promise<void>>();

  /** The device's own view of its bolt, so its acks report a measured state. */
  private readonly lockState = new Map<string, 'LOCKED' | 'UNLOCKED'>();

  constructor(options: { delayMs?: number } = {}) {
    // A real 300ms per command would add minutes to the suite for no signal.
    this.delayMs = options.delayMs ?? (isTest ? 0 : 300);
  }

  async start(handler: DeviceInboundHandler): Promise<void> {
    this.handler = handler;
  }

  async stop(): Promise<void> {
    await this.drain();
    this.handler = null;
  }

  /**
   * Waits for every ack this gateway owes.
   *
   * The reason tests can be deterministic about an asynchronous protocol. A
   * real device answers whenever it answers, and a test cannot poll for an
   * outcome without either sleeping — which is how a suite becomes slow and
   * flaky at once — or reaching inside the thing it is testing. This is the
   * seam that avoids both: the mock knows exactly what it owes, so a test can
   * ask it to finish and then assert on a settled world.
   */
  async drain(): Promise<void> {
    // A handler can enqueue nothing further here, but an ack landing while we
    // await can; loop until the set is genuinely empty.
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }

  sendLock(command: OutboundCommand): Promise<PublishResult> {
    return this.publish(command, 'LOCKED');
  }

  sendUnlock(command: OutboundCommand): Promise<PublishResult> {
    return this.publish(command, 'UNLOCKED');
  }

  /**
   * Accepts the command, then answers out of band.
   *
   * The ack is scheduled rather than awaited, which is the whole point: a
   * caller that awaited its own ack would be back to a synchronous command and
   * would hold whatever lock it is inside across the round trip.
   */
  private async publish(
    command: OutboundCommand,
    reaches: 'LOCKED' | 'UNLOCKED',
  ): Promise<PublishResult> {
    const publishedAt = new Date();

    // Serial and command id only. A transport log has no business holding a
    // code, a user or a key.
    logger.info(
      {
        gateway: this.name,
        serialNumber: command.serialNumber,
        commandId: command.commandId,
        seq: command.seq,
      },
      'Mock device accepted a command',
    );

    const ack = this.scheduleAck(command, reaches);
    this.pending.add(ack);
    void ack.finally(() => this.pending.delete(ack));

    return { published: true, publishedAt };
  }

  private async scheduleAck(
    command: OutboundCommand,
    reaches: 'LOCKED' | 'UNLOCKED',
  ): Promise<void> {
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }

    const handler = this.handler;

    /**
     * No handler means nobody started the gateway — a unit test exercising a
     * service in isolation, say. The command stays `SENT` and the sweeper
     * times it out, which is the honest outcome: an unanswered command.
     */
    if (!handler) return;

    this.lockState.set(command.serialNumber, reaches);

    try {
      await handler.handleMessage(
        command.serialNumber,
        'ack',
        Buffer.from(JSON.stringify(this.buildAck(command, reaches)), 'utf8'),
      );
    } catch (cause) {
      // A handler that throws must not become an unhandled rejection in a
      // `setTimeout`. A real device's ack would simply have been lost.
      logger.error(
        {
          commandId: command.commandId,
          reason: cause instanceof Error ? cause.message : 'unknown',
        },
        'Mock ack handler threw',
      );
    }
  }

  /**
   * A genuinely signed ack, under the key the server will derive to check it.
   *
   * Signed rather than waved through on a trust flag, because an unsigned path
   * through the handler is an unsigned path that exists. If the master secret
   * is not configured the signature is left empty and the handler drops the
   * ack as unverifiable — which is the correct behaviour for a message we
   * cannot authenticate, and is visible as a timeout rather than as a silent
   * success.
   */
  private buildAck(command: OutboundCommand, reaches: 'LOCKED' | 'UNLOCKED') {
    const body = {
      commandId: command.commandId,
      seq: command.seq,
      result: 'OK' as const,
      reason: null,
      lockState: reaches,
      /**
       * Units ship with a door sensor, and a renter who has just locked up has
       * a shut door. The mock has no way to model someone standing there with
       * it open, and reporting `UNKNOWN` would flag every mock device as
       * faulty.
       */
      doorState: 'CLOSED' as const,
      bootId: 'mock0000',
      measuredAtUptimeMs: Math.floor(process.uptime() * 1000),
    };

    return {
      v: 1,
      ...body,
      sig: canDeriveDeviceKeys()
        ? signCanonical(
            deriveCommandKey(command.serialNumber, command.keyVersion),
            canonicalAck(body),
          )
        : '',
    };
  }
}
