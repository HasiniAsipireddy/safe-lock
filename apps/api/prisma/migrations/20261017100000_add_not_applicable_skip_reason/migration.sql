-- The skip reason for a message that re-validation refused at send time.
--
-- Separate from CANCELLED, which is the same situation caught by the other
-- guard: cancellation at the state change, re-validation at the send. Keeping
-- them apart is what makes a pile of NOT_APPLICABLE readable as "some state
-- change is not cancelling what it should" rather than as normal traffic.
--
-- Its own migration because the enum values added alongside the scheduling
-- columns are already applied; Postgres cannot use a value added in the same
-- transaction that adds it, so a later migration is the honest way to add one.

-- AlterEnum
ALTER TYPE "OutboundFailureCategory" ADD VALUE 'NOT_APPLICABLE';
