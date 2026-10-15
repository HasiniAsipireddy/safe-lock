-- CreateEnum
CREATE TYPE "DeviceStatus" AS ENUM ('UNASSIGNED', 'ASSIGNED', 'RETIRED');

-- CreateEnum
CREATE TYPE "LockState" AS ENUM ('LOCKED', 'UNLOCKED', 'UNKNOWN');

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "serialNumber" TEXT NOT NULL,
    "status" "DeviceStatus" NOT NULL DEFAULT 'UNASSIGNED',
    "lockState" "LockState" NOT NULL DEFAULT 'UNKNOWN',
    "online" BOOLEAN NOT NULL DEFAULT false,
    "lastSeenAt" TIMESTAMP(3),
    "ownerId" TEXT,
    "allocatedAt" TIMESTAMP(3),
    "credentialHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Device_serialNumber_key" ON "Device"("serialNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Device_ownerId_key" ON "Device"("ownerId");

-- CreateIndex
CREATE INDEX "Device_status_createdAt_idx" ON "Device"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
