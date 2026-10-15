/**
 * Razorpay Checkout loader and types.
 *
 * checkout.js is fetched on demand — when the user actually reaches /pay —
 * rather than from the root layout, so every other page stays free of a
 * third-party script.
 */

const CHECKOUT_SRC = 'https://checkout.razorpay.com/v1/checkout.js';

/** The three fields Checkout hands back on success. */
export interface RazorpaySuccessResponse {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

/** Shape of the `error` payload on the `payment.failed` event. */
export interface RazorpayFailureResponse {
  error?: {
    code?: string;
    description?: string;
    reason?: string;
    source?: string;
    step?: string;
    metadata?: { order_id?: string; payment_id?: string };
  };
}

export interface RazorpayCheckoutOptions {
  key: string;
  amount: number;
  currency: string;
  name: string;
  description?: string;
  order_id: string;
  prefill?: { name?: string; email?: string; contact?: string };
  notes?: Record<string, string>;
  theme?: { color?: string };
  handler: (response: RazorpaySuccessResponse) => void;
  modal?: { ondismiss?: () => void; escape?: boolean; confirm_close?: boolean };
}

export interface RazorpayInstance {
  open: () => void;
  close?: () => void;
  on: (event: 'payment.failed', handler: (response: RazorpayFailureResponse) => void) => void;
}

type RazorpayConstructor = new (options: RazorpayCheckoutOptions) => RazorpayInstance;

declare global {
  interface Window {
    Razorpay?: RazorpayConstructor;
  }
}

let loader: Promise<RazorpayConstructor> | null = null;

/**
 * Injects checkout.js once and resolves with the global constructor.
 *
 * The promise is cached so a double-click cannot start two downloads; a failed
 * load clears the cache so the next attempt can retry.
 */
export function loadRazorpayCheckout(): Promise<RazorpayConstructor> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Razorpay Checkout can only load in the browser.'));
  }

  if (window.Razorpay) return Promise.resolve(window.Razorpay);
  if (loader) return loader;

  loader = new Promise<RazorpayConstructor>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${CHECKOUT_SRC}"]`);
    const script = existing ?? document.createElement('script');

    const onLoad = () => {
      if (window.Razorpay) resolve(window.Razorpay);
      else reject(new Error('Razorpay Checkout loaded but did not register itself.'));
    };

    script.addEventListener('load', onLoad, { once: true });
    script.addEventListener(
      'error',
      () => reject(new Error('Could not load the payment window. Check your connection.')),
      { once: true },
    );

    if (!existing) {
      script.src = CHECKOUT_SRC;
      script.async = true;
      document.body.appendChild(script);
    }
  });

  // Let a later attempt retry rather than replaying the rejection forever.
  loader.catch(() => {
    loader = null;
  });

  return loader;
}
