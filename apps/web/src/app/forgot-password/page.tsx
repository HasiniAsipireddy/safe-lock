'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  forgotPasswordSchema,
  type ForgotPasswordInput,
  type ForgotPasswordResponse,
} from '@safelock/shared';
import { api } from '@/lib/api';
import { ApiError } from '@/lib/apiError';
import { USE_MOCK_API } from '@/lib/env';
import { peekMockResetToken } from '@/lib/mockApi';
import { AuthCard } from '@/components/ui/AuthCard';
import { Button } from '@/components/ui/Button';
import { FormError } from '@/components/ui/FormError';
import { Input } from '@/components/ui/Input';
import { GuestOnly } from '@/components/RouteGuard';

/**
 * `/forgot-password` — requests a reset link.
 *
 * The confirmation panel is deliberately written to be true whether or not the
 * address has an account: the API answers identically on purpose, and a page
 * that said "we've sent you a link" only for real accounts would hand back the
 * disclosure the endpoint was built to withhold.
 */
export default function ForgotPasswordPage() {
  return (
    <GuestOnly>
      <ForgotPasswordForm />
    </GuestOnly>
  );
}

function ForgotPasswordForm() {
  const [sent, setSent] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  /** Mock mode only — see the panel below. Never populated by the real API. */
  const [devToken, setDevToken] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ForgotPasswordInput>({
    resolver: zodResolver(forgotPasswordSchema),
    mode: 'onTouched',
    defaultValues: { email: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await api.post<ForgotPasswordResponse>('/auth/password/forgot', {
        email: values.email,
      });
      setSent(true);
      setDevToken(USE_MOCK_API ? peekMockResetToken() : null);
    } catch (error) {
      // A 429 is the one thing worth surfacing: the user should wait rather
      // than keep pressing. Anything else is still shown generically.
      if (error instanceof ApiError) {
        setFormError(error.message);
      } else {
        setFormError('Something went wrong. Please try again.');
      }
    }
  });

  const backToSignIn = (
    <p>
      <Link
        href="/login"
        className="font-semibold text-brand-700 underline underline-offset-2 hover:text-brand-800 dark:text-brand-300 dark:hover:text-brand-200"
      >
        Back to sign in
      </Link>
    </p>
  );

  if (sent) {
    return (
      <AuthCard
        title="Check your messages"
        subtitle="If that address has an account, a reset link is on its way."
        footer={backToSignIn}
      >
        <div className="flex flex-col gap-3 text-sm text-slate-600 dark:text-slate-400">
          <p role="status">
            The link is valid for 30 minutes and can be used once. Requesting another one
            replaces it.
          </p>
          <p>
            Didn&apos;t get it? Check the address you typed, then{' '}
            <button
              type="button"
              onClick={() => {
                setSent(false);
                setDevToken(null);
              }}
              className="font-semibold text-brand-700 underline underline-offset-2 hover:text-brand-800 dark:text-brand-300 dark:hover:text-brand-200"
            >
              try again
            </button>
            .
          </p>

          {devToken ? <MockResetHint token={devToken} /> : null}
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Reset your password"
      subtitle="We'll send a link to the email on your account."
      footer={backToSignIn}
    >
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <FormError variant="banner" message={formError ?? undefined} />

        <Input
          label="Email"
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="you@example.com"
          hint="Reset links go to email, even if you sign in with your phone number."
          error={errors.email?.message}
          {...register('email')}
        />

        <Button type="submit" loading={isSubmitting} loadingText="Sending…">
          Send reset link
        </Button>
      </form>
    </AuthCard>
  );
}

/**
 * Dev-only shortcut shown in mock mode, where there is no inbox to check.
 *
 * `USE_MOCK_API` cannot be true in a production build — `lib/env.ts` throws at
 * startup — so this panel cannot ship. The real API never returns a token in
 * any response, so there would be nothing for it to display anyway.
 */
function MockResetHint({ token }: { token: string }) {
  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/40">
      <p className="text-xs font-bold tracking-wide text-amber-900 uppercase dark:text-amber-200">
        Mock mode
      </p>
      <p className="mt-1 text-sm text-amber-900/90 dark:text-amber-100/90">
        No email is sent. Use this link to continue:
      </p>
      <Link
        href={`/reset-password?token=${encodeURIComponent(token)}`}
        className="mt-2 inline-flex min-h-11 items-center font-semibold text-amber-900 underline underline-offset-2 dark:text-amber-100"
      >
        Open the reset page
      </Link>
    </div>
  );
}
