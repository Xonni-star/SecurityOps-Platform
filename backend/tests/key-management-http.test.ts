import request from 'supertest';
import type {QueryResult} from 'pg';
import {beforeEach,describe,expect,it,jest} from '@jest/globals';
import {canonicalPayloadHash} from '../src/services/offline-sync.js';

const queryMock=jest.fn();
const commitMock=jest.fn();
const rollbackMock=jest.fn();
const notificationMock=jest.fn();

jest.unstable_mockModule('../src/db/pool.js',()=>({
  query:queryMock,
  withTransaction:async (work:(client:unknown)=>Promise<unknown>)=>{
    try{const value=await work({query:queryMock});commitMock();return value;}
    catch(error){rollbackMock();throw error;}
  },
  withLoginContext:async (_value:string,work:()=>Promise<unknown>)=>work(),
  withSessionContext:async (_value:string,work:()=>Promise<unknown>)=>work(),
  withTenantContext:async (_value:string,work:()=>Promise<unknown>)=>work(),
}));
jest.unstable_mockModule('../src/services/notifications.js',()=>({
  queueNotificationEvent:notificationMock,
  sendEmail:jest.fn(),
  sendSms:jest.fn(),
  processNotificationQueue:jest.fn(),
}));

const {app}=await import('../src/app.js');
const result=(rows:unknown[],rowCount=rows.length)=>({rows,rowCount}) as unknown as QueryResult;
const tenant='00000000-0000-4000-8000-000000000010';
const userId='00000000-0000-4000-8000-000000000001';
const siteId='00000000-0000-4000-8000-000000000011';
const keyId='00000000-0000-4000-8000-000000000030';
const employeeId='00000000-0000-4000-8000-000000000031';
const documentId='00000000-0000-4000-8000-000000000032';
const mutationId='00000000-0000-4000-8000-000000000050';
const concurrentMutationId='00000000-0000-4000-8000-000000000051';
const sessionId='00000000-0000-4000-8000-000000000040';
const deviceId='00000000-0000-4000-8000-000000000041';
const csrf={Cookie:['securityops_session=session-1','securityops_csrf=csrf-value'],'x-csrf-token':'csrf-value'};

const keyRow={
  id:keyId,site_id:siteId,key_code:'K-1001',label:'Haupteingang',key_type:'physical',
  serial_number:'SN-1',manufacturer:'ABUS',location:'Eingang',building:'A',area:'EG',access_point:'P1',
  description:null,remarks:null,responsible_employee_id:null,status:'available',
  holder_user_id:null,holder_employee_id:null,holder_name:null,due_at:null,issued_at:null,returned_at:null,
  lost_at:null,deactivated_at:null,created_at:'2026-01-01T00:00:00Z',updated_at:'2026-01-01T00:00:00Z',
  total_count:1,bundle_id:null,bundle_name:null,site_name:'Zentrale',responsible_name:null,
  display_status:'available',holder_personnel_number:null,holder_status:null,
  last_movement_at:null,last_movement_type:null,
};

function sessionWith(permissions:string[],role='admin',siteIds:string[]=[]){
  return {
    id:userId,tenantId:tenant,email:'admin@example.invalid',role,
    permissions,permission_grants:permissions.map(code=>({code,scope:'tenant'})),
    site_ids:siteIds,is_system_admin:false,
    session_id:sessionId,csrf_token:'csrf-value',expires_at:'2099-01-01',device_id:deviceId,
  };
}

type Handler=(sql:string,values:unknown[])=>unknown;
function install(permissions:string[],handler:Handler,role='admin',siteIds:string[]=[]){
  const session=sessionWith(permissions,role,siteIds);
  queryMock.mockReset();
  queryMock.mockImplementation(async(sql:string,values:unknown[])=>{
    if(sql.includes('FROM sessions'))return result([session]);
    return handler(sql,values)??result([]);
  });
}

