import type { AdminDeviceRow, DeviceSummary } from '@safelock/shared';

/**
 * Explicit column lists for every device query.
 *
 * Nothing here selects `credentialHash`. Using `select` rather than returning
 * whole rows means a column added to the schema later — a device secret, say —
 * cannot leak into an API response just because someone forgot to exclude it.
 */

/** Columns needed for the owner-facing view. */
export const DEVICE_SUMMARY_SELECT = {
  id: true,
  serialNumber: true,
  lockState: true,
  online: true,
  lastSeenAt: true,
  allocatedAt: true,
} as const;

/** Columns needed for the admin inventory view, including the owner. */
export const ADMIN_DEVICE_SELECT = {
  id: true,
  serialNumber: true,
  status: true,
  lockState: true,
  online: true,
  lastSeenAt: true,
  allocatedAt: true,
  createdAt: true,
  owner: {
    select: { id: true, name: true, email: true },
  },
} as const;

interface DeviceSummaryRow {
  id: string;
  serialNumber: string;
  lockState: 'LOCKED' | 'UNLOCKED' | 'UNKNOWN';
  online: boolean;
  lastSeenAt: Date | null;
  allocatedAt: Date | null;
}

export function toDeviceSummary(device: DeviceSummaryRow): DeviceSummary {
  return {
    id: device.id,
    serialNumber: device.serialNumber,
    lockState: device.lockState,
    online: device.online,
    lastSeenAt: device.lastSeenAt ? device.lastSeenAt.toISOString() : null,
    allocatedAt: device.allocatedAt ? device.allocatedAt.toISOString() : null,
  };
}

interface AdminDeviceRowSource extends DeviceSummaryRow {
  status: 'UNASSIGNED' | 'ASSIGNED' | 'RETIRED';
  createdAt: Date;
  owner: { id: string; name: string; email: string } | null;
}

export function toAdminDeviceRow(device: AdminDeviceRowSource): AdminDeviceRow {
  return {
    ...toDeviceSummary(device),
    status: device.status,
    createdAt: device.createdAt.toISOString(),
    owner: device.owner,
  };
}
