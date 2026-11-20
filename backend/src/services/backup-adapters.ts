import {mkdir,writeFile,rename} from 'node:fs/promises';
import {dirname,join,normalize} from 'node:path';
import {spawnFile} from './backup-process.js';
import {PutObjectCommand,S3Client} from '@aws-sdk/client-s3';
import {BackupTargetKind} from './backup-domain.js';
import SftpClient from 'ssh2-sftp-client';
import {createHash} from 'node:crypto';

export interface BackupUpload {key:string;content:Buffer;contentType?:string;}
export interface BackupTargetConfig {root?:string;endpoint?:string;bucket?:string;prefix?:string;region?:string;remotePath?:string;host?:string;port?:number;username?:string;hostKeyFingerprint?:string;hostKeyPolicy?:'strict'|'disabled';forcePathStyle?:boolean}
export interface BackupTargetAdapter {upload(upload:BackupUpload):Promise<void>;}
export interface BackupTargetAdapter {delete(key:string):Promise<void>;}

function safeKey(key:string){
  if(!key||key.startsWith('/')||key.includes('\\')||key.split('/').some(part=>part===''||part==='.'||part==='..'))throw new Error('Unsafe backup artifact key');
  const value=normalize(key);
  if(value.startsWith('../')||value==='..'||value.startsWith('/'))throw new Error('Unsafe backup artifact key');
  return value;
}

function remotePath(config:BackupTargetConfig,key:string){
  const root=config.remotePath?.replace(/^\/+|\/+$/g,'');
  return [root,safeKey(key)].filter(Boolean).join('/');
}

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
    if(!config.bucket)throw new Error('S3 backup target requires a bucket');
    const endpoint=config.endpoint?.trim();
    if(endpoint&&!/^https:\/\//i.test(endpoint))throw new Error('S3 endpoint must use HTTPS');
    this.client=new S3Client({...(endpoint?{endpoint}:{}),region:config.region??'us-east-1',forcePathStyle:config.forcePathStyle??Boolean(endpoint),credentials:secret.accessKey&&secret.secretKey?{accessKeyId:secret.accessKey,secretAccessKey:secret.secretKey}:undefined});
  }
  async upload(upload:BackupUpload){await this.client.send(new PutObjectCommand({Bucket:this.config.bucket!,Key:[this.config.prefix?.replace(/^\/+|\/+$/g,''),safeKey(upload.key)].filter(Boolean).join('/'),Body:upload.content,ContentType:upload.contentType??'application/octet-stream'}));}
  async delete(key:string){const {DeleteObjectCommand}=await import('@aws-sdk/client-s3');await this.client.send(new DeleteObjectCommand({Bucket:this.config.bucket!,Key:[this.config.prefix?.replace(/^\/+|\/+$/g,''),safeKey(key)].filter(Boolean).join('/')}));}
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
    const remote=remotePath(this.config,upload.key);
    if(this.kind==='smb'){
      if(!this.config.host||!this.secret.username||!this.secret.password)throw new Error('SMB requires host, username and password');
      await this.runner('smbclient',[this.config.host, '-p',String(this.config.port??445), '-U',this.secret.username, '-c',`put - ${remote}`],upload.content,{PASSWD:this.secret.password});
      return;
    }
    throw new Error('SFTP adapter is not available through the command runner');
  }
  async delete(key:string){
    const remote=remotePath(this.config,key);
    if(this.kind==='smb'){
      if(!this.config.host||!this.secret.username||!this.secret.password)throw new Error('SMB requires host, username and password');
      await this.runner('smbclient',[this.config.host,'-p',String(this.config.port??445),'-U',this.secret.username,'-c',`del ${remote}`],Buffer.alloc(0),{PASSWD:this.secret.password});
      return;
    }
    throw new Error('SFTP adapter is not available through the command runner');
  }
}

export class SftpBackupTargetAdapter implements BackupTargetAdapter {
  constructor(private readonly config:BackupTargetConfig,private readonly secret:Record<string,string>){}
  private async withClient<T>(work:(client:SftpClient)=>Promise<T>){
    if(!this.config.host||!this.secret.username)throw new Error('SFTP requires host and username');
    if(!this.secret.password&&!this.secret.privateKey)throw new Error('SFTP requires a password or private key');
    if(this.config.hostKeyPolicy==='disabled'||!this.config.hostKeyFingerprint)throw new Error('SFTP host-key fingerprint is required');
    const client=new SftpClient();
    try{
      await client.connect({
        host:this.config.host,port:this.config.port??22,username:this.secret.username,password:this.secret.password,
        privateKey:this.secret.privateKey,passphrase:this.secret.passphrase,readyTimeout:10000,
        hostVerifier:key=>`SHA256-${createHash('sha256').update(key).digest('base64').replace(/=+$/,'')}`===this.config.hostKeyFingerprint,
      });
      return await work(client);
    }finally{await client.end().catch(()=>undefined);}
  }
  async upload(upload:BackupUpload){return this.withClient(client=>client.put(upload.content,remotePath(this.config,upload.key)));}
  async delete(key:string){return this.withClient(client=>client.delete(remotePath(this.config,key)));}
}

export function createBackupTargetAdapter(kind:BackupTargetKind,config:BackupTargetConfig,secret:Record<string,string>={},runner?:CommandRunner):BackupTargetAdapter{
  if(kind==='local')return new LocalBackupTargetAdapter(config.root??'./backups');
  if(kind==='s3')return new S3BackupTargetAdapter(config,secret);
  if(kind==='sftp')return new SftpBackupTargetAdapter(config,secret);
  return new CommandBackupTargetAdapter(kind,config,secret,runner);
}
