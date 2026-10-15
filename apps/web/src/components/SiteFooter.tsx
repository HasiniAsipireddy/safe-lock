import Link from 'next/link';

/**
 * Site-wide footer.
 *
 * These links are not decoration: Razorpay's activation review requires the
 * terms, privacy, refund and contact pages to be reachable from every page.
 */

const LINKS = [
  { href: '/terms', label: 'Terms' },
  { href: '/privacy', label: 'Privacy' },
  { href: '/refund-policy', label: 'Refunds' },
  { href: '/contact', label: 'Contact' },
] as const;

export function SiteFooter() {
  return (
    <footer className="mt-auto border-t border-slate-200 px-4 py-6 dark:border-slate-800">
      <div className="mx-auto flex w-full max-w-2xl flex-col items-center gap-3 text-center">
        <nav aria-label="Legal">
          <ul className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
            {LINKS.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  className="text-sm text-slate-600 underline-offset-2 hover:text-slate-900 hover:underline dark:text-slate-400 dark:hover:text-slate-100"
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <p className="text-xs text-slate-500 dark:text-slate-500">
          {/* Replace with the registered business name before launch. */}© {new Date().getFullYear()}{' '}
          [BUSINESS NAME]. Payments processed by Razorpay.
        </p>
      </div>
    </footer>
  );
}
