'use client';

import { useState } from 'react';
import { AdminOnly } from '@/components/RouteGuard';
import { ToastProvider } from '@/components/ui/Toast';
import { DevicesTab } from '@/components/admin/DevicesTab';
import { BookingsTab } from '@/components/admin/BookingsTab';
import { UsersTab } from '@/components/admin/UsersTab';
import { PaymentsTab } from '@/components/admin/PaymentsTab';
import { AuditTab } from '@/components/admin/AuditTab';
import { cn } from '@/lib/cn';

/**
 * Admin panel.
 *
 * `AdminOnly` keeps non-admins out of the UI; the real boundary is the API,
 * where every `/admin/*` endpoint sits behind `requireAdmin`.
 */
export default function AdminPage() {
  return (
    <AdminOnly>
      <ToastProvider>
        <AdminPanel />
      </ToastProvider>
    </AdminOnly>
  );
}

const TABS = [
  // Bookings first: it opens on "needs attention", which is the only list in
  // this panel that nothing else will surface. An unpaid overstay is never
  // completed automatically, on purpose.
  { id: 'bookings', label: 'Bookings' },
  { id: 'devices', label: 'Devices' },
  { id: 'users', label: 'Users' },
  { id: 'payments', label: 'Payments' },
  { id: 'audit', label: 'Audit' },
] as const;

type TabId = (typeof TABS)[number]['id'];

function AdminPanel() {
  const [tab, setTab] = useState<TabId>('bookings');
  /**
   * Bumped when a booking or the inventory changes, so the Users tab re-reads
   * its current-booking column instead of showing a stale one.
   */
  const [inventoryVersion, setInventoryVersion] = useState(0);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl dark:text-white">
          Admin
        </h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Bookings, device inventory and activity.
        </p>
      </header>

      <div className="overflow-x-auto">
        <div
          role="tablist"
          aria-label="Admin sections"
          className="flex min-w-max gap-1 border-b border-slate-200 dark:border-slate-800"
        >
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`tab-${item.id}`}
              aria-selected={tab === item.id}
              aria-controls={`panel-${item.id}`}
              onClick={() => setTab(item.id)}
              className={cn(
                'min-h-12 px-4 text-sm font-semibold transition-colors',
                '-mb-px border-b-2',
                tab === item.id
                  ? 'border-brand-600 text-brand-700 dark:border-brand-400 dark:text-brand-300'
                  : 'border-transparent text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div
        role="tabpanel"
        id={`panel-${tab}`}
        aria-labelledby={`tab-${tab}`}
        // Remount per tab so each list loads fresh rather than showing stale
        // rows from a previous visit.
        key={tab}
      >
        {tab === 'bookings' && (
          <BookingsTab onChanged={() => setInventoryVersion((value) => value + 1)} />
        )}
        {tab === 'devices' && (
          <DevicesTab onInventoryChange={() => setInventoryVersion((value) => value + 1)} />
        )}
        {tab === 'users' && <UsersTab refreshKey={inventoryVersion} />}
        {tab === 'payments' && <PaymentsTab />}
        {tab === 'audit' && <AuditTab />}
      </div>
    </main>
  );
}
