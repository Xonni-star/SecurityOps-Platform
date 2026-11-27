import {query,withTenantContext} from '../db/pool.js';
import {logger} from '../middleware/errors.js';
import {queueNotificationEvent} from './notifications.js';
import {recordAudit} from './audit.js';
import {qualificationLocalDate} from './qualification-status.js';
import {releaseWorkerLease,tryAcquireWorkerLease} from './worker-lease.js';

type ExpiringRow={
  tenant_id:string;qualification_id:string;employee_id:string;employee_name:string;
  catalog_id:string|null;code:string;name:string;valid_until:string;days_left:number;
};
type RequiredRow={
  tenant_id:string;qualification_id:string|null;employee_id:string;employee_name:string;
  catalog_id:string;code:string;name:string;valid_until:string|null;days_left:number;
};
type ClaimInput={
  qualificationId:string|null;employeeId:string;catalogId:string|null;days:number;
  dueDate:string;eventKey:string;eventType:string;title:string;body:string;
};

const expirationEvent='qualification.expiring';
const expiredEvent='qualification.expired';
const missingEvent='qualification.missing_required';

/**
 * Erzeugt genau einen Event-Schlüssel pro Tenant, Ereignis und Kalendertag.
 * Der injizierte Zeitpunkt wird auch für den Schlüssel verwendet, damit
 * Tests mit festem Datum deterministisch sind.
 */
function eventKey(type:string,tenantId:string,parts:string[]):string{
  return `${type}:${tenantId}:${parts.join(':')}`;
}

async function ensureRecipients(tenantId:string,eventType:string,employeeId:string,today:string):Promise<void>{
  await query(
    `INSERT INTO notification_subscriptions(tenant_id,user_id,event_type,channel)
     SELECT $1,e.user_id,$2,'in_app' FROM employees e
      WHERE e.tenant_id=$1 AND e.id=$3 AND e.user_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM notification_subscriptions s
           WHERE s.tenant_id=$1 AND s.user_id=e.user_id AND s.event_type=$2 AND s.channel='in_app'
        )`,
    [tenantId,eventType,employeeId],
  );
  await query(
    `INSERT INTO notification_subscriptions(tenant_id,user_id,event_type,channel)
     SELECT DISTINCT $1,us.user_id,$2,'in_app'
       FROM user_sites us
       JOIN employee_object_assignments oa
         ON oa.tenant_id=us.tenant_id AND oa.site_id=us.site_id
      WHERE us.tenant_id=$1 AND oa.employee_id=$3
        AND oa.starts_on<=$4::date AND (oa.ends_on IS NULL OR oa.ends_on>=$4::date)
        AND NOT EXISTS (
          SELECT 1 FROM notification_subscriptions s
           WHERE s.tenant_id=$1 AND s.user_id=us.user_id AND s.event_type=$2 AND s.channel='in_app'
        )`,
    [tenantId,eventType,employeeId,today],
  );
}

/** Sperrt das Ereignis in der Historie; bei einem zweiten Lauf passiert nichts. */
async function claimEvent(tenantId:string,input:ClaimInput):Promise<boolean>{
  const result=await query<{event_key:string}>(
    `INSERT INTO qualification_reminder_state
       (tenant_id,event_key,qualification_id,employee_id,catalog_id,days,due_date,event_type,title,body)
     VALUES($1,$2,$3,$4,$5,$6,$7::date,$8,$9,$10)
     ON CONFLICT(tenant_id,event_key) DO NOTHING RETURNING event_key`,
    [tenantId,input.eventKey,input.qualificationId,input.employeeId,input.catalogId,
      input.days,input.dueDate,input.eventType,input.title,input.body],
  );
  return result.rows.length===1;
}

async function emit(
  tenantId:string,
  input:ClaimInput,
  entityType:string,
  entityId:string,
  now:Date,
):Promise<boolean>{
  if(!await claimEvent(tenantId,input))return false;
  await ensureRecipients(tenantId,input.eventType,input.employeeId,input.dueDate);
  await queueNotificationEvent(tenantId,input.eventType,input.eventKey,input.title,input.body,entityType,entityId,input.title);
  await recordAudit(tenantId,null,input.eventType,entityType,entityId,{
    event_key:input.eventKey,due_date:input.dueDate,days_left:input.days,run_at:now.toISOString(),
  });
  return true;
}

