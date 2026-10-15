import { vi } from 'vitest';

/**
 * Stand-in for the `razorpay` npm package.
 *
 * Tests mock the SDK itself rather than our wrapper, so `lib/razorpay.ts` and
 * the service's amount checks are exercised for real. No network is ever
 * touched.
 *
 * Used as:
 *   vi.mock('razorpay', () => import('../test/razorpayMock'));
 */

export interface MockOrderInput {
  amount: number;
  currency: string;
  receipt?: string;
  notes?: Record<string, string>;
}

/** Every order the code under test asked Razorpay to create, in order. */
export const createdOrders: MockOrderInput[] = [];

let sequence = 0;

/**
 * Lets a test force the next `orders.create` to behave differently — e.g.
 * return a tampered amount, or reject like a gateway outage.
 */
export const orderOverride: {
  next: ((input: MockOrderInput) => unknown) | null;
} = { next: null };

export const ordersCreate = vi.fn(async (input: MockOrderInput) => {
  createdOrders.push(input);

  if (orderOverride.next) {
    const override = orderOverride.next;
    orderOverride.next = null;
    return override(input);
  }

  sequence += 1;
  return {
    id: `order_TEST${String(sequence).padStart(10, '0')}`,
    entity: 'order',
    amount: input.amount,
    amount_paid: 0,
    amount_due: input.amount,
    currency: input.currency,
    receipt: input.receipt,
    notes: input.notes,
    status: 'created',
    attempts: 0,
    created_at: Math.floor(Date.now() / 1000),
  };
});

export function resetRazorpayMock(): void {
  createdOrders.length = 0;
  orderOverride.next = null;
  ordersCreate.mockClear();
}

/** Mirrors `new Razorpay({ key_id, key_secret })`. */
export default class RazorpayMock {
  readonly orders = { create: ordersCreate };

  constructor(readonly options: { key_id: string; key_secret: string }) {}
}
