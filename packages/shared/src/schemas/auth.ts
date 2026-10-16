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

/** Bytes of entropy in a reset token. 32 random bytes is 2^256 of guess space. */
export const RESET_TOKEN_BYTES = 32;

/** How long a reset token is good for. Shorter than a session, longer than an OTP. */
export const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;

/**
 * Reset is requested by **email only**, even though login accepts a phone
 * number too: the link has to be delivered somewhere, and email is the channel
 * every account has. (Nothing is actually delivered yet — see the OTP channel
 * open question in CLAUDE.md.)
 */
export const forgotPasswordSchema = z.object({ email: emailSchema }).strict();

/**
 * The token as it arrives from the URL.
 *
 * Length and alphabet are checked **before** anything is hashed or looked up,
 * so an oversized or non-base64url value is a 400 rather than work the server
 * does on an attacker's behalf. 32 bytes base64url-encode to 43 characters;
 * the upper bound leaves room without inviting a megabyte.
 */
export const resetTokenSchema = z
  .string()
  .trim()
  .min(1, 'Reset link is missing its token')
  .max(64, 'That reset link is not valid')
  .regex(/^[A-Za-z0-9_-]+$/, 'That reset link is not valid');

/** What `POST /auth/password/reset` accepts. `confirmPassword` is client-only. */
export const resetPasswordBodySchema = z
  .object({ token: resetTokenSchema, password: passwordSchema })
  .strict();

/** The `/reset-password` form, which also makes the user retype it. */
export const resetPasswordSchema = z
  .object({
    token: resetTokenSchema,
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
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type ChangePasswordBody = z.infer<typeof changePasswordBodySchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

/** Classifies a login identifier so the API can look up the right column. */
export function classifyIdentifier(identifier: string): 'email' | 'phone' {
  return INDIAN_PHONE_REGEX.test(identifier.trim()) ? 'phone' : 'email';
}
