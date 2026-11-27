import request from 'supertest';
import {randomUUID} from 'node:crypto';
import type {QueryResult} from 'pg';
import {beforeEach,describe,expect,it,jest} from '@jest/globals';

// Isolierte Testumgebung: kleine Grenze, keine echten Provider, keine echten
// Schadprogramme. Die EICAR-Zeichenkette ist der offizielle, harmlose Teststring.
process.env.DMS_MAX_BYTES='128';
const EICAR='X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

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
const {sha256}=await import('../src/services/dms-providers.js');

const tenant='00000000-0000-4000-8000-00000000000a';
const site='00000000-0000-4000-8000-0000000000aa';
const documentId='00000000-0000-4000-8000-0000000000b1';
const userId='00000000-0000-4000-8000-000000000001';
const sessionId='00000000-0000-4000-8000-0000000000ac';
const csrf=['securityops_session=opaque','securityops_csrf=csrf-value'];
const result=(rows:unknown[],rowCount=rows.length)=>({rows,rowCount}) as unknown as QueryResult;

const baseUser={
  id:userId,tenantId:tenant,email:'uploader@example.invalid',role:'admin',
  permissions:['dms:read','dms:write'],permission_grants:[],site_ids:[site],
  is_system_admin:false,session_id:sessionId,csrf_token:'csrf-value',
  expires_at:'2099-01-01',device_id:'00000000-0000-4000-8000-0000000000ee',
};
const document={id:documentId,tenant_id:tenant,site_id:site,title:'Testdokument',document_status:'active'};
const cleanContent='SecurityOps Testdokument';
let activeUser:Record<string,unknown>;
let downloadRow:Record<string,unknown>;

const storage={
  put:jest.fn(async(_key:string,_content:Buffer,_contentType:string)=>{}),
  get:jest.fn(async(_key:string)=>({content:Buffer.from(cleanContent),contentType:'text/plain'})),
  delete:jest.fn(async(_key:string)=>{}),
  ready:jest.fn(async()=>{}),
};
const scanner={
  scan:jest.fn(async(_content:Buffer)=>({clean:true})),
  ready:jest.fn(async()=>{}),
};

const uploadBody=(overrides:Record<string,unknown>={})=>({
  title:'Testdokument',
  content_base64:Buffer.from(cleanContent,'utf8').toString('base64'),
  content_type:'text/plain',
  client_mutation_id:randomUUID(),
  ...overrides,
});
const versionBody=(overrides:Record<string,unknown>={})=>({
  content_base64:Buffer.from(cleanContent,'utf8').toString('base64'),
  content_type:'text/plain',
  client_mutation_id:randomUUID(),
  ...overrides,
});
const postUpload=(body:Record<string,unknown>)=>request(app).post('/api/v1/dms/documents').set('Cookie',csrf).set('x-csrf-token','csrf-value').send(body);
const postVersion=(body:Record<string,unknown>)=>request(app).post(`/api/v1/dms/documents/${documentId}/versions`).set('Cookie',csrf).set('x-csrf-token','csrf-value').send(body);

beforeEach(()=>{
  queryMock.mockReset();
  storage.put.mockReset().mockImplementation(async()=>{});
  storage.get.mockReset().mockImplementation(async()=>({content:Buffer.from(cleanContent),contentType:'text/plain'}));
  storage.delete.mockReset().mockImplementation(async()=>{});
  storage.ready.mockReset().mockImplementation(async()=>{});
  scanner.scan.mockReset().mockImplementation(async()=>({clean:true}));
  scanner.ready.mockReset().mockImplementation(async()=>{});
  configureDmsAdapters(storage,scanner);
  activeUser=baseUser;
  const version={id:'00000000-0000-4000-8000-0000000000c1',tenant_id:tenant,document_id:documentId,
    version_no:1,content_type:'video/mp4',sha256:sha256(Buffer.from(cleanContent)),size_bytes:Buffer.byteLength(cleanContent),lifecycle_state:'available'};
  downloadRow={...document,...version,object_key:`${tenant}/${documentId}/${version.id}`,size_bytes:Buffer.byteLength(cleanContent),sha256:sha256(Buffer.from(cleanContent))};
  queryMock.mockImplementation(async(sql:string)=>{
    if(sql.includes('FROM sessions'))return result([activeUser]);
    if(sql.includes('INSERT INTO sync_receipts'))return result([{id:randomUUID()}],1);
    if(sql.includes('UPDATE sync_receipts'))return result([],1);
    if(sql.includes('INSERT INTO dms_documents'))return result([document],1);
    if(sql.includes('INSERT INTO dms_versions'))return result([version],1);
    if(sql.includes("UPDATE dms_versions SET lifecycle_state='available'"))return result([version],1);
    if(sql.includes('UPDATE dms_versions'))return result([],1);
    if(sql.includes('INSERT INTO audit_events'))return result([],1);
    if(sql.includes('FROM dms_documents d JOIN dms_versions v'))return result([downloadRow],1);
    if(sql.includes('FROM dms_documents WHERE'))return result([document],1);
    if(sql.includes('FROM dms_versions'))return result([version],1);
    return result([]);
  });
});

