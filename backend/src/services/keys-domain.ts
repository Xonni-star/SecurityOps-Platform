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
    throw Object.assign(new Error(`Invalid key status transition: ${status} -> ${movement}`),{status:409,code:'KEY_INVALID_STATUS_TRANSITION'});
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
    throw Object.assign(new Error('Each bundle key may only be returned once'),{status:400,code:'KEY_BUNDLE_DUPLICATE_KEY'});
  }
  const byId=new Map(keys.map(key=>[key.id,key]));
  const selected=requestedKeyIds.map(keyId=>{
    const key=byId.get(keyId);
    if(!key)throw Object.assign(new Error('Every requested key must belong to the bundle'),{status:404,code:'KEY_BUNDLE_MEMBER_NOT_FOUND'});
    if(key.status!=='issued')throw Object.assign(new Error(`Key ${key.id} is not issued`),{status:409,code:'KEY_BUNDLE_INVALID_KEY_STATUS'});
    if(!canReturnKey({actorUserId:actor.actorUserId,holderUserId:key.holder_user_id,operator:actor.operator})){
      throw Object.assign(new Error(`Actor may not return key ${key.id}`),{status:403,code:'KEY_BUNDLE_RETURN_FORBIDDEN'});
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
