import {Router} from 'express';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {query,withTransaction} from '../db/pool.js';
import {requireAuth,requireCsrf,requirePermission} from '../middleware/auth.js';
import {recordAudit} from '../services/audit.js';
import {encryptSecretPayload} from '../services/backup-domain.js';
import {checkPersistedProviderStatus,checkSmtpStatus,checkSmsStatus,checkTimeScanStatus} from '../services/provider-status.js';
import {applyRetention,runBackup,isBackupWorkerRunning} from '../services/backup.js';
import {env} from '../config/env.js';

const uuid=z.string().uuid();
const targetKind=z.enum(['local','smb','sftp','s3']);
const config=z.record(z.string(),z.union([z.string(),z.number(),z.boolean()])).default({});
const schedule=z.object({enabled:z.boolean(),schedule_kind:z.enum(['daily','weekly']),schedule_time:z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),schedule_weekday:z.number().int().min(0).max(6).nullable().optional(),schedule_timezone:z.string().min(1).max(80).default('UTC'),retention_count:z.number().int().positive().nullable().optional(),retention_days:z.number().int().positive().nullable().optional()}).strict();
const reason=z.string().trim().min(3).max(500);
const providerName=z.enum(['smtp','sms']);
function publicConfig(value:unknown){
  if(!value||typeof value!=='object'||Array.isArray(value))return {};
  return Object.fromEntries(Object.entries(value as Record<string,unknown>).filter(([key])=>!/(secret|password|token|private.?key|access.?key)/i.test(key)));
}
export const backupsRouter=Router();
backupsRouter.use((req,res,next)=>/^\/(backups|settings\/backups|settings\/providers|settings\/backup-notifications)/.test(req.path)?requireAuth(req,res,()=>['POST','PUT','PATCH','DELETE'].includes(req.method)?requireCsrf(req,res,next):next()):next());

backupsRouter.get('/backups/status',requirePermission('backup:read'),async(req,res,next)=>{
  try{
    const [settings,runs,targets]=await Promise.all([
      query('SELECT tenant_id,enabled,schedule_kind,schedule_time,schedule_weekday,schedule_timezone,retention_count,retention_days,last_run_at,last_success_at,last_status,updated_at FROM backup_settings WHERE tenant_id=$1',[req.user!.tenantId]),
      query(`SELECT id,started_at,completed_at,status,error_message,successful_targets,manifest FROM backup_runs WHERE tenant_id=$1 ORDER BY started_at DESC LIMIT 20`,[req.user!.tenantId]),
      query(`SELECT t.id,t.name,t.target_kind,t.config,t.secret_ref,t.enabled,t.created_at,t.updated_at,
        COALESCE((SELECT tr.status FROM backup_target_runs tr WHERE tr.tenant_id=t.tenant_id AND tr.target_id=t.id ORDER BY tr.uploaded_at DESC NULLS LAST LIMIT 1),'never') AS last_status
        FROM backup_targets t WHERE t.tenant_id=$1 ORDER BY t.created_at`,[req.user!.tenantId]),
    ]);
    res.json({worker:{running:isBackupWorkerRunning()},settings:settings.rows[0]??null,runs:runs.rows,targets:targets.rows.map(target=>({...target,config:publicConfig(target.config)}))});
  }catch(error){next(error);}
});

backupsRouter.get('/settings/backups',requirePermission('settings:read'),async(req,res,next)=>{
  try{res.json((await query('SELECT tenant_id,enabled,schedule_kind,schedule_time,schedule_weekday,schedule_timezone,retention_count,retention_days,last_run_at,last_success_at,last_status,updated_at FROM backup_settings WHERE tenant_id=$1',[req.user!.tenantId])).rows[0]??null);}catch(error){next(error);}
});

