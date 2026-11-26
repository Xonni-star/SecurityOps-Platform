import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';

export type BackupScheduleKind='daily'|'weekly';
export type BackupTargetKind='local'|'smb'|'sftp'|'s3';
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
  try{new Intl.DateTimeFormat('en-GB',{timeZone:schedule.timezone}).format();}catch{return false;}
  return schedule.kind==='daily'||schedule.kind==='weekly';
}

export function isScheduleDue(schedule:BackupSchedule,now=new Date()){
  if(!schedule.enabled||!scheduleIsValid(schedule))return false;
  const [hours,minutes]=schedule.time.split(':').map(Number);
  const local=new Intl.DateTimeFormat('en-GB',{timeZone:schedule.timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',weekday:'short',hourCycle:'h23'}).formatToParts(now);
  const values=Object.fromEntries(local.map(part=>[part.type,part.value]));
  const weekdayMap:Record<string,number>={Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6};
  const matchesTime=Number(values.hour)>hours||(Number(values.hour)===hours&&Number(values.minute)>=minutes);
  const matchesDay=schedule.kind==='daily'||weekdayMap[values.weekday]===schedule.weekday;
  if(!matchesTime||!matchesDay)return false;
  if(!schedule.lastRunAt)return Number(values.hour)===hours&&Number(values.minute)===minutes;
  const last=new Date(schedule.lastRunAt);
  const lastLocal=new Intl.DateTimeFormat('en-GB',{timeZone:schedule.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(last);
  const lastValues=Object.fromEntries(lastLocal.map(part=>[part.type,part.value]));
  return `${values.year}-${values.month}-${values.day}`!==`${lastValues.year}-${lastValues.month}-${lastValues.day}`;
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
  if(!secret)throw new Error('BACKUP_SECRET_KEY ist zum Verschlüsseln der Zielgeheimnisse erforderlich');
  const iv=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',keyBytes(secret),iv);
  const ciphertext=Buffer.concat([cipher.update(JSON.stringify(payload),'utf8'),cipher.final()]);
  return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`;
}
export function decryptSecretPayload(value:string,secret:string):Record<string,string>{
  if(!secret)throw new Error('BACKUP_SECRET_KEY ist zum Entschlüsseln der Zielgeheimnisse erforderlich');
  const [ivValue,tagValue,ciphertextValue]=value.split('.');
  if(!ivValue||!tagValue||!ciphertextValue)throw new Error('Ungültiges verschlüsseltes Backup-Geheimnis');
  const decipher=createDecipheriv('aes-256-gcm',keyBytes(secret),Buffer.from(ivValue,'base64url'));
  decipher.setAuthTag(Buffer.from(tagValue,'base64url'));
  const clear=Buffer.concat([decipher.update(Buffer.from(ciphertextValue,'base64url')),decipher.final()]).toString('utf8');
  const payload=JSON.parse(clear) as unknown;
  if(!payload||typeof payload!=='object')throw new Error('Ungültiger Backup-Geheimniswert');
  return Object.fromEntries(Object.entries(payload).filter((entry):entry is [string,string]=>typeof entry[1]==='string'));
}
