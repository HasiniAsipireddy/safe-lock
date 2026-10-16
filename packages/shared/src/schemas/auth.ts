import { z } from 'zod';
import { NAME_RULES, PASSWORD_RULES } from '../constants';

/** Indian mobile number: exactly 10 digits, starting 6-9. */
export const INDIAN_PHONE_REGEX = /^[6-9]\d{9}$/;

export const emailSchema = z
  .string()
  .trim()
  .min(1, 'Email is required')
  .max(254, 'Email is too long')
  .toLowerCase()
  .email('Enter a valid email address');

export const phoneSchema = z
  .string()
  .trim()
  .min(1, 'Phone number is required')
  .regex(INDIAN_PHONE_REGEX, 'Enter a valid 10-digit Indian mobile number');

export const nameSchema = z
  .string()
  .trim()
  .min(NAME_RULES.minLength, `Name must be at least ${NAME_RULES.minLength} characters`)
  .max(NAME_RULES.maxLength, `Name must be at most ${NAME_RULES.maxLength} characters`);

export const passwordSchema = z
  .string()
  .min(PASSWORD_RULES.minLength, `Password must be at least ${PASSWORD_RULES.minLength} characters`)
  .max(PASSWORD_RULES.maxLength, `Password must be at most ${PASSWORD_RULES.maxLength} characters`)
  .regex(/[A-Za-z]/, 'Password must contain at least one letter')
  .regex(/\d/, 'Password must contain at least one number');

/**
 * Login accepts either an email address or a 10-digit Indian mobile number in
 * a single `identifier` field.
 */
export const loginIdentifierSchema = z
  .string()
  .trim()
  .min(1, 'Email or phone number is required')
  .refine(
    (value) => INDIAN_PHONE_REGEX.test(value) || emailSchema.safeParse(value).success,
    'Enter a valid email address or 10-digit mobile number',
  );

export const loginSchema = z.object({
  identifier: loginIdentifierSchema,
  // Not run through passwordSchema on purpose: a login form must not hint at
  // the password policy or pre-reject a legacy password.
  password: z.string().min(1, 'Password is required'),
});

