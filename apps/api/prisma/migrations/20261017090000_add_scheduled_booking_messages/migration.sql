-- Scheduled booking lifecycle messages.
--
-- Adds a due time (`sendAt`), the booking a message is about, and an
-- idempotency key for scheduling. Nothing here changes behaviour for messages
-- already in flight: see the backfill below.

-- AlterEnum
-- CANCELLED: the booking moved on before the message was sent.
-- STALE:     claimed too late to still be true.
ALTER TYPE "OutboundFailureCategory" ADD VALUE 'CANCELLED';
ALTER TYPE "OutboundFailureCategory" ADD VALUE 'STALE';

-- AlterEnum
-- One value per new Meta template. All UTILITY, all scheduled, all
-- re-validated against the live booking before they are sent.
ALTER TYPE "OutboundMessageKind" ADD VALUE 'BOOKING_CONFIRMED';
ALTER TYPE "OutboundMessageKind" ADD VALUE 'BOOKING_ENDING_SOON';
ALTER TYPE "OutboundMessageKind" ADD VALUE 'OVERSTAY_STARTED';
ALTER TYPE "OutboundMessageKind" ADD VALUE 'OVERSTAY_SETTLED';
ALTER TYPE "OutboundMessageKind" ADD VALUE 'COLLECTION_CLOSING';

-- AlterTable
ALTER TABLE "OutboundMessage" ADD COLUMN     "bookingId" TEXT,
ADD COLUMN     "dedupeKey" TEXT,
ADD COLUMN     "sendAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill: an existing row was due the moment it was written.
--
-- Without this, every row in the table — including any PENDING one mid-retry —
-- would take the column default of "now", quietly moving its due time to
-- deploy time and reordering the queue around the deploy. `sendAt = createdAt`
-- is what was already true of these rows, so the new claim clause
-- (`sendAt <= now`) admits exactly the set it admitted before.
UPDATE "OutboundMessage" SET "sendAt" = "createdAt";

-- CreateIndex
CREATE UNIQUE INDEX "OutboundMessage_dedupeKey_key" ON "OutboundMessage"("dedupeKey");

-- CreateIndex
CREATE INDEX "OutboundMessage_status_sendAt_idx" ON "OutboundMessage"("status", "sendAt");

-- CreateIndex
CREATE INDEX "OutboundMessage_bookingId_status_idx" ON "OutboundMessage"("bookingId", "status");

-- AddForeignKey
ALTER TABLE "OutboundMessage" ADD CONSTRAINT "OutboundMessage_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;
