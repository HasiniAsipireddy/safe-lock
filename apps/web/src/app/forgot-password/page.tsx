import Link from 'next/link';
import { AuthCard } from '@/components/ui/AuthCard';

/** Placeholder. The reset flow lands with the auth API. */
export default function ForgotPasswordPage() {
  return (
    <AuthCard
      title="Reset your password"
      subtitle="Password reset isn't available yet."
      footer={
        <p>
          <Link
            href="/login"
            className="font-semibold text-brand-700 underline underline-offset-2 hover:text-brand-800 dark:text-brand-300 dark:hover:text-brand-200"
          >
            Back to sign in
          </Link>
        </p>
      }
    >
      <div className="flex flex-col gap-3 text-sm text-slate-600 dark:text-slate-400">
        <p>
          We&apos;re still building this. Once the backend is live you&apos;ll be able to request a
          reset link by email or a code by SMS.
        </p>
        <p>
          In the meantime, contact support to regain access to your safe.
        </p>
      </div>
    </AuthCard>
  );
}