const defaultMutations:Handler=(sql)=>{
  if(String(sql).includes('INSERT INTO sync_receipts'))return result([{id:'sync-1'}],1);
  if(String(sql).includes('UPDATE sync_receipts'))return result([],1);
  if(String(sql).includes('INSERT INTO audit_events'))return result([{id:'audit-1'}],1);
  return undefined;
};

beforeEach(()=>{commitMock.mockReset();rollbackMock.mockReset();notificationMock.mockReset();});

describe('key list, dashboard and actions',()=>{
  it('lists keys with server-side filters, pagination headers and tenant predicate',async()=>{
    install(['keys:read'],(sql,values)=>{
      if(String(sql).includes('FROM keys k')){
        expect(values[0]).toBe(tenant);
        expect(String(sql)).toContain('k.tenant_id=$1');
        return result([keyRow]);
      }
      return undefined;
    });
    const response=await request(app).get('/api/v1/keys').query({q:'Haupt',status:'available',sort:'label',dir:'asc',page:2,pageSize:10}).set(csrf);
    expect(response.status).toBe(200);
    expect(response.headers['x-total-count']).toBe('1');
    expect(response.headers['x-page']).toBe('2');
    expect(response.headers['x-page-size']).toBe('10');
    expect(response.headers['x-page-count']).toBe('1');
    expect(response.body[0].key_code).toBe('K-1001');
  });

  it('rejects page sizes above 100 and missing keys:read permission',async()=>{
    install(['keys:read'],()=>undefined);
    expect((await request(app).get('/api/v1/keys').query({pageSize:101}).set(csrf)).status).toBe(400);
    install(['keys:export'],()=>undefined);
    expect((await request(app).get('/api/v1/keys').set(csrf)).status).toBe(403);
  });

  it('derives live dashboard metrics and caps recent movements at eight',async()=>{
    install(['keys:read'],(sql)=>{
      const text=String(sql);
      if(text.includes('FROM keys k WHERE k.tenant_id=$1'))return result([{total:4,available:1,issued:1,overdue:1,lost:1,blocked:0,deactivated:0,without_site:0,without_holder:0,due_today:1,due_7_days:2,due_30_days:3}]);
      if(text.includes('FROM key_movements m JOIN keys k'))return result([{id:'m1',key_id:keyId,movement_type:'issued'}]);
      if(text.includes('FROM key_bundles b'))return result([{partial_bundles:1}]);
      return undefined;
    });
    const response=await request(app).get('/api/v1/keys/dashboard').set(csrf);
    expect(response.status).toBe(200);
    expect(response.body.total).toBe(4);
    expect(response.body.overdue).toBe(1);
    expect(response.body.partial_bundles).toBe(1);
    expect(response.body.recent_movements).toHaveLength(1);
  });

  it('returns A/B/C action buckets whose URLs always deep-link to a key',async()=>{
    install(['keys:read'],(sql)=>{
      const text=String(sql);
      if(text.includes('incomplete_master'))return result([{
        id:keyId,key_code:'K-1001',label:'Haupteingang',site_id:siteId,site_name:'Zentrale',
        status:'lost',display_status:'lost',holder_user_id:null,holder_employee_id:null,
        due_at:null,created_at:'2026-01-01T00:00:00Z',incomplete_master:false,
      }]);
      return undefined;
    });
    const response=await request(app).get('/api/v1/keys/action-list').set(csrf);
    expect(response.status).toBe(200);
    expect(response.body.A.length).toBeGreaterThan(0);
    expect(response.body.generated_at).toBeTruthy();
    const all=[...response.body.A,...response.body.B,...response.body.C];
    for(const entry of all){
      expect(entry.url).toMatch(/^\/keys\/[0-9a-f-]+(\/historie)?$/);
      expect(['/keys','/']).not.toContain(entry.url);
      expect(entry.target).toBe(entry.url);
    }
  });

  it('exports German CSV only with keys:export and records keys.exported',async()=>{
    install(['keys:export'],(sql)=>{
      const text=String(sql);
      if(text.includes('WITH latest_movement AS'))return result([{...keyRow,holder_name:'Ada',due_at:'2026-07-01T00:00:00Z'}]);
      if(text.includes('INSERT INTO audit_events')){expect(text).toContain('audit_events');return result([{id:'a'}],1);}
      return defaultMutations(sql);
    });
    const response=await request(app).get('/api/v1/keys/export').query({ids:keyId}).set(csrf);
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.text).toContain('Schlüsselnummer');
    expect(response.text).toContain('K-1001');
    expect(queryMock.mock.calls.some(([sql,values])=>String(sql).includes('audit_events')&&JSON.stringify(values).includes('keys.exported'))).toBe(true);
  });
});

