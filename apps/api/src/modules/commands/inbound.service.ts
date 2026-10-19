import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import type { DeviceInboundHandler } from '../../lib/deviceGateway';
import {
  ackPayloadSchema,
  deriveCommandKey,
  parsePayload,
  statePayloadSchema,
  statusPayloadSchema,
  verifyStateSignature,
  type StatePayload,
} from '../../lib/deviceProtocol';
import { AUDIT_ACTIONS, writeAudit } from '../audit/audit.service';
import { handleAck, touchDevice } from './ack.service';
import { reconcileUnexpectedUnlock } from './reconcile.service';

/**
 * Everything a device says, arriving here.
 *
 * One sink for all three inbound topics rather than a subscription each,
 * because every message takes the same four steps — parse, verify, advance
 * liveness, apply — and three handlers would be three places to forget the
 * third one.
 *
 * Nothing in here throws at its caller. The caller is a broker callback, and
 * an exception there is an unhandled rejection in a library's event loop: a
 * malformed message from a radio is Tuesday, not an exceptional condition.
 * Every bad message is dropped, logged, and audited where the drop is
 * security-relevant.
 */

export const deviceInboundHandler: DeviceInboundHandler = {
  async handleMessage(serialNumber, kind, raw) {
    try {
      switch (kind) {
        case 'ack':
          await onAck(serialNumber, raw);
          return;
        case 'state':
          await onState(serialNumber, raw);
          return;
        case 'status':
          await onStatus(serialNumber, raw);
          return;
      }
    } catch (cause) {
      logger.error(
        {
          serialNumber,
          kind,
          reason: cause instanceof Error ? cause.message : 'unknown',
        },
        'Failed to handle an inbound device message',
      );
    }
  },
};

async function onAck(serialNumber: string, raw: Buffer): Promise<void> {
  const payload = parsePayload(ackPayloadSchema, raw);

  if (!payload) {
    /**
     * Malformed, wrong version, unknown field, or a reason that disagrees with
     * its result. Not audited: we cannot attribute it to a device without a
     * verified signature, and an unauthenticated writer could otherwise fill
     * the audit table by publishing garbage.
     */
    logger.warn({ serialNumber }, 'Dropped an unparseable device ack');
    return;
  }

  const outcome = await handleAck(serialNumber, payload);

  if (!outcome.applied) {
    logger.warn(
      { serialNumber, commandId: payload.commandId, reason: outcome.droppedReason },
      'Device ack was not applied',
    );
  }
}

/**
 * A state report: the device's own account of itself, on change and on a
 * heartbeat.
 *
 * Retained on the broker, so this is **replayable by design** — the server
 * gets the last one on its own reconnect without waiting up to a heartbeat
 * interval. That is safe because a state report is a *report* and not an
 * instruction: re-delivering it causes nothing to move. What it must not do is
 * walk the record backwards, which is why it cannot settle a command and why
 * the stale-boot check below exists.
 */
async function onState(serialNumber: string, raw: Buffer): Promise<void> {
  const payload = parsePayload(statePayloadSchema, raw);

  if (!payload) {
    logger.warn({ serialNumber }, 'Dropped an unparseable device state report');
    return;
  }

  const device = await prisma.device.findUnique({
    where: { serialNumber },
    select: { id: true, commandKeyVersion: true },
  });

  if (!device) {
    logger.warn({ serialNumber }, 'State report from a serial not in the inventory');
    return;
  }

  if (!verifyStateSignature(deriveCommandKey(serialNumber, device.commandKeyVersion), payload)) {
    await writeAudit({
      action: AUDIT_ACTIONS.DEVICE_MESSAGE_SIGNATURE_INVALID,
      deviceId: device.id,
      metadata: { kind: 'state', reason: payload.reason, lastSeq: payload.lastSeq },
    });
    return;
  }

  await applyState(device.id, payload);

  /**
   * And then the question a state report is the only place to ask: is this safe
   * open with nobody entitled to have it open? Evaluated on **every** report,
   * because the ways a bolt ends up withdrawn without a command of ours — a
   * power event, a firmware fault, a completion lock lost while this process
   * was down — all surface as an ordinary heartbeat. See §8.3.
   */
  await reconcileUnexpectedUnlock({
    deviceId: device.id,
    reportedLockState: payload.lockState,
  });
}

async function applyState(deviceId: string, payload: StatePayload): Promise<void> {
  const now = new Date();

  await prisma.device.update({
    where: { id: deviceId },
    data: {
      lockState: payload.lockState,
      doorState: payload.doorState,
      /**
       * `lockStateUpdatedAt` moves on a state report as well as on an ack, and
       * that is right: the column means "when the device last confirmed this
       * state", and an unprompted report is a confirmation. What would be
       * wrong is moving it when a *command* was sent.
       */
      lockStateUpdatedAt: now,
      firmwareVersion: payload.firmwareVersion,
      rssi: payload.rssi,
      clockSynced: payload.clockSynced,
      bootId: payload.bootId,
      online: true,
      lastSeenAt: now,
      ...(payload.lockState === 'LOCKED' ? { unexpectedUnlockAt: null } : {}),
    },
  });
}

/**
 * Liveness, from the retained `/status` topic or the broker's last will.
 *
 * **The one unsigned message, and therefore the one that may not move a lock
 * state.** The will is composed by the device at connect time and published by
 * the broker later, so a signature would have to be held by the broker to be
 * useful — and a forged `online: false` is a denial of service a hostile
 * broker achieves by dropping packets anyway. Liveness is not a security claim
 * here, which is exactly why `isDeviceOnline` also requires a fresh
 * `lastSeenAt`: one retained flag is never the whole answer.
 */
async function onStatus(serialNumber: string, raw: Buffer): Promise<void> {
  const payload = parsePayload(statusPayloadSchema, raw);

  if (!payload) {
    logger.warn({ serialNumber }, 'Dropped an unparseable device status');
    return;
  }

  const device = await prisma.device.findUnique({
    where: { serialNumber },
    select: { id: true, lockState: true },
  });

  if (!device) return;

  if (!payload.online) {
    /**
     * A clean disconnect or a last will. `lastSeenAt` is deliberately **not**
     * advanced: this message is the device saying it is gone, and stamping it
     * as freshly seen would make `isDeviceOnline`'s second condition agree
     * that it is here.
     */
    await prisma.device.update({
      where: { id: device.id },
      data: { online: false },
    });
    return;
  }

  await touchDevice(device.id, new Date());

  if (payload.firmwareVersion) {
    await prisma.device.update({
      where: { id: device.id },
      data: { firmwareVersion: payload.firmwareVersion },
    });
  }

  /**
   * A device that has just **connected** is the other half of §8.3's trigger.
   *
   * A status message carries no lock state, so the stored one is what is
   * checked — and that is the case worth catching: a safe recorded open, whose
   * completion lock was lost while this process was down, is a safe nobody
   * would otherwise look at again until its next heartbeat. The reconciler
   * re-reads the device under a row lock before it does anything, so acting on
   * a stored value here cannot race the state report that may be arriving
   * alongside it.
   */
  await reconcileUnexpectedUnlock({
    deviceId: device.id,
    reportedLockState: device.lockState,
  });
}
