import type { DeviceEventType, UnlockFailureReason } from '@safelock/shared';
import type { PrismaTransaction } from '../../lib/prisma';

/**
 * Writing a row to the user-visible activity feed.
 *
 * Extracted from `deviceControl.service.ts` because there are now **two**
 * places a device event is written: the request path, and the ack handler that
 * learns what the bolt actually did. Those are in different modules and must
 * not import each other, and a feed whose rows are shaped slightly differently
 * depending on which one wrote them is a feed that renders inconsistently.
 *
 * Never carries a code, a hash or a signature.
 */
export async function recordEvent(
  tx: PrismaTransaction,
  input: {
    deviceId: string;
    userId: string;
    type: DeviceEventType;
    /** Internal correlation only. In no `select` the history endpoint uses. */
    requestId: string | null;
    failureReason?: UnlockFailureReason | undefined;
  },
): Promise<string> {
  const event = await tx.deviceEvent.create({
    data: {
      deviceId: input.deviceId,
      userId: input.userId,
      type: input.type,
      source: 'WEB',
      requestId: input.requestId,
      ...(input.failureReason ? { failureReason: input.failureReason } : {}),
    },
    select: { id: true },
  });

  return event.id;
}