describe('DMS upload security and provider failures',()=>{
  it('releases a clean file only after a successful virus scan',async()=>{
    const response=await postUpload(uploadBody());
    expect(response.status).toBe(201);
    expect(response.body.version.lifecycle_state).toBe('available');
    expect(storage.put).toHaveBeenCalledTimes(1);
    expect(scanner.scan).toHaveBeenCalledTimes(1);
    expect(storage.delete).not.toHaveBeenCalled();
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes("lifecycle_state='available'"))).toBe(true);
    const audit=queryMock.mock.calls.find(([sql])=>String(sql).includes('INSERT INTO audit_events'));
    expect(audit?.[1]?.[2]).toBe('dms.document.uploaded');
  });

  it('rejects the upload safely when ClamAV is unreachable',async()=>{
    scanner.scan.mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:3310'));
    const response=await postUpload(uploadBody());
    expect(response.status).toBe(502);
    expect(response.body.error).toContain('Virenscan-Anbieter ist nicht erreichbar');
    expect(storage.delete).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes("rejection_reason=$3"))).toBe(true);
    const audit=queryMock.mock.calls.find(([,values])=>values?.[2]==='dms.scan.provider_error');
    expect(audit).toBeDefined();
  });

  it('rejects the official EICAR test signature and deletes the blob',async()=>{
    scanner.scan.mockResolvedValueOnce({clean:false,signature:'Eicar-Test-Signature'});
    const response=await postUpload(uploadBody({content_base64:Buffer.from(EICAR,'utf8').toString('base64')}));
    expect(response.status).toBe(422);
    expect(response.body).toEqual(expect.objectContaining({state:'rejected',signature:'Eicar-Test-Signature'}));
    expect(storage.delete).toHaveBeenCalledTimes(1);
    const audit=queryMock.mock.calls.find(([,values])=>values?.[2]==='dms.scan.rejected');
    expect(audit?.[1]?.[5]).toEqual(expect.objectContaining({signature:'Eicar-Test-Signature'}));
  });

  it('rejects the upload when the scanner times out',async()=>{
    scanner.scan.mockRejectedValueOnce(new Error('Zeitüberschreitung beim ClamAV-Scan'));
    const response=await postUpload(uploadBody());
    expect(response.status).toBe(502);
    expect(response.body.error).toContain('Virenscan-Anbieter ist nicht erreichbar');
    expect(storage.delete).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty file',async()=>{
    const response=await postUpload(uploadBody({content_base64:''}));
    expect(response.status).toBe(400);
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('rejects a file above the server-side size limit',async()=>{
    const response=await postUpload(uploadBody({content_base64:Buffer.alloc(129,0x41).toString('base64')}));
    expect(response.status).toBe(413);
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('rejects a disallowed content type',async()=>{
    const response=await postUpload(uploadBody({content_type:'application/x-msdownload'}));
    expect(response.status).toBe(415);
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('rejects a manipulated file extension by checking the content',async()=>{
    const response=await postUpload(uploadBody({title:'report.pdf',content_type:'application/pdf'}));
    expect(response.status).toBe(415);
    expect(response.body.error).toContain('Dateiinhalt entspricht nicht dem angegebenen Dateityp');
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('denies uploads without write permission',async()=>{
    activeUser={...baseUser,permissions:['dms:read']};
    const response=await postUpload(uploadBody());
    expect(response.status).toBe(403);
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('denies access to a document outside the authenticated tenant',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([activeUser]);
      if(sql.includes('FROM dms_documents WHERE'))return result([]);
      return result([]);
    });
    const response=await postVersion(versionBody());
    expect(response.status).toBe(404);
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('does not create database state when blob storage fails',async()=>{
    storage.put.mockRejectedValueOnce(new Error('NoSuchBucket'));
    const response=await postUpload(uploadBody());
    expect(response.status).toBe(500);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('INSERT INTO dms_documents'))).toBe(false);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('INSERT INTO audit_events'))).toBe(false);
  });

  it('does not allow downloading a version that is not released',async()=>{
    downloadRow={...downloadRow,lifecycle_state:'rejected'};
    const response=await request(app)
      .get(`/api/v1/dms/documents/${documentId}/versions/00000000-0000-4000-8000-0000000000c1/download`)
      .set('Cookie',csrf);
    expect(response.status).toBe(409);
    expect(response.body.error).toContain('nicht verfügbar');
    expect(storage.get).not.toHaveBeenCalled();
  });

  it('blocks a download whose stored blob fails the integrity check',async()=>{
    storage.get.mockResolvedValueOnce({content:Buffer.from('verändert'),contentType:'text/plain'});
    const response=await request(app)
      .get(`/api/v1/dms/documents/${documentId}/versions/00000000-0000-4000-8000-0000000000c1/download`)
      .set('Cookie',csrf);
    expect(response.status).toBe(502);
    expect(response.body.error).toContain('Integritätsprüfung des Blobs fehlgeschlagen');
  });

  it('keeps the stored audio/video content type on download',async()=>{
    const response=await request(app)
      .get(`/api/v1/dms/documents/${documentId}/versions/00000000-0000-4000-8000-0000000000c1/download`)
      .set('Cookie',csrf);
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('video/mp4');
    expect(response.headers['content-disposition']).toMatch(/^attachment;/);
  });

  it('previews an available released version inline with the stored content type',async()=>{
    const response=await request(app)
      .get(`/api/v1/dms/documents/${documentId}/versions/00000000-0000-4000-8000-0000000000c1/preview`)
      .set('Cookie',csrf);
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('video/mp4');
    expect(response.headers['content-disposition']).toMatch(/^inline;/);
    expect(storage.get).toHaveBeenCalledWith(downloadRow.object_key);
  });

  it.each(['quarantined','rejected'])('refuses to preview a %s version',async(state)=>{
    downloadRow={...downloadRow,lifecycle_state:state};
    const response=await request(app)
      .get(`/api/v1/dms/documents/${documentId}/versions/00000000-0000-4000-8000-0000000000c1/preview`)
      .set('Cookie',csrf);
    expect(response.status).toBe(409);
    expect(response.body.state).toBe(state);
    expect(storage.get).not.toHaveBeenCalled();
  });

  it('denies preview without dms:read',async()=>{
    activeUser={...baseUser,permissions:['dms:write']};
    const response=await request(app)
      .get(`/api/v1/dms/documents/${documentId}/versions/00000000-0000-4000-8000-0000000000c1/preview`)
      .set('Cookie',csrf);
    expect(response.status).toBe(403);
    expect(storage.get).not.toHaveBeenCalled();
  });

  it('blocks a preview whose stored blob fails the integrity check',async()=>{
    storage.get.mockResolvedValueOnce({content:Buffer.from('verändert'),contentType:'text/plain'});
    const response=await request(app)
      .get(`/api/v1/dms/documents/${documentId}/versions/00000000-0000-4000-8000-0000000000c1/preview`)
      .set('Cookie',csrf);
    expect(response.status).toBe(502);
    expect(response.body.error).toContain('Integritätsprüfung des Blobs fehlgeschlagen');
  });

  it.each(['download','preview'])('rejects an unchecked latest alias on %s',async(endpoint)=>{
    const response=await request(app)
      .get(`/api/v1/dms/documents/${documentId}/versions/latest/${endpoint}`)
      .set('Cookie',csrf);
    expect(response.status).toBe(400);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('FROM dms_documents d JOIN dms_versions v'))).toBe(false);
    expect(storage.get).not.toHaveBeenCalled();
  });
});
