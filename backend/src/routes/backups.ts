import {Router} from 'express';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {query} from '../db/pool.js';
import {requireAuth,requireCsrf,requirePermission} from '../middleware/auth.js';
import {recordAudit} from '../services/audit.js';
import {encryptSecretPayload} from '../services/backup-domain.js';
import {applyRetention,runBackup,isBackupWorkerRunning} from '../services/backup.js';
import {env} from '../config/env.js';

const uuid=z.string().uuid();
const targetKind=z.enum(['local','smb','ftp','ftps','sftp','s3']);
const config=z.record(z.string(),z.union([z.string(),z.number(),z.boolean()])).default({});
const schedule=z.object({enabled:z.boolean(),schedule_kind:z.enum(['daily','weekly']),schedule_time:z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),schedule_weekday:z.number().int().min(0).max(6).nullable().optional(),schedule_timezone:z.string().min(1).max(80).default('UTC'),retention_count:z.number().int().positive().nullable().optional(),retention_days:z.number().int().positive().nullable().optional()}).strict();
export const backupsRouter=Router();
backupsRouter.use((req,res,next)=>/^\/(backups|settings\/backups)/.test(req.path)?requireAuth(req,res,()=>['POST','PUT','PATCH','DELETE'].includes(req.method)?requireCsrf(req,res,next):next()):next());

backupsRouter.get('/backups/status',requirePermission('backup:read'),async(req,res,next)=>{
  try{
    const [settings,runs,targets]=await Promise.all([
      query('SELECT tenant_id,enabled,schedule_kind,schedule_time,schedule_weekday,schedule_timezone,retention_count,retention_days,last_run_at,last_success_at,last_status,updated_at FROM backup_settings WHERE tenant_id=$1',[req.user!.tenantId]),
      query(`SELECT id,started_at,completed_at,status,error_message,successful_targets,manifest FROM backup_runs WHERE tenant_id=$1 ORDER BY started_at DESC LIMIT 20`,[req.user!.tenantId]),
      query(`SELECT id,name,target_kind,config,secret_ref,enabled,created_at,updated_at FROM backup_targets WHERE tenant_id=$1 ORDER BY created_at`,[req.user!.tenantId]),
    ]);
    res.json({worker:{running:isBackupWorkerRunning()},settings:settings.rows[0]??null,runs:runs.rows,targets:targets.rows});
  }catch(error){next(error);}
});

backupsRouter.get('/settings/backups',requirePermission('settings:read'),async(req,res,next)=>{
  try{res.json((await query('SELECT tenant_id,enabled,schedule_kind,schedule_time,schedule_weekday,schedule_timezone,retention_count,retention_days,last_run_at,last_success_at,last_status,updated_at FROM backup_settings WHERE tenant_id=$1',[req.user!.tenantId])).rows[0]??null);}catch(error){next(error);}
});

backupsRouter.put('/settings/backups',requirePermission('settings:write'),async(req,res,next)=>{
  try{
    const body=schedule.parse(req.body);
    if(body.schedule_kind==='weekly'&&body.schedule_weekday===null)throw Object.assign(new Error('schedule_weekday is required for weekly schedules'),{status:400});
    const row=(await query(`INSERT INTO backup_settings(tenant_id,enabled,schedule_kind,schedule_time,schedule_weekday,schedule_timezone,retention_count,retention_days,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT(tenant_id) DO UPDATE SET enabled=EXCLUDED.enabled,schedule_kind=EXCLUDED.schedule_kind,schedule_time=EXCLUDED.schedule_time,schedule_weekday=EXCLUDED.schedule_weekday,schedule_timezone=EXCLUDED.schedule_timezone,retention_count=EXCLUDED.retention_count,retention_days=EXCLUDED.retention_days,updated_by=EXCLUDED.updated_by,updated_at=now()
      RETURNING tenant_id,enabled,schedule_kind,schedule_time,schedule_weekday,schedule_timezone,retention_count,retention_days,last_run_at,last_success_at,last_status,updated_at`,
      [req.user!.tenantId,body.enabled,body.schedule_kind,body.schedule_time,body.schedule_weekday??null,body.schedule_timezone,body.retention_count??null,body.retention_days??null,req.user!.id])).rows[0];
    await recordAudit(req.user!.tenantId,req.user!.id,'backup.settings.updated','backup_settings',req.user!.tenantId,{schedule_kind:body.schedule_kind,enabled:body.enabled});
    res.json(row);
  }catch(error){next(error);}
});

