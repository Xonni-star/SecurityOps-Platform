import {Router,type RequestHandler} from 'express';
import {z} from 'zod';
import {query} from '../db/pool.js';
import {requireAuth,requirePermission} from '../middleware/auth.js';
import {canAccessResource,effectivePermissionScope,normalizePermissionGrants} from '../types/authorization.js';

const uuid=z.string().uuid();
const isoDate=z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

function canRead(req:Parameters<RequestHandler>[0],permission:string,siteId:string){
  const user=req.user!;
  const grants=normalizePermissionGrants(user.permissionGrants,user.permissions);
  const scope=effectivePermissionScope(grants,permission,{role:user.role,isSystemAdmin:user.isSystemAdmin===true});
  return scope!==null&&canAccessResource({userId:user.id,tenantId:user.tenantId,role:user.role,isSystemAdmin:user.isSystemAdmin===true,siteIds:user.siteIds??[],grants},scope,{tenantId:user.tenantId,siteId});
}

function category(eventKind:string){
  if(eventKind.startsWith('alarm'))return 'Alarme';
  if(eventKind.startsWith('incident'))return 'Vorfälle';
  if(eventKind.startsWith('handover'))return 'Übergaben';
  if(eventKind.startsWith('maintenance')||eventKind.startsWith('devices.'))return 'Technik & Wartung';
  if(eventKind.startsWith('dms.')||eventKind.startsWith('site.document_requirement'))return 'Dokumente';
  if(eventKind.startsWith('watchbook'))return 'Wachbuch';
  if(eventKind.startsWith('scheduling'))return 'Dienstplanung';
  if(eventKind.startsWith('employee')||eventKind.startsWith('qualification'))return 'Personal';
  if(eventKind.startsWith('customer'))return 'Kunden & Aufträge';
  if(eventKind.startsWith('key'))return 'Schlüssel';
  return 'Objekt';
}

export const objectChronicleRouter=Router();

/**
 * One denormalized chronological stream from real audit and append-only event tables.
 * Domain streams that are already mirrored into audit_events are intentionally not
 * UNIONed a second time; DISTINCT ON removes any remaining identical events.
 */
