import type { Request, RequestHandler } from 'express';
import type {
  AllocateDeviceInput,
  BulkCreateDevicesInput,
  CreateDeviceInput,
  ListAuditQuery,
  ListDevicesQuery,
  ListPaymentsQuery,
  ListUsersQuery,
} from '@safelock/shared';
import { HttpError } from '../../lib/httpError';
import {
  AUDIT_ACTIONS,
  auditContext,
  writeAudit,
  type AuditAction,
} from '../audit/audit.service';
import * as deviceService from '../devices/device.service';
import * as adminService from './admin.service';

/**
 * Admin controllers.
 *
 * Every write records an audit entry on **both** outcomes. A refused
 * allocation is as interesting as a successful one — repeated NOT_PAID
 * attempts against one account is a pattern worth being able to see — so
 * failures are logged with the error code in metadata.
 *
 * Audit metadata carries ids and codes only. Emails and phone numbers are
 * never copied in; the audit service scrubs such keys as a backstop.
 */

/**
 * Reads a single route parameter.
 *
 * Express 5 types params as `string | string[]` because a path can repeat a
 * name. Ours cannot, so take the first value and keep the call sites clean.
 */
function routeParam(req: Request, name: string): string {
  const value = req.params[name];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

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
    const device = await deviceService.createDevice(body.serialNumber);

    await writeAudit({
      action: AUDIT_ACTIONS.DEVICE_CREATED,
      userId: req.user!.id,
      deviceId: device.id,
      ...auditContext(req),
      metadata: { serialNumber: device.serialNumber },
    });

    res.status(201).json({ device });
  } catch (error) {
    await auditFailure(req, AUDIT_ACTIONS.DEVICE_CREATED, error, {
      serialNumber: body?.serialNumber,
    });
    next(error);
  }
};

export const postDevicesBulk: RequestHandler = async (req, res, next) => {
  const body = req.body as BulkCreateDevicesInput;

  try {
    const result = await deviceService.bulkCreateDevices(body.serialNumbers);

    await writeAudit({
      action: AUDIT_ACTIONS.DEVICE_BULK_CREATED,
      userId: req.user!.id,
      ...auditContext(req),
      // Counts, not the serial list: a 500-row paste does not belong in a log.
      metadata: {
        submitted: body.serialNumbers.length,
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

/** Shared by `POST /devices/:id/allocate` and `POST /allocate-next`. */
function allocateHandler(mode: 'specific' | 'next'): RequestHandler {
  return async (req, res, next) => {
    const body = req.body as AllocateDeviceInput;
    const deviceId = mode === 'specific' ? routeParam(req, 'id') : undefined;

    try {
      const result = await deviceService.allocateDevice(body.userId, deviceId);

      await writeAudit({
        action: AUDIT_ACTIONS.DEVICE_ALLOCATED,
        // The audit subject is the user who received the device; the admin who
        // did it is in metadata.
        userId: body.userId,
        deviceId: result.device.id,
        ...auditContext(req),
        metadata: {
          allocatedByAdminId: req.user!.id,
          serialNumber: result.device.serialNumber,
          mode,
        },
      });

      res.status(200).json(result);
    } catch (error) {
      await auditFailure(req, AUDIT_ACTIONS.DEVICE_ALLOCATION_FAILED, error, {
        targetUserId: body?.userId,
        attemptedByAdminId: req.user?.id,
        deviceId: deviceId ?? null,
        mode,
      });
      next(error);
    }
  };
}

export const postAllocateDevice = allocateHandler('specific');
export const postAllocateNext = allocateHandler('next');

export const postUnassignDevice: RequestHandler = async (req, res, next) => {
  const deviceId = routeParam(req, 'id');

  try {
    const result = await deviceService.unassignDevice(deviceId);

    await writeAudit({
      action: AUDIT_ACTIONS.DEVICE_UNASSIGNED,
      userId: result.previousOwnerId,
      deviceId,
      ...auditContext(req),
      metadata: {
        unassignedByAdminId: req.user!.id,
        serialNumber: result.device.serialNumber,
      },
    });

    res.status(200).json(result);
  } catch (error) {
    await auditFailure(req, AUDIT_ACTIONS.DEVICE_UNASSIGN_FAILED, error, {
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
      },
    });

    res.status(200).json(result);
  } catch (error) {
    await auditFailure(req, AUDIT_ACTIONS.DEVICE_RETIRE_FAILED, error, {
      deviceId,
      attemptedByAdminId: req.user?.id,
    });
    next(error);
  }
};

// --- Read-only listings ------------------------------------------------------

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
