import {api,csrf} from './api';

export type MobileEventKind='patrol_scan'|'panic';
export type MobileOutboxItem={id:string;kind:MobileEventKind;path:string;body:Record<string,unknown>;createdAt:string;status:'pending'|'conflict';error?:string};

const DB_NAME='securityops-mobile';
const STORE='outbox';
const KEY_STORE='keys';
let database:Promise<IDBDatabase>|undefined;

function openDatabase(){
  if(database)return database;
  database=new Promise((resolve,reject)=>{
    const request=indexedDB.open(DB_NAME,2);
    request.onupgradeneeded=()=>{const db=request.result;if(!db.objectStoreNames.contains(STORE))db.createObjectStore(STORE,{keyPath:'id'});if(!db.objectStoreNames.contains(KEY_STORE))db.createObjectStore(KEY_STORE);};
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
  return database;
}

async function transaction(storeName:string,mode:IDBTransactionMode,run:(store:IDBObjectStore)=>void){
  const db=await openDatabase();
  return new Promise<void>((resolve,reject)=>{
    const tx=db.transaction(storeName,mode);
    run(tx.objectStore(storeName));
    tx.oncomplete=()=>resolve();
    tx.onerror=()=>reject(tx.error);
  });
}

async function getKey(){
  const db=await openDatabase();
  return new Promise<CryptoKey>((resolve,reject)=>{
    const tx=db.transaction(KEY_STORE,'readwrite');
    const store=tx.objectStore(KEY_STORE);
    const request=store.get('outbox-key');
    request.onsuccess=async()=>{if(request.result){resolve(request.result);return;}const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt','decrypt']);store.put(key,'outbox-key');resolve(key);};
    request.onerror=()=>reject(request.error);
  });
}

async function encryptBody(body:Record<string,unknown>){
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv},await getKey(),new TextEncoder().encode(JSON.stringify(body)));
  return {iv:Array.from(iv),ciphertext:Array.from(new Uint8Array(ciphertext))};
}

async function decryptBody(iv:number[],ciphertext:number[]){
  const plaintext=await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(iv)},await getKey(),new Uint8Array(ciphertext));
  return JSON.parse(new TextDecoder().decode(plaintext)) as Record<string,unknown>;
}

export async function listOutbox():Promise<MobileOutboxItem[]>{
  const db=await openDatabase();
  return new Promise((resolve,reject)=>{
    const request=db.transaction(STORE,'readonly').objectStore(STORE).getAll();
    request.onsuccess=async()=>{try{const records=await Promise.all((request.result as Array<MobileOutboxItem&{iv:number[];ciphertext:number[]}>).map(async record=>({...record,body:await decryptBody(record.iv,record.ciphertext)})));resolve(records.sort((a,b)=>a.createdAt.localeCompare(b.createdAt)));}catch(error){reject(error);}};
    request.onerror=()=>reject(request.error);
  });
}

export async function enqueue(item:Omit<MobileOutboxItem,'id'|'createdAt'|'status'>){
  const record:MobileOutboxItem={...item,id:crypto.randomUUID(),createdAt:new Date().toISOString(),status:'pending'};
  const encrypted=await encryptBody(record.body);
  await transaction(STORE,'readwrite',store=>store.add({...record,body:undefined,...encrypted}));
  return record;
}

async function update(item:MobileOutboxItem){
  const encrypted=await encryptBody(item.body);
  await transaction(STORE,'readwrite',store=>store.put({...item,body:undefined,...encrypted}));
}

export async function syncOutbox(){
  const items=await listOutbox();
  const results:{synced:number;conflicts:number;remaining:number}={synced:0,conflicts:0,remaining:0};
  for(const item of items){
    if(item.status==='conflict'){results.conflicts++;continue;}
    try{
      const response=await fetch(item.path,{method:'POST',credentials:'include',headers:{'Content-Type':'application/json','x-csrf-token':csrf(),'Idempotency-Key':String(item.body.client_event_id)},body:JSON.stringify(item.body)});
      if(response.status===409){
        await update({...item,status:'conflict',error:'Server meldet einen Konflikt; manuelle Prüfung erforderlich.'});
        results.conflicts++;
      }else if(!response.ok){
        throw new Error(`Synchronisation fehlgeschlagen (${response.status})`);
      }else{
        await transaction(STORE,'readwrite',store=>store.delete(item.id));
        results.synced++;
      }
    }catch(error){
      await update({...item,error:error instanceof Error?error.message:'Netzwerkfehler'});
      results.remaining++;
      break;
    }
  }
  return results;
}

export function watchConnection(onChange:()=>void){
  window.addEventListener('online',onChange);
  window.addEventListener('offline',onChange);
  return ()=>{window.removeEventListener('online',onChange);window.removeEventListener('offline',onChange);};
}

export async function loadPatrolRoutes(){
  return api<Array<{id:string;name:string;site_id:string}>>('/patrol-routes');
}
