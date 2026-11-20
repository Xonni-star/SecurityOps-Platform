import {mkdir,writeFile,rename} from 'node:fs/promises';
import {dirname,join,normalize} from 'node:path';
import {spawnFile} from './backup-process.js';
import {PutObjectCommand,S3Client} from '@aws-sdk/client-s3';
import {BackupTargetKind} from './backup-domain.js';

export interface BackupUpload {key:string;content:Buffer;contentType?:string;}
export interface BackupTargetConfig {root?:string;endpoint?:string;bucket?:string;prefix?:string;region?:string;remotePath?:string;host?:string;port?:number}
export interface BackupTargetAdapter {upload(upload:BackupUpload):Promise<void>;}
export interface BackupTargetAdapter {delete(key:string):Promise<void>;}

function safeKey(key:string){const value=normalize(key).replace(/^(\.\.(\/|\\|$))+/, '');if(value.startsWith('/')||value.includes('..'))throw new Error('Unsafe backup artifact key');return value;}

export class LocalBackupTargetAdapter implements BackupTargetAdapter {
  constructor(private readonly root:string){}
  async upload(upload:BackupUpload){
    const target=join(this.root,safeKey(upload.key));await mkdir(dirname(target),{recursive:true});
    const temporary=`${target}.partial-${process.pid}-${Date.now()}`;await writeFile(temporary,upload.content,{mode:0o600});await rename(temporary,target);
  }
  async delete(key:string){await (await import('node:fs/promises')).rm(join(this.root,safeKey(key)),{force:true});}
}

export class S3BackupTargetAdapter implements BackupTargetAdapter {
  private readonly client:S3Client;
  constructor(private readonly config:BackupTargetConfig,secret:Record<string,string>){
    if(!config.endpoint||!config.bucket)throw new Error('S3 backup target requires endpoint and bucket');
    this.client=new S3Client({endpoint:config.endpoint,region:config.region??'us-east-1',forcePathStyle:true,credentials:secret.accessKey&&secret.secretKey?{accessKeyId:secret.accessKey,secretAccessKey:secret.secretKey}:undefined});
  }
  async upload(upload:BackupUpload){await this.client.send(new PutObjectCommand({Bucket:this.config.bucket!,Key:[this.config.prefix,safeKey(upload.key)].filter(Boolean).join('/'),Body:upload.content,ContentType:upload.contentType??'application/octet-stream'}));}
  async delete(key:string){const {DeleteObjectCommand}=await import('@aws-sdk/client-s3');await this.client.send(new DeleteObjectCommand({Bucket:this.config.bucket!,Key:[this.config.prefix,safeKey(key)].filter(Boolean).join('/')}));}
}

export type CommandRunner=(command:string,args:string[],input:Buffer,env:Record<string,string>)=>Promise<void>;
const defaultRunner:CommandRunner=async(command,args,input,extraEnv)=>{
  await new Promise<void>((resolve,reject)=>{
    const child=spawnFile(command,args,{env:{...process.env,...extraEnv},stdio:['pipe','ignore','pipe']});
    let stderr='';child.stderr?.on('data',chunk=>{stderr+=String(chunk).slice(-2000);});
    child.on('error',reject);child.on('close',code=>code===0?resolve():reject(new Error(`${command} failed with exit code ${code}: ${stderr}`)));child.stdin?.end(input);
  });
};

export class CommandBackupTargetAdapter implements BackupTargetAdapter {
  constructor(private readonly kind:Exclude<BackupTargetKind,'local'|'s3'>,private readonly config:BackupTargetConfig,private readonly secret:Record<string,string>,private readonly runner:CommandRunner=defaultRunner){}
  async upload(upload:BackupUpload){
    const remote=[this.config.remotePath,safeKey(upload.key)].filter(Boolean).join('/');
    if(this.kind==='smb'){
      await this.runner('smbclient',[this.config.host??'', '-U', `${this.secret.username??''}%${this.secret.password??''}`, '-c',`put - ${remote}`],upload.content,{});
      return;
    }
    const scheme='sftp';
    const url=`${scheme}://${this.config.host??''}/${remote}`;
    await this.runner('curl',['--fail','--silent','--show-error','--retry','3','--upload-file','-','--user',`${this.secret.username??''}:${this.secret.password??''}`,url],upload.content,{});
  }
  async delete(key:string){
    const remote=[this.config.remotePath,safeKey(key)].filter(Boolean).join('/');
    if(this.kind==='smb'){await this.runner('smbclient',[this.config.host??'', '-U', `${this.secret.username??''}%${this.secret.password??''}`, '-c',`del ${remote}`],Buffer.alloc(0),{});return;}
    const scheme='sftp';
    await this.runner('curl',['--fail','--silent','--show-error','--user',`${this.secret.username??''}:${this.secret.password??''}`,'-X','DELETE',`${scheme}://${this.config.host??''}/${remote}`],Buffer.alloc(0),{});
  }
}

export function createBackupTargetAdapter(kind:BackupTargetKind,config:BackupTargetConfig,secret:Record<string,string>={},runner?:CommandRunner):BackupTargetAdapter{
  if(kind==='local')return new LocalBackupTargetAdapter(config.root??'./backups');
  if(kind==='s3')return new S3BackupTargetAdapter(config,secret);
  return new CommandBackupTargetAdapter(kind,config,secret,runner);
}
