import {query,withTenantContext} from '../db/pool.js';
import {logger} from '../middleware/errors.js';
import {publish} from './realtime.js';
import {recordAudit} from './audit.js';
import {queueNotificationEvent} from './notifications.js';
import {releaseWorkerLease,tryAcquireWorkerLease} from './worker-lease.js';

type EscalationCandidate={
  id:string;tenant_id:string;rule_id:string;rule_name:string;
  target_status:'escalated'|'acknowledged';notify_enabled:boolean;delay_seconds:number;
};

function safeError(error:unknown){return error instanceof Error?error.message:String(error);}

async function auditFailure(tenantId:string,eventType:string,error:unknown,alarmId?:string){
  try{
    await recordAudit(tenantId,null,eventType,'alarm',alarmId,{error:safeError(error),trigger:'automatic'});
  }catch(auditError){
    logger.error({event:'escalation.audit.failed',tenantId,error:safeError(auditError)},'Escalation audit failed');
  }
}

export async function checkEscalations(now=new Date()){
  const tenants=(await query<{id:string}>('SELECT id FROM tenants')).rows;
  let escalated=0;
  for(const tenant of tenants){
    try{
      escalated+=await withTenantContext(tenant.id,async()=>{
        const result=await query<EscalationCandidate>(
          `SELECT a.id,a.tenant_id,r.id rule_id,r.name rule_name,r.target_status,r.notify_enabled,r.delay_seconds
           FROM alarms a JOIN escalation_rules r ON r.tenant_id=a.tenant_id AND r.enabled=true
             AND (r.priority_id IS NULL OR r.priority_id=a.priority_id)
           WHERE a.status='open' AND a.triggered_at + make_interval(secs => r.delay_seconds) <= $1`,
          [now],
        );
        let count=0;
        for(const alarm of result.rows){
          try{
            const changed=(await query<{id:string}>(
              `UPDATE alarms SET status=$2,
                 escalated_at=CASE WHEN $2='escalated' THEN now() ELSE escalated_at END,
                 escalation_level=CASE WHEN $2='escalated' THEN escalation_level+1 ELSE escalation_level END,
                 acknowledged_at=CASE WHEN $2='acknowledged' THEN COALESCE(acknowledged_at,now()) ELSE acknowledged_at END,
                 updated_at=now()
               WHERE id=$1 AND status='open' RETURNING id`,
              [alarm.id,alarm.target_status],
            )).rowCount;
            if(!changed)continue;
            await query(
              `INSERT INTO alarm_history(alarm_id,tenant_id,from_status,to_status,note)
               VALUES($1,$2,'open',$3,$4)`,
              [alarm.id,alarm.tenant_id,alarm.target_status,`Automatische Eskalation (Regel: ${alarm.rule_name})`],
            );
            await query(
              `INSERT INTO escalation_log(tenant_id,alarm_id,rule_id,trigger,from_status,to_status,reason)
               VALUES($1,$2,$3,'automatic','open',$4,$5)`,
              [alarm.tenant_id,alarm.id,alarm.rule_id,alarm.target_status,
                `Automatische Eskalation nach ${alarm.delay_seconds} Sekunden`],
            );
            await recordAudit(alarm.tenant_id,null,'alarm.escalated','alarm',alarm.id,{
              rule_id:alarm.rule_id,rule_name:alarm.rule_name,target_status:alarm.target_status,
              notify_enabled:alarm.notify_enabled,trigger:'automatic',
            });
            if(alarm.notify_enabled){
              try{
                await queueNotificationEvent(
                  alarm.tenant_id,'alarm.escalated',`alarm:${alarm.id}:escalation:${alarm.rule_id}`,
                  'Alarm eskaliert',`Automatische Eskalation (Regel: ${alarm.rule_name})`,'alarm',alarm.id,
                );
              }catch(notificationError){
                logger.error({event:'alarm.escalation.notification.failed',alarmId:alarm.id,
                  error:safeError(notificationError)},'Escalation notification failed');
                await auditFailure(alarm.tenant_id,'alarm.escalation.notification.failed',notificationError,alarm.id);
              }
            }
            publish(alarm.tenant_id,'alarm.escalated',{
              id:alarm.id,
              rule:{id:alarm.rule_id,name:alarm.rule_name,target_status:alarm.target_status,
                notify_enabled:alarm.notify_enabled},
            });
            count++;
          }catch(error){
            logger.error({event:'alarm.escalation.failed',tenantId:tenant.id,alarmId:alarm.id,
              error:safeError(error)},'Automatic alarm escalation failed');
            await auditFailure(alarm.tenant_id,'alarm.escalation.failed',error,alarm.id);
          }
        }
        return count;
      });
    }catch(error){
      logger.error({event:'escalation.check.failed',tenantId:tenant.id,error:safeError(error)},
        'Automatic escalation check failed');
      await auditFailure(tenant.id,'escalation.check.failed',error);
    }
  }
  return escalated;
}

export function startEscalationWorker(){
  const timer=setInterval(()=>{
    void (async()=>{
      let acquired=false;
      try{
        acquired=await tryAcquireWorkerLease('escalation-worker',60000);
        if(!acquired)return;
        await checkEscalations();
      }catch(error){
        logger.error({event:'escalation.worker.failed',error:safeError(error)},'Escalation worker failed');
      }finally{
        if(acquired){
          try{await releaseWorkerLease('escalation-worker');}
          catch(error){logger.error({event:'escalation.lease.release.failed',error:safeError(error)},
            'Escalation worker lease release failed');}
        }
      }
    })();
  },30000);
  timer.unref();
  return timer;
}
