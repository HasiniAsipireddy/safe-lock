'use client';

import { useEffect, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';

/**
 * Client-side route guards.
 *
 * These are a UX measure only. Because the session is an httpOnly cookie the
 * browser cannot inspect, real enforcement is the API rejecting unauthorised
 * requests — never rely on these components for access control.
 */

function FullPageSpinner({ label }: { label: string }) {
  return (
    <div
      className="flex min-h-[60vh] flex-1 items-center justify-center p-8"
      role="status"
      aria-live="polite"
    >
      <span className="flex items-center gap-3 text-sm text-slate-600 dark:text-slate-400">
        <svg className="size-5 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
        </svg>
        {label}
      </span>
    </div>
  );
}

/** Wraps pages that require a signed-in user (e.g. /dashboard, /pay). */
export function Protected({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (status === 'unauthenticated') {
      router.replace('/login');
    }
  }, [status, router]);

  if (status !== 'authenticated') {
    return <FullPageSpinner label="Checking your session…" />;
  }

  return <>{children}</>;
}

/**
 * Wraps pages only ADMIN users should see (/admin).
 *
 * Non-admins are redirected to the dashboard rather than shown a 403 — they
 * have an account, they simply have no business here. Real enforcement is the
 * API's `requireAdmin`; this only keeps the UI honest.
 */
export function AdminOnly({ children }: { children: ReactNode }) {
  const { status, user } = useAuth();
  const router = useRouter();

  const allowed = status === 'authenticated' && user?.role === 'ADMIN';

  useEffect(() => {
    if (status === 'unauthenticated') {
      router.replace('/login');
      return;
    }
    if (status === 'authenticated' && user?.role !== 'ADMIN') {
      router.replace('/dashboard');
    }
  }, [status, user?.role, router]);

  if (!allowed) {
    return <FullPageSpinner label="Checking your access…" />;
  }

  return <>{children}</>;
}

/** Wraps pages only guests should see (/login, /signup). */
export function GuestOnly({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (status === 'authenticated') {
      router.replace('/dashboard');
    }
  }, [status, router]);

  if (status !== 'unauthenticated') {
    return <FullPageSpinner label="Loading…" />;
  }

  return <>{children}</>;
}