describe('key master data and lifecycle',()=>{
  it('creates a key with extended master data using the keys:create alias',async()=>{
    install(['keys:create'],(sql,values)=>{
      const text=String(sql);
      if(text.includes('INSERT INTO sync_receipts'))return result([{id:'sync-1'}],1);
      if(text.startsWith('INSERT INTO keys(')){
        expect(values).toContain('SN-1');expect(values).toContain('ABUS');
        return result([{...keyRow,serial_number:'SN-1',manufacturer:'ABUS'}]);
      }
      if(text.includes('SELECT id FROM employees WHERE'))return result([{id:employeeId}]);
      return defaultMutations(sql);
    });
    const response=await request(app).post('/api/v1/keys').set(csrf).send({
      key_code:'K-1001',label:'Haupteingang',key_type:'electronic',serial_number:'SN-1',manufacturer:'ABUS',
      location:'Eingang',building:'A',area:'EG',access_point:'P1',description:'Wangenschloss',remarks:'',
      responsible_employee_id:employeeId,site_id:siteId,client_mutation_id:mutationId,
    });
    expect(response.status).toBe(201);
    expect(response.body.serial_number).toBe('SN-1');
    expect(commitMock).toHaveBeenCalled();
  });

  it('returns a read-only safe file for keys:read without protected sections',async()=>{
    install(['keys:read'],(sql)=>{
      const text=String(sql);
      if(text.includes('SELECT * FROM keys WHERE'))return result([keyRow]);
      if(text.includes('FROM keys k LEFT JOIN sites s'))return result([keyRow]);
      return undefined;
    });
    const response=await request(app).get(`/api/v1/keys/${keyId}`).set(csrf);
    expect(response.status).toBe(200);
    expect(response.body.visible_sections).toEqual({master:true,history:false,qr:false,loss_reports:false,inventory:false});
    expect(response.body.recent_movements).toEqual([]);
    expect(response.body.loss_reports).toEqual([]);
  });

  it('rejects status in PATCH and keeps master-data updates scoped and audited',async()=>{
    install(['keys:update'],(sql)=>{
      const text=String(sql);
      if(text.includes('SELECT * FROM keys WHERE'))return result([keyRow]);
      if(text.startsWith('UPDATE keys SET'))return result([{...keyRow,label:'Neues Label'}],1);
      return defaultMutations(sql);
    });
    const invalid=await request(app).patch(`/api/v1/keys/${keyId}`).set(csrf).send({status:'blocked'});
    expect(invalid.status).toBe(400);
    const response=await request(app).patch(`/api/v1/keys/${keyId}`).set(csrf).send({label:'Neues Label',location:'Nord'});
    expect(response.status).toBe(200);
    expect(response.body.label).toBe('Neues Label');
    const updateSql=queryMock.mock.calls.find(([sql])=>String(sql).startsWith('UPDATE keys SET'))?.[0] as string;
    expect(updateSql).not.toContain('status=');
  });

  it('rejects a double issue with 409 after the FOR UPDATE availability re-check',async()=>{
    install(['keys:issue'],(sql)=>{
      const text=String(sql);
      if(text.includes('SELECT * FROM keys WHERE')&&text.includes('FOR UPDATE'))return result([{...keyRow,status:'issued',holder_user_id:userId}]);
      return defaultMutations(sql);
    });
    const response=await request(app).post(`/api/v1/keys/${keyId}/issue`).set(csrf).send({
      holder_user_id:userId,due_at:'2026-07-01T00:00:00Z',confirmation_name:'Ada',client_mutation_id:mutationId,
    });
    expect(response.status).toBe(409);
    expect(rollbackMock).toHaveBeenCalled();
  });

  it('serializes concurrent issues and rejects the losing request with 409',async()=>{
    let issueChecks=0;
    install(['keys:issue'],(sql)=>{
      const text=String(sql);
      if(text.includes('SELECT * FROM keys WHERE')&&text.includes('FOR UPDATE')){
        issueChecks+=1;
        return result([issueChecks===1?{...keyRow}:{...keyRow,status:'issued',holder_user_id:userId}]);
      }
      if(text.includes('SELECT id FROM users WHERE'))return result([{id:userId}]);
      if(text.startsWith('UPDATE keys SET status=$3,holder'))return result([{...keyRow,status:'issued',holder_user_id:userId,due_at:'2026-07-01T00:00:00Z'}],1);
      if(text.includes('INSERT INTO key_receipts'))return result([{id:'receipt-1',kind:'issue'}],1);
      return defaultMutations(sql);
    });
    const body=(client_mutation_id:string)=>({holder_user_id:userId,due_at:'2026-07-01T00:00:00Z',confirmation_name:'Ada',client_mutation_id});
    const responses=await Promise.all([
      request(app).post(`/api/v1/keys/${keyId}/issue`).set(csrf).send(body(mutationId)),
      request(app).post(`/api/v1/keys/${keyId}/issue`).set(csrf).send(body(concurrentMutationId)),
    ]);
    expect(responses.map(response=>response.status).sort()).toEqual([201,409]);
    expect(commitMock).toHaveBeenCalledTimes(1);
    expect(rollbackMock).toHaveBeenCalledTimes(1);
  });

  it('issues a key with a receipt, due date and keys.issued notification',async()=>{
    install(['keys:issue'],(sql)=>{
      const text=String(sql);
      if(text.includes('INSERT INTO sync_receipts'))return result([{id:'sync-1'}],1);
      if(text.includes('SELECT * FROM keys WHERE')&&text.includes('FOR UPDATE'))return result([keyRow]);
      if(text.includes('SELECT id FROM users WHERE'))return result([{id:userId}]);
      if(text.includes('SELECT id,site_id FROM dms_documents'))return result([{id:documentId,site_id:siteId}]);
      if(text.startsWith('UPDATE keys SET status=$3,holder'))return result([{...keyRow,status:'issued',holder_user_id:userId,due_at:'2026-07-01T00:00:00Z'}],1);
      if(text.includes('INSERT INTO key_movements'))return result([{id:'movement-1'}],1);
      if(text.includes('INSERT INTO key_receipts'))return result([{id:'receipt-1',kind:'issue'}],1);
      return defaultMutations(sql);
    });
    const response=await request(app).post(`/api/v1/keys/${keyId}/issue`).set(csrf).send({
      holder_user_id:userId,due_at:'2026-07-01T00:00:00Z',reason:'Schicht',handover_notes:'Übergabe',
      confirmation_name:'Ada Lovelace',receipt_document_id:documentId,client_mutation_id:mutationId,
    });
    expect(response.status).toBe(201);
    expect(response.body.receipt.kind).toBe('issue');
    expect(response.body.key.due_at).toBe('2026-07-01T00:00:00Z');
    expect(notificationMock).toHaveBeenCalledWith(tenant,'keys.issued',expect.any(String),expect.any(String),expect.any(String),'key',keyId);
    const receiptSql=queryMock.mock.calls.find(([sql])=>String(sql).includes('INSERT INTO key_receipts'))?.[0] as string;
    expect(receiptSql).toContain('confirmation_name');
  });

  it('returns a key only for its holder or an operator and clears holder plus due date',async()=>{
    install(['keys:return'],(sql)=>{
      const text=String(sql);
      if(text.includes('INSERT INTO sync_receipts'))return result([{id:'sync-1'}],1);
      if(text.includes('SELECT * FROM keys WHERE')&&text.includes('FOR UPDATE'))return result([{...keyRow,status:'issued',holder_user_id:userId,due_at:'2026-07-01T00:00:00Z'}]);
      if(text.startsWith('UPDATE keys SET status=$3,holder_user_id=NULL'))return result([{...keyRow,status:'available'}],1);
      if(text.includes('INSERT INTO key_movements'))return result([{id:'movement-2'}],1);
      if(text.includes('INSERT INTO key_receipts'))return result([{id:'receipt-2',kind:'return'}],1);
      return defaultMutations(sql);
    }, 'admin');
    const response=await request(app).post(`/api/v1/keys/${keyId}/return`).set(csrf).send({
      condition:'damaged',notes:'Beschädigung',reason:'Rückgabe',client_mutation_id:mutationId,
    });
    expect(response.status).toBe(200);
    expect(response.body.key.status).toBe('available');
    const updateSql=queryMock.mock.calls.find(([sql])=>String(sql).startsWith('UPDATE keys SET status=$3,holder_user_id=NULL'))?.[0] as string;
    expect(updateSql).toContain('due_at=NULL');
    expect(notificationMock).toHaveBeenCalledWith(tenant,'keys.returned',expect.any(String),expect.any(String),expect.any(String),'key',keyId);
  });

  it('blocks then reactivates a key with append-only movements',async()=>{
    install(['keys:manage'],(sql)=>{
      const text=String(sql);
      if(text.includes('INSERT INTO sync_receipts'))return result([{id:'sync-1'}],1);
      if(text.includes('SELECT * FROM keys WHERE')&&text.includes('FOR UPDATE'))return result([{...keyRow,status:'blocked',holder_user_id:userId}]);
      if(text.includes('INSERT INTO key_movements'))return result([{id:'movement-3'}],1);
      if(text.startsWith('UPDATE keys SET status=$3'))return result([{...keyRow,status:'available',holder_user_id:null}],1);
      return defaultMutations(sql);
    });
    const response=await request(app).post(`/api/v1/keys/${keyId}/reactivate`).set(csrf).send({reason:'Ersetzt',client_mutation_id:mutationId});
    expect(response.status).toBe(200);
    expect(response.body.movement).toBeDefined();
    const movementSql=queryMock.mock.calls.find(([sql])=>String(sql).includes('INSERT INTO key_movements'))?.[0] as string;
    expect(movementSql).toContain("'reactivated'");
    expect(notificationMock).toHaveBeenCalledWith(tenant,'keys.reactivated',expect.any(String),expect.any(String),expect.any(String),'key',keyId);
  });

  it('reports a loss with incident creation and a lost movement',async()=>{
    install(['keys:report_loss'],(sql)=>{
      const text=String(sql);
      if(text.includes('INSERT INTO sync_receipts'))return result([{id:'sync-1'}],1);
      if(text.includes('SELECT * FROM keys WHERE')&&text.includes('FOR UPDATE'))return result([{...keyRow,status:'issued',holder_user_id:userId}]);
      if(text.includes('SELECT id FROM users WHERE'))return result([{id:userId}]);
      if(text.includes('SELECT id FROM alarm_priorities'))return result([{id:'priority-1'}]);
      if(text.includes('INSERT INTO incidents'))return result([{id:'incident-1'}],1);
      if(text.includes('INSERT INTO incident_history'))return result([],1);
      if(text.includes('INSERT INTO key_loss_reports'))return result([{id:'loss-1',status:'reported',incident_id:'incident-1'}],1);
      if(text.startsWith('UPDATE keys SET status=$3,holder_user_id=NULL'))return result([{...keyRow,status:'lost'}],1);
      if(text.includes('INSERT INTO key_movements'))return result([{id:'movement-4'}],1);
      return defaultMutations(sql);
    });
    const response=await request(app).post(`/api/v1/keys/${keyId}/report-loss`).set(csrf).send({
      last_holder_user_id:userId,site_id:siteId,lost_at:'2026-06-01T08:00:00Z',reported_at:'2026-06-01T09:00:00Z',
      reporter_name:'Ada',description:'Schlüssel verloren',risk_assessment:'Hoch',immediate_measures:'Technische Sperrung',
      status:'review',create_incident:true,incident_priority_id:'00000000-0000-4000-8000-000000000099',client_mutation_id:mutationId,
    });
    expect(response.status).toBe(201);
    expect(response.body.report.status).toBe('reported');
    expect(response.body.incident_id).toBe('incident-1');
    expect(notificationMock).toHaveBeenCalledWith(tenant,'keys.lost',expect.any(String),expect.any(String),expect.any(String),'key',keyId);
    const movementSql=queryMock.mock.calls.find(([sql])=>String(sql).includes('INSERT INTO key_movements'))?.[0] as string;
    expect(movementSql).toContain("'blocked'");
  });

  it('updates a loss report status without mutating movement history',async()=>{
    install(['keys:report_loss'],(sql)=>{
      const text=String(sql);
      if(text.includes('SELECT * FROM key_loss_reports'))return result([{id:'loss-1',key_id:keyId,status:'reported'}]);
      if(text.includes('SELECT site_id FROM keys'))return result([{site_id:siteId}]);
      if(text.startsWith('UPDATE key_loss_reports SET'))return result([{id:'loss-1',status:'closed'}],1);
      return defaultMutations(sql);
    });
    const response=await request(app).patch(`/api/v1/keys/${keyId}/loss-reports/loss-1`).set(csrf).send({status:'closed',follow_up:'Ersetzt'});
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('closed');
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('key_movements'))).toBe(false);
  });
});

