'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { NotificationBell } from '@/components/NotificationBell';
import { cn } from '@/lib/cn';

/**
 * Application header.
 *
 * The Admin link is rendered only for `role === 'ADMIN'`. That is presentation
 * only — `/admin` is guarded client-side and, more importantly, every admin
 * endpoint is behind `requireAdmin` on the server. Hiding a link has never
 * stopped anyone from typing a URL.
 *
 * Hidden entirely for signed-out visitors so the auth and legal pages keep
 * their uncluttered layout.
 */
export function AppHeader() {
  const { user, status } = useAuth();
  const pathname = usePathname();

  if (status !== 'authenticated' || !user) return null;

  const links = [
    { href: '/dashboard', label: 'Dashboard' },
    { href: '/history', label: 'Activity' },
    ...(user.role === 'ADMIN' ? [{ href: '/admin', label: 'Admin' }] : []),
  ];

  return (
    <header className="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <div className="mx-auto flex w-full max-w-5xl items-center gap-4 px-4 py-3 sm:px-6">
        <Link
          href="/dashboard"
          className="flex items-center gap-2 font-bold tracking-tight text-slate-900 dark:text-white"
        >
          <svg
            className="size-5 text-brand-600 dark:text-brand-400"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="3" y="11" width="18" height="10" rx="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          Safe Lock
        </Link>

        <nav aria-label="Main" className="ml-auto">
          <ul className="flex items-center gap-0.5 sm:gap-1">
            {links.map((link) => {
              const active = pathname === link.href || pathname.startsWith(`${link.href}/`);
              return (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'inline-flex min-h-10 items-center rounded-lg px-2 text-sm font-semibold transition-colors sm:px-3',
                      active
                        ? 'bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-white'
                        : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white',
                    )}
                  >
                    {link.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* Outside the nav list: it is a control, not a navigation link. */}
        <NotificationBell />
      </div>
    </header>
  );
}
