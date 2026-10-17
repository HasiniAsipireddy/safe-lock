'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ERROR_CODES, type BookingOrderResponse, type VerifyPaymentResponse } from '@safelock/shared';
import { api } from './api';
import { ApiError, toUserMessage } from './apiError';
import { USE_MOCK_API } from './env';
import { loadRazorpayCheckout } from './razorpay';

/**
 * The Razorpay Checkout round trip, shared by all three things a renter pays
 * for: the booking, an extension, and an overstay fee.
 *
 * One hook rather than three copies, because the sequence has a few rules that
 * must hold identically every time and are easy to get subtly wrong:
 *
 * - **The amount is never ours.** Every call posts an empty (or hours-only)
 *   body to an order endpoint and uses the amount that comes back. Nothing
 *   here computes money.
 * - **`needsReview` is not success.** The money arrived and could not be
 *   applied — a lapsed hold whose safe was taken, or an expired overstay
 *   quote. Rendering that as "paid!" would be the single most misleading thing
 *   this UI could do, so it is its own terminal stage with its own copy.
 * - **A signature mismatch is not retryable.** Paying twice is not the remedy;
 *   the user needs support.
 * - **One payment at a time**, guarded synchronously, because a stale Checkout
 *   callback can fire after the component has moved on.
 */

export type CheckoutStage =
  | { kind: 'idle' }
  /** Creating the order. */
  | { kind: 'starting' }
  /** Checkout is open, or mock mode is waiting for the simulate button. */
  | { kind: 'awaiting-payment'; order: BookingOrderResponse }
  | { kind: 'verifying' }
  | { kind: 'success' }
  /**
   * Captured but not applied. The payment is real and is queued for a manual
   * refund; the user is told so plainly rather than shown a success screen.
   */
  | { kind: 'needs-review' }
  | { kind: 'failed'; message: string; canRetry: boolean };

export interface UseBookingCheckout {
  stage: CheckoutStage;
  /** A non-fatal message — the window was closed, say. */
  notice: string | null;
  /** Creates the order and opens Checkout. */
  start: () => void;
  /** Mock mode only: stands in for a successful Checkout callback. */
  simulate: (order: BookingOrderResponse, signature: string) => void;
  reset: () => void;
}

export interface BookingCheckoutOptions {
  /** Creates the Razorpay order. The amount comes back from the server. */
  createOrder: () => Promise<BookingOrderResponse>;
  /** What Checkout shows the user as the line item. */
  description: string;
  prefill?: { name?: string | undefined; email?: string | undefined; phone?: string | undefined };
  /** Called after a verified, applied payment. */
  onPaid?: () => void | Promise<void>;
  /**
   * Called when an order could not even be created — usually because the thing
   * being paid for moved on (the hold lapsed, the fee was waived). The page
   * decides what to do; most reload the booking.
   */
  onOrderRejected?: (error: ApiError) => boolean | void;
}

export function useBookingCheckout(options: BookingCheckoutOptions): UseBookingCheckout {
  const { createOrder, description, prefill, onPaid, onOrderRejected } = options;

  const [stage, setStage] = useState<CheckoutStage>({ kind: 'idle' });
  const [notice, setNotice] = useState<string | null>(null);

  /**
   * Synchronous guard, not state.
   *
   * `setStage` is async, so two clicks in the same tick would both pass a
   * state-based check and create two orders — two Razorpay orders for one
   * booking, one of which would later be captured against nothing.
   */
  const inFlight = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const verify = useCallback(
    async (payload: {
      razorpay_order_id: string;
      razorpay_payment_id: string;
      razorpay_signature: string;
    }) => {
      setStage({ kind: 'verifying' });

      try {
        const result = await api.post<VerifyPaymentResponse>('/payments/verify', payload);
        if (!mounted.current) return;

        if (result.needsReview) {
          setStage({ kind: 'needs-review' });
          return;
        }

        await onPaid?.();
        if (!mounted.current) return;
        setStage({ kind: 'success' });
      } catch (error) {
        if (!mounted.current) return;

        // Paying again is not the remedy for a signature that did not verify.
        const isSignature =
          error instanceof ApiError && error.code === ERROR_CODES.INVALID_SIGNATURE;

        setStage({
          kind: 'failed',
          message: toUserMessage(error),
          canRetry: !isSignature,
        });
      } finally {
        inFlight.current = false;
      }
    },
    [onPaid],
  );

  const start = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    setNotice(null);
    setStage({ kind: 'starting' });

    void (async () => {
      let order: BookingOrderResponse;
      try {
        order = await createOrder();
      } catch (error) {
        inFlight.current = false;
        if (!mounted.current) return;

        if (error instanceof ApiError && onOrderRejected?.(error)) return;

        setStage({ kind: 'failed', message: toUserMessage(error), canRetry: true });
        return;
      }

      if (!mounted.current) return;

      // Mock mode stands in for Checkout with an explicit simulate step, so
      // the whole flow is exercisable without a Razorpay account.
      if (USE_MOCK_API) {
        setStage({ kind: 'awaiting-payment', order });
        inFlight.current = false;
        return;
      }

      try {
        const Checkout = await loadRazorpayCheckout();
        if (!mounted.current) return;

        setStage({ kind: 'awaiting-payment', order });

        const checkout = new Checkout({
          key: order.keyId,
          amount: order.amount,
          currency: order.currency,
          name: 'Safe Lock',
          description,
          order_id: order.orderId,
          prefill: {
            ...(prefill?.name ? { name: prefill.name } : {}),
            ...(prefill?.email ? { email: prefill.email } : {}),
            // Razorpay expects a dialable number; accounts store 10 digits.
            ...(prefill?.phone ? { contact: `+91${prefill.phone}` } : {}),
          },
          theme: { color: '#2059dc' },
          modal: {
            confirm_close: true,
            ondismiss: () => {
              inFlight.current = false;
              if (!mounted.current) return;
              setStage({ kind: 'idle' });
              setNotice('Payment window closed. Nothing has been charged.');
            },
          },
          handler: (response) => {
            void verify(response);
          },
        });

        checkout.on('payment.failed', (response) => {
          inFlight.current = false;
          if (!mounted.current) return;
          setStage({
            kind: 'failed',
            message:
              response.error?.description ??
              'The payment did not go through. No money has been taken.',
            canRetry: true,
          });
        });

        checkout.open();
      } catch (error) {
        inFlight.current = false;
        if (!mounted.current) return;
        setStage({ kind: 'failed', message: toUserMessage(error), canRetry: true });
      }
    })();
  }, [createOrder, description, onOrderRejected, prefill, verify]);

  const simulate = useCallback(
    (order: BookingOrderResponse, signature: string) => {
      inFlight.current = true;
      void verify({
        razorpay_order_id: order.orderId,
        razorpay_payment_id: `pay_mock${Date.now()}`,
        razorpay_signature: signature,
      });
    },
    [verify],
  );

  const reset = useCallback(() => {
    inFlight.current = false;
    setNotice(null);
    setStage({ kind: 'idle' });
  }, []);

  return { stage, notice, start, simulate, reset };
}
