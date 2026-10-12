'use client';

import { useId, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { ERROR_CODES, signupSchema, type SignupInput } from '@safelock/shared';
import { useAuth } from '@/context/AuthContext';
import { ApiError } from '@/lib/apiError';
import { AuthCard } from '@/components/ui/AuthCard';
import { Button } from '@/components/ui/Button';
import { FormError } from '@/components/ui/FormError';
import { Input } from '@/components/ui/Input';
import { PasswordInput } from '@/components/ui/PasswordInput';
import { PasswordStrengthMeter } from '@/components/PasswordStrengthMeter';
import { GuestOnly } from '@/components/RouteGuard';
import { cn } from '@/lib/cn';

export default function SignupPage() {
  return (
    <GuestOnly>
      <SignupForm />
    </GuestOnly>
  );
}

function SignupForm() {
  const { signup } = useAuth();
  const router = useRouter();
  const [formError, setFormError] = useState<string | null>(null);
  const termsId = useId();
  const termsErrorId = `${termsId}-error`;

  const {
    register,
    handleSubmit,
    setError,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<SignupInput>({
    resolver: zodResolver(signupSchema),
    mode: 'onTouched',
    defaultValues: {
      name: '',
      email: '',
      phone: '',
      password: '',
      confirmPassword: '',
      acceptedTerms: false,
    },
  });

  const password = watch('password');

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await signup(values);
      router.replace('/pay');
    } catch (error) {
      if (error instanceof ApiError && error.code === ERROR_CODES.EMAIL_ALREADY_REGISTERED) {
        setError('email', { type: 'server', message: error.message }, { shouldFocus: true });
      } else if (error instanceof ApiError && error.code === ERROR_CODES.PHONE_ALREADY_REGISTERED) {
        setError('phone', { type: 'server', message: error.message }, { shouldFocus: true });
      } else if (error instanceof ApiError) {
        setFormError(error.message);
      } else {
        setFormError('Something went wrong. Please try again.');
      }
    }
  });

  return (
    <AuthCard
      title="Create your account"
      subtitle="Set up access to your smart safe."
      footer={
        <p>
          Already have an account?{' '}
          <Link
            href="/login"
            className="font-semibold text-brand-700 underline underline-offset-2 hover:text-brand-800 dark:text-brand-300 dark:hover:text-brand-200"
          >
            Sign in
          </Link>
        </p>
      }
    >
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <FormError variant="banner" message={formError ?? undefined} />

        <Input
          label="Full name"
          type="text"
          autoComplete="name"
          placeholder="Asha Kumar"
          error={errors.name?.message}
          {...register('name')}
        />

        <Input
          label="Email"
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="you@example.com"
          error={errors.email?.message}
          {...register('email')}
        />

        <Input
          label="Phone number"
          type="tel"
          inputMode="numeric"
          autoComplete="tel-national"
          maxLength={10}
          prefix="+91"
          placeholder="9876543210"
          hint="10-digit Indian mobile number"
          error={errors.phone?.message}
          {...register('phone')}
        />

        <PasswordInput
          label="Password"
          autoComplete="new-password"
          placeholder="At least 8 characters"
          error={errors.password?.message}
          footer={<PasswordStrengthMeter password={password ?? ''} />}
          {...register('password')}
        />

        <PasswordInput
          label="Confirm password"
          autoComplete="new-password"
          placeholder="Re-enter your password"
          error={errors.confirmPassword?.message}
          {...register('confirmPassword')}
        />

        <div className="flex flex-col gap-1.5">
          <div className="flex items-start gap-3">
            <input
              id={termsId}
              type="checkbox"
              aria-invalid={errors.acceptedTerms ? true : undefined}
              aria-describedby={errors.acceptedTerms ? termsErrorId : undefined}
              className={cn(
                'mt-0.5 size-6 shrink-0 rounded-md border-2 accent-brand-600',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
                errors.acceptedTerms
                  ? 'border-red-400 dark:border-red-700'
                  : 'border-slate-300 dark:border-slate-600',
              )}
              {...register('acceptedTerms')}
            />
            <label htmlFor={termsId} className="text-sm text-slate-700 dark:text-slate-300">
              I agree to the{' '}
              <Link href="/terms" className="font-medium underline underline-offset-2">
                Terms of Service
              </Link>{' '}
              and{' '}
              <Link href="/privacy" className="font-medium underline underline-offset-2">
                Privacy Policy
              </Link>
              .
            </label>
          </div>
          <FormError id={termsErrorId} message={errors.acceptedTerms?.message} />
        </div>

        <Button type="submit" loading={isSubmitting} loadingText="Creating account…">
          Create account
        </Button>
      </form>
    </AuthCard>
  );
}
