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

const tenant='00000000-0000-4000-8000-000000000010';
const device='00000000-0000-4000-8000-000000000020';
const newDevice='00000000-0000-4000-8000-000000000021';
const site='00000000-0000-4000-8000-000000000030';
const point='00000000-0000-4000-8000-000000000031';
const employee='00000000-0000-4000-8000-000000000032';
const csrf={Cookie:['securityops_session=session-1','securityops_csrf=csrf-value'],'x-csrf-token':'csrf-value'};
const result=(rows:unknown[],rowCount=rows.length)=>({rows,rowCount} as unknown as QueryResult);
const baseUser={
  id:'00000000-0000-4000-8000-000000000001',tenantId:tenant,email:'operator@example.invalid',role:'operator',
  permissions:['nfc_devices:read','nfc_devices:write','nfc_devices:security'],permission_grants:[],site_ids:[site],
  session_id:'session-1',csrf_token:'csrf-value',expires_at:'2099-01-01',
};
let activeUser=baseUser;
const deviceRow={
  id:device,tenant_id:tenant,identifier:'TAG-001',device_type:'tag',manufacturer:'Acme',status:'active',
  employee_id:null,site_id:null,control_point_id:point,notes:'',registered_at:'2026-01-01',updated_at:'2026-01-02',
  control_point_name:'Punkt 1',site_name:'Objekt 1',employee_name:null,control_point_site_id:site,last_used_at:null,
};

beforeEach(()=>{
  queryMock.mockReset();
  activeUser=baseUser;
  queryMock.mockImplementation(async(sql:string)=>{
    if(sql.includes('FROM sessions'))return result([activeUser]);
    if(sql.includes('FROM control_points'))return result([{id:point,site_id:site,name:'Punkt 1',site_name:'Objekt 1'}]);
    if(sql.includes('FROM nfc_devices n LEFT JOIN'))return result([deviceRow]);
    if(sql.includes('SELECT n.*,e.name employee_name'))return result([deviceRow]);
    if(sql.includes('SELECT * FROM nfc_devices'))return result([deviceRow]);
    return result([]);
  });
});

const calls=(fragment:string)=>queryMock.mock.calls.filter(([sql])=>String(sql).includes(fragment));
const auditCall=(event:string)=>calls('INSERT INTO audit_events').find(([,values])=>String((values as unknown[])?.[2])===event);

