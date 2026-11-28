import request from 'supertest';
import {createHash} from 'node:crypto';
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
const {configureDmsAdapters}=await import('../src/routes/dms.js');
const tenant='00000000-0000-4000-8000-00000000000a';
const site='00000000-0000-4000-8000-0000000000aa';
const otherSite='00000000-0000-4000-8000-0000000000ab';
const documentId='00000000-0000-4000-8000-0000000000b1';
const versionId='00000000-0000-4000-8000-0000000000c1';
const uploader='00000000-0000-4000-8000-000000000001';
const customer='00000000-0000-4000-8000-0000000000dd';
const content=Buffer.from('Vertraulicher Dokumentinhalt');
const csrf=['securityops_session=opaque','securityops_csrf=csrf-value'];
const result=(rows:unknown[],rowCount=rows.length)=>({rows,rowCount}) as unknown as QueryResult;
const baseUser={
  id:'00000000-0000-4000-8000-000000000002',tenantId:tenant,email:'pruefer@example.invalid',role:'admin',
  permissions:['dms:read','dms:write','dms:delete','dms:backup:read','sites:read'],permission_grants:[],site_ids:[site],
  is_system_admin:false,session_id:'00000000-0000-4000-8000-0000000000ac',
  csrf_token:'csrf-value',expires_at:'2099-01-01',device_id:'00000000-0000-4000-8000-0000000000ee',
};
const documentRow={
  id:documentId,tenant_id:tenant,site_id:site,title:'Sicherheitskonzept',description:null,
  document_status:'active',approval_status:'pending_approval',document_number:'DMS-1',document_type:'Konzept',
  customer_id:null,employee_id:null,responsible_employee_id:null,valid_from:null,valid_until:'2027-01-01',
  review_on:null,created_by:uploader,created_at:'2026-01-01T00:00:00Z',updated_at:'2026-01-02T00:00:00Z',
  approved_at:null,reviewed_at:null,created_by_email:'autor@example.invalid',site_name:'Objekt Nord',
  customer_name:null,employee_name:null,responsible_employee_name:null,
  versions:[{id:versionId,version_no:1,lifecycle_state:'available',size_bytes:content.byteLength,content_type:'text/plain'}],
};
let activeUser:Record<string,unknown>;
let currentDocument:Record<string,unknown>;
let currentVersion:Record<string,unknown>|null;

beforeEach(()=>{
  activeUser=baseUser;
  currentDocument={...documentRow};
  currentVersion={
    ...documentRow,id:versionId,document_id:documentId,lifecycle_state:'available',version_no:1,
    object_key:`dms/${documentId}/1`,size_bytes:content.byteLength,content_type:'text/plain',
    sha256:createHash('sha256').update(content).digest('hex'),
  };
  configureDmsAdapters({
    put:async()=>undefined,
    get:async()=>({content,contentType:'text/plain'}),
    delete:async()=>undefined,
    ready:async()=>undefined,
  },{scan:async()=>({clean:true}),ready:async()=>undefined});
  queryMock.mockReset();
  queryMock.mockImplementation(async(sql:string)=>{
    const text=String(sql);
    if(text.includes('FROM sessions'))return result([activeUser]);
    if(text.includes('FROM dms_documents d LEFT JOIN dms_versions'))return result([currentDocument]);
    if(text.includes('FROM dms_documents d JOIN dms_versions v'))return result(currentVersion?[currentVersion]:[]);
    if(text.includes('FROM dms_documents WHERE'))return result([currentDocument]);
    if(text.includes('retention_until')&&text.includes('FROM dms_versions WHERE tenant_id'))return result([]);
    if(text.includes('FROM dms_versions WHERE'))return result([{lifecycle_state:'available',version_no:1}]);
    if(text.includes('UPDATE dms_documents'))return result([{...currentDocument,approval_status:'approved',approved_by:activeUser.id}]);
    if(text.includes('INSERT INTO audit_events'))return result([],1);
    if(text.includes('FROM dms_blob_backup_status'))return result([]);
    return result([]);
  });
});

