import type { Request, RequestHandler } from 'express';
import type {
  BulkCreateDevicesInput,
  ClearInspectionInput,
  CreateDeviceInput,
  ForceCompleteBookingInput,
  ListAuditQuery,
  ListBookingsQuery,
  ListDevicesQuery,
  ListPaymentsQuery,
  ListUsersQuery,
  UpdateDeviceSizeInput,
  WaiveOverstayInput,
} from '@safelock/shared';
import { HttpError } from '../../lib/httpError';
import { routeParam } from '../../lib/routeParam';
import {
  AUDIT_ACTIONS,
  auditContext,
  writeAudit,
  type AuditAction,
} from '../audit/audit.service';
import { adminForceComplete, adminWaiveOverstay } from '../bookings/booking.service';
import { clearPaymentReview } from '../payments/payments.service';
import * as deviceService from '../devices/device.service';
import * as adminService from './admin.service';

/**
 * Admin controllers.
 *
 * Every write records an audit entry on **both** outcomes. A refused action is
 * as interesting as a successful one — a run of them against one account is a
 * pattern worth being able to see — so failures are logged with the error code
 * in metadata.
 *
 * The three rental actions here all **require a reason**, enforced by their
 * zod schemas rather than by convention: force-completing a booking, waiving a
 * fee and clearing an inspection are each a human overriding a safety rule,
 * and an override with no stated reason is indistinguishable afterwards from a
 * misclick.
 *
 * Audit metadata carries ids, codes and those reasons only. Emails and phone
 * numbers are never copied in; the audit service scrubs such keys as a
 * backstop.
 */

/** Records a failed admin write with its error code. */
async function auditFailure(
  req: Request,
  action: AuditAction,
  error: unknown,
  metadata: Record<string, unknown>,
): Promise<void> {
  const code = error instanceof HttpError ? error.code : 'INTERNAL_ERROR';
  await writeAudit({
    action,
    userId: req.user?.id ?? null,
    ...auditContext(req),
    metadata: { ...metadata, outcome: 'failed', errorCode: code },
  });
}

// --- Devices -----------------------------------------------------------------

export const getDevices: RequestHandler = async (req, res, next) => {
  try {
    const query = req.query as unknown as ListDevicesQuery;
    res.status(200).json(await deviceService.listDevices(query));
  } catch (error) {
    next(error);
  }
};

export const postDevice: RequestHandler = async (req, res, next) => {
  const body = req.body as CreateDeviceInput;

  try {
    const device = await deviceService.createDevice(body.serialNumber, body.size);

    await writeAudit({
      action: AUDIT_ACTIONS.DEVICE_CREATED,
      userId: req.user!.id,
      deviceId: device.id,
      ...auditContext(req),
      metadata: { serialNumber: device.serialNumber, size: device.size },
    });

    res.status(201).json({ device });
  } catch (error) {
    await auditFailure(req, AUDIT_ACTIONS.DEVICE_CREATED, error, {
      serialNumber: body?.serialNumber,
      size: body?.size,
    });
    next(error);
  }
};

export const postDevicesBulk: RequestHandler = async (req, res, next) => {
  const body = req.body as BulkCreateDevicesInput;

  try {
    const result = await deviceService.bulkCreateDevices(body.serialNumbers, body.size);

    await writeAudit({
      action: AUDIT_ACTIONS.DEVICE_BULK_CREATED,
      userId: req.user!.id,
      ...auditContext(req),
      // Counts, not the serial list: a 500-row paste does not belong in a log.
      metadata: {
        submitted: body.serialNumbers.length,
        size: body.size,
        created: result.created,
        duplicates: result.duplicates,
        invalid: result.invalid,
      },
    });

    res.status(201).json(result);
  } catch (error) {
    await auditFailure(req, AUDIT_ACTIONS.DEVICE_BULK_CREATED, error, {
      submitted: body?.serialNumbers?.length ?? 0,
    });
    next(error);
  }
};

/**
 * Reclassifying a cabinet's size.
 *
 * Audited with both the old and the new value, because this is the one device
 * write that changes what future renters are **charged** — and "who made the
 * large safes cheap" needs an answer. Allowed while the safe is occupied: a
 * live booking snapshotted its own size and rate, so nothing about the current
 * rental moves.
 */
export const patchDeviceSize: RequestHandler = async (req, res, next) => {
  const deviceId = routeParam(req, 'id');
  const body = req.body as UpdateDeviceSizeInput;

  try {
    const before = await deviceService.getDeviceSize(deviceId);
    const device = await deviceService.updateDeviceSize(deviceId, body.size);

    await writeAudit({
      action: AUDIT_ACTIONS.DEVICE_SIZE_CHANGED,
      userId: req.user!.id,
      deviceId,
      ...auditContext(req),
      metadata: {
        changedByAdminId: req.user!.id,
        serialNumber: device.serialNumber,
        from: before,
        to: device.size,
      },
    });

    res.status(200).json({ device });
  } catch (error) {
    await auditFailure(req, AUDIT_ACTIONS.DEVICE_SIZE_CHANGED, error, {
      deviceId,
      to: body?.size,
    });
    next(error);
  }
};

