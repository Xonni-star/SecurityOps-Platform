import request from 'supertest';
import type {QueryResult} from 'pg';
import {beforeEach,describe,expect,it,jest} from '@jest/globals';

const queryMock=jest.fn();
jest.unstable_mockModule('../src/db/pool.js',()=>({
  query:queryMock,
  withTransaction:async(work:(client:unknown)=>Promise<unknown>)=>work({query:queryMock}),
  withLoginContext:async(_value:string,work:()=>Promise<unknown>)=>work(),
  withSessionContext:async(_value:string,work:()=>Promise<unknown>)=>work(),
  withTenantContext:async(_value:string,work:()=>Promise<unknown>)=>work(),
}));

const {app}=await import('../src/app.js');
const tenant='00000000-0000-4000-8000-00000000000a';
const site='00000000-0000-4000-8000-0000000000aa';
const documentId='00000000-0000-4000-8000-0000000000b1';
const uploader='00000000-0000-4000-8000-000000000001';
const reviewer='00000000-0000-4000-8000-000000000002';
const result=(rows:unknown[],rowCount=rows.length)=>({rows,rowCount}) as unknown as QueryResult;
const csrf=['securityops_session=opaque','securityops_csrf=csrf-value'];
let activeUser:Record<string,unknown>;

const baseUser={
  id:reviewer,tenantId:tenant,email:'reviewer@example.invalid',role:'admin',
  permissions:['dms:read','dms:write','sites:read'],permission_grants:[],site_ids:[site],
  is_system_admin:false,session_id:'00000000-0000-4000-8000-0000000000ac',
  csrf_token:'csrf-value',expires_at:'2099-01-01',device_id:'00000000-0000-4000-8000-0000000000ee',
};
const document={
  id:documentId,tenant_id:tenant,site_id:site,title:'Security plan',document_status:'active',
  approval_status:'pending_approval',created_by:uploader,valid_from:null,valid_until:null,review_on:null,
};
const approved={...document,approval_status:'approved',approved_by:reviewer,approved_at:'2026-01-01T00:00:00Z'};
const availableVersion={lifecycle_state:'available'};

beforeEach(()=>{
  queryMock.mockReset();
  activeUser=baseUser;
  queryMock.mockImplementation(async(sql:string)=>{
    if(sql.includes('FROM sessions'))return result([activeUser]);
    if(sql.includes('FROM dms_documents WHERE'))return result([document]);
    if(sql.includes('FROM dms_versions'))return result([availableVersion]);
    if(sql.includes('UPDATE dms_documents'))return result([approved]);
    return result([]);
  });
});

describe('DMS approval workflow',()=>{
  it('approves only a document with a released version and records the approver',async()=>{
    const response=await request(app).post(`/api/v1/dms/documents/${documentId}/approve`).set('Cookie',csrf).set('x-csrf-token','csrf-value').send({});
    expect(response.status).toBe(200);
    expect(response.body.computed_status).toBe('gueltig');
    expect(response.body.approved_by).toBe(reviewer);
    const update=queryMock.mock.calls.find(([sql])=>String(sql).includes('UPDATE dms_documents'));
    expect(String(update?.[0])).toContain("approval_status='approved'");
    expect(update?.[1]).toEqual([tenant,documentId,reviewer]);
    const audit=queryMock.mock.calls.find(([sql])=>String(sql).includes('INSERT INTO audit_events'));
    expect(audit?.[1]?.[2]).toBe('dms.document.approved');
  });

  it('blocks uploaders from approving their own document',async()=>{
    activeUser={...baseUser,id:uploader};
    const response=await request(app).post(`/api/v1/dms/documents/${documentId}/approve`).set('Cookie',csrf).set('x-csrf-token','csrf-value').send({});
    expect(response.status).toBe(403);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('UPDATE dms_documents'))).toBe(false);
  });

  it('refuses approval while no released version exists',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([activeUser]);
      if(sql.includes('FROM dms_documents WHERE'))return result([document]);
      if(sql.includes('FROM dms_versions'))return result([{lifecycle_state:'quarantined'}]);
      return result([]);
    });
    const response=await request(app).post(`/api/v1/dms/documents/${documentId}/approve`).set('Cookie',csrf).set('x-csrf-token','csrf-value').send({});
    expect(response.status).toBe(409);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('UPDATE dms_documents'))).toBe(false);
  });

  it('does not allow approval status to be set through the metadata endpoint',async()=>{
    const response=await request(app).patch(`/api/v1/dms/documents/${documentId}`).set('Cookie',csrf).set('x-csrf-token','csrf-value').send({approval_status:'approved'});
    expect(response.status).toBe(400);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('UPDATE dms_documents'))).toBe(false);
  });

  it('does not allow approval status to be set during upload',async()=>{
    const response=await request(app).post('/api/v1/dms/documents').set('Cookie',csrf).set('x-csrf-token','csrf-value').send({
      title:'Security plan',content_type:'application/pdf',content_base64:Buffer.from('document').toString('base64'),
      client_mutation_id:'00000000-0000-4000-8000-0000000000f1',approval_status:'approved',
    });
    expect(response.status).toBe(400);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('INSERT INTO dms_documents'))).toBe(false);
  });

  it('returns a document for revision with a mandatory reason',async()=>{
    const missingReason=await request(app).post(`/api/v1/dms/documents/${documentId}/return-for-revision`).set('Cookie',csrf).set('x-csrf-token','csrf-value').send({});
    expect(missingReason.status).toBe(400);
    const response=await request(app).post(`/api/v1/dms/documents/${documentId}/return-for-revision`).set('Cookie',csrf).set('x-csrf-token','csrf-value').send({reason:'Unterschrift fehlt'});
    expect(response.status).toBe(200);
    const audit=queryMock.mock.calls.find(([sql])=>String(sql).includes('INSERT INTO audit_events'));
    expect(audit?.[1]?.[2]).toBe('dms.document.returned_for_revision');
  });
});