describe('DMS-Rechtematrix für Dokumente, Objekte und Kunden',()=>{
  it('trennt Lesen, Prüfen, Archivieren, Löschen, Aufbewahrung und Backup nach Rechten',async()=>{
    activeUser={...baseUser,role:'viewer',id:'00000000-0000-4000-8000-000000000003',permissions:['dms:read','sites:read']};
    expect((await request(app).get('/api/v1/dms/documents/query').set('Cookie',csrf)).status).toBe(200);
    expect((await request(app).post(`/api/v1/dms/documents/${documentId}/approve`).set('Cookie',csrf).set('x-csrf-token','csrf-value').send({})).status).toBe(403);
    expect((await request(app).post(`/api/v1/dms/documents/${documentId}/archive`).set('Cookie',csrf).set('x-csrf-token','csrf-value').send({})).status).toBe(403);
    expect((await request(app).delete(`/api/v1/dms/documents/${documentId}`).set('Cookie',csrf).set('x-csrf-token','csrf-value').send({reason:'Test'})).status).toBe(403);
    expect((await request(app).post('/api/v1/dms/retention/apply').set('Cookie',csrf).set('x-csrf-token','csrf-value').send({})).status).toBe(403);
    expect((await request(app).get('/api/v1/dms/backup/status').set('Cookie',csrf)).status).toBe(403);
  });

  it('erlaubt Operatoren Prüfung und Archivierung, aber keine Löschung',async()=>{
    const response=await request(app).post(`/api/v1/dms/documents/${documentId}/approve`).set('Cookie',csrf).set('x-csrf-token','csrf-value').send({feedback:'Geprüft'});
    expect(response.status).toBe(200);
    activeUser={...baseUser,permissions:['dms:read','dms:write','sites:read']};
    expect((await request(app).post(`/api/v1/dms/documents/${documentId}/archive`).set('Cookie',csrf).set('x-csrf-token','csrf-value').send({})).status).toBe(200);
    expect((await request(app).delete(`/api/v1/dms/documents/${documentId}`).set('Cookie',csrf).set('x-csrf-token','csrf-value').send({reason:'Test'})).status).toBe(403);
  });

  it('erlaubt Administratoren Löschen, Aufbewahrungslauf und Backup-Status',async()=>{
    expect((await request(app).delete(`/api/v1/dms/documents/${documentId}`).set('Cookie',csrf).set('x-csrf-token','csrf-value').send({reason:'Aufbewahrungsfrist abgelaufen'})).status).toBe(200);
    expect((await request(app).post('/api/v1/dms/retention/apply').set('Cookie',csrf).set('x-csrf-token','csrf-value').send({})).status).toBe(200);
    expect((await request(app).get('/api/v1/dms/backup/status').set('Cookie',csrf)).status).toBe(200);
  });

  it('verweigert den Zugriff auf Dokumente außerhalb der zugewiesenen Objekte',async()=>{
    activeUser={...baseUser,permissions:[],permission_grants:[{code:'dms:read',scope:'site'}],site_ids:[site]};
    currentDocument={...documentRow,approval_status:'approved',site_id:otherSite};
    currentVersion={...currentVersion,approval_status:'approved',site_id:otherSite};
    const response=await request(app).get(`/api/v1/dms/documents/${documentId}/versions/${versionId}/download`).set('Cookie',csrf);
    expect(response.status).toBe(403);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('INSERT INTO audit_events'))).toBe(false);
  });

  it('schützt Kundendokumente auch bei vorhandener DMS-Leseberechtigung',async()=>{
    currentDocument={...documentRow,approval_status:'approved',customer_id:customer};
    currentVersion={...currentVersion,approval_status:'approved',customer_id:customer};
    const denied=await request(app).get(`/api/v1/dms/documents/${documentId}/versions/${versionId}/download`).set('Cookie',csrf);
    expect(denied.status).toBe(403);
    activeUser={
      ...baseUser,
      permission_grants:[{code:'dms:read',scope:'tenant'},{code:'customer_documents:read',scope:'tenant'}],
    };
    const allowed=await request(app).get(`/api/v1/dms/documents/${documentId}/versions/${versionId}/download`).set('Cookie',csrf);
    expect(allowed.status).toBe(200);
    expect(allowed.text).toBe(content.toString('utf8'));
    const audit=queryMock.mock.calls.find(([sql])=>String(sql).includes('INSERT INTO audit_events'));
    expect(audit?.[1]?.[2]).toBe('dms.document.downloaded');
    expect(audit?.[1]?.[5]).toEqual(expect.objectContaining({customer_id:customer,site_id:site}));
  });

  it('verhindert Freigabe und Herausgabe nicht freigegebener oder nicht verfügbarer Versionen',async()=>{
    const denied=await request(app).get(`/api/v1/dms/documents/${documentId}/versions/${versionId}/preview`).set('Cookie',csrf);
    expect(denied.status).toBe(409);
    expect(denied.body.state).toBe('pending_approval');
    currentDocument={...documentRow,approval_status:'approved'};
    currentVersion={...currentVersion,approval_status:'approved',lifecycle_state:'quarantined'};
    const quarantined=await request(app).get(`/api/v1/dms/documents/${documentId}/versions/${versionId}/preview`).set('Cookie',csrf);
    expect(quarantined.status).toBe(409);
    expect(quarantined.body.state).toBe('quarantined');
  });
});
