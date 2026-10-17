-- Rental model: bookings replace one-time purchase and device ownership.
--
-- DESTRUCTIVE, deliberately. `Payment.purpose` is NOT NULL and every existing
-- Payment row is an artefact of the purchase model, which no longer exists --
-- there is no sensible purpose to assign them. No deployment and no live users
-- exist (see docs/decisions.md), so the rows are dropped rather than migrated
-- to a fiction. Devices keep their serial numbers; their ownership columns go.

DELETE FROM "Payment";

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('PENDING_PAYMENT', 'ACTIVE', 'OVERSTAY', 'COMPLETED', 'CANCELLED', 'EXPIRED_UNPAID');

-- CreateEnum
CREATE TYPE "BookingCompletionReason" AS ENUM ('COLLECTED', 'COLLECTION_WINDOW_LAPSED', 'ADMIN_FORCE_COMPLETED');

-- CreateEnum
CREATE TYPE "PaymentPurpose" AS ENUM ('BOOKING', 'EXTENSION', 'OVERSTAY');

-- CreateEnum
CREATE TYPE "PaymentReviewReason" AS ENUM ('BOOKING_EXPIRED_DEVICE_TAKEN', 'OVERSTAY_QUOTE_EXPIRED', 'BOOKING_NO_LONGER_PAYABLE');

-- AlterEnum: DeviceStatus loses ASSIGNED and gains AVAILABLE/NEEDS_INSPECTION.
--
-- Prisma's generated cast (`status::text::DeviceStatus_new`) cannot work here
-- because no old value exists in the new enum. The column goes via `text` so
-- the values can be remapped first:
--
--   UNASSIGNED -> AVAILABLE          (in the pool, bookable)
--   ASSIGNED   -> NEEDS_INSPECTION   (was in somebody's hands; contents
--                                     unknown, so a human must look before it
--                                     is rented again — the same rule a lapsed
--                                     collection window now follows)
--   RETIRED    -> RETIRED
ALTER TABLE "Device" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Device" ALTER COLUMN "status" TYPE TEXT USING ("status"::text);

UPDATE "Device" SET "status" = CASE "status"
  WHEN 'UNASSIGNED' THEN 'AVAILABLE'
  WHEN 'ASSIGNED'   THEN 'NEEDS_INSPECTION'
  ELSE "status"
END;

DROP TYPE "DeviceStatus";
CREATE TYPE "DeviceStatus" AS ENUM ('AVAILABLE', 'NEEDS_INSPECTION', 'RETIRED');

ALTER TABLE "Device"
  ALTER COLUMN "status" TYPE "DeviceStatus" USING ("status"::"DeviceStatus");
ALTER TABLE "Device" ALTER COLUMN "status" SET DEFAULT 'AVAILABLE';

-- DropForeignKey
ALTER TABLE "Device" DROP CONSTRAINT "Device_ownerId_fkey";

-- DropIndex
DROP INDEX "Device_ownerId_key";

-- AlterTable
ALTER TABLE "Device" DROP COLUMN "allocatedAt",
DROP COLUMN "ownerId",
ADD COLUMN     "inspectionNote" TEXT,
ADD COLUMN     "inspectionNotedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "bookingId" TEXT,
ADD COLUMN     "purpose" "PaymentPurpose" NOT NULL,
ADD COLUMN     "quoteExpiresAt" TIMESTAMP(3),
ADD COLUMN     "reviewClearedAt" TIMESTAMP(3),
ADD COLUMN     "reviewReason" "PaymentReviewReason";

-- CreateTable
CREATE TABLE "Booking" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "status" "BookingStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "hours" INTEGER NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "holdExpiresAt" TIMESTAMP(3),
    "reservedUntil" TIMESTAMP(3) NOT NULL,
    "pricePaise" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "hourlyRatePaise" INTEGER NOT NULL,
    "overstayMultiplierBps" INTEGER NOT NULL,
    "graceMinutes" INTEGER NOT NULL,
    "capHours" INTEGER NOT NULL,
    "collectionWindowMinutes" INTEGER NOT NULL,
    "overstaySettledAt" TIMESTAMP(3),
    "overstayPaidPaise" INTEGER NOT NULL DEFAULT 0,
    "overstayWaivedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "completionReason" "BookingCompletionReason",
    "adminNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Booking_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Booking_status_endsAt_idx" ON "Booking"("status", "endsAt");

-- CreateIndex
CREATE INDEX "Booking_status_holdExpiresAt_idx" ON "Booking"("status", "holdExpiresAt");

-- CreateIndex
CREATE INDEX "Booking_userId_createdAt_idx" ON "Booking"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Booking_deviceId_reservedUntil_idx" ON "Booking"("deviceId", "reservedUntil");

-- CreateIndex
CREATE INDEX "Payment_bookingId_idx" ON "Payment"("bookingId");

-- CreateIndex
CREATE INDEX "Payment_reviewReason_reviewClearedAt_idx" ON "Payment"("reviewReason", "reviewClearedAt");

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Overlap prevention: no two bookings may occupy one device at once.
--
-- Prisma cannot model an exclusion constraint, so it lives here. This is the
-- rental model's equivalent of the old `Device.ownerId` unique index: the
-- service checks too, but a check is a read followed by a write and two
-- concurrent bookings can both pass the read. The constraint is the only thing
-- that makes it true under concurrency.
--
-- `tsrange`, not `tstzrange`, on purpose. Prisma's DateTime maps to
-- `timestamp(3)` *without* time zone and the driver writes every value as UTC.
-- `tstzrange(timestamp, timestamp)` would need a cast that depends on the
-- session TimeZone, which is not IMMUTABLE and which Postgres therefore
-- refuses inside an index expression. `tsrange` over the stored UTC values is
-- immutable and compares exactly the instants we mean.
--
-- `[)` bounds: a booking reserved until 12:45 does not collide with one
-- starting at 12:45.
--
-- The WHERE clause is what lets a device be re-booked once a booking ends:
-- COMPLETED, CANCELLED and EXPIRED_UNPAID rows leave the constraint entirely.
-- ---------------------------------------------------------------------------

-- Required for an exclusion constraint mixing equality (deviceId) with a range
-- operator. Managed Postgres must allow this extension -- see README.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "Booking"
  ADD CONSTRAINT "Booking_device_no_overlap"
  EXCLUDE USING gist (
    "deviceId" WITH =,
    tsrange("startsAt", "reservedUntil", '[)') WITH &&
  )
  WHERE ("status" IN ('PENDING_PAYMENT', 'ACTIVE', 'OVERSTAY'));

-- One live booking per user.
--
-- Also a real constraint rather than a service check, and it is what closes
-- the obvious abuse of the payment hold: without it, anyone could open unpaid
-- bookings until the pool was empty.
CREATE UNIQUE INDEX "Booking_one_live_per_user"
  ON "Booking" ("userId")
  WHERE ("status" IN ('PENDING_PAYMENT', 'ACTIVE', 'OVERSTAY'));
