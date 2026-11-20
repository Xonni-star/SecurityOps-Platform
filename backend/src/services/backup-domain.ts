import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';

export type BackupScheduleKind='daily'|'weekly';
export type BackupTargetKind='local'|'smb'|'ftp'|'ftps'|'sftp'|'s3';
export type BackupStatus='never'|'running'|'succeeded'|'failed';

export interface BackupSchedule {
  enabled:boolean;
  kind:BackupScheduleKind;
  time:string;
  weekday?:number|null;
  timezone:string;
  lastRunAt?:Date|string|null;
}

export function scheduleIsValid(schedule:BackupSchedule){
  if(!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(schedule.time))return false;
  if(schedule.kind==='weekly'&&(!Number.isInteger(schedule.weekday)||Number(schedule.weekday)<0||Number(schedule.weekday)>6))return false;
  return schedule.kind==='daily'||schedule.kind==='weekly';
}

export function isScheduleDue(schedule:BackupSchedule,now=new Date()){
  if(!schedule.enabled||!scheduleIsValid(schedule))return false;
  const [hours,minutes]=schedule.time.split(':').map(Number);
  const local=new Intl.DateTimeFormat('en-GB',{timeZone:schedule.timezone,hour:'2-digit',minute:'2-digit',weekday:'short',hourCycle:'h23'}).formatToParts(now);
  const values=Object.fromEntries(local.map(part=>[part.type,part.value]));
  const weekdayMap:Record<string,number>={Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6};
  const matchesTime=Number(values.hour)===hours&&Number(values.minute)===minutes;
  const matchesDay=schedule.kind==='daily'||weekdayMap[values.weekday]===schedule.weekday;
  if(!matchesTime||!matchesDay)return false;
  if(!schedule.lastRunAt)return true;
  const last=new Date(schedule.lastRunAt);
  return now.getTime()-last.getTime()>=60_000;
}

export function retentionDue(createdAt:string|Date,retentionDays:number|undefined|null,now=new Date()){
  return retentionDays!==null&&retentionDays!==undefined&&new Date(createdAt).getTime()<=now.getTime()-retentionDays*86400000;
}

export function selectRetentionRuns<T extends {started_at:string|Date}>(runs:T[],retentionCount:number|undefined|null,retentionDays:number|undefined|null,now=new Date()){
  const sorted=[...runs].sort((a,b)=>new Date(b.started_at).getTime()-new Date(a.started_at).getTime());
  return sorted.filter((run,index)=>
    Boolean(retentionCount&&retentionCount>0&&index>=retentionCount) ||
    Boolean(retentionDays&&retentionDue(run.started_at,retentionDays,now)),
  );
}

function keyBytes(secret:string){return createHash('sha256').update(secret).digest();}
export function encryptSecretPayload(payload:Record<string,string>,secret:string){
  if(!secret)throw new Error('BACKUP_SECRET_KEY is required to encrypt target secrets');
  const iv=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',keyBytes(secret),iv);
  const ciphertext=Buffer.concat([cipher.update(JSON.stringify(payload),'utf8'),cipher.final()]);
  return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`;
}
export function decryptSecretPayload(value:string,secret:string):Record<string,string>{
  if(!secret)throw new Error('BACKUP_SECRET_KEY is required to decrypt target secrets');
  const [ivValue,tagValue,ciphertextValue]=value.split('.');
  if(!ivValue||!tagValue||!ciphertextValue)throw new Error('Invalid encrypted backup secret');
  const decipher=createDecipheriv('aes-256-gcm',keyBytes(secret),Buffer.from(ivValue,'base64url'));
  decipher.setAuthTag(Buffer.from(tagValue,'base64url'));
  const clear=Buffer.concat([decipher.update(Buffer.from(ciphertextValue,'base64url')),decipher.final()]).toString('utf8');
  const payload=JSON.parse(clear) as unknown;
  if(!payload||typeof payload!=='object')throw new Error('Invalid backup secret payload');
  return Object.fromEntries(Object.entries(payload).filter((entry):entry is [string,string]=>typeof entry[1]==='string'));
}