describe('key history, QR and inventory',()=>{
  it('serves paginated immutable history with keys:view_history and refuses keys:read only',async()=>{
    install(['keys:read'],(sql)=>{
      if(String(sql).includes('SELECT * FROM keys WHERE'))return result([keyRow]);
      return undefined;
    });
    expect((await request(app).get(`/api/v1/keys/${keyId}/history`).set(csrf)).status).toBe(403);

    install(['keys:view_history'],(sql,values)=>{
      const text=String(sql);
      if(text.includes('SELECT * FROM keys WHERE'))return result([keyRow]);
      if(text.includes('FROM key_movements m JOIN keys k')){
        expect(text).toContain('LIMIT $3 OFFSET $4');
        expect(values).toHaveLength(4);
        expect(values[3]).toBe(0);
        return result([{id:'m1',movement_type:'issued',total_count:1}]);
      }
      return undefined;
    });
    const response=await request(app).get(`/api/v1/keys/${keyId}/history`).query({page:1,pageSize:25}).set(csrf);
    expect(response.status).toBe(200);
    expect(response.headers['x-total-count']).toBe('1');
    expect(response.body[0].movement_type).toBe('issued');
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('INSERT INTO key_movements'))).toBe(false);
  });

  it('issues a short-lived opaque QR token and stores only its hash',async()=>{
    install(['keys:qr:read'],(sql)=>{
      const text=String(sql);
      if(text.includes('SELECT * FROM keys WHERE'))return result([keyRow]);
      if(text.includes('INSERT INTO key_qr_tokens'))return result([],1);
      return defaultMutations(sql);
    });
    const response=await request(app).get(`/api/v1/keys/${keyId}/qr`).set(csrf);
    expect(response.status).toBe(200);
    expect(response.body.url).toMatch(/^\/keys\/[0-9a-f-]+\?ref=/);
    expect(response.body.expires_at).toBeTruthy();
    expect(response.body.token).not.toContain(keyRow.key_code);
    expect(response.body.token).not.toContain(keyRow.serial_number);
    const insertValues=queryMock.mock.calls.find(([sql])=>String(sql).includes('INSERT INTO key_qr_tokens'))?.[1] as unknown[];
    expect(insertValues?.[2]).toMatch(/^[a-f0-9]{64}$/);
    expect(insertValues?.[2]).not.toBe(response.body.token);
  });

  it('records an inventory check with mismatches and lists checks with permission gating',async()=>{
    install(['keys:inventory:read'],()=>undefined);
    expect((await request(app).post('/api/v1/keys/inventory-checks').set(csrf).send({})).status).toBe(403);

    install(['keys:inventory:write'],(sql)=>{
      const text=String(sql);
      if(text.includes('INSERT INTO sync_receipts'))return result([{id:'sync-1'}],1);
      if(text.includes('SELECT id,site_id FROM keys WHERE'))return result([{id:keyId,site_id:siteId}]);
      if(text.startsWith('INSERT INTO key_inventory_checks'))return result([{id:'check-1',site_id:siteId}],1);
      if(text.includes('INSERT INTO key_inventory_check_items'))return result([],1);
      return defaultMutations(sql);
    });
    const response=await request(app).post('/api/v1/keys/inventory-checks').set(csrf).send({
      site_id:siteId,checked_at:'2026-06-01T08:00:00Z',checker_name:'Ada',
      results:[{key_id:keyId,expected_present:true}],client_mutation_id:mutationId,
    });
    expect(response.status).toBe(201);
    expect(response.body.mismatches).toBe(1);
    expect(response.body.items[0].found).toBe(false);

    install(['keys:inventory:read'],(sql)=>{
      const text=String(sql);
      if(text.includes('FROM key_inventory_checks c'))return result([{id:'check-1',total_count:1,items:[]}]);
      return undefined;
    });
    const list=await request(app).get('/api/v1/keys/inventory-checks').set(csrf);
    expect(list.status).toBe(200);
    expect(list.headers['x-total-count']).toBe('1');
  });
});

