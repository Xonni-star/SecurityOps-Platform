import request from 'supertest';
import type {QueryResult} from 'pg';
import {beforeEach,describe,expect,it,jest} from '@jest/globals';

const queryMock=jest.fn();
jest.unstable_mockModule('../src/db/pool.js',()=>({
  query:queryMock,
  withTransaction:async (work:(client:unknown)=>Promise<unknown>)=>work({query:queryMock}),
  withLoginContext:async (_value:string,work:()=>Promise<unknown>)=>work(),
  withSessionContext:async (_value:string,work:()=>Promise<unknown>)=>work(),
  withTenantContext:async (_value:string,work:()=>Promise<unknown>)=>work(),
}));

const {app}=await import('../src/app.js');
const tenant='00000000-0000-4000-8000-00000000000a';
const site='00000000-0000-4000-8000-0000000000aa';
const customer='00000000-0000-4000-8000-0000000000bb';
const sessionUser={id:'00000000-0000-4000-8000-000000000001',tenantId:tenant,email:'admin@example.invalid',role:'admin',permissions:['sites:read','sites:write','customers:read','customers:write','contracts:read'],permission_grants:[],site_ids:[site],is_system_admin:false,session_id:'00000000-0000-4000-8000-0000000000ac',csrf_token:'csrf-value',expires_at:'2099-01-01',device_id:'00000000-0000-4000-8000-0000000000ad'};
const result=(rows:unknown[],rowCount=rows.length)=>({rows,rowCount}) as unknown as QueryResult;

beforeEach(()=>{
  queryMock.mockReset();
  queryMock.mockImplementation(async(sql:string)=>{
    if(sql.includes('FROM sessions'))return result([sessionUser]);
    if(sql.includes('FROM sites s'))return result([{id:site,status:'planning'}]);
    if(sql.includes('FROM sites WHERE'))return result([{id:site}]);
    if(sql.includes('FROM customers WHERE'))return result([{id:customer}]);
    if(sql.includes('INSERT INTO customer_sites'))return result([{id:'00000000-0000-4000-8000-0000000000cc'}]);
    return result([]);
  });
});

