import { z } from 'zod';
import { INDIAN_PHONE_REGEX } from './auth';
import { OTP_LENGTH, OTP_MAX_ATTEMPTS } from './devices';

/**
 * Phone numbers, in the two representations this product uses.
 *
 * ## Why there are two
 * `User.phone` stores the **bare 10-digit national number** (`9876543210`).
 * That is what signup has always written, what the unique constraint is built
 * on, and what the admin lists search. WhatsApp needs **E.164**
 * (`+919876543210`). Rather than migrate every existing row and every query,
 * the national form stays the stored identity and E.164 is derived at the
 * delivery boundary. {@link toE164} and {@link toNationalPhone} are the only
 * two places that conversion happens.
 *
 * ## Why India-only
 * The product ships in India, the price is in paise, and the signup form has
 * always demanded a 10-digit Indian mobile. Accepting an arbitrary country
 * code would mean a number we cannot validate, cannot price delivery for, and
 * cannot be confident WhatsApp will reach. A number that is not an Indian
 * mobile is rejected rather than stored and discovered later.
 */

/** India. The only country code this product accepts. */
export const INDIA_COUNTRY_CODE = '91';

/**
 * Normalises almost anything a person might type into E.164, or returns null.
 *
 * Accepts, after stripping spaces, dashes, dots and brackets:
 * - `9876543210`      — bare national
 * - `09876543210`     — national with the domestic trunk prefix
 * - `+919876543210`   — E.164
 * - `919876543210`    — E.164 without the plus
 * - `00919876543210`  — international access code
 *
 * Returns null for everything else, including a valid-looking number with the
 * wrong country code. **Null is the only failure mode** — this never throws
 * and never guesses.
 */
export function toE164(raw: string): string | null {
  // Keep digits and a single leading plus; everything else is formatting.
  const cleaned = raw.trim().replace(/[\s().-]/g, '');
  if (!/^\+?\d+$/.test(cleaned)) return null;

  let digits = cleaned.startsWith('+') ? cleaned.slice(1) : cleaned;

  // Strip the international access code, then the country code, then the
  // domestic trunk prefix — in that order, because `0091…` carries both.
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length > 10 && digits.startsWith(INDIA_COUNTRY_CODE)) {
    digits = digits.slice(INDIA_COUNTRY_CODE.length);
  }
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);

  // The national number must be a real Indian mobile: 10 digits, starting 6-9.
  if (!INDIAN_PHONE_REGEX.test(digits)) return null;

  return `+${INDIA_COUNTRY_CODE}${digits}`;
}

/**
 * The 10-digit national form of an E.164 number, or null.
 *
 * Used when writing `User.phone`, which is the column the unique constraint
 * lives on — a mix of representations there would let one physical number
 * exist twice.
 */
export function toNationalPhone(e164: string): string | null {
  const match = /^\+91(\d{10})$/.exec(e164.trim());
  if (!match?.[1]) return null;
  return INDIAN_PHONE_REGEX.test(match[1]) ? match[1] : null;
}

/**
 * A number safe to show in a UI, a log line or an audit row.
 *
 * `+919876543210` and `9876543210` both become `+91 98****10`.
 *
 * The mask is a **fixed four asterisks** regardless of how many digits it
 * hides, so the output reveals neither the middle digits nor the length. Two
 * digits at each end is enough for someone to recognise their own number — and
 * to spot that they typed a stranger's — without being enough to identify a
 * person from a log.
 *
 * Returns a constant for anything unparseable rather than echoing the input,
 * so a malformed value cannot be laundered into a log line through this
 * function.
 */
export function maskPhone(value: string | null | undefined): string {
  if (!value) return '(none)';

  const e164 = toE164(value);
  const national = e164 ? toNationalPhone(e164) : null;
  if (!national) return '(hidden)';

  return `+${INDIA_COUNTRY_CODE} ${national.slice(0, 2)}****${national.slice(-2)}`;
}

/**
 * A phone number from a request body, normalised to E.164.
 *
 * Normalisation happens **inside** validation, so a handler can never see a
 * number in a format it did not expect, and `+91 98765 43210` and
 * `9876543210` cannot become two different stored values.
 */
export const phoneE164Schema = z
  .string()
  .trim()
  .min(1, 'Phone number is required')
  // Bounded before any parsing so a megabyte of digits is refused cheaply.
  .max(24, 'Phone number is too long')
  .transform((value, ctx) => {
    const e164 = toE164(value);
    if (!e164) {
      ctx.addIssue({
        code: 'custom',
        message: 'Enter a valid 10-digit Indian mobile number',
      });
      return z.NEVER;
    }
    return e164;
  });

// --- Phone verification ------------------------------------------------------

/**
 * Verification code parameters.
 *
 * Deliberately the **same** numbers as the unlock OTP (6 digits, 5 minutes, 5
 * attempts), imported rather than re-declared. Two different code lengths in
 * one product is a UI inconsistency people notice and a second set of
 * constants to keep in step for no benefit.
 */
export const PHONE_OTP_LENGTH = OTP_LENGTH;
export const PHONE_OTP_TTL_MS = 5 * 60 * 1000;
export const PHONE_OTP_MAX_ATTEMPTS = OTP_MAX_ATTEMPTS;
/** How long the UI disables "Resend" after a verification code is sent. */
export const PHONE_OTP_RESEND_COOLDOWN_SECONDS = 30;

/**
 * The WhatsApp opt-in wording, and its version.
 *
 * Kept here so the web app renders exactly the text whose version the API
 * stores against the user. Meta requires an explicit opt-in before a business
 * may message someone; "we recorded consent" is only meaningful if we can say
 * *what* they consented to, which is what the version is for.
 *
 * **Bump the version whenever the text changes.** An old consent then remains
 * an accurate record of the old wording rather than silently claiming to cover
 * the new one.
 */
export const WHATSAPP_CONSENT_VERSION = 1;

export const WHATSAPP_CONSENT_TEXT =
  'I agree to receive WhatsApp messages from Safe Lock for one-time codes and ' +
  'security alerts about my safe. Message rates may apply.';

// --- Request bodies ----------------------------------------------------------

/**
 * `POST /account/phone/request-verification`.
 *
 * `currentPassword` is optional **in the schema** and conditionally required
 * **in the service**: it is demanded only when the account already has a
 * verified number, because that case is a credential change — someone who has
 * borrowed an unlocked session should not be able to move the number that
 * receives unlock codes. Enforcing it here instead would mean demanding a
 * password from a first-time verifier who is simply confirming the number they
 * signed up with.
 */
export const requestPhoneVerificationSchema = z
  .object({
    phone: phoneE164Schema,
    /** Meta requires an explicit opt-in before any message is sent. */
    consent: z.boolean(),
    currentPassword: z.string().min(1).max(128).optional(),
  })
  .strict();

export const confirmPhoneVerificationSchema = z
  .object({
    otp: z
      .string()
      .trim()
      .transform((value) => value.replace(/[\s-]/g, ''))
      .pipe(
        z
          .string()
          .regex(
            new RegExp(`^\\d{${PHONE_OTP_LENGTH}}$`),
            `Enter the ${PHONE_OTP_LENGTH}-digit code`,
          ),
      ),
  })
  .strict();

export type RequestPhoneVerificationInput = z.infer<typeof requestPhoneVerificationSchema>;
export type ConfirmPhoneVerificationInput = z.infer<typeof confirmPhoneVerificationSchema>;
