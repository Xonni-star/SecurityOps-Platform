import {describe,expect,it} from '@jest/globals';
import {canAccessResource} from '../src/types/authorization.js';
import {bundleStatus,canReturnKey,holderIsValid,transitionKeyStatus,validateBundleReturn} from '../src/services/keys-domain.js';

describe('key management domain',()=>{
  it('keeps tenant and site scope isolated',()=>{
    const context={userId:'u1',tenantId:'t1',role:'operator',isSystemAdmin:false,siteIds:['s1'],grants:[]};
    expect(canAccessResource(context,'site',{tenantId:'t1',siteId:'s1'})).toBe(true);
    expect(canAccessResource(context,'site',{tenantId:'t1',siteId:'s2'})).toBe(false);
    expect(canAccessResource(context,'tenant',{tenantId:'t2'})).toBe(false);
  });
  it('enforces one holder and the canonical status machine',()=>{
    expect(holderIsValid('u1',null)).toBe(true);
    expect(holderIsValid(null,'e1')).toBe(true);
    expect(holderIsValid('u1','e1')).toBe(false);
    expect(transitionKeyStatus('available','issued')).toBe('issued');
    expect(transitionKeyStatus('issued','returned')).toBe('available');
    expect(transitionKeyStatus('issued','lost')).toBe('lost');
    expect(transitionKeyStatus('lost','deactivated')).toBe('deactivated');
    expect(()=>transitionKeyStatus('available','returned')).toThrow('Invalid key status transition');
    expect(()=>transitionKeyStatus('deactivated','issued')).toThrow('Invalid key status transition');
    expect(()=>transitionKeyStatus('issued','issued')).toThrow('Invalid key status transition');
  });
  it('allows return only to the holder or an operator',()=>{
    expect(canReturnKey({actorUserId:'u1',holderUserId:'u1',operator:false})).toBe(true);
    expect(canReturnKey({actorUserId:'u2',holderUserId:'u1',operator:false})).toBe(false);
    expect(canReturnKey({actorUserId:'u2',holderUserId:'u1',operator:true})).toBe(true);
  });
  it('checks every requested bundle key before allowing a partial return',()=>{
    const keys=[
      {id:'key-a',site_id:null,status:'issued' as const,holder_user_id:'u1',holder_employee_id:null},
      {id:'key-b',site_id:null,status:'issued' as const,holder_user_id:'u1',holder_employee_id:null},
    ];
    expect(validateBundleReturn(keys,['key-b','key-a'],{actorUserId:'u1',operator:false}).map(key=>key.id)).toEqual(['key-a','key-b']);
    expect(()=>validateBundleReturn(keys,['key-a','missing'],{actorUserId:'u1',operator:false})).toThrow('Every requested key must belong to the bundle');
    expect(()=>validateBundleReturn([{...keys[0],status:'lost' as const},keys[1]],['key-a','key-b'],{actorUserId:'u1',operator:false})).toThrow('is not issued');
  });
  it('keeps partial bundle returns visible until every member is returned',()=>{
    expect(bundleStatus(0,3)).toBe('available');
    expect(bundleStatus(3,3)).toBe('issued');
    expect(bundleStatus(1,3)).toBe('partial');
    expect(bundleStatus(2,3)).toBe('partial');
  });
});
