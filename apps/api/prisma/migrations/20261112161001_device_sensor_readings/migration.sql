-- AlterTable
ALTER TABLE "Device" ADD COLUMN     "humidityPct" DOUBLE PRECISION,
ADD COLUMN     "sensorReadAt" TIMESTAMP(3),
ADD COLUMN     "temperatureC" DOUBLE PRECISION;
