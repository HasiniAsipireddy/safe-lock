'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  ERROR_CODES,
  changePasswordSchema,
  updateProfileSchema,
  type ChangePasswordInput,
  type UpdateProfileInput,
} from '@safelock/shared';
import { useAuth } from '@/context/AuthContext';
import { ApiError } from '@/lib/apiError';
import { Button } from '@/components/ui/Button';
import { FormError } from '@/components/ui/FormError';
import { Input } from '@/components/ui/Input';
import { PasswordInput } from '@/components/ui/PasswordInput';
import { PasswordStrengthMeter } from '@/components/PasswordStrengthMeter';
import {
  PhoneVerificationCard,
  VerifyPhonePrompt,
} from '@/components/PhoneVerificationCard';
import { Protected } from '@/components/RouteGuard';

/**
 * `/account` — the signed-in user's own details.
 *
 * Two independent forms, each with its own submit and its own result message,
 * rather than one combined save. A password change ends every other session
 * and a name change does not; bundling them behind one button would make a
 * consequential action a side effect of a cosmetic one.
 */
export default function AccountPage() {
  return (
    <Protected>
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8 sm:px-6">
        <header>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl dark:text-white">
            Account
          </h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Your details and password.
          </p>
        </header>

        {/* The nudge first, for an unverified user: it is the one thing on
            this page that blocks the product's main action. */}
        <VerifyPhonePrompt />

        {/* `id` is the anchor the prompt and the dashboard banner link to. */}
        <div id="phone">
          <PhoneVerificationCard />
        </div>

        <ProfileCard />
        <PasswordCard />

        <Link
          href="/dashboard"
          className="inline-flex min-h-12 items-center justify-center rounded-xl px-5 text-base font-semibold text-brand-700 transition-colors hover:bg-brand-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 dark:text-brand-300 dark:hover:bg-slate-800"
        >
          Back to dashboard
        </Link>
      </main>
    </Protected>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 dark:border-slate-800 dark:bg-slate-900">
      <h2 className="text-base font-bold text-slate-900 dark:text-white">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** A result line that screen readers announce without stealing focus. */
function SuccessNote({ message }: { message: string }) {
  return (
    <p
      role="status"
      className="rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-100"
    >
      {message}
    </p>
  );
}

function ProfileCard() {
  const { user, updateProfile } = useAuth();
  const [saved, setSaved] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<UpdateProfileInput>({
    resolver: zodResolver(updateProfileSchema),
    mode: 'onTouched',
    defaultValues: { name: user?.name ?? '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    setSaved(false);
    try {
      await updateProfile(values.name);
      setSaved(true);
    } catch (error) {
      setFormError(
        error instanceof ApiError ? error.message : 'Something went wrong. Please try again.',
      );
    }
  });

  return (
    <Card title="Your details">
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <FormError variant="banner" message={formError ?? undefined} />
        {saved ? <SuccessNote message="Your name has been updated." /> : null}

        <Input
          label="Full name"
          type="text"
          autoComplete="name"
          error={errors.name?.message}
          {...register('name')}
        />

        {/*
          Email and phone are shown but not editable. Both are identifiers —
          one receives reset links, the other will receive unlock codes — so
          changing either needs a verification flow that is not built. The API
          rejects a body carrying them rather than ignoring them, and this is
          the UI telling the same truth.
        */}
        <dl className="flex flex-col gap-3 rounded-xl bg-slate-50 p-4 text-sm dark:bg-slate-950">
          <div>
            <dt className="font-medium text-slate-700 dark:text-slate-300">Email</dt>
            <dd className="break-all text-slate-600 dark:text-slate-400">{user?.email}</dd>
          </div>
          <div>
            <dt className="font-medium text-slate-700 dark:text-slate-300">Phone</dt>
            <dd className="text-slate-600 dark:text-slate-400">+91 {user?.phone}</dd>
          </div>
          <p className="text-slate-500 dark:text-slate-400">
            Contact support to change your email or phone number — both are used to verify
            it&apos;s you.
          </p>
        </dl>

        <Button type="submit" loading={isSubmitting} loadingText="Saving…" disabled={!isDirty}>
          Save name
        </Button>
      </form>
    </Card>
  );
}

function PasswordCard() {
  const { changePassword } = useAuth();
  const [changed, setChanged] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    setError,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<ChangePasswordInput>({
    resolver: zodResolver(changePasswordSchema),
    mode: 'onTouched',
    defaultValues: { currentPassword: '', password: '', confirmPassword: '' },
  });

  const password = watch('password');

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    setChanged(false);
    try {
      await changePassword({
        currentPassword: values.currentPassword,
        password: values.password,
      });
      setChanged(true);
      // Clears the three password fields from form state as soon as the call
      // succeeds — there is no reason to keep them in memory afterwards.
      reset({ currentPassword: '', password: '', confirmPassword: '' });
    } catch (error) {
      if (error instanceof ApiError && error.code === ERROR_CODES.PASSWORD_INCORRECT) {
        setError(
          'currentPassword',
          { type: 'server', message: error.message },
          { shouldFocus: true },
        );
      } else if (error instanceof ApiError) {
        setFormError(error.message);
      } else {
        setFormError('Something went wrong. Please try again.');
      }
    }
  });

  return (
    <Card title="Change password">
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <FormError variant="banner" message={formError ?? undefined} />
        {changed ? (
          <SuccessNote message="Password changed. Any other devices signed in to this account have been signed out." />
        ) : null}

        <PasswordInput
          label="Current password"
          autoComplete="current-password"
          error={errors.currentPassword?.message}
          {...register('currentPassword')}
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
          error={errors.confirmPassword?.message}
          {...register('confirmPassword')}
        />

        <p className="text-sm text-slate-500 dark:text-slate-400">
          You&apos;ll stay signed in here. Every other device will need to sign in again.
        </p>

        <Button type="submit" loading={isSubmitting} loadingText="Updating…">
          Change password
        </Button>
      </form>
    </Card>
  );
}
