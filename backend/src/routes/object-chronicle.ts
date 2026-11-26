import {Router} from 'express';
import {z} from 'zod';
import {query} from '../db/pool.js';
import {requireAuth,requirePermission} from '../middleware/auth.js';
import {createSitePermissionReader} from '../services/site-permissions.js';

const uuid=z.string().uuid();
const isoDate=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value=>!Number.isNaN(Date.parse(`${value}T00:00:00Z`)),'Ungültiges Kalenderdatum');

export type ChronicleLink={
  target:string;label:string;permission:string;
  entity_id?:string|null;entity_type?:string|null;
  record_id?:string|null;record_available?:boolean;verification_type?:string|null;fallback_target?:string|null;
  evidence_id?:string|null;evidence_fallback_target?:string|null;
};
export type ChronicleRow={
  event_kind:string;entity_type:string|null;entity_id:string|null;site_id:string|null;
  details:Record<string,unknown>|null;
};

function usableId(value:unknown):string|null{
  return typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)?value:null;
}

function detailId(details:Record<string,unknown>|null,key:string):string|null{
  return usableId(details?.[key]);
}

/** Recorded event types use singular and plural spellings; normalize once. */
const canonicalTypes:Record<string,string>={
  maintenance_orders:'maintenance_order',maintenance_order:'maintenance_order',
  dms_documents:'dms_document',dms_document:'dms_document',
  dms_document_requirements:'dms_document_requirement',dms_document_requirement:'dms_document_requirement',
  devices:'device',device:'device',
  object_locations:'object_location',object_location:'object_location',
  object_hazards:'object_hazard',object_hazard:'object_hazard',
  object_hazard_measures:'object_hazard_measure',object_hazard_measure:'object_hazard_measure',
  site_instructions:'site_instruction',site_instruction:'site_instruction',
  instruction_acknowledgements:'instruction_acknowledgement',instruction_acknowledgement:'instruction_acknowledgement',
  employee_object_assignments:'employee_object_assignment',employee_object_assignment:'employee_object_assignment',
  customer_sites:'customer_site',customer_site:'customer_site',
  keys:'key',key:'key',key_bundles:'key_bundle',key_bundle:'key_bundle',
  schedule_periods:'schedule_period',schedule_period:'schedule_period',
  schedule_shifts:'schedule_shift',schedule_shift:'schedule_shift',
  schedule_assignments:'schedule_assignment',schedule_assignment:'schedule_assignment',
  watchbook_entries:'watchbook_entry',watchbook_entry:'watchbook_entry',
  alarms:'alarm',alarm:'alarm',incidents:'incident',incident:'incident',
  handover_records:'handover',handover:'handover',
  employee_qualification:'qualification',employee_qualifications:'qualification',qualification:'qualification',
  employees:'employee',employee:'employee',
  customers:'customer',customer:'customer',
  customer_tasks:'customer_task',customer_task:'customer_task',
};

function canonicalType(type:string|null|undefined):string|null{
  if(!type)return null;
  return canonicalTypes[type]??type;
}

type RecordSpec={table:string;siteScoped:boolean};
/** Existing tables used only to verify that a linked record still exists in this tenant. */
const recordTables:Record<string,RecordSpec>={
  maintenance_order:{table:'maintenance_orders',siteScoped:true},
  dms_document:{table:'dms_documents',siteScoped:true},
  dms_document_requirement:{table:'dms_document_requirements',siteScoped:true},
  device:{table:'devices',siteScoped:true},
  object_location:{table:'object_locations',siteScoped:true},
  object_hazard:{table:'object_hazards',siteScoped:true},
  object_hazard_measure:{table:'object_hazard_measures',siteScoped:true},
  site_instruction:{table:'site_instructions',siteScoped:true},
  employee_object_assignment:{table:'employee_object_assignments',siteScoped:true},
  customer_site:{table:'customer_sites',siteScoped:false},
  key:{table:'keys',siteScoped:true},
  key_bundle:{table:'key_bundles',siteScoped:true},
  schedule_period:{table:'schedule_periods',siteScoped:true},
  schedule_shift:{table:'schedule_shifts',siteScoped:true},
  schedule_assignment:{table:'schedule_assignments',siteScoped:false},
  watchbook_entry:{table:'watchbook_entries',siteScoped:true},
  alarm:{table:'alarms',siteScoped:false},
  incident:{table:'incidents',siteScoped:false},
  handover:{table:'handover_records',siteScoped:true},
  qualification:{table:'employee_qualifications',siteScoped:false},
  employee:{table:'employees',siteScoped:false},
  customer:{table:'customers',siteScoped:false},
  customer_task:{table:'customer_tasks',siteScoped:false},
};