backupsRouter.post('/backups/targets',requirePermission('backup:manage'),async(req,res,next)=>{
  try{
    const body=z.object({name:z.string().trim().min(1).max(160),target_kind:targetKind,config,secret:z.record(z.string(),z.string()).optional(),secret_ref:z.string().trim().min(1).max(240).optional(),enabled:z.boolean().default(true)}).strict().parse(req.body);
    if(body.target_kind!=='local'&&!body.secret&&!body.secret_ref)throw Object.assign(new Error('A secret payload or secret reference is required'),{status:400});
    const encryptedSecret=body.secret?encryptSecretPayload(body.secret,env.BACKUP_SECRET_KEY??''):null;
    const id=randomUUID();
    const row=(await query(`INSERT INTO backup_targets(id,tenant_id,name,target_kind,config,encrypted_secret,secret_ref,enabled,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,name,target_kind,config,secret_ref,enabled,created_at,updated_at`,
      [id,req.user!.tenantId,body.name,body.target_kind,body.config,encryptedSecret,body.secret_ref??null,body.enabled,req.user!.id])).rows[0];
    await recordAudit(req.user!.tenantId,req.user!.id,'backup.target.created','backup_target',id,{target_kind:body.target_kind,name:body.name});
    res.status(201).json(row);
  }catch(error){next(error);}
});

backupsRouter.patch('/backups/targets/:id',requirePermission('backup:manage'),async(req,res,next)=>{
  try{
    const body=z.object({name:z.string().trim().min(1).max(160).optional(),config:config.optional(),secret:z.record(z.string(),z.string()).optional(),secret_ref:z.string().trim().min(1).max(240).nullable().optional(),enabled:z.boolean().optional()}).strict().parse(req.body);
    const targetId=String(req.params.id);
    const current=(await query('SELECT * FROM backup_targets WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,targetId])).rows[0];
    if(!current)return res.status(404).json({error:'Backup target not found'});
    const values={name:body.name??current.name,config:body.config??current.config,encrypted_secret:body.secret?encryptSecretPayload(body.secret,env.BACKUP_SECRET_KEY??''):current.encrypted_secret,secret_ref:body.secret_ref===undefined?current.secret_ref:body.secret_ref,enabled:body.enabled===undefined?current.enabled:body.enabled};
    const row=(await query(`UPDATE backup_targets SET name=$3,config=$4,encrypted_secret=$5,secret_ref=$6,enabled=$7,updated_at=now() WHERE tenant_id=$1 AND id=$2
      RETURNING id,name,target_kind,config,secret_ref,enabled,created_at,updated_at`,[req.user!.tenantId,targetId,values.name,values.config,values.encrypted_secret,values.secret_ref,values.enabled])).rows[0];
    await recordAudit(req.user!.tenantId,req.user!.id,'backup.target.updated','backup_target',targetId,{name:values.name,enabled:values.enabled});
    res.json(row);
  }catch(error){next(error);}
});

backupsRouter.delete('/backups/targets/:id',requirePermission('backup:manage'),async(req,res,next)=>{
  try{
    const targetId=String(req.params.id);
    const result=await query('DELETE FROM backup_targets WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,targetId]);
    if(!result.rowCount)return res.status(404).json({error:'Backup target not found'});
    await recordAudit(req.user!.tenantId,req.user!.id,'backup.target.deleted','backup_target',targetId,{});
    res.status(204).send();
  }catch(error){next(error);}
});

backupsRouter.post('/backups/run',requirePermission('backup:manage'),async(req,res,next)=>{
  try{const result=await runBackup(req.user!.tenantId,req.user!.id);res.status(201).json(result);}catch(error){next(error);}
});

backupsRouter.post('/backups/retention',requirePermission('backup:manage'),async(req,res,next)=>{
  try{res.json(await applyRetention(req.user!.tenantId,req.user!.id));}catch(error){next(error);}
});
