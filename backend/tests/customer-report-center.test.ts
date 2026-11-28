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
const {customerReportFingerprint}=await import('../src/services/customer-report-domain.js');

const tenant='00000000-0000-4000-8000-00000000000a';
const customer='00000000-0000-4000-8000-0000000000bb';
const site='00000000-0000-4000-8000-0000000000cc';
const author='00000000-0000-4000-8000-000000000001';
const approver='00000000-0000-4000-8000-000000000002';
const releaseId='00000000-0000-4000-8000-0000000000f1';
const sessionId='00000000-0000-4000-8000-0000000000dd';
const deviceId='00000000-0000-4000-8000-0000000000ee';
const result=(rows:unknown[],rowCount=rows.length)=>({rows,rowCount}) as unknown as QueryResult;
const csrf=['securityops_session=opaque','securityops_csrf=csrf-value'];
const filters={
  from:'2026-11-01',to:'2026-11-28',customer_id:customer,site_id:site,
  q:'Tor',sort:'occurred_at',order:'desc' as const,
};
const safeRow={
  id:'row-1',occurred_at:'2026-11-05T10:00:00.000Z',site_id:site,site_name:'Nordgebäude',
  category:'Einsatz',label:'Tor 1',status:'Abgeschlossen',metric:1,
};
const fingerprint=customerReportFingerprint('incidents',filters,[safeRow]);
const fullPermissions=[
  'customer_reports:read','customer_reports:write','customer_reports:approve',
  'customer_reports:export','customer_portal:read',
];
const user=(overrides:Record<string,unknown>={})=>({
  id:approver,tenantId:tenant,email:'reporting-e2e@example.invalid',role:'admin',
  permissions:fullPermissions,permission_grants:[],site_ids:[site],is_system_admin:false,
  session_id:sessionId,csrf_token:'csrf-value',expires_at:'2099-01-01',device_id:deviceId,
  ...overrides,
});
const release=(overrides:Record<string,unknown>={})=>({
  id:releaseId,tenant_id:tenant,customer_id:customer,title:'Nachweisbericht November',
  kind:'incidents',status:'draft',filters,allowed_site_ids:[site],rows:[safeRow],row_count:1,
  fingerprint,created_by:author,created_at:'2026-11-28T09:00:00.000Z',
  previewed_at:'2026-11-28T09:00:00.000Z',approved_by:null,approved_at:null,
  customer_name:'Nordlicht GmbH',rejected_reason:null,revoked_reason:null,
  ...overrides,
});

let activeUser:Record<string,unknown>;
let activeRelease:Record<string,unknown>;
let dataRows:Record<string,unknown>[];
let total:number;

beforeEach(()=>{
  activeUser=user();
  activeRelease=release();
  dataRows=[safeRow];
  total=1;
  queryMock.mockReset();
  queryMock.mockImplementation(async(sql:string)=>{
    if(sql.includes('FROM sessions'))return result([activeUser]);
    if(sql.includes('SELECT id FROM customers WHERE'))return result([{id:customer}]);
    if(sql.includes('FROM customer_sites'))return result([{site_id:site}]);
    if(sql.includes('SELECT r.*,c.name AS customer_name FROM customer_report_releases r')){
      if(sql.includes("r.status='approved'")&&activeRelease.status!=='approved')return result([]);
      return result([activeRelease]);
    }
    if(sql.includes('SELECT id,rows FROM customer_report_releases WHERE'))return result([]);
    if(sql.includes('INSERT INTO customer_report_releases'))return result([
      {id:releaseId,status:'draft',created_at:'2026-11-28T09:00:00.000Z'},
    ]);
    if(sql.includes('SELECT count(*)::int AS total'))return result([{total}]);
    if(sql.includes('WITH basis AS'))return result(dataRows);
    if(sql.includes('UPDATE customer_report_releases')){
      if(sql.includes("status='approved',reviewed_at"))return result([{id:releaseId,status:'approved'}]);
      if(sql.includes("status='revoked',revoked_at"))return result([{id:releaseId,status:'revoked'}]);
      if(sql.includes("status='rejected',reviewed_at"))return result([{id:releaseId,status:'rejected'}]);
      if(sql.includes("status='in_review',submitted_at"))return result([{id:releaseId,status:'in_review'}]);
    }
    return result([]);
  });
});