type SectionSpec={tab:string;label:string;permission:string;param:string};
const sectionSpecs:Record<string,SectionSpec>={
  maintenance_order:{tab:'technik',label:'Wartungsauftrag öffnen',permission:'devices:read',param:'maintenance_order'},
  device:{tab:'technik',label:'Gerät öffnen',permission:'devices:read',param:'device'},
  dms_document:{tab:'dokumente',label:'Dokument öffnen',permission:'dms:read',param:'document'},
  dms_document_requirement:{tab:'dokumente',label:'Pflichtdokument öffnen',permission:'dms:read',param:'requirement'},
  object_location:{tab:'struktur',label:'Bereich öffnen',permission:'sites:read',param:'location'},
  object_hazard:{tab:'gefaehrdungen',label:'Gefährdung öffnen',permission:'sites:read',param:'hazard'},
  object_hazard_measure:{tab:'gefaehrdungen',label:'Maßnahme öffnen',permission:'sites:read',param:'measure'},
  site_instruction:{tab:'anweisungen',label:'Dienstanweisung öffnen',permission:'watchbook:read',param:'instruction'},
  instruction_acknowledgement:{tab:'anweisungen',label:'Dienstanweisung öffnen',permission:'watchbook:read',param:'instruction'},
  employee_object_assignment:{tab:'personal',label:'Personalzuordnung öffnen',permission:'employees:read',param:'assignment'},
  key:{tab:'schluessel',label:'Schlüssel öffnen',permission:'keys:read',param:'key'},
  key_bundle:{tab:'schluessel',label:'Schlüsselbund öffnen',permission:'keys:read',param:'key_bundle'},
  schedule_period:{tab:'dienstplanung',label:'Dienstplan öffnen',permission:'scheduling:read',param:'period'},
  schedule_shift:{tab:'dienstplanung',label:'Schicht öffnen',permission:'scheduling:read',param:'shift'},
  schedule_assignment:{tab:'dienstplanung',label:'Schichtzuweisung öffnen',permission:'scheduling:read',param:'shift_assignment'},
  watchbook_entry:{tab:'journal',label:'Wachbucheintrag öffnen',permission:'watchbook:read',param:'entry'},
  alarm:{tab:'vorfaelle',label:'Alarm öffnen',permission:'alarms:read',param:'alarm'},
  incident:{tab:'vorfaelle',label:'Vorfall öffnen',permission:'incidents:read',param:'incident'},
  handover:{tab:'uebersicht',label:'Übergabe öffnen',permission:'handover:read',param:'handover'},
  customer_task:{tab:'aufgaben',label:'Aufgabe öffnen',permission:'customers:read',param:'task'},
  employee:{tab:'personal',label:'Mitarbeiterprofil öffnen',permission:'employees:read',param:'employee'},
};

function sectionTarget(siteId:string,spec:SectionSpec,id:string):string{
  return `/sites/${siteId}/${spec.tab}?${spec.param}=${id}`;
}

/**
 * Derives the concrete record target from real event data. The route verifies
 * that the record still exists in the tenant before exposing this link; if no
 * usable id exists there is no record link and the UI shows a plain hint.
 */
export function chronicleLink(row:ChronicleRow):ChronicleLink|null{
  const type=canonicalType(row.entity_type);
  const id=usableId(row.entity_id);
  const details=row.details;
  const employeeId=detailId(details,'employee_id');
  const documentId=detailId(details,'document_id');
  const customerId=detailId(details,'customer_id');
  const site=row.site_id;

  if(type==='qualification'){
    if(employeeId){
      const target=`/employees/${employeeId}/qualifikationen${id?`?qualification=${id}${documentId?`&document=${documentId}`:''}`:''}`;
      return {target,label:'Qualifikationsnachweis öffnen',permission:'qualifications:read',
        entity_id:id,entity_type:row.entity_type??type,record_id:id,verification_type:'qualification',
        fallback_target:`/employees/${employeeId}/qualifikationen`,
        evidence_id:documentId,
        evidence_fallback_target:`/employees/${employeeId}/qualifikationen${id?`?qualification=${id}`:''}`};
    }
    return site?{target:`/sites/${site}/personal`,label:'Qualifikationen öffnen',permission:'qualifications:read'}:null;
  }
  if(type==='employee'&&employeeId&&site){
    const spec=sectionSpecs.employee!;
    return {target:sectionTarget(site,spec,employeeId),label:spec.label,permission:spec.permission,
      entity_id:id,entity_type:row.entity_type??type,record_id:employeeId,verification_type:'employee',
      fallback_target:`/sites/${site}/personal`};
  }
  if(type==='customer'&&customerId){
    return {target:`/customers/${customerId}`,label:'Kunde öffnen',permission:'customers:read',
      entity_id:id,entity_type:row.entity_type??type,record_id:customerId,verification_type:'customer',
      fallback_target:'/customers'};
  }
  if(type==='customer_site'&&customerId){
    return {target:`/customers/${customerId}${site?`?site=${site}`:''}`,label:'Kunde öffnen',permission:'customers:read',
      entity_id:id,entity_type:row.entity_type??type,record_id:customerId,verification_type:'customer',
      fallback_target:'/customers'};
  }
  const spec=type?sectionSpecs[type]:null;
  if(spec&&id&&site){
    return {target:sectionTarget(site,spec,id),label:spec.label,permission:spec.permission,
      entity_id:id,entity_type:row.entity_type??type,record_id:id,
      verification_type:type==='instruction_acknowledgement'?'site_instruction':type,
      fallback_target:`/sites/${site}/${spec.tab}`};
  }
  // Events without a concrete record still link to the responsible module area.
  if(spec&&site)return {target:`/sites/${site}/${spec.tab}`,label:spec.label,permission:spec.permission};
  if(documentId&&site)return {target:`/sites/${site}/dokumente?document=${documentId}`,label:'Dokument öffnen',permission:'dms:read',record_id:documentId,verification_type:'dms_document'};
  return null;
}

