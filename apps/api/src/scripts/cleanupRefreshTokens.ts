import { logger } from '../lib/logger';
import { disconnectPrisma } from '../lib/prisma';
import { cleanupRefreshTokens } from '../modules/auth/refreshToken.service';
import { cleanupPasswordResetCodes } from '../modules/auth/passwordReset.service';

/**
 * Deletes token rows that can no longer authorise anything.
 *
 * Run from cron or a scheduled job:
 *   npm --workspace apps/api run db:cleanup-tokens
 *
 * **Refresh tokens:** revoked rows are retained for 30 days rather than
 * deleted on revocation — they are what makes reuse detection work. Delete one
 * immediately and a replayed stolen token looks like an unknown token instead
 * of a theft signal.
 *
 * **Password reset tokens:** consumed rows are kept only 7 days, and purely
 * for forensics. There is no reuse-detection reason to hold them: a replayed
 * reset link and an expired one answer identically by design, so nothing
 * distinguishes them at request time anyway.
 */

async function main(): Promise<void> {
  const refresh = await cleanupRefreshTokens();
  const resets = await cleanupPasswordResetCodes();

  logger.info(
    { refreshDeleted: refresh.deleted, resetDeleted: resets.deleted },
    'Token cleanup complete',
  );
  process.stdout.write(
    `Deleted ${refresh.deleted} expired or long-revoked refresh token(s) ` +
      `and ${resets.deleted} spent password reset token(s)\n`,
  );
}

main()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Cleanup failed: ${message}\n`);
    process.exitCode = 1;
  })
  .finally(() => void disconnectPrisma());
