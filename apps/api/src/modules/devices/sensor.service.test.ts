import { describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  SENSOR_ALERT_HUMIDITY_PCT,
  SENSOR_ALERT_TEMPERATURE_C,
  SENSOR_SAMPLE_INTERVAL_SECONDS,
} from '@safelock/shared';
import { prisma } from '../../lib/prisma';
import { app, createTestUser, createUserWithDevice, seedDevice } from '../../test/helpers';
import { recordSensorReading } from './sensor.service';

function reading(serialNumber: string, overrides: Partial<{ t: number; h: number; at: Date }> = {}) {
  return {
    serialNumber,
    temperatureC: overrides.t ?? 27,
    humidityPct: overrides.h ?? 55,
    readAt: overrides.at ?? new Date(),
  };
}

describe('recordSensorReading', () => {
  it('updates the latest reading every time but stores at most one sample a minute', async () => {
    const device = await seedDevice();
    const start = Date.now() - 10 * 60_000;

    await recordSensorReading(reading(device.serialNumber, { t: 26, at: new Date(start) }));
    await recordSensorReading(reading(device.serialNumber, { t: 27, at: new Date(start + 3_000) }));
    await recordSensorReading(
      reading(device.serialNumber, {
        t: 28,
        at: new Date(start + SENSOR_SAMPLE_INTERVAL_SECONDS * 1000),
      }),
    );

    const row = await prisma.device.findUniqueOrThrow({ where: { id: device.id } });
    expect(row.temperatureC).toBe(28);
    expect(await prisma.sensorReading.count({ where: { deviceId: device.id } })).toBe(2);
  });

  it('alerts the renter once per cooldown when a threshold is crossed', async () => {
    const held = await createUserWithDevice();
    const hot = { t: SENSOR_ALERT_TEMPERATURE_C + 1, h: SENSOR_ALERT_HUMIDITY_PCT + 1 };

    await recordSensorReading(reading(held.serialNumber, hot));
    await recordSensorReading(reading(held.serialNumber, hot));

    const notes = await prisma.notification.findMany({ where: { userId: held.user.id } });
    expect(notes.map((note) => note.type).sort()).toEqual([
      'SENSOR_HUMIDITY_HIGH',
      'SENSOR_TEMPERATURE_HIGH',
    ]);

    const bell = await request(app()).get('/api/v1/notifications').set('Cookie', held.user.cookie);
    expect(bell.body.unreadCount).toBe(2);
    expect(bell.body.items[0].title).toMatch(/hot|humid/);
  });

  it('alerts nobody for normal readings or an unbooked safe', async () => {
    const held = await createUserWithDevice();
    await recordSensorReading(reading(held.serialNumber));

    const idle = await seedDevice();
    await recordSensorReading(reading(idle.serialNumber, { t: 60 }));

    expect(await prisma.notification.count()).toBe(0);
  });
});

describe('GET /devices/sensor-history', () => {
  it("returns the caller's samples, oldest first, with the alert thresholds", async () => {
    const held = await createUserWithDevice();
    const now = Date.now();
    // The booking began before the readings, so all of them are the caller's.
    await prisma.booking.update({
      where: { id: held.bookingId },
      data: { startsAt: new Date(now - 2 * 60 * 60_000) },
    });
    for (let i = 3; i >= 1; i -= 1) {
      await prisma.sensorReading.create({
        data: {
          deviceId: held.deviceId,
          temperatureC: 20 + i,
          humidityPct: 50,
          readAt: new Date(now - i * 60_000),
        },
      });
    }

    const res = await request(app())
      .get('/api/v1/devices/sensor-history?hours=1')
      .set('Cookie', held.user.cookie);

    expect(res.status).toBe(200);
    expect(res.body.serialNumber).toBe(held.serialNumber);
    expect(res.body.samples.map((s: { temperatureC: number }) => s.temperatureC)).toEqual([
      23, 22, 21,
    ]);
    expect(res.body.thresholds).toEqual({
      temperatureC: SENSOR_ALERT_TEMPERATURE_C,
      humidityPct: SENSOR_ALERT_HUMIDITY_PCT,
    });
  });

  it('never reaches back before the booking started', async () => {
    const held = await createUserWithDevice();
    await prisma.sensorReading.create({
      data: {
        deviceId: held.deviceId,
        temperatureC: 30,
        humidityPct: 50,
        readAt: new Date(Date.now() - 60 * 60_000),
      },
    });

    const res = await request(app())
      .get('/api/v1/devices/sensor-history?hours=6')
      .set('Cookie', held.user.cookie);
    expect(res.body.samples).toEqual([]);
  });

  it('is empty, not an error, without a booking, and validates hours', async () => {
    const user = await createTestUser();

    const empty = await request(app()).get('/api/v1/devices/sensor-history').set('Cookie', user.cookie);
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ serialNumber: null, samples: [] });

    const bad = await request(app())
      .get('/api/v1/devices/sensor-history?hours=99')
      .set('Cookie', user.cookie);
    expect(bad.status).toBe(400);
  });
});
