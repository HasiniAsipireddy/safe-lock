-- CreateEnum
CREATE TYPE "RefreshTokenRevokedReason" AS ENUM ('ROTATED', 'LOGOUT', 'PASSWORD_CHANGE', 'PASSWORD_RESET', 'REUSE_CASCADE');

-- AlterTable
ALTER TABLE "RefreshToken" ADD COLUMN     "revokedReason" "RefreshTokenRevokedReason";
