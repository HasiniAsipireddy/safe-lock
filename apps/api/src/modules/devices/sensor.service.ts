import {
  SENSOR_ALERT_COOLDOWN_MINUTES,
  SENSOR_ALERT_HUMIDITY_PCT,
  SENSOR_ALERT_TEMPERATURE_C,
  SENSOR_SAMPLE_INTERVAL_SECONDS,
  type NotificationType,
  type SensorHistoryResponse,
} from '@safelock/shared';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { AUDIT_ACTIONS, writeAudit } from '../audit/audit.service';

/**
 * DHT22 telemetry: the latest reading on `Device`, a thinned history in
 * `SensorReading`, and an in-app alert to the renter when a threshold is
 * crossed.
 *
 * Telemetry gates nothing. A failure anywhere here is logged and swallowed by
 * the caller — a full disk on the sensor table must never stop a state poll,
 * because the same poll is what keeps the safe looking online.
 */

export interface SensorReadingInput {
  serialNumber: string;
  temperatureC: number;
  humidityPct: number;
  readAt: Date;
}

const SAMPLE_INTERVAL_MS = SENSOR_SAMPLE_INTERVAL_SECONDS * 1000;
const COOLDOWN_MS = SENSOR_ALERT_COOLDOWN_MINUTES * 60_000;

export async function recordSensorReading(reading: SensorReadingInput): Promise<void> {
  const device = await prisma.device.findUnique({
    where: { serialNumber: reading.serialNumber },
    select: { id: true },
  });
  if (!device) return;

  await prisma.device.update({
    where: { id: device.id },
    data: {
      temperatureC: reading.temperatureC,
      humidityPct: reading.humidityPct,
      sensorReadAt: reading.readAt,
    },
  });

  const last = await prisma.sensorReading.findFirst({
    where: { deviceId: device.id },
    orderBy: { readAt: 'desc' },
    select: { readAt: true },
  });

  if (!last || reading.readAt.getTime() - last.readAt.getTime() >= SAMPLE_INTERVAL_MS) {
    await prisma.sensorReading.create({
      data: {
        deviceId: device.id,
        temperatureC: reading.temperatureC,
        humidityPct: reading.humidityPct,
        readAt: reading.readAt,
      },
    });
  }

  const alerts: NotificationType[] = [];
  if (reading.temperatureC >= SENSOR_ALERT_TEMPERATURE_C) alerts.push('SENSOR_TEMPERATURE_HIGH');
  if (reading.humidityPct >= SENSOR_ALERT_HUMIDITY_PCT) alerts.push('SENSOR_HUMIDITY_HIGH');
  if (alerts.length === 0) return;

  await alertRenter(device.id, alerts, reading);
}

/**
 * Tells the safe's current renter, at most once per type per cooldown.
 *
 * Only a **paid** booking's renter: someone still at the checkout has put
 * nothing in the safe yet. An empty safe overheating is an admin problem, and
 * it is visible on the Devices tab.
 */
async function alertRenter(
  deviceId: string,
  types: NotificationType[],
  reading: SensorReadingInput,
): Promise<void> {
  const booking = await prisma.booking.findFirst({
    where: { deviceId, status: { in: ['ACTIVE', 'OVERSTAY'] } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, userId: true },
  });
  if (!booking) return;

  const since = new Date(reading.readAt.getTime() - COOLDOWN_MS);

  for (const type of types) {
    const recent = await prisma.notification.findFirst({
      where: { userId: booking.userId, type, createdAt: { gte: since } },
      select: { id: true },
    });
    if (recent) continue;

    await prisma.notification.create({
      data: { userId: booking.userId, type },
    });

    await writeAudit({
      action: AUDIT_ACTIONS.DEVICE_SENSOR_ALERT,
      userId: booking.userId,
      deviceId,
      // Readings are measurements, not personal data; rounded for the log.
      metadata: {
        bookingId: booking.id,
        type,
        temperatureC: Math.round(reading.temperatureC * 10) / 10,
        humidityPct: Math.round(reading.humidityPct * 10) / 10,
      },
    });

    logger.warn({ deviceId, bookingId: booking.id, type }, 'Sensor alert sent to the renter');
  }
}

/**
 * The caller's safe's readings over the last `hours`, never before their
 * booking started — what the safe did for the previous renter is not theirs.
 */
export async function sensorHistoryFor(
  userId: string,
  hours: number,
  now: Date = new Date(),
): Promise<SensorHistoryResponse> {
  const thresholds = {
    temperatureC: SENSOR_ALERT_TEMPERATURE_C,
    humidityPct: SENSOR_ALERT_HUMIDITY_PCT,
  };

  const booking = await prisma.booking.findFirst({
    where: { userId, status: { in: ['ACTIVE', 'OVERSTAY'] } },
    orderBy: { createdAt: 'desc' },
    select: { deviceId: true, startsAt: true, device: { select: { serialNumber: true } } },
  });
  if (!booking) return { serialNumber: null, samples: [], thresholds };

  const windowStart = new Date(now.getTime() - hours * 3_600_000);
  const from = booking.startsAt > windowStart ? booking.startsAt : windowStart;

  const rows = await prisma.sensorReading.findMany({
    where: { deviceId: booking.deviceId, readAt: { gte: from } },
    orderBy: { readAt: 'asc' },
    select: { readAt: true, temperatureC: true, humidityPct: true },
  });

  return {
    serialNumber: booking.device.serialNumber,
    samples: rows.map((row) => ({
      at: row.readAt.toISOString(),
      temperatureC: row.temperatureC,
      humidityPct: row.humidityPct,
    })),
    thresholds,
  };
}
