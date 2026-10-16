-- CreateEnum
CREATE TYPE "UnlockFailureReason" AS ENUM ('WRONG_CODE', 'EXPIRED', 'TOO_MANY_ATTEMPTS', 'NO_CHALLENGE');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('UNLOCK_CONFIRMED', 'UNLOCK_FAILED_MAX_ATTEMPTS');

-- DropIndex
DROP INDEX "DeviceEvent_userId_createdAt_idx";

-- AlterTable
ALTER TABLE "DeviceEvent" ADD COLUMN     "failureReason" "UnlockFailureReason";

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "deviceEventId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMP(3),

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_createdAt_idx" ON "Notification"("userId", "readAt", "createdAt");

-- CreateIndex
CREATE INDEX "DeviceEvent_userId_createdAt_id_idx" ON "DeviceEvent"("userId", "createdAt", "id");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_deviceEventId_fkey" FOREIGN KEY ("deviceEventId") REFERENCES "DeviceEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
