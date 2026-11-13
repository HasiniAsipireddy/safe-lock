-- AlterEnum
ALTER TYPE "CommandActor" ADD VALUE 'AUTO_LOCK';

-- AlterEnum
ALTER TYPE "DeviceEventSource" ADD VALUE 'SYSTEM';

-- AlterEnum
ALTER TYPE "DeviceEventType" ADD VALUE 'AUTO_LOCK';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'SENSOR_TEMPERATURE_HIGH';
ALTER TYPE "NotificationType" ADD VALUE 'SENSOR_HUMIDITY_HIGH';

-- CreateTable
CREATE TABLE "SensorReading" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "temperatureC" DOUBLE PRECISION NOT NULL,
    "humidityPct" DOUBLE PRECISION NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SensorReading_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SensorReading_deviceId_readAt_idx" ON "SensorReading"("deviceId", "readAt");

-- AddForeignKey
ALTER TABLE "SensorReading" ADD CONSTRAINT "SensorReading_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
