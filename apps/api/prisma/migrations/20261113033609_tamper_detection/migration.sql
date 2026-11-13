-- CreateEnum
CREATE TYPE "TamperKind" AS ENUM ('VIBRATION', 'DOOR_FORCED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "DeviceEventType" ADD VALUE 'VIBRATION_DETECTED';
ALTER TYPE "DeviceEventType" ADD VALUE 'DOOR_FORCED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'TAMPER_VIBRATION';
ALTER TYPE "NotificationType" ADD VALUE 'TAMPER_DOOR_FORCED';

-- AlterTable
ALTER TABLE "Device" ADD COLUMN     "lastTamperAt" TIMESTAMP(3),
ADD COLUMN     "lastTamperKind" "TamperKind";
