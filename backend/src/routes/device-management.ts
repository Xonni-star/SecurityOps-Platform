import {Router, type Response} from 'express';
import {z} from 'zod';
import {query} from '../db/pool.js';
import {requirePermission} from '../middleware/auth.js';
import {recordAudit} from '../services/audit.js';
import {deviceAuthorizationContext, devicePermissionScope, deviceScopeFilter} from '../services/device-access.js';
import {canAccessResource, effectivePermissionScope, normalizePermissionGrants, type PermissionScope} from '../types/authorization.js';
import type {AuthUser} from '../types/models.js';

const uuid = z.string().uuid();
const operationalStatuses = ['active', 'maintenance', 'fault', 'offline', 'decommissioned'] as const;
const allScopes: PermissionScope[] = ['tenant', 'site', 'own', 'system'];

const sortFields: Record<string, string> = {
  name: 'd.name',
  asset_number: 'd.asset_number',
  category: 'd.category',
  manufacturer: 'd.manufacturer',
  site: 's.name',
  operational_status: 'd.operational_status',
  next_inspection_on: 'd.next_inspection_on',
  next_maintenance_on: 'COALESCE(d.next_maintenance_on, d.last_maintenance_on + d.maintenance_interval_days)',
  created_at: 'd.created_at',
};

const listQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  site_id: uuid.optional(),
  category: z.string().trim().max(160).optional(),
  operational_status: z.enum(operationalStatuses).optional(),
  manufacturer: z.string().trim().max(160).optional(),
  responsible_employee_id: uuid.optional(),
  inspection_due: z.enum(['overdue', 'soon', 'planned', 'none']).optional(),
  maintenance_due: z.enum(['overdue', 'soon', 'planned', 'none']).optional(),
  sort: z.enum(Object.keys(sortFields) as [string, ...string[]]).default('name'),
  dir: z.enum(['asc', 'desc']).default('asc'),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

function invalid(res: Response, message = 'Ungültige Anfrage') {
  return res.status(400).json({error: message});
}

function escapeLike(value: string) {
  return `%${value.replace(/[\\%_]/g, '\\$&')}%`;
}

function maintenanceDateExpression() {
  return 'COALESCE(d.next_maintenance_on, d.last_maintenance_on + d.maintenance_interval_days)';
}

function dueCondition(column: string, due?: 'overdue' | 'soon' | 'planned' | 'none') {
  if (!due) return null;
  if (due === 'overdue') return `${column} < CURRENT_DATE`;
  if (due === 'soon') return `${column} BETWEEN CURRENT_DATE AND CURRENT_DATE + 30`;
  if (due === 'planned') return `${column} > CURRENT_DATE + 30`;
  return `${column} IS NULL`;
}

function authorizationContext(user: AuthUser) {
  return deviceAuthorizationContext(user);
}

function canReadDeviceFile(user: AuthUser, siteId: string | null): boolean {
  const scope = devicePermissionScope(user, 'devices:read');
  if (!scope) return false;
  return canAccessResource(authorizationContext(user), scope, {
    tenantId: user.tenantId,
    siteId,
  });
}

export const deviceManagementRouter = Router();

