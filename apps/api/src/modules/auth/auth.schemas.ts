import { emailSchema, loginSchema, nameSchema, passwordSchema, phoneSchema } from '@safelock/shared';
import { z } from 'zod';

/**
 * Server-side signup body.
 *
 * Composed from the same field schemas the web form uses, minus the two
 * client-only fields: `confirmPassword` and `acceptedTerms` are never sent
 * (see docs/decisions.md) so the API must not require them.
 */
export const signupBodySchema = z
  .object({
    name: nameSchema,
    email: emailSchema,
    phone: phoneSchema,
    password: passwordSchema,
  })
  .strict();

export type SignupBody = z.infer<typeof signupBodySchema>;

/** Login body — identical to the form's, which carries no extra fields. */
export const loginBodySchema = loginSchema;