backupsRouter.put('/settings/backups',requirePermission('settings:write'),async(req,res,next)=>{
  try{
    const body=schedule.extend({reason}).parse(req.body);
    if(body.schedule_kind==='weekly'&&body.schedule_weekday===null)throw Object.assign(new Error('schedule_weekday ist für wöchentliche Zeitpläne erforderlich'),{status:400});
    const row=(await query(`INSERT INTO backup_settings(tenant_id,enabled,schedule_kind,schedule_time,schedule_weekday,schedule_timezone,retention_count,retention_days,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT(tenant_id) DO UPDATE SET enabled=EXCLUDED.enabled,schedule_kind=EXCLUDED.schedule_kind,schedule_time=EXCLUDED.schedule_time,schedule_weekday=EXCLUDED.schedule_weekday,schedule_timezone=EXCLUDED.schedule_timezone,retention_count=EXCLUDED.retention_count,retention_days=EXCLUDED.retention_days,updated_by=EXCLUDED.updated_by,updated_at=now()
      RETURNING tenant_id,enabled,schedule_kind,schedule_time,schedule_weekday,schedule_timezone,retention_count,retention_days,last_run_at,last_success_at,last_status,updated_at`,
      [req.user!.tenantId,body.enabled,body.schedule_kind,body.schedule_time,body.schedule_weekday??null,body.schedule_timezone,body.retention_count??null,body.retention_days??null,req.user!.id])).rows[0];
    await recordAudit(req.user!.tenantId,req.user!.id,'backup.settings.updated','backup_settings',req.user!.tenantId,{reason:body.reason,schedule_kind:body.schedule_kind,enabled:body.enabled,retention_count:body.retention_count??null,retention_days:body.retention_days??null});
    res.json(row);
  }catch(error){next(error);}
});

backupsRouter.post('/backups/targets',requirePermission('backup:manage'),async(req,res,next)=>{
  try{
    const body=z.object({name:z.string().trim().min(1).max(160),target_kind:targetKind,config,secret:z.record(z.string(),z.string()).optional(),secret_ref:z.string().trim().min(1).max(240).optional(),enabled:z.boolean().default(true),reason}).strict().parse(req.body);
    if(body.target_kind!=='local'&&!body.secret&&!body.secret_ref)throw Object.assign(new Error('Ein Geheimniswert oder eine Geheimnisreferenz ist erforderlich'),{status:400});
    const encryptedSecret=body.secret?encryptSecretPayload(body.secret,env.BACKUP_SECRET_KEY??''):null;
    const id=randomUUID();
    const row=(await query(`INSERT INTO backup_targets(id,tenant_id,name,target_kind,config,encrypted_secret,secret_ref,enabled,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,name,target_kind,config,secret_ref,enabled,created_at,updated_at`,
      [id,req.user!.tenantId,body.name,body.target_kind,body.config,encryptedSecret,body.secret_ref??null,body.enabled,req.user!.id])).rows[0];
    await recordAudit(req.user!.tenantId,req.user!.id,'backup.target.created','backup_target',id,{reason:body.reason,target_kind:body.target_kind,name:body.name});
    res.status(201).json({...row,config:publicConfig(row.config)});
  }catch(error){next(error);}
});

