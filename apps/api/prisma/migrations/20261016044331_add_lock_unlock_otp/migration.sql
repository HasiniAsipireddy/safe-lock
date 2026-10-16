-- CreateEnum
CREATE TYPE "DeviceEventType" AS ENUM ('LOCK', 'UNLOCK_REQUESTED', 'UNLOCK_CONFIRMED', 'UNLOCK_FAILED');

-- CreateEnum
CREATE TYPE "DeviceEventSource" AS ENUM ('WEB');

-- AlterTable
ALTER TABLE "Device" ADD COLUMN     "lockStateUpdatedAt" TIMESTAMP(3),
ALTER COLUMN "lockState" SET DEFAULT 'LOCKED';

-- CreateTable
CREATE TABLE "DeviceEvent" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "DeviceEventType" NOT NULL,
    "source" "DeviceEventSource" NOT NULL DEFAULT 'WEB',
    "requestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UnlockChallenge" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "otpHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UnlockChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeviceEvent_userId_createdAt_idx" ON "DeviceEvent"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "DeviceEvent_deviceId_createdAt_idx" ON "DeviceEvent"("deviceId", "createdAt");

-- CreateIndex
CREATE INDEX "UnlockChallenge_userId_deviceId_consumedAt_idx" ON "UnlockChallenge"("userId", "deviceId", "consumedAt");

-- CreateIndex
CREATE INDEX "UnlockChallenge_expiresAt_idx" ON "UnlockChallenge"("expiresAt");

-- AddForeignKey
ALTER TABLE "DeviceEvent" ADD CONSTRAINT "DeviceEvent_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceEvent" ADD CONSTRAINT "DeviceEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnlockChallenge" ADD CONSTRAINT "UnlockChallenge_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnlockChallenge" ADD CONSTRAINT "UnlockChallenge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
