import crypto from 'node:crypto';
import {env} from '../config/env.js';

export type HashInput=Record<string,unknown>;
function canonical(value:unknown):unknown{
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)]));
  return value;
}
export function canonicalJson(value:HashInput){return JSON.stringify(canonical(value));}
export function sha256(value:string){return crypto.createHash('sha256').update(value,'utf8').digest('hex');}
export function hashChain(value:HashInput,previous:string|null){
  const contentHash=sha256(canonicalJson(value));
  const chainHash=sha256(`${contentHash}:${previous??''}`);
  const secret=env.WATCHBOOK_HASH_SECRET;
  return {contentHash,chainHash,integrityHmac:secret?crypto.createHmac('sha256',secret).update(chainHash).digest('hex'):null};
}
export function verifyHash(value:HashInput,previous:string|null,contentHash:string|null,chainHashValue:string|null,hmac:string|null){
  if(!contentHash||!chainHashValue)return false;
  const expected=hashChain(value,previous);
  if(expected.contentHash!==contentHash||expected.chainHash!==chainHashValue)return false;
  const secret=env.WATCHBOOK_HASH_SECRET;
  return !secret||expected.integrityHmac===hmac;
}

export type RevisionIntegrityInput={
  tenant_id:string;entry_id:string;revision_id:string;revision_no:number;created_at:string;canonical_payload:HashInput;previous_revision_hash:string|null;
};
export function computeRevisionIntegrity(input:RevisionIntegrityInput){
  const canonicalPayload=canonicalJson(input.canonical_payload);
  const canonicalPayloadHash=sha256(canonicalPayload);
  const material=`sha256-v1|${input.tenant_id}|${input.entry_id}|${input.revision_id}|${input.revision_no}|${input.created_at}|${canonicalPayload}|${input.previous_revision_hash??''}`;
  const revisionHash=sha256(material);
  const secret=env.WATCHBOOK_HASH_SECRET;
  return {canonicalPayload,canonicalPayloadHash,revisionHash,hmac:secret?crypto.createHmac('sha256',secret).update(revisionHash).digest('hex'):null,hmacVersion:secret?'hmac-sha256-v1':null};
}
export function verifyRevisionIntegrity(input:RevisionIntegrityInput,stored:{canonical_payload_hash:string|null;revision_hash:string|null;hmac:string|null;hmac_version:string|null}){
  const expected=computeRevisionIntegrity(input);
  if(expected.canonicalPayloadHash!==stored.canonical_payload_hash||expected.revisionHash!==stored.revision_hash)return {valid:false,reason:'hash_mismatch',expected,actual:stored.revision_hash};
  if(env.WATCHBOOK_HASH_SECRET&&(expected.hmac!==stored.hmac||stored.hmac_version!=='hmac-sha256-v1'))return {valid:false,reason:'hmac_mismatch',expected,actual:stored.hmac};
  return {valid:true,reason:null,expected,actual:stored.revision_hash};
}