/**
 * Returning a flagged safe to the pool.
 *
 * The one admin action that makes a safe rentable again after a booking ended
 * with its contents unknown. It requires a note, and the note is the point: it
 * is the record that a human looked inside. Audited on both outcomes.
 */
export const postClearInspection: RequestHandler = async (req, res, next) => {
  const deviceId = routeParam(req, 'id');
  const body = req.body as ClearInspectionInput;

  try {
    const result = await deviceService.clearInspection(deviceId, body.note);

    await writeAudit({
      action: AUDIT_ACTIONS.DEVICE_INSPECTION_CLEARED,
      deviceId,
      ...auditContext(req),
      metadata: {
        clearedByAdminId: req.user!.id,
        serialNumber: result.device.serialNumber,
        note: body.note,
      },
    });

    res.status(200).json(result);
  } catch (error) {
    await auditFailure(req, AUDIT_ACTIONS.DEVICE_INSPECTION_CLEARED, error, {
      deviceId,
      attemptedByAdminId: req.user?.id,
    });
    next(error);
  }
};

/**
 * What this safe has been doing lately. Read-only, so not audited.
 *
 * Reading a diagnostic list is not an action on a device, and auditing every
 * panel expansion would bury the rows that record somebody *doing* something
 * — which is the only reason the audit log is worth reading.
 */
export const getDeviceCommands: RequestHandler = async (req, res, next) => {
  try {
    const commands = await deviceService.listDeviceCommands(routeParam(req, 'id'));

    res.status(200).json({ items: commands });
  } catch (error) {
    next(error);
  }
};

/**
 * Mints a unit's credential, for the one and only time it is readable.
 *
 * The audit row records that a credential was issued, which safe it was for,
 * and at which key version — and **nothing derived from the secrets**. Not a
 * prefix, not a length, not a digest: an audit table is read by more people
 * than a password store, and a value that is useless to an attacker is also
 * useless to the admin reading the row, so there is nothing to put there.
 *
 * `reissued` is recorded because it is the operationally dangerous case: a
 * re-issue silently revokes a working unit's password, and the question "who
 * bricked SAFE-0007" needs an answer.
 */
export const postDeviceCredential: RequestHandler = async (req, res, next) => {
  const deviceId = routeParam(req, 'id');

  try {
    const credential = await deviceService.issueDeviceCredential(deviceId);

    await writeAudit({
      action: AUDIT_ACTIONS.DEVICE_CREDENTIAL_ISSUED,
      deviceId,
      ...auditContext(req),
      metadata: {
        issuedByAdminId: req.user!.id,
        serialNumber: credential.serialNumber,
        keyVersion: credential.keyVersion,
        reissued: credential.reissued,
      },
    });

    /**
     * 201, not 200: a credential was created. And `Cache-Control: no-store`
     * rather than relying on the default, because this is the one response in
     * the API a browser or proxy holding a copy of would be a stored secret.
     */
    res.status(201).set('Cache-Control', 'no-store').json(credential);
  } catch (error) {
    await auditFailure(req, AUDIT_ACTIONS.DEVICE_CREDENTIAL_ISSUED, error, {
      deviceId,
      attemptedByAdminId: req.user?.id,
    });
    next(error);
  }
};

export const postRetireDevice: RequestHandler = async (req, res, next) => {
  const deviceId = routeParam(req, 'id');

  try {
    const result = await deviceService.retireDevice(deviceId);

    await writeAudit({
      action: AUDIT_ACTIONS.DEVICE_RETIRED,
      deviceId,
      ...auditContext(req),
      metadata: {
        retiredByAdminId: req.user!.id,
        serialNumber: result.device.serialNumber,
        credentialRevoked: result.credentialRevoked,
      },
    });

    /**
     * Its own row, and only when there was something to revoke.
     *
     * Two actions rather than one, because they answer different questions and
     * the second one has a **second half somebody has to perform by hand**:
     * the stored hash is gone, and the unit is still in the broker's password
     * file until an operator removes it. A row saying "this credential was
     * revoked at this time" is what that work gets reconciled against.
     */
    if (result.credentialRevoked) {
      await writeAudit({
        action: AUDIT_ACTIONS.DEVICE_CREDENTIAL_REVOKED,
        deviceId,
        ...auditContext(req),
        metadata: {
          revokedByAdminId: req.user!.id,
          serialNumber: result.device.serialNumber,
          reason: 'RETIRED',
        },
      });
    }

    res.status(200).json(result);
  } catch (error) {
    await auditFailure(req, AUDIT_ACTIONS.DEVICE_RETIRE_FAILED, error, {
      deviceId,
      attemptedByAdminId: req.user?.id,
    });
    next(error);
  }
};

