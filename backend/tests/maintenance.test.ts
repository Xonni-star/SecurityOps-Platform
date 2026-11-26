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
const device='00000000-0000-4000-8000-0000000000b1';
const orderId='00000000-0000-4000-8000-0000000000c1';
const result=(rows:unknown[],rowCount=rows.length)=>({rows,rowCount}) as unknown as QueryResult;
const csrf=['securityops_session=opaque','securityops_csrf=csrf-value'];
let activeUser:Record<string,unknown>;
const baseUser={
  id:'00000000-0000-4000-8000-000000000001',tenantId:tenant,email:'admin@example.invalid',role:'admin',
  permissions:['sites:read','devices:read','devices:write'],permission_grants:[{code:'sites:read',scope:'site'},{code:'devices:read',scope:'site'},{code:'devices:write',scope:'site'}],site_ids:[site],
  is_system_admin:false,session_id:'00000000-0000-4000-8000-0000000000ac',
  csrf_token:'csrf-value',expires_at:'2099-01-01',device_id:'00000000-0000-4000-8000-0000000000ee',
};
const order={
  id:orderId,tenant_id:tenant,site_id:site,device_id:device,order_number:'MAIN-2026-000042',
  status:'planned',due_on:'2026-01-01',description:'Prüfung der Alarmanlage',responsible_employee_id:null,
};

beforeEach(()=>{
  queryMock.mockReset();
  activeUser=baseUser;
  queryMock.mockImplementation(async(sql:string)=>{
    if(sql.includes('FROM sessions'))return result([activeUser]);
    if(sql.includes('SELECT id,site_id FROM devices'))return result([{id:device,site_id:site}]);
    if(sql.includes('SELECT maintenance_interval_days FROM devices'))return result([{maintenance_interval_days:30}]);
    if(sql.includes('nextval'))return result([{next:'42'}]);
    if(sql.includes('FROM maintenance_orders o WHERE'))return result([order]);
    if(sql.includes('INSERT INTO maintenance_orders'))return result([order]);
    if(sql.includes('UPDATE maintenance_orders'))return result([{...order,status:'completed',completed_at:'2026-11-25T10:00:00Z'}]);
    return result([]);
  });
});