/**
 * Tenant-scoped existence and permission verification for every record link in
 * one query. A record that was deleted meanwhile falls back to its module
 * section and is labelled as unavailable instead of leading to a broken view.
 */
export async function resolveChronicleLinks(
  rows:ChronicleRow[],
  tenantId:string,
  siteId:string,
  canRead:(permission:string,siteId:string)=>Promise<boolean>,
):Promise<Array<ChronicleLink|null>>{
  const links=rows.map(chronicleLink);
  const candidates=new Map<string,Set<string>>();
  for(const link of links){
    const type=canonicalType(link?.verification_type??link?.entity_type);
    const id=link?.record_id;
    if(type&&id&&recordTables[type]){
      if(!candidates.has(type))candidates.set(type,new Set());
      candidates.get(type)!.add(id);
    }
    if(link?.evidence_id&&recordTables.dms_document){
      if(!candidates.has('dms_document'))candidates.set('dms_document',new Set());
      candidates.get('dms_document')!.add(link.evidence_id);
    }
  }
  const available=new Set<string>();
  const params:unknown[]=[tenantId,siteId];
  let parameterIndex=3;
  const unions:string[]=[];
  for(const [type,spec] of Object.entries(recordTables)){
    const ids=[...(candidates.get(type)??[])];
    if(ids.length===0)continue;
    const placeholders=ids.map(()=>`$${parameterIndex++}`).join(',');
    params.push(...ids);
    unions.push(`SELECT '${type}'::text AS type,id::text AS id FROM ${spec.table}
      WHERE tenant_id=$1 ${spec.siteScoped?'AND site_id=$2 ':''}AND id IN (${placeholders})`);
  }
  if(unions.length>0){
    const result=await query<{type:string;id:string}>(unions.join(' UNION ALL '),params);
    for(const row of result.rows)available.add(`${row.type}:${row.id}`);
  }
  return Promise.all(links.map(async link=>{
    if(!link||!await canRead(link.permission,siteId))return null;
    const type=canonicalType(link.verification_type??link.entity_type);
    const id=link.record_id;
    if(type&&id&&recordTables[type]&&!available.has(`${type}:${id}`)){
      return {...link,target:link.fallback_target??link.target.split('?')[0],record_available:false,
        label:`${link.label} (Datensatz nicht mehr verfügbar)`,evidence_id:null};
    }
    if(link.evidence_id&&!available.has(`dms_document:${link.evidence_id}`)){
      return {...link,target:link.evidence_fallback_target??link.target,evidence_id:null};
    }
    return link;
  }));
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
    const canRead=createSitePermissionReader(req);
    if(!await canRead('sites:read',siteId))return res.status(403).json({error:'Kein Zugriff auf Objekt'});
    const filters=z.object({type:z.string().max(120).optional(),from:isoDate.optional(),to:isoDate.optional(),limit:z.coerce.number().int().min(1).max(500).optional()}).strict().parse(req.query);
    const patternMap:Record<string,string[]>={
      'sites:read':['site.location.%','site.hazard.%','site.hazard_measure.%','site.customer_link%'],
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
    const patterns:string[]=[];
    for(const [permission,values] of Object.entries(patternMap)){
      if(await canRead(permission,siteId))patterns.push(...values);
    }
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
           a.created_at AS occurred_at,a.event_type AS event_kind,a.entity_type,a.entity_id::text AS entity_id,
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
    const links=await resolveChronicleLinks(rows as ChronicleRow[],req.user!.tenantId,siteId,canRead);
    res.json({site_id:siteId,events:rows.map((row,index)=>({
      ...row,
      category:category(String(row.event_kind)),
      link:links[index],
    }))});
  }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Ungültiger Chronikfilter'});next(error);}
});
