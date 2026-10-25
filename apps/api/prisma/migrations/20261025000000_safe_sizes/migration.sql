-- Safe sizes, and per-size pricing.
--
-- A renter now chooses a size before a duration, and each size has its own
-- hourly rate. Three changes, in the order they have to happen.

-- 1. The enum. Small to large, matching `SafeSize` in @safelock/shared, which
--    several places rely on as the canonical display order.
CREATE TYPE "SafeSize" AS ENUM ('SMALL', 'MEDIUM', 'LARGE');

-- 2. "Device"."size" -- how big the cabinet physically is.
--
-- Added WITH a default rather than nullable-then-backfilled-then-NOT NULL,
-- which collapses three statements into one and, more importantly, takes one
-- short ACCESS EXCLUSIVE lock instead of three. Postgres 11+ records a default
-- for an added column in the catalogue rather than rewriting every row, so this
-- does not scan the table.
--
-- MEDIUM is the deliberate choice for existing stock, not a convenience: the
-- medium rate is configured to equal the flat rate those safes were already
-- being rented at (10000 paise/hour), so the backfill re-prices nothing and no
-- existing device goes unbookable. An admin reclassifies from the Devices tab.
ALTER TABLE "Device" ADD COLUMN "size" "SafeSize" NOT NULL DEFAULT 'MEDIUM';

-- 3. "Booking"."safeSize" -- the size that was booked, snapshotted.
--
-- Part of the rate snapshot, for exactly the reason the hourly rate is: an
-- admin re-classifying a cabinet mid-rental must not retroactively change what
-- the renter is recorded as having booked. `Device.size` is a fact about
-- inventory; this is a fact about the contract.
--
-- Rows predating this column get MEDIUM, which is true of them: their device
-- was just backfilled to MEDIUM and they were charged the flat rate that is now
-- the medium rate. The booking and its safe therefore still agree.
ALTER TABLE "Booking" ADD COLUMN "safeSize" "SafeSize" NOT NULL DEFAULT 'MEDIUM';

-- 4. The index the booking pick now needs.
--
-- Every pick filters on size -- a renter asks for one before a duration -- so
-- `size` leads, and `createdAt` trails to keep "oldest free safe of this size
-- first" an index scan rather than a sort. The existing (status, createdAt)
-- index stays for the admin inventory list, which filters on status alone.
CREATE INDEX "Device_status_size_createdAt_idx" ON "Device"("status", "size", "createdAt");
