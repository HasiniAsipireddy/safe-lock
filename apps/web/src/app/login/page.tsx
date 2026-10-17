'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { GENERIC_LOGIN_ERROR, loginSchema, type LoginInput } from '@safelock/shared';
import { useAuth } from '@/context/AuthContext';
import { ApiError } from '@/lib/apiError';
import { nextFromLocation } from '@/lib/safeRedirect';
import { AuthCard } from '@/components/ui/AuthCard';
import { Button } from '@/components/ui/Button';
import { FormError } from '@/components/ui/FormError';
import { Input } from '@/components/ui/Input';
import { PasswordInput } from '@/components/ui/PasswordInput';
import { GuestOnly } from '@/components/RouteGuard';

export default function LoginPage() {
  return (
    <GuestOnly>
      <LoginForm />
    </GuestOnly>
  );
}

function LoginForm() {
  const { login } = useAuth();
  const router = useRouter();
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    mode: 'onTouched',
    defaultValues: { identifier: '', password: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await login(values);

      /**
       * Where to go after signing in.
       *
       * A WhatsApp reminder links straight to a booking page, so someone
       * arriving from one with an expired session must land back where they
       * were headed rather than on a generic dashboard. The value is
       * attacker-controlled — it comes from a query string — so it is never
       * navigated to directly: `nextFromLocation` resolves it against this
       * origin and refuses anything that escapes.
       */
      router.replace(nextFromLocation());
    } catch (error) {
      // Any credential failure shows the same message, so the response can
      // never reveal whether the account exists or the password was wrong.
      if (error instanceof ApiError && error.status === 401) {
        setFormError(GENERIC_LOGIN_ERROR);
      } else if (error instanceof ApiError) {
        setFormError(error.message);
      } else {
        setFormError('Something went wrong. Please try again.');
      }
    }
  });

  return (
    <AuthCard
      title="Welcome back"
      subtitle="Sign in to control your safe."
      footer={
        <p>
          Don&apos;t have an account?{' '}
          <Link
            href="/signup"
            className="font-semibold text-brand-700 underline underline-offset-2 hover:text-brand-800 dark:text-brand-300 dark:hover:text-brand-200"
          >
            Create one
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

        <PasswordInput
          label="Password"
          autoComplete="current-password"
          placeholder="Your password"
          error={errors.password?.message}
          {...register('password')}
        />

        <div className="-mt-1 flex justify-end">
          <Link
            href="/forgot-password"
            className="inline-flex min-h-11 items-center text-sm font-medium text-brand-700 underline underline-offset-2 hover:text-brand-800 dark:text-brand-300 dark:hover:text-brand-200"
          >
            Forgot password?
          </Link>
        </div>

        <Button type="submit" loading={isSubmitting} loadingText="Signing in…">
          Sign in
        </Button>
      </form>
    </AuthCard>
  );
}
