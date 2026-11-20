import crypto from 'node:crypto';
import type pg from 'pg';

export type SyncConflictStrategy='USE_LOCAL'|'USE_SERVER'|'RECORD_AS_EXCEPTION';
export type SyncMutationAction='alarms.panic'|'patrol.scan'|'watchbook.entry'|'scheduling.period'|'scheduling.shift'|'scheduling.assignment'|'scheduling.rule_profile'|'dms.document'|'keys.create'|'keys.issue'|'keys.return'|'keys.lost'|'keys.deactivate';

export interface SyncMutationInput {
  tenantId:string;
  userId:string;
  mutationId:string;
  action:SyncMutationAction;
  payload:unknown;
  conflictStrategy?:SyncConflictStrategy;
}

export interface SyncMutationResult<T> {
  response:T;
  replayed:boolean;
}

export type ConflictResolution<T>=
  | {strategy:'USE_LOCAL';value:T}
  | {strategy:'USE_SERVER';value:T}
  | {strategy:'RECORD_AS_EXCEPTION';value:null};

export function resolveConflict<T>(strategy:SyncConflictStrategy,local:T,server:T):ConflictResolution<T>{
  if(strategy==='USE_LOCAL')return {strategy,value:local};
  if(strategy==='USE_SERVER')return {strategy,value:server};
  return {strategy,value:null};
}

export function canonicalize(value:unknown):unknown{
  if(Array.isArray(value))return value.map(canonicalize);
  if(value&&typeof value==='object'){
    return Object.fromEntries(Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonicalize(item)]));
  }
  return value;
}

export function canonicalPayloadHash(value:unknown){
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function syncError(message:string,status:number,code:string){
  return Object.assign(new Error(message),{status,code});
}

export async function runIdempotentMutation<T>(
  client:pg.PoolClient,
  input:SyncMutationInput,
  apply:(client:pg.PoolClient)=>Promise<T>,
):Promise<SyncMutationResult<T>>{
  const payloadHash=canonicalPayloadHash(input.payload);
  const inserted=await client.query(
    `INSERT INTO sync_receipts(tenant_id,user_id,mutation_id,action,payload_hash,conflict_strategy,status)
     VALUES($1,$2,$3,$4,$5,$6,'processing')
     ON CONFLICT (tenant_id,mutation_id) DO NOTHING
     RETURNING id`,
    [input.tenantId,input.userId,input.mutationId,input.action,payloadHash,input.conflictStrategy??'RECORD_AS_EXCEPTION'],
  );
  if(!inserted.rowCount){
    const existing=await client.query<{action:string;payload_hash:string;status:string;response:T|null}>(
      `SELECT action,payload_hash,status,response FROM sync_receipts
       WHERE tenant_id=$1 AND mutation_id=$2 FOR UPDATE`,
      [input.tenantId,input.mutationId],
    );
    const receipt=existing.rows[0];
    if(receipt.action!==input.action)throw syncError('Mutation-ID wurde bereits für eine inkompatible Aktion verwendet.',409,'SYNC_ACTION_MISMATCH');
    if(receipt.payload_hash!==payloadHash)throw syncError('Mutation-ID wurde mit einem abweichenden Payload wiederverwendet.',409,'SYNC_HASH_MISMATCH');
    if(receipt.status==='completed'&&receipt.response!==null)return {response:receipt.response,replayed:true};
    throw syncError('Mutation wird bereits verarbeitet.',409,'SYNC_IN_PROGRESS');
  }
  const response=await apply(client);
  await client.query(
    `UPDATE sync_receipts SET status='completed',response=$4,completed_at=now()
     WHERE tenant_id=$1 AND mutation_id=$2 AND action=$3`,
    [input.tenantId,input.mutationId,input.action,JSON.stringify(response)],
  );
  return {response,replayed:false};
}

export function parseSyncConflictStrategy(value:unknown):SyncConflictStrategy{
  if(value===undefined)return 'RECORD_AS_EXCEPTION';
  if(value==='USE_LOCAL'||value==='USE_SERVER'||value==='RECORD_AS_EXCEPTION')return value;
  throw syncError('Ungültige Konfliktstrategie.',400,'SYNC_INVALID_CONFLICT_STRATEGY');
}
