import {encryptSecretPayload} from './backup-domain.js';
import {query} from '../db/pool.js';
import {recordAudit} from './audit.js';
import {sendEmail,sendSms} from './notifications.js';
import {resolveSecretPayload} from './secrets.js';

type Destination={id:string;tenant_id:string;channel:'webhook'|'email'|'sms';endpoint:string|null;recipient:string|null;secret_ref:string|null;encrypted_secret:string|null;enabled:boolean};
type Delivery={id:string;tenant_id:string;alarm_id:string;rule_id:string;destination_id:string;attempts:number;status:string;next_attempt_at:string;max_attempts:number};

function secret(destination:Destination):Promise<Record<string,string>|undefined>{
  return resolveSecretPayload(destination.secret_ref??undefined,destination.encrypted_secret);
}

let workerTimer:NodeJS.Timeout|undefined;
export async function processDueForwardingDeliveries(limit=50){
  const rows=(await query<Delivery>(`SELECT id,tenant_id,alarm_id,rule_id,destination_id,attempts,status,next_attempt_at
    FROM alarm_forwarding_deliveries WHERE status IN ('queued','retrying') AND next_attempt_at<=now() ORDER BY next_attempt_at LIMIT $1`,[limit])).rows;
  for(const row of rows)await processForwardingDelivery(row.id);
  return rows.length;
}
export function startForwardingWorker(intervalMs=10000){
  if(workerTimer)return stopForwardingWorker;
  workerTimer=setInterval(()=>{void processDueForwardingDeliveries().catch(()=>undefined);},intervalMs);
  void processDueForwardingDeliveries();
  return stopForwardingWorker;
}
export function stopForwardingWorker(){if(workerTimer){clearInterval(workerTimer);workerTimer=undefined;}}

function safeError(error:unknown){
  return (error instanceof Error?error.message:'Forwarding failed').replace(/(authorization|password|token|secret)(\s*[:=]\s*)[^\s,;]+/gi,'$1$2[redacted]').slice(0,500);
}

export async function queueAlarmForwarding(tenantId:string,alarmId:string){
  const matches=(await query<{
    rule_id:string;destination_id:string;destination_name:string;channel:'webhook'|'email'|'sms';
  }>(`SELECT r.id rule_id,d.id destination_id,d.name destination_name,d.channel
      FROM alarms a JOIN alarm_priorities p ON p.id=a.priority_id AND p.tenant_id=a.tenant_id
      JOIN alarm_forwarding_rules r ON r.tenant_id=a.tenant_id AND r.enabled=true
      JOIN alarm_forwarding_destinations d ON d.tenant_id=r.tenant_id AND d.id=r.destination_id AND d.enabled=true
      WHERE a.tenant_id=$1 AND a.id=$2 AND (r.alarm_type IS NULL OR r.alarm_type=a.type)
        AND (r.priority_code IS NULL OR r.priority_code=p.code)`,[tenantId,alarmId])).rows;
  for(const match of matches){
    const delivery=(await query<Delivery>(`INSERT INTO alarm_forwarding_deliveries(tenant_id,alarm_id,rule_id,destination_id)
      VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,alarm_id,destination_id) DO NOTHING
      RETURNING id,tenant_id,alarm_id,rule_id,destination_id,attempts,status,next_attempt_at`,
      [tenantId,alarmId,match.rule_id,match.destination_id])).rows[0];
    if(delivery){
      await recordAudit(tenantId,null,'alarm.forwarding.queued','alarm_forwarding_delivery',delivery.id,{alarm_id:alarmId,destination_id:match.destination_id,channel:match.channel});
      void processForwardingDelivery(delivery.id).catch(()=>undefined);
    }
  }
}