/** Kennzahlen der zentralen Geräteverwaltung aus der einzigen Gerätedatenquelle. */
deviceManagementRouter.get(
  '/overview',
  requirePermission('devices:read', {allowedScopes: allScopes}),
  async (req, res, next) => {
    try {
      const user = req.user!;
      const scope = deviceScopeFilter(user, 'devices:read', 2, 'd');
      const maintenanceDate = maintenanceDateExpression();
      const row = (
        await query(
          `SELECT
             count(*)::int AS total_devices,
             count(*) FILTER (WHERE d.operational_status='active')::int AS active_devices,
             count(*) FILTER (WHERE d.operational_status='maintenance')::int AS maintenance_devices,
             count(*) FILTER (WHERE d.operational_status='fault')::int AS faulty_devices,
             count(*) FILTER (WHERE d.operational_status='offline')::int AS offline_devices,
             count(*) FILTER (WHERE d.operational_status='decommissioned')::int AS decommissioned_devices,
             count(*) FILTER (WHERE d.next_inspection_on < CURRENT_DATE)::int AS overdue_inspections,
             count(*) FILTER (WHERE d.next_inspection_on BETWEEN CURRENT_DATE AND CURRENT_DATE + 30)::int AS upcoming_inspections,
             count(*) FILTER (WHERE ${maintenanceDate} < CURRENT_DATE)::int AS overdue_maintenance,
             count(*) FILTER (WHERE ${maintenanceDate} BETWEEN CURRENT_DATE AND CURRENT_DATE + 30)::int AS upcoming_maintenance
           FROM devices d
           WHERE d.tenant_id=$1 AND d.device_kind='operational'${scope.sql}`,
          [user.tenantId, ...scope.values],
        )
      ).rows[0];
      res.json(row);
    } catch (error) {
      next(error);
    }
  },
);

/** Vorbelegte Filterwerte aus dem tatsächlichen Gerätebestand. */
deviceManagementRouter.get(
  '/filter-options',
  requirePermission('devices:read', {allowedScopes: allScopes}),
  async (req, res, next) => {
    try {
      const user = req.user!;
      const scope = deviceScopeFilter(user, 'devices:read', 2, 'd');
      const rows = (
        await query<{category: string | null; manufacturer: string | null}>(
          `SELECT DISTINCT d.category, d.manufacturer
           FROM devices d
           WHERE d.tenant_id=$1 AND d.device_kind='operational'${scope.sql}
           ORDER BY d.category NULLS LAST, d.manufacturer NULLS LAST`,
          [user.tenantId, ...scope.values],
        )
      ).rows;
      res.json({
        categories: [...new Set(rows.map((row: {category: string | null}) => row.category).filter(Boolean))],
        manufacturers: [...new Set(rows.map((row: {manufacturer: string | null}) => row.manufacturer).filter(Boolean))],
      });
    } catch (error) {
      next(error);
    }
  },
);

/** Bereiche eines Objekts für die Gerätezuordnung. */
deviceManagementRouter.get(
  '/locations/:siteId',
  requirePermission('devices:read', {allowedScopes: allScopes}),
  async (req, res, next) => {
    try {
      const siteId = uuid.safeParse(String(req.params.siteId));
      if (!siteId.success) return invalid(res, 'Ungültige Objekt-ID');
      const user = req.user!;
      const scope = devicePermissionScope(user, 'devices:read');
      if (
        !canAccessResource(authorizationContext(user), scope ?? 'own', {
          tenantId: user.tenantId,
          siteId: siteId.data,
        })
      ) {
        return res.status(403).json({error: 'Kein Zugriff auf dieses Objekt'});
      }
      const rows = (
        await query(
          `SELECT id,name,code,location_type,parent_id FROM object_locations
           WHERE tenant_id=$1 AND site_id=$2 ORDER BY name`,
          [user.tenantId, siteId.data],
        )
      ).rows;
      res.json(rows);
    } catch (error) {
      next(error);
    }
  },
);

