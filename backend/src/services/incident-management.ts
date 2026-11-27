/**
 * Fachlogik für Vorfälle und Einsätze der Leitstelle.
 *
 * Alle Zugriffe laufen im Mandantenkontext des Request; Objektgrenzen werden
 * zusätzlich serverseitig über die wirksame Berechtigung geprüft. Es werden
 * ausschließlich vorhandene Daten ausgewertet und keine externen Notrufe
 * ausgelöst.
 */
import {query,withTransaction} from '../db/pool.js';
import type {PoolClient} from 'pg';
import {logger} from '../middleware/errors.js';
import {publish} from './realtime.js';
import {queueNotificationEvent} from './notifications.js';
import {recordAudit} from './audit.js';
import {
  assertIncidentSiteScope,
  incidentError,
  incidentFingerprint,
  incidentReplayConflict,
  incidentScope,
  incidentWriteScopes,
  requireIncidentScope,
  type IncidentUser,
} from './incident-access.js';

type Row=Record<string,any>;
type Run=Pick<PoolClient,'query'>;

export type IncidentListFilters={
  q?:string; incidentType?:string; priorityCode?:string; status?:string;
  siteId?:string; customerId?:string; employeeId?:string;
  from?:Date; to?:Date; sort?:string; dir?:'asc'|'desc'; page:number; pageSize:number;
};
export type CreateIncidentInput={
  incident_type_code:string; priority_id:string; description:string;
  customer_id?:string|null; site_id?:string|null; employee_id?:string|null;
  alarm_id?:string|null; source?:string|null; source_key?:string|null;
  client_mutation_id?:string|null; reason?:string|null;
};
export type UpdateIncidentInput={
  description?:string; priority_id?:string; incident_type_code?:string;
  customer_id?:string|null; site_id?:string|null; employee_id?:string|null;
  source?:string; reason?:string;
};
export type IncidentStatusInput={
  status:'en_route'|'on_site'|'completed'|'cancelled';
  note?:string; force?:boolean; reason?:string;
};
export type IncidentDocumentInput={document_id:string;category?:'attachment'|'report'|'evidence';note?:string|null};
export type IncidentReportInput={summary?:string;cause?:string;actions?:string;result?:string;document_id?:string};
export type IncidentEscalationInput={rule_id?:string;target_status?:'escalated'|'acknowledged';target_user_id?:string|null;reason?:string};
export type IncidentStatsFilters={from?:Date;to?:Date;siteId?:string;incidentType?:string};

const sortMap:Record<string,string>={
  created_at:'i.created_at',updated_at:'i.updated_at',incident_number:'i.incident_number',
  status:'i.status',priority:'COALESCE(p.rank,99)',type:'t.code',
};

function notify(tenantId:string,eventType:string,eventKey:string,title:string,body:string,entityType:string,entityId:string){
  void queueNotificationEvent(tenantId,eventType,eventKey,title,body,entityType,entityId)
    .catch(error=>logger.error({event:'incident.notification.failed',eventType,error:String(error)},'Incident notification failed'));
}

async function runInTransaction<T>(work:(client:PoolClient)=>Promise<T>){return withTransaction(work);}

async function loadIncident(tenantId:string,id:string,client?:Run):Promise<Row|undefined>{
  const run=client?client.query.bind(client):query;
  const result=await run<Row>(
    `SELECT i.*,t.code incident_type_code,t.name incident_type_name,p.code priority_code,p.name priority_name,
       p.rank priority_rank,s.name site_name,c.name customer_name,e.name employee_name
     FROM incidents i
     LEFT JOIN incident_types t ON t.tenant_id=i.tenant_id AND t.id=i.incident_type_id
     LEFT JOIN alarm_priorities p ON p.tenant_id=i.tenant_id AND p.id=i.priority_id
     LEFT JOIN sites s ON s.tenant_id=i.tenant_id AND s.id=i.site_id
     LEFT JOIN customers c ON c.tenant_id=i.tenant_id AND c.id=i.customer_id
     LEFT JOIN employees e ON e.tenant_id=i.tenant_id AND e.id=i.employee_id
     WHERE i.tenant_id=$1 AND i.id=$2`,
    [tenantId,id],
  );
  return result.rows[0];
}

async function requireIncident(user:IncidentUser,id:string,permission='incidents:read'){
  const scope=requireIncidentScope(user,permission);
  const incident=await loadIncident(user.tenantId,id);
  if(!incident)throw incidentError('Vorfall nicht gefunden',404);
  assertIncidentSiteScope(user,scope,incident.site_id);
  return {incident,scope};
}

async function tenantRow(table:string,tenantId:string,id:string,client?:Run){
  const run=client?client.query.bind(client):query;
  const result=await run<Row>(`SELECT * FROM ${table} WHERE tenant_id=$1 AND id=$2`,[tenantId,id]);
  return result.rows[0];
}

async function loadDocumentLinks(tenantId:string,incidentId:string,category?:string){
  const values:unknown[]=[tenantId,incidentId];
  const categoryClause=category?(values.push(category),` AND x.category=$${values.length}`):'';
  const rows=(await query<Row>(
    `SELECT x.id,x.document_id,x.category,x.note,x.linked_by,x.created_at,
       d.title,d.document_status,d.approval_status,d.site_id,d.customer_id,
       (SELECT v.id FROM dms_versions v WHERE v.tenant_id=d.tenant_id AND v.document_id=d.id
          AND v.lifecycle_state='available' AND v.deleted_at IS NULL ORDER BY v.version_no DESC LIMIT 1) version_id,
       (SELECT v.version_no FROM dms_versions v WHERE v.tenant_id=d.tenant_id AND v.document_id=d.id
          AND v.lifecycle_state='available' AND v.deleted_at IS NULL ORDER BY v.version_no DESC LIMIT 1) version_no
     FROM incident_documents x JOIN dms_documents d ON d.tenant_id=x.tenant_id AND d.id=x.document_id
     WHERE x.tenant_id=$1 AND x.incident_id=$2${categoryClause} ORDER BY x.created_at DESC`,
    values,
  )).rows;
  return rows.map(row=>({
    id:String(row.id),incident_id:String(row.incident_id??incidentId),document_id:String(row.document_id),
    category:String(row.category),note:row.note??null,linked_by:row.linked_by??null,
    created_at:row.created_at,title:row.title,document_status:row.document_status,
    approval_status:row.approval_status,site_id:row.site_id??null,customer_id:row.customer_id??null,
    version_id:row.version_id?String(row.version_id):null,version_no:row.version_no??null,
    // Nur Metadaten und Verweise auf die vorhandenen DMS-Routen; keine Bytes/object_key.
    download_url:row.version_id?`/api/v1/dms/documents/${row.document_id}/versions/${row.version_id}/download`:null,
    preview_url:row.version_id?`/api/v1/dms/documents/${row.document_id}/versions/${row.version_id}/preview`:null,
  }));
}

