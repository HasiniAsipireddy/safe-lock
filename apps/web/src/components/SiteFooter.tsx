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
    <footer className="mt-auto bg-brand-800 px-4 py-6 print:hidden">
      <div className="mx-auto flex w-full max-w-2xl flex-col items-center gap-3 text-center">
        <nav aria-label="Legal">
          <ul className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
            {LINKS.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  className="text-sm text-brand-50 underline-offset-2 hover:text-white hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <p className="text-xs text-brand-200">
          {/* Replace with the registered business name before launch. */}© {new Date().getFullYear()}{' '}
          [BUSINESS NAME]. Payments processed by Razorpay.
        </p>
      </div>
    </footer>
  );
}