/** Gefilterte, sortierte und seitenweise Geräteliste mit berechneten Fälligkeiten. */
deviceManagementRouter.get(
  '/inventory',
  requirePermission('devices:read', {allowedScopes: allScopes}),
  async (req, res, next) => {
    try {
      const parsed = listQuerySchema.safeParse(req.query);
      if (!parsed.success) return invalid(res);
      const filters = parsed.data;
      const user = req.user!;
      const values: unknown[] = [user.tenantId];
      const conditions: string[] = ["d.tenant_id=$1", "d.device_kind='operational'"];
      const scope = deviceScopeFilter(user, 'devices:read', values.length + 1, 'd');
      const scopeCondition = scope.sql.trim().replace(/^AND\s+/, '');
      if (scopeCondition) conditions.push(scopeCondition);
      values.push(...scope.values);

      if (filters.search) {
        values.push(escapeLike(filters.search));
        const index = values.length;
        conditions.push(
          `(d.name ILIKE $${index} ESCAPE '\\' OR d.asset_number ILIKE $${index} ESCAPE '\\' OR d.serial_number ILIKE $${index} ESCAPE '\\')`,
        );
      }
      const exactFilters: Array<[string, string | undefined]> = [
        ['d.site_id', filters.site_id],
        ['d.category', filters.category],
        ['d.operational_status', filters.operational_status],
        ['d.manufacturer', filters.manufacturer],
        ['d.responsible_employee_id', filters.responsible_employee_id],
      ];
      for (const [column, value] of exactFilters) {
        if (!value) continue;
        values.push(value);
        conditions.push(`${column}=$${values.length}`);
      }
      const inspectionDue = dueCondition('d.next_inspection_on', filters.inspection_due);
      if (inspectionDue) conditions.push(inspectionDue);
      const maintenanceDue = dueCondition(maintenanceDateExpression(), filters.maintenance_due);
      if (maintenanceDue) conditions.push(maintenanceDue);

      const where = `WHERE ${conditions.join(' AND ')}`;
      const total = Number(
        (await query(`SELECT count(*)::int AS count FROM devices d ${where}`, values)).rows[0].count,
      );
      values.push(filters.pageSize, (filters.page - 1) * filters.pageSize);
      const limitIndex = values.length - 1;
      const offsetIndex = values.length;
      const direction = filters.dir === 'desc' ? 'DESC' : 'ASC';
      const rows = (
        await query(
          `SELECT d.*, s.name AS site_name, l.name AS location_name, e.name AS responsible_employee_name,
             ${maintenanceDateExpression()} AS effective_maintenance_on,
             CASE WHEN d.next_inspection_on IS NULL THEN 'none'
                  WHEN d.next_inspection_on < CURRENT_DATE THEN 'overdue'
                  WHEN d.next_inspection_on <= CURRENT_DATE + 30 THEN 'soon'
                  ELSE 'planned' END AS inspection_state,
             CASE WHEN ${maintenanceDateExpression()} IS NULL THEN 'none'
                  WHEN ${maintenanceDateExpression()} < CURRENT_DATE THEN 'overdue'
                  WHEN ${maintenanceDateExpression()} <= CURRENT_DATE + 30 THEN 'soon'
                  ELSE 'planned' END AS maintenance_state
           FROM devices d
           LEFT JOIN sites s ON s.tenant_id=d.tenant_id AND s.id=d.site_id
           LEFT JOIN object_locations l ON l.tenant_id=d.tenant_id AND l.id=d.location_id
           LEFT JOIN employees e ON e.tenant_id=d.tenant_id AND e.id=d.responsible_employee_id
           ${where}
           ORDER BY ${sortFields[filters.sort]} ${direction} NULLS LAST, d.name ASC
           LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
          values,
        )
      ).rows;
      res.json({
        rows,
        total,
        page: filters.page,
        pageSize: filters.pageSize,
        totalPages: Math.max(1, Math.ceil(total / filters.pageSize)),
      });
    } catch (error) {
      next(error);
    }
  },
);

/** Vollständige Geräteakte inklusive Wartung, Störungen, Dokumenten und Audit. */
deviceManagementRouter.get(
  '/:id/file',
  requirePermission('devices:read', {allowedScopes: allScopes}),
  async (req, res, next) => {
    try {
      const id = uuid.safeParse(String(req.params.id));
      if (!id.success) return invalid(res, 'Ungültige Geräte-ID');
      const user = req.user!;
      const scope = deviceScopeFilter(user, 'devices:read', 2, 'd');
      const deviceResult = await query(
        `SELECT d.*, s.name AS site_name, l.name AS location_name, e.name AS responsible_employee_name,
           ${maintenanceDateExpression()} AS effective_maintenance_on
         FROM devices d
         LEFT JOIN sites s ON s.tenant_id=d.tenant_id AND s.id=d.site_id
         LEFT JOIN object_locations l ON l.tenant_id=d.tenant_id AND l.id=d.location_id
         LEFT JOIN employees e ON e.tenant_id=d.tenant_id AND e.id=d.responsible_employee_id
         WHERE d.tenant_id=$1 AND d.id=$2 AND d.device_kind='operational'${scope.sql}`,
        [user.tenantId, id.data, ...scope.values],
      );
      const device = deviceResult.rows[0];
      if (!device) return res.status(404).json({error: 'Gerät nicht gefunden'});
      if (!canReadDeviceFile(user, device.site_id)) {
        return res.status(403).json({error: 'Kein Zugriff auf dieses Gerät'});
      }

      const maintenanceOrders = (
        await query<{id: string}>(
          `SELECT o.*, e.name AS responsible_employee_name
           FROM maintenance_orders o
           LEFT JOIN employees e ON e.tenant_id=o.tenant_id AND e.id=o.responsible_employee_id
           WHERE o.tenant_id=$1 AND o.device_id=$2
           ORDER BY o.created_at DESC LIMIT 100`,
          [user.tenantId, id.data],
        )
      ).rows;
      const alarms = (
        await query(
          `SELECT id,severity,status,message,triggered_at,resolved_at
           FROM alarms WHERE tenant_id=$1 AND device_id=$2
           ORDER BY triggered_at DESC LIMIT 100`,
          [user.tenantId, id.data],
        )
      ).rows;

      let documents: unknown[] = [];
      const dmsScope = effectivePermissionScope(
        normalizePermissionGrants(user.permissionGrants, user.permissions),
        'dms:read',
        {role: user.role, isSystemAdmin: user.isSystemAdmin === true},
      );
      if (
        dmsScope &&
        ['tenant', 'site', 'system'].includes(dmsScope) &&
        canAccessResource(authorizationContext(user), dmsScope, {
          tenantId: user.tenantId,
          siteId: device.site_id,
        })
      ) {
        documents = (
          await query(
            `SELECT id,title,description,document_number,document_type,document_status,approval_status,
               valid_until,created_at,
               (SELECT v.id FROM dms_versions v WHERE v.tenant_id=dms_documents.tenant_id AND v.document_id=dms_documents.id ORDER BY v.version_no DESC LIMIT 1) AS latest_version_id
             FROM dms_documents
             WHERE tenant_id=$1 AND device_id=$2 AND deleted_at IS NULL
               AND EXISTS (SELECT 1 FROM dms_versions v WHERE v.tenant_id=dms_documents.tenant_id
                 AND v.document_id=dms_documents.id AND v.lifecycle_state='available')
             ORDER BY created_at DESC LIMIT 100`,
            [user.tenantId, id.data],
          )
        ).rows;
      }

      const history = (
        await query(
          `SELECT id,event_type,entity_type,entity_id,details,actor_user_id,created_at
           FROM audit_events
           WHERE tenant_id=$1 AND (
             (entity_type IN ('device','devices') AND entity_id=$2)
             OR (entity_type='maintenance_order' AND entity_id = ANY($3::uuid[]))
           )
           ORDER BY created_at DESC LIMIT 100`,
          [user.tenantId, id.data, maintenanceOrders.map((order: {id: string}) => order.id)],
        )
      ).rows;

      res.json({device, maintenance_orders: maintenanceOrders, alarms, documents, history});
    } catch (error) {
      next(error);
    }
  },
);

/** Prüfungsdaten aktualisieren – fachlich getrennt von Wartungsaufträgen. */
deviceManagementRouter.post(
  '/:id/inspection',
  requirePermission('devices:write', {allowedScopes: allScopes}),
  async (req, res, next) => {
    try {
      const id = uuid.safeParse(String(req.params.id));
      if (!id.success) return invalid(res, 'Ungültige Geräte-ID');
      const body = z
        .object({
          last_inspection_on: z.string().date().nullable().optional(),
          next_inspection_on: z.string().date().nullable().optional(),
        })
        .strict()
        .refine(value => Object.keys(value).length > 0, 'Keine Prüfungsdaten übermittelt')
        .refine(
          value =>
            !value.last_inspection_on ||
            !value.next_inspection_on ||
            value.next_inspection_on >= value.last_inspection_on,
          'Die nächste Prüfung darf nicht vor der letzten Prüfung liegen',
        )
        .safeParse(req.body);
      if (!body.success) return invalid(res, body.error.issues[0]?.message ?? 'Ungültige Prüfungsdaten');
      const user = req.user!;
      const entries = Object.entries(body.data);
      const scope = deviceScopeFilter(user, 'devices:write', 3 + entries.length, 'd');
      const values = [user.tenantId, id.data, ...entries.map(([, value]) => value), ...scope.values];
      const assignments = entries.map(([key], index) => `${key}=$${index + 3}`).join(',');
      const row = (
        await query(
          `UPDATE devices d SET ${assignments},updated_at=now()
           WHERE d.tenant_id=$1 AND d.id=$2 AND d.device_kind='operational'${scope.sql}
           RETURNING *`,
          values,
        )
      ).rows[0];
      if (!row) return res.status(404).json({error: 'Gerät nicht gefunden'});
      await recordAudit(user.tenantId, user.id, 'devices.inspection_updated', 'device', id.data, {
        changed_fields: Object.keys(body.data),
      });
      res.json(row);
    } catch (error) {
      next(error);
    }
  },
);

/** Gerät ausmustern: status bleibt als technischer Zustand unangetastet. */
deviceManagementRouter.post(
  '/:id/archive',
  requirePermission('devices:write', {allowedScopes: allScopes}),
  async (req, res, next) => {
    try {
      const id = uuid.safeParse(String(req.params.id));
      if (!id.success) return invalid(res, 'Ungültige Geräte-ID');
      const body = z
        .object({reason: z.string().trim().max(500).optional()})
        .strict()
        .safeParse(req.body ?? {});
      if (!body.success) return invalid(res);
      const user = req.user!;
      const readScope = deviceScopeFilter(user, 'devices:write', 3, 'd');
      const previous = (
        await query(
          `SELECT d.operational_status FROM devices d
           WHERE d.tenant_id=$1 AND d.id=$2 AND d.device_kind='operational'${readScope.sql}`,
          [user.tenantId, id.data, ...readScope.values],
        )
      ).rows[0];
      if (!previous) return res.status(404).json({error: 'Gerät nicht gefunden'});
      const scope = deviceScopeFilter(user, 'devices:write', 4, 'd');
      const row = (
        await query(
          `UPDATE devices d SET operational_status='decommissioned',updated_at=now()
           WHERE d.tenant_id=$1 AND d.id=$2 AND d.device_kind='operational'${scope.sql}
           RETURNING *`,
          [user.tenantId, id.data, ...scope.values],
        )
      ).rows[0];
      if (!row) return res.status(404).json({error: 'Gerät nicht gefunden'});
      await recordAudit(user.tenantId, user.id, 'devices.archived', 'device', id.data, {
        reason: body.data.reason ?? null,
        previous_status: previous.operational_status,
      });
      res.json(row);
    } catch (error) {
      next(error);
    }
  },
);

/** Objekt- und Bereichszuordnung mit fachlicher Konsistenzprüfung. */
deviceManagementRouter.post(
  '/:id/assign-site',
  requirePermission('devices:write', {allowedScopes: allScopes}),
  async (req, res, next) => {
    try {
      const id = uuid.safeParse(String(req.params.id));
      if (!id.success) return invalid(res, 'Ungültige Geräte-ID');
      const body = z
        .object({
          site_id: uuid.nullable(),
          location_id: uuid.nullable().optional(),
        })
        .strict()
        .refine(value => Boolean(value.site_id) || !value.location_id, 'Ohne Objekt kann kein Bereich zugeordnet werden')
        .safeParse(req.body);
      if (!body.success) return invalid(res, body.error.issues[0]?.message ?? 'Ungültige Zuordnung');
      const user = req.user!;
      const scope = devicePermissionScope(user, 'devices:write');
      if (body.data.site_id && !canAccessResource(authorizationContext(user), scope ?? 'own', {
        tenantId: user.tenantId,
        siteId: body.data.site_id,
      })) {
        return res.status(403).json({error: 'Kein Zugriff auf dieses Objekt'});
      }
      if (body.data.site_id) {
        const site = (
          await query('SELECT id FROM sites WHERE tenant_id=$1 AND id=$2', [user.tenantId, body.data.site_id])
        ).rows[0];
        if (!site) return res.status(404).json({error: 'Objekt nicht gefunden'});
      }
      if (body.data.location_id) {
        const location = (
          await query(
            'SELECT id FROM object_locations WHERE tenant_id=$1 AND site_id=$2 AND id=$3',
            [user.tenantId, body.data.site_id, body.data.location_id],
          )
        ).rows[0];
        if (!location) return res.status(400).json({error: 'Bereich gehört nicht zum gewählten Objekt'});
      }
      const filter = deviceScopeFilter(user, 'devices:write', 5, 'd');
      const row = (
        await query(
          `UPDATE devices d SET site_id=$3,location_id=$4,updated_at=now()
           WHERE d.tenant_id=$1 AND d.id=$2 AND d.device_kind='operational'${filter.sql}
           RETURNING *`,
          [user.tenantId, id.data, body.data.site_id, body.data.location_id ?? null, ...filter.values],
        )
      ).rows[0];
      if (!row) return res.status(404).json({error: 'Gerät nicht gefunden'});
      await recordAudit(user.tenantId, user.id, 'devices.site_assigned', 'device', id.data, {
        site_id: body.data.site_id,
        location_id: body.data.location_id ?? null,
      });
      res.json(row);
    } catch (error) {
      next(error);
    }
  },
);

/** Fachlich verantwortlichen Mitarbeiter ändern, ohne Standdaten zu berühren. */
deviceManagementRouter.post(
  '/:id/assign-responsible',
  requirePermission('devices:write', {allowedScopes: allScopes}),
  async (req, res, next) => {
    try {
      const id = uuid.safeParse(String(req.params.id));
      if (!id.success) return invalid(res, 'Ungültige Geräte-ID');
      const body = z
        .object({responsible_employee_id: uuid.nullable()})
        .strict()
        .safeParse(req.body);
      if (!body.success) return invalid(res, 'Ungültiger verantwortlicher Mitarbeiter');
      const user = req.user!;
      if (body.data.responsible_employee_id) {
        const employee = (
          await query('SELECT id FROM employees WHERE tenant_id=$1 AND id=$2', [
            user.tenantId,
            body.data.responsible_employee_id,
          ])
        ).rows[0];
        if (!employee) return res.status(404).json({error: 'Mitarbeiter nicht gefunden'});
      }
      const scope = deviceScopeFilter(user, 'devices:write', 4, 'd');
      const row = (
        await query(
          `UPDATE devices d SET responsible_employee_id=$3,updated_at=now()
           WHERE d.tenant_id=$1 AND d.id=$2 AND d.device_kind='operational'${scope.sql}
           RETURNING *`,
          [user.tenantId, id.data, body.data.responsible_employee_id, ...scope.values],
        )
      ).rows[0];
      if (!row) return res.status(404).json({error: 'Gerät nicht gefunden'});
      await recordAudit(user.tenantId, user.id, 'devices.responsible_changed', 'device', id.data, {
        responsible_employee_id: body.data.responsible_employee_id,
      });
      res.json(row);
    } catch (error) {
      next(error);
    }
  },
);