describe('NFC device management routes',()=>{
  it('returns real tenant-scoped KPIs and scan count',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([activeUser]);
      if(sql.includes('count(*) FILTER'))return result([{total:10,active_tags:6,active_readers:2,blocked:1,lost:1,replaced:1,unassigned:3}]);
      if(sql.includes('count(DISTINCT nfc_device_id)'))return result([{scans:42,devices:5}]);
      if(sql.includes('JOIN patrol_scans ps'))return result([{id:device,identifier:'TAG-001',last_used_at:'2026-11-26T10:00:00Z'}]);
      return result([]);
    });
    const response=await request(app).get('/api/v1/nfc-devices/overview?days=14').set('Cookie',csrf.Cookie);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({total:10,active_tags:6,active_readers:2,scans:42,days:14}));
    expect(response.body.recent).toHaveLength(1);
    expect(calls('count(DISTINCT nfc_device_id)')[0]?.[1]).toEqual([tenant,14]);
  });

  it('combines filters, sorting and pagination in one inventory query',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([activeUser]);
      if(sql.includes('count(*)::int total FROM nfc_devices'))return result([{total:37}]);
      return result([deviceRow]);
    });
    const response=await request(app).get('/api/v1/nfc-devices/inventory?q=TAG&device_type=tag&status=blocked&site_id='+site
      +'&control_point_id='+point+'&employee_id='+employee+'&assignment=assigned&sort=last_used_at&dir=asc&page=2&pageSize=10')
      .set('Cookie',csrf.Cookie);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({total:37,page:2,pageSize:10,totalPages:4}));
    const listCall=calls('ORDER BY')[0];
    expect(String(listCall?.[0])).toContain('n.identifier ILIKE $2');
    expect(String(listCall?.[0])).toContain('n.device_type=$3');
    expect(String(listCall?.[0])).toContain('n.status=$4');
    expect(String(listCall?.[0])).toContain('num_nonnulls(n.employee_id,n.site_id,n.control_point_id)>0');
    expect(String(listCall?.[0])).toContain('SELECT MAX(ps.server_received_at)');
    expect(listCall?.[1]).toEqual(expect.arrayContaining([tenant,'%TAG%','tag','blocked',site,point,employee,10,10]));
  });

  it('returns all assignment options from the tenant',async()=>{
    const response=await request(app).get('/api/v1/nfc-devices/filter-options').set('Cookie',csrf.Cookie);
    expect(response.status).toBe(200);
    expect(response.body.sites).toEqual([]);
    expect(response.body.control_points).toEqual([{id:point,site_id:site,name:'Punkt 1',site_name:'Objekt 1'}]);
    expect(response.body.employees).toEqual([]);
  });

  it('assembles the complete device file including rejected scans and documents',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([activeUser]);
      if(sql.includes('SELECT n.*,e.name employee_name'))return result([deviceRow]);
      if(sql.includes('FROM nfc_device_assignment_history'))return result([{id:'assignment-1',previous_assignment:{},assignment:{control_point_id:point},assigned_at:'2026-01-02'}]);
      if(sql.includes('FROM nfc_device_replacements'))return result([{id:'replacement-1',old_device_id:device,new_device_id:newDevice,reason:'Defekt',replaced_at:'2026-01-03',old_assignment:{},new_assignment:{}}]);
      if(sql.includes('FROM patrol_scans ps'))return result([{id:'scan-1',control_point_name:'Punkt 1',site_name:'Objekt 1',server_received_at:'2026-11-26T10:00:00Z',outcome:'accepted'}]);
      if(sql.includes('FROM dms_documents d'))return result([{id:'doc-1',title:'Prüfprotokoll',versions:[{id:'v1',version_no:1,lifecycle_state:'available'}]}]);
      if(sql.includes("entity_type='nfc_device'"))return result([{id:'audit-1',event_type:'nfc_device.created',details:{},created_at:'2026-01-01'}]);
      if(sql.includes('patrol.scan.rejected'))return result([{id:'audit-2',event_type:'patrol.scan.rejected',details:{reason:'NFC-Tag ist nicht aktiv',code:'NFC_TAG_NOT_ACTIVE',nfc_uid:'TAG-001'},created_at:'2026-11-26T11:00:00Z'}]);
      return result([]);
    });
    const response=await request(app).get(`/api/v1/nfc-devices/${device}/file`).set('Cookie',csrf.Cookie);
    expect(response.status).toBe(200);
    expect(response.body.device.identifier).toBe('TAG-001');
    expect(response.body.assignment_history).toHaveLength(1);
    expect(response.body.replacements).toHaveLength(1);
    expect(response.body.documents).toHaveLength(1);
    expect(response.body.scans).toHaveLength(2);
    expect(response.body.scans[0].outcome).toBe('rejected');
    expect(response.body.scans[0].reason).toBe('NFC-Tag ist nicht aktiv');
  });

  it('assigns a control point, writes assignment history and audits the change',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([activeUser]);
      if(sql.includes('SELECT * FROM nfc_devices')&&sql.includes('FOR UPDATE'))return result([deviceRow]);
      if(sql.includes('FROM control_points t'))return result([{id:point,site_id:site}]);
      if(sql.includes('SELECT site_id FROM control_points'))return result([{site_id:site}]);
      if(sql.includes('UPDATE nfc_devices SET employee_id'))return result([{...deviceRow,control_point_id:point}]);
      if(sql.includes('INSERT INTO audit_events'))return result([{id:'audit-1'}]);
      return result([]);
    });
    const response=await request(app).post(`/api/v1/nfc-devices/${device}/assign`).set(csrf)
      .send({control_point_id:point,reason:'Neuer Kontrollpunkt'});
    expect(response.status).toBe(200);
    const history=calls('INSERT INTO nfc_device_assignment_history')[0];
    expect(history?.[1]).toEqual(expect.arrayContaining([tenant,device,'Neuer Kontrollpunkt']));
    expect(auditCall('nfc_device.assigned')?.[1]?.[5]).toEqual(expect.objectContaining({site_id:site}));
  });

  it('rejects foreign assignment targets and more than one target',async()=>{
    queryMock.mockImplementation(async(sql:string)=>sql.includes('FROM sessions')?result([activeUser]):result([]));
    const foreign=await request(app).post(`/api/v1/nfc-devices/${device}/assign`).set(csrf).send({site_id:site});
    expect(foreign.status).toBe(404);
    const multiple=await request(app).post(`/api/v1/nfc-devices/${device}/assign`).set(csrf).send({site_id:site,employee_id:employee});
    expect(multiple.status).toBe(400);
    expect(calls('UPDATE nfc_devices SET employee_id')).toHaveLength(0);
  });

  it('reports loss with date and reason and blocks subsequent scans',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([activeUser]);
      if(sql.includes('SELECT * FROM nfc_devices')&&sql.includes('FOR UPDATE'))return result([deviceRow]);
      if(sql.includes("status='lost'"))return result([{...deviceRow,status:'lost',lost_at:'2026-11-26',event_reason:'Verloren auf dem Weg'}]);
      if(sql.includes('INSERT INTO audit_events'))return result([{id:'audit-1'}]);
      return result([]);
    });
    const response=await request(app).post(`/api/v1/nfc-devices/${device}/report-lost`).set(csrf)
      .send({lost_at:'2026-11-26',reason:'Verloren auf dem Weg'});
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('lost');
    const update=calls("status='lost'")[0];
    expect(update?.[1]).toEqual(expect.arrayContaining([tenant,'2026-11-26','Verloren auf dem Weg',activeUser.id]));
    expect(auditCall('nfc_device.lost.reported')).toBeDefined();
  });

  it('blocks and reactivates only in valid states with a reason',async()=>{
    let lockedRow={...deviceRow,status:'active'};
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([activeUser]);
      if(sql.includes('SELECT * FROM nfc_devices')&&sql.includes('FOR UPDATE'))return result([lockedRow]);
      if(sql.includes("status='blocked'")){lockedRow={...deviceRow,status:'blocked'};return result([lockedRow]);}
      if(sql.includes("status='active'")){lockedRow={...deviceRow,status:'active'};return result([lockedRow]);}
      return result([]);
    });
    const blocked=await request(app).post(`/api/v1/nfc-devices/${device}/block`).set(csrf).send({reason:'Missbrauch verdächtig'});
    expect(blocked.status).toBe(200);
    expect(blocked.body.status).toBe('blocked');
    expect(auditCall('nfc_device.blocked')?.[1]?.[5]).toEqual(expect.objectContaining({reason:'Missbrauch verdächtig'}));
    const reactivated=await request(app).post(`/api/v1/nfc-devices/${device}/reactivate`).set(csrf).send({reason:'Wiedergefunden'});
    expect(reactivated.status).toBe(200);
    expect(reactivated.body.status).toBe('active');
    expect(auditCall('nfc_device.reactivated')).toBeDefined();
  });

  it('rejects invalid status transitions and short reasons',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([activeUser]);
      if(sql.includes('SELECT * FROM nfc_devices')&&sql.includes('FOR UPDATE'))return result([{...deviceRow,status:'replaced'}]);
      return result([]);
    });
    const blocked=await request(app).post(`/api/v1/nfc-devices/${device}/block`).set(csrf).send({reason:'Missbrauch'});
    expect(blocked.status).toBe(409);
    const short=await request(app).post(`/api/v1/nfc-devices/${device}/reactivate`).set(csrf).send({reason:'ok'});
    expect(short.status).toBe(400);
  });

  it('registers a replacement, keeps the old history and copies the assignment',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([activeUser]);
      if(sql.includes('SELECT * FROM nfc_devices')&&sql.includes('FOR UPDATE'))return result([deviceRow]);
      if(sql.includes('SELECT id FROM nfc_devices'))return result([]);
      if(sql.includes('INSERT INTO nfc_devices'))return result([{...deviceRow,id:newDevice,identifier:'TAG-002'}]);
      if(sql.includes("status='replaced'"))return result([{...deviceRow,status:'replaced'}]);
      if(sql.includes('INSERT INTO audit_events'))return result([{id:'audit-1'}]);
      return result([]);
    });
    const response=await request(app).post(`/api/v1/nfc-devices/${device}/replace`).set(csrf).send({
      identifier:'TAG-002',device_type:'tag',manufacturer:'Acme',reason:'Defekt',copy_assignment:true,
    });
    expect(response.status).toBe(201);
    expect(response.body.device.identifier).toBe('TAG-002');
    const replacement=calls('INSERT INTO nfc_device_replacements')[0];
    expect(replacement?.[1]).toEqual(expect.arrayContaining([tenant,device,newDevice,'Defekt']));
    expect(String(replacement?.[1]?.[5])).toContain(point);
    expect(calls('INSERT INTO nfc_device_assignment_history')).toHaveLength(1);
    expect(auditCall('nfc_device.replaced')?.[1]?.[5]).toEqual(expect.objectContaining({new_device_id:newDevice}));
  });

  it('rejects duplicate replacement identifiers',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([activeUser]);
      if(sql.includes('SELECT * FROM nfc_devices')&&sql.includes('FOR UPDATE'))return result([deviceRow]);
      if(sql.includes('SELECT id FROM nfc_devices'))return result([{id:newDevice}]);
      return result([]);
    });
    const response=await request(app).post(`/api/v1/nfc-devices/${device}/replace`).set(csrf).send({
      identifier:'TAG-002',device_type:'tag',manufacturer:'Acme',reason:'Defekt',
    });
    expect(response.status).toBe(409);
    expect(calls('INSERT INTO nfc_devices')).toHaveLength(0);
  });

  it('requires the security permission for sensitive actions',async()=>{
    activeUser={...baseUser,permissions:['nfc_devices:read','nfc_devices:write']};
    const response=await request(app).post(`/api/v1/nfc-devices/${device}/block`).set(csrf).send({reason:'Test'});
    expect(response.status).toBe(403);
    expect(calls("status='blocked'")).toHaveLength(0);
  });

  it('requires the read permission for all management data',async()=>{
    activeUser={...baseUser,permissions:['nfc_devices:write','nfc_devices:security']};
    const response=await request(app).get('/api/v1/nfc-devices/overview').set('Cookie',csrf.Cookie);
    expect(response.status).toBe(403);
  });

  it('validates device ids and rejects cross-tenant device access',async()=>{
    const invalid=await request(app).get('/api/v1/nfc-devices/not-a-uuid/file').set('Cookie',csrf.Cookie);
    expect(invalid.status).toBe(400);
    queryMock.mockImplementation(async(sql:string)=>sql.includes('FROM sessions')?result([activeUser]):result([]));
    const missing=await request(app).get(`/api/v1/nfc-devices/${newDevice}/file`).set('Cookie',csrf.Cookie);
    expect(missing.status).toBe(404);
    expect(missing.body.error).toContain('NFC-Gerät nicht gefunden');
  });
});
