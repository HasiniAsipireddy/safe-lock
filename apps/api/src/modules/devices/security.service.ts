import { TAMPER_ALERT_COOLDOWN_MINUTES, type TamperKind } from '@safelock/shared';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { AUDIT_ACTIONS, writeAudit } from '../audit/audit.service';
import { recordEvent } from './deviceEvents';

/**
 * Tamper detection from the door reed switch and the vibration sensor.
 *
 * Two signals, both meaningful **only while the bolt is LOCKED**:
 * - **Door forced** — the reed switch says OPEN while the bolt says LOCKED.
 *   A closed bolt and an open door cannot both be true unless the door was
 *   forced or the bolt was bypassed. The stronger of the two, so it wins when
 *   both arrive in the same reading.
 * - **Vibration** — knocking, prising or shaking. Weaker: a renter bumping the
 *   cabinet trips it too, which is why it is worded "may be".
 *
 * While unlocked, both are the renter using their safe, and mean nothing.
 *
 * ## One incident, one alert
 * A jammed crowbar produces vibration on every poll. The device row's
 * `lastTamperAt` is bumped by every reading, and a reading of the **same
 * kind** within {@link TAMPER_ALERT_COOLDOWN_MINUTES} of the last one only
 * extends the incident. An alert goes out when an incident *starts*, so
 * continuous tampering is one alert, and tampering again after five quiet
 * minutes is a new one.
 *
 * ## Who is told
 * - The renter of a live (paid) booking: a `DeviceEvent` in their feed and a
 *   bell notification, atomically, through the same transaction — the
 *   step-5 rule that a notification never exists without its event.
 * - Admins: the `TAMPER_DETECTED` device flag and an audit row, whether or not
 *   the safe is rented. An empty safe being forced is still an incident.
 *
 * In-app only. A WhatsApp alert would need an eleventh Meta template.
 *
 * ## It gates nothing
 * No command is sent, nothing is locked, no booking changes. A false positive
 * must cost a notification, not a renter's access to their safe.
 */

export interface SecurityReadingInput {
  serialNumber: string;
  lockState: 'LOCKED' | 'UNLOCKED';
  /** Null when the unit has no door sensor fitted. */
  doorOpen: boolean | null;
  /** Whether any vibration was detected since the previous reading. */
  vibration: boolean;
  at: Date;
}

const COOLDOWN_MS = TAMPER_ALERT_COOLDOWN_MINUTES * 60_000;

/** Which tampering, if any, this reading describes. */
export function tamperKindOf(reading: SecurityReadingInput): TamperKind | null {
  if (reading.lockState !== 'LOCKED') return null;
  if (reading.doorOpen === true) return 'DOOR_FORCED';
  if (reading.vibration) return 'VIBRATION';
  return null;
}

/**
 * @returns The kind of a *new* incident that was alerted, or null when the
 *   reading was quiet or only extended an incident already alerted.
 */
export async function recordSecurityReading(
  reading: SecurityReadingInput,
): Promise<TamperKind | null> {
  const kind = tamperKindOf(reading);
  if (!kind) return null;

  const device = await prisma.device.findUnique({
    where: { serialNumber: reading.serialNumber },
    select: { id: true, lastTamperAt: true, lastTamperKind: true },
  });
  if (!device) return null;

  const continuing =
    device.lastTamperKind === kind &&
    device.lastTamperAt !== null &&
    reading.at.getTime() - device.lastTamperAt.getTime() < COOLDOWN_MS;

  await prisma.device.update({
    where: { id: device.id },
    data: { lastTamperAt: reading.at, lastTamperKind: kind },
  });

  if (continuing) return null;

  const booking = await prisma.booking.findFirst({
    where: { deviceId: device.id, status: { in: ['ACTIVE', 'OVERSTAY'] } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, userId: true },
  });

  if (booking) {
    await prisma.$transaction(async (tx) => {
      const eventId = await recordEvent(tx, {
        deviceId: device.id,
        userId: booking.userId,
        type: kind === 'DOOR_FORCED' ? 'DOOR_FORCED' : 'VIBRATION_DETECTED',
        requestId: null,
        source: 'SYSTEM',
      });

      await tx.notification.create({
        data: {
          userId: booking.userId,
          type: kind === 'DOOR_FORCED' ? 'TAMPER_DOOR_FORCED' : 'TAMPER_VIBRATION',
          deviceEventId: eventId,
        },
      });
    });
  }

  await writeAudit({
    action: AUDIT_ACTIONS.DEVICE_TAMPER_DETECTED,
    userId: booking?.userId ?? null,
    deviceId: device.id,
    metadata: { kind, bookingId: booking?.id ?? null, renterNotified: booking !== null },
  });

  logger.warn(
    { deviceId: device.id, kind, bookingId: booking?.id ?? null },
    'Possible tampering reported by a safe',
  );

  return kind;
}
