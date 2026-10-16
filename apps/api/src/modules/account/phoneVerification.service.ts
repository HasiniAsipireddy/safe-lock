import {
  ERROR_CODES,
  PHONE_OTP_MAX_ATTEMPTS,
  PHONE_OTP_RESEND_COOLDOWN_SECONDS,
  PHONE_OTP_TTL_MS,
  WHATSAPP_CONSENT_VERSION,
  maskPhone,
  toNationalPhone,
  type PhoneVerificationRequestResponse,
  type PublicUser,
} from '@safelock/shared';
import { env } from '../../config/env';
import { HttpError } from '../../lib/httpError';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { generateOtp, hashOtp, mayPrintOtp, verifyOtp } from '../devices/otp.service';
import { loadPublicUser } from '../users/user.mapper';
import { verifyPassword } from '../auth/password';
import { capResetsAt, isCapReached, sendWhatsApp } from '../../lib/whatsapp/send';

/**
 * Phone verification.
 *
 * Reuses the unlock OTP's parameters and primitives — 6 digits from
 * `crypto.randomInt`, HMAC'd under `OTP_HMAC_SECRET`, 5 minutes, 5 attempts,
 * one live challenge at a time. Two different code lengths in one product is
 * an inconsistency people notice, and a second set of constants is a second
 * thing to keep in step for no benefit.
 *
 * ## The candidate number is not the stored number
 * The number under verification lives on the `PhoneVerification` row and only
 * reaches `User.phone` when a code is confirmed. Three things follow, all of
 * them wanted:
 * - changing a verified number leaves the **old one live** and receiving codes
 *   until the new one is proved,
 * - an abandoned change costs nothing and leaves no half-state,
 * - a hostile session cannot move the number codes go to without also
 *   receiving one at the new number.
 *
 * ## Enumeration
 * A request for a number that belongs to another account answers **exactly**
 * like a successful one, and sends nothing. The response carries the masked
 * number so a user who mistyped can see it is not theirs. See
 * docs/decisions.md.
 */

const consentRequired = () =>
  new HttpError({
    status: 400,
    code: ERROR_CODES.CONSENT_REQUIRED,
    message: 'Please agree to receive WhatsApp messages so we can send your code.',
  });

const alreadyVerified = () =>
  new HttpError({
    status: 409,
    code: ERROR_CODES.PHONE_ALREADY_VERIFIED,
    message: 'That number is already verified on your account.',
  });

const passwordRequired = () =>
  new HttpError({
    status: 400,
    code: ERROR_CODES.PASSWORD_INCORRECT,
    message: 'Enter your current password to change your verified number.',
  });

const otpFailure = (code: string, message: string) =>
  new HttpError({ status: 400, code, message });

/**
 * A spent cap is a 429 here, unlike on `/forgot-password`.
 *
 * This endpoint is authenticated, so telling the caller about their own
 * allowance reveals nothing they could not already count. `/forgot-password`
 * is unauthenticated, which is why it must stay byte-identical and silently
 * skip instead.
 */
async function capReached(userId: string): Promise<HttpError> {
  const resetsAt = await capResetsAt(userId);

  return new HttpError({
    status: 429,
    code: ERROR_CODES.WHATSAPP_SEND_CAP_REACHED,
    message: resetsAt
      ? `You have reached today’s limit for WhatsApp messages. Please try again after ${resetsAt.toISOString()}.`
      : 'You have reached today’s limit for WhatsApp messages. Please try again later.',
  });
}

export interface RequestVerificationInput {
  userId: string;
  /** E.164, already normalised by the schema. */
  phoneE164: string;
  consent: boolean;
  currentPassword?: string | undefined;
  ip?: string | null;
  userAgent?: string | null;
}

export interface RequestVerificationResult {
  response: PhoneVerificationRequestResponse;
  /** For the audit row: whether a code was actually sent. */
  sent: boolean;
  /** Set when the number belongs to someone else. Audited, never returned. */
  collision: boolean;
}

/**
 * Issues a verification code for a candidate number.
 *
 * Consent is checked **first and unconditionally**: Meta requires an explicit
 * opt-in before any message, so a request without it must not send one — and
 * must not be allowed to look like it did.
 */