async function loadDelivery(id:string){
  return (await query<Delivery & Destination & {alarm_type:string;priority_code:string;description:string}>(
    `SELECT f.*,r.max_attempts,d.channel,d.endpoint,d.recipient,d.secret_ref,d.encrypted_secret,d.enabled,
      a.type alarm_type,p.code priority_code,a.description
     FROM alarm_forwarding_deliveries f
     JOIN alarm_forwarding_destinations d ON d.tenant_id=f.tenant_id AND d.id=f.destination_id
     JOIN alarms a ON a.tenant_id=f.tenant_id AND a.id=f.alarm_id
     LEFT JOIN alarm_priorities p ON p.tenant_id=a.tenant_id AND p.id=a.priority_id
     WHERE f.id=$1`,[id])).rows[0];
}

async function deliver(delivery:Awaited<ReturnType<typeof loadDelivery>>){
  if(!delivery||!delivery.enabled)throw new Error('Forwarding destination is disabled');
  const payload=JSON.stringify({alarm_id:delivery.alarm_id,type:delivery.alarm_type,priority:delivery.priority_code,description:delivery.description});
  const configured=await secret(delivery);
  if(delivery.channel==='webhook'){
    if(!delivery.endpoint)throw new Error('Webhook endpoint is not configured');
    const token= configured?.token??configured?.value;
    const response=await fetch(delivery.endpoint,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},body:payload,signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new Error(`Webhook returned ${response.status}`);
    return response.headers.get('x-request-id')??undefined;
  }
  if(!delivery.recipient)throw new Error('Forwarding recipient is not configured');
  if(delivery.channel==='email'){await sendEmail(delivery.recipient,'SecurityOps Alarm',`Alarm ${delivery.alarm_id} (${delivery.priority_code}) wurde weitergeleitet.`);return undefined;}
  await sendSms(delivery.recipient,`SecurityOps Alarm ${delivery.priority_code}: ${delivery.alarm_id}`);return undefined;
}

export async function processForwardingDelivery(id:string){
  const delivery=await loadDelivery(id);if(!delivery)return;
  const attempts=delivery.attempts+1;
  await query(`UPDATE alarm_forwarding_deliveries SET status='retrying',attempts=$2,updated_at=now() WHERE id=$1`,[id,attempts]);
  try{
    if(delivery.status==='forwarded'||delivery.status==='acknowledged')return;
    const reference=await deliver(delivery);
    await query(`UPDATE alarm_forwarding_deliveries SET status='forwarded',provider_reference=$2,forwarded_at=now(),updated_at=now(),last_error=NULL WHERE id=$1`,[id,reference??null]);
    await recordAudit(delivery.tenant_id,null,'alarm.forwarding.forwarded','alarm_forwarding_delivery',id,{alarm_id:delivery.alarm_id,attempts});
  }catch(error){
    const message=safeError(error);const terminal=attempts>=delivery.max_attempts;
    await query(`UPDATE alarm_forwarding_deliveries SET status=$2,last_error=$3,next_attempt_at=now()+($4 || ' seconds')::interval,updated_at=now() WHERE id=$1`,[id,terminal?'exhausted':'retrying',message,Math.min(3600,30*2**(attempts-1))]);
    await recordAudit(delivery.tenant_id,null,'alarm.forwarding.failed','alarm_forwarding_delivery',id,{alarm_id:delivery.alarm_id,attempts,error:message,retry_scheduled:!terminal});
  }
}

export async function acknowledgeForwardingDelivery(tenantId:string,id:string,actorUserId:string){
  const row=(await query(`UPDATE alarm_forwarding_deliveries SET status='acknowledged',acknowledged_at=now(),updated_at=now()
    WHERE tenant_id=$1 AND id=$2 AND status='forwarded' RETURNING id,alarm_id,destination_id`,[tenantId,id])).rows[0];
  if(!row)return null;
  await recordAudit(tenantId,actorUserId,'alarm.forwarding.acknowledged','alarm_forwarding_delivery',id,{alarm_id:row.alarm_id,destination_id:row.destination_id});
  return row;
}

export {encryptSecretPayload};
