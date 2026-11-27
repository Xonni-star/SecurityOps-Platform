import request from 'supertest';
import type {QueryResult} from 'pg';
import {beforeEach,describe,expect,it,jest} from '@jest/globals';

const oldSecret='a-strong-old-rotation-secret-value-1234567890abcdef';
const newSecret='a-strong-new-rotation-secret-value-fedcba9876543210';
process.env.NODE_ENV='test';
process.env.KEY_QR_SECRET=newSecret;
process.env.KEY_QR_SECRET_PREVIOUS=oldSecret;

const queryMock=jest.fn();
jest.unstable_mockModule('../src/db/pool.js',()=>({
  query:queryMock,
  withTransaction:async(work:(client:unknown)=>Promise<unknown>)=>work({query:queryMock}),
  withLoginContext:async(_value:string,work:()=>Promise<unknown>)=>work(),
  withSessionContext:async(_value:string,work:()=>Promise<unknown>)=>work(),
  withTenantContext:async(_value:string,work:()=>Promise<unknown>)=>work(),
}));

const {app}=await import('../src/app.js');
const {keyQrSecrets}=await import('../src/config/env.js');
const {buildKeyQrToken,hashKeyQrToken}=await import('../src/services/keys-domain.js');

const result=(rows:unknown[],rowCount=rows.length)=>({rows,rowCount}) as unknown as QueryResult;
const tenant='00000000-0000-4000-8000-000000000010';
const keyId='00000000-0000-4000-8000-000000000030';
const userId='00000000-0000-4000-8000-000000000001';
const sessionId='00000000-0000-4000-8000-000000000040';
const csrf={Cookie:['securityops_session=session-1','securityops_csrf=csrf-value'],'x-csrf-token':'csrf-value'};
const keyRow={id:keyId,site_id:null,key_code:'K-1001',label:'Haupteingang',status:'available'};
const session={id:userId,tenantId:tenant,email:'admin@example.invalid',role:'admin',
  permissions:['keys:qr:read'],permission_grants:[{code:'keys:qr:read',scope:'tenant'}],
  site_ids:[],is_system_admin:false,session_id:sessionId,csrf_token:'csrf-value',
  expires_at:'2099-01-01',device_id:'00000000-0000-4000-8000-000000000041'};

beforeEach(()=>{
  queryMock.mockReset();
  queryMock.mockImplementation(async(sql:string,values:unknown[])=>{
    const text=String(sql);
    if(text.includes('FROM sessions'))return result([session]);
    if(text.includes('SELECT * FROM keys WHERE'))return result([keyRow]);
    if(text.includes('SELECT id FROM key_qr_tokens')){
      // Sowohl die neue als auch die noch nicht abgelaufene alte Referenz
      // liegen in der Datenbank; der Hash wird jeweils mitgeliefert.
      expect(values[2]).toMatch(/^[a-f0-9]{64}$/);
      return result([{id:'qr-stored'}]);
    }
    if(text.includes('INSERT INTO audit_events'))return result([],1);
    return result([]);
  });
});

const expiresAt=()=>new Date(Date.now()+600000);
const oldToken=buildKeyQrToken(oldSecret,tenant,keyId,expiresAt());

describe('KEY_QR_SECRET rotation over HTTP',()=>{
  it('exposes only the active secret for signing but verifies with previous secrets',async()=>{
    expect(keyQrSecrets).toEqual([newSecret,oldSecret]);
    const verification=async(ref:string)=>request(app).get(`/api/v1/keys/${keyId}/qr/verify`).query({ref}).set(csrf);
    const issued=await verification(buildKeyQrToken(newSecret,tenant,keyId,expiresAt()));
    expect(issued.status).toBe(200);
    const rotated=await verification(oldToken);
    expect(rotated.status).toBe(200);
    expect(rotated.body).toMatchObject({valid:true,key_id:keyId,key_code:'K-1001'});
    expect(queryMock.mock.calls.some(([sql,values])=>String(sql).includes('SELECT id FROM key_qr_tokens')&&values?.[2]===hashKeyQrToken(oldToken))).toBe(true);
    const foreign=await verification(buildKeyQrToken('a-completely-different-strong-secret-0123456789abcdef',tenant,keyId,expiresAt()));
    expect(foreign.status).toBe(400);
    expect(foreign.body.code).toBe('KEY_QR_INVALID');
  });
});
