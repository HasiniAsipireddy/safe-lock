'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  ERROR_CODES,
  resetPasswordSchema,
  type PasswordResetResponse,
  type ResetPasswordInput,
} from '@safelock/shared';
import { api } from '@/lib/api';
import { ApiError } from '@/lib/apiError';
import { AuthCard } from '@/components/ui/AuthCard';
import { Button } from '@/components/ui/Button';
import { FormError } from '@/components/ui/FormError';
import { PasswordInput } from '@/components/ui/PasswordInput';
import { PasswordStrengthMeter } from '@/components/PasswordStrengthMeter';

/**
 * `/reset-password?token=…` — sets a new password from a reset link.
 *
 * **Completing this does not sign anyone in.** The API returns no user and no
 * session cookie, and the page sends the visitor to `/login` to use the
 * password they just set. Holding a link proves control of a delivery channel,
 * which is enough to set a password and not enough to be handed a live session
 * to a safe.
 *
 * Not wrapped in `GuestOnly`: someone *can* legitimately be signed in here (a
 * reset link opened in the browser they are already using), and the API has
 * just revoked their sessions anyway.
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
  const token = useSearchParams().get('token') ?? '';
  const [done, setDone] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  /** True once the server has called the link dead — retrying cannot help. */
  const [linkDead, setLinkDead] = useState(false);

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<ResetPasswordInput>({
    resolver: zodResolver(resetPasswordSchema),
    mode: 'onTouched',
    defaultValues: { token, password: '', confirmPassword: '' },
  });

  const password = watch('password');

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await api.post<PasswordResetResponse>('/auth/password/reset', {
        token: values.token,
        password: values.password,
      });
      setDone(true);
    } catch (error) {
      if (error instanceof ApiError && error.code === ERROR_CODES.RESET_TOKEN_INVALID) {
        setLinkDead(true);
        setFormError(error.message);
      } else if (error instanceof ApiError) {
        setFormError(error.message);
      } else {
        setFormError('Something went wrong. Please try again.');
      }
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

  const requestAnother = (
    <Link
      href="/forgot-password"
      className="font-semibold text-brand-700 underline underline-offset-2 hover:text-brand-800 dark:text-brand-300 dark:hover:text-brand-200"
    >
      Request a new link
    </Link>
  );

  // A link with no token at all: say so plainly rather than showing a form
  // that cannot succeed.
  if (!token) {
    return (
      <AuthCard
        title="That link is incomplete"
        subtitle="The reset link is missing its token."
        footer={<p>{requestAnother}</p>}
      >
        <p className="text-sm text-slate-600 dark:text-slate-400">
          Open the most recent link you were sent, or request a new one. Links can be used
          once and expire after 30 minutes.
        </p>
      </AuthCard>
    );
  }

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

  if (linkDead) {
    return (
      <AuthCard
        title="That link has expired"
        subtitle="Reset links can be used once, within 30 minutes."
        footer={<p>{requestAnother}</p>}
      >
        <p role="alert" className="text-sm text-slate-600 dark:text-slate-400">
          {formError}
        </p>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Set a new password"
      subtitle="Choose a password you haven't used here before."
      footer={<p>Remembered it? {signInLink}</p>}
    >
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <FormError variant="banner" message={formError ?? undefined} />

        {/* The token travels in the form rather than being re-read on submit,
            so a navigation mid-flow cannot swap it underneath the request. */}
        <input type="hidden" {...register('token')} />

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
