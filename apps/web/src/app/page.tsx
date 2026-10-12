'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';

/** Entry point: sends the user to the dashboard or the login page. */
export default function HomePage() {
  const { status } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (status === 'authenticated') router.replace('/dashboard');
    else if (status === 'unauthenticated') router.replace('/login');
  }, [status, router]);

  return (
    <main
      className="flex min-h-[60vh] flex-1 items-center justify-center p-8"
      role="status"
      aria-live="polite"
    >
      <p className="text-sm text-slate-600 dark:text-slate-400">Loading Safe Lock…</p>
    </main>
  );
}
