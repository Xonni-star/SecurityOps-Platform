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
const versionId='00000000-0000-4000-8000-0000000000c1';
const csrf=['securityops_session=opaque','securityops_csrf=csrf-value'];
const result=(rows:unknown[],rowCount=rows.length)=>({rows,rowCount}) as unknown as QueryResult;
const baseUser={
  id:'00000000-0000-4000-8000-000000000002',tenantId:tenant,email:'pruefer@example.invalid',role:'admin',
  permissions:['dms:read','dms:write','dms:delete','sites:read'],permission_grants:[],site_ids:[site],
  is_system_admin:false,session_id:'00000000-0000-4000-8000-0000000000ac',csrf_token:'csrf-value',
  expires_at:'2099-01-01',device_id:'00000000-0000-4000-8000-0000000000ee',
};
const documentRow={
  id:documentId,tenant_id:tenant,site_id:site,title:'Sicherheitskonzept',description:null,
  document_status:'active',approval_status:'approved',document_number:'DMS-1',document_type:'Konzept',
  customer_id:null,employee_id:null,responsible_employee_id:null,valid_from:null,valid_until:'2027-01-01',
  review_on:null,created_at:'2026-01-01T00:00:00Z',updated_at:'2026-01-02T00:00:00Z',approved_at:'2026-01-03T00:00:00Z',reviewed_at:'2026-01-03T00:00:00Z',
  created_by:'00000000-0000-4000-8000-000000000001',created_by_email:'autor@example.invalid',
  site_name:'Objekt Nord',customer_name:null,employee_name:null,responsible_employee_name:null,
  versions:[{id:versionId,version_no:1,lifecycle_state:'available',size_bytes:128,content_type:'application/pdf'}],
};
let currentDocument:Record<string,unknown>;
let activeUser:Record<string,unknown>;

beforeEach(()=>{
  currentDocument={...documentRow};activeUser=baseUser;
  queryMock.mockReset();
  queryMock.mockImplementation(async(sql:string)=>{
    const text=String(sql);
    if(text.includes('FROM sessions'))return result([activeUser]);
    if(text.includes('FROM dms_documents d LEFT JOIN dms_versions'))return result([currentDocument]);
    if(text.includes('FROM dms_documents WHERE'))return result([currentDocument]);
    if(text.includes('UPDATE dms_documents')){
      const archived=text.includes("SET approval_status='archived'");
      const removed=text.includes("SET document_status='deleted'");
      const next=archived?'archived':removed?'deleted':'draft';
      return result([{...currentDocument,approval_status:next==='deleted'?'draft':next,...(next==='deleted'?{document_status:'deleted',deleted_at:'2026-02-01T00:00:00Z'}:{})}]);
    }
    if(text.includes('FROM audit_events a LEFT JOIN users u'))return result([{
      id:versionId,event_type:'dms.document.approved',entity_type:'dms_document',entity_id:documentId,
      details:{version_no:1},created_at:'2026-01-03T00:00:00Z',actor_email:baseUser.email,
    }]);
    if(text.includes('INSERT INTO audit_events'))return result([],1);
    return result([]);
  });
});

