import crypto from 'node:crypto';
import type { UserRole } from '@safelock/shared';
import { REFRESH_TOKEN_TTL_MS } from '../../config/env';
import { prisma } from '../../lib/prisma';
import type { PrismaTransaction } from '../../lib/prisma';

/**
 * Refresh token issuing, rotation and reuse detection.
 *
 * ## Shape
 * A refresh token is 32 bytes from `crypto.randomBytes`, base64url-encoded.
 * Not a JWT: a JWT is a bearer credential that stays valid until it expires,
 * and a 7-day credential that cannot be revoked is unacceptable for a product
 * that opens a safe. Only `sha256(token)` is persisted, so a database leak
 * yields nothing usable.
 *
 * ## Rotation
 * Redeeming a token revokes it and issues a successor in the same `familyId`,
 * linked by `replacedById`. One login is therefore one family, and one chain.
 *
 * ## Reuse detection
 * If an already-revoked token is presented, either the user raced themselves
 * (two tabs refreshing at once) or someone replayed a stolen token. We
 * distinguish by time:
 *
 * - **Inside {@link REFRESH_GRACE_WINDOW_MS}**, and only if this token has not
 *   already used its grace, it may mint **one** sibling in the same family.
 *   `graceUsedAt` enforces the "only once" part: a second grace presentation
 *   of the same token is treated as reuse.
 * - **Outside the window** (or on a second grace attempt) the whole family and
 *   every other refresh token for that user is revoked, and
 *   `REFRESH_REUSE_DETECTED` is audited.
 *
 * ## Why a sibling rather than re-issuing the successor
 * The successor's raw value exists only in the first tab's cookie — we store
 * only its hash and cannot reconstruct it. Minting a sibling keeps both tabs
 * working without ever holding a raw token at rest. See docs/decisions.md for
 * the tradeoff this accepts.
 */

/**
 * How long after rotation a replayed token is forgiven.
 *
 * **Set to 0 to disable the grace window entirely**, making any replay of a
 * revoked token immediate grounds for revoking the family.
 */
export const REFRESH_GRACE_WINDOW_MS = 10_000;

const TOKEN_BYTES = 32;

export interface IssueContext {
  userAgent?: string | null;
  ip?: string | null;
}

export interface IssuedToken {
  /** Give this to the client. It is never stored and cannot be recovered. */
  rawToken: string;
  id: string;
  familyId: string;
  expiresAt: Date;
}

export function hashRefreshToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

function generateRawToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

function expiryFromNow(now = new Date()): Date {
  return new Date(now.getTime() + REFRESH_TOKEN_TTL_MS);
}

/** Issues the first token of a new family — i.e. a fresh login or signup. */
export async function issueRefreshToken(
  userId: string,
  context: IssueContext = {},
  client: PrismaTransaction | typeof prisma = prisma,
): Promise<IssuedToken> {
  const rawToken = generateRawToken();
  const expiresAt = expiryFromNow();

  const row = await client.refreshToken.create({
    data: {
      userId,
      tokenHash: hashRefreshToken(rawToken),
      familyId: crypto.randomUUID(),
      expiresAt,
      userAgent: context.userAgent?.slice(0, 500) ?? null,
      ip: context.ip ?? null,
    },
    select: { id: true, familyId: true },
  });

  return { rawToken, id: row.id, familyId: row.familyId, expiresAt };
}

/** Adds a token to an existing family (a rotation successor or a sibling). */
async function issueIntoFamily(
  tx: PrismaTransaction,
  params: { userId: string; familyId: string; context: IssueContext },
): Promise<IssuedToken> {
  const rawToken = generateRawToken();
  const expiresAt = expiryFromNow();

  const row = await tx.refreshToken.create({
    data: {
      userId: params.userId,
      tokenHash: hashRefreshToken(rawToken),
      familyId: params.familyId,
      expiresAt,
      userAgent: params.context.userAgent?.slice(0, 500) ?? null,
      ip: params.context.ip ?? null,
    },
    select: { id: true, familyId: true },
  });

  return { rawToken, id: row.id, familyId: row.familyId, expiresAt };
}