backupsRouter.patch('/backups/targets/:id',requirePermission('backup:manage'),async(req,res,next)=>{
  try{
    const body=z.object({name:z.string().trim().min(1).max(160).optional(),config:config.optional(),secret:z.record(z.string(),z.string()).optional(),secret_ref:z.string().trim().min(1).max(240).nullable().optional(),enabled:z.boolean().optional(),reason}).strict().parse(req.body);
    const targetId=String(req.params.id);
    const current=(await query('SELECT * FROM backup_targets WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,targetId])).rows[0];
    if(!current)return res.status(404).json({error:'Sicherungsziel nicht gefunden'});
    const values={name:body.name??current.name,config:body.config??current.config,encrypted_secret:body.secret?encryptSecretPayload(body.secret,env.BACKUP_SECRET_KEY??''):current.encrypted_secret,secret_ref:body.secret_ref===undefined?current.secret_ref:body.secret_ref,enabled:body.enabled===undefined?current.enabled:body.enabled};
    const row=(await query(`UPDATE backup_targets SET name=$3,config=$4,encrypted_secret=$5,secret_ref=$6,enabled=$7,updated_at=now() WHERE tenant_id=$1 AND id=$2
      RETURNING id,name,target_kind,config,secret_ref,enabled,created_at,updated_at`,[req.user!.tenantId,targetId,values.name,values.config,values.encrypted_secret,values.secret_ref,values.enabled])).rows[0];
    await recordAudit(req.user!.tenantId,req.user!.id,'backup.target.updated','backup_target',targetId,{reason:body.reason,name:values.name,enabled:values.enabled,secret_changed:Boolean(body.secret||body.secret_ref)});
    res.json({...row,config:publicConfig(row.config)});
  }catch(error){next(error);}
});

backupsRouter.delete('/backups/targets/:id',requirePermission('backup:manage'),async(req,res,next)=>{
  try{
    const body=z.object({reason}).strict().parse(req.body);
    const targetId=String(req.params.id);
    const result=await query('DELETE FROM backup_targets WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,targetId]);
    if(!result.rowCount)return res.status(404).json({error:'Sicherungsziel nicht gefunden'});
    await recordAudit(req.user!.tenantId,req.user!.id,'backup.target.deleted','backup_target',targetId,{reason:body.reason});
    res.status(204).send();
  }catch(error){next(error);}
});

backupsRouter.post('/backups/run',requirePermission('backup:manage'),async(req,res,next)=>{
  try{const result=await runBackup(req.user!.tenantId,req.user!.id);res.status(201).json(result);}catch(error){next(error);}
});

backupsRouter.post('/backups/retention',requirePermission('backup:manage'),async(req,res,next)=>{
  try{const body=z.object({reason}).strict().parse(req.body);const result=await applyRetention(req.user!.tenantId,req.user!.id);await recordAudit(req.user!.tenantId,req.user!.id,'backup.retention.requested','backup_settings',req.user!.tenantId,{reason:body.reason});res.json(result);}catch(error){next(error);}
});

backupsRouter.get('/settings/providers',requirePermission('settings:read'),async(req,res,next)=>{
  try{
    const rows=(await query('SELECT provider,config,secret_ref,enabled,updated_at FROM provider_settings WHERE tenant_id=$1 ORDER BY provider',[req.user!.tenantId])).rows.map(row=>({provider:row.provider,config:publicConfig(row.config),secret_ref:row.secret_ref??null,enabled:row.enabled,updated_at:row.updated_at}));
    const timescan=(await query('SELECT base_url,account_ref,secret_ref,enabled,last_sync_at FROM timescan_connections WHERE tenant_id=$1',[req.user!.tenantId])).rows[0]??null;
    res.json({providers:rows,timescan});
  }catch(error){next(error);}
});

backupsRouter.put('/settings/providers/:provider',requirePermission('settings:write'),async(req,res,next)=>{
  try{
    const provider=providerName.parse(req.params.provider);
    const body=z.object({config,secret:z.record(z.string(),z.string()).optional(),secret_ref:z.string().trim().min(1).max(240).optional(),enabled:z.boolean().default(true),reason}).strict().parse(req.body);
    if(provider==='sms'&&!body.secret_ref&&!body.secret)throw Object.assign(new Error('SMS-Einstellungen erfordern ein Geheimnis oder secret_ref'),{status:400});
    const encrypted=body.secret?encryptSecretPayload(body.secret,env.BACKUP_SECRET_KEY??''):null;
    const row=(await query(`INSERT INTO provider_settings(tenant_id,provider,config,encrypted_secret,secret_ref,enabled,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(tenant_id,provider) DO UPDATE SET config=EXCLUDED.config,encrypted_secret=COALESCE(EXCLUDED.encrypted_secret,provider_settings.encrypted_secret),secret_ref=EXCLUDED.secret_ref,enabled=EXCLUDED.enabled,updated_by=EXCLUDED.updated_by,updated_at=now()
      RETURNING provider,config,secret_ref,enabled,updated_at`,[req.user!.tenantId,provider,body.config,encrypted,body.secret_ref??null,body.enabled,req.user!.id])).rows[0];
    await recordAudit(req.user!.tenantId,req.user!.id,'provider.settings.updated','provider',provider,{reason:body.reason,provider,enabled:body.enabled,secret_changed:Boolean(body.secret||body.secret_ref),config_keys:Object.keys(body.config)});
    res.json({...row,config:publicConfig(row.config)});
  }catch(error){next(error);}
});

backupsRouter.get('/settings/providers/status',requirePermission('settings:read'),async(req,res,next)=>{
  try{
    const rows=(await query('SELECT provider,config,secret_ref,enabled FROM provider_settings WHERE tenant_id=$1',[req.user!.tenantId])).rows as Array<{provider:'smtp'|'sms';config:Record<string,unknown>;secret_ref:string|null;enabled:boolean}>;
    const timescan=(await query<{base_url:string;account_ref:string;secret_ref:string;enabled:boolean}>('SELECT base_url,account_ref,secret_ref,enabled FROM timescan_connections WHERE tenant_id=$1',[req.user!.tenantId])).rows[0];
    const persisted=new Map(rows.map(row=>[row.provider,row]));
    const providers=await Promise.all([
      persisted.has('smtp')?checkPersistedProviderStatus(persisted.get('smtp')):checkSmtpStatus(),
      persisted.has('sms')?checkPersistedProviderStatus(persisted.get('sms')):checkSmsStatus(),
      checkTimeScanStatus(timescan),
    ]);
    res.json({providers});
  }catch(error){next(error);}
});

backupsRouter.get('/settings/backup-notifications',requirePermission('settings:read'),async(req,res,next)=>{
  try{
    const rows=(await query(`SELECT id,role,user_id,event_type,channel,recipient,enabled FROM notification_subscriptions
      WHERE tenant_id=$1 AND event_type IN ('backup.failed','backup.succeeded') ORDER BY event_type,channel,role,user_id`,[req.user!.tenantId])).rows;
    res.json(rows);
  }catch(error){next(error);}
});

backupsRouter.put('/settings/backup-notifications',requirePermission('settings:write'),async(req,res,next)=>{
  try{
    const body=z.object({
      event_type:z.enum(['backup.failed','backup.succeeded']),
      role:z.enum(['admin','operator','viewer']).optional(),
      user_id:uuid.optional(),
      channel:z.enum(['email','sms','in_app']),
      recipient:z.string().trim().max(320).optional(),
      enabled:z.boolean().default(true),
      reason,
    }).strict().refine(value=>Boolean(value.role||value.user_id),{message:'Rolle oder Benutzer ist erforderlich'}).refine(value=>value.channel==='in_app'||Boolean(value.recipient),{message:'Empfänger ist für E-Mail oder SMS erforderlich'});
    const value=body.parse(req.body);
    const lockKey=`backup-notification:${req.user!.tenantId}:${value.event_type}:${value.channel}:${value.user_id??''}:${value.role??''}`;
    const row=await withTransaction(async client=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)',[lockKey]);
      const existing=(await client.query<{id:string}>(
        `SELECT id FROM notification_subscriptions
         WHERE tenant_id=$1 AND event_type=$2 AND channel=$3
           AND user_id IS NOT DISTINCT FROM $4 AND role IS NOT DISTINCT FROM $5`,
        [req.user!.tenantId,value.event_type,value.channel,value.user_id??null,value.role??null],
      )).rows[0];
      if(existing)return (await client.query(
        `UPDATE notification_subscriptions SET recipient=$3,enabled=$4
         WHERE tenant_id=$1 AND id=$2 RETURNING id,role,user_id,event_type,channel,recipient,enabled`,
        [req.user!.tenantId,existing.id,value.recipient??null,value.enabled],
      )).rows[0];
      return (await client.query(
        `INSERT INTO notification_subscriptions(tenant_id,user_id,role,event_type,channel,recipient,enabled)
         VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,role,user_id,event_type,channel,recipient,enabled`,
        [req.user!.tenantId,value.user_id??null,value.role??null,value.event_type,value.channel,value.recipient??null,value.enabled],
      )).rows[0];
    });
    await recordAudit(req.user!.tenantId,req.user!.id,'backup.notification_rule.updated','notification_subscription',row.id,{reason:value.reason,event_type:value.event_type,channel:value.channel,role:value.role??null,user_id:value.user_id??null,enabled:value.enabled});
    res.json(row);
  }catch(error){next(error);}
});
