import nodemailer from 'nodemailer';
import {query,withTenantContext} from '../db/pool.js';
import {env} from '../config/env.js';
import {logger} from '../middleware/errors.js';
import {publish} from './realtime.js';

type Channel='email'|'sms';
type Delivery={id:string;tenant_id:string;channel:Channel;recipient:string;subject:string;body:string;attempts:number};
function safeDeliveryError(error:unknown){
  const message=error instanceof Error?error.message:'Delivery failed';
  return message.replace(/(authorization|password|token|secret)(\s*[:=]\s*)[^\s,;]+/gi,'$1$2[redacted]').slice(0,500);
}

export async function sendEmail(recipient:string,subject:string,body:string){
  if(!env.SMTP_HOST)throw new Error('SMTP_HOST is not configured');
  const transport=nodemailer.createTransport({
    host:env.SMTP_HOST,port:env.SMTP_PORT,secure:env.SMTP_PORT===465,
    auth:env.SMTP_USER?{user:env.SMTP_USER,password:env.SMTP_PASSWORD}:undefined,
  });
  await transport.sendMail({from:env.NOTIFICATION_FROM,to:recipient,subject,text:body});
}

export async function sendSms(recipient:string,body:string){
  if(!env.SMS_GATEWAY_URL)throw new Error('SMS_GATEWAY_URL is not configured');
  const response=await fetch(env.SMS_GATEWAY_URL,{
    method:'POST',
    headers:{'content-type':'application/json',...(env.SMS_GATEWAY_TOKEN?{authorization:`Bearer ${env.SMS_GATEWAY_TOKEN}`}:{})},
    body:JSON.stringify({to:recipient,message:body}),
  });
  if(!response.ok)throw new Error(`SMS gateway returned ${response.status}`);
}

export async function queueNotificationEvent(tenantId:string,eventType:string,eventKey:string,title:string,body:string,entityType?:string,entityId?:string){
  await withTenantContext(tenantId,async()=>{
   await query(
    `INSERT INTO notifications(tenant_id,user_id,event_type,title,body,entity_type,entity_id)
     SELECT DISTINCT ON (u.id) $1,u.id,$2,$3,$4,$5,$6
     FROM users u LEFT JOIN notification_subscriptions s
       ON s.tenant_id=$1 AND s.event_type=$2 AND s.enabled=true
       AND (s.user_id=u.id OR s.role=u.role)
     WHERE u.tenant_id=$1 AND s.id IS NOT NULL AND s.channel='in_app'
     ON CONFLICT DO NOTHING`,
    [tenantId,eventType,title,body,entityType??null,entityId??null],
   );
   await query(
    `INSERT INTO notification_deliveries(tenant_id,event_key,channel,recipient,subject,body)
     SELECT $1,$2,s.channel,COALESCE(s.recipient,u.email),$3,$4
     FROM notification_subscriptions s JOIN users u ON u.tenant_id=s.tenant_id
     WHERE s.tenant_id=$1 AND s.event_type=$5 AND s.enabled=true
       AND (s.user_id=u.id OR s.role=u.role) AND s.channel IN ('email','sms')
     ON CONFLICT(event_key,channel,recipient) DO NOTHING`,
    [tenantId,eventKey,'SecurityOps notification',body,eventType],
   );
  });
  publish(tenantId,'notification.created',{eventType,title,body},'notifications:read');
}

export async function processNotificationQueue(limit=20){
  const tenants=(await query<{id:string}>('SELECT id FROM tenants')).rows;
  for(const tenant of tenants)await withTenantContext(tenant.id,async()=>{
  const deliveries=(await query<Delivery>(
    `UPDATE notification_deliveries SET status='processing',attempts=attempts+1
     WHERE id IN (SELECT id FROM notification_deliveries
       WHERE status IN ('pending','failed') AND next_attempt_at<=now()
       ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED)
     RETURNING id,tenant_id,channel,recipient,subject,body,attempts`,
    [limit],
  )).rows;
  for(const delivery of deliveries){
    try{
      if(delivery.channel==='email')await sendEmail(delivery.recipient,delivery.subject,delivery.body);
      else await sendSms(delivery.recipient,delivery.body);
      await query(`UPDATE notification_deliveries SET status='sent',sent_at=now(),last_error=NULL WHERE id=$1`,[delivery.id]);
    }catch(error){
      const attempts=delivery.attempts;
      const terminal=attempts>=5;
      const safeError=safeDeliveryError(error);
      await query(
        `UPDATE notification_deliveries SET status=$1,last_error=$2,next_attempt_at=now()+($3 || ' seconds')::interval WHERE id=$4`,
        [terminal?'failed':'pending',safeError,Math.min(3600,2**attempts*30),delivery.id],
      );
      await query(
        `INSERT INTO audit_events(tenant_id,event_type,entity_type,entity_id,details)
         VALUES($1,'notification.delivery.failed','notification_delivery',$2,$3)`,
        [delivery.tenant_id,delivery.id,{channel:delivery.channel,attempts,error:safeError,retry_scheduled:!terminal}],
      );
      logger.error({deliveryId:delivery.id,error:safeError},'Notification delivery failed');
    }
  }
  });
}

export function startNotificationWorker(){
  const timer=setInterval(()=>{void processNotificationQueue().catch(error=>logger.error({error},'Notification worker failed'));},10000);
  timer.unref();
}
