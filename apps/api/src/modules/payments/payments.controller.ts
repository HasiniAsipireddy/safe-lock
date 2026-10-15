import type { RequestHandler } from 'express';
import type {
  CreateOrderResponse,
  PaymentMeResponse,
  VerifyPaymentInput,
  VerifyPaymentResponse,
} from '@safelock/shared';
import { HttpError } from '../../lib/httpError';
import { AUDIT_ACTIONS, auditContext, writeAudit } from '../audit/audit.service';
import * as paymentsService from './payments.service';

export const postOrder: RequestHandler = async (req, res, next) => {
  const userId = req.user!.id;

  try {
    const order = await paymentsService.createOrder(userId);

    await writeAudit({
      action: AUDIT_ACTIONS.PAYMENT_ORDER_CREATED,
      userId,
      ...auditContext(req),
      metadata: {
        paymentRowId: order.paymentId,
        razorpayOrderId: order.orderId,
        amount: order.amount,
        currency: order.currency,
      },
    });

    const response: CreateOrderResponse = order;
    res.status(201).json(response);
  } catch (error) {
    if (error instanceof HttpError && error.status === 409) {
      await writeAudit({
        action: AUDIT_ACTIONS.PAYMENT_ORDER_REFUSED,
        userId,
        ...auditContext(req),
        metadata: { reason: error.code },
      });
    }
    next(error);
  }
};

export const postVerify: RequestHandler = async (req, res, next) => {
  const userId = req.user!.id;
  const body = req.body as VerifyPaymentInput;

  try {
    const result = await paymentsService.verifyPayment({
      userId,
      orderId: body.razorpay_order_id,
      paymentId: body.razorpay_payment_id,
      signature: body.razorpay_signature,
    });

    // Only the state-changing call is audited as a verification; a repeat call
    // is a no-op and would otherwise pollute the log.
    if (result.changed) {
      await writeAudit({
        action: AUDIT_ACTIONS.PAYMENT_VERIFIED,
        userId,
        ...auditContext(req),
        metadata: {
          paymentRowId: result.payment.id,
          razorpayOrderId: body.razorpay_order_id,
          razorpayPaymentId: body.razorpay_payment_id,
          amount: result.payment.amount,
        },
      });
    }

    const response: VerifyPaymentResponse = {
      payment: result.payment,
      hasPaid: result.hasPaid,
    };
    res.status(200).json(response);
  } catch (error) {
    // Security events worth having a record of. The signature value itself is
    // never written to the audit log.
    if (error instanceof HttpError) {
      if (error.status === 400) {
        await writeAudit({
          action: AUDIT_ACTIONS.PAYMENT_SIGNATURE_FAILED,
          userId,
          ...auditContext(req),
          metadata: {
            razorpayOrderId: body?.razorpay_order_id,
            razorpayPaymentId: body?.razorpay_payment_id,
          },
        });
      } else if (error.status === 403) {
        await writeAudit({
          action: AUDIT_ACTIONS.PAYMENT_VERIFY_FORBIDDEN,
          userId,
          ...auditContext(req),
          metadata: { razorpayOrderId: body?.razorpay_order_id },
        });
      }
    }
    next(error);
  }
};

export const getMyPayment: RequestHandler = async (req, res, next) => {
  try {
    const state = await paymentsService.getPaymentStateForUser(req.user!.id);
    const response: PaymentMeResponse = state;
    res.status(200).json(response);
  } catch (error) {
    next(error);
  }
};