// --- Bookings ----------------------------------------------------------------

/**
 * Ending a booking by hand.
 *
 * `needsInspection` is the admin's call and defaults to true — see
 * `adminForceComplete`. A false answer means "I have looked inside", and it is
 * recorded as such, because it is the one input here that decides whether the
 * next renter could be handed somebody else's property.
 */
export const postForceCompleteBooking: RequestHandler = async (req, res, next) => {
  const bookingId = routeParam(req, 'id');
  const body = req.body as ForceCompleteBookingInput;

  try {
    const result = await adminForceComplete({
      bookingId,
      reason: body.reason,
      needsInspection: body.needsInspection,
    });

    await writeAudit({
      action: AUDIT_ACTIONS.BOOKING_FORCE_COMPLETED,
      deviceId: result.deviceId,
      ...auditContext(req),
      metadata: {
        bookingId,
        completedByAdminId: req.user!.id,
        needsInspection: result.needsInspection,
        reason: body.reason,
      },
    });

    res.status(200).json(result);
  } catch (error) {
    await auditFailure(req, AUDIT_ACTIONS.BOOKING_FORCE_COMPLETED, error, {
      bookingId,
      attemptedByAdminId: req.user?.id,
    });
    next(error);
  }
};

/**
 * Writing off an overstay fee.
 *
 * The amount waived is recorded, not just the fact of the waive: "an admin
 * gave away Rs 450" and "an admin gave away Rs 4" are different events and the
 * log should be able to tell them apart.
 */
export const postWaiveOverstay: RequestHandler = async (req, res, next) => {
  const bookingId = routeParam(req, 'id');
  const body = req.body as WaiveOverstayInput;

  try {
    const result = await adminWaiveOverstay({ bookingId, reason: body.reason });

    await writeAudit({
      action: AUDIT_ACTIONS.BOOKING_OVERSTAY_WAIVED,
      deviceId: result.deviceId,
      ...auditContext(req),
      metadata: {
        bookingId,
        waivedByAdminId: req.user!.id,
        waivedPaise: result.waivedPaise,
        reason: body.reason,
      },
    });

    res.status(200).json(result);
  } catch (error) {
    await auditFailure(req, AUDIT_ACTIONS.BOOKING_OVERSTAY_WAIVED, error, {
      bookingId,
      attemptedByAdminId: req.user?.id,
    });
    next(error);
  }
};

/**
 * Marking a flagged payment dealt with.
 *
 * The refund itself happens in the Razorpay dashboard — see
 * `clearPaymentReview`. This records that it did, with a note.
 */
export const postClearPaymentReview: RequestHandler = async (req, res, next) => {
  const paymentRowId = routeParam(req, 'id');
  const body = req.body as ClearInspectionInput;

  try {
    const payment = await clearPaymentReview({ paymentRowId });

    await writeAudit({
      action: AUDIT_ACTIONS.PAYMENT_REVIEW_CLEARED,
      ...auditContext(req),
      metadata: {
        paymentRowId,
        clearedByAdminId: req.user!.id,
        amount: payment.amount,
        note: body.note,
      },
    });

    res.status(200).json({ payment });
  } catch (error) {
    await auditFailure(req, AUDIT_ACTIONS.PAYMENT_REVIEW_CLEARED, error, {
      paymentRowId,
      attemptedByAdminId: req.user?.id,
    });
    next(error);
  }
};

// --- Read-only listings ------------------------------------------------------

export const getBookings: RequestHandler = async (req, res, next) => {
  try {
    const query = req.query as unknown as ListBookingsQuery;
    res.status(200).json(await adminService.listBookings(query));
  } catch (error) {
    next(error);
  }
};

export const getUsers: RequestHandler = async (req, res, next) => {
  try {
    const query = req.query as unknown as ListUsersQuery;
    res.status(200).json(await adminService.listUsers(query));
  } catch (error) {
    next(error);
  }
};

export const getPayments: RequestHandler = async (req, res, next) => {
  try {
    const query = req.query as unknown as ListPaymentsQuery;
    res.status(200).json(await adminService.listPayments(query));
  } catch (error) {
    next(error);
  }
};

export const getAudit: RequestHandler = async (req, res, next) => {
  try {
    const query = req.query as unknown as ListAuditQuery;
    res.status(200).json(await adminService.listAudit(query));
  } catch (error) {
    next(error);
  }
};