objectChronicleRouter.get('/sites/:id/chronicle',requireAuth,requirePermission('sites:read',{allowedScopes:['tenant','site','own','system']}),async(req,res,next)=>{
  try{
    const siteId=uuid.parse(String(req.params.id));
    if(!canRead(req,'sites:read',siteId))return res.status(403).json({error:'Permission scope does not include this site'});
    const filters=z.object({type:z.string().max(120).optional(),from:isoDate.optional(),to:isoDate.optional(),limit:z.coerce.number().int().min(1).max(500).optional()}).strict().parse(req.query);
    const patternMap:Record<string,string[]>={
      'sites:read':['site.location.%','site.hazard.%','site.customer_link%'],
      'devices:read':['devices.%','maintenance_order.%'],
      'dms:read':['dms.%','site.document_requirement.%'],
      'watchbook:read':['watchbook.%','site.instruction.%'],
      'scheduling:read':['scheduling.%'],
      'employees:read':['employee.%','qualification.%'],
      'customers:read':['customer.%'],
      'keys:read':['key.%'],
      'alarms:read':['alarm.%'],
      'incidents:read':['incident.%'],
      'handover:read':['handover.%'],
    };
    const patterns=Object.entries(patternMap).flatMap(([permission,values])=>canRead(req,permission,siteId)?values:[]);
    const types=filters.type?filters.type.split(',').map(value=>value.trim()).filter(Boolean):[];
    const rows=(await query(
      `WITH audit_source AS (
         SELECT a.id::text AS id,a.tenant_id,
           COALESCE(
             NULLIF(a.details->>'site_id','')::uuid,
             CASE WHEN a.entity_type='sites' THEN a.entity_id::uuid END,
             (SELECT d.site_id FROM devices d WHERE d.tenant_id=a.tenant_id AND d.id=a.entity_id::uuid),
             (SELECT doc.site_id FROM dms_documents doc WHERE doc.tenant_id=a.tenant_id AND doc.id=a.entity_id::uuid),
             (SELECT mo.site_id FROM maintenance_orders mo WHERE mo.tenant_id=a.tenant_id AND mo.id=a.entity_id::uuid),
             (SELECT we.site_id FROM watchbook_entries we WHERE we.tenant_id=a.tenant_id AND we.id=a.entity_id::uuid),
             (SELECT k.site_id FROM keys k WHERE k.tenant_id=a.tenant_id AND k.id=a.entity_id::uuid),
             (SELECT kb.site_id FROM key_bundles kb WHERE kb.tenant_id=a.tenant_id AND kb.id=a.entity_id::uuid),
             (SELECT sp.site_id FROM schedule_periods sp WHERE sp.tenant_id=a.tenant_id AND sp.id=a.entity_id::uuid),
             (SELECT sh.site_id FROM schedule_shifts sh WHERE sh.tenant_id=a.tenant_id AND sh.id=a.entity_id::uuid),
             (SELECT sh.site_id FROM schedule_assignments sa
                JOIN schedule_shifts sh ON sh.tenant_id=sa.tenant_id AND sh.id=sa.shift_id
                WHERE sa.tenant_id=a.tenant_id AND sa.id=a.entity_id::uuid),
             (SELECT oa.site_id FROM employee_object_assignments oa WHERE oa.tenant_id=a.tenant_id AND oa.id=a.entity_id::uuid),
             (SELECT n.site_id FROM nfc_devices n WHERE n.tenant_id=a.tenant_id AND n.id=a.entity_id::uuid)
           ) AS site_id,
           a.created_at AS occurred_at,a.event_type AS event_kind,a.entity_type,a.entity_id,
           a.actor_user_id,NULL::uuid AS actor_employee_id,'audit_events'::text AS source_table,
           COALESCE(a.details->>'title',a.details->>'description',a.event_type) AS summary,
           a.details AS details,1 AS source_priority
         FROM audit_events a WHERE a.tenant_id=$1
       ), domain_source AS (
         SELECT h.id::text AS id,h.tenant_id,al.site_id,h.created_at,'alarm.status_changed'::text AS event_kind,
           'alarm'::text AS entity_type,h.alarm_id::text AS entity_id,h.changed_by AS actor_user_id,
           NULL::uuid AS actor_employee_id,'alarm_history'::text AS source_table,
           CONCAT('Alarm: ',COALESCE(h.from_status,'–'),' → ',h.to_status) AS summary,
           jsonb_build_object('from_status',h.from_status,'to_status',h.to_status,'note',h.note) AS details,2 AS source_priority
         FROM alarm_history h JOIN alarms al ON al.tenant_id=h.tenant_id AND al.id=h.alarm_id
         WHERE h.tenant_id=$1 AND al.site_id=$2
         UNION ALL
         SELECT h.id::text AS id,h.tenant_id,i.site_id,h.created_at,'incident.status_changed'::text,
           'incident'::text,h.incident_id::text,h.changed_by,NULL::uuid,'incident_history'::text,
           CONCAT('Vorfall: ',COALESCE(h.from_status,'–'),' → ',h.to_status),
           jsonb_build_object('from_status',h.from_status,'to_status',h.to_status),2
         FROM incident_history h JOIN incidents i ON i.tenant_id=h.tenant_id AND i.id=h.incident_id
         WHERE h.tenant_id=$1 AND i.site_id=$2
         UNION ALL
         SELECT ia.incident_id::text||':'||ia.employee_id::text AS id,i.tenant_id,i.site_id,ia.assigned_at,'incident.assigned'::text,
           'incident'::text,ia.incident_id::text,ia.assigned_by,ia.employee_id,'incident_assignments'::text,
           'Vorfall: Mitarbeiter zugewiesen',jsonb_build_object('employee_id',ia.employee_id),2
         FROM incident_assignments ia JOIN incidents i ON i.tenant_id=ia.tenant_id AND i.id=ia.incident_id
         WHERE i.tenant_id=$1 AND i.site_id=$2
         UNION ALL
         SELECT ev.id::text AS id,ev.tenant_id,h.site_id,ev.created_at,'handover.'||ev.event_type,
           'handover'::text,ev.handover_id::text,ev.actor_user_id,NULL::uuid,'handover_events'::text,
           COALESCE(ev.payload->>'title','Übergabeereignis'),ev.payload,2
         FROM handover_events ev JOIN handover_records h ON h.tenant_id=ev.tenant_id AND h.id=ev.handover_id
         WHERE ev.tenant_id=$1 AND h.site_id=$2
       ), normalized AS (SELECT * FROM audit_source UNION ALL SELECT * FROM domain_source),
       deduped AS (
         SELECT DISTINCT ON (event_kind,entity_id,occurred_at) * FROM normalized
         ORDER BY event_kind,entity_id,occurred_at,source_priority
       )
       SELECT d.*,u.email AS actor_email,e.name AS actor_employee_name
       FROM deduped d
       LEFT JOIN users u ON u.tenant_id=d.tenant_id AND u.id=d.actor_user_id
       LEFT JOIN employees e ON e.tenant_id=d.tenant_id AND e.id=d.actor_employee_id
       WHERE d.tenant_id=$1 AND d.site_id=$2
         AND ($3::text[] IS NULL OR d.event_kind LIKE ANY($3::text[]))
         AND ($7::text[] IS NULL OR d.event_kind=ANY($7::text[]))
         AND ($4::timestamptz IS NULL OR d.occurred_at>=$4::timestamptz)
         AND ($5::timestamptz IS NULL OR d.occurred_at<$5::timestamptz)
       ORDER BY d.occurred_at DESC,d.id DESC LIMIT $6`,
      [req.user!.tenantId,siteId,patterns.length?patterns:null,filters.from?`${filters.from}T00:00:00Z`:null,
        filters.to?`${filters.to}T00:00:00Z`:null,filters.limit??100,types.length?types:null],
    )).rows;
    res.json({site_id:siteId,events:rows.map(row=>({...row,category:category(String(row.event_kind))}))});
  }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Invalid chronicle filter'});next(error);}
});