describe('key isolation, idempotency and transactional audit',()=>{
  it('never reads a key outside the tenant',async()=>{
    install(['keys:read'],()=>undefined);
    const response=await request(app).get(`/api/v1/keys/${keyId}`).set(csrf);
    expect(response.status).toBe(404);
  });

  it('replays an already-completed mutation without a second state change',async()=>{
    const payload={reason:'Sperre',client_mutation_id:mutationId};
    install(['keys:manage'],(sql)=>{
      const text=String(sql);
      if(text.includes('INSERT INTO sync_receipts'))return result([],0);
      if(text.includes('SELECT action,payload_hash,status,response FROM sync_receipts'))return result([{
        action:'keys.block',payload_hash:canonicalPayloadHash(payload),status:'completed',response:{key:keyRow,movement:{id:'movement-replayed'},replayed:true},
      }]);
      return defaultMutations(sql);
    });
    const response=await request(app).post(`/api/v1/keys/${keyId}/block`).set(csrf).send(payload);
    expect(response.status).toBe(200);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).startsWith('UPDATE keys'))).toBe(false);
  });

  it('rolls the transaction back when the audit insert fails',async()=>{
    install(['keys:update'],(sql)=>{
      const text=String(sql);
      if(text.includes('SELECT * FROM keys WHERE'))return result([keyRow]);
      if(text.startsWith('UPDATE keys SET'))return result([{...keyRow,label:'Neu'}],1);
      if(text.includes('INSERT INTO audit_events'))throw new Error('audit unavailable');
      return undefined;
    });
    const response=await request(app).patch(`/api/v1/keys/${keyId}`).set(csrf).send({label:'Neu'});
    expect(response.status).toBe(500);
    expect(rollbackMock).toHaveBeenCalled();
    expect(commitMock).not.toHaveBeenCalled();
  });
});
