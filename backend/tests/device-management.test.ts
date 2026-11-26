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
const otherSite='00000000-0000-4000-8000-0000000000ab';
const device='00000000-0000-4000-8000-0000000000b1';
const location='00000000-0000-4000-8000-0000000000c1';
const employee='00000000-0000-4000-8000-0000000000d1';
const result=(rows:unknown[],rowCount=rows.length)=>({rows,rowCount}) as unknown as QueryResult;
const csrf=['securityops_session=opaque','securityops_csrf=csrf-value'];
const headers={Cookie:csrf,'x-csrf-token':'csrf-value'};

let activeUser:Record<string,unknown>;
const baseUser={
  id:'00000000-0000-4000-8000-000000000001',tenantId:tenant,email:'admin@example.invalid',role:'admin',
  permissions:['devices:read','devices:write','devices:delete','sites:read','dms:read'],permission_grants:[],site_ids:[site],
  is_system_admin:false,session_id:'00000000-0000-4000-8000-0000000000ac',
  csrf_token:'csrf-value',expires_at:'2099-01-01',device_id:'00000000-0000-4000-8000-0000000000ee',
};
const deviceRow={
  id:device,tenant_id:tenant,site_id:site,name:'Zutrittsleser 01',status:'online',operational_status:'active',
  asset_number:'INV-1',category:'Zutritt',manufacturer:'Secura',model:'Reader 3000',serial_number:'SN-1',
  location_id:location,responsible_employee_id:employee,last_inspection_on:'2026-01-01',next_inspection_on:'2026-12-01',
  maintenance_interval_days:90,last_maintenance_on:null,next_maintenance_on:null,
  site_name:'Hauptobjekt',location_name:'Eingang',responsible_employee_name:'Ava Worker',
  effective_maintenance_on:null,inspection_state:'soon',maintenance_state:'none',created_at:'2026-01-01',updated_at:'2026-01-02',
};
const metrics={
  total_devices:12,active_devices:8,maintenance_devices:1,faulty_devices:1,offline_devices:1,decommissioned_devices:1,
  overdue_inspections:2,upcoming_inspections:3,overdue_maintenance:1,upcoming_maintenance:4,
};

beforeEach(()=>{
  queryMock.mockReset();
  activeUser=baseUser;
  queryMock.mockImplementation(async(sql:string)=>{
    if(sql.includes('FROM sessions'))return result([activeUser]);
    if(sql.includes('total_devices'))return result([metrics]);
    if(sql.includes('count(*)::int AS count FROM devices'))return result([{count:12}]);
    if(sql.includes('SELECT DISTINCT d.category'))return result([{category:'Zutritt',manufacturer:'Secura'}]);
    if(sql.includes('FROM object_locations'))return result([{id:location,name:'Eingang',code:'EG',location_type:'area',parent_id:null}]);
    if(sql.includes('SELECT id FROM sites'))return result([{id:site}]);
    if(sql.includes('FROM maintenance_orders o'))return result([{
      id:'00000000-0000-4000-8000-0000000000e1',tenant_id:tenant,site_id:site,device_id:device,
      order_number:'MAIN-2026-000042',maintenance_type:'inspection',description:'Prüfung',status:'planned',
      due_on:'2026-12-01',responsible_employee_id:employee,responsible_employee_name:'Ava Worker',created_at:'2026-01-01',
    }]);
    if(sql.includes('FROM alarms'))return result([{id:'alarm-1',severity:'high',status:'open',message:'Störung',triggered_at:'2026-01-01',resolved_at:null}]);
    if(sql.includes('FROM dms_documents'))return result([{
      id:'doc-1',title:'Prüfprotokoll',description:null,document_number:null,document_type:'Prüfung',
      document_status:'active',approval_status:'approved',valid_until:null,latest_version_id:'version-1',created_at:'2026-01-01',
    }]);
    if(sql.includes('FROM audit_events'))return result([{
      id:'audit-1',event_type:'devices.created',entity_type:'device',entity_id:device,
      details:{changed_fields:['name']},created_at:'2026-01-01',
    }]);
    if(sql.includes('UPDATE devices d'))return result([deviceRow]);
    if(sql.includes('FROM devices d'))return result(sql.includes('count(*)') ? [] : [deviceRow]);
    return result([metrics]);
  });
});

