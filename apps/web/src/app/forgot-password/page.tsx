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
import { peekMockResetCode } from '@/lib/mockApi';
import { AuthCard } from '@/components/ui/AuthCard';
import { Button } from '@/components/ui/Button';
import { FormError } from '@/components/ui/FormError';
import { Input } from '@/components/ui/Input';
import { GuestOnly } from '@/components/RouteGuard';

/**
 * `/forgot-password` — requests a reset code.
 *
 * The confirmation panel is deliberately written to be true for every case the
 * API treats identically: a registered email, an unknown email, a registered
 * phone, an unknown phone, a user with no verified number, and a user whose
 * daily WhatsApp allowance is spent. A page that said "we've sent you a code"
 * only for real accounts would hand back the disclosure the endpoint was built
 * to withhold.
 */
export default function ForgotPasswordPage() {
  return (
    <GuestOnly>
      <ForgotPasswordForm />
    </GuestOnly>
  );
}

function ForgotPasswordForm() {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  /** Mock mode only. Never populated by the real API, which returns no code. */
  const [devCode, setDevCode] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ForgotPasswordInput>({
    resolver: zodResolver(forgotPasswordSchema),
    mode: 'onTouched',
    defaultValues: { identifier: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await api.post<ForgotPasswordResponse>('/auth/password/forgot', {
        identifier: values.identifier,
      });
      setSentTo(values.identifier);
      setDevCode(USE_MOCK_API ? peekMockResetCode() : null);
    } catch (error) {
      // A 429 is worth surfacing — including the minimum-interval one, which
      // tells the user to wait rather than keep pressing. It says nothing
      // about whether the account exists: the limiter runs before any lookup.
      setFormError(
        error instanceof ApiError ? error.message : 'Something went wrong. Please try again.',
      );
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

  if (sentTo !== null) {
    return (
      <AuthCard
        title="Check WhatsApp"
        subtitle="If that account exists and has a verified number, a code is on its way."
        footer={backToSignIn}
      >
        <div className="flex flex-col gap-3 text-sm text-slate-600 dark:text-slate-400">
          <p role="status">
            The code is 8 digits, valid for 15 minutes, and can be used once. Requesting
            another one replaces it.
          </p>

          <Link
            href={`/reset-password?identifier=${encodeURIComponent(sentTo)}`}
            className="inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-brand-600 px-5 text-base font-semibold text-white transition-colors hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 dark:bg-brand-500 dark:hover:bg-brand-400"
          >
            Enter the code
          </Link>

          <p>
            Reset codes are sent on WhatsApp to a <strong>verified</strong> number. If you
            never verified yours,{' '}
            <Link href="/contact" className="font-semibold underline underline-offset-2">
              contact support
            </Link>{' '}
            — we cannot reach you otherwise.
          </p>

          <p>
            Didn&apos;t get it? Check what you typed, then{' '}
            <button
              type="button"
              onClick={() => {
                setSentTo(null);
                setDevCode(null);
              }}
              className="font-semibold text-brand-700 underline underline-offset-2 hover:text-brand-800 dark:text-brand-300 dark:hover:text-brand-200"
            >
              try again
            </button>
            . There is a short wait between codes.
          </p>

          {devCode ? <MockCodeHint code={devCode} identifier={sentTo} /> : null}
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Reset your password"
      subtitle="We'll send a code to your phone on WhatsApp."
      footer={backToSignIn}
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
          hint="Whichever you signed up with. The code goes to your verified WhatsApp number."
          error={errors.identifier?.message}
          {...register('identifier')}
        />

        <Button type="submit" loading={isSubmitting} loadingText="Sending…">
          Send reset code
        </Button>
      </form>
    </AuthCard>
  );
}

/**
 * Dev-only shortcut shown in mock mode, where there is no WhatsApp to check.
 *
 * `USE_MOCK_API` cannot be true in a production build — `lib/env.ts` throws at
 * startup — so this cannot ship. The real API never returns a code in any
 * response, so there would be nothing for it to display.
 */
function MockCodeHint({ code, identifier }: { code: string; identifier: string }) {
  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/40">
      <p className="text-xs font-bold tracking-wide text-amber-900 uppercase dark:text-amber-200">
        Mock mode
      </p>
      <p className="mt-1 text-sm text-amber-900/90 dark:text-amber-100/90">
        No message is sent. Your code is <span className="font-mono">{code}</span>
      </p>
      <Link
        href={`/reset-password?identifier=${encodeURIComponent(identifier)}&code=${code}`}
        className="mt-2 inline-flex min-h-11 items-center font-semibold text-amber-900 underline underline-offset-2 dark:text-amber-100"
      >
        Open the reset page with it filled in
      </Link>
    </div>
  );
}
