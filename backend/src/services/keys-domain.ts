import crypto from 'node:crypto';

export type KeyStatus='available'|'issued'|'overdue'|'lost'|'blocked'|'deactivated';
export type KeyMovement='created'|'issued'|'returned'|'lost'|'deactivated'|'blocked'|'reactivated';

const transitions:Record<KeyMovement,{from:KeyStatus[];to:KeyStatus|'preserve'}>={
  created:{from:['available'],to:'available'},
  issued:{from:['available'],to:'issued'},
  returned:{from:['issued'],to:'available'},
  lost:{from:['issued','blocked'],to:'lost'},
  blocked:{from:['available','issued','lost'],to:'blocked'},
  reactivated:{from:['blocked'],to:'available'},
  deactivated:{from:['available','issued','lost','blocked'],to:'deactivated'},
};

export function transitionKeyStatus(status:KeyStatus,movement:KeyMovement):KeyStatus{
  const transition=transitions[movement];
  if(!transition.from.includes(status)){
    throw Object.assign(new Error(`Ungültiger Schlüsselstatuswechsel: ${status} -> ${movement}`),{status:409,code:'KEY_INVALID_STATUS_TRANSITION'});
  }
  return transition.to==='preserve'?status:(transition.to as KeyStatus);
}

export function derivedKeyStatus(status:KeyStatus,dueAt:string|Date|null|undefined,now=new Date()):KeyStatus{
  if(status!=='issued'||!dueAt)return status;
  const due=new Date(dueAt).getTime();
  return Number.isFinite(due)&&due<now.getTime()?'overdue':'issued';
}

export function holderIsValid(holderUserId:string|null|undefined,holderEmployeeId:string|null|undefined){
  return (holderUserId?1:0)+(holderEmployeeId?1:0)===1;
}

export function canReturnKey(input:{actorUserId:string;holderUserId:string|null;operator:boolean}){
  return input.operator||input.actorUserId===input.holderUserId;
}

export function canAccessKeySite(siteId:string|null,scope:'tenant'|'site'|'system',siteIds:string[]){
  return scope==='tenant'||scope==='system'||(siteId!==null&&siteIds.includes(siteId));
}

export type BundleReturnKey={id:string;site_id:string|null;status:KeyStatus;holder_user_id:string|null;holder_employee_id:string|null};

export function validateBundleReturn(
  keys:BundleReturnKey[],
  requestedKeyIds:string[],
  actor:{actorUserId:string;operator:boolean},
){
  if(new Set(requestedKeyIds).size!==requestedKeyIds.length){
    throw Object.assign(new Error('Jeder Bundschlüssel darf nur einmal zurückgegeben werden'),{status:400,code:'KEY_BUNDLE_DUPLICATE_KEY'});
  }
  const byId=new Map(keys.map(key=>[key.id,key]));
  const selected=requestedKeyIds.map(keyId=>{
    const key=byId.get(keyId);
    if(!key)throw Object.assign(new Error('Jeder angeforderte Schlüssel muss zum Schlüsselbund gehören'),{status:404,code:'KEY_BUNDLE_MEMBER_NOT_FOUND'});
    if(key.status!=='issued')throw Object.assign(new Error(`Schlüssel ${key.id} ist nicht ausgegeben`),{status:409,code:'KEY_BUNDLE_INVALID_KEY_STATUS'});
    if(!canReturnKey({actorUserId:actor.actorUserId,holderUserId:key.holder_user_id,operator:actor.operator})){
      throw Object.assign(new Error(`Akteur darf Schlüssel ${key.id} nicht zurückgeben`),{status:403,code:'KEY_BUNDLE_RETURN_FORBIDDEN'});
    }
    return key;
  });
  return selected.sort((left,right)=>left.id.localeCompare(right.id));
}

export function bundleStatus(issuedCount:number,totalCount:number):'available'|'issued'|'partial'|'deactivated'{
  if(issuedCount===0)return 'available';
  return issuedCount===totalCount?'issued':'partial';
}

/** QR references carry only opaque identifiers and an expiry; never a key code, serial or site secret. */
export function buildKeyQrToken(secret:string,tenantId:string,keyId:string,expiresAt:Date|string){
  const payload=Buffer.from(JSON.stringify({tid:tenantId,kid:keyId,exp:new Date(expiresAt).toISOString()})).toString('base64url');
  const signature=crypto.createHmac('sha256',secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}
export function hashKeyQrToken(token:string){return crypto.createHash('sha256').update(token).digest('hex');}

export type QrTokenVerification=
  {valid:true;tenantId:string;keyId:string;expiresAt:string}
  |{valid:false;reason:'malformed'|'invalid_signature'|'expired'|'tenant_mismatch'|'key_mismatch'};

/** Constant-time HMAC verification with tenant, key and expiry binding. */
export function verifyKeyQrToken(
  secret:string,
  token:string,
  expected:{tenantId:string;keyId?:string},
  now=new Date(),
):QrTokenVerification{
  const fail=(reason:Exclude<QrTokenVerification,{valid:true}>['reason']):QrTokenVerification=>({valid:false,reason});
  if(typeof token!=='string'||token.length<20||token.length>4096||token.split('.').length!==2)return fail('malformed');
  const [payloadPart,signaturePart]=token.split('.');
  if(!/^[A-Za-z0-9_-]+$/.test(payloadPart)||!/^[A-Za-z0-9_-]+$/.test(signaturePart))return fail('malformed');
  let claims:unknown;
  try{claims=JSON.parse(Buffer.from(payloadPart,'base64url').toString('utf8'));}catch{return fail('malformed');}
  if(!claims||typeof claims!=='object')return fail('malformed');
  const {tid,kid,exp}=claims as Record<string,unknown>;
  if(typeof tid!=='string'||typeof kid!=='string'||typeof exp!=='string')return fail('malformed');
  const expiresAt=new Date(exp);
  if(!Number.isFinite(expiresAt.getTime()))return fail('malformed');
  const expectedSignature=crypto.createHmac('sha256',secret).update(payloadPart).digest();
  const providedSignature=Buffer.from(signaturePart,'base64url');
  if(expectedSignature.length!==providedSignature.length||!crypto.timingSafeEqual(expectedSignature,providedSignature))return fail('invalid_signature');
  if(tid!==expected.tenantId)return fail('tenant_mismatch');
  if(expected.keyId&&kid!==expected.keyId)return fail('key_mismatch');
  if(expiresAt.getTime()<=now.getTime())return fail('expired');
  return {valid:true,tenantId:tid,keyId:kid,expiresAt:expiresAt.toISOString()};
}
