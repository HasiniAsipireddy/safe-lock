import { afterEach, describe, expect, it } from 'vitest';
import { env } from '../../config/env';
import { FAKE_CHECKOUT_SIGNATURE, FAKE_ORDER_PREFIX } from '../../lib/razorpay';
import { expectedCheckoutSignature, verifyCheckoutSignature } from './signature';

const original = env.PAYMENT_PROVIDER;
const fakeOrder = `${FAKE_ORDER_PREFIX}0a1b2c3d4e5f`;

afterEach(() => {
  env.PAYMENT_PROVIDER = original;
});

describe('verifyCheckoutSignature with PAYMENT_PROVIDER=fake', () => {
  it('is off by default: the simulate signature is rejected for a fake-looking order', () => {
    expect(env.PAYMENT_PROVIDER).toBe('razorpay');
    expect(
      verifyCheckoutSignature({
        orderId: fakeOrder,
        paymentId: 'pay_x1',
        signature: FAKE_CHECKOUT_SIGNATURE,
      }),
    ).toBe(false);
  });

  it('accepts the simulate signature for a locally created order', () => {
    env.PAYMENT_PROVIDER = 'fake';
    expect(
      verifyCheckoutSignature({
        orderId: fakeOrder,
        paymentId: 'pay_x1',
        signature: FAKE_CHECKOUT_SIGNATURE,
      }),
    ).toBe(true);
  });

  it('rejects any other signature for a fake order', () => {
    env.PAYMENT_PROVIDER = 'fake';
    expect(
      verifyCheckoutSignature({ orderId: fakeOrder, paymentId: 'pay_x1', signature: 'f'.repeat(64) }),
    ).toBe(false);
  });

  it('still demands the real HMAC for a real Razorpay order', () => {
    env.PAYMENT_PROVIDER = 'fake';
    const orderId = 'order_Real123';
    expect(
      verifyCheckoutSignature({ orderId, paymentId: 'pay_x1', signature: FAKE_CHECKOUT_SIGNATURE }),
    ).toBe(false);
    expect(
      verifyCheckoutSignature({
        orderId,
        paymentId: 'pay_x1',
        signature: expectedCheckoutSignature(orderId, 'pay_x1'),
      }),
    ).toBe(true);
  });
});