async function loadNotifications(user:IncidentUser,incident:Row){
  const scope=incidentScope(user,'notifications:read');
  if(!scope)return [];
  assertIncidentSiteScope(user,scope,incident.site_id);
  const alarmId=incident.alarm_id?String(incident.alarm_id):null;
  const rows=(await query<Row>(
    `SELECT id,channel,status,attempts,sent_at,created_at,
       CASE WHEN recipient LIKE '%@%' THEN regexp_replace(recipient,'^(.).*(@.*)$','\\1***\\2')
            WHEN length(recipient)>3 THEN left(recipient,2)||'***' ELSE '***' END recipient_masked
     FROM notification_deliveries
     WHERE tenant_id=$1 AND (event_key=$2 OR event_key LIKE $3
       OR ($4::uuid IS NOT NULL AND (event_key=$5 OR event_key LIKE $6)))
     ORDER BY created_at DESC LIMIT 200`,
    [user.tenantId,`incident:${incident.id}`,`incident:${incident.id}:%`,alarmId,
      alarmId?`alarm:${alarmId}`:null,alarmId?`alarm:${alarmId}:%`:null],
  )).rows;
  return rows.map(row=>({
    id:String(row.id),channel:row.channel,status:row.status,attempts:Number(row.attempts),
    sent_at:row.sent_at??null,created_at:row.created_at,recipient_masked:row.recipient_masked,
  }));
}

export async function listIncidents(user:IncidentUser,filters:IncidentListFilters){
  const scope=requireIncidentScope(user,'incidents:read');
  const values:unknown[]=[user.tenantId];
  const clauses=['i.tenant_id=$1'];
  if(scope==='site'){
    values.push(user.siteIds);
    clauses.push(`i.site_id=ANY($${values.length}::uuid[])`);
  }
  if(filters.siteId){
    if(scope==='site'&&!user.siteIds.includes(filters.siteId))throw incidentError('Kein Zugriff auf dieses Objekt',403);
    values.push(filters.siteId);clauses.push(`i.site_id=$${values.length}`);
  }
  if(filters.q){
    values.push(`%${filters.q}%`);
    clauses.push(`(i.incident_number ILIKE $${values.length} OR i.description ILIKE $${values.length}
      OR s.name ILIKE $${values.length} OR c.name ILIKE $${values.length})`);
  }
  if(filters.incidentType){values.push(filters.incidentType);clauses.push(`t.code=$${values.length}`);}
  if(filters.priorityCode){values.push(filters.priorityCode);clauses.push(`p.code=$${values.length}`);}
  if(filters.status){values.push(filters.status);clauses.push(`i.status=$${values.length}`);}
  if(filters.customerId){values.push(filters.customerId);clauses.push(`i.customer_id=$${values.length}`);}
  if(filters.employeeId){
    values.push(filters.employeeId);
    clauses.push(`(i.employee_id=$${values.length} OR EXISTS (SELECT 1 FROM incident_assignments ia
      WHERE ia.tenant_id=i.tenant_id AND ia.incident_id=i.id AND ia.employee_id=$${values.length}))`);
  }
  if(filters.from){values.push(filters.from.toISOString());clauses.push(`i.created_at>=$${values.length}`);}
  if(filters.to){values.push(filters.to.toISOString());clauses.push(`i.created_at<=$${values.length}`);}
  const where=clauses.join(' AND ');
  const joins=`FROM incidents i
    LEFT JOIN incident_types t ON t.tenant_id=i.tenant_id AND t.id=i.incident_type_id
    LEFT JOIN alarm_priorities p ON p.tenant_id=i.tenant_id AND p.id=i.priority_id
    LEFT JOIN sites s ON s.tenant_id=i.tenant_id AND s.id=i.site_id
    LEFT JOIN customers c ON c.tenant_id=i.tenant_id AND c.id=i.customer_id`;
  const total=Number((await query<Row>(`SELECT count(*)::text count ${joins} WHERE ${where}`,values)).rows[0]?.count??0);
  const order=`${sortMap[filters.sort??'created_at']??'i.created_at'} ${filters.dir==='asc'?'ASC':'DESC'}, i.id DESC`;
  const limit=filters.pageSize;
  const rows=(await query<Row>(
    `SELECT i.*,t.code incident_type_code,t.name incident_type_name,p.code priority_code,p.name priority_name,
       s.name site_name,c.name customer_name,e.name employee_name,
       COALESCE(json_agg(json_build_object('id',ae.id,'name',ae.name)) FILTER (WHERE ae.id IS NOT NULL),'[]'::json) assignees,
       (SELECT count(*)::int FROM operations_measures m WHERE m.tenant_id=i.tenant_id AND m.incident_id=i.id
          AND m.status NOT IN ('done','cancelled')) open_measures
     ${joins}
     LEFT JOIN employees e ON e.tenant_id=i.tenant_id AND e.id=i.employee_id
     LEFT JOIN incident_assignments ia ON ia.tenant_id=i.tenant_id AND ia.incident_id=i.id
     LEFT JOIN employees ae ON ae.tenant_id=i.tenant_id AND ae.id=ia.employee_id
     WHERE ${where}
     GROUP BY i.id,t.code,t.name,p.code,p.name,p.rank,s.name,c.name,e.name
     ORDER BY ${order} LIMIT $${values.length+1} OFFSET $${values.length+2}`,
    [...values,limit,(filters.page-1)*limit],
  )).rows;
  return {rows,total};
}

