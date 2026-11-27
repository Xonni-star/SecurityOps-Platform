import {createHash} from 'node:crypto';
import net from 'node:net';
import {DeleteObjectCommand,GetObjectCommand,HeadBucketCommand,PutObjectCommand,S3Client} from '@aws-sdk/client-s3';
import {env} from '../config/env.js';

export interface BlobStorageAdapter {
  put(key:string, content:Buffer, contentType:string):Promise<void>;
  get(key:string):Promise<{content:Buffer;contentType?:string}>;
  delete(key:string):Promise<void>;
  /** Optional readiness probe used by /ready/dms. */
  ready?():Promise<void>;
}

export interface MalwareScanResult {
  clean:boolean;
  signature?:string;
}

export interface MalwareScannerAdapter {
  scan(content:Buffer):Promise<MalwareScanResult>;
  /** Optional readiness probe used by /ready/dms. */
  ready?():Promise<void>;
}

export class MinioS3BlobStorageAdapter implements BlobStorageAdapter {
  private readonly client:S3Client;
  constructor(
    private readonly endpoint=env.MINIO_ENDPOINT,
    private readonly bucket=env.MINIO_BUCKET,
    private readonly accessKey=env.MINIO_ACCESS_KEY,
    private readonly secretKey=env.MINIO_SECRET_KEY,
  ){
    this.client=new S3Client({
      endpoint:this.endpoint,
      region:'us-east-1',
      forcePathStyle:true,
      credentials:this.accessKey&&this.secretKey?{accessKeyId:this.accessKey,secretAccessKey:this.secretKey}:undefined,
    });
  }

  async put(key:string,content:Buffer,contentType:string){
    await this.client.send(new PutObjectCommand({Bucket:this.bucket,Key:key,Body:content,ContentType:contentType}));
  }

  async get(key:string){
    const response=await this.client.send(new GetObjectCommand({Bucket:this.bucket,Key:key}));
    if(!response.Body)throw new Error('Blob-Anbieter hat einen leeren Antwortkörper zurückgegeben');
    return {content:Buffer.from(await response.Body.transformToByteArray()),contentType:response.ContentType};
  }

  async delete(key:string){
    await this.client.send(new DeleteObjectCommand({Bucket:this.bucket,Key:key}));
  }

  async ready(){
    await this.client.send(new HeadBucketCommand({Bucket:this.bucket}));
  }
}

export class ClamAvMalwareScannerAdapter implements MalwareScannerAdapter {
  constructor(private readonly host=env.CLAMAV_HOST,private readonly port=env.CLAMAV_PORT,private readonly timeoutMs=env.CLAMAV_TIMEOUT_MS){}

  scan(content:Buffer){
    return new Promise<MalwareScanResult>((resolve,reject)=>{
      const socket=net.createConnection({host:this.host,port:this.port});
      const chunks:Buffer[]=[];
      const timer=setTimeout(()=>{socket.destroy();reject(new Error('Zeitüberschreitung beim ClamAV-Scan'));},this.timeoutMs);
      socket.on('data',chunk=>chunks.push(Buffer.from(chunk)));
      socket.on('error',error=>{clearTimeout(timer);reject(error);});
      socket.on('close',()=>{clearTimeout(timer);const result=Buffer.concat(chunks).toString('utf8').replace(/\0+$/,'').trim();if(result.endsWith('OK'))resolve({clean:true});else if(result.startsWith('stream:'))resolve({clean:false,signature:result.slice(7).trim()});else reject(new Error(`Unerwartete ClamAV-Antwort: ${result}`));});
      socket.write(Buffer.from('zINSTREAM\0'));
      for(let offset=0;offset<content.length;offset+=env.CLAMAV_CHUNK_BYTES){
        const chunk=content.subarray(offset,offset+env.CLAMAV_CHUNK_BYTES);
        const length=Buffer.alloc(4);length.writeUInt32BE(chunk.length);socket.write(length);socket.write(chunk);
      }
      socket.end(Buffer.alloc(4));
    });
  }

  ready(){
    return new Promise<void>((resolve,reject)=>{
      const socket=net.createConnection({host:this.host,port:this.port});
      const chunks:Buffer[]=[];
      const timer=setTimeout(()=>{socket.destroy();reject(new Error('Zeitüberschreitung beim ClamAV-Ping'));},this.timeoutMs);
      socket.on('data',chunk=>chunks.push(Buffer.from(chunk)));
      socket.on('error',error=>{clearTimeout(timer);reject(error);});
      socket.on('close',()=>{
        clearTimeout(timer);
        const result=Buffer.concat(chunks).toString('utf8').replace(/\0+$/,'').trim();
        if(result==='PONG')resolve();
        else reject(new Error(`Unerwartete ClamAV-Ping-Antwort: ${result}`));
      });
      socket.write(Buffer.from('zPING\0'));
      socket.end();
    });
  }
}

export function createDmsAdapters(){
  return {storage:new MinioS3BlobStorageAdapter(),scanner:new ClamAvMalwareScannerAdapter()};
}

export function sha256(content:Buffer){return createHash('sha256').update(content).digest('hex');}

export interface DmsBackupContractStatus {
  provider:string;
  contractVersion:string;
  status:'unknown'|'healthy'|'degraded'|'failed';
  lastBackupAt:string|null;
  lastRestoreTestAt:string|null;
  databaseBackupIndependent:true;
}

export function configuredDmsBackupContract():DmsBackupContractStatus{
  return {
    provider:env.DMS_BLOB_BACKUP_PROVIDER,
    contractVersion:'dms-blob-backup-v1',
    status:env.DMS_BLOB_BACKUP_STATUS,
    lastBackupAt:null,
    lastRestoreTestAt:null,
    databaseBackupIndependent:true,
  };
}
