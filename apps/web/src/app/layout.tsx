import type { Metadata, Viewport } from 'next';
import './globals.css';
import { AuthProvider } from '@/context/AuthContext';
import { MockModeBadge } from '@/components/MockModeBadge';
import { SiteFooter } from '@/components/SiteFooter';

export const metadata: Metadata = {
  title: 'Safe Lock',
  description: 'Lock and unlock your smart safe from anywhere.',
  applicationName: 'Safe Lock',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f8fafc' },
    { media: '(prefers-color-scheme: dark)', color: '#020617' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="flex min-h-dvh flex-col antialiased">
        <AuthProvider>
          <MockModeBadge />
          {children}
          <SiteFooter />
        </AuthProvider>
      </body>
    </html>
  );
}
