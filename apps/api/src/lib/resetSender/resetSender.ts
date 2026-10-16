/**
 * The password-reset delivery seam.
 *
 * Step 3 put reset delivery in a plain function with a `TODO`. This is that
 * function given a shape, for the same reason `DeviceGateway` and `Notifier`
 * have one: there is exactly one place the application says "get this reset
 * link to this person", so adding or changing a channel is a new file here.
 *
 * ## The outcome is advisory, and that is the point
 * `/auth/password/forgot` answers **byte-identically** whether or not the
 * address has an account — that is the property the endpoint exists to
 * protect. It follows that it must also answer identically whether or not
 * delivery succeeded, was skipped for a missing phone, or was skipped because
 * the daily cap was spent. Otherwise the cap becomes exactly the enumeration
 * oracle the identical response was built to deny.
 *
 * So a sender reports what happened for the **log and nothing else**. No
 * caller may branch on it in a way a client could observe.
 */

export type ResetDeliveryOutcome =
  | { status: 'SENT' }
  /** We chose not to send: no verified number, no consent, or cap spent. */
  | { status: 'SKIPPED'; reason: string }
  | { status: 'FAILED'; reason: string };

export interface ResetDelivery {
  userId: string;
  /**
   * The raw 8-digit code.
   *
   * Never stored (only its HMAC is), never logged, never in a response. It
   * exists in memory for the length of one request and in the message.
   */
  code: string;
  expiresAt: Date;
}

export interface ResetSender {
  readonly name: string;

  /**
   * Attempts to get a reset code to the user.
   *
   * **Must not throw for an ordinary failure.** A thrown error would change
   * the shape of `/auth/password/forgot`'s response, and that response has to
   * stay the same for every input.
   */
  send(delivery: ResetDelivery): Promise<ResetDeliveryOutcome>;
}
