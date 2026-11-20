import {query} from '../db/pool.js';
import {queueNotificationEvent} from './notifications.js';
import {recordAudit} from './audit.js';
import {releaseWorkerLease,tryAcquireWorkerLease} from './worker-lease.js';

export async function processQualificationReminders(now=new Date()){
  const rows=(await query<{tenant_id:string;qualification_id:string;employee_id:string;employee_name:string;code:string;name:string;valid_until:string;days_left:number}>(
    `SELECT q.tenant_id,q.id qualification_id,q.employee_id,e.name employee_name,q.code,
      COALESCE(c.name,q.code) name,q.valid_until,
      (q.valid_until-CURRENT_DATE)::integer days_left
     FROM employee_qualifications q JOIN employees e ON e.tenant_id=q.tenant_id AND e.id=q.employee_id
     LEFT JOIN qualification_catalog c ON c.tenant_id=q.tenant_id AND c.code=q.code
     JOIN qualification_reminder_settings s ON s.tenant_id=q.tenant_id
     WHERE q.valid_until IS NOT NULL AND q.status='valid'
       AND (q.valid_until-CURRENT_DATE)=ANY(s.reminder_days)`,[])).rows;
  for(const row of rows){
    const eventKey=`qualification-expiry:${row.qualification_id}:${row.days_left}:${new Date().toISOString().slice(0,10)}`;
    await queueNotificationEvent(row.tenant_id,'qualification.expiring',eventKey,'Qualifikation läuft ab',
      `${row.name} von ${row.employee_name} läuft in ${row.days_left} Tagen ab.`, 'employee_qualification',row.qualification_id);
    await recordAudit(row.tenant_id,null,'qualification.reminder.queued','employee_qualification',row.qualification_id,{days_left:row.days_left,run_at:now.toISOString()});
  }
  return {queued:rows.length};
}

let timer:NodeJS.Timeout|undefined;
export function startQualificationReminderWorker(intervalMs=86400000){
  if(timer)return stopQualificationReminderWorker;
  const tick=async()=>{if(!await tryAcquireWorkerLease('qualification-reminders-worker',Math.max(60000,intervalMs*2)))return;try{await processQualificationReminders();}catch{}finally{await releaseWorkerLease('qualification-reminders-worker');}};
  timer=setInterval(()=>{void tick();},intervalMs);
  void tick();
  timer.unref();
  return stopQualificationReminderWorker;
}
export function stopQualificationReminderWorker(){if(timer){clearInterval(timer);timer=undefined;}}
