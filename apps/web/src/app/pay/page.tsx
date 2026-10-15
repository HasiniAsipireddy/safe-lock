'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ERROR_CODES,
  formatInr,
  type CreateOrderResponse,
  type PaymentMeResponse,
  type VerifyPaymentResponse,
} from '@safelock/shared';
import { useAuth } from '@/context/AuthContext';
import { Protected } from '@/components/RouteGuard';
import { Button } from '@/components/ui/Button';
import { api } from '@/lib/api';
import { ApiError, toUserMessage } from '@/lib/apiError';
import { USE_MOCK_API } from '@/lib/env';
import { MOCK_CHECKOUT_SIGNATURE } from '@/lib/mockApi';
import { loadRazorpayCheckout } from '@/lib/razorpay';

export default function PayPage() {
  return (
    <Protected>
      <PayContent />
    </Protected>
  );
}

/**
 * What the user is buying. Deliberately factual — no promises about delivery
 * dates or hardware specifics that have not been decided.
 */
const INCLUDED = [
  'One smart safe lock allocated to your account',
  'Remote lock and unlock from any device',
  'OTP confirmation on every unlock',
  'Activity history for every lock and unlock',
];

const WHAT_HAPPENS_NEXT = [
  'Your payment is verified on our server — never in the browser.',
  'A safe lock is allocated to your account.',
  'Your dashboard shows the safe and its current status.',
  'Unlocking always asks for a one-time code.',
];

type Stage =
  | { kind: 'loading' }
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'awaiting-payment'; order: CreateOrderResponse }
  | { kind: 'verifying' }
  | { kind: 'success' }
  | { kind: 'failed'; message: string; canRetry: boolean };