export type RedeemResult =
  | {
      outcome: 'rotated' | 'grace';
      userId: string;
      role: UserRole;
      token: IssuedToken;
      familyId: string;
    }
  | { outcome: 'reuse'; userId: string; familyId: string }
  | {
      outcome: 'invalid';
      reason: 'unknown' | 'expired' | 'user-missing' | 'password-changed';
    };

/**
 * Redeems a presented refresh token.
 *
 * Every state change is a conditional `updateMany` whose `where` includes the
 * precondition, so two concurrent requests cannot both win: the loser sees
 * `count === 0` and falls through to the replay path instead of double-issuing.
 */
export async function redeemRefreshToken(
  rawToken: string,
  context: IssueContext = {},
  /** Internal: guards the lost-race re-entry below against looping. */
  attempt = 0,
): Promise<RedeemResult> {
  const tokenHash = hashRefreshToken(rawToken);

  const existing = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      userId: true,
      familyId: true,
      expiresAt: true,
      revokedAt: true,
      graceUsedAt: true,
      // Required: the grace window only applies to rotation-revoked tokens,
      // which are exactly the ones with a successor recorded here.
      replacedById: true,
      // Required: distinguishes a token we revoked on purpose from one that
      // might have been stolen. See the replay path below.
      revokedReason: true,
    },
  });

  if (!existing) return { outcome: 'invalid', reason: 'unknown' };

  const now = new Date();

  if (existing.expiresAt.getTime() <= now.getTime()) {
    return { outcome: 'invalid', reason: 'expired' };
  }

  const user = await prisma.user.findUnique({
    where: { id: existing.userId },
    select: { id: true, role: true },
  });
  if (!user) return { outcome: 'invalid', reason: 'user-missing' };

  // --- Replay of an already-revoked token ---------------------------------
  if (existing.revokedAt) {
    /**
     * A token revoked by a password change or reset is **not** a theft
     * signal, and must not trigger the cascade.
     *
     * Those revocations already ended every session for the user on purpose,
     * and then handed the caller a brand-new one. The old tokens are still
     * sitting in other devices' cookie jars — a phone in a pocket, a
     * background tab polling notifications every 60 seconds — and each of
     * them will present a revoked token within moments. Reading that as theft
     * runs `revokeAllForUser`, which kills the successor too: the user
     * changes their password and is silently signed out of the very device
     * they changed it on, seconds later. (Observed exactly that way before
     * this check existed.)
     *
     * There is also nothing left to protect. The cascade exists for "we
     * cannot know which sessions are compromised"; here we revoked them all
     * deliberately a moment ago, so it can only do collateral damage. The
     * honest answer is a plain "your session ended, sign in again".
     */
    const deliberate =
      existing.revokedReason === 'PASSWORD_CHANGE' ||
      existing.revokedReason === 'PASSWORD_RESET';

    if (deliberate) return { outcome: 'invalid', reason: 'password-changed' };

    const elapsed = now.getTime() - existing.revokedAt.getTime();

    /**
     * The grace window forgives only tokens revoked **by rotation** — those
     * are the ones with a successor, i.e. the two-tabs-racing case.
     *
     * A token revoked any other way (logout, or the cascade from a reuse
     * detection) has no `replacedById`. Forgiving those would mean a token
     * replayed within 10 seconds of the user logging out still minted a
     * working session, which defeats the point of logging out.
     */
    const revokedByRotation = existing.replacedById !== null;
    const withinGrace =
      REFRESH_GRACE_WINDOW_MS > 0 && elapsed <= REFRESH_GRACE_WINDOW_MS && revokedByRotation;

    if (withinGrace && !existing.graceUsedAt) {
      // Claim the single grace use atomically. If another concurrent replay
      // got there first, count is 0 and this becomes reuse.
      const claimed = await prisma.refreshToken.updateMany({
        where: { id: existing.id, graceUsedAt: null },
        data: { graceUsedAt: now },
      });

      if (claimed.count === 1) {
        const token = await prisma.$transaction((tx) =>
          issueIntoFamily(tx, {
            userId: user.id,
            familyId: existing.familyId,
            context,
          }),
        );

        return {
          outcome: 'grace',
          userId: user.id,
          role: user.role,
          token,
          familyId: existing.familyId,
        };
      }
    }

    // Outside the window, or the grace was already spent: treat as theft.
    await revokeAllForUser(existing.userId);
    return { outcome: 'reuse', userId: existing.userId, familyId: existing.familyId };
  }

  // --- Normal rotation -----------------------------------------------------
  //
  // The successor is created first, then `revokedAt` and `replacedById` are
  // set in one conditional update. Doing it the other way round would leave a
  // window where the old row is revoked but has no successor recorded — and a
  // concurrent tab arriving in that window would be misread as theft, because
  // the grace window keys off `replacedById`.
  //
  // The whole thing is one transaction: if the conditional update finds the
  // row already revoked we lost the race, and throwing rolls the orphan
  // successor back.
  const LOST_RACE = 'refresh-rotation-lost-race';

  let token: IssuedToken;
  try {
    token = await prisma.$transaction(async (tx) => {
      const successor = await issueIntoFamily(tx, {
        userId: user.id,
        familyId: existing.familyId,
        context,
      });

      const revoked = await tx.refreshToken.updateMany({
        where: { id: existing.id, revokedAt: null },
        data: { revokedAt: now, replacedById: successor.id, revokedReason: 'ROTATED' },
      });

      if (revoked.count !== 1) throw new Error(LOST_RACE);

      return successor;
    });
  } catch (error) {
    if (error instanceof Error && error.message === LOST_RACE) {
      // Another request rotated this token microseconds ago. Re-enter through
      // the replay path so the grace window applies. One retry is always
      // enough (the row is now revoked, or gone); the guard means a surprise
      // can never become a hot loop.
      if (attempt >= 1) return { outcome: 'invalid', reason: 'unknown' };
      return redeemRefreshToken(rawToken, context, attempt + 1);
    }
    throw error;
  }

  return {
    outcome: 'rotated',
    userId: user.id,
    role: user.role,
    token,
    familyId: existing.familyId,
  };
}

