/** Alarm-, Maßnahmen- und Eskalationsregel-Fachlogik für den Einsatzbereich. */
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
  requireIncidentScope,
  type IncidentUser,
} from './incident-access.js';

type Row=Record<string,any>;
const priorityCodes=['critical','high','medium','low'];

export type AlarmListFilters={
  q?:string;status?:string;severity?:string;siteId?:string;priorityCode?:string;
  from?:Date;to?:Date;sort?:string;dir?:'asc'|'desc';page:number;pageSize:number;
};
export type CreateAlarmInput={
  type?:string;priority_id?:string;priority_code?:string;source?:string;description:string;
  site_id?:string|null;employee_id?:string|null;device_id?:string|null;
  source_key?:string|null;client_mutation_id?:string|null;reason?:string;
};
export type MeasureListFilters={
  q?:string;status?:string;module?:string;siteId?:string;incidentId?:string;
  overdue?:boolean;page:number;pageSize:number;
};
export type EscalationRuleInput={
  enabled?:boolean;target_status?:'escalated'|'acknowledged';
  notify_enabled?:boolean;target_user_id?:string|null;reason?:string;
};

function notify(tenantId:string,eventType:string,eventKey:string,title:string,body:string,entityId:string){
  void queueNotificationEvent(tenantId,eventType,eventKey,title,body,'alarm',entityId)
    .catch(error=>logger.error({event:'alarm.notification.failed',eventType,error:String(error)},'Alarm notification failed'));
}

async function tenantRow(table:string,tenantId:string,id:string,client?:Pick<PoolClient,'query'>){
  const run=client?client.query.bind(client):query;
  return (await run<Row>(`SELECT * FROM ${table} WHERE tenant_id=$1 AND id=$2`,[tenantId,id])).rows[0];
}

const alarmSortMap:Record<string,string>={
  triggered_at:'a.triggered_at',created_at:'a.created_at',status:'a.status',
  severity:'COALESCE(p.rank,99)',site:'s.name',
};

export async function listAlarms(user:IncidentUser,filters:AlarmListFilters){
  const scope=requireIncidentScope(user,'alarms:read');
  const values:unknown[]=[user.tenantId];
  const clauses=['a.tenant_id=$1'];
  if(scope==='site'){
    values.push(user.siteIds);clauses.push(`a.site_id=ANY($${values.length}::uuid[])`);
  }
  if(filters.siteId){
    if(scope==='site'&&!user.siteIds.includes(filters.siteId))throw incidentError('Kein Zugriff auf dieses Objekt',403);
    values.push(filters.siteId);clauses.push(`a.site_id=$${values.length}`);
  }
  if(filters.q){values.push(`%${filters.q}%`);clauses.push(`(a.description ILIKE $${values.length} OR a.message ILIKE $${values.length} OR a.id::text ILIKE $${values.length})`);}
  if(filters.status){values.push(filters.status);clauses.push(`a.status=$${values.length}`);}
  if(filters.severity){values.push(filters.severity);clauses.push(`(a.severity=$${values.length} OR p.code=$${values.length})`);}
  if(filters.priorityCode){values.push(filters.priorityCode);clauses.push(`p.code=$${values.length}`);}
  if(filters.from){values.push(filters.from.toISOString());clauses.push(`a.triggered_at>=$${values.length}`);}
  if(filters.to){values.push(filters.to.toISOString());clauses.push(`a.triggered_at<=$${values.length}`);}
  const where=clauses.join(' AND ');
  const joins=`FROM alarms a
    LEFT JOIN alarm_priorities p ON p.tenant_id=a.tenant_id AND p.id=a.priority_id
    LEFT JOIN sites s ON s.tenant_id=a.tenant_id AND s.id=a.site_id
    LEFT JOIN employees e ON e.tenant_id=a.tenant_id AND e.id=a.employee_id`;
  const total=Number((await query<Row>(`SELECT count(*)::text count ${joins} WHERE ${where}`,values)).rows[0]?.count??0);
  const order=`${alarmSortMap[filters.sort??'triggered_at']??'a.triggered_at'} ${filters.dir==='asc'?'ASC':'DESC'}, a.id DESC`;
  const rows=(await query<Row>(
    `SELECT a.*,p.code priority_code,p.name priority_name,p.rank priority_rank,p.color priority_color,
       s.name site_name,e.name employee_name ${joins} WHERE ${where} ORDER BY ${order}
     LIMIT $${values.length+1} OFFSET $${values.length+2}`,
    [...values,filters.pageSize,(filters.page-1)*filters.pageSize])).rows;
  return {rows,total};
}