function PayContent() {
  const { user, refreshUser } = useAuth();
  const router = useRouter();

  const [stage, setStage] = useState<Stage>({ kind: 'loading' });
  const [price, setPrice] = useState<{ amount: number; currency: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Guards against a second payment being started by a double-click or by a
  // stale Checkout callback firing after the component moved on.
  const inFlight = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Already paid? Skip the page entirely.
  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        const state = await api.get<PaymentMeResponse>('/payments/me', {
          signal: controller.signal,
        });
        if (!mounted.current) return;

        setPrice({ amount: state.priceInPaise, currency: state.currency });

        if (state.hasPaid) {
          router.replace('/dashboard');
          return;
        }

        setStage({ kind: 'idle' });

        if (state.payment?.status === 'FAILED') {
          setNotice('Your last payment attempt did not go through. You can try again below.');
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        if (!mounted.current) return;
        setStage({
          kind: 'failed',
          message: toUserMessage(error),
          canRetry: true,
        });
      }
    })();

    return () => controller.abort();
  }, [router]);

  const finishSuccessfully = useCallback(async () => {
    // Pull the fresh user so `hasPaid` is correct before /dashboard renders.
    await refreshUser();
    if (!mounted.current) return;
    setStage({ kind: 'success' });
    setTimeout(() => {
      if (mounted.current) router.replace('/dashboard');
    }, 1600);
  }, [refreshUser, router]);

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

        if (result.hasPaid) {
          await finishSuccessfully();
          return;
        }

        setStage({
          kind: 'failed',
          message:
            'Your payment could not be confirmed. Please contact support before paying again.',
          canRetry: false,
        });
      } catch (error) {
        if (!mounted.current) return;

        // A signature mismatch is not something to retry by paying twice.
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
    [finishSuccessfully],
  );

  const startPayment = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setNotice(null);
    setStage({ kind: 'starting' });

    let order: CreateOrderResponse;
    try {
      order = await api.post<CreateOrderResponse>('/payments/order', undefined);
    } catch (error) {
      inFlight.current = false;
      if (!mounted.current) return;

      // Paid in another tab or on another device since this page loaded.
      if (error instanceof ApiError && error.code === ERROR_CODES.ALREADY_PAID) {
        await refreshUser();
        router.replace('/dashboard');
        return;
      }

      setStage({ kind: 'failed', message: toUserMessage(error), canRetry: true });
      return;
    }

    if (!mounted.current) return;

    // Mock mode stands in for Checkout with an explicit simulate step.
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
        description: 'One-time safe activation',
        order_id: order.orderId,
        prefill: {
          name: user?.name,
          email: user?.email,
          // Razorpay expects a dialable number; accounts store 10 digits.
          contact: user?.phone ? `+91${user.phone}` : undefined,
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
  }, [refreshUser, router, user, verify]);

  if (stage.kind === 'loading') {
    return (
      <main
        className="mx-auto flex w-full max-w-md flex-1 items-center justify-center px-4 py-8"
        role="status"
        aria-live="polite"
      >
        <p className="text-sm text-slate-600 dark:text-slate-400">Checking your payment status…</p>
      </main>
    );
  }

  if (stage.kind === 'success') {
    return <SuccessPanel />;
  }

  const busy = stage.kind === 'starting' || stage.kind === 'verifying';
  const awaitingMock = stage.kind === 'awaiting-payment' && USE_MOCK_API;

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8 sm:px-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl dark:text-white">
          Activate your safe
        </h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          One payment. No subscription.
        </p>
      </header>

      {notice && (
        <p
          role="status"
          className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
        >
          {notice}
        </p>
      )}

      {stage.kind === 'failed' && (
        <div
          role="alert"
          className="rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
        >
          <p className="font-semibold">Payment not completed</p>
          <p className="mt-1">{stage.message}</p>
          {!stage.canRetry && (
            <p className="mt-2">
              Please{' '}
              <Link href="/contact" className="font-semibold underline underline-offset-2">
                contact support
              </Link>{' '}
              rather than paying again.
            </p>
          )}
        </div>
      )}

      <section className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
        <h2 className="text-sm font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
          Safe activation
        </h2>

        <p className="mt-3 flex items-baseline gap-2">
          <span className="text-4xl font-bold tracking-tight text-slate-900 dark:text-white">
            {price ? formatInr(price.amount) : '—'}
          </span>
          <span className="text-sm text-slate-500 dark:text-slate-400">one-time</span>
        </p>

        <ul className="mt-4 flex flex-col gap-2">
          {INCLUDED.map((item) => (
            <li key={item} className="flex gap-2 text-sm text-slate-700 dark:text-slate-300">
              <CheckIcon />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </section>

      {awaitingMock && stage.kind === 'awaiting-payment' ? (
        <MockCheckoutPanel
          orderId={stage.order.orderId}
          amount={stage.order.amount}
          onSuccess={() =>
            void verify({
              razorpay_order_id: stage.order.orderId,
              razorpay_payment_id: `pay_mock${Date.now().toString(36).padEnd(14, '0')}`,
              razorpay_signature: MOCK_CHECKOUT_SIGNATURE,
            })
          }
          onFailure={() => {
            inFlight.current = false;
            setStage({
              kind: 'failed',
              message: 'Your bank declined the payment (simulated). No money has been taken.',
              canRetry: true,
            });
          }}
          onCancel={() => {
            inFlight.current = false;
            setStage({ kind: 'idle' });
            setNotice('Payment window closed. Nothing has been charged.');
          }}
        />
      ) : (
        <Button
          onClick={() => void startPayment()}
          loading={busy}
          loadingText={stage.kind === 'verifying' ? 'Confirming payment…' : 'Opening payment…'}
          disabled={busy || price === null}
        >
          {stage.kind === 'failed' && stage.canRetry ? 'Try again' : 'Pay now'}
        </Button>
      )}

      <section>
        <h2 className="text-sm font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
          What happens next
        </h2>
        <ol className="mt-3 flex flex-col gap-2">
          {WHAT_HAPPENS_NEXT.map((step, index) => (
            <li key={step} className="flex gap-3 text-sm text-slate-700 dark:text-slate-300">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                {index + 1}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      </section>

      <p className="text-xs text-slate-500 dark:text-slate-400">
        Payments are processed by Razorpay. We never see or store your card details. By paying you
        accept the{' '}
        <Link href="/terms" className="underline underline-offset-2">
          Terms of Service
        </Link>{' '}
        and the{' '}
        <Link href="/refund-policy" className="underline underline-offset-2">
          Refund Policy
        </Link>
        .
      </p>
    </main>
  );
}

function SuccessPanel() {
  return (
    <main
      className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-4 px-4 py-8 text-center"
      role="status"
      aria-live="polite"
    >
      <span className="flex size-16 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-950">
        <svg
          className="size-8 text-emerald-600 dark:text-emerald-400"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m5 13 4 4L19 7" />
        </svg>
      </span>
      <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
        Payment confirmed
      </h1>
      <p className="text-sm text-slate-600 dark:text-slate-400">
        Taking you to your dashboard…
      </p>
      <Link
        href="/dashboard"
        className="text-sm font-semibold text-brand-700 underline underline-offset-2 dark:text-brand-300"
      >
        Go now
      </Link>
    </main>
  );
}

/**
 * Stand-in for the Razorpay Checkout modal while NEXT_PUBLIC_USE_MOCK_API is
 * on, so the whole payment flow can be walked through without Razorpay keys.
 * Never rendered against the real API.
 */
function MockCheckoutPanel({
  orderId,
  amount,
  onSuccess,
  onFailure,
  onCancel,
}: {
  orderId: string;
  amount: number;
  onSuccess: () => void;
  onFailure: () => void;
  onCancel: () => void;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-2xl border-2 border-dashed border-amber-400 bg-amber-50 p-5 dark:border-amber-700 dark:bg-amber-950/30">
      <div>
        <h2 className="text-sm font-bold tracking-wide text-amber-900 uppercase dark:text-amber-200">
          Mock checkout
        </h2>
        <p className="mt-1 text-sm text-amber-900 dark:text-amber-200">
          Razorpay Checkout is not loaded in mock mode. Simulate the outcome instead.
        </p>
        <p className="mt-2 font-mono text-xs break-all text-amber-800 dark:text-amber-300">
          {orderId} · {formatInr(amount)}
        </p>
      </div>

      <Button onClick={onSuccess}>Simulate payment</Button>
      <Button variant="secondary" onClick={onFailure}>
        Simulate failure
      </Button>
      <Button variant="ghost" onClick={onCancel}>
        Close without paying
      </Button>
    </section>
  );
}

function CheckIcon() {
  return (
    <svg
      className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m5 13 4 4L19 7" />
    </svg>
  );
}
