import {describe,expect,it} from '@jest/globals';
import {canAccessResource} from '../src/types/authorization.js';
import {bundleStatus,buildKeyQrToken,canReturnKey,derivedKeyStatus,hashKeyQrToken,holderIsValid,transitionKeyStatus,validateBundleReturn,verifyKeyQrToken} from '../src/services/keys-domain.js';

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
    expect(holderIsValid(null,null)).toBe(false);
    expect(transitionKeyStatus('available','issued')).toBe('issued');
    expect(transitionKeyStatus('issued','returned')).toBe('available');
    expect(transitionKeyStatus('issued','lost')).toBe('lost');
    expect(transitionKeyStatus('lost','deactivated')).toBe('deactivated');
    expect(()=>transitionKeyStatus('available','returned')).toThrow('Ungültiger Schlüsselstatuswechsel');
    expect(()=>transitionKeyStatus('deactivated','issued')).toThrow('Ungültiger Schlüsselstatuswechsel');
    expect(()=>transitionKeyStatus('issued','issued')).toThrow('Ungültiger Schlüsselstatuswechsel');
  });
  it('supports technical block and reactivation without losing history',()=>{
    expect(transitionKeyStatus('available','blocked')).toBe('blocked');
    expect(transitionKeyStatus('issued','blocked')).toBe('blocked');
    expect(transitionKeyStatus('lost','blocked')).toBe('blocked');
    expect(transitionKeyStatus('blocked','reactivated')).toBe('available');
    expect(()=>transitionKeyStatus('blocked','returned')).toThrow('Ungültiger Schlüsselstatuswechsel');
    expect(()=>transitionKeyStatus('available','reactivated')).toThrow('Ungültiger Schlüsselstatuswechsel');
    expect(()=>transitionKeyStatus('deactivated','blocked')).toThrow('Ungültiger Schlüsselstatuswechsel');
  });
  it('derives overdue only for issued keys past their due date',()=>{
    const now=new Date('2026-06-15T12:00:00.000Z');
    expect(derivedKeyStatus('issued','2026-06-14T12:00:00.000Z',now)).toBe('overdue');
    expect(derivedKeyStatus('issued','2026-06-16T12:00:00.000Z',now)).toBe('issued');
    expect(derivedKeyStatus('issued',null,now)).toBe('issued');
    expect(derivedKeyStatus('available','2020-01-01T00:00:00.000Z',now)).toBe('available');
    expect(derivedKeyStatus('blocked','2020-01-01T00:00:00.000Z',now)).toBe('blocked');
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
    expect(()=>validateBundleReturn(keys,['key-a','missing'],{actorUserId:'u1',operator:false})).toThrow('Jeder angeforderte Schlüssel muss zum Schlüsselbund gehören');
    expect(()=>validateBundleReturn([{...keys[0],status:'lost' as const},keys[1]],['key-a','key-b'],{actorUserId:'u1',operator:false})).toThrow('ist nicht ausgegeben');
    expect(()=>validateBundleReturn(keys,['key-a','key-a'],{actorUserId:'u1',operator:false})).toThrow('nur einmal zurückgegeben werden');
    expect(()=>validateBundleReturn(keys,['key-a'],{actorUserId:'u2',operator:false})).toThrow('nicht zurückgeben');
  });
  it('keeps partial bundle returns visible until every member is returned',()=>{
    expect(bundleStatus(0,3)).toBe('available');
    expect(bundleStatus(3,3)).toBe('issued');
    expect(bundleStatus(1,3)).toBe('partial');
    expect(bundleStatus(2,3)).toBe('partial');
  });
  it('builds opaque, signed QR tokens without leaking key secrets',()=>{
    const secret='super-secret-signing-key';
    const expiresAt='2026-06-15T12:15:00.000Z';
    const token=buildKeyQrToken(secret,'11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',expiresAt);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const payload=Buffer.from(token.split('.')[0],'base64url').toString('utf8');
    expect(payload).toContain('11111111-1111-4111-8111-111111111111');
    expect(payload).toContain(expiresAt);
    expect(payload).not.toContain(secret);
    expect(payload).not.toMatch(/key_code|serial|site_secret|secret/i);
    expect(hashKeyQrToken(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashKeyQrToken(token)).not.toBe(hashKeyQrToken(`${token}x`));
  });
  it('verifies QR signatures with tenant, key and expiry binding',()=>{
    const secret='a-strong-test-secret-value-with-entropy-12345';
    const tenantId='11111111-1111-4111-8111-111111111111';
    const keyId='22222222-2222-4222-8222-222222222222';
    const now=new Date('2026-06-15T12:00:00.000Z');
    const token=buildKeyQrToken(secret,tenantId,keyId,new Date('2026-06-15T12:15:00.000Z'));
    expect(verifyKeyQrToken(secret,token,{tenantId,keyId},now)).toEqual({
      valid:true,tenantId,keyId,expiresAt:'2026-06-15T12:15:00.000Z',
    });
    const [payload,signature]=token.split('.');
    const flipped=`${payload}.${signature.slice(0,-1)}${signature.at(-1)==='A'?'B':'A'}`;
    expect(verifyKeyQrToken(secret,flipped,{tenantId,keyId},now)).toEqual({valid:false,reason:'invalid_signature'});
    expect(verifyKeyQrToken(secret,token,{tenantId:'33333333-3333-4333-8333-333333333333',keyId},now)).toEqual({valid:false,reason:'tenant_mismatch'});
    expect(verifyKeyQrToken(secret,token,{tenantId,keyId:'44444444-4444-4444-8444-444444444444'},now)).toEqual({valid:false,reason:'key_mismatch'});
    expect(verifyKeyQrToken(secret,token,{tenantId,keyId},new Date('2026-06-15T12:16:00.000Z'))).toEqual({valid:false,reason:'expired'});
    expect(verifyKeyQrToken(secret,'not-a-token',{tenantId,keyId},now)).toEqual({valid:false,reason:'malformed'});
  });
  it('rejects QR tokens after secret rotation',()=>{
    const oldSecret='a-strong-test-secret-value-with-entropy-12345';
    const newSecret='a-different-strong-test-secret-value-67890!';
    const tenantId='11111111-1111-4111-8111-111111111111';
    const keyId='22222222-2222-4222-8222-222222222222';
    const token=buildKeyQrToken(oldSecret,tenantId,keyId,'2026-06-15T12:15:00.000Z');
    const now=new Date('2026-06-15T12:00:00.000Z');
    expect(verifyKeyQrToken(oldSecret,token,{tenantId,keyId},now)).toMatchObject({valid:true});
    expect(verifyKeyQrToken(newSecret,token,{tenantId,keyId},now)).toEqual({valid:false,reason:'invalid_signature'});
  });
  it('accepts references signed by a previous key during rotation but rejects them afterwards',()=>{
    const oldSecret='a-strong-test-secret-value-with-entropy-12345';
    const newSecret='a-different-strong-test-secret-value-67890!';
    const tenantId='11111111-1111-4111-8111-111111111111';
    const keyId='22222222-2222-4222-8222-222222222222';
    const token=buildKeyQrToken(oldSecret,tenantId,keyId,'2026-06-15T12:15:00.000Z');
    const now=new Date('2026-06-15T12:00:00.000Z');
    expect(verifyKeyQrToken([newSecret,oldSecret],token,{tenantId,keyId},now)).toMatchObject({valid:true});
    expect(verifyKeyQrToken([newSecret],token,{tenantId,keyId},now)).toEqual({valid:false,reason:'invalid_signature'});
    const forged=buildKeyQrToken(oldSecret,tenantId,'33333333-3333-4333-8333-333333333333','2026-06-15T12:15:00.000Z');
    expect(verifyKeyQrToken([newSecret,oldSecret],forged,{tenantId,keyId},now)).toEqual({valid:false,reason:'key_mismatch'});
  });
});
