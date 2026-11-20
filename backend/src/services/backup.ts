import {readFile} from 'node:fs/promises';
import {basename,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {query,withTenantContext} from '../db/pool.js';
import {env} from '../config/env.js';
import {dmsStorage} from '../routes/dms.js';
import {recordAudit} from './audit.js';
import {createBackupTargetAdapter,BackupTargetAdapter,BackupUpload} from './backup-adapters.js';
import {isScheduleDue,selectRetentionRuns} from './backup-domain.js';
import {spawnFile} from './backup-process.js';
import {queueNotificationEvent} from './notifications.js';
import {resolveSecretPayload} from './secrets.js';
import {releaseWorkerLease,tryAcquireWorkerLease} from './worker-lease.js';

type BackupSettingsRow={tenant_id:string;enabled:boolean;schedule_kind:'daily'|'weekly';schedule_time:string;schedule_weekday:number|null;schedule_timezone:string;retention_count:number|null;retention_days:number|null;last_run_at:string|null};
type TargetRow={id:string;tenant_id:string;target_kind:'local'|'smb'|'sftp'|'s3';config:Record<string,unknown>;encrypted_secret:string|null;secret_ref:string|null};
type Artifact={artifact_kind:'database'|'dms_blob'|'manifest';source_key:string;sha256:string;size_bytes:number;content:Buffer};

let workerTimer:NodeJS.Timeout|undefined;
let workerRunning=false;

function hash(content:Buffer){return createHash('sha256').update(content).digest('hex');}
function runScript(script:string,databaseUrl:string):Promise<string>{
  return new Promise((resolvePromise,reject)=>{
    const child=spawnFile('bash',[script],{env:{...process.env,DATABASE_URL:databaseUrl,BACKUP_DIRECTORY:env.BACKUP_DIRECTORY},stdio:['ignore','pipe','pipe']});
    let stdout='';let stderr='';
    child.stdout?.on('data',chunk=>{stdout+=String(chunk);});
    child.stderr?.on('data',chunk=>{stderr+=String(chunk);});
    child.on('error',reject);child.on('close',code=>{
      if(code!==0)return reject(new Error(`Database backup failed: ${stderr.slice(-2000)}`));
      const file=stdout.trim().split(/\r?\n/).at(-1);if(!file)return reject(new Error('Database backup did not return an artifact path'));
      resolvePromise(file);
    });
  });
}

async function loadTargets(tenantId:string){
  return (await query<TargetRow>('SELECT id,tenant_id,target_kind,config,encrypted_secret,secret_ref FROM backup_targets WHERE tenant_id=$1 AND enabled=true ORDER BY created_at',[tenantId])).rows;
}

async function secretForTarget(target:TargetRow){
  if(target.target_kind==='local')return {};
  const secret=await resolveSecretPayload(target.secret_ref??undefined,target.encrypted_secret);
  if(!secret)throw new Error(`Target ${target.id} has no configured secret`);
  return secret;
}

export async function retryUpload(adapter:BackupTargetAdapter,upload:BackupUpload,maxAttempts=3){
  let lastError:unknown;
  for(let attempt=1;attempt<=maxAttempts;attempt++){
    try{await adapter.upload(upload);return attempt;}catch(error){lastError=error;if(attempt<maxAttempts)await new Promise(resolve=>setTimeout(resolve,Math.min(1000*2**(attempt-1),5000)));}
  }
  throw lastError instanceof Error?lastError:new Error('Backup upload failed');
}

export async function runBackup(tenantId:string,actorUserId?:string){
  return withTenantContext(tenantId,async()=>{
    const runId=randomUUID();
    try{
      try{await query('INSERT INTO backup_runs(id,tenant_id,status) VALUES($1,$2,$3)',[runId,tenantId,'running']);}
      catch(error){if((error as {code?:string}).code==='23505')throw Object.assign(new Error('A backup is already running for this tenant'),{status:409});throw error;}
      await query('UPDATE backup_settings SET last_run_at=now(),last_status=$2,updated_at=now() WHERE tenant_id=$1',[tenantId,'running']);
      const script=resolve(process.cwd(),process.env.BACKUP_DB_SCRIPT??'../scripts/backup-db.sh');
      if(!env.DATABASE_URL)throw new Error('DATABASE_URL is not configured');
      const dumpPath=await runScript(script,env.DATABASE_URL);
      const dump=await readFile(dumpPath);
      const artifacts:Artifact[]=[{artifact_kind:'database',source_key:basename(dumpPath),sha256:hash(dump),size_bytes:dump.byteLength,content:dump}];
      const rows=(await query<{object_key:string;sha256:string;size_bytes:number}>(
        `SELECT object_key,sha256,size_bytes FROM dms_versions WHERE tenant_id=$1 AND lifecycle_state='available' ORDER BY object_key`,[tenantId])).rows;
      for(const row of rows){
        const blob=await dmsStorage.get(row.object_key);
        if(blob.content.byteLength!==Number(row.size_bytes)||hash(blob.content)!==row.sha256)throw new Error(`DMS blob integrity check failed for ${row.object_key}`);
        artifacts.push({artifact_kind:'dms_blob',source_key:row.object_key,sha256:row.sha256,size_bytes:blob.content.byteLength,content:blob.content});
      }
      const manifest=Buffer.from(JSON.stringify({version:'backup-v1',tenant_id:tenantId,run_id:runId,created_at:new Date().toISOString(),database:artifacts[0],dms_blobs:artifacts.filter(item=>item.artifact_kind==='dms_blob').map(({content:_,...item})=>item)},null,2));
      artifacts.push({artifact_kind:'manifest',source_key:'manifest.json',sha256:hash(manifest),size_bytes:manifest.byteLength,content:manifest});
      for(const artifact of artifacts)await query('INSERT INTO backup_artifacts(tenant_id,run_id,artifact_kind,source_key,sha256,size_bytes) VALUES($1,$2,$3,$4,$5,$6)',[tenantId,runId,artifact.artifact_kind,artifact.source_key,artifact.sha256,artifact.size_bytes]);
      const targets=await loadTargets(tenantId);let successfulTargets=0;const failures:string[]=[];
      for(const target of targets){
        const targetRunId=randomUUID();await query('INSERT INTO backup_target_runs(id,tenant_id,run_id,target_id,status) VALUES($1,$2,$3,$4,$5)',[targetRunId,tenantId,runId,target.id,'running']);
        try{
          const adapter=createBackupTargetAdapter(target.target_kind,target.config as never,await secretForTarget(target));
          let attempts=0;
          for(const artifact of artifacts)attempts=Math.max(attempts,await retryUpload(adapter,{key:`${tenantId}/${runId}/${artifact.source_key}`,content:artifact.content}));
          await query('UPDATE backup_target_runs SET status=$4,attempts=$5,uploaded_at=now() WHERE tenant_id=$1 AND run_id=$2 AND target_id=$3',[tenantId,runId,target.id,'succeeded',attempts]);
          successfulTargets++;
        }catch(error){
          const message=error instanceof Error?error.message:'Unknown target failure';failures.push(`${target.id}: ${message}`);
          await query('UPDATE backup_target_runs SET status=$4,error_message=$5 WHERE tenant_id=$1 AND run_id=$2 AND target_id=$3',[tenantId,runId,target.id,'failed',message]);
        }
      }
      if(targets.length===0)throw new Error('No enabled backup targets configured');
      if(successfulTargets===0)throw new Error(failures.join('; ')||'All backup targets failed');
      await query('UPDATE backup_runs SET status=$3,completed_at=now(),successful_targets=$4,manifest=$5 WHERE tenant_id=$1 AND id=$2',[tenantId,runId,'succeeded',successfulTargets,{artifact_count:artifacts.length,failed_targets:failures}]);
      await query('UPDATE backup_settings SET last_success_at=now(),last_status=$2,updated_at=now() WHERE tenant_id=$1',[tenantId,'succeeded']);
      try{await applyRetention(tenantId,actorUserId);}catch(error){
        const message=error instanceof Error?error.message:'Unknown retention failure';
        if(actorUserId)await recordAudit(tenantId,actorUserId,'backup.retention.failed','backup_run',runId,{error:message});
      }
      if(actorUserId)await recordAudit(tenantId,actorUserId,'backup.run.succeeded','backup_run',runId,{successful_targets:successfulTargets,artifact_count:artifacts.length});
      void queueNotificationEvent(tenantId,'backup.succeeded',`backup:${runId}`,'Backup erfolgreich',`Backup-Lauf ${runId} wurde erfolgreich abgeschlossen.`, 'backup_run',runId).catch(error=>recordAudit(tenantId,actorUserId??null,'backup.notification.failed','backup_run',runId,{error:error instanceof Error?error.message:'Notification failed'}));
      return {id:runId,status:'succeeded',successfulTargets,artifactCount:artifacts.length};
    }catch(error){
      const message=error instanceof Error?error.message:'Unknown backup failure';
      if((error as {status?:number}).status!==409){
        await query('UPDATE backup_runs SET status=$3,completed_at=now(),error_message=$4 WHERE tenant_id=$1 AND id=$2',[tenantId,runId,'failed',message]);
        await query('UPDATE backup_settings SET last_status=$2,updated_at=now() WHERE tenant_id=$1',[tenantId,'failed']);
      }
      if(actorUserId)await recordAudit(tenantId,actorUserId,'backup.run.failed','backup_run',runId,{error:message});
      void queueNotificationEvent(tenantId,'backup.failed',`backup:${runId}`,'Backup fehlgeschlagen',`Backup-Lauf ${runId} ist fehlgeschlagen. Prüfen Sie den Backup-Status.`, 'backup_run',runId).catch(error=>recordAudit(tenantId,actorUserId??null,'backup.notification.failed','backup_run',runId,{error:error instanceof Error?error.message:'Notification failed'}));
      throw error;
    }
  });
}

export async function applyRetention(tenantId:string,actorUserId?:string){
  return withTenantContext(tenantId,async()=>{
    const settings=(await query<Pick<BackupSettingsRow,'retention_count'|'retention_days'> & {tenant_id:string}>('SELECT tenant_id,retention_count,retention_days FROM backup_settings WHERE tenant_id=$1',[tenantId])).rows[0];
    if(!settings||(!settings.retention_count&&!settings.retention_days))return {deleted:0};
    const runs=(await query<{id:string;started_at:string;status:'succeeded'|'failed'|'running'}>('SELECT id,started_at,status FROM backup_runs WHERE tenant_id=$1 AND status=$2 ORDER BY started_at DESC',[tenantId,'succeeded'])).rows;
    const obsolete=selectRetentionRuns(runs,settings.retention_count,settings.retention_days);
    let deleted=0;
    for(const run of obsolete){
      const targets=(await query<TargetRow>('SELECT id,target_kind,config,encrypted_secret,secret_ref,tenant_id FROM backup_targets WHERE tenant_id=$1 AND enabled=true',[tenantId])).rows;
      const artifacts=(await query<{source_key:string}>('SELECT source_key FROM backup_artifacts WHERE tenant_id=$1 AND run_id=$2',[tenantId,run.id])).rows;
      for(const target of targets){
        const targetRun=(await query<{status:string}>('SELECT status FROM backup_target_runs WHERE tenant_id=$1 AND run_id=$2 AND target_id=$3',[tenantId,run.id,target.id])).rows[0];
        if(targetRun?.status!=='succeeded')continue;
        const adapter=createBackupTargetAdapter(target.target_kind,target.config as never,await secretForTarget(target));
        for(const artifact of artifacts)await adapter.delete(`${tenantId}/${run.id}/${artifact.source_key}`);
      }
      await query('DELETE FROM backup_runs WHERE tenant_id=$1 AND id=$2',[tenantId,run.id]);deleted++;
    }
    if(actorUserId)await recordAudit(tenantId,actorUserId,'backup.retention.applied','backup_run',undefined,{deleted});
    return {deleted};
  });
}

export async function runDueBackups(){
  if(workerRunning)return;
  workerRunning=true;
  const leaseName='backup-scheduler';
  if(!await tryAcquireWorkerLease(leaseName,Math.max(30000,Number(process.env.BACKUP_WORKER_INTERVAL_MS??60000)*2))){
    workerRunning=false;
    return;
  }
  try{
    const settings=(await query<BackupSettingsRow>('SELECT * FROM backup_settings WHERE enabled=true')).rows;
    for(const setting of settings){
      if(!isScheduleDue({enabled:setting.enabled,kind:setting.schedule_kind,time:setting.schedule_time.slice(0,5),weekday:setting.schedule_weekday,timezone:setting.schedule_timezone,lastRunAt:setting.last_run_at}))continue;
      try{await runBackup(setting.tenant_id);}catch(error){
        const message=error instanceof Error?error.message:'Scheduled backup failed';
        await recordAudit(setting.tenant_id,null,'backup.scheduler.failed','backup_settings',setting.tenant_id,{error:message}).catch(()=>undefined);
      }
    }
  }finally{
    await releaseWorkerLease(leaseName);
    workerRunning=false;
  }
}

export function startBackupWorker(intervalMs=Number(process.env.BACKUP_WORKER_INTERVAL_MS??60000)){
  if(workerTimer)return stopBackupWorker;
  workerTimer=setInterval(()=>{void runDueBackups();},intervalMs);
  void runDueBackups();
  return stopBackupWorker;
}
export function stopBackupWorker(){if(workerTimer){clearInterval(workerTimer);workerTimer=undefined;}}
export function isBackupWorkerRunning(){return workerTimer!==undefined;}
