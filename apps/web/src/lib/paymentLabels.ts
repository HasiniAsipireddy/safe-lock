import type { PaymentPurpose } from '@safelock/shared';

/** What each kind of payment is called on bookings and receipts. */
export const PAYMENT_PURPOSE_LABEL: Record<PaymentPurpose, string> = {
  BOOKING: 'Safe rental',
  EXTENSION: 'Extension',
  OVERSTAY: 'Overstay fee',
};