describe('DMS Professionalisierung – Abfrage, Kennzahlen und Workflow',()=>{
  it('liefert serverseitig gefilterte und paginierte Dokumente mit Kennzahlen',async()=>{
    const response=await request(app).get('/api/v1/dms/documents/query')
      .query({q:'Sicherheitskonzept',approval_status:'approved',sort:'title',order:'asc',page:1,page_size:10})
      .set('Cookie',csrf);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({total:1,page:1,pages:1,page_size:10}));
    expect(response.body.rows[0]).toEqual(expect.objectContaining({title:'Sicherheitskonzept',computed_status:'gueltig',status_label:'Gültig'}));
    expect(response.body.stats).toEqual(expect.objectContaining({total:1,draft:0,approved:1}));
    expect(response.body.filter_options.sites).toEqual([{id:site,name:'Objekt Nord'}]);
    const call=queryMock.mock.calls.find(([sql])=>String(sql).includes('FROM dms_documents d LEFT JOIN dms_versions'));
    expect(String(call?.[0])).toContain('d.title ILIKE');
    expect(String(call?.[0])).toContain('d.approval_status=$');
  });

  it('weist manipulierte Filter und ungültige UUIDs serverseitig zurück',async()=>{
    const unknown=await request(app).get('/api/v1/dms/documents/query').query({sort:'geheim'}).set('Cookie',csrf);
    expect(unknown.status).toBe(400);
    const badId=await request(app).get('/api/v1/dms/documents/query').query({device_id:'kein-uuid'}).set('Cookie',csrf);
    expect(badId.status).toBe(400);
    const injected=await request(app).get('/api/v1/dms/documents/query').query({q:'x',limit:'1;DROP TABLE dms_documents'}).set('Cookie',csrf);
    expect(injected.status).toBe(400);
  });

  it('stellt dieselben Kennzahlen und offenen Freigaben über die Übersicht bereit',async()=>{
    currentDocument={...documentRow,approval_status:'pending_approval'};
    const response=await request(app).get('/api/v1/dms/overview').set('Cookie',csrf);
    expect(response.status).toBe(200);
    expect(response.body.stats.pending_approval).toBe(1);
    expect(response.body.approvals).toEqual([expect.objectContaining({id:documentId,title:'Sicherheitskonzept',created_by_email:'autor@example.invalid'})]);
  });

  it('archiviert, stellt wieder her und protokolliert jeden Statuswechsel',async()=>{
    const archived=await request(app).post(`/api/v1/dms/documents/${documentId}/archive`).set('Cookie',csrf).set('x-csrf-token','csrf-value').send({});
    expect(archived.status).toBe(200);
    expect(archived.body.approval_status).toBe('archived');
    currentDocument={...documentRow,approval_status:'archived'};
    const restored=await request(app).post(`/api/v1/dms/documents/${documentId}/restore`).set('Cookie',csrf).set('x-csrf-token','csrf-value').send({});
    expect(restored.status).toBe(200);
    expect(restored.body.approval_status).toBe('draft');
    const events=queryMock.mock.calls.filter(([,values])=>values?.[2]?.toString().startsWith('dms.document.'));
    expect(events.map(([,values])=>values[2])).toEqual(expect.arrayContaining(['dms.document.archived','dms.document.restored']));
  });

  it('lernt ein Dokument nur mit zwingender Begründung löschen',async()=>{
    const missing=await request(app).delete(`/api/v1/dms/documents/${documentId}`).set('Cookie',csrf).set('x-csrf-token','csrf-value').send({});
    expect(missing.status).toBe(400);
    const deleted=await request(app).delete(`/api/v1/dms/documents/${documentId}`).set('Cookie',csrf).set('x-csrf-token','csrf-value').send({reason:'Aufbewahrungsfrist abgelaufen'});
    expect(deleted.status).toBe(200);
    expect(deleted.body.document_status).toBe('deleted');
    const audit=queryMock.mock.calls.find(([,values])=>values?.[2]==='dms.document.deleted');
    expect(audit?.[1]?.[5]).toEqual({reason:'Aufbewahrungsfrist abgelaufen'});
  });

  it('verweigert Schreibzugriff auf gelöschte Dokumente',async()=>{
    currentDocument={...documentRow,document_status:'deleted',deleted_at:'2026-02-01T00:00:00Z'};
    const response=await request(app).post(`/api/v1/dms/documents/${documentId}/archive`).set('Cookie',csrf).set('x-csrf-token','csrf-value').send({});
    expect(response.status).toBe(409);
    expect(response.body.error).toContain('gelöscht');
  });

  it('gibt die Audit-Historie eines Dokuments zurück',async()=>{
    const response=await request(app).get(`/api/v1/dms/documents/${documentId}/history`).set('Cookie',csrf);
    expect(response.status).toBe(200);
    expect(response.body[0]).toEqual(expect.objectContaining({event_type:'dms.document.approved',actor_email:baseUser.email}));
  });
});
