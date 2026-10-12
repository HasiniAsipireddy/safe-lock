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

/** Classifies a login identifier so the API can look up the right column. */
export function classifyIdentifier(identifier: string): 'email' | 'phone' {
  return INDIAN_PHONE_REGEX.test(identifier.trim()) ? 'phone' : 'email';
}
