'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { Protected } from '@/components/RouteGuard';
import { Button } from '@/components/ui/Button';

/** Placeholder dashboard. The safe status card and Lock/Unlock land later. */
export default function DashboardPage() {
  return (
    <Protected>
      <DashboardContent />
    </Protected>
  );
}

function DashboardContent() {
  const { user, logout } = useAuth();
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  async function handleLogout() {
    setSigningOut(true);
    await logout();
    router.replace('/login');
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8 sm:px-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl dark:text-white">
          Welcome, {user?.name}
        </h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{user?.email}</p>
      </header>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
        <h2 className="text-sm font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
          Your safe
        </h2>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
          Nothing here yet — the safe status card, Lock and Unlock controls arrive with the device
          module.
        </p>
      </section>

      <Button variant="secondary" loading={signingOut} loadingText="Signing out…" onClick={handleLogout}>
        Sign out
      </Button>
    </main>
  );
}