/**
 * Revokes every token in a family — the rotation chain *and* any siblings
 * minted during a grace window, since they all share the `familyId`.
 */
export async function revokeFamily(familyId: string): Promise<number> {
  const result = await prisma.refreshToken.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: 'REUSE_CASCADE' },
  });
  return result.count;
}

/**
 * Revokes every live refresh token for a user, across all families.
 *
 * Three callers, and the `reason` is what separates them:
 * - **reuse detection** (`REUSE_CASCADE`): one token leaked and we cannot know
 *   which other sessions are compromised, so all of them end.
 * - **password change / reset** (`PASSWORD_CHANGE` / `PASSWORD_RESET`): a
 *   deliberate eviction. Replaying one of these tokens afterwards is ordinary
 *   — other devices still hold them — and is **not** treated as theft. See
 *   the replay path in {@link redeemRefreshToken}.
 *
 * Optionally runs on a transaction client, so a password change can revoke and
 * reissue atomically.
 */
export async function revokeAllForUser(
  userId: string,
  reason: 'REUSE_CASCADE' | 'PASSWORD_CHANGE' | 'PASSWORD_RESET' = 'REUSE_CASCADE',
  client: PrismaTransaction | typeof prisma = prisma,
): Promise<number> {
  const result = await client.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
  return result.count;
}

/** Revokes one presented token. Used by logout. Safe if already revoked. */
export async function revokeByRawToken(rawToken: string): Promise<boolean> {
  const result = await prisma.refreshToken.updateMany({
    where: { tokenHash: hashRefreshToken(rawToken), revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: 'LOGOUT' },
  });
  return result.count > 0;
}

/**
 * Deletes rows that can no longer authorise anything: expired, or revoked
 * longer ago than the retention window.
 *
 * Revoked rows are kept for a while on purpose — they are what makes reuse
 * detection possible. Deleting one immediately would turn a replayed stolen
 * token into an "unknown token" 401 and lose the theft signal.
 *
 * Callable from `scripts/cleanupRefreshTokens.ts`.
 */
export async function cleanupRefreshTokens(
  options: { revokedRetentionDays?: number; now?: Date } = {},
): Promise<{ deleted: number }> {
  const now = options.now ?? new Date();
  const retentionDays = options.revokedRetentionDays ?? 30;
  const revokedBefore = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);

  const result = await prisma.refreshToken.deleteMany({
    where: {
      OR: [{ expiresAt: { lt: now } }, { revokedAt: { lt: revokedBefore } }],
    },
  });

  return { deleted: result.count };
}