export const signupSchema = z
  .object({
    name: nameSchema,
    email: emailSchema,
    phone: phoneSchema,
    password: passwordSchema,
    confirmPassword: z.string().min(1, 'Please confirm your password'),
    // Kept as a boolean (rather than z.literal(true)) so a form can start
    // unchecked while still refusing to submit until it is ticked.
    acceptedTerms: z.boolean().refine((value) => value, {
      message: 'You must accept the Terms of Service and Privacy Policy',
    }),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

export type LoginInput = z.infer<typeof loginSchema>;
export type SignupInput = z.infer<typeof signupSchema>;

// --- Password reset ----------------------------------------------------------

/**
 * Reset uses a one-time **code**, not a link carrying a long token.
 *
 * ## Why a code
 * The code is delivered over WhatsApp, and a WhatsApp message is persistent,
 * forwardable and backed up to whatever cloud the account is mirrored to. A
 * 32-byte token in such a message is an account takeover in one string that
 * outlives its expiry in someone's chat history. A code is useless without
 * also knowing the account identifier and being able to reach this endpoint
 * within 15 minutes, and it is spent on first use.
 *
 * ## Why 8 digits
 * 10^8 against {@link RESET_CODE_MAX_ATTEMPTS} is a 1-in-20-million shot per
 * code. Base32 would give 10^12, which the attempt cap makes unreachable
 * either way — so the extra entropy buys nothing, while digits buy a numeric
 * keypad on mobile, no case handling, no "is that O or 0" on a code read off a
 * message, and a working `autocomplete="one-time-code"`.
 *
 * **The tradeoff this accepts:** 8 digits is safe *because* the per-account
 * attempt counter works. Base32 would survive a broken attempt limit; this
 * will not. The counter is therefore load-bearing and incremented atomically.
 * See docs/decisions.md.
 */
export const RESET_CODE_LENGTH = 8;

/**
 * How long a reset code is good for.
 *
 * 15 minutes: long enough to switch apps, read a message and type 8 digits;
 * short enough that a code left on a screen is not a standing risk. Half the
 * 30 minutes the old link had, because a code is easier to shoulder-surf than
 * a URL nobody reads.
 */
export const PASSWORD_RESET_TTL_MS = 15 * 60 * 1000;

/** Wrong guesses before the code is invalidated outright. */
export const RESET_CODE_MAX_ATTEMPTS = 5;

/**
 * Minimum gap between code requests for one account.
 *
 * Enforced **on the server** as a rate-limit limb keyed on the hashed
 * identifier — not merely as a UI countdown — and that limb runs before any
 * database lookup, so its 429 is identical whether or not the account exists.
 * The UI uses the same number for its resend countdown, from this constant, so
 * the two cannot drift.
 */
export const RESET_CODE_RESEND_COOLDOWN_SECONDS = 30;

/**
 * Who the reset is for.
 *
 * Accepts an email address **or** a 10-digit mobile, via the same schema
 * `/auth/login` uses: the code arrives on WhatsApp, so entering the phone
 * number it arrives on is the natural thing to do, and accepting both
 * discloses nothing a single field would not.
 */
export const forgotPasswordSchema = z
  .object({ identifier: loginIdentifierSchema })
  .strict();

/**
 * A submitted reset code.
 *
 * Exactly {@link RESET_CODE_LENGTH} digits, with spaces and dashes stripped
 * first so a code pasted as `4031 8725` is accepted. The length check runs on
 * the cleaned value, so padding cannot smuggle a longer string through. Shaped
 * like `otpSchema`, deliberately.
 */
export const resetCodeSchema = z
  .string()
  .trim()
  // Bounded before any cleaning so a megabyte is refused cheaply.
  .max(64, 'That reset code is not valid')
  .transform((value) => value.replace(/[\s-]/g, ''))
  .pipe(
    z
      .string()
      .regex(
        new RegExp(`^\\d{${RESET_CODE_LENGTH}}$`),
        `Enter the ${RESET_CODE_LENGTH}-digit code`,
      ),
  );

/**
 * What `POST /auth/password/reset` accepts. `confirmPassword` is client-only.
 *
 * The identifier is required alongside the code: a code alone is only 8 digits
 * and would otherwise be guessable against the whole user table at once, where
 * naming the account confines every guess to one attempt counter.
 */
export const resetPasswordBodySchema = z
  .object({
    identifier: loginIdentifierSchema,
    code: resetCodeSchema,
    password: passwordSchema,
  })
  .strict();

/** The `/reset-password` form, which also makes the user retype the password. */
export const resetPasswordSchema = z
  .object({
    identifier: loginIdentifierSchema,
    code: resetCodeSchema,
    password: passwordSchema,
    confirmPassword: z.string().min(1, 'Please confirm your password'),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

// --- Change password (signed in) ---------------------------------------------

/** What `POST /auth/password/change` accepts. */
export const changePasswordBodySchema = z
  .object({
    // Not run through passwordSchema: it is an existing credential being
    // proved, not a new one being set, and pre-rejecting it would leak the
    // policy that applied when the account was created.
    currentPassword: z.string().min(1, 'Enter your current password'),
    password: passwordSchema,
  })
  .strict();

/** The `/account` change-password form. */
export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password'),
    password: passwordSchema,
    confirmPassword: z.string().min(1, 'Please confirm your new password'),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

// --- Profile -----------------------------------------------------------------

/**
 * What `PATCH /auth/profile` accepts: **the name and nothing else.**
 *
 * `.strict()` matters here. Email and phone are identifiers — one is how a
 * reset link is delivered, the other is where an unlock code will go — so
 * changing either needs a verification flow that does not exist yet. Without
 * `.strict()` a body carrying `{ name, email }` would silently have the email
 * ignored, which looks to the user exactly like a change that worked. A 400
 * says what actually happened.
 */
export const updateProfileSchema = z.object({ name: nameSchema }).strict();

export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type ResetPasswordBody = z.infer<typeof resetPasswordBodySchema>;
export type ResetCodeInput = z.infer<typeof resetCodeSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type ChangePasswordBody = z.infer<typeof changePasswordBodySchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

/** Classifies a login identifier so the API can look up the right column. */
export function classifyIdentifier(identifier: string): 'email' | 'phone' {
  return INDIAN_PHONE_REGEX.test(identifier.trim()) ? 'phone' : 'email';
}