export async function createIncidentAlarm(user:IncidentUser,body:CreateAlarmInput){
  const scope=requireIncidentScope(user,'alarms:write',['tenant','site','system']);
  assertIncidentSiteScope(user,scope,body.site_id,scope==='site');
  let priorityId=body.priority_id??null;
  if(priorityId&&!await tenantRow('alarm_priorities',user.tenantId,priorityId))throw incidentError('Priorität nicht gefunden',404);
  if(!priorityId){
    const code=body.priority_code??(priorityCodes.includes(body.source??'')?body.source:'medium');
    const priority=(await query<Row>('SELECT id FROM alarm_priorities WHERE tenant_id=$1 AND code=$2',[user.tenantId,code])).rows[0];
    if(!priority)throw incidentError('Priorität nicht gefunden',404);
    priorityId=String(priority.id);
  }
  const priority=await tenantRow('alarm_priorities',user.tenantId,priorityId);
  if(body.site_id&&!await tenantRow('sites',user.tenantId,body.site_id))throw incidentError('Objekt nicht gefunden',404);
  if(body.employee_id&&!await tenantRow('employees',user.tenantId,body.employee_id))throw incidentError('Mitarbeiter nicht gefunden',404);
  if(body.device_id&&!await tenantRow('devices',user.tenantId,body.device_id))throw incidentError('Gerät nicht gefunden',404);
  const sourceKey=body.source_key??(body.client_mutation_id?`client_mutation:${body.client_mutation_id}`:null);
  const fingerprint=incidentFingerprint({
    type:body.type??'alarm',priority_id:priorityId,source:body.source??'einsatz',description:body.description,
    site_id:body.site_id??null,employee_id:body.employee_id??null,device_id:body.device_id??null,
  });
  if(sourceKey){
    const existing=(await query<Row>('SELECT * FROM alarms WHERE tenant_id=$1 AND source_key=$2',[user.tenantId,sourceKey])).rows[0];
    if(existing){
      if(existing.request_fingerprint&&existing.request_fingerprint!==fingerprint)throw incidentReplayConflict();
      return {row:existing,replayed:true};
    }
  }
  const type=body.type??'alarm';
  // Ein als Prioritätscode übergebener source wird nicht als Herkunft gespeichert.
  const origin=priorityCodes.includes(body.source??'')?'einsatz':(body.source??'einsatz');
  const result=await withTransaction(async client=>{
    const inserted=(await client.query<Row>(
      `INSERT INTO alarms(tenant_id,type,priority_id,source,site_id,employee_id,device_id,description,message,
         severity,source_key,request_fingerprint,triggered_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10,$11,now())
       ON CONFLICT (tenant_id,source_key) WHERE source_key IS NOT NULL DO NOTHING RETURNING *`,
      [user.tenantId,type,priorityId,origin,body.site_id??null,body.employee_id??null,body.device_id??null,
        body.description,priority?.severity??'medium',sourceKey,fingerprint],
    )).rows[0];
    if(!inserted){
      const existing=(await client.query<Row>('SELECT * FROM alarms WHERE tenant_id=$1 AND source_key=$2',[user.tenantId,sourceKey])).rows[0];
      if(existing&&existing.request_fingerprint&&existing.request_fingerprint!==fingerprint)throw incidentReplayConflict();
      return {row:existing,replayed:true};
    }
    await client.query(
      `INSERT INTO alarm_history(alarm_id,tenant_id,to_status,changed_by,note)
       VALUES($1,$2,'open',$3,$4)`,
      [inserted.id,user.tenantId,user.userId,body.reason??'Alarm erstellt (Einsatz)'],
    );
    await recordAudit(user.tenantId,user.userId,'einsatz.alarm.created','alarm',inserted.id,{
      type,priority_id:priorityId,source:origin,source_key:sourceKey,site_id:body.site_id??null,
    },client);
    return {row:inserted,replayed:false};
  });
  if(result.row&&!result.replayed){
    publish(user.tenantId,'alarm.created',result.row,'alarms:read');
    notify(user.tenantId,'alarm.created',`alarm:${result.row.id}`,'Neuer Alarm',body.description,String(result.row.id));
  }
  return result;
}