export async function getIncidentDetail(user:IncidentUser,id:string){
  const {incident}=await requireIncident(user,id);
  const assignees=(await query<Row>(
    `SELECT e.id,e.name,ia.assigned_at FROM incident_assignments ia
     JOIN employees e ON e.tenant_id=ia.tenant_id AND e.id=ia.employee_id
     WHERE ia.tenant_id=$1 AND ia.incident_id=$2 ORDER BY ia.assigned_at`,[user.tenantId,id])).rows;
  const history=(await query<Row>(
    `SELECT id,from_status,to_status,note,event_type,changed_by,created_at FROM incident_history
     WHERE tenant_id=$1 AND incident_id=$2 ORDER BY created_at,id`,[user.tenantId,id])).rows;
  const documents=await loadDocumentLinks(user.tenantId,id);
  const measures=(await query<Row>(
    `SELECT m.*,s.name site_name,e.name assigned_employee_name FROM operations_measures m
     LEFT JOIN sites s ON s.tenant_id=m.tenant_id AND s.id=m.site_id
     LEFT JOIN employees e ON e.tenant_id=m.tenant_id AND e.id=m.assigned_employee_id
     WHERE m.tenant_id=$1 AND m.incident_id=$2 ORDER BY m.created_at DESC`,[user.tenantId,id])).rows;
  const report=(await query<Row>('SELECT * FROM incident_reports WHERE tenant_id=$1 AND incident_id=$2',[user.tenantId,id])).rows[0]??null;
  const reportDocuments=report?await loadDocumentLinks(user.tenantId,id,'report'):[];
  const escalationLog=(await query<Row>(
    `SELECT e.*,r.name rule_name,r.target_status rule_target_status FROM escalation_log e
     LEFT JOIN escalation_rules r ON r.tenant_id=e.tenant_id AND r.id=e.rule_id
     WHERE e.tenant_id=$1 AND e.incident_id=$2 ORDER BY e.created_at DESC`,[user.tenantId,id])).rows;
  const notifications=await loadNotifications(user,incident);
  return {
    ...incident,
    assignees:assignees.map(row=>({id:String(row.id),name:row.name,assigned_at:row.assigned_at})),
    history,documents,measures,
    report:report?{...report,documents:reportDocuments}:null,
    escalation_log:escalationLog,
    notifications,
  };
}

export async function createIncident(user:IncidentUser,body:CreateIncidentInput){
  const scope=requireIncidentScope(user,'incidents:write',incidentWriteScopes);
  assertIncidentSiteScope(user,scope,body.site_id,scope==='site');
  const sourceKey=body.source_key??(body.client_mutation_id?`client_mutation:${body.client_mutation_id}`:null);
  const fingerprint=incidentFingerprint({
    incident_type_code:body.incident_type_code,priority_id:body.priority_id,description:body.description,
    customer_id:body.customer_id??null,site_id:body.site_id??null,employee_id:body.employee_id??null,
    alarm_id:body.alarm_id??null,source:body.source??null,
  });
  if(sourceKey){
    const existing=(await query<Row>('SELECT * FROM incidents WHERE tenant_id=$1 AND source_key=$2',[user.tenantId,sourceKey])).rows[0];
    if(existing){
      if(existing.request_fingerprint&&existing.request_fingerprint!==fingerprint)throw incidentReplayConflict();
      return {row:existing,replayed:true};
    }
  }
  const type=(await query<Row>(
    'SELECT id FROM incident_types WHERE tenant_id=$1 AND code=$2 AND active=true',[user.tenantId,body.incident_type_code])).rows[0];
  if(!type)throw incidentError('Vorfallart nicht gefunden',404);
  const priority=await tenantRow('alarm_priorities',user.tenantId,body.priority_id);
  if(!priority)throw incidentError('Priorität nicht gefunden',404);
  if(body.customer_id&&!await tenantRow('customers',user.tenantId,body.customer_id))throw incidentError('Kunde nicht gefunden',404);
  if(body.site_id&&!await tenantRow('sites',user.tenantId,body.site_id))throw incidentError('Objekt nicht gefunden',404);
  if(body.employee_id&&!await tenantRow('employees',user.tenantId,body.employee_id))throw incidentError('Mitarbeiter nicht gefunden',404);
  let alarm:Row|undefined;
  if(body.alarm_id){
    alarm=await tenantRow('alarms',user.tenantId,body.alarm_id);
    if(!alarm)throw incidentError('Alarm nicht gefunden',404);
  }
  const siteId=body.site_id??alarm?.site_id??null;
  let customerId=body.customer_id??null;
  if(!customerId&&siteId){
    const site=await tenantRow('sites',user.tenantId,siteId);
    customerId=site?.customer_id??null;
  }
  assertIncidentSiteScope(user,scope,siteId,scope==='site');
  const result=await runInTransaction(async client=>{
    const inserted=(await client.query<Row>(
      `INSERT INTO incidents(tenant_id,incident_type_id,priority_id,customer_id,site_id,employee_id,alarm_id,
         description,status,source,source_key,request_fingerprint,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,'initiated',$9,$10,$11,$12)
       ON CONFLICT (tenant_id,source_key) WHERE source_key IS NOT NULL DO NOTHING RETURNING *`,
      [user.tenantId,type.id,body.priority_id,customerId,siteId,body.employee_id??null,body.alarm_id??null,
        body.description,body.source??'manual',sourceKey,fingerprint,user.userId],
    )).rows[0];
    if(!inserted){
      const existing=(await client.query<Row>('SELECT * FROM incidents WHERE tenant_id=$1 AND source_key=$2',[user.tenantId,sourceKey])).rows[0];
      if(existing&&existing.request_fingerprint&&existing.request_fingerprint!==fingerprint)throw incidentReplayConflict();
      return {row:existing,replayed:true};
    }
    await client.query(
      `INSERT INTO incident_history(incident_id,tenant_id,from_status,to_status,changed_by,note,event_type)
       VALUES($1,$2,NULL,'initiated',$3,$4,'created')`,
      [inserted.id,user.tenantId,user.userId,body.reason??'Vorfall erstellt'],
    );
    await recordAudit(user.tenantId,user.userId,'incident.created','incident',inserted.id,{
      incident_number:inserted.incident_number,incident_type_code:body.incident_type_code,
      priority_id:body.priority_id,source:body.source??'manual',source_key:sourceKey,
    },client);
    return {row:inserted,replayed:false};
  });
  if(result.row&&!result.replayed){
    publish(user.tenantId,'incident.created',result.row,'incidents:read');
    notify(user.tenantId,'incident.created',`incident:${result.row.id}`,'Neuer Vorfall',result.row.description,'incident',result.row.id);
  }
  return result;
}