export async function requestPhoneVerification(
  input: RequestVerificationInput,
): Promise<RequestVerificationResult> {
  if (!input.consent) throw consentRequired();

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: input.userId },
    select: { id: true, phone: true, phoneVerifiedAt: true, passwordHash: true },
  });

  const national = toNationalPhone(input.phoneE164);
  // Unreachable: the schema normalised and validated it already.
  if (!national) throw otpFailure(ERROR_CODES.VALIDATION_ERROR, 'Enter a valid mobile number');

  const alreadyMine = user.phoneVerifiedAt !== null && user.phone === national;
  if (alreadyMine) throw alreadyVerified();

  /**
   * Changing an **already verified** number requires the password.
   *
   * The number receives unlock codes, so moving it is a credential change.
   * Someone who found an unlocked laptop should not be able to redirect the
   * codes for a safe. Deliberately *not* required for a first verification:
   * demanding a password from someone simply confirming the number they signed
   * up with is friction that buys nothing.
   */
  if (user.phoneVerifiedAt) {
    if (!input.currentPassword) throw passwordRequired();
    if (!(await verifyPassword(user.passwordHash, input.currentPassword))) {
      throw passwordRequired();
    }
  }

  if (await isCapReached(input.userId)) throw await capReached(input.userId);

  /**
   * Uniqueness, failing closed.
   *
   * `User.phone` is unique, so a number already on another account cannot be
   * taken. Saying so would be an oracle: anyone could test whether a given
   * mobile has a Safe Lock account — and therefore, probably, a safe. So the
   * response is identical to a success and **nothing is sent**: no code goes
   * to a number the caller has not proved any claim to.
   *
   * The masked number in the response is what rescues the honest mistake: a
   * user who typed a digit wrong sees `+91 98****10` and can tell it is not
   * theirs.
   */
  const owner = await prisma.user.findUnique({
    where: { phone: national },
    select: { id: true },
  });
  const collision = owner !== null && owner.id !== user.id;

  const code = generateOtp();
  const expiresAt = new Date(Date.now() + PHONE_OTP_TTL_MS);
  let sent = false;

  if (!collision) {
    await prisma.$transaction(async (tx) => {
      // One live challenge at a time, exactly as the unlock flow does. Without
      // it, "5 attempts per challenge" becomes "5 per request".
      await tx.phoneVerification.updateMany({
        where: { userId: input.userId, consumedAt: null },
        data: { consumedAt: new Date() },
      });

      await tx.phoneVerification.create({
        data: {
          userId: input.userId,
          phoneE164: input.phoneE164,
          otpHash: hashOtp(code),
          expiresAt,
          requestedIp: input.ip ?? null,
          userAgent: input.userAgent?.slice(0, 500) ?? null,
        },
      });

      /**
       * Consent is recorded **now**, not on confirmation.
       *
       * The code itself is a WhatsApp message, so permission has to exist
       * before it is sent. Recording it here is also what makes the record
       * honest: the user agreed at this moment, to this wording.
       */
      await tx.user.update({
        where: { id: input.userId },
        data: {
          whatsappConsentAt: new Date(),
          whatsappConsentVersion: WHATSAPP_CONSENT_VERSION,
        },
      });
    });

    if (mayPrintOtp(env.NODE_ENV)) {
      // Dev only, guarded exactly as the unlock code's print is.
      // eslint-disable-next-line no-console -- see mayPrintOtp
      console.log(
        `\n  [dev] Phone verification code for ${maskPhone(input.phoneE164)}: ${code}` +
          `  (expires ${expiresAt.toISOString()})\n`,
      );
    }

    /**
     * Sent to the **candidate** number, not the stored one.
     *
     * `sendWhatsApp` gates on a verified number, which this user may not have
     * yet — that gate exists to stop unlock codes going to unproved numbers.
     * A verification code is the one message whose whole purpose is to reach
     * an unproved number, so the send is made directly with the candidate as
     * recipient. The cap was checked above.
     */
    const outcome = await sendWhatsApp({
      recipient: {
        userId: input.userId,
        phone: input.phoneE164,
        // Treated as verified *for this one message only*: the code is what
        // proves the number, so requiring proof first would be circular.
        phoneVerifiedAt: new Date(),
        whatsappConsentAt: new Date(),
      },
      kind: 'PHONE_OTP',
      params: [code],
      ignoreCap: true,
    });

    sent = outcome.status === 'SENT';

    if (!sent) {
      // Same compensation as the unlock code: no undeliverable challenge is
      // left open. The user simply asks again.
      await prisma.phoneVerification.updateMany({
        where: { userId: input.userId, consumedAt: null },
        data: { consumedAt: new Date() },
      });

      throw new HttpError({
        status: 502,
        code: ERROR_CODES.OTP_DELIVERY_FAILED,
        message: 'We could not send your verification code. Please try again in a moment.',
      });
    }
  } else {
    logger.warn(
      { userId: input.userId, maskedPhone: maskPhone(input.phoneE164) },
      'Phone verification requested for a number owned by another account; sent nothing',
    );
  }

  return {
    // Identical for a free number and one owned by someone else.
    response: {
      maskedPhone: maskPhone(input.phoneE164),
      expiresAt: expiresAt.toISOString(),
      expiresInSeconds: Math.round(PHONE_OTP_TTL_MS / 1000),
      attemptsAllowed: PHONE_OTP_MAX_ATTEMPTS,
      resendAfterSeconds: PHONE_OTP_RESEND_COOLDOWN_SECONDS,
    },
    sent,
    collision,
  };
}

