/** Pure server-side maintenance workflow rules shared by routes and tests. */

export type MaintenanceStatus = 'planned' | 'open' | 'in_progress' | 'overdue' | 'completed' | 'cancelled';

export const maintenanceStatusLabels: Record<MaintenanceStatus, string> = {
  planned: 'Geplant',
  open: 'Offen',
  in_progress: 'In Bearbeitung',
  overdue: 'Überfällig',
  completed: 'Abgeschlossen',
  cancelled: 'Abgebrochen',
};

function dayValue(value: string | Date | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function todayValue(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

/** "overdue" is derived, never stored, so status history stays unambiguous. */
export function effectiveMaintenanceStatus(
  order: {status: string; due_on?: string | Date | null},
  now = new Date(),
): MaintenanceStatus {
  if (order.status === 'completed' || order.status === 'cancelled') return order.status;
  const due = dayValue(order.due_on);
  if (due !== null && due < todayValue(now)) return 'overdue';
  if (order.status === 'open' || order.status === 'in_progress') return order.status;
  return 'planned';
}

export function withMaintenanceStatus<T extends Record<string, unknown>>(order: T, now = new Date()) {
  const computed = effectiveMaintenanceStatus(order as unknown as {status: string; due_on?: string | Date | null}, now);
  return {...order,computed_status:computed,status_label:maintenanceStatusLabels[computed],overdue:computed==='overdue'};
}

export function maintenanceIsOverdue(
  order: {status: string; due_on?: string | Date | null},
  now = new Date(),
): boolean {
  return effectiveMaintenanceStatus(order, now) === 'overdue';
}

/** Calculates the next due date from the completion date and the device interval. */
export function nextMaintenanceDate(
  completedOn: string | Date,
  intervalDays: number | string | null | undefined,
): string | null {
  const interval = typeof intervalDays === 'string' ? Number(intervalDays) : intervalDays;
  if (interval === null || interval === undefined || !Number.isFinite(interval) || interval <= 0) return null;
  const completed = dayValue(completedOn);
  if (completed === null) return null;
  return new Date(completed + Math.round(interval) * 86_400_000).toISOString().slice(0, 10);
}