describe('maintenance workflow routes',()=>{
  it('creates an order with a unique number for an operational device at the site',async()=>{
    const response=await request(app).post(`/api/v1/sites/${site}/maintenance-orders`)
      .set('Cookie',csrf).set('x-csrf-token','csrf-value')
      .send({device_id:device,maintenance_type:'inspection',description:'Prüfung der Alarmanlage',priority_code:'high',due_on:'2026-12-01',status:'planned'});
    expect(response.status).toBe(201);
    expect(response.body.order_number).toMatch(/^MAIN-\d{4}-000042$/);
    const insert=queryMock.mock.calls.find(([sql])=>String(sql).includes('INSERT INTO maintenance_orders'));
    expect(insert?.[1]).toEqual(expect.arrayContaining([tenant,site,device,'inspection','Prüfung der Alarmanlage','high','2026-12-01','planned']));
    const audit=queryMock.mock.calls.find(([sql])=>String(sql).includes('INSERT INTO audit_events'));
    expect(audit?.[1]?.[2]).toBe('maintenance_order.created');
  });

  it('replays a creation with an Idempotency-Key without duplicating the order or audit event',async()=>{
    const key='00000000-0000-4000-8000-0000000000d1';
    const payload={device_id:device,description:'Prüfung der Alarmanlage',priority_code:'high',due_on:'2026-12-01'};
    let storedHash:string|null=null;
    let receiptStored=false;
    queryMock.mockImplementation(async(sql:string,values:unknown[])=>{
      if(sql.includes('FROM sessions'))return result([activeUser]);
      if(sql.includes('SELECT id,site_id FROM devices'))return result([{id:device,site_id:site}]);
      if(sql.includes('INSERT INTO sync_receipts')){
        if(receiptStored)return result([],0);
        receiptStored=true;storedHash=String(values[4]);
        return result([{id:'receipt'}],1);
      }
      if(sql.includes('SELECT action,payload_hash,status,response FROM sync_receipts')){
        if(!storedHash)return result([],0);
        return result([{action:'maintenance.order.create',payload_hash:storedHash,status:'completed',response:order}],1);
      }
      if(sql.includes('nextval'))return result([{next:'42'}]);
      if(sql.includes('INSERT INTO maintenance_orders'))return result([order],1);
      if(sql.includes('INSERT INTO audit_events'))return result([],1);
      return result([]);
    });
    const first=await request(app).post(`/api/v1/sites/${site}/maintenance-orders`)
      .set('Cookie',csrf).set('x-csrf-token','csrf-value').set('Idempotency-Key',key).send(payload);
    const replay=await request(app).post(`/api/v1/sites/${site}/maintenance-orders`)
      .set('Cookie',csrf).set('x-csrf-token','csrf-value').set('Idempotency-Key',key).send(payload);
    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(expect.objectContaining({id:orderId,order_number:order.order_number}));
    expect(queryMock.mock.calls.filter(([sql])=>String(sql).includes('INSERT INTO maintenance_orders'))).toHaveLength(1);
    expect(queryMock.mock.calls.filter(([sql])=>String(sql).includes('INSERT INTO audit_events'))).toHaveLength(1);
  });

  it('rejects malformed idempotency keys and payload hash mismatches',async()=>{
    const key='00000000-0000-4000-8000-0000000000d2';
    const invalid=await request(app).post(`/api/v1/sites/${site}/maintenance-orders`)
      .set('Cookie',csrf).set('x-csrf-token','csrf-value').set('Idempotency-Key','not-a-uuid')
      .send({device_id:device,description:'Prüfung der Alarmanlage'});
    expect(invalid.status).toBe(400);
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([activeUser]);
      if(sql.includes('SELECT id,site_id FROM devices'))return result([{id:device,site_id:site}]);
      if(sql.includes('INSERT INTO sync_receipts'))return result([],0);
      if(sql.includes('SELECT action,payload_hash,status,response FROM sync_receipts'))return result([{
        action:'maintenance.order.create',payload_hash:'different-hash',status:'completed',response:order,
      }],1);
      return result([]);
    });
    const mismatch=await request(app).post(`/api/v1/sites/${site}/maintenance-orders`)
      .set('Cookie',csrf).set('x-csrf-token','csrf-value').set('Idempotency-Key',key)
      .send({device_id:device,description:'Prüfung der Alarmanlage'});
    expect(mismatch.status).toBe(409);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('INSERT INTO maintenance_orders'))).toBe(false);
  });

  it('rejects a device that does not belong to the addressed site',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([activeUser]);
      if(sql.includes('SELECT id,site_id FROM devices'))return result([{id:device,site_id:'00000000-0000-4000-8000-0000000000ff'}]);
      return result([]);
    });
    const response=await request(app).post(`/api/v1/sites/${site}/maintenance-orders`).set('Cookie',csrf).set('x-csrf-token','csrf-value')
      .send({device_id:device,description:'Prüfung der Alarmanlage'});
    expect(response.status).toBe(404);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('INSERT INTO maintenance_orders'))).toBe(false);
  });

  it('reports overdue status server-side instead of trusting the stored status',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([activeUser]);
      if(sql.includes('FROM maintenance_orders o'))return result([{...order,status:'open',due_on:'2020-01-01',device_name:'Alarmanlage'}]);
      return result([]);
    });
    const response=await request(app).get(`/api/v1/sites/${site}/maintenance-orders`).set('Cookie','securityops_session=opaque');
    expect(response.status).toBe(200);
    expect(response.body[0]).toMatchObject({computed_status:'overdue',status_label:'Überfällig',overdue:true});
  });

  it('completes maintenance and derives the next date from the device interval',async()=>{
    const response=await request(app).post(`/api/v1/maintenance-orders/${orderId}/complete`).set('Cookie',csrf).set('x-csrf-token','csrf-value')
      .send({performed_work:'Funktionstest durchgeführt',result:'ok'});
    expect(response.status).toBe(200);
    expect(response.body.computed_status).toBe('completed');
    const deviceUpdate=queryMock.mock.calls.find(([sql])=>String(sql).includes('UPDATE devices SET last_maintenance_on'));
    expect(String(deviceUpdate?.[0])).toContain('next_maintenance_on=COALESCE');
    expect(deviceUpdate?.[1]?.[2]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const audit=queryMock.mock.calls.find(([sql])=>String(sql).includes('INSERT INTO audit_events'));
    expect(audit?.[1]?.[2]).toBe('maintenance_order.completed');
  });

  it('blocks manipulation outside the granted site scope',async()=>{
    activeUser={...baseUser,site_ids:['00000000-0000-4000-8000-0000000000ff']};
    const response=await request(app).patch(`/api/v1/maintenance-orders/${orderId}`).set('Cookie',csrf).set('x-csrf-token','csrf-value').send({status:'in_progress'});
    expect(response.status).toBe(403);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('UPDATE maintenance_orders'))).toBe(false);
  });

  it('does not reopen a completed order',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([activeUser]);
      if(sql.includes('FROM maintenance_orders o WHERE'))return result([{...order,status:'completed'}]);
      return result([]);
    });
    const response=await request(app).post(`/api/v1/maintenance-orders/${orderId}/cancel`).set('Cookie',csrf).set('x-csrf-token','csrf-value').send({reason:'Irrtum'});
    expect(response.status).toBe(409);
  });
});
