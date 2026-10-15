import { logger } from '../lib/logger';
import { disconnectPrisma } from '../lib/prisma';
import { cleanupRefreshTokens } from '../modules/auth/refreshToken.service';

/**
 * Deletes refresh token rows that can no longer authorise anything.
 *
 * Run from cron or a scheduled job:
 *   npm --workspace apps/api run db:cleanup-tokens
 *
 * Revoked rows are retained for 30 days rather than deleted on revocation —
 * they are what makes reuse detection work. Delete one immediately and a
 * replayed stolen token looks like an unknown token instead of a theft signal.
 */

async function main(): Promise<void> {
  const { deleted } = await cleanupRefreshTokens();
  logger.info({ deleted }, 'Refresh token cleanup complete');
  process.stdout.write(`Deleted ${deleted} expired or long-revoked refresh token(s)\n`);
}

main()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Cleanup failed: ${message}\n`);
    process.exitCode = 1;
  })
  .finally(() => void disconnectPrisma());
