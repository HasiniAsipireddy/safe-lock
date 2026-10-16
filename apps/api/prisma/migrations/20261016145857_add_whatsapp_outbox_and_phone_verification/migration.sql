-- CreateEnum
CREATE TYPE "OutboundMessageKind" AS ENUM ('UNLOCK_OTP', 'PHONE_OTP', 'PASSWORD_RESET', 'UNLOCK_ALERT', 'FAILED_ATTEMPTS_ALERT');

-- CreateEnum
CREATE TYPE "OutboundMessageStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "OutboundFailureCategory" AS ENUM ('NO_VERIFIED_PHONE', 'NO_CONSENT', 'CAP_REACHED', 'INVALID_NUMBER', 'TEMPLATE', 'AUTH', 'RATE_LIMITED', 'TRANSPORT', 'UNKNOWN');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "phoneVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "whatsappConsentAt" TIMESTAMP(3),
ADD COLUMN     "whatsappConsentVersion" INTEGER;

-- CreateTable
CREATE TABLE "OutboundMessage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "OutboundMessageKind" NOT NULL,
    "status" "OutboundMessageStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "failureCategory" "OutboundFailureCategory",
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "providerMessageId" TEXT,
    "deliveryStatus" TEXT,
    "deliveryUpdatedAt" TIMESTAMP(3),
    "deviceEventId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "OutboundMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OutboundMessage_providerMessageId_key" ON "OutboundMessage"("providerMessageId");

-- CreateIndex
CREATE INDEX "OutboundMessage_status_nextAttemptAt_idx" ON "OutboundMessage"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "OutboundMessage_userId_createdAt_idx" ON "OutboundMessage"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "OutboundMessage" ADD CONSTRAINT "OutboundMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundMessage" ADD CONSTRAINT "OutboundMessage_deviceEventId_fkey" FOREIGN KEY ("deviceEventId") REFERENCES "DeviceEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
