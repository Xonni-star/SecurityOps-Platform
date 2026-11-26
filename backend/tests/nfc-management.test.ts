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

  it('assembles the complete device file with approved documents and full histories',async()=>{
    activeUser={...baseUser,permissions:[...baseUser.permissions,'dms:read','audit:read']};
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([activeUser]);
      if(sql.includes('SELECT n.*,e.name employee_name'))return result([deviceRow]);
      if(sql.includes('FROM nfc_device_assignment_history'))return result([{id:'assignment-1',previous_assignment:{},assignment:{control_point_id:point},assigned_at:'2026-01-02'}]);
      if(sql.includes('FROM nfc_device_replacements'))return result([{id:'replacement-1',old_device_id:device,new_device_id:newDevice,reason:'Defekt',replaced_at:'2026-01-03',old_assignment:{},new_assignment:{}}]);
      if(sql.includes('FROM dms_documents d'))return result([{id:'doc-1',title:'Prüfprotokoll',versions:[{id:'v1',version_no:1,lifecycle_state:'available'},{id:'v2',version_no:2,lifecycle_state:'draft'}]}]);
      if(sql.includes("entity_type='nfc_device'"))return result([{id:'audit-1',event_type:'nfc_device.created',details:{},created_at:'2026-01-01',actor_user_id:activeUser.id}]);
      return result([]);
    });
    const response=await request(app).get(`/api/v1/nfc-devices/${device}/file`).set('Cookie',csrf.Cookie);
    expect(response.status).toBe(200);
    expect(response.body.device.identifier).toBe('TAG-001');
    expect(response.body.assignment_history).toHaveLength(1);
    expect(response.body.replacements).toHaveLength(1);
    expect(response.body.documents).toHaveLength(1);
    expect(response.body.documents[0].versions).toHaveLength(1);
    expect(String(calls('FROM dms_documents d')[0]?.[0])).toContain("approval_status='approved'");
    expect(response.body.history[0].actor_user_id).toBe(activeUser.id);
    expect(response.body.scans).toBeUndefined();
    expect(String(calls('FROM dms_documents d')[0]?.[0])).toContain("d.document_status='active'");
    expect(String(calls('FROM dms_documents d')[0]?.[0])).toContain("v.lifecycle_state='available'");
  });

  it('withholds documents and audit actors without the corresponding permissions',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([activeUser]);
      if(sql.includes('SELECT n.*,e.name employee_name'))return result([deviceRow]);
      if(sql.includes('FROM dms_documents d'))return result([{id:'doc-1',title:'Prüfprotokoll',versions:[{id:'v1',version_no:1,lifecycle_state:'available'}]}]);
      if(sql.includes("entity_type='nfc_device'"))return result([{id:'audit-1',event_type:'nfc_device.created',details:{},created_at:'2026-01-01',actor_user_id:activeUser.id}]);
      return result([]);
    });
    const response=await request(app).get(`/api/v1/nfc-devices/${device}/file`).set('Cookie',csrf.Cookie);
    expect(response.status).toBe(200);
    expect(response.body.documents).toEqual([]);
    expect(response.body.history).toEqual([]);
  });

  it('returns paginated accepted and rejected scans with filters and real audit details',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([activeUser]);
      if(sql.includes('SELECT id FROM nfc_devices'))return result([{id:device}]);
      if(sql.includes('count(*)::int total FROM events'))return result([{total:31}]);
      if(sql.includes('FROM events'))return result([{
        id:'scan-1',outcome:'rejected',nfc_uid:'TAG-001',control_point_name:'Punkt 1',site_name:'Objekt 1',
        scanned_at:'2026-11-26T10:00:00Z',server_received_at:'2026-11-26T10:00:01Z',
        scan_authentication:null,deviation:null,rejection_reason:'NFC-Tag ist archiviert',rejection_code:'NFC_TAG_ARCHIVED',
      }]);
      return result([]);
    });
    const response=await request(app)
      .get(`/api/v1/nfc-devices/${device}/scan-history?page=2&pageSize=5&from=2026-11-01&to=2026-11-30&outcome=rejected&control_point_id=${point}`)
      .set('Cookie',csrf.Cookie);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({total:31,page:2,pageSize:5,totalPages:7}));
    expect(response.body.rows[0]).toEqual(expect.objectContaining({outcome:'rejected',rejection_code:'NFC_TAG_ARCHIVED'}));
    expect(response.headers['x-total-count']).toBe('31');
    const sql=String(calls('FROM events')[0]?.[0]);
    expect(sql).toContain("patrol.scan.rejected");
    expect(sql).toContain('effective_at >=');
    expect(sql).toContain('control_point_id=$');
    expect(calls('FROM events')[0]?.[1]).toEqual([tenant,device,'2026-11-01T00:00:00.000Z','2026-11-30T23:59:59.999Z',point,'rejected']);
    const rowCall=calls('FROM events').find(([sql])=>String(sql).includes('ORDER BY'));
    expect(rowCall?.[1]).toEqual([tenant,device,'2026-11-01T00:00:00.000Z','2026-11-30T23:59:59.999Z',point,'rejected',5,5]);
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

  it.each([
    ['gesperrten',{status:'blocked'},'Gesperrt'],
    ['verlorenen',{status:'lost'},'Verloren'],
    ['ersetzten',{status:'replaced'},'Ersetzt'],
    ['archivierten',{archived_at:'2026-11-26T12:00:00Z'},'archiviert'],
    ['trotz geändertem Archivierungsstatus ersetzten',{status:'active',replaced_at:'2026-11-26T12:00:00Z'},'ersetzt'],
  ])('lehnt die Zuordnung eines %s Geräts serverseitig ab',async(_label,override,expected)=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([activeUser]);
      if(sql.includes('SELECT * FROM nfc_devices')&&sql.includes('FOR UPDATE'))return result([{...deviceRow,...override}]);
      if(sql.includes('FROM employees t'))return result([{id:employee,site_id:null}]);
      return result([]);
    });
    const response=await request(app).post(`/api/v1/nfc-devices/${device}/assign`).set(csrf)
      .send({employee_id:employee,reason:'Zuordnung prüfen'});
    expect(response.status).toBe(409);
    expect(response.body.error.toLowerCase()).toContain(String(expected).toLowerCase());
    expect(calls('UPDATE nfc_devices SET employee_id')).toHaveLength(0);
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

  it('never reactivates a lost or replaced device through the reactivation endpoint',async()=>{
    for(const status of ['lost','replaced']){
      queryMock.mockImplementation(async(sql:string)=>{
        if(sql.includes('FROM sessions'))return result([activeUser]);
        if(sql.includes('SELECT * FROM nfc_devices')&&sql.includes('FOR UPDATE'))return result([{...deviceRow,status}]);
        return result([]);
      });
      const response=await request(app).post(`/api/v1/nfc-devices/${device}/reactivate`).set(csrf).send({reason:'Prüfung'});
      expect(response.status).toBe(409);
    }
    expect(calls("status='active'")).toHaveLength(0);
  });

  it('forces lost devices through the recovery protocol instead of blocking them',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([activeUser]);
      if(sql.includes('SELECT * FROM nfc_devices')&&sql.includes('FOR UPDATE'))return result([{...deviceRow,status:'lost',lost_at:'2026-11-26'}]);
      return result([]);
    });
    const response=await request(app).post(`/api/v1/nfc-devices/${device}/block`).set(csrf).send({reason:'Umgehung'});
    expect(response.status).toBe(409);
    expect(response.body.error).toContain('wiedergefunden');
    expect(calls("status='blocked'")).toHaveLength(0);
  });

  it('requires an explicit copy_assignment decision on every replacement',async()=>{
    queryMock.mockImplementation(async(sql:string)=>sql.includes('FROM sessions')?result([activeUser]):result([]));
    const response=await request(app).post(`/api/v1/nfc-devices/${device}/replace`).set(csrf).send({
      identifier:'TAG-002',device_type:'tag',manufacturer:'Acme',reason:'Defekt',
    });
    expect(response.status).toBe(400);
    expect(calls('INSERT INTO nfc_devices')).toHaveLength(0);
  });

  it('registers a replacement, keeps the old history and copies the assignment',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([activeUser]);
      if(sql.includes('SELECT * FROM nfc_devices')&&sql.includes('FOR UPDATE'))return result([deviceRow]);
      if(sql.includes('SELECT id FROM nfc_devices'))return result([]);
      if(sql.includes('INSERT INTO nfc_devices'))return result([{...deviceRow,id:newDevice,identifier:'TAG-002'}]);
      if(sql.includes("status='replaced'"))return result([{...deviceRow,status:'replaced'}]);
      if(sql.includes("SET status='active'"))return result([{...deviceRow,id:newDevice,identifier:'TAG-002',status:'active'}]);
      if(sql.includes('INSERT INTO audit_events'))return result([{id:'audit-1'}]);
      return result([]);
    });
    const response=await request(app).post(`/api/v1/nfc-devices/${device}/replace`).set(csrf).send({
      identifier:'TAG-002',device_type:'tag',manufacturer:'Acme',reason:'Defekt',copy_assignment:true,
    });
    expect(response.status).toBe(201);
    expect(response.body.device.identifier).toBe('TAG-002');
    expect(response.body.device.status).toBe('active');
    const replacement=calls('INSERT INTO nfc_device_replacements')[0];
    expect(replacement?.[1]).toEqual(expect.arrayContaining([tenant,device,newDevice,'Defekt']));
    expect(String(replacement?.[1]?.[5])).toContain(point);
    expect(calls('INSERT INTO nfc_device_assignment_history')).toHaveLength(2);
    expect(auditCall('nfc_device.replaced')?.[1]?.[5]).toEqual(expect.objectContaining({
      new_device_id:newDevice,old_device_id:device,copy_assignment:true,
    }));
  });

  it('rejects duplicate replacement identifiers',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([activeUser]);
      if(sql.includes('SELECT * FROM nfc_devices')&&sql.includes('FOR UPDATE'))return result([deviceRow]);
      if(sql.includes('SELECT id FROM nfc_devices'))return result([{id:newDevice}]);
      return result([]);
    });
    const response=await request(app).post(`/api/v1/nfc-devices/${device}/replace`).set(csrf).send({
      identifier:'TAG-002',device_type:'tag',manufacturer:'Acme',reason:'Defekt',copy_assignment:false,
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

  it('exposes archive and recent-use KPIs with matching inventory filters',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([activeUser]);
      if(sql.includes('count(*) FILTER'))return result([{total:12,active_tags:4,active_readers:1,blocked:2,lost:1,
        replaced:2,archived:3,unassigned:5}]);
      if(sql.includes('count(DISTINCT nfc_device_id)'))return result([{scans:9,devices:4}]);
      if(sql.includes('count(*)::int total FROM nfc_devices'))return result([{total:3}]);
      return result([deviceRow]);
    });
    const overview=await request(app).get('/api/v1/nfc-devices/overview').set('Cookie',csrf.Cookie);
    expect(overview.status).toBe(200);
    expect(overview.body).toEqual(expect.objectContaining({archived:3,recent_devices:4}));
    const inventory=await request(app).get('/api/v1/nfc-devices/inventory?archived=true&recent=true').set('Cookie',csrf.Cookie);
    expect(inventory.status).toBe(200);
    const sql=String(calls('n.archived_at IS NOT NULL')[0]?.[0]);
    expect(sql).toContain('n.archived_at IS NOT NULL');
    expect(sql).toContain("interval '30 days'");
    expect(calls('n.archived_at IS NOT NULL')[0]?.[1]).toEqual(expect.arrayContaining([tenant]));
  });

  it('offers real devices as replacement options',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([activeUser]);
      if(sql.includes('FROM nfc_devices'))return result([{id:newDevice,identifier:'TAG-002',device_type:'tag',manufacturer:'Acme',status:'active'}]);
      return result([]);
    });
    const response=await request(app).get('/api/v1/nfc-devices/filter-options').set('Cookie',csrf.Cookie);
    expect(response.status).toBe(200);
    expect(response.body.devices).toEqual([expect.objectContaining({id:newDevice,identifier:'TAG-002',device_type:'tag',manufacturer:'Acme',status:'active'})]);
    expect(String(calls('FROM nfc_devices')[0]?.[0])).toContain("status<>'replaced'");
    expect(String(calls('FROM nfc_devices')[0]?.[0])).toContain('employee_name');
  });

  it('recovers a lost device only into quarantine after identity and assignment confirmation',async()=>{
    let lockedRow={...deviceRow,status:'lost',lost_at:'2026-11-26'};
    queryMock.mockImplementation(async(sql:string,values?:unknown[])=>{
      if(sql.includes('FROM sessions'))return result([activeUser]);
      if(sql.includes('SELECT * FROM nfc_devices')&&sql.includes('FOR UPDATE'))return result([lockedRow]);
      if(sql.includes("SET status='blocked'")){
        lockedRow={...lockedRow,status:'blocked',recovered_at:String(values?.[0]??''),recovered_reason:String(values?.[1]??'')};
        return result([lockedRow]);
      }
      if(sql.includes('INSERT INTO audit_events'))return result([{id:'audit-1'}]);
      return result([]);
    });
    const rejected=await request(app).post(`/api/v1/nfc-devices/${device}/recover`).set(csrf).send({
      found_at:'2026-11-27',identifier_confirmation:'FALSCH',assignment_confirmed:true,reason:'Wiedergefunden',
    });
    expect(rejected.status).toBe(409);
    expect(calls("SET status='blocked'")).toHaveLength(0);
    const response=await request(app).post(`/api/v1/nfc-devices/${device}/recover`).set(csrf).send({
      found_at:'2026-11-27',identifier_confirmation:'TAG-001',assignment_confirmed:true,reason:'Wiedergefunden und geprüft',
    });
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('blocked');
    expect(response.body.recovered_at).toBe('2026-11-27');
    expect(auditCall('nfc_device.recovered')?.[1]?.[5]).toEqual(expect.objectContaining({
      previous_status:'lost',found_at:'2026-11-27',reason:'Wiedergefunden und geprüft',
    }));
    expect(calls("SET status='active'")).toHaveLength(0);
    const missingConfirmation=await request(app).post(`/api/v1/nfc-devices/${device}/recover`).set(csrf).send({
      found_at:'2026-11-27',identifier_confirmation:'TAG-001',reason:'Wiedergefunden',
    });
    expect(missingConfirmation.status).toBe(400);
  });

  it('archives a device without changing its scan history and blocks further changes',async()=>{
    let lockedRow={...deviceRow,status:'active',archived_at:null};
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([activeUser]);
      if(sql.includes('SELECT * FROM nfc_devices')&&sql.includes('FOR UPDATE'))return result([lockedRow]);
      if(sql.includes('SET archived_at=now()')){
        lockedRow={...lockedRow,archived_at:'2026-11-26T12:00:00Z'};
        return result([lockedRow]);
      }
      if(sql.includes('INSERT INTO audit_events'))return result([{id:'audit-1'}]);
      return result([]);
    });
    const response=await request(app).post(`/api/v1/nfc-devices/${device}/archive`).set(csrf).send({reason:'Außerbetriebnahme'});
    expect(response.status).toBe(200);
    expect(response.body.archived_at).toBeTruthy();
    expect(auditCall('nfc_device.archived')?.[1]?.[5]).toEqual(expect.objectContaining({reason:'Außerbetriebnahme'}));
    expect(calls('patrol_scans')).toHaveLength(0);
    const blocked=await request(app).post(`/api/v1/nfc-devices/${device}/block`).set(csrf).send({reason:'Test'});
    expect(blocked.status).toBe(409);
    const assigned=await request(app).post(`/api/v1/nfc-devices/${device}/assign`).set(csrf).send({site_id:site});
    expect(assigned.status).toBe(409);
    const reactivated=await request(app).post(`/api/v1/nfc-devices/${device}/reactivate`).set(csrf).send({reason:'Test'});
    expect(reactivated.status).toBe(409);
  });

  it('replaces a device with an existing tenant device and preserves the old-new link',async()=>{
    const existing={...deviceRow,id:newDevice,identifier:'TAG-002',status:'active',control_point_id:null,site_id:null,employee_id:null};
    queryMock.mockImplementation(async(sql:string,values?:unknown[])=>{
      if(sql.includes('FROM sessions'))return result([activeUser]);
      if(sql.includes('SELECT * FROM nfc_devices')&&sql.includes('FOR UPDATE')){
        return result([values?.[1]===device?deviceRow:existing]);
      }
      if(sql.includes("status='replaced'"))return result([{...deviceRow,status:'replaced'}]);
      if(sql.includes("SET status='active'"))return result([{...existing,status:'active',control_point_id:point}]);
      if(sql.includes('INSERT INTO nfc_device_assignment_history'))return result([{id:'history-1'}]);
      if(sql.includes('INSERT INTO audit_events'))return result([{id:'audit-1'}]);
      return result([]);
    });
    const response=await request(app).post(`/api/v1/nfc-devices/${device}/replace`).set(csrf).send({
      new_device_id:newDevice,reason:'Defekt',copy_assignment:true,
    });
    expect(response.status).toBe(201);
    expect(response.body.device.id).toBe(newDevice);
    expect(response.body.device.control_point_id).toBe(point);
    expect(calls('INSERT INTO nfc_devices')).toHaveLength(0);
    expect(calls('INSERT INTO nfc_device_replacements')[0]?.[1]).toEqual(expect.arrayContaining([tenant,device,newDevice]));
    expect(String(calls('INSERT INTO nfc_device_assignment_history')[1]?.[1]?.[3])).toContain(point);
    expect(auditCall('nfc_device.replaced')?.[1]?.[5]).toEqual(expect.objectContaining({new_device_id:newDevice}));
    expect(auditCall('nfc_device.created')).toBeUndefined();
  });

  it('rejects self-replacement and unavailable existing replacement devices',async()=>{
    const invalid=await request(app).post(`/api/v1/nfc-devices/${device}/replace`).set(csrf)
      .send({new_device_id:device,reason:'Defekt',copy_assignment:false});
    expect(invalid.status).toBe(400);
    queryMock.mockImplementation(async(sql:string,values?:unknown[])=>{
      if(sql.includes('FROM sessions'))return result([activeUser]);
      if(sql.includes('SELECT * FROM nfc_devices')&&sql.includes('FOR UPDATE')){
        return result([values?.[1]===device?deviceRow:{...deviceRow,id:newDevice,archived_at:'2026-11-26'}]);
      }
      return result([]);
    });
    const archived=await request(app).post(`/api/v1/nfc-devices/${device}/replace`).set(csrf)
      .send({new_device_id:newDevice,reason:'Defekt',copy_assignment:false});
    expect(archived.status).toBe(409);
  });

  it.each([
    ['ersetzten',{status:'replaced'},'bereits ersetzt'],
    ['archivierten',{archived_at:'2026-11-26T12:00:00Z'},'archiviert'],
    ['mit ersetztem Zeitstempel trotz aktivem Status',{status:'active',replaced_at:'2026-11-26T12:00:00Z'},'bereits ersetzt'],
  ])('verhindert eine erneute Ersatzaktion für ein %s Gerät',async(_label,override,expected)=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([activeUser]);
      if(sql.includes('SELECT * FROM nfc_devices')&&sql.includes('FOR UPDATE'))return result([{...deviceRow,...override}]);
      return result([]);
    });
    const response=await request(app).post(`/api/v1/nfc-devices/${device}/replace`).set(csrf)
      .send({identifier:'TAG-NEU',device_type:'tag',manufacturer:'Acme',reason:'Defekt',copy_assignment:true});
    expect(response.status).toBe(409);
    expect(response.body.error).toContain(expected);
    expect(calls('INSERT INTO nfc_device_replacements')).toHaveLength(0);
  });

  it('enforces one active tag per control point on assignment changes',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([activeUser]);
      if(sql.includes('SELECT * FROM nfc_devices')&&sql.includes('FOR UPDATE'))return result([{...deviceRow,control_point_id:null}]);
      if(sql.includes('FROM control_points t'))return result([{id:point,site_id:site}]);
      if(sql.includes('SELECT site_id FROM control_points'))return result([{site_id:site}]);
      if(sql.includes('SELECT id FROM nfc_devices'))return result([{id:newDevice}]);
      return result([]);
    });
    const response=await request(app).post(`/api/v1/nfc-devices/${device}/assign`).set(csrf)
      .send({control_point_id:point,reason:'Doppelbelegung'});
    expect(response.status).toBe(409);
    expect(response.body.error).toContain('Kontrollpunkt');
    expect(calls('UPDATE nfc_devices SET employee_id')).toHaveLength(0);
  });

  it('requires security permission and CSRF for archive and recovery',async()=>{
    activeUser={...baseUser,permissions:['nfc_devices:read','nfc_devices:write']};
    const forbidden=await request(app).post(`/api/v1/nfc-devices/${device}/recover`).set(csrf).send({
      found_at:'2026-11-27',identifier_confirmation:'TAG-001',assignment_confirmed:true,reason:'Zurück',
    });
    expect(forbidden.status).toBe(403);
    activeUser=baseUser;
    const noCsrf=await request(app).post(`/api/v1/nfc-devices/${device}/archive`).set('Cookie',csrf.Cookie)
      .send({reason:'Außerbetriebnahme'});
    expect(noCsrf.status).toBe(403);
    expect(calls('SET archived_at=now()')).toHaveLength(0);
  });

  it('never recovers a replaced device even when it was archived afterwards',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([activeUser]);
      if(sql.includes('SELECT * FROM nfc_devices')&&sql.includes('FOR UPDATE')){
        return result([{...deviceRow,status:'replaced',replaced_at:'2026-11-20T10:00:00Z',archived_at:'2026-11-25T10:00:00Z'}]);
      }
      return result([]);
    });
    const response=await request(app).post(`/api/v1/nfc-devices/${device}/recover`).set(csrf).send({
      found_at:'2026-11-27',identifier_confirmation:'TAG-001',assignment_confirmed:true,reason:'Wiedergefunden',
    });
    expect(response.status).toBe(409);
    expect(response.body.error).toContain('Ersetzte');
    expect(calls("SET status='blocked'")).toHaveLength(0);
  });

  it('requires an explicit decision before taking over an existing assignment',async()=>{
    const existing={...deviceRow,id:newDevice,identifier:'TAG-002',status:'active',employee_id:employee,site_id:null,control_point_id:null};
    queryMock.mockImplementation(async(sql:string,values?:unknown[])=>{
      if(sql.includes('FROM sessions'))return result([activeUser]);
      if(sql.includes('SELECT * FROM nfc_devices')&&sql.includes('FOR UPDATE')){
        return result([values?.[1]===device?deviceRow:existing]);
      }
      if(sql.includes("SET status='replaced'"))return result([{...deviceRow,status:'replaced'}]);
      if(sql.includes("SET status='active'"))return result([{...existing,status:'active'}]);
      if(sql.includes('INSERT INTO audit_events'))return result([{id:'audit-1'}]);
      return result([]);
    });
    const withoutAck=await request(app).post(`/api/v1/nfc-devices/${device}/replace`).set(csrf).send({
      new_device_id:newDevice,reason:'Defekt',copy_assignment:false,
    });
    expect(withoutAck.status).toBe(409);
    expect(withoutAck.body.error).toContain('bereits zugeordnet');
    expect(calls("SET status='replaced'")).toHaveLength(0);

    const withAck=await request(app).post(`/api/v1/nfc-devices/${device}/replace`).set(csrf).send({
      new_device_id:newDevice,reason:'Defekt',copy_assignment:false,acknowledge_existing_assignment:true,
    });
    expect(withAck.status).toBe(201);
    expect(withAck.body.device.id).toBe(newDevice);
    expect(withAck.body.device.employee_id).toBe(employee);
    expect(withAck.body.device.control_point_id).toBeNull();
    expect(auditCall('nfc_device.replaced')?.[1]?.[5]).toEqual(expect.objectContaining({
      acknowledge_existing_assignment:true,copy_assignment:false,
    }));
  });

  it('clears the old assignment even when the user decides not to take it over',async()=>{
    queryMock.mockImplementation(async(sql:string,values?:unknown[])=>{
      if(sql.includes('FROM sessions'))return result([activeUser]);
      if(sql.includes('SELECT * FROM nfc_devices')&&sql.includes('FOR UPDATE'))return result([values?.[1]===device?deviceRow:{...deviceRow,id:newDevice,identifier:'TAG-002',status:'active',control_point_id:null,site_id:null,employee_id:null}]);
      if(sql.includes('SELECT id FROM nfc_device_replacements'))return result([]);
      if(sql.includes("status='replaced'"))return result([{...deviceRow,status:'replaced',control_point_id:null}]);
      if(sql.includes("SET status='active'"))return result([{...deviceRow,id:newDevice,identifier:'TAG-002',status:'active',control_point_id:null}]);
      if(sql.includes('INSERT INTO audit_events'))return result([{id:'audit-1'}]);
      return result([]);
    });
    const response=await request(app).post(`/api/v1/nfc-devices/${device}/replace`).set(csrf).send({
      new_device_id:newDevice,reason:'Defekt',copy_assignment:false,
    });
    expect(response.status).toBe(201);
    expect(response.body.device.control_point_id).toBeNull();
    const oldUpdate=calls("status='replaced'")[0];
    expect(String(oldUpdate?.[0])).toContain('control_point_id=NULL');
    const history=calls('INSERT INTO nfc_device_assignment_history')[0];
    expect(String(history?.[1]?.[3])).toBe(JSON.stringify({employee_id:null,site_id:null,control_point_id:null}));
    expect(calls('INSERT INTO nfc_device_assignment_history')).toHaveLength(1);
  });

  it('requires explicit clearance for a blocked replacement candidate',async()=>{
    const blocked={...deviceRow,id:newDevice,identifier:'TAG-002',status:'blocked',control_point_id:null,site_id:null,employee_id:null};
    queryMock.mockImplementation(async(sql:string,values?:unknown[])=>{
      if(sql.includes('FROM sessions'))return result([activeUser]);
      if(sql.includes('SELECT * FROM nfc_devices')&&sql.includes('FOR UPDATE')){
        return result([values?.[1]===device?deviceRow:blocked]);
      }
      if(sql.includes("SET status='replaced'"))return result([{...deviceRow,status:'replaced'}]);
      if(sql.includes("SET status='active'"))return result([{...blocked,status:'active'}]);
      if(sql.includes('INSERT INTO audit_events'))return result([{id:'audit-1'}]);
      return result([]);
    });
    const withoutClearance=await request(app).post(`/api/v1/nfc-devices/${device}/replace`).set(csrf).send({
      new_device_id:newDevice,reason:'Defekt',copy_assignment:false,
    });
    expect(withoutClearance.status).toBe(409);
    expect(withoutClearance.body.error).toContain('gesperrt oder verloren');
    const cleared=await request(app).post(`/api/v1/nfc-devices/${device}/replace`).set(csrf).send({
      new_device_id:newDevice,reason:'Defekt',copy_assignment:false,acknowledge_restricted:true,
    });
    expect(cleared.status).toBe(201);
    expect(cleared.body.device.status).toBe('active');
    expect(auditCall('nfc_device.replaced')?.[1]?.[5]).toEqual(expect.objectContaining({acknowledge_restricted:true}));
  });

  it('keeps the audit actor for lifecycle events in the device file',async()=>{
    activeUser={...baseUser,permissions:[...baseUser.permissions,'audit:read']};
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([activeUser]);
      if(sql.includes('SELECT n.*,e.name employee_name'))return result([deviceRow]);
      if(sql.includes("entity_type='nfc_device'"))return result([{
        id:'audit-1',event_type:'nfc_device.recovered',actor_user_id:activeUser.id,actor_email:activeUser.email,
        details:{previous_status:'lost'},created_at:'2026-11-27',
      }]);
      return result([]);
    });
    const response=await request(app).get(`/api/v1/nfc-devices/${device}/file`).set('Cookie',csrf.Cookie);
    expect(response.status).toBe(200);
    expect(response.body.history[0].actor_email).toBe('operator@example.invalid');
    expect(String(calls("entity_type='nfc_device'")[0]?.[0])).toContain('u.email actor_email');
  });
});
