-- Backfill: an ASSIGNED device must never be UNKNOWN.
--
-- The previous migration changed the column default to 'LOCKED', but a
-- default only applies to new rows. Any safe allocated before this change is
-- still sitting at 'UNKNOWN', and assertCanOperate refuses to send a command
-- in that state — so without this, every existing owner would find their
-- dashboard controls dead with DEVICE_STATE_UNKNOWN.
--
-- Only ASSIGNED rows are touched. A device nobody owns genuinely has an
-- unknown state and is left alone.
UPDATE "Device"
SET "lockState" = 'LOCKED'
WHERE "status" = 'ASSIGNED' AND "lockState" = 'UNKNOWN';
