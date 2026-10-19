-- CreateEnum
CREATE TYPE "DoorState" AS ENUM ('CLOSED', 'OPEN', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "CommandType" AS ENUM ('LOCK', 'UNLOCK');

-- CreateEnum
CREATE TYPE "CommandStatus" AS ENUM ('PENDING', 'SENT', 'ACKED', 'REJECTED', 'FAILED', 'TIMED_OUT', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CommandFailureCategory" AS ENUM ('BAD_VERSION', 'BAD_KEY_VERSION', 'WRONG_DEVICE', 'BAD_SIGNATURE', 'SEQ_REPLAY', 'DUPLICATE', 'EXPIRED', 'UNSUPPORTED', 'MOTOR_FAULT', 'JAMMED', 'DOOR_OBSTRUCTED', 'LOW_POWER', 'SENSOR_FAULT', 'NO_ACK', 'PUBLISH_FAILED', 'NOT_PUBLISHED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "CommandActor" AS ENUM ('COMPLETION', 'SWEEPER', 'ADMIN');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "UnlockFailureReason" ADD VALUE 'DEVICE_TIMEOUT';
ALTER TYPE "UnlockFailureReason" ADD VALUE 'DEVICE_REJECTED';
ALTER TYPE "UnlockFailureReason" ADD VALUE 'DEVICE_FAILED';
ALTER TYPE "UnlockFailureReason" ADD VALUE 'DEVICE_OFFLINE';

-- AlterTable
ALTER TABLE "Device" ADD COLUMN     "bootId" TEXT,
ADD COLUMN     "clockSynced" BOOLEAN,
ADD COLUMN     "commandKeyVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "commandSeq" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "credentialIssuedAt" TIMESTAMP(3),
ADD COLUMN     "doorState" "DoorState" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN     "firmwareVersion" TEXT,
ADD COLUMN     "lockCommandFailedAt" TIMESTAMP(3),
ADD COLUMN     "rssi" INTEGER,
ADD COLUMN     "unexpectedUnlockAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "UnlockChallenge" ADD COLUMN     "binds" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "commandId" TEXT;

-- CreateTable
CREATE TABLE "Command" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "bookingId" TEXT,
    "type" "CommandType" NOT NULL,
    "status" "CommandStatus" NOT NULL DEFAULT 'PENDING',
    "seq" INTEGER NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "ackedAt" TIMESTAMP(3),
    "lateAckedAt" TIMESTAMP(3),
    "failureCategory" "CommandFailureCategory",
    "userId" TEXT,
    "systemActor" "CommandActor",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Command_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Command_status_expiresAt_idx" ON "Command"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "Command_deviceId_issuedAt_idx" ON "Command"("deviceId", "issuedAt");

-- CreateIndex
CREATE INDEX "Command_userId_issuedAt_idx" ON "Command"("userId", "issuedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Command_deviceId_seq_key" ON "Command"("deviceId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "UnlockChallenge_commandId_key" ON "UnlockChallenge"("commandId");

-- AddForeignKey
ALTER TABLE "UnlockChallenge" ADD CONSTRAINT "UnlockChallenge_commandId_fkey" FOREIGN KEY ("commandId") REFERENCES "Command"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Command" ADD CONSTRAINT "Command_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- At most one live system command per device.
--
-- Prisma cannot model a partial unique index, so it lives here -- the same
-- place, and for the same reason, as `Booking_one_live_per_user`: the issuer
-- checks under the device row lock too, but a check is a read followed by a
-- write, and the whole point of this one is to survive a case that is *made*
-- of concurrency.
--
-- The case: a device wedged open heartbeats every 60 seconds, and every one of
-- those reports re-triggers the §8.3 reconcile. Without this, a jammed safe
-- produces one retry chain per heartbeat -- an unbounded fan-out of commands
-- to the one device least able to answer them. A reconnect storm does the same
-- thing faster.
--
-- `systemActor IS NOT NULL` rather than a type or actor filter, so a COMPLETION
-- lock and a SWEEPER reconcile cannot both be in flight at once. They would be
-- asking for the same end state, and two commands racing to the same bolt is
-- how a device ends up rejecting the one we care about as a DUPLICATE.
--
-- User commands are deliberately outside it: a user command is answered, not
-- retried, and two tabs racing are already serialised by the device row lock.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "Command_one_live_system_per_device"
  ON "Command" ("deviceId")
  WHERE ("systemActor" IS NOT NULL AND "status" IN ('PENDING', 'SENT'));