async function processTenant(tenantId:string,today:string,now:Date):Promise<number>{
  let queued=0;
  const expiring=(await query<ExpiringRow>(
    `SELECT q.id qualification_id,q.employee_id,e.name employee_name,q.catalog_id,q.code,
       COALESCE(c.name,q.code) name,q.valid_until,(q.valid_until-$1::date)::integer days_left
      FROM employee_qualifications q
      JOIN employees e ON e.tenant_id=q.tenant_id AND e.id=q.employee_id
        AND e.employment_status IN ('active','probation')
        AND (e.hire_date IS NULL OR e.hire_date<=$1::date)
        AND (e.termination_date IS NULL OR e.termination_date>=$1::date)
      LEFT JOIN qualification_catalog c ON c.tenant_id=q.tenant_id
        AND (c.id=q.catalog_id OR (q.catalog_id IS NULL AND c.code=q.code))
      JOIN qualification_reminder_settings s ON s.tenant_id=q.tenant_id
      WHERE q.tenant_id=$2 AND q.valid_until IS NOT NULL
        AND q.status='valid' AND q.revoked_at IS NULL
        AND COALESCE(c.active,true)=true
        AND (q.valid_until-$1::date)>0
        AND (q.valid_until-$1::date)=ANY(s.reminder_days)`,
    [today,tenantId],
  )).rows;
  for(const row of expiring){
    const title='Qualifikation läuft ab';
    const body=`${row.name} von ${row.employee_name} läuft am ${row.valid_until} in ${row.days_left} Tagen ab.`;
    const ok=await emit(tenantId,{
      qualificationId:row.qualification_id,employeeId:row.employee_id,catalogId:row.catalog_id,
      days:row.days_left,dueDate:today,
      eventKey:eventKey(expirationEvent,tenantId,[row.qualification_id,String(row.days_left),today]),
      eventType:expirationEvent,title,body,
    },'employee_qualification',row.qualification_id,now);
    if(ok)queued++;
  }

  const expired=(await query<RequiredRow>(
    `SELECT q.id qualification_id,q.employee_id,e.name employee_name,c.id catalog_id,c.code,
       COALESCE(c.name,q.code) name,q.valid_until,
       GREATEST((q.valid_until-$1::date)::integer,0) days_left
      FROM employee_qualifications q
      JOIN qualification_catalog c ON c.tenant_id=q.tenant_id AND c.required=true AND c.active=true
        AND (c.id=q.catalog_id OR (q.catalog_id IS NULL AND c.code=q.code))
      JOIN employees e ON e.tenant_id=q.tenant_id AND e.id=q.employee_id
        AND e.employment_status IN ('active','probation')
        AND (e.hire_date IS NULL OR e.hire_date<=$1::date)
        AND (e.termination_date IS NULL OR e.termination_date>=$1::date)
      WHERE q.tenant_id=$2
        AND (q.status IN ('expired','revoked','invalid') OR q.revoked_at IS NOT NULL
             OR (q.valid_until IS NOT NULL AND q.valid_until<$1::date))`,
    [today,tenantId],
  )).rows;
  for(const row of expired){
    const qualificationId=String(row.qualification_id??row.catalog_id);
    const title='Pflichtqualifikation ungültig';
    const body=`Pflichtqualifikation ${row.name} von ${row.employee_name} ist abgelaufen, widerrufen oder ungültig und muss geprüft werden.`;
    const ok=await emit(tenantId,{
      qualificationId,employeeId:row.employee_id,catalogId:row.catalog_id,
      days:row.days_left,dueDate:today,
      eventKey:eventKey(expiredEvent,tenantId,[qualificationId,today]),
      eventType:expiredEvent,title,body,
    },'employee_qualification',qualificationId,now);
    if(ok)queued++;
  }

  const missing=(await query<RequiredRow>(
    `SELECT e.id employee_id,e.name employee_name,c.id catalog_id,c.code,c.name,
       NULL::date valid_until,0 days_left
      FROM employees e
      JOIN qualification_catalog c ON c.tenant_id=e.tenant_id AND c.required=true AND c.active=true
      WHERE e.tenant_id=$1 AND e.employment_status IN ('active','probation')
        AND (e.hire_date IS NULL OR e.hire_date<=$1::date)
        AND (e.termination_date IS NULL OR e.termination_date>=$1::date)
        AND NOT EXISTS (
          SELECT 1 FROM employee_qualifications q
           WHERE q.tenant_id=e.tenant_id AND q.employee_id=e.id AND q.code=c.code
        )`,
    [tenantId],
  )).rows;
  for(const row of missing){
    const title='Pflichtqualifikation fehlt';
    const body=`Für ${row.employee_name} fehlt die Pflichtqualifikation ${row.name}. Bitte Nachweis erfassen oder anfordern.`;
    const ok=await emit(tenantId,{
      qualificationId:null,employeeId:row.employee_id,catalogId:row.catalog_id,
      days:0,dueDate:today,
      eventKey:eventKey(missingEvent,tenantId,[row.employee_id,row.catalog_id,today]),
      eventType:missingEvent,title,body,
    },'qualification_catalog',row.catalog_id,now);
    if(ok)queued++;
  }
  return queued;
}

export async function processQualificationReminders(now=new Date()):Promise<{queued:number}>{
  const today=qualificationLocalDate(now);
  const tenants=(await query<{id:string}>('SELECT id FROM tenants')).rows;
  let queued=0;
  for(const tenant of tenants){
    queued+=await withTenantContext(tenant.id,()=>processTenant(tenant.id,today,now));
  }
  return {queued};
}

let timer:NodeJS.Timeout|undefined;
export function startQualificationReminderWorker(intervalMs=86400000){
  if(timer)return stopQualificationReminderWorker;
  const tick=async()=>{
    if(!await tryAcquireWorkerLease('qualification-reminders-worker',Math.max(60000,intervalMs*2)))return;
    try{await processQualificationReminders();}
    catch(error){logger.error({error},'Qualification reminder worker failed');}
    finally{await releaseWorkerLease('qualification-reminders-worker');}
  };
  timer=setInterval(()=>{void tick();},intervalMs);
  void tick();
  timer.unref();
  return stopQualificationReminderWorker;
}
export function stopQualificationReminderWorker(){if(timer){clearInterval(timer);timer=undefined;}}