describe('central device management routes',()=>{
  it('returns real inventory metrics from the single device table',async()=>{
    const response=await request(app).get('/api/v1/devices/overview').set('Cookie',csrf);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({total_devices:12,overdue_inspections:2,upcoming_maintenance:4}));
    const call=queryMock.mock.calls.find(([sql])=>String(sql).includes('total_devices'));
    expect(String(call?.[0])).toContain("d.device_kind='operational'");
    expect(call?.[1]).toEqual([tenant]);
  });

  it('filters, sorts and paginates the inventory with combined criteria',async()=>{
    const response=await request(app)
      .get('/api/v1/devices/inventory?search=Leser&site_id='+site+'&operational_status=active&inspection_due=soon&maintenance_due=soon&sort=name&dir=desc&page=2&pageSize=10')
      .set('Cookie',csrf);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({total:12,page:2,pageSize:10,totalPages:2}));
    const listCall=queryMock.mock.calls.find(([sql])=>String(sql).includes('ORDER BY d.name DESC'));
    expect(String(listCall?.[0])).toContain('responsible_employee_name');
    expect(listCall?.[1]).toEqual(expect.arrayContaining([tenant,site,'%Leser%','active',10,10]));
  });

  it('builds a valid inventory query without an empty scope condition',async()=>{
    const response=await request(app).get('/api/v1/devices/inventory').set('Cookie',csrf);
    expect(response.status).toBe(200);
    const countCall=queryMock.mock.calls.find(([sql])=>String(sql).includes('count(*)::int AS count FROM devices'));
    const sql=String(countCall?.[0]);
    expect(sql).toMatch(/WHERE d\.tenant_id=\$1 AND d\.device_kind='operational'$/);
    expect(sql).not.toContain('AND AND');
  });

  it('applies the site scope to every inventory query',async()=>{
    activeUser={...baseUser,permissions:['devices:read'],permission_grants:[{code:'devices:read',scope:'site'}]};
    const response=await request(app).get('/api/v1/devices/inventory').set('Cookie',csrf);
    expect(response.status).toBe(200);
    const countCall=queryMock.mock.calls.find(([sql])=>String(sql).includes('count(*)::int AS count FROM devices'));
    expect(String(countCall?.[0])).toContain('d.site_id = ANY($2::uuid[])');
    expect(countCall?.[1]).toEqual(expect.arrayContaining([tenant,[site]]));
  });

  it('returns the complete device file with maintenance, alarms, documents and audit',async()=>{
    const response=await request(app).get(`/api/v1/devices/${device}/file`).set('Cookie',csrf);
    expect(response.status).toBe(200);
    expect(response.body.device.name).toBe('Zutrittsleser 01');
    expect(response.body.maintenance_orders).toHaveLength(1);
    expect(response.body.alarms).toHaveLength(1);
    expect(response.body.documents).toHaveLength(1);
    const documentCall=queryMock.mock.calls.find(([sql])=>String(sql).includes("FROM dms_documents\n"));
    expect(String(documentCall?.[0])).toContain("v.lifecycle_state='available'");
    expect(response.body.history[0].event_type).toBe('devices.created');
  });

  it('returns 404 for devices outside the accessible tenant',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([activeUser]);
      return result([]);
    });
    const response=await request(app).get(`/api/v1/devices/${device}/file`).set('Cookie',csrf);
    expect(response.status).toBe(404);
  });

  it('updates inspection data and writes an audit event',async()=>{
    const response=await request(app).post(`/api/v1/devices/${device}/inspection`).set(headers)
      .send({last_inspection_on:'2026-11-20',next_inspection_on:'2027-11-20'});
    expect(response.status).toBe(200);
    const update=queryMock.mock.calls.find(([sql])=>String(sql).includes('UPDATE devices d SET last_inspection_on'));
    expect(update?.[1]).toEqual(expect.arrayContaining([tenant,device,'2026-11-20','2027-11-20']));
    const audit=queryMock.mock.calls.find(([sql])=>String(sql).includes('INSERT INTO audit_events'));
    expect(audit?.[1]?.[2]).toBe('devices.inspection_updated');
  });

  it('rejects inspection dates in the wrong order',async()=>{
    const response=await request(app).post(`/api/v1/devices/${device}/inspection`).set(headers)
      .send({last_inspection_on:'2026-11-20',next_inspection_on:'2026-01-01'});
    expect(response.status).toBe(400);
  });

  it('archives a device without changing its technical status',async()=>{
    const response=await request(app).post(`/api/v1/devices/${device}/archive`).set(headers).send({reason:'Ausmusterung'});
    expect(response.status).toBe(200);
    const update=queryMock.mock.calls.find(([sql])=>String(sql).includes("operational_status='decommissioned'"));
    expect(String(update?.[0])).not.toContain('status=$');
    const audit=queryMock.mock.calls.find(([sql])=>String(sql).includes('INSERT INTO audit_events'));
    expect(audit?.[1]?.[2]).toBe('devices.archived');
    expect(audit?.[1]?.[5]).toEqual(expect.objectContaining({previous_status:'active'}));
  });

  it('includes generic device audit events in the device file history',async()=>{
    const response=await request(app).get(`/api/v1/devices/${device}/file`).set('Cookie',csrf);
    expect(response.status).toBe(200);
    const historyCall=queryMock.mock.calls.find(([sql])=>String(sql).includes('FROM audit_events'));
    expect(String(historyCall?.[0])).toContain("entity_type IN ('device','devices')");
  });

  it('changes the responsible employee and records the audit event',async()=>{
    const response=await request(app).post(`/api/v1/devices/${device}/assign-responsible`).set(headers)
      .send({responsible_employee_id:employee});
    expect(response.status).toBe(200);
    const update=queryMock.mock.calls.find(([sql])=>String(sql).includes('SET responsible_employee_id=$3'));
    expect(update?.[1]).toEqual(expect.arrayContaining([tenant,device,employee]));
    const audit=queryMock.mock.calls.find(([sql])=>String(sql).includes('INSERT INTO audit_events'));
    expect(audit?.[1]?.[2]).toBe('devices.responsible_changed');
  });

  it('rejects a responsible employee from another tenant',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([activeUser]);
      if(sql.includes('FROM employees'))return result([]);
      return result([]);
    });
    const response=await request(app).post(`/api/v1/devices/${device}/assign-responsible`).set(headers)
      .send({responsible_employee_id:employee});
    expect(response.status).toBe(404);
  });

  it('assigns a site and rejects locations from another object',async()=>{
    const response=await request(app).post(`/api/v1/devices/${device}/assign-site`).set(headers)
      .send({site_id:site,location_id:location});
    expect(response.status).toBe(200);
    const update=queryMock.mock.calls.find(([sql])=>String(sql).includes('SET site_id=$3'));
    expect(update?.[1]).toEqual(expect.arrayContaining([tenant,device,site,location]));
  });

  it('requires devices:delete for final deletion and keeps the inventory filter',async()=>{
    activeUser={...baseUser,permissions:['devices:read','devices:write','sites:read','dms:read']};
    const denied=await request(app).delete(`/api/v1/devices/${device}`).set(headers);
    expect(denied.status).toBe(403);
    activeUser=baseUser;
    const response=await request(app).delete(`/api/v1/devices/${device}`).set(headers);
    expect(response.status).toBe(204);
    const call=queryMock.mock.calls.find(([sql])=>String(sql).startsWith('DELETE FROM devices'));
    expect(String(call?.[0])).toContain("device_kind='operational'");
  });

  it('lists DMS documents filtered by their device assignment',async()=>{
    const response=await request(app).get(`/api/v1/dms/documents?device_id=${device}`).set('Cookie',csrf);
    expect(response.status).toBe(200);
    expect(response.body[0].title).toBe('Prüfprotokoll');
    const call=queryMock.mock.calls.find(([sql])=>String(sql).includes('FROM dms_documents d LEFT JOIN'));
    expect(String(call?.[0])).toContain('AND d.device_id=$2');
    expect(call?.[1]).toEqual(expect.arrayContaining([tenant,device]));
    expect(call?.[1]).toHaveLength(2);
  });

  it('blocks a site assignment outside the permitted scope',async()=>{
    activeUser={...baseUser,permissions:['devices:write'],permission_grants:[{code:'devices:write',scope:'site'}]};
    const response=await request(app).post(`/api/v1/devices/${device}/assign-site`).set(headers)
      .send({site_id:otherSite,location_id:null});
    expect(response.status).toBe(403);
  });
});