export async function updateIncident(user:IncidentUser,id:string,body:UpdateIncidentInput){
  const {incident,scope}=await requireIncident(user,id,'incidents:write');
  const changes:Record<string,unknown>={};
  const values:unknown[]=[];
  const set=(column:string,value:unknown)=>{values.push(value);changes[column]=value;return `${column}=$${values.length}`;};
  const fields:string[]=[];
  if(body.description!==undefined)fields.push(set('description',body.description));
  if(body.source!==undefined)fields.push(set('source',body.source));
  if(body.priority_id!==undefined){
    if(!await tenantRow('alarm_priorities',user.tenantId,body.priority_id))throw incidentError('Priorität nicht gefunden',404);
    fields.push(set('priority_id',body.priority_id));
  }
  if(body.incident_type_code!==undefined){
    const type=(await query<Row>('SELECT id FROM incident_types WHERE tenant_id=$1 AND code=$2 AND active=true',
      [user.tenantId,body.incident_type_code])).rows[0];
    if(!type)throw incidentError('Vorfallart nicht gefunden',404);
    fields.push(set('incident_type_id',type.id));
  }
  for(const [key,table,message] of [
    ['customer_id','customers','Kunde nicht gefunden'],
    ['site_id','sites','Objekt nicht gefunden'],
    ['employee_id','employees','Mitarbeiter nicht gefunden'],
  ] as const){
    const value=body[key];
    if(value===undefined)continue;
    if(value&&!await tenantRow(table,user.tenantId,value))throw incidentError(message,404);
    assertIncidentSiteScope(user,scope,key==='site_id'?value:incident.site_id);
    fields.push(set(key,value));
  }
  if(!fields.length)throw incidentError('Keine Änderung angegeben',400);
  const row=await runInTransaction(async client=>{
    values.push(new Date().toISOString());fields.push(`updated_at=$${values.length}`);
    values.push(user.tenantId,id);
    const updated=(await client.query<Row>(`UPDATE incidents SET ${fields.join(',')}
      WHERE tenant_id=$${values.length-1} AND id=$${values.length} RETURNING *`,values)).rows[0];
    await client.query(
      `INSERT INTO incident_history(incident_id,tenant_id,from_status,to_status,changed_by,note,event_type)
       VALUES($1,$2,$3,$4,$5,$6,'updated')`,
      [id,user.tenantId,incident.status,incident.status,user.userId,body.reason??'Vorfall aktualisiert'],
    );
    await recordAudit(user.tenantId,user.userId,'incident.updated','incident',id,{changes,reason:body.reason??null},client);
    return updated;
  });
  publish(user.tenantId,'incident.updated',row,'incidents:read');
  return row;
}

const incidentTransitions:Record<string,string[]>={
  initiated:['en_route','cancelled'],
  en_route:['on_site','cancelled'],
  on_site:['completed','cancelled'],
  completed:[],cancelled:[],
};