async function loadAlarmForUpdate(user:IncidentUser,id:string,client:PoolClient){
  const alarm=(await client.query<Row>(
    'SELECT * FROM alarms WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[user.tenantId,id])).rows[0];
  if(!alarm)throw incidentError('Alarm nicht gefunden',404);
  return alarm;
}

export async function acknowledgeIncidentAlarm(user:IncidentUser,id:string){
  const scope=requireIncidentScope(user,'alarms:write',['tenant','site','system']);
  const alarm=await withTransaction(async client=>{
    const current=await loadAlarmForUpdate(user,id,client);
    assertIncidentSiteScope(user,scope,current.site_id);
    if(current.status!=='open')throw incidentError('Nur offene Alarme können bestätigt werden',409);
    const updated=(await client.query<Row>(
      `UPDATE alarms SET status='acknowledged',acknowledged_at=now(),acknowledged_by=$1,updated_at=now()
       WHERE tenant_id=$2 AND id=$3 RETURNING *`,[user.userId,user.tenantId,id])).rows[0];
    // Die Bestätigung beseitigt ausdrücklich nicht die Ursache des Alarms.
    await client.query(
      `INSERT INTO alarm_history(alarm_id,tenant_id,from_status,to_status,changed_by,note)
       VALUES($1,$2,'open','acknowledged',$3,'Bestätigung beseitigt die Ursache nicht')`,
      [id,user.tenantId,user.userId],
    );
    await recordAudit(user.tenantId,user.userId,'alarm.acknowledged','alarm',id,{
      from_status:'open',to_status:'acknowledged',resolution:false},client);
    return updated;
  });
  publish(user.tenantId,'alarm.acknowledged',alarm,'alarms:read');
  notify(user.tenantId,'alarm.acknowledged',`alarm:${id}:acknowledged`,'Alarm bestätigt',
    'Bestätigung beseitigt die Ursache nicht',id);
  return alarm;
}

export async function resolveIncidentAlarm(user:IncidentUser,id:string,reason:string){
  const scope=requireIncidentScope(user,'alarms:write',['tenant','site','system']);
  const alarm=await withTransaction(async client=>{
    const current=await loadAlarmForUpdate(user,id,client);
    assertIncidentSiteScope(user,scope,current.site_id);
    if(!['acknowledged','escalated'].includes(current.status))throw incidentError('Alarm kann in diesem Status nicht gelöst werden',409);
    const openIncidents=(await client.query<Row>(
      `SELECT id,incident_number,status FROM incidents WHERE tenant_id=$1 AND alarm_id=$2
       AND status NOT IN ('completed','cancelled')`,[user.tenantId,id])).rows;
    if(openIncidents.length){
      throw incidentError('Ein verknüpfter Vorfall ist noch offen',409,{reason_code:'linked_incident_open',
        details:{incidents:openIncidents.map(incident=>({id:String(incident.id),
          incident_number:incident.incident_number,status:incident.status}))}});
    }
    const updated=(await client.query<Row>(
      `UPDATE alarms SET status='resolved',resolved_at=now(),updated_at=now()
       WHERE tenant_id=$1 AND id=$2 RETURNING *`,[user.tenantId,id])).rows[0];
    await client.query(
      `INSERT INTO alarm_history(alarm_id,tenant_id,from_status,to_status,changed_by,note)
       VALUES($1,$2,$3,'resolved',$4,$5)`,[id,user.tenantId,current.status,user.userId,reason],
    );
    await recordAudit(user.tenantId,user.userId,'alarm.resolved','alarm',id,{
      from_status:current.status,to_status:'resolved',reason},client);
    return updated;
  });
  publish(user.tenantId,'alarm.resolved',alarm,'alarms:read');
  notify(user.tenantId,'alarm.resolved',`alarm:${id}:resolved`,'Alarm gelöst',reason,id);
  return alarm;
}

export async function getAlarmHistory(user:IncidentUser,id:string){
  requireIncidentScope(user,'alarms:read');
  if(!await tenantRow('alarms',user.tenantId,id))throw incidentError('Alarm nicht gefunden',404);
  return (await query<Row>(
    `SELECT id,alarm_id,from_status,to_status,changed_by,note,created_at
     FROM alarm_history WHERE tenant_id=$1 AND alarm_id=$2 ORDER BY created_at,id`,[user.tenantId,id])).rows;
}

export async function listMeasures(user:IncidentUser,filters:MeasureListFilters){
  const scope=requireIncidentScope(user,'operations_measures:read');
  const values:unknown[]=[user.tenantId];
  const clauses=['m.tenant_id=$1'];
  if(scope==='site'){
    values.push(user.siteIds);clauses.push(`m.site_id=ANY($${values.length}::uuid[])`);
  }
  if(filters.q){values.push(`%${filters.q}%`);clauses.push(`(m.title ILIKE $${values.length} OR m.description ILIKE $${values.length})`);}
  if(filters.status){values.push(filters.status);clauses.push(`m.status=$${values.length}`);}
  if(filters.module){values.push(filters.module);clauses.push(`m.module=$${values.length}`);}
  if(filters.siteId){
    if(scope==='site'&&!user.siteIds.includes(filters.siteId))throw incidentError('Kein Zugriff auf dieses Objekt',403);
    values.push(filters.siteId);clauses.push(`m.site_id=$${values.length}`);
  }
  if(filters.incidentId){values.push(filters.incidentId);clauses.push(`m.incident_id=$${values.length}`);}
  if(filters.overdue)clauses.push(`m.status NOT IN ('done','cancelled') AND m.due_at < now()`);
  const where=clauses.join(' AND ');
  const total=Number((await query<Row>(`SELECT count(*)::text count FROM operations_measures m WHERE ${where}`,values)).rows[0]?.count??0);
  const rows=(await query<Row>(
    `SELECT m.*,s.name site_name,e.name assigned_employee_name,
       (SELECT count(*)::int FROM operations_measures c WHERE c.tenant_id=m.tenant_id
         AND c.incident_id=m.incident_id AND c.status NOT IN ('done','cancelled')) open_siblings
     FROM operations_measures m
     LEFT JOIN sites s ON s.tenant_id=m.tenant_id AND s.id=m.site_id
     LEFT JOIN employees e ON e.tenant_id=m.tenant_id AND e.id=m.assigned_employee_id
     WHERE ${where}
     ORDER BY CASE m.status WHEN 'open' THEN 1 WHEN 'in_progress' THEN 2 WHEN 'on_hold' THEN 3 ELSE 4 END,
       m.due_at NULLS LAST,m.created_at DESC LIMIT $${values.length+1} OFFSET $${values.length+2}`,
    [...values,filters.pageSize,(filters.page-1)*filters.pageSize])).rows;
  return {rows,total};
}

export async function listEscalationRules(user:IncidentUser){
  requireIncidentScope(user,'escalation_rules:read');
  return (await query<Row>(
    'SELECT * FROM escalation_rules WHERE tenant_id=$1 ORDER BY created_at DESC,id',[user.tenantId])).rows;
}

async function updateEscalationRule(user:IncidentUser,id:string,input:EscalationRuleInput,toggle=false){
  requireIncidentScope(user,'escalation_rules:write',['tenant','site','system']);
  const current=await tenantRow('escalation_rules',user.tenantId,id);
  if(!current)throw incidentError('Eskalationsregel nicht gefunden',404);
  if(input.target_status&&!['escalated','acknowledged'].includes(input.target_status))throw incidentError('Ungültiger Eskalationsstatus',400);
  if(input.target_user_id&&!await tenantRow('users',user.tenantId,input.target_user_id))throw incidentError('Zielbenutzer nicht gefunden',404);
  const enabled=toggle?!current.enabled:(input.enabled??current.enabled);
  const fields=['enabled=$1','target_status=$2','notify_enabled=$3','target_user_id=$4','updated_at=now()'];
  const values=[enabled,input.target_status??current.target_status,input.notify_enabled??current.notify_enabled,
    input.target_user_id===undefined?(current.target_user_id??null):input.target_user_id,user.tenantId,id];
  const row=(await query<Row>(
    `UPDATE escalation_rules SET ${fields.join(',')} WHERE tenant_id=$5 AND id=$6 RETURNING *`,values)).rows[0];
  await recordAudit(user.tenantId,user.userId,toggle?'escalation_rule.toggled':'escalation_rule.updated',
    'escalation_rule',id,{before:{enabled:current.enabled,target_status:current.target_status,
      notify_enabled:current.notify_enabled,target_user_id:current.target_user_id},
    after:{enabled:row.enabled,target_status:row.target_status,notify_enabled:row.notify_enabled,
      target_user_id:row.target_user_id},reason:input.reason??null});
  publish(user.tenantId,'escalation_rule.updated',row,'escalation_rules:read');
  return row;
}

export async function patchEscalationRule(user:IncidentUser,id:string,input:EscalationRuleInput){
  return updateEscalationRule(user,id,input);
}

export async function toggleEscalationRule(user:IncidentUser,id:string,input:EscalationRuleInput={}){
  return updateEscalationRule(user,id,input,true);
}