describe('Kundenberichtswesen – API',()=>{
  it('listet die vier Nachweisarten mit deutscher Beschreibung und Berliner Zeitzone',async()=>{
    const response=await request(app).get('/api/v1/customer-reports/kinds')
      .set('Cookie','securityops_session=opaque');
    expect(response.status).toBe(200);
    expect(response.body.timezone).toBe('Europe/Berlin');
    expect(response.body.kinds.map((kind:{slug:string})=>kind.slug)).toEqual([
      'control-walks','watchbook','alarms','incidents',
    ]);
    expect(response.body.kinds[0].label).toBe('Kontrollgänge');
  });

  it('filtert, sortiert und seitet Vorschauen serverseitig und gibt nur sichere Felder zurück',async()=>{
    const response=await request(app).get('/api/v1/customer-reports/preview/incidents')
      .query({...filters,page:2,page_size:2})
      .set('Cookie','securityops_session=opaque');
    expect(response.status).toBe(200);
    expect(response.body.rows).toEqual([expect.objectContaining({
      id:'row-1',category:'Einsatz',label:'Tor 1',status:'Abgeschlossen',metric:1,
    })]);
    expect(Object.keys(response.body.rows[0]).sort()).toEqual([
      'category','id','label','metric','occurred_at','site_id','site_name','status',
    ]);
    expect(response.body.filter).toEqual(expect.objectContaining({
      page:2,page_size:2,total:1,page_count:1,timezone:'Europe/Berlin',
      customer_id:customer,site_id:site,
    }));
    const listing=queryMock.mock.calls.find(([sql])=>String(sql).includes('SELECT basis.* FROM basis'));
    const sql=String(listing?.[0]);
    expect(sql).toContain('ORDER BY basis.occurred_at DESC');
    expect(sql).toContain('LIMIT $7 OFFSET $8');
    expect(sql).toContain("basis.label ILIKE $6 ESCAPE '\\'");
    const count=queryMock.mock.calls.find(([sql])=>String(sql).includes('SELECT count(*)::int AS total'));
    expect(count).toBeDefined();
  });

  it('verweigert eine Vorschau ohne Leseberechtigung',async()=>{
    activeUser=user({permissions:['customer_portal:read']});
    const response=await request(app).get('/api/v1/customer-reports/preview/incidents')
      .set('Cookie','securityops_session=opaque');
    expect(response.status).toBe(403);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('WITH basis AS'))).toBe(false);
  });

  it('speichert einen Entwurf mit Snapshot, Fingerprint und Audit, aber ohne Freigabe',async()=>{
    const response=await request(app).post('/api/v1/customer-reports/releases')
      .set('Cookie',csrf).set('x-csrf-token','csrf-value')
      .send({title:'Nachweisbericht November',kind:'incidents',customer_id:customer,filters});
    expect(response.status).toBe(201);
    expect(response.body).toEqual(expect.objectContaining({
      id:releaseId,status:'draft',row_count:1,fingerprint,
    }));
    const insert=queryMock.mock.calls.find(([sql])=>String(sql).includes('INSERT INTO customer_report_releases'));
    expect(String(insert?.[0])).toContain("VALUES($1,$2,$3,$4,'draft'");
    expect(JSON.parse(String(insert?.[1]?.[6]))).toEqual([safeRow]);
    expect(insert?.[1]?.[5]).toEqual([site]);
    const audit=queryMock.mock.calls.find(([sql])=>String(sql).includes('INSERT INTO audit_events'));
    expect(audit?.[1]?.[2]).toBe('customer_report.created');
  });

  it('verlangt für die Einreichung eine unveränderte Datenbasis',async()=>{
    dataRows=[{...safeRow,status:'Offen'}];
    const response=await request(app).post(`/api/v1/customer-reports/releases/${releaseId}/submit`)
      .set('Cookie',csrf).set('x-csrf-token','csrf-value').send({});
    expect(response.status).toBe(409);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes("status='in_review'"))).toBe(false);
  });

  it('reiht einen geprüften Entwurf mit nachvollziehbarer Datenbasis zur Freigabe ein',async()=>{
    activeRelease=release({status:'draft'});
    const response=await request(app).post(`/api/v1/customer-reports/releases/${releaseId}/submit`)
      .set('Cookie',csrf).set('x-csrf-token','csrf-value').send({});
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('in_review');
    const audit=queryMock.mock.calls.find(([sql])=>String(sql).includes('INSERT INTO audit_events'));
    expect(audit?.[1]?.[2]).toBe('customer_report.submitted');
  });

  it('gibt einen Bericht nur durch eine andere Person mit aktueller Datenbasis frei',async()=>{
    activeRelease=release({status:'in_review'});
    const approved=await request(app).post(`/api/v1/customer-reports/releases/${releaseId}/approve`)
      .set('Cookie',csrf).set('x-csrf-token','csrf-value').send({});
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('approved');
    const update=queryMock.mock.calls.find(([sql])=>String(sql).includes("status='approved',reviewed_at"));
    expect(update?.[1]).toEqual([tenant,releaseId,approver]);
    const audit=queryMock.mock.calls.find(([sql])=>String(sql).includes('INSERT INTO audit_events'));
    expect(audit?.[1]?.[2]).toBe('customer_report.approved');

    queryMock.mockClear();
    activeUser=user({id:author});
    const selfApproval=await request(app).post(`/api/v1/customer-reports/releases/${releaseId}/approve`)
      .set('Cookie',csrf).set('x-csrf-token','csrf-value').send({});
    expect(selfApproval.status).toBe(403);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes("status='approved',reviewed_at"))).toBe(false);
  });

  it('verhindert die Freigabe ohne gespeicherte Nachweiszeilen',async()=>{
    activeRelease=release({status:'in_review',row_count:2});
    const response=await request(app).post(`/api/v1/customer-reports/releases/${releaseId}/approve`)
      .set('Cookie',csrf).set('x-csrf-token','csrf-value').send({});
    expect(response.status).toBe(409);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes("status='approved',reviewed_at"))).toBe(false);
  });

  it('liefert im Kundenportal ausschließlich freigegebene Schnappschüsse ohne Exportfreigabe',async()=>{
    activeUser=user({permissions:['customer_portal:read']});
    activeRelease=release({status:'approved',approved_by:approver,approved_at:'2026-11-28T10:00:00.000Z'});
    const list=await request(app).get(`/api/v1/customer-portal/releases?customer_id=${customer}`)
      .set('Cookie','securityops_session=opaque');
    expect(list.status).toBe(200);
    expect(list.body.read_only).toBe(true);
    expect(list.body.export_allowed).toBe(false);
    expect(list.body.releases[0]).toEqual(expect.objectContaining({id:releaseId,status:'approved'}));
    expect(queryMock.mock.calls.some(([sql])=>/FROM (alarms a|incidents i|patrol_scans ps|watchbook_entries e)/.test(String(sql)))).toBe(false);

    const detail=await request(app).get(`/api/v1/customer-portal/releases/${releaseId}`)
      .set('Cookie','securityops_session=opaque');
    expect(detail.status).toBe(200);
    expect(detail.body.rows).toEqual([safeRow]);
    expect(detail.body.export_allowed).toBe(false);
    const audit=queryMock.mock.calls.find(([sql])=>String(sql).includes('INSERT INTO audit_events'));
    expect(audit?.[1]?.[2]).toBe('customer.portal.released_viewed');

    activeRelease=release({status:'draft'});
    const hidden=await request(app).get(`/api/v1/customer-portal/releases/${releaseId}`)
      .set('Cookie','securityops_session=opaque');
    expect(hidden.status).toBe(404);
  });

  it('exportiert ausschließlich freigegebene Berichte als CSV, PDF und XLSX mit Audit',async()=>{
    activeRelease=release({status:'approved',approved_by:approver,approved_at:'2026-11-28T10:00:00.000Z'});
    const csv=await request(app).get(`/api/v1/customer-reports/releases/${releaseId}/export?format=csv`)
      .set('Cookie','securityops_session=opaque');
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['x-report-row-count']).toBe('1');
    expect(csv.headers['x-report-truncated']).toBe('false');
    expect(csv.text.startsWith('\uFEFF')).toBe(true);
    expect(csv.text).toContain('"Referenz";"Zeitpunkt (Europe/Berlin)";"Objekt"');

    const pdf=await request(app).get(`/api/v1/customer-reports/releases/${releaseId}/export?format=pdf`)
      .set('Cookie','securityops_session=opaque');
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');

    const xlsx=await request(app).get(`/api/v1/customer-reports/releases/${releaseId}/export?format=xlsx`)
      .set('Cookie','securityops_session=opaque');
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers['content-type']).toContain('spreadsheetml');
    expect(Number(xlsx.headers['content-length'])).toBeGreaterThan(100);

    const audits=queryMock.mock.calls.filter(([sql])=>String(sql).includes('INSERT INTO audit_events'));
    expect(audits.map(([,values])=>values?.[2])).toEqual(expect.arrayContaining([
      'customer_report.exported','customer_report.exported','customer_report.exported',
    ]));

    activeRelease=release({status:'draft'});
    const blocked=await request(app).get(`/api/v1/customer-reports/releases/${releaseId}/export`)
      .set('Cookie','securityops_session=opaque');
    expect(blocked.status).toBe(409);
  });

  it('widerruft eine Freigabe mit Begründung und entfernt sie aus dem Portal',async()=>{
    activeRelease=release({status:'approved',approved_by:approver,approved_at:'2026-11-28T10:00:00.000Z'});
    const response=await request(app).post(`/api/v1/customer-reports/releases/${releaseId}/revoke`)
      .set('Cookie',csrf).set('x-csrf-token','csrf-value').send({reason:'Falscher Zeitraum'});
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('revoked');
    const update=queryMock.mock.calls.find(([sql])=>String(sql).includes("status='revoked'"));
    expect(update?.[1]?.[2]).toBe('Falscher Zeitraum');
    const audit=queryMock.mock.calls.find(([sql])=>String(sql).includes('INSERT INTO audit_events'));
    expect(audit?.[1]?.[2]).toBe('customer_report.revoked');
  });

  it('gewährt dem Kundenportal keine Exportberechtigung',async()=>{
    activeUser=user({permissions:['customer_portal:read']});
    const response=await request(app).get(`/api/v1/customer-reports/releases/${releaseId}/export`)
      .set('Cookie','securityops_session=opaque');
    expect(response.status).toBe(403);
  });
});
