'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  RESET_CODE_LENGTH,
  resetPasswordSchema,
  type PasswordResetResponse,
  type ResetPasswordInput,
} from '@safelock/shared';
import { api } from '@/lib/api';
import { ApiError } from '@/lib/apiError';
import { AuthCard } from '@/components/ui/AuthCard';
import { Button } from '@/components/ui/Button';
import { FormError } from '@/components/ui/FormError';
import { Input } from '@/components/ui/Input';
import { PasswordInput } from '@/components/ui/PasswordInput';
import { PasswordStrengthMeter } from '@/components/PasswordStrengthMeter';

/**
 * `/reset-password` — sets a new password from an 8-digit code.
 *
 * **Completing this does not sign anyone in.** The API returns no user and no
 * session cookie, and the page sends the visitor to `/login` to use the
 * password they just set. Holding a code proves control of a delivery channel,
 * which is enough to set a password and not enough to be handed a live session
 * to a safe.
 *
 * The identifier is prefilled from the query when the user arrived from
 * `/forgot-password`, and editable: it is not a secret — they typed it — and a
 * wrong one must be fixable without starting over.
 *
 * Not wrapped in `GuestOnly`: someone can legitimately be signed in here, and
 * the API revokes their sessions on success anyway.
 */
export default function ResetPasswordPage() {
  return (
    // useSearchParams needs a Suspense boundary at build time.
    <Suspense
      fallback={
        <AuthCard title="Set a new password">
          <p role="status" className="text-sm text-slate-600 dark:text-slate-400">
            Loading…
          </p>
        </AuthCard>
      }
    >
      <ResetPasswordForm />
    </Suspense>
  );
}

function ResetPasswordForm() {
  const params = useSearchParams();
  const [done, setDone] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<ResetPasswordInput>({
    resolver: zodResolver(resetPasswordSchema),
    mode: 'onTouched',
    defaultValues: {
      identifier: params.get('identifier') ?? '',
      // Prefilled only in mock mode, where /forgot-password can pass it along.
      code: params.get('code') ?? '',
      password: '',
      confirmPassword: '',
    },
  });

  const password = watch('password');

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await api.post<PasswordResetResponse>('/auth/password/reset', {
        identifier: values.identifier,
        code: values.code,
        password: values.password,
      });
      setDone(true);
    } catch (error) {
      /**
       * Every failure answers identically — wrong code, expired, already used,
       * attempts exhausted, no such account — so there is one message to show
       * and nothing to branch on. That is the point: the server will not say
       * which it was, and neither can this page.
       */
      setFormError(
        error instanceof ApiError ? error.message : 'Something went wrong. Please try again.',
      );
    }
  });

  const signInLink = (
    <Link
      href="/login"
      className="font-semibold text-brand-700 underline underline-offset-2 hover:text-brand-800 dark:text-brand-300 dark:hover:text-brand-200"
    >
      Sign in
    </Link>
  );

  if (done) {
    return (
      <AuthCard
        title="Password updated"
        subtitle="Sign in with your new password."
        footer={<p>{signInLink}</p>}
      >
        <div className="flex flex-col gap-3">
          <p role="status" className="text-sm text-slate-600 dark:text-slate-400">
            Every device that was signed in to this account has been signed out. You are not
            signed in here either — use your new password to sign in.
          </p>
          <Link
            href="/login"
            className="inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-brand-600 px-5 text-base font-semibold text-white transition-colors hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 dark:bg-brand-500 dark:hover:bg-brand-400"
          >
            Go to sign in
          </Link>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Set a new password"
      subtitle={`Enter the ${RESET_CODE_LENGTH}-digit code we sent on WhatsApp.`}
      footer={
        <p>
          No code?{' '}
          <Link
            href="/forgot-password"
            className="font-semibold text-brand-700 underline underline-offset-2 hover:text-brand-800 dark:text-brand-300 dark:hover:text-brand-200"
          >
            Request one
          </Link>
        </p>
      }
    >
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <FormError variant="banner" message={formError ?? undefined} />

        <Input
          label="Email or phone number"
          type="text"
          inputMode="email"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="you@example.com or 9876543210"
          error={errors.identifier?.message}
          {...register('identifier')}
        />

        {/*
          A single field rather than eight boxes: the OtpInput component is
          built around a 6-digit code and a one-field entry is what people
          expect for something they are reading off another app. inputMode
          brings up the numeric keypad; autoComplete lets the platform offer
          the code straight from the notification.
        */}
        <Input
          label={`${RESET_CODE_LENGTH}-digit code`}
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={RESET_CODE_LENGTH + 2}
          placeholder="40318725"
          hint="Valid for 15 minutes, and usable once."
          error={errors.code?.message}
          inputClassName="font-mono tracking-[0.3em]"
          {...register('code')}
        />

        <PasswordInput
          label="New password"
          autoComplete="new-password"
          placeholder="At least 8 characters"
          error={errors.password?.message}
          footer={<PasswordStrengthMeter password={password ?? ''} />}
          {...register('password')}
        />

        <PasswordInput
          label="Confirm new password"
          autoComplete="new-password"
          placeholder="Re-enter your new password"
          error={errors.confirmPassword?.message}
          {...register('confirmPassword')}
        />

        <Button type="submit" loading={isSubmitting} loadingText="Updating…">
          Update password
        </Button>
      </form>
    </AuthCard>
  );
}