describe('object management',()=>{
  it('creates a site with a placeholder for every value including the tenant',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([sessionUser]);
      if(sql.includes('INSERT INTO sites'))return result([{id:site,name:'Headquarters'}]);
      return result([]);
    });
    const response=await request(app).post('/api/v1/sites')
      .set('Cookie',['securityops_session=opaque','securityops_csrf=csrf-value'])
      .set('x-csrf-token','csrf-value')
      .send({name:'Headquarters',site_number:null,address:null,status:'planning'});
    expect(response.status).toBe(201);
    const insert=queryMock.mock.calls.find(([sql])=>String(sql).includes('INSERT INTO sites'));
    expect(insert?.[0]).toContain('VALUES ($1,$2,$3,$4,$5)');
    expect(insert?.[1]).toEqual([tenant,'Headquarters',null,null,'planning']);
  });

  it('keeps object context behind tenant and permission checks',async()=>{
    const response=await request(app).get(`/api/v1/sites/${site}/object-context`).set('Cookie','securityops_session=opaque');
    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({locations:[],hazards:[],instructions:[],journal:null,staffing:null,shifts:null,patrols:null,keys:null,keyBundles:null,documents:null,alarms:null,incidents:null,customerTasks:[],maintenance:null}));
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('FROM customer_sites'))).toBe(true);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('FROM contract_sites'))).toBe(true);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('FROM employee_object_assignments'))).toBe(false);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('FROM schedule_periods p'))).toBe(false);
  });

  it('returns site-scoped employee assignments and upcoming shifts only with their read scopes',async()=>{
    const scoped={
      ...sessionUser,
      permissions:['sites:read'],
      permission_grants:[
        {code:'sites:read',scope:'site'},
        {code:'customers:read',scope:'tenant'},
        {code:'contracts:read',scope:'tenant'},
        {code:'employees:read',scope:'site'},
        {code:'scheduling:read',scope:'site'},
      ],
    };
    const staffing=[{id:'assignment',employee_id:'employee',employee_name:'Guard',assignment_type:'operational'}];
    const shifts=[{id:'shift',period_id:'period',period_name:'November',role_code:'guard',assigned_count:1,assignments:[]}];
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([scoped]);
      if(sql.includes('FROM sites s'))return result([{id:site}]);
      if(sql.includes('FROM employee_object_assignments'))return result(staffing);
      if(sql.includes('FROM schedule_periods p'))return result(shifts);
      return result([]);
    });

    const response=await request(app).get(`/api/v1/sites/${site}/object-context`).set('Cookie','securityops_session=opaque');
    expect(response.status).toBe(200);
    expect(response.body.staffing).toEqual(staffing);
    expect(response.body.shifts).toEqual(shifts);
    expect(queryMock.mock.calls.find(([sql])=>String(sql).includes('FROM employee_object_assignments'))?.[1]).toEqual([tenant,site]);
    expect(queryMock.mock.calls.find(([sql])=>String(sql).includes('FROM schedule_periods p'))?.[1]).toEqual([tenant,site,true]);
  });

  it('returns site-linked patrol plans and recent scans only within patrol scope',async()=>{
    const scoped={
      ...sessionUser,
      permissions:['sites:read'],
      permission_grants:[{code:'patrols:read',scope:'site'}],
    };
    const patrolRoute={id:'route-1',name:'Night perimeter',expected_start:'22:00:00',expected_end:'23:00:00',points:[{control_point_id:'point-1',name:'North gate',sequence:1,expected_offset_seconds:0}],assignments:[{id:'assignment-1',starts_at:'2026-11-25T22:00:00Z',ends_at:null,employee_name:null}]};
    const scan={id:'scan-1',route_id:'route-1',route_name:'Night perimeter',control_point_id:'point-1',control_point_name:'North gate',scanned_at:'2026-11-24T22:15:00Z',deviation:'none',employee_name:null};
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([scoped]);
      if(sql.includes('FROM sites s'))return result([{id:site}]);
      if(sql.includes('FROM patrol_routes r'))return result([patrolRoute]);
      if(sql.includes('FROM patrol_scans ps'))return result([scan]);
      return result([]);
    });
    const response=await request(app).get(`/api/v1/sites/${site}/object-context`).set('Cookie','securityops_session=opaque');
    expect(response.status).toBe(200);
    expect(response.body.patrols).toEqual({routes:[patrolRoute],recentScans:[scan]});
    expect(queryMock.mock.calls.find(([sql])=>String(sql).includes('FROM patrol_routes r'))?.[1]).toEqual([tenant,site,false]);
    expect(queryMock.mock.calls.find(([sql])=>String(sql).includes('FROM patrol_scans ps'))?.[1]).toEqual([tenant,site,false]);
  });

  it('distinguishes an authorized empty patrol record set from inaccessible patrol data',async()=>{
    const scoped={...sessionUser,permissions:['sites:read'],permission_grants:[{code:'patrols:read',scope:'site'}],site_ids:[site]};
    queryMock.mockImplementation(async(sql:string)=>sql.includes('FROM sessions')?result([scoped]):sql.includes('FROM sites s')?result([{id:site}]):result([]));
    const allowed=await request(app).get(`/api/v1/sites/${site}/object-context`).set('Cookie','securityops_session=opaque');
    expect(allowed.status).toBe(200);
    expect(allowed.body.patrols).toEqual({routes:[],recentScans:[]});

    queryMock.mockReset();
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([{...scoped,site_ids:[]}]);
      if(sql.includes('FROM sites s'))return result([{id:site}]);
      return result([]);
    });
    const denied=await request(app).get(`/api/v1/sites/${site}/object-context`).set('Cookie','securityops_session=opaque');
    expect(denied.status).toBe(200);
    expect(denied.body.patrols).toBeNull();
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('FROM patrol_routes r'))).toBe(false);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('FROM patrol_scans ps'))).toBe(false);
  });

  it('returns site-scoped keys, bundles and DMS metadata with independent permissions',async()=>{
    const scoped={
      ...sessionUser,
      permissions:['sites:read'],
      permission_grants:[
        {code:'keys:read',scope:'site'},
        {code:'keys:bundle_read',scope:'site'},
        {code:'dms:read',scope:'site'},
      ],
    };
    const key={id:'key-1',key_code:'K-01',label:'Main entrance',key_type:'physical',status:'available'};
    const movement={id:'movement-1',key_id:'key-1',key_label:'Main entrance',movement_type:'returned',to_status:'available'};
    const bundle={id:'bundle-1',name:'Night shift',status:'available',item_count:2,issued_count:0};
    const document={id:'document-1',title:'Site instructions',document_status:'active',versions:[{id:'version-1',version_no:1,lifecycle_state:'available'}]};
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([scoped]);
      if(sql.includes('FROM sites s'))return result([{id:site}]);
      if(sql.includes('FROM keys WHERE'))return result([key]);
      if(sql.includes('FROM key_movements m'))return result([movement]);
      if(sql.includes('FROM key_bundles b'))return result([bundle]);
      if(sql.includes('FROM dms_documents d'))return result([document]);
      return result([]);
    });

    const response=await request(app).get(`/api/v1/sites/${site}/object-context`).set('Cookie','securityops_session=opaque');
    expect(response.status).toBe(200);
    expect(response.body.keys).toEqual({items:[key],recentMovements:[movement]});
    expect(response.body.keyBundles).toEqual([bundle]);
    expect(response.body.documents).toEqual([document]);
    expect(queryMock.mock.calls.find(([sql])=>String(sql).includes('FROM keys WHERE'))?.[1]).toEqual([tenant,site]);
    expect(queryMock.mock.calls.find(([sql])=>String(sql).includes('FROM key_bundles b'))?.[1]).toEqual([tenant,site]);
    expect(queryMock.mock.calls.find(([sql])=>String(sql).includes('FROM dms_documents d'))?.[1]).toEqual([tenant,site,false]);
    expect(String(queryMock.mock.calls.find(([sql])=>String(sql).includes('FROM dms_documents d'))?.[0])).toContain('d.customer_id IS NULL');
  });

  it('does not query keys or documents when their site permissions are missing',async()=>{
    const scoped={...sessionUser,permissions:['sites:read'],permission_grants:[]};
    queryMock.mockImplementation(async(sql:string)=>sql.includes('FROM sessions')?result([scoped]):sql.includes('FROM sites s')?result([{id:site}]):result([]));
    const response=await request(app).get(`/api/v1/sites/${site}/object-context`).set('Cookie','securityops_session=opaque');
    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({keys:null,keyBundles:null,documents:null}));
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('FROM keys WHERE'))).toBe(false);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('FROM key_movements m'))).toBe(false);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('FROM key_bundles b'))).toBe(false);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('FROM dms_documents d'))).toBe(false);
  });

  it('returns site-linked alarms, incidents, active-customer tasks and maintenance entries',async()=>{
    const scoped={
      ...sessionUser,
      permissions:['sites:read'],
      permission_grants:[
        {code:'alarms:read',scope:'site'},
        {code:'incidents:read',scope:'site'},
        {code:'watchbook:read',scope:'site'},
        {code:'customers:read',scope:'tenant'},
        {code:'employees:read',scope:'site'},
      ],
    };
    const alarm={id:'alarm-1',type:'panic',description:'Assistance requested',severity:'critical',status:'open'};
    const incident={id:'incident-1',description:'Respond to alarm',status:'on_site',assignees:[{id:'employee-1',name:'Mia Guard'}]};
    const task={id:'task-1',customer_id:customer,customer_name:'Northwind',title:'Review site access',status:'open'};
    const journalEntry={id:'entry-1',category_name:'Vorkommnis',content:'Entry',status:'open'};
    const maintenanceEntry={id:'entry-2',content:'Inspect gate',priority_name:'Hoch',status:'open'};
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([scoped]);
      if(sql.includes('FROM sites s'))return result([{id:site}]);
      if(sql.includes('FROM alarms a'))return result([alarm]);
      if(sql.includes('FROM incidents i'))return result([incident]);
      if(sql.includes('FROM customer_tasks t'))return result([task]);
      if(sql.includes('FROM watchbook_entries e')&&sql.includes("c.code='maintenance'"))return result([maintenanceEntry]);
      if(sql.includes('FROM watchbook_entries e'))return result([journalEntry]);
      return result([]);
    });

    const response=await request(app).get(`/api/v1/sites/${site}/object-context`).set('Cookie','securityops_session=opaque');
    expect(response.status).toBe(200);
    expect(response.body.alarms).toEqual([alarm]);
    expect(response.body.incidents).toEqual([incident]);
    expect(response.body.customerTasks).toEqual([task]);
    expect(response.body.journal).toEqual([journalEntry]);
    expect(response.body.maintenance).toEqual([maintenanceEntry]);
    expect(queryMock.mock.calls.find(([sql])=>String(sql).includes('FROM incidents i'))?.[1]).toEqual([tenant,site,true]);
    expect(queryMock.mock.calls.find(([sql])=>String(sql).includes('FROM customer_tasks t'))?.[1]).toEqual([tenant,site,true]);
  });

  it('does not query operational records without their independent permissions',async()=>{
    const scoped={...sessionUser,permissions:['sites:read'],permission_grants:[]};
    queryMock.mockImplementation(async(sql:string)=>sql.includes('FROM sessions')?result([scoped]):sql.includes('FROM sites s')?result([{id:site}]):result([]));
    const response=await request(app).get(`/api/v1/sites/${site}/object-context`).set('Cookie','securityops_session=opaque');
    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({alarms:null,incidents:null,customerTasks:null,maintenance:null,journal:null}));
    for(const table of ['FROM alarms a','FROM incidents i','FROM customer_tasks t','FROM watchbook_entries e']){
      expect(queryMock.mock.calls.some(([sql])=>String(sql).includes(table))).toBe(false);
    }
  });

  it('rejects a site-scoped user outside their assigned sites before reading or writing',async()=>{
    const scoped={...sessionUser,permission_grants:[{code:'sites:read',scope:'site'},{code:'sites:write',scope:'site'}],site_ids:[]};
    queryMock.mockImplementation(async(sql:string)=>sql.includes('FROM sessions')?result([scoped]):result([]));
    const read=await request(app).get(`/api/v1/sites/${site}/object-context`).set('Cookie','securityops_session=opaque');
    const write=await request(app).post(`/api/v1/sites/${site}/hazards`)
      .set('Cookie',['securityops_session=opaque','securityops_csrf=csrf-value'])
      .set('x-csrf-token','csrf-value')
      .send({title:'Fire',category:'fire',description:'Risk',likelihood:1,impact:1});
    expect(read.status).toBe(403);
    expect(write.status).toBe(403);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('FROM sites'))).toBe(false);
  });

  it('requires ownership for own-scoped object context',async()=>{
    const scoped={...sessionUser,permission_grants:[{code:'sites:read',scope:'own'}]};
    queryMock.mockImplementation(async(sql:string)=>sql.includes('FROM sessions')?result([scoped]):result([]));
    const response=await request(app).get(`/api/v1/sites/${site}/object-context`).set('Cookie','securityops_session=opaque');
    expect(response.status).toBe(403);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('FROM resource_owners'))).toBe(true);
  });

  it('withholds CRM data through a narrower customer permission without blocking the object file',async()=>{
    const scoped={...sessionUser,permission_grants:[{code:'customers:read',scope:'site'}]};
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([scoped]);
      if(sql.includes('FROM sites s'))return result([{id:site}]);
      return result([]);
    });
    const response=await request(app).get(`/api/v1/sites/${site}/object-context`).set('Cookie','securityops_session=opaque');
    expect(response.status).toBe(200);
    expect(response.body.customers).toBeNull();
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('FROM customer_sites'))).toBe(false);
  });

  it('lets site-scoped personnel read the object file without CRM permissions',async()=>{
    const scoped={
      ...sessionUser,
      permissions:['sites:read'],
      permission_grants:[
        {code:'sites:read',scope:'site'},
        {code:'employees:read',scope:'site'},
        {code:'scheduling:read',scope:'site'},
      ],
    };
    const staffing=[{id:'assignment',employee_name:'Guard'}];
    const shifts=[{id:'shift',period_name:'November'}];
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([scoped]);
      if(sql.includes('FROM sites s'))return result([{id:site}]);
      if(sql.includes('FROM employee_object_assignments'))return result(staffing);
      if(sql.includes('FROM schedule_periods p'))return result(shifts);
      return result([]);
    });
    const response=await request(app).get(`/api/v1/sites/${site}/object-context`).set('Cookie','securityops_session=opaque');
    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({customers:null,contracts:null,staffing,shifts}));
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('FROM customer_sites'))).toBe(false);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('FROM contract_sites'))).toBe(false);
  });

  it('returns journal entries only with watchbook permission for the site',async()=>{
    const scoped={...sessionUser,permission_grants:[{code:'watchbook:read',scope:'site'}],site_ids:[site]};
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([scoped]);
      if(sql.includes('FROM sites s'))return result([{id:site}]);
      if(sql.includes('FROM watchbook_entries'))return result([{id:'entry'}]);
      return result([]);
    });
    const response=await request(app).get(`/api/v1/sites/${site}/object-context`).set('Cookie','securityops_session=opaque');
    expect(response.status).toBe(200);
    expect(response.body.journal).toEqual([{id:'entry'}]);
  });

  it('does not create a CRM link for a customer outside the tenant',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([sessionUser]);
      if(sql.includes('FROM sites WHERE'))return result([{id:site}]);
      if(sql.includes('FROM customers WHERE'))return result([]);
      return result([]);
    });
    const response=await request(app).post(`/api/v1/sites/${site}/customer-links`)
      .set('Cookie',['securityops_session=opaque','securityops_csrf=csrf-value'])
      .set('x-csrf-token','csrf-value')
      .send({customer_id:customer});
    expect(response.status).toBe(404);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('INSERT INTO customer_sites'))).toBe(false);
  });

  it('rejects a hierarchy parent that is not part of the same site',async()=>{
    const response=await request(app).post(`/api/v1/sites/${site}/locations`)
      .set('Cookie',['securityops_session=opaque','securityops_csrf=csrf-value'])
      .set('x-csrf-token','csrf-value')
      .send({name:'North building',location_type:'building',parent_id:customer});
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('Parent location');
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('INSERT INTO object_locations'))).toBe(false);
  });

  it('creates a location with a tenant-validated responsible employee and audit event',async()=>{
    const employee='00000000-0000-4000-8000-0000000000dd';
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([sessionUser]);
      if(sql.includes('FROM sites WHERE'))return result([{id:site}]);
      if(sql.includes('FROM employees WHERE'))return result([{id:employee}]);
      if(sql.includes('INSERT INTO object_locations'))return result([{id:'00000000-0000-4000-8000-0000000000de',responsible_employee_id:employee}]);
      return result([]);
    });
    const response=await request(app).post(`/api/v1/sites/${site}/locations`)
      .set('Cookie',['securityops_session=opaque','securityops_csrf=csrf-value'])
      .set('x-csrf-token','csrf-value')
      .send({name:'North building',location_type:'building',responsible_employee_id:employee});
    expect(response.status).toBe(201);
    expect(response.body.responsible_employee_id).toBe(employee);
    expect(queryMock.mock.calls.find(([sql])=>String(sql).includes('FROM employees WHERE'))?.[1]).toEqual([tenant,employee]);
    expect(queryMock.mock.calls.some(([sql,values])=>String(sql).includes('INSERT INTO audit_events')&&values?.[2]==='site.location.created')).toBe(true);
  });

  it('creates an approved instruction and records employee acknowledgement by version',async()=>{
    const instruction='00000000-0000-4000-8000-0000000000df';
    const employee='00000000-0000-4000-8000-0000000000dd';
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([sessionUser]);
      if(sql.includes('FROM sites WHERE'))return result([{id:site}]);
      if(sql.includes('SELECT id,version,status FROM site_instructions'))return result([{id:instruction,version:2,status:'approved'}]);
      if(sql.includes('SELECT id FROM employees WHERE'))return result([{id:employee}]);
      if(sql.includes('INSERT INTO instruction_acknowledgements'))return result([{instruction_id:instruction,employee_id:employee,acknowledged_version:2}]);
      if(sql.includes('INSERT INTO site_instructions'))return result([{id:instruction,version:2,status:'approved'}]);
      return result([]);
    });
    const cookie=['securityops_session=opaque','securityops_csrf=csrf-value'];
    const create=await request(app).post(`/api/v1/sites/${site}/instructions`).set('Cookie',cookie).set('x-csrf-token','csrf-value')
      .send({title:'Evacuation',content:'Use the marked exit.',version:2,status:'approved',requires_acknowledgement:true});
    expect(create.status).toBe(201);
    const acknowledged=await request(app).post(`/api/v1/sites/${site}/instructions/${instruction}/acknowledgements`).set('Cookie',cookie).set('x-csrf-token','csrf-value')
      .send({employee_id:employee});
    expect(acknowledged.status).toBe(201);
    expect(acknowledged.body.acknowledged_version).toBe(2);
    expect(queryMock.mock.calls.some(([sql,values])=>String(sql).includes('INSERT INTO instruction_acknowledgements')&&values?.[0]===tenant&&values?.[3]===2)).toBe(true);
  });

  it('validates hazard scoring inputs server-side',async()=>{
    const response=await request(app).post(`/api/v1/sites/${site}/hazards`)
      .set('Cookie',['securityops_session=opaque','securityops_csrf=csrf-value'])
      .set('x-csrf-token','csrf-value')
      .send({title:'Fire loading bay',category:'fire',description:'Combustible storage',likelihood:6,impact:3});
    expect(response.status).toBe(400);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('INSERT INTO object_hazards'))).toBe(false);
  });
});
