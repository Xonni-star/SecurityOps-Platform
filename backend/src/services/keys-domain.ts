export type KeyStatus='available'|'issued'|'lost'|'deactivated';
export type KeyMovement='created'|'issued'|'returned'|'lost'|'deactivated';

const transitions:Record<KeyMovement,{from:KeyStatus[];to:KeyStatus}>={
  created:{from:['available'],to:'available'},
  issued:{from:['available'],to:'issued'},
  returned:{from:['issued'],to:'available'},
  lost:{from:['issued'],to:'lost'},
  deactivated:{from:['available','issued','lost'],to:'deactivated'},
};

export function transitionKeyStatus(status:KeyStatus,movement:KeyMovement){
  const transition=transitions[movement];
  if(!transition.from.includes(status)){
    throw Object.assign(new Error(`Invalid key status transition: ${status} -> ${movement}`),{status:409,code:'KEY_INVALID_STATUS_TRANSITION'});
  }
  return transition.to;
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
