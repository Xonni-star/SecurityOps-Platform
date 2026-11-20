import {decryptSecretPayload} from './backup-domain.js';
import {env} from '../config/env.js';

export type SecretResolver= (reference:string)=>Promise<string|undefined>|string|undefined;

const defaultResolver:SecretResolver=(reference)=>process.env[reference];

export async function resolveSecret(reference:string|undefined,resolver:SecretResolver=defaultResolver):Promise<string|undefined>{
  if(!reference)return undefined;
  const value=await resolver(reference);
  if(typeof value!=='string'||value.length===0)throw new Error(`Referenced secret ${reference} is unavailable`);
  return value;
}

export async function resolveSecretPayload(secretRef:string|undefined,encryptedSecret:string|null,resolver:SecretResolver=defaultResolver):Promise<Record<string,string>|undefined>{
  if(secretRef){
    const raw=await resolveSecret(secretRef,resolver);
    if(!raw)throw new Error(`Referenced secret ${secretRef} is unavailable`);
    try{
      const parsed=JSON.parse(raw) as unknown;
      if(parsed&&typeof parsed==='object')return Object.fromEntries(Object.entries(parsed).filter((entry):entry is [string,string]=>typeof entry[1]==='string'&&entry[1].length>0));
    }catch{
      return {value:raw};
    }
    throw new Error(`Referenced secret ${secretRef} has an invalid payload`);
  }
  if(encryptedSecret){
    if(!env.BACKUP_SECRET_KEY)throw new Error('Encrypted secret key is unavailable');
    const decrypted=decryptSecretPayload(encryptedSecret,env.BACKUP_SECRET_KEY);
    if(typeof decrypted==='string')return {value:decrypted};
    return Object.fromEntries(Object.entries(decrypted??{}).filter((entry):entry is [string,string]=>typeof entry[1]==='string'));
  }
  return undefined;
}