export interface ConfirmVerificationResult {
  user: PublicUser;
  /** The number that is now verified, masked, for the audit row. */
  maskedPhone: string;
}

/**
 * Confirms a code and promotes the candidate number to the account.
 *
 * The promotion and the challenge's consumption are one transaction: a number
 * can never be marked verified without the code being spent, and a spent code
 * can never leave the number unverified.
 */
export async function confirmPhoneVerification(input: {
  userId: string;
  otp: string;
}): Promise<ConfirmVerificationResult> {
  const challenge = await prisma.phoneVerification.findFirst({
    where: { userId: input.userId, consumedAt: null },
    orderBy: { createdAt: 'desc' },
    select: { id: true, otpHash: true, expiresAt: true, attempts: true, phoneE164: true },
  });

  if (!challenge) {
    throw otpFailure(
      ERROR_CODES.PHONE_VERIFICATION_NOT_FOUND,
      'That code is no longer valid. Request a new one.',
    );
  }

  if (challenge.expiresAt.getTime() <= Date.now()) {
    await consume(challenge.id);
    throw otpFailure(
      ERROR_CODES.PHONE_VERIFICATION_EXPIRED,
      'That code has expired. Request a new one.',
    );
  }

  if (challenge.attempts >= PHONE_OTP_MAX_ATTEMPTS) {
    await consume(challenge.id);
    throw otpFailure(
      ERROR_CODES.PHONE_VERIFICATION_TOO_MANY_ATTEMPTS,
      'Too many incorrect codes. Request a new one.',
    );
  }

  if (!verifyOtp(input.otp, challenge.otpHash)) {
    const { attempts } = await prisma.phoneVerification.update({
      where: { id: challenge.id },
      data: { attempts: { increment: 1 } },
      select: { attempts: true },
    });

    if (attempts >= PHONE_OTP_MAX_ATTEMPTS) {
      await consume(challenge.id);
      throw otpFailure(
        ERROR_CODES.PHONE_VERIFICATION_TOO_MANY_ATTEMPTS,
        'Too many incorrect codes. Request a new one.',
      );
    }

    const left = PHONE_OTP_MAX_ATTEMPTS - attempts;
    throw otpFailure(
      ERROR_CODES.PHONE_VERIFICATION_INVALID,
      `That code is not correct. ${left} attempt${left === 1 ? '' : 's'} left.`,
    );
  }

  const national = toNationalPhone(challenge.phoneE164);
  if (!national) {
    await consume(challenge.id);
    throw otpFailure(ERROR_CODES.VALIDATION_ERROR, 'That number is no longer valid.');
  }

  await prisma.$transaction(async (tx) => {
    // The serialisation point: exactly one concurrent confirm claims it.
    const claimed = await tx.phoneVerification.updateMany({
      where: { id: challenge.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    if (claimed.count !== 1) {
      throw otpFailure(
        ERROR_CODES.PHONE_VERIFICATION_NOT_FOUND,
        'That code has already been used. Request a new one.',
      );
    }

    /**
     * Only now does the number become the account's.
     *
     * The unique constraint on `User.phone` is the backstop against the
     * collision check above having raced: if the number was claimed in
     * between, this throws and the transaction rolls back — the code is not
     * spent, the old number is untouched, and the user can try another.
     */
    await tx.user.update({
      where: { id: input.userId },
      data: { phone: national, phoneVerifiedAt: new Date() },
    });
  });

  const user = await loadPublicUser(input.userId);
  if (!user) {
    throw new HttpError({
      status: 401,
      code: ERROR_CODES.UNAUTHENTICATED,
      message: 'You are not signed in.',
    });
  }

  return { user, maskedPhone: maskPhone(challenge.phoneE164) };
}

/** Marks a challenge dead. Idempotent — only an open one is touched. */
async function consume(id: string): Promise<void> {
  await prisma.phoneVerification.updateMany({
    where: { id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
}