export async function changeIncidentStatus(user:IncidentUser,id:string,body:IncidentStatusInput){
  const scope=requireIncidentScope(user,'incidents:write',incidentWriteScopes);
  if(body.force&&(!body.reason||body.reason.trim().length<10)){
    throw incidentError('Für eine erzwungene Abschlussänderung ist eine Begründung mit mindestens 10 Zeichen erforderlich',400);
  }
  const result=await runInTransaction(async client=>{
    const current=(await client.query<Row>(
      'SELECT * FROM incidents WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[user.tenantId,id])).rows[0];
    if(!current)throw incidentError('Vorfall nicht gefunden',404);
    assertIncidentSiteScope(user,scope,current.site_id);
    if(!incidentTransitions[current.status]?.includes(body.status)){
      throw incidentError('Ungültiger Statuswechsel des Vorfalls',409,{reason_code:'invalid_transition'});
    }
    let blocked:Record<string,unknown>|null=null;
    if(['completed','cancelled'].includes(body.status)&&!body.force){
      const openAlarms=(await client.query<Row>(
        `SELECT id,status FROM alarms WHERE tenant_id=$1 AND id=$2 AND status<>'resolved'`,
        [user.tenantId,current.alarm_id])).rows;
      const openMeasures=(await client.query<Row>(
        `SELECT id,title,status FROM operations_measures WHERE tenant_id=$1 AND incident_id=$2
         AND status NOT IN ('done','cancelled') ORDER BY created_at`,[user.tenantId,id])).rows;
      if(openAlarms.length||openMeasures.length){
        blocked={open_alarms:openAlarms.map(alarm=>({id:String(alarm.id),status:alarm.status})),
          open_measures:openMeasures.map(measure=>({id:String(measure.id),title:measure.title,status:measure.status}))};
        throw incidentError('Abschlussbedingungen nicht erfüllt: Alarm oder Maßnahme noch offen',409,
          {reason_code:'closure_conditions',details:blocked});
      }
    }
    const terminal=['completed','cancelled'].includes(body.status);
    const updated=(await client.query<Row>(
      `UPDATE incidents SET status=$1,updated_at=now(),closed_at=CASE WHEN $2 THEN now() ELSE closed_at END,
         closed_by=CASE WHEN $2 THEN $3 ELSE closed_by END,
         closure_note=CASE WHEN $2 THEN $4 ELSE closure_note END
       WHERE tenant_id=$5 AND id=$6 RETURNING *`,
      [body.status,terminal,terminal?user.userId:null,terminal?(body.reason??body.note??null):null,user.tenantId,id],
    )).rows[0];
    await client.query(
      `INSERT INTO incident_history(incident_id,tenant_id,from_status,to_status,changed_by,note,event_type)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [id,user.tenantId,current.status,body.status,user.userId,body.reason??body.note??null,terminal?'closed':'status_changed'],
    );
    await recordAudit(user.tenantId,user.userId,terminal?'incident.closed':'incident.status_changed','incident',id,{
      from_status:current.status,to_status:body.status,force:body.force===true,
      reason:body.reason??body.note??null,bypassed_conditions:blocked,
    },client);
    return updated;
  });
  publish(user.tenantId,'incident.status_changed',result,'incidents:read');
  notify(user.tenantId,'incident.status_changed',`incident:${id}:${body.status}`,'Einsatzstatus geändert',
    `Status: ${body.status}`,'incident',id);
  return result;
}

export async function assignIncidentEmployee(user:IncidentUser,id:string,employeeId:string){
  const scope=requireIncidentScope(user,'incidents:write',incidentWriteScopes);
  const incident=(await loadIncident(user.tenantId,id))??(()=>{throw incidentError('Vorfall nicht gefunden',404);})();
  assertIncidentSiteScope(user,scope,incident.site_id);
  const employee=await tenantRow('employees',user.tenantId,employeeId);
  if(!employee)throw incidentError('Mitarbeiter nicht gefunden',404);
  if(scope==='site'){
    if(!incident.site_id)throw incidentError('Für objektbezogene Berechtigungen ist ein Objekt erforderlich',403);
    const assignment=(await query<Row>(
      `SELECT 1 FROM employee_object_assignments WHERE tenant_id=$1 AND employee_id=$2 AND site_id=$3
       AND starts_on<=CURRENT_DATE AND (ends_on IS NULL OR ends_on>=CURRENT_DATE) LIMIT 1`,
      [user.tenantId,employeeId,incident.site_id])).rows[0];
    if(!assignment)throw incidentError('Mitarbeiter ist diesem Objekt nicht zugeordnet',403);
  }
  const row=(await query<Row>(
    `INSERT INTO incident_assignments(tenant_id,incident_id,employee_id,assigned_by,assigned_at)
     VALUES($1,$2,$3,$4,now()) ON CONFLICT (incident_id,employee_id)
     DO UPDATE SET assigned_by=EXCLUDED.assigned_by,assigned_at=now() RETURNING *`,
    [user.tenantId,id,employeeId,user.userId])).rows[0];
  await recordAudit(user.tenantId,user.userId,'incident.assigned','incident',id,{employee_id:employeeId});
  publish(user.tenantId,'incident.assigned',row,'incidents:read');
  return row;
}

async function availableDmsVersion(tenantId:string,documentId:string){
  return (await query<Row>(
    `SELECT id,version_no FROM dms_versions WHERE tenant_id=$1 AND document_id=$2
     AND lifecycle_state='available' AND deleted_at IS NULL ORDER BY version_no DESC LIMIT 1`,
    [tenantId,documentId])).rows[0];
}

export async function linkIncidentDocument(user:IncidentUser,incidentId:string,input:IncidentDocumentInput,category=input.category??'attachment'){
  requireIncidentScope(user,'incident_documents:write',incidentWriteScopes);
  const dmsScope=requireIncidentScope(user,'dms:read');
  const {incident}=await requireIncident(user,incidentId);
  const document=await tenantRow('dms_documents',user.tenantId,input.document_id);
  if(!document||document.document_status!=='active'||document.approval_status!=='approved'){
    throw incidentError('Dokument ist nicht freigegeben oder nicht aktiv',409);
  }
  const version=await availableDmsVersion(user.tenantId,input.document_id);
  if(!version)throw incidentError('Für das Dokument ist keine verfügbare Version vorhanden',409);
  assertIncidentSiteScope(user,dmsScope,document.site_id);
  if(document.customer_id&&!incidentScope(user,'customer_documents:read')){
    throw incidentError('Unzureichende Berechtigungen für Kundendokumente',403);
  }
  if(incident.site_id&&document.site_id&&String(incident.site_id)!==String(document.site_id)){
    throw incidentError('Dokument gehört zu einem anderen Objekt',409,{reason_code:'document_site_mismatch'});
  }
  if(incident.customer_id&&document.customer_id&&String(incident.customer_id)!==String(document.customer_id)){
    throw incidentError('Dokument gehört zu einem anderen Kunden',409,{reason_code:'document_customer_mismatch'});
  }
  const row=(await query<Row>(
    `INSERT INTO incident_documents(tenant_id,incident_id,document_id,linked_by,note,category)
     VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT (tenant_id,incident_id,document_id,category) DO NOTHING RETURNING *`,
    [user.tenantId,incidentId,input.document_id,user.userId,input.note??null,category],
  )).rows[0];
  if(!row)throw incidentError('Dokument ist bereits mit diesem Vorfall verknüpft',409);
  await recordAudit(user.tenantId,user.userId,'incident.document.linked','incident',incidentId,
    {document_id:input.document_id,category,version_id:version.id,note:input.note??null});
  publish(user.tenantId,'incident.document.linked',row,'incidents:read');
  return (await loadDocumentLinks(user.tenantId,incidentId,category))[0]??row;
}

export async function listIncidentDocuments(user:IncidentUser,incidentId:string){
  requireIncidentScope(user,'incident_documents:read');
  await requireIncident(user,incidentId);
  return loadDocumentLinks(user.tenantId,incidentId);
}

export async function unlinkIncidentDocument(
  user:IncidentUser,
  incidentId:string,
  selector:{link_id?:string;document_id?:string;category?:string},
){
  requireIncidentScope(user,'incident_documents:write',incidentWriteScopes);
  await requireIncident(user,incidentId,'incidents:write');
  const values:unknown[]=[user.tenantId,incidentId];
  const clauses=['tenant_id=$1','incident_id=$2'];
  if(selector.link_id){values.push(selector.link_id);clauses.push(`id=$${values.length}`);}
  if(selector.document_id){values.push(selector.document_id);clauses.push(`document_id=$${values.length}`);}
  if(selector.category){values.push(selector.category);clauses.push(`category=$${values.length}`);}
  if(!selector.link_id&&!selector.document_id)throw incidentError('Dokumentverknüpfung nicht angegeben',400);
  const row=(await query<Row>(`DELETE FROM incident_documents WHERE ${clauses.join(' AND ')} RETURNING *`,values)).rows[0];
  if(!row)throw incidentError('Dokumentverknüpfung nicht gefunden',404);
  await recordAudit(user.tenantId,user.userId,'incident.document.unlinked','incident',incidentId,
    {link_id:String(row.id),document_id:String(row.document_id),category:row.category});
  publish(user.tenantId,'incident.document.unlinked',row,'incidents:read');
  return {deleted:true,id:String(row.id)};
}

export async function getIncidentReport(user:IncidentUser,incidentId:string){
  requireIncidentScope(user,'incident_reports:read');
  await requireIncident(user,incidentId);
  const row=(await query<Row>('SELECT * FROM incident_reports WHERE tenant_id=$1 AND incident_id=$2',
    [user.tenantId,incidentId])).rows[0]??null;
  if(!row)return null;
  return {...row,documents:await loadDocumentLinks(user.tenantId,incidentId,'report')};
}

export async function upsertIncidentReport(user:IncidentUser,incidentId:string,input:IncidentReportInput){
  requireIncidentScope(user,'incident_reports:write',incidentWriteScopes);
  await requireIncident(user,incidentId,'incidents:write');
  if(input.document_id)await linkIncidentDocument(user,incidentId,{document_id:input.document_id},'report');
  const row=await runInTransaction(async client=>{
    const existing=(await client.query<Row>(
      'SELECT id,created_by FROM incident_reports WHERE tenant_id=$1 AND incident_id=$2 FOR UPDATE',
      [user.tenantId,incidentId])).rows[0];
    const result=(await client.query<Row>(
      `INSERT INTO incident_reports(tenant_id,incident_id,summary,cause,actions,result,created_by,updated_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$7)
       ON CONFLICT (tenant_id,incident_id) DO UPDATE SET
         summary=COALESCE(EXCLUDED.summary,incident_reports.summary),
         cause=COALESCE(EXCLUDED.cause,incident_reports.cause),
         actions=COALESCE(EXCLUDED.actions,incident_reports.actions),
         result=COALESCE(EXCLUDED.result,incident_reports.result),
         updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING *`,
      [user.tenantId,incidentId,input.summary??null,input.cause??null,input.actions??null,input.result??null,
        existing?.created_by??user.userId],
    )).rows[0];
    await recordAudit(user.tenantId,user.userId,existing?'incident.report.updated':'incident.report.created',
      'incident_report',result.id,{incident_id:incidentId,fields:Object.keys(input)},client);
    return result;
  });
  publish(user.tenantId,'incident.report.updated',row,'incidents:read');
  return row;
}

export async function getEscalationLog(user:IncidentUser,incidentId:string){
  requireIncidentScope(user,'escalation_log:read');
  await requireIncident(user,incidentId);
  return (await query<Row>(
    `SELECT e.*,r.name rule_name,r.target_status rule_target_status,u.email actor_email
     FROM escalation_log e
     LEFT JOIN escalation_rules r ON r.tenant_id=e.tenant_id AND r.id=e.rule_id
     LEFT JOIN users u ON u.tenant_id=e.tenant_id AND u.id=e.actor_user_id
     WHERE e.tenant_id=$1 AND e.incident_id=$2 ORDER BY e.created_at DESC`,
    [user.tenantId,incidentId])).rows;
}

export async function escalateIncident(user:IncidentUser,incidentId:string,input:IncidentEscalationInput){
  requireIncidentScope(user,'incidents:escalate',incidentWriteScopes);
  const {incident}=await requireIncident(user,incidentId,'incidents:read');
  let rule:Row|undefined;
  if(input.rule_id){
    rule=(await query<Row>('SELECT * FROM escalation_rules WHERE tenant_id=$1 AND id=$2',
      [user.tenantId,input.rule_id])).rows[0];
    if(!rule)throw incidentError('Eskalationsregel nicht gefunden',404);
  }
  const targetStatus=input.target_status??rule?.target_status??'escalated';
  if(!['escalated','acknowledged'].includes(targetStatus))throw incidentError('Ungültiger Eskalationsstatus',400);
  const targetUserId=input.target_user_id===undefined?(rule?.target_user_id??null):input.target_user_id;
  if(targetUserId&&!await tenantRow('users',user.tenantId,targetUserId))throw incidentError('Zielbenutzer nicht gefunden',404);
  const reason=input.reason??rule?.name??'Manuelle Eskalation';
  const row=await runInTransaction(async client=>{
    const inserted=(await client.query<Row>(
      `INSERT INTO escalation_log(tenant_id,incident_id,rule_id,trigger,from_status,to_status,reason,actor_user_id)
       VALUES($1,$2,$3,'manual',$4,$5,$6,$7) RETURNING *`,
      [user.tenantId,incidentId,input.rule_id??rule?.id??null,incident.status,targetStatus,reason,user.userId],
    )).rows[0];
    await recordAudit(user.tenantId,user.userId,'incident.escalated','incident',incidentId,{
      escalation_log_id:String(inserted.id),rule_id:input.rule_id??rule?.id??null,
      target_status:targetStatus,target_user_id:targetUserId,reason,
    },client);
    return inserted;
  });
  if(rule?.notify_enabled!==false){
    notify(user.tenantId,'incident.escalated',`incident:${incidentId}:escalation:${row.id}`,
      'Vorfall eskaliert',`${incident.incident_number??incidentId}: ${reason}`,'incident',incidentId);
  }
  publish(user.tenantId,'incident.escalated',{...row,rule:rule?{
    id:String(rule.id),name:rule.name,target_status:rule.target_status,notify_enabled:rule.notify_enabled}:null},'incidents:read');
  return row;
}

export async function getIncidentNotifications(user:IncidentUser,incidentId:string){
  const {incident}=await requireIncident(user,incidentId,'notifications:read');
  return loadNotifications(user,incident);
}

function numeric(value:unknown):number|null{
  if(value===null||value===undefined||value==='')return null;
  const parsed=Number(value);
  return Number.isFinite(parsed)?Math.round(parsed*10)/10:null;
}

export async function getIncidentStats(user:IncidentUser,filters:IncidentStatsFilters){
  requireIncidentScope(user,'einsatz:reports:read');
  const readScope=requireIncidentScope(user,'incidents:read');
  const siteFilter=filters.siteId?(values:unknown[],alias:string)=>{
    values.push(filters.siteId);return ` AND ${alias}.site_id=$${values.length}`;
  }:null;
  const incidentValues:unknown[]=[user.tenantId];
  let incidentWhere='i.tenant_id=$1';
  if(readScope==='site'){
    incidentValues.push(user.siteIds);incidentWhere+=` AND i.site_id=ANY($${incidentValues.length}::uuid[])`;
  }
  if(siteFilter)incidentWhere+=siteFilter(incidentValues,'i');
  if(filters.from){incidentValues.push(filters.from.toISOString());incidentWhere+=` AND i.created_at>=$${incidentValues.length}`;}
  if(filters.to){incidentValues.push(filters.to.toISOString());incidentWhere+=` AND i.created_at<=$${incidentValues.length}`;}
  if(filters.incidentType){incidentValues.push(filters.incidentType);incidentWhere+=` AND t.code=$${incidentValues.length}`;}
  const incidentJoins=`FROM incidents i
    LEFT JOIN incident_types t ON t.tenant_id=i.tenant_id AND t.id=i.incident_type_id
    LEFT JOIN alarm_priorities p ON p.tenant_id=i.tenant_id AND p.id=i.priority_id
    LEFT JOIN sites s ON s.tenant_id=i.tenant_id AND s.id=i.site_id`;

  const alarmValues:unknown[]=[user.tenantId];
  let alarmWhere='a.tenant_id=$1';
  if(readScope==='site'){
    alarmValues.push(user.siteIds);alarmWhere+=` AND a.site_id=ANY($${alarmValues.length}::uuid[])`;
  }
  if(siteFilter)alarmWhere+=siteFilter(alarmValues,'a');
  if(filters.from){alarmValues.push(filters.from.toISOString());alarmWhere+=` AND a.triggered_at>=$${alarmValues.length}`;}
  if(filters.to){alarmValues.push(filters.to.toISOString());alarmWhere+=` AND a.triggered_at<=$${alarmValues.length}`;}
  const alarmJoins=`FROM alarms a
    LEFT JOIN alarm_priorities p ON p.tenant_id=a.tenant_id AND p.id=a.priority_id
    LEFT JOIN sites s ON s.tenant_id=a.tenant_id AND s.id=a.site_id`;

  const byType=(await query<Row>(
    `SELECT COALESCE(t.code,'unknown') code,COALESCE(t.name,'Ohne Typ') name,count(*)::int count
     ${incidentJoins} WHERE ${incidentWhere} GROUP BY 1,2 ORDER BY count DESC,1`,incidentValues)).rows;
  const byPriority=(await query<Row>(
    `SELECT COALESCE(p.code,'unknown') code,COALESCE(p.name,'Ohne Priorität') name,count(*)::int count
     ${incidentJoins} WHERE ${incidentWhere} GROUP BY 1,2 ORDER BY 1`,incidentValues)).rows;
  const byStatus=(await query<Row>(
    `SELECT i.status status,count(*)::int count ${incidentJoins} WHERE ${incidentWhere} GROUP BY 1 ORDER BY 1`,incidentValues)).rows;
  const incidentsTotal=(await query<Row>(`SELECT count(*)::int count ${incidentJoins} WHERE ${incidentWhere}`,incidentValues)).rows[0];
  const alarmTotals=(await query<Row>(
    `SELECT count(*)::int alarms,count(*) FILTER (WHERE a.status='open')::int open_alarms,
       count(*) FILTER (WHERE a.acknowledged_at IS NOT NULL)::int acknowledged,
       count(*) FILTER (WHERE a.status='resolved')::int resolved,
       round(avg(extract(epoch FROM (a.acknowledged_at-a.triggered_at))/60)::numeric,1) avg_ack_minutes,
       round(avg(extract(epoch FROM (a.resolved_at-a.triggered_at))/60)::numeric,1) avg_resolve_minutes
     ${alarmJoins} WHERE ${alarmWhere}`,alarmValues)).rows[0];
  const alarmsByStatus=(await query<Row>(
    `SELECT a.status status,count(*)::int count ${alarmJoins} WHERE ${alarmWhere} GROUP BY 1 ORDER BY 1`,alarmValues)).rows;

  const escalationValues:unknown[]=[user.tenantId];
  let escalationWhere='e.tenant_id=$1';
  if(readScope==='site'){
    escalationValues.push(user.siteIds);escalationWhere+=` AND i.site_id=ANY($${escalationValues.length}::uuid[])`;
  }
  if(siteFilter)escalationWhere+=siteFilter(escalationValues,'i');
  if(filters.from){escalationValues.push(filters.from.toISOString());escalationWhere+=` AND e.created_at>=$${escalationValues.length}`;}
  if(filters.to){escalationValues.push(filters.to.toISOString());escalationWhere+=` AND e.created_at<=$${escalationValues.length}`;}
  if(filters.incidentType){escalationValues.push(filters.incidentType);escalationWhere+=` AND t.code=$${escalationValues.length}`;}
  const escalations=(await query<Row>(
    `SELECT count(*)::int count ${escalationJoins()} WHERE ${escalationWhere}`,escalationValues)).rows[0];
  function escalationJoins(){
    return `FROM escalation_log e
      LEFT JOIN incidents i ON i.tenant_id=e.tenant_id AND i.id=e.incident_id
      LEFT JOIN incident_types t ON t.tenant_id=i.tenant_id AND t.id=i.incident_type_id
      LEFT JOIN sites s ON s.tenant_id=i.tenant_id AND s.id=i.site_id`;
  }

  const measureValues:unknown[]=[user.tenantId];
  let measureWhere='m.tenant_id=$1 AND m.status NOT IN (\'done\',\'cancelled\')';
  if(readScope==='site'){
    measureValues.push(user.siteIds);measureWhere+=` AND m.site_id=ANY($${measureValues.length}::uuid[])`;
  }
  if(siteFilter)measureWhere+=siteFilter(measureValues,'m');
  const openMeasures=(await query<Row>(
    `SELECT count(*)::int count FROM operations_measures m WHERE ${measureWhere}`,measureValues)).rows[0];

  const sites=(await query<Row>(
    `SELECT id,name FROM sites WHERE tenant_id=$1${readScope==='site'?' AND id=ANY($2::uuid[])':''} ORDER BY name`,
    readScope==='site'?[user.tenantId,user.siteIds]:[user.tenantId])).rows;
  const siteIncidents=(await query<Row>(
    `SELECT s.id site_id,count(*)::int incidents ${incidentJoins.replace('LEFT JOIN sites s ON s.tenant_id=i.tenant_id AND s.id=i.site_id','JOIN sites s ON s.tenant_id=i.tenant_id AND s.id=i.site_id')}
     WHERE ${incidentWhere} AND i.site_id IS NOT NULL GROUP BY s.id`,incidentValues)).rows;
  const siteAlarms=(await query<Row>(
    `SELECT s.id site_id,count(*)::int alarms,
       round(avg(extract(epoch FROM (a.acknowledged_at-a.triggered_at))/60)::numeric,1) avg_ack_minutes,
       round(avg(extract(epoch FROM (a.resolved_at-a.triggered_at))/60)::numeric,1) avg_resolve_minutes
     ${alarmJoins.replace('LEFT JOIN sites s ON s.tenant_id=a.tenant_id AND s.id=a.site_id','JOIN sites s ON s.tenant_id=a.tenant_id AND s.id=a.site_id')}
     WHERE ${alarmWhere} AND a.site_id IS NOT NULL GROUP BY s.id`,alarmValues)).rows;
  const siteEscalations=(await query<Row>(
    `SELECT i.site_id,count(*)::int escalations ${escalationJoins()}
     WHERE ${escalationWhere} AND i.site_id IS NOT NULL GROUP BY i.site_id`,escalationValues)).rows;
  const siteMeasures=(await query<Row>(
    `SELECT m.site_id,count(*)::int open_measures FROM operations_measures m WHERE ${measureWhere} AND m.site_id IS NOT NULL GROUP BY m.site_id`,
    measureValues)).rows;
  const grouped=(rows:Row[],key='site_id')=>new Map(rows.map(row=>[String(row[key]),row]));
  const incidentBySite=grouped(siteIncidents),alarmBySite=grouped(siteAlarms),
    escalationBySite=grouped(siteEscalations),measureBySite=grouped(siteMeasures);
  const bySite=sites.map(site=>{
    const alarmRow=alarmBySite.get(String(site.id));
    return {
      site_id:String(site.id),site_name:site.name,
      incidents:Number(incidentBySite.get(String(site.id))?.incidents??0),
      alarms:Number(alarmRow?.alarms??0),
      escalations:Number(escalationBySite.get(String(site.id))?.escalations??0),
      open_measures:Number(measureBySite.get(String(site.id))?.open_measures??0),
      avg_minutes_to_acknowledge:numeric(alarmRow?.avg_ack_minutes),
      avg_minutes_to_resolve:numeric(alarmRow?.avg_resolve_minutes),
    };
  });
  return {
    generated_at:new Date().toISOString(),tenant_id:user.tenantId,
    filters:{from:filters.from?.toISOString()??null,to:filters.to?.toISOString()??null,
      site_id:filters.siteId??null,incident_type:filters.incidentType??null},
    totals:{
      incidents:Number(incidentsTotal?.count??0),
      alarms:Number(alarmTotals?.alarms??0),
      open_alarms:Number(alarmTotals?.open_alarms??0),
      acknowledged_alarms:Number(alarmTotals?.acknowledged??0),
      resolved_alarms:Number(alarmTotals?.resolved??0),
      escalations:Number(escalations?.count??0),
      open_measures:Number(openMeasures?.count??0),
      avg_minutes_to_acknowledge:numeric(alarmTotals?.avg_ack_minutes),
      avg_minutes_to_resolve:numeric(alarmTotals?.avg_resolve_minutes),
    },
    incidents_by_type:byType,incidents_by_priority:byPriority,incidents_by_status:byStatus,
    alarms_by_status:alarmsByStatus,
    by_site:bySite,
    by_tenant:[{
      tenant_id:user.tenantId,
      incidents:Number(incidentsTotal?.count??0),alarms:Number(alarmTotals?.alarms??0),
      escalations:Number(escalations?.count??0),open_measures:Number(openMeasures?.count??0),
      avg_minutes_to_acknowledge:numeric(alarmTotals?.avg_ack_minutes),
      avg_minutes_to_resolve:numeric(alarmTotals?.avg_resolve_minutes),
    }],
  };
}
