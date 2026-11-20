import {Router} from 'express';
import {z} from 'zod';
import {query} from '../db/pool.js';
import {requireAuth,requireCsrf,requirePermission} from '../middleware/auth.js';
import {recordAudit} from '../services/audit.js';
import {acknowledgeForwardingDelivery,encryptSecretPayload} from '../services/external-forwarding.js';
import {env} from '../config/env.js';

const uuid=z.string().uuid();const nonempty=z.string().trim().min(1);
const channel=z.enum(['webhook','email','sms']);
const reason=z.string().trim().min(3).max(500);
export const alarmForwardingRouter=Router();
alarmForwardingRouter.use((req,res,next)=>/^\/alarm-forwarding/.test(req.path)?requireAuth(req,res,()=>['POST','PUT','PATCH','DELETE'].includes(req.method)?requireCsrf(req,res,next):next()):next());

alarmForwardingRouter.get('/alarm-forwarding/destinations',requirePermission('alarm_forwarding:read'),async(req,res,next)=>{
  try{res.json((await query(`SELECT id,name,channel,endpoint,recipient,secret_ref,enabled,created_at,updated_at FROM alarm_forwarding_destinations WHERE tenant_id=$1 ORDER BY name`,[req.user!.tenantId])).rows);}catch(error){next(error);}
});
alarmForwardingRouter.post('/alarm-forwarding/destinations',requirePermission('alarm_forwarding:write'),async(req,res,next)=>{
  try{
    const body=z.object({name:nonempty.max(160),channel,endpoint:z.string().url().optional(),recipient:z.string().trim().max(320).optional(),secret:z.record(z.string(),z.string()).optional(),secret_ref:nonempty.max(240).optional(),enabled:z.boolean().default(true),reason}).strict().parse(req.body);
    if(body.channel==='webhook'&&!body.endpoint)throw Object.assign(new Error('Webhook endpoint is required'),{status:400});
    if(body.channel!=='webhook'&&!body.recipient)throw Object.assign(new Error('Recipient is required'),{status:400});
    if(body.channel==='webhook'&&!body.secret&&!body.secret_ref)throw Object.assign(new Error('Webhook secret or secret_ref is required'),{status:400});
    const encrypted=body.secret?encryptSecretPayload(body.secret,env.BACKUP_SECRET_KEY??''):null;
    const row=(await query(`INSERT INTO alarm_forwarding_destinations(tenant_id,name,channel,endpoint,recipient,secret_ref,encrypted_secret,enabled,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,name,channel,endpoint,recipient,secret_ref,enabled,created_at,updated_at`,
      [req.user!.tenantId,body.name,body.channel,body.endpoint??null,body.recipient??null,body.secret_ref??null,encrypted,body.enabled,req.user!.id])).rows[0];
    await recordAudit(req.user!.tenantId,req.user!.id,'alarm.forwarding.destination.created','alarm_forwarding_destination',row.id,{reason:body.reason,channel:body.channel,name:body.name,secret_configured:Boolean(body.secret||body.secret_ref)});
    res.status(201).json(row);
  }catch(error){next(error);}
});
alarmForwardingRouter.patch('/alarm-forwarding/destinations/:id',requirePermission('alarm_forwarding:write'),async(req,res,next)=>{
  try{const id=String(req.params.id);const body=z.object({name:nonempty.max(160).optional(),endpoint:z.string().url().nullable().optional(),recipient:z.string().trim().max(320).nullable().optional(),secret: z.record(z.string(),z.string()).optional(),secret_ref:nonempty.max(240).nullable().optional(),enabled:z.boolean().optional(),reason}).strict().parse(req.body);const current=(await query('SELECT * FROM alarm_forwarding_destinations WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,id])).rows[0];if(!current)return res.status(404).json({error:'Forwarding destination not found'});const encrypted=body.secret?encryptSecretPayload(body.secret,env.BACKUP_SECRET_KEY??''):current.encrypted_secret;const row=(await query(`UPDATE alarm_forwarding_destinations SET name=COALESCE($3,name),endpoint=COALESCE($4,endpoint),recipient=COALESCE($5,recipient),secret_ref=$6,encrypted_secret=$7,enabled=COALESCE($8,enabled),updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING id,name,channel,endpoint,recipient,secret_ref,enabled`,[req.user!.tenantId,id,body.name??null,body.endpoint??null,body.recipient??null,body.secret_ref===undefined?current.secret_ref:body.secret_ref,encrypted,body.enabled??null])).rows[0];await recordAudit(req.user!.tenantId,req.user!.id,'alarm.forwarding.destination.updated','alarm_forwarding_destination',id,{reason:body.reason,secret_changed:Boolean(body.secret||body.secret_ref)});res.json(row);}catch(error){next(error);}
});
alarmForwardingRouter.delete('/alarm-forwarding/destinations/:id',requirePermission('alarm_forwarding:write'),async(req,res,next)=>{
  try{const id=String(req.params.id);const body=z.object({reason}).strict().parse(req.body);const result=await query('DELETE FROM alarm_forwarding_destinations WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,id]);if(!result.rowCount)return res.status(404).json({error:'Forwarding destination not found'});await recordAudit(req.user!.tenantId,req.user!.id,'alarm.forwarding.destination.deleted','alarm_forwarding_destination',id,{reason:body.reason});res.status(204).send();}catch(error){next(error);}
});
alarmForwardingRouter.get('/alarm-forwarding/rules',requirePermission('alarm_forwarding:read'),async(req,res,next)=>{
  try{res.json((await query(`SELECT r.id,r.name,r.alarm_type,r.priority_code,r.destination_id,r.enabled,r.max_attempts,d.name destination_name,d.channel
    FROM alarm_forwarding_rules r JOIN alarm_forwarding_destinations d ON d.tenant_id=r.tenant_id AND d.id=r.destination_id
    WHERE r.tenant_id=$1 ORDER BY r.name`,[req.user!.tenantId])).rows);}catch(error){next(error);}
});
alarmForwardingRouter.post('/alarm-forwarding/rules',requirePermission('alarm_forwarding:write'),async(req,res,next)=>{
  try{
    const body=z.object({name:nonempty.max(160),alarm_type:nonempty.optional(),priority_code:z.enum(['critical','high','medium','low']).optional(),destination_id:uuid,enabled:z.boolean().default(true),max_attempts:z.number().int().min(1).max(10).default(5),reason}).strict().refine(value=>Boolean(value.alarm_type||value.priority_code),{message:'Alarm type or priority is required'}).parse(req.body);
    const row=(await query(`INSERT INTO alarm_forwarding_rules(tenant_id,name,alarm_type,priority_code,destination_id,enabled,max_attempts,created_by)
      SELECT $1,$2,$3,$4,id,$5,$6,$7 FROM alarm_forwarding_destinations WHERE tenant_id=$1 AND id=$8
      RETURNING id,name,alarm_type,priority_code,destination_id,enabled,max_attempts`,
      [req.user!.tenantId,body.name,body.alarm_type??null,body.priority_code??null,body.enabled,body.max_attempts,req.user!.id,body.destination_id])).rows[0];
    if(!row)return res.status(404).json({error:'Forwarding destination not found'});
    await recordAudit(req.user!.tenantId,req.user!.id,'alarm.forwarding.rule.created','alarm_forwarding_rule',row.id,{reason:body.reason,alarm_type:body.alarm_type??null,priority_code:body.priority_code??null,destination_id:body.destination_id});
    res.status(201).json(row);
  }catch(error){next(error);}
});
alarmForwardingRouter.patch('/alarm-forwarding/rules/:id',requirePermission('alarm_forwarding:write'),async(req,res,next)=>{
  try{const id=String(req.params.id);const body=z.object({name:nonempty.max(160).optional(),alarm_type:nonempty.nullable().optional(),priority_code:z.enum(['critical','high','medium','low']).nullable().optional(),destination_id:uuid.optional(),enabled:z.boolean().optional(),max_attempts:z.number().int().min(1).max(10).optional(),reason}).strict().parse(req.body);const row=(await query(`UPDATE alarm_forwarding_rules r SET name=COALESCE($3,r.name),alarm_type=COALESCE($4,r.alarm_type),priority_code=COALESCE($5,r.priority_code),destination_id=COALESCE((SELECT id FROM alarm_forwarding_destinations WHERE tenant_id=$1 AND id=$6),r.destination_id),enabled=COALESCE($7,r.enabled),max_attempts=COALESCE($8,r.max_attempts) WHERE r.tenant_id=$1 AND r.id=$2 RETURNING r.id,r.name,r.alarm_type,r.priority_code,r.destination_id,r.enabled,r.max_attempts`,[req.user!.tenantId,id,body.name??null,body.alarm_type??null,body.priority_code??null,body.destination_id??null,body.enabled??null,body.max_attempts??null])).rows[0];if(!row)return res.status(404).json({error:'Forwarding rule not found'});await recordAudit(req.user!.tenantId,req.user!.id,'alarm.forwarding.rule.updated','alarm_forwarding_rule',id,{reason:body.reason});res.json(row);}catch(error){next(error);}
});
alarmForwardingRouter.delete('/alarm-forwarding/rules/:id',requirePermission('alarm_forwarding:write'),async(req,res,next)=>{
  try{const id=String(req.params.id);const body=z.object({reason}).strict().parse(req.body);const result=await query('DELETE FROM alarm_forwarding_rules WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,id]);if(!result.rowCount)return res.status(404).json({error:'Forwarding rule not found'});await recordAudit(req.user!.tenantId,req.user!.id,'alarm.forwarding.rule.deleted','alarm_forwarding_rule',id,{reason:body.reason});res.status(204).send();}catch(error){next(error);}
});
alarmForwardingRouter.get('/alarm-forwarding/deliveries',requirePermission('alarm_forwarding:read'),async(req,res,next)=>{
  try{res.json((await query(`SELECT f.id,f.alarm_id,f.rule_id,f.destination_id,f.status,f.attempts,f.last_error,f.forwarded_at,f.acknowledged_at,f.created_at,d.name destination_name
    FROM alarm_forwarding_deliveries f JOIN alarm_forwarding_destinations d ON d.tenant_id=f.tenant_id AND d.id=f.destination_id
    WHERE f.tenant_id=$1 ORDER BY f.created_at DESC LIMIT 200`,[req.user!.tenantId])).rows);}catch(error){next(error);}
});
alarmForwardingRouter.post('/alarm-forwarding/deliveries/:id/acknowledge',requirePermission('alarm_forwarding:write'),async(req,res,next)=>{
  try{const row=await acknowledgeForwardingDelivery(req.user!.tenantId,String(req.params.id),req.user!.id);if(!row)return res.status(404).json({error:'Forwarding delivery not found or not forwarded'});res.json(row);}catch(error){next(error);}
});
