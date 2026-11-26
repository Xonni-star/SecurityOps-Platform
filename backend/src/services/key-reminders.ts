import {query,withTenantContext} from '../db/pool.js';
import {env} from '../config/env.js';
import {queueNotificationEvent} from './notifications.js';
import {recordAudit} from './audit.js';
import {releaseWorkerLease,tryAcquireWorkerLease} from './worker-lease.js';

type DueKey={tenant_id:string;id:string;key_code:string;label:string;due_at:string|Date;holder_name:string|null};

export async function processKeyReminders(now=new Date()){
  const rows=(await query<DueKey>(
    `SELECT k.tenant_id,k.id,k.key_code,k.label,k.due_at,
       COALESCE(u.email,e.name) holder_name
     FROM keys k
     LEFT JOIN users u ON u.tenant_id=k.tenant_id AND u.id=k.holder_user_id
     LEFT JOIN employees e ON e.tenant_id=k.tenant_id AND e.id=k.holder_employee_id
     WHERE k.status='issued' AND k.due_at IS NOT NULL`,
    [],
  )).rows;
  let queued=0;
  for(const row of rows){
    const due=new Date(row.due_at).getTime();
    if(!Number.isFinite(due))continue;
    const days=due<now.getTime()?-1:Math.ceil((due-now.getTime())/86_400_000);
    if(days!==-1&&!env.KEY_REMINDER_DAYS.includes(days))continue;
    const dueAt=new Date(due).toISOString();
    await withTenantContext(row.tenant_id,async()=>{
      const claim=await query(
        `INSERT INTO key_reminder_state(tenant_id,key_id,due_at,days)
         VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING key_id`,
        [row.tenant_id,row.id,dueAt,days],
      );
      if(!claim.rowCount)return;
      const eventKey=`keys-return-due:${row.id}:${days}:${dueAt}`;
      const title=days===-1?'Schlüsselrückgabe überfällig':`Schlüsselrückgabe in ${days} Tag${days===1?'':'en'}`;
      const body=`${row.label} (${row.key_code})${row.holder_name?` von ${row.holder_name}`:''}: ${days===-1?'Rückgabe ist überfällig.':`Rückgabe am ${dueAt.slice(0,10)} fällig.`}`;
      await queueNotificationEvent(row.tenant_id,'keys.return_due',eventKey,title,body,'key',row.id);
      await recordAudit(row.tenant_id,null,'keys.reminder.queued','key',row.id,{days,due_at:dueAt,run_at:now.toISOString()});
      queued++;
    });
  }
  return {queued};
}

let timer:NodeJS.Timeout|undefined;
export function startKeyReminderWorker(intervalMs=3600000){
  if(timer)return stopKeyReminderWorker;
  const tick=async()=>{if(!await tryAcquireWorkerLease('key-reminders-worker',Math.max(60000,intervalMs*2)))return;try{await processKeyReminders();}catch{}finally{await releaseWorkerLease('key-reminders-worker');}};
  timer=setInterval(()=>{void tick();},intervalMs);
  void tick();
  timer.unref();
  return stopKeyReminderWorker;
}
export function stopKeyReminderWorker(){if(timer){clearInterval(timer);timer=undefined;}}

export const keyQrSecret=()=>env.KEY_QR_SECRET??env.WATCHBOOK_HASH_SECRET??env.BACKUP_SECRET_KEY??'securityops-dev-key-qr-secret';
