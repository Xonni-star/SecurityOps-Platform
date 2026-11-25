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
let activeUser=sessionUser;
const result=(rows:unknown[],rowCount=rows.length)=>({rows,rowCount}) as unknown as QueryResult;

beforeEach(()=>{
  queryMock.mockReset();
  activeUser=sessionUser;
  queryMock.mockImplementation(async(sql:string)=>{
    if(sql.includes('FROM sessions'))return result([activeUser]);
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
    expect(response.body).toEqual(expect.objectContaining({locations:[],hazards:[],instructions:[],journal:null,staffing:null,shifts:null,patrols:null,keys:null,keyBundles:null,documents:null,alarms:null,incidents:null,customerTasks:[],maintenance:null,qualifications:null,handovers:null}));
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('FROM customer_sites'))).toBe(true);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('FROM contract_sites'))).toBe(true);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('FROM employee_object_assignments'))).toBe(false);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('FROM schedule_periods p'))).toBe(false);
  });

  it('returns site-scoped dashboard data and real object-management metrics',async()=>{
    const scoped={
      ...sessionUser,
      permissions:['sites:read'],
      permission_grants:[
        {code:'sites:read',scope:'site'},
        {code:'employees:read',scope:'site'},
        {code:'customers:read',scope:'tenant'},
        {code:'contracts:read',scope:'tenant'},
        {code:'dms:read',scope:'site'},
        {code:'watchbook:read',scope:'site'},
        {code:'scheduling:read',scope:'site'},
        {code:'devices:read',scope:'site'},
      ],
    };
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([scoped]);
      if(sql.includes('SELECT s.id FROM sites s'))return result([{id:site}]);
      if(sql.includes('WITH customer_summary AS'))return result([{
        id:site,name:'Headquarters',site_number:'S-1',address:'Berlin',alias:null,site_type:'Leitstelle',
        status:'active',security_classification:'critical',object_manager_employee_id:'employee-1',object_manager_name:'Mia Guard',
        operations_manager_employee_id:null,operations_manager_name:null,customer_names:['North Client'],
        assigned_employee_count:2,active_contract_count:1,expiring_contract_count:1,open_hazard_count:2,
        contract_statuses:['active'],open_task_count:0,overdue_task_count:0,open_shift_count:0,undercovered_shift_count:0,
        critical_hazard_count:0,required_staff_count:0,understaffed:false,
        overdue_measure_count:3,available_document_count:0,last_activity:'2026-11-25T10:00:00Z',
      }]);
      return result([]);
    });

    const response=await request(app).get('/api/v1/sites/overview-dashboard').set('Cookie','securityops_session=opaque');

    expect(response.status).toBe(200);
    expect(response.body.sites).toEqual([expect.objectContaining({
      id:site,customer_names:['North Client'],object_manager_name:'Mia Guard',assigned_employee_count:2,
      active_contract_count:1,open_hazard_count:2,overdue_measure_count:3,
    })]);
    expect(response.body.metrics).toEqual({
      total_sites:1,active_sites:1,preparation_sites:0,restricted_sites:0,critical_sites:1,
      sites_with_critical_hazards:0,sites_with_open_tasks:0,sites_with_understaffing:0,
      open_hazards:2,overdue_measures:3,open_tasks:0,overdue_tasks:0,open_shifts:0,undercovered_shifts:0,
      expiring_contracts:1,sites_without_available_documents:1,
      valid_documents:0,expired_documents:0,documents_expiring_7d:0,documents_expiring_30d:0,
      documents_review_due:0,unapproved_documents:0,missing_required_documents:0,
      open_maintenance:0,overdue_maintenance:0,
    });
    expect(queryMock.mock.calls.find(([sql])=>String(sql).includes('SELECT s.id FROM sites s'))?.[1]).toEqual([tenant, [site]]);
  });

  it('returns concrete, sorted priority actions from real dashboard records',async()=>{
    const scoped={
      ...sessionUser,
      permissions:['sites:read'],
      permission_grants:[
        {code:'sites:read',scope:'site'},
        {code:'employees:read',scope:'site'},
        {code:'qualifications:read',scope:'site'},
        {code:'customers:read',scope:'tenant'},
        {code:'contracts:read',scope:'tenant'},
        {code:'dms:read',scope:'site'},
        {code:'watchbook:read',scope:'site'},
        {code:'scheduling:read',scope:'site'},
        {code:'devices:read',scope:'site'},
      ],
    };
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([scoped]);
      if(sql.includes('SELECT s.id FROM sites s'))return result([{id:site}]);
      if(sql.includes('WITH customer_summary AS'))return result([{
        id:site,name:'Headquarters',site_number:'S-1',address:'Berlin',alias:null,site_type:'Leitstelle',
        status:'active',security_classification:'critical',object_manager_employee_id:null,object_manager_name:null,
        operations_manager_employee_id:null,operations_manager_name:null,customer_names:['North Client'],
        assigned_employee_count:2,active_contract_count:1,expiring_contract_count:1,open_hazard_count:2,
        contract_statuses:['active'],open_task_count:0,overdue_task_count:0,open_shift_count:0,undercovered_shift_count:0,
        critical_hazard_count:0,required_staff_count:0,understaffed:false,
        overdue_measure_count:3,available_document_count:0,last_activity:'2026-11-25T10:00:00Z',
      }]);
      if(sql.includes('WITH action_source AS'))return result([
        {id:'task-1',site_id:site,site_name:'Headquarters',entity_id:'task-1',employee_id:null,severity:'high',category:'Aufgaben',title:'Überfällige Aufgabe: Report',detail:'Kunde: North Client',due_on:'2026-11-20',tab:'aufgaben',permission:'customers:read',target:`/sites/${site}/aufgaben`},
        {id:'hazard-1',site_id:site,site_name:'Headquarters',entity_id:'hazard-1',employee_id:null,severity:'critical',category:'Gefährdungen',title:'Kritische Gefährdung: Fire',detail:'Risikoscore 22',due_on:'2026-11-24',tab:'gefaehrdungen',permission:'sites:read',target:`/sites/${site}/gefaehrdungen`},
        {id:'qualification-1',site_id:site,site_name:'Headquarters',entity_id:'q-1',employee_id:'employee-1',severity:'medium',category:'Personal',title:'Qualifikation prüfen: Mia Guard',detail:'Nachweis fehlt',due_on:'2026-12-20',tab:'personal',permission:'qualifications:read',target:'/employees/employee-1/qualifikationen'},
      ]);
      return result([]);
    });

    const response=await request(app).get('/api/v1/sites/overview-dashboard').set('Cookie','securityops_session=opaque');
    expect(response.status).toBe(200);
    expect((response.body.priorityActions as Array<{id:string;severity:string}>).map(action=>[action.id,action.severity])).toEqual([
      ['hazard-1','critical'],['task-1','high'],['qualification-1','medium'],
    ]);
    expect(response.body.priorityActions[2].target).toBe('/employees/employee-1/qualifikationen');
    const priorityCall=queryMock.mock.calls.find(([sql])=>String(sql).includes('WITH action_source AS'));
    expect(priorityCall?.[1]).toEqual([tenant,[site],[site],[site],[site],[site],[site],[site],[site]]);
  });

  it('does not request customer, contract, employee or DMS aggregates without their read scopes',async()=>{
    const sitesOnly={...sessionUser,permissions:['sites:read'],permission_grants:[{code:'sites:read',scope:'tenant'}]};
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([sitesOnly]);
      if(sql.includes('SELECT s.id FROM sites s'))return result([{id:site}]);
      if(sql.includes('WITH customer_summary AS'))return result([{
        id:site,name:'Headquarters',site_number:null,address:null,alias:null,site_type:null,status:'active',security_classification:'unknown',
        object_manager_employee_id:null,object_manager_name:null,operations_manager_employee_id:null,operations_manager_name:null,
        customer_names:null,assigned_employee_count:null,active_contract_count:null,expiring_contract_count:null,
        open_hazard_count:0,overdue_measure_count:0,available_document_count:null,last_activity:null,
      }]);
      return result([]);
    });

    const response=await request(app).get('/api/v1/sites/overview-dashboard').set('Cookie','securityops_session=opaque');

    expect(response.status).toBe(200);
    expect(response.body.metrics).toEqual(expect.objectContaining({expiring_contracts:null,sites_without_available_documents:null}));
    const aggregate=queryMock.mock.calls.find(([sql])=>String(sql).includes('WITH customer_summary AS'));
    expect(aggregate?.[1]).toEqual([tenant,[site],[],[],[],[site],[],[],[],[],[]]);
    expect(response.body.sites[0]).toEqual(expect.objectContaining({
      customer_names:null,assigned_employee_count:null,active_contract_count:null,available_document_count:null,
    }));
  });

  it('returns instruction acknowledgement identities only with site-scoped employee read access',async()=>{
    const acknowledgement={employee_id:'employee-1',employee_name:'Mia Guard',acknowledged_at:'2026-11-25T10:00:00Z'};
    const instruction={id:'instruction-1',title:'Evacuation',version:2,status:'approved',requires_acknowledgement:true,acknowledgement_count:1};
    const withEmployeeRead={...sessionUser,permissions:['sites:read'],permission_grants:[{code:'sites:read',scope:'site'},{code:'employees:read',scope:'site'}]};
    const withoutEmployeeRead={...sessionUser,permissions:['sites:read'],permission_grants:[{code:'sites:read',scope:'site'}]};
    queryMock.mockImplementation(async(sql:string,values?:unknown[])=>{
      if(sql.includes('FROM sessions'))return result([withEmployeeRead]);
      if(sql.includes('FROM sites s'))return result([{id:site,object_manager_employee_id:values?.[2]?'employee-1':null,operations_manager_employee_id:values?.[2]?'employee-1':null,object_manager_name:values?.[2]?'Mia Guard':null,operations_manager_name:values?.[2]?'Mia Guard':null}]);
      if(sql.includes('FROM object_locations l'))return result([{id:'location-1',responsible_employee_id:values?.[2]? 'employee-1':null,responsible_employee_name:values?.[2]?'Mia Guard':null}]);
      if(sql.includes('FROM object_hazards h'))return result([{id:'hazard-1',responsible_employee_id:values?.[2]?'employee-1':null,responsible_employee_name:values?.[2]?'Mia Guard':null}]);
      if(sql.includes('FROM site_instructions i'))return result([{...instruction,acknowledgements:values?.[2]?[acknowledgement]:[]}]);
      return result([]);
    });
    const visible=await request(app).get(`/api/v1/sites/${site}/object-context`).set('Cookie','securityops_session=opaque');
    expect(visible.status).toBe(200);
    expect(visible.body.instructions[0].acknowledgements).toEqual([acknowledgement]);
    expect(visible.body.site).toEqual(expect.objectContaining({object_manager_employee_id:'employee-1',object_manager_name:'Mia Guard'}));
    expect(visible.body.locations[0]).toEqual(expect.objectContaining({responsible_employee_id:'employee-1',responsible_employee_name:'Mia Guard'}));
    expect(visible.body.hazards[0]).toEqual(expect.objectContaining({responsible_employee_id:'employee-1',responsible_employee_name:'Mia Guard'}));
    expect(queryMock.mock.calls.find(([sql])=>String(sql).includes('FROM site_instructions i'))?.[1]).toEqual([tenant,site,true,false,sessionUser.id]);

    queryMock.mockImplementation(async(sql:string,values?:unknown[])=>{
      if(sql.includes('FROM sessions'))return result([withoutEmployeeRead]);
      if(sql.includes('FROM sites s'))return result([{id:site,object_manager_employee_id:values?.[2]?'employee-1':null,operations_manager_employee_id:values?.[2]?'employee-1':null,object_manager_name:values?.[2]?'Mia Guard':null,operations_manager_name:values?.[2]?'Mia Guard':null}]);
      if(sql.includes('FROM object_locations l'))return result([{id:'location-1',responsible_employee_id:values?.[2]?'employee-1':null,responsible_employee_name:values?.[2]?'Mia Guard':null}]);
      if(sql.includes('FROM object_hazards h'))return result([{id:'hazard-1',responsible_employee_id:values?.[2]?'employee-1':null,responsible_employee_name:values?.[2]?'Mia Guard':null}]);
      if(sql.includes('FROM site_instructions i'))return result([{...instruction,acknowledgements:values?.[2]?[acknowledgement]:[]}]);
      return result([]);
    });
    const hidden=await request(app).get(`/api/v1/sites/${site}/object-context`).set('Cookie','securityops_session=opaque');
    expect(hidden.status).toBe(200);
    expect(hidden.body.site).toEqual(expect.objectContaining({object_manager_employee_id:null,operations_manager_employee_id:null,object_manager_name:null,operations_manager_name:null}));
    expect(hidden.body.instructions[0]).toEqual(expect.objectContaining({acknowledgement_count:1,acknowledgements:[]}));
    expect(hidden.body.locations[0]).toEqual(expect.objectContaining({responsible_employee_id:null,responsible_employee_name:null}));
    expect(hidden.body.hazards[0]).toEqual(expect.objectContaining({responsible_employee_id:null,responsible_employee_name:null}));
    expect(queryMock.mock.calls.filter(([sql])=>String(sql).includes('FROM site_instructions i')).at(-1)?.[1]).toEqual([tenant,site,false,false,sessionUser.id]);
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
    expect(queryMock.mock.calls.find(([sql])=>String(sql).includes('FROM schedule_periods p'))?.[0]).toContain("'employee_id',a.employee_id");
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
    const document={id:'document-1',title:'Site instructions',document_status:'active',approval_status:'approved',valid_until:null,versions:[{id:'version-1',version_no:1,lifecycle_state:'available'}]};
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
    expect(response.body.documents).toEqual([expect.objectContaining({
      ...document,computed_status:'gueltig',status_label:'Gültig',expiry_bucket:'no_expiry',is_currently_valid:true,
    })]);
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

  it('returns qualifications only for current site staff and site-scoped handovers',async()=>{
    const scoped={
      ...sessionUser,
      permissions:['sites:read'],
      permission_grants:[
        {code:'employees:read',scope:'site'},
        {code:'qualifications:read',scope:'site'},
        {code:'handover:read',scope:'site'},
      ],
    };
    const qualification={id:'qualification-1',employee_id:'employee-1',employee_name:'Mia Guard',code:'first_aid',computed_status:'expiring'};
    const handover={id:'handover-1',title:'Night shift transfer',status:'open',participant_count:2,confirmation_count:1};
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([scoped]);
      if(sql.includes('FROM sites s'))return result([{id:site}]);
      if(sql.includes('FROM employee_qualifications q'))return result([qualification]);
      if(sql.includes('FROM handover_records h'))return result([handover]);
      return result([]);
    });

    const response=await request(app).get(`/api/v1/sites/${site}/object-context`).set('Cookie','securityops_session=opaque');
    expect(response.status).toBe(200);
    expect(response.body.qualifications).toEqual([expect.objectContaining({
      ...qualification,
      days_until_expiry:null,
      issue:expect.objectContaining({code:'expiring',severity:'medium'}),
      evidence_status:'missing',
      evidence_label:'Kein Nachweis verknüpft',
      evidence_document_id:null,
      evidence_document_title:null,
      last_checked_at:null,
      employee_url:'/employees/employee-1/qualifikationen',
    })]);
    expect(response.body.handovers).toEqual([handover]);
    expect(queryMock.mock.calls.find(([sql])=>String(sql).includes('FROM employee_qualifications q'))?.[1]).toEqual([tenant,site]);
    expect(queryMock.mock.calls.find(([sql])=>String(sql).includes('FROM handover_records h'))?.[1]).toEqual([tenant,site]);
  });

  it('returns concrete qualification issues, last checks and missing acknowledgement links',async()=>{
    const scoped={
      ...sessionUser,
      permissions:['sites:read'],
      permission_grants:[
        {code:'sites:read',scope:'site'},
        {code:'employees:read',scope:'site'},
        {code:'qualifications:read',scope:'site'},
        {code:'watchbook:read',scope:'site'},
      ],
    };
    const qualifications=[
      {id:'q-revoked',employee_id:'employee-1',employee_name:'Mia Guard',code:'first_aid',qualification_name:'Erste Hilfe',status:'revoked',computed_status:'revoked',valid_until:'2030-01-01',days_until_expiry:1200,document_id:'document-1',revoked_at:'2026-11-01T10:00:00Z',updated_at:'2026-11-20T09:00:00Z'},
      {id:'q-missing',employee_id:'employee-2',employee_name:'Leo Guard',code:'security',qualification_name:'Sicherheitsdienst',status:'valid',computed_status:'valid',valid_until:'2030-01-01',days_until_expiry:1200,updated_at:'2026-11-21T09:00:00Z'},
      {id:'q-expiring',employee_id:'employee-3',employee_name:'Nora Guard',code:'first_aid',qualification_name:'Erste Hilfe',status:'valid',computed_status:'expiring',valid_until:'2026-12-20',days_until_expiry:25,updated_at:'2026-11-22T09:00:00Z'},
    ];
    const staffing=[
      {id:'assignment-1',employee_id:'employee-1',employee_name:'Mia Guard'},
      {id:'assignment-2',employee_id:'employee-2',employee_name:'Leo Guard'},
      {id:'assignment-3',employee_id:'employee-3',employee_name:'Nora Guard'},
      {id:'assignment-4',employee_id:'employee-3',employee_name:'Nora Guard'},
    ];
    const instruction={id:'instruction-1',title:'Evacuation',version:2,status:'approved',requires_acknowledgement:true,
      acknowledgements:[{employee_id:'employee-1',employee_name:'Mia Guard',acknowledged_at:'2026-11-25T10:00:00Z'}]};
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([scoped]);
      if(sql.includes('FROM sites s'))return result([{id:site}]);
      if(sql.includes('FROM employee_qualifications q'))return result(qualifications);
      if(sql.includes('FROM employee_object_assignments oa'))return result(staffing);
      if(sql.includes('FROM site_instructions i'))return result([instruction]);
      return result([]);
    });

    const response=await request(app).get(`/api/v1/sites/${site}/object-context`).set('Cookie','securityops_session=opaque');
    expect(response.status).toBe(200);
    expect(response.body.qualifications[0]).toEqual(expect.objectContaining({
      issue:expect.objectContaining({code:'revoked',label:'Widerrufen',severity:'critical'}),
      evidence_status:'not_found',
      evidence_label:'Verknüpfter Nachweis nicht gefunden',
      evidence_document_id:'document-1',
      last_checked_at:'2026-11-20T09:00:00.000Z',
      employee_url:'/employees/employee-1/qualifikationen',
    }));
    expect(response.body.qualifications[1].issue).toEqual(expect.objectContaining({code:'missing_evidence',label:'Nachweis fehlt',severity:'high'}));
    expect(response.body.personnelSummary).toEqual(expect.objectContaining({
      assigned_employee_count:3,
      expiring_qualification_count:1,
      invalid_qualification_count:1,
      qualification_issue_count:3,
      blocking_qualification_issue_count:2,
      missing_acknowledgements:[expect.objectContaining({
        instruction_id:'instruction-1',
        target:`/sites/${site}/anweisungen`,
        missing_employee_ids:['employee-2','employee-3'],
      })],
    }));
    const actions=response.body.priorityActions as Array<{id:string;severity:string;target:string}>;
    expect(actions.map(action=>action.id)).toEqual(expect.arrayContaining([
      'qualification-q-revoked','qualification-q-missing','qualification-q-expiring','acknowledgement-instruction-1',
    ]));
    expect(actions.find(action=>action.id==='qualification-q-revoked')).toEqual(expect.objectContaining({
      severity:'critical',target:'/employees/employee-1/qualifikationen',
    }));
    expect(actions.find(action=>action.id==='acknowledgement-instruction-1')).toEqual(expect.objectContaining({
      severity:'medium',target:`/sites/${site}/anweisungen`,
    }));
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

  it('creates employee-to-site assignments for an authorized site-scoped employee manager',async()=>{
    const employee='00000000-0000-4000-8000-0000000000dd';
    const scoped={...sessionUser,permissions:[],permission_grants:[{code:'employees:write',scope:'site'}]};
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([scoped]);
      if(sql.includes('FROM employees WHERE tenant_id=$1 AND id=$2'))return result([{id:employee}]);
      if(sql.includes('FROM sites WHERE tenant_id=$1 AND id=$2'))return result([{id:site}]);
      if(sql.includes('INSERT INTO employee_object_assignments'))return result([{id:'assignment-1',employee_id:employee,site_id:site}]);
      return result([]);
    });
    const response=await request(app).post(`/api/v1/employees/${employee}/object-assignments`)
      .set('Cookie',['securityops_session=opaque','securityops_csrf=csrf-value'])
      .set('x-csrf-token','csrf-value')
      .send({site_id:site,assignment_type:'operational',starts_on:'2026-11-25',primary_assignment:false,reason:'Coverage requirement'});
    expect(response.status).toBe(201);
    expect(response.body.site_id).toBe(site);
    expect(queryMock.mock.calls.find(([sql])=>String(sql).includes('INSERT INTO employee_object_assignments'))?.[1]).toEqual([tenant,employee,site,'operational',null,'2026-11-25',null,false,null]);
  });

  it('ends an object assignment through the existing employee assignment record',async()=>{
    const employee='00000000-0000-4000-8000-0000000000dd';
    const assignment='00000000-0000-4000-8000-0000000000ee';
    const scoped={...sessionUser,permissions:[],permission_grants:[{code:'employees:write',scope:'site'}]};
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([scoped]);
      if(sql.includes('SELECT site_id,employee_id,starts_on'))return result([{site_id:site,employee_id:employee,starts_on:'2026-01-01'}]);
      if(sql.includes('UPDATE employee_object_assignments SET ends_on'))return result([{id:assignment,employee_id:employee,site_id:site,ends_on:'2026-11-25'}]);
      return result([]);
    });
    const response=await request(app).patch(`/api/v1/employees/${employee}/object-assignments/${assignment}`)
      .set('Cookie',['securityops_session=opaque','securityops_csrf=csrf-value'])
      .set('x-csrf-token','csrf-value')
      .send({ends_on:'2026-11-25',reason:'No longer assigned'});
    expect(response.status).toBe(200);
    expect(response.body.ends_on).toBe('2026-11-25');
  });

  it('rejects employee assignment writes when the requested site is outside the site grant',async()=>{
    const employee='00000000-0000-4000-8000-0000000000dd';
    const scoped={...sessionUser,permissions:[],permission_grants:[{code:'employees:write',scope:'site'}],site_ids:[]};
    queryMock.mockImplementation(async(sql:string)=>sql.includes('FROM sessions')?result([scoped]):result([]));
    const response=await request(app).post(`/api/v1/employees/${employee}/object-assignments`)
      .set('Cookie',['securityops_session=opaque','securityops_csrf=csrf-value'])
      .set('x-csrf-token','csrf-value')
      .send({site_id:site,starts_on:'2026-11-25',reason:'Coverage requirement'});
    expect(response.status).toBe(403);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('FROM employees WHERE tenant_id=$1 AND id=$2'))).toBe(false);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('INSERT INTO employee_object_assignments'))).toBe(false);
  });

  it('prevents a site-scoped assignment from changing primary status across other sites',async()=>{
    const employee='00000000-0000-4000-8000-0000000000dd';
    const scoped={...sessionUser,permissions:[],permission_grants:[{code:'employees:write',scope:'site'}]};
    queryMock.mockImplementation(async(sql:string)=>sql.includes('FROM sessions')?result([scoped]):result([]));
    const response=await request(app).post(`/api/v1/employees/${employee}/object-assignments`)
      .set('Cookie',['securityops_session=opaque','securityops_csrf=csrf-value'])
      .set('x-csrf-token','csrf-value')
      .send({site_id:site,starts_on:'2026-11-25',primary_assignment:true,reason:'Coverage requirement'});
    expect(response.status).toBe(403);
    expect(response.body.error).toContain('tenant-wide');
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('UPDATE employee_object_assignments'))).toBe(false);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('INSERT INTO employee_object_assignments'))).toBe(false);
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

  it('allows site-scoped readers to load watchbook categories and priorities',async()=>{
    const scoped={...sessionUser,permissions:[],permission_grants:[{code:'watchbook:read',scope:'site'}]};
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([scoped]);
      if(sql.includes('FROM watchbook_categories'))return result([{id:'category-id',code:'maintenance',name:'Technik / Instandhaltung'}]);
      if(sql.includes('FROM watchbook_priorities'))return result([{id:'priority-id',code:'medium',name:'Mittel',rank:2}]);
      return result([]);
    });
    const cookie='securityops_session=opaque';
    const categories=await request(app).get('/api/v1/watchbook/categories').set('Cookie',cookie);
    const priorities=await request(app).get('/api/v1/watchbook/priorities').set('Cookie',cookie);
    expect(categories.status).toBe(200);
    expect(categories.body).toEqual([{id:'category-id',code:'maintenance',name:'Technik / Instandhaltung'}]);
    expect(priorities.status).toBe(200);
    expect(priorities.body).toEqual([{id:'priority-id',code:'medium',name:'Mittel',rank:2}]);
  });

  it('creates an idempotent maintenance watchbook entry for a site-scoped writer',async()=>{
    const category='00000000-0000-4000-8000-0000000000e1';
    const entryId='00000000-0000-4000-8000-0000000000e2';
    const revisionId='00000000-0000-4000-8000-0000000000e3';
    const scoped={...sessionUser,permissions:[],permission_grants:[{code:'watchbook:write',scope:'site'}]};
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([scoped]);
      if(sql.includes('FROM sites WHERE tenant_id=$1 AND id=$2'))return result([{id:site}]);
      if(sql.includes('FROM watchbook_categories'))return result([{id:category}]);
      if(sql.includes('FROM watchbook_priorities'))return result([{id:'priority-id'}]);
      if(sql.includes('INSERT INTO sync_receipts'))return result([{id:'receipt-id'}]);
      if(sql.includes('INSERT INTO watchbook_entries'))return result([{id:entryId,site_id:site}]);
      if(sql.includes('INSERT INTO watchbook_revisions'))return result([{id:revisionId}]);
      return result([]);
    });
    const response=await request(app).post('/api/v1/watchbook/entries')
      .set('Cookie',['securityops_session=opaque','securityops_csrf=csrf-value'])
      .set('x-csrf-token','csrf-value')
      .send({site_id:site,category_id:category,priority_code:'medium',content:'Inspect loading-bay shutter',client_entry_id:'00000000-0000-4000-8000-0000000000e4'});
    expect(response.status).toBe(201);
    expect(response.body.entry).toEqual(expect.objectContaining({id:entryId,site_id:site}));
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('INSERT INTO audit_events'))).toBe(true);
  });

  it('rejects watchbook writes outside the site grant and site-less writes for site-scoped users',async()=>{
    const scoped={...sessionUser,permissions:[],permission_grants:[{code:'watchbook:write',scope:'site'}],site_ids:[]};
    queryMock.mockImplementation(async(sql:string)=>sql.includes('FROM sessions')?result([scoped]):result([]));
    const cookie=['securityops_session=opaque','securityops_csrf=csrf-value'];
    const outside=await request(app).post('/api/v1/watchbook/entries')
      .set('Cookie',cookie).set('x-csrf-token','csrf-value')
      .send({site_id:site,category_id:customer,priority_code:'medium',content:'Out of scope',client_entry_id:'00000000-0000-4000-8000-0000000000e5'});
    expect(outside.status).toBe(403);
    const withoutSite=await request(app).post('/api/v1/watchbook/entries')
      .set('Cookie',cookie).set('x-csrf-token','csrf-value')
      .send({category_id:customer,priority_code:'medium',content:'No site assigned',client_entry_id:'00000000-0000-4000-8000-0000000000e6'});
    expect(withoutSite.status).toBe(403);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('INSERT INTO sync_receipts'))).toBe(false);
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

  it('creates a location with a site-assigned responsible employee and audit event',async()=>{
    const employee='00000000-0000-4000-8000-0000000000dd';
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([sessionUser]);
      if(sql.includes('FROM sites WHERE'))return result([{id:site}]);
      if(sql.includes('FROM employee_object_assignments oa'))return result([{id:'assignment-1'}]);
      if(sql.includes('INSERT INTO object_locations'))return result([{id:'00000000-0000-4000-8000-0000000000de',responsible_employee_id:employee}]);
      return result([]);
    });
    const response=await request(app).post(`/api/v1/sites/${site}/locations`)
      .set('Cookie',['securityops_session=opaque','securityops_csrf=csrf-value'])
      .set('x-csrf-token','csrf-value')
      .send({name:'North building',location_type:'building',responsible_employee_id:employee});
    expect(response.status).toBe(201);
    expect(response.body.responsible_employee_id).toBe(employee);
    expect(queryMock.mock.calls.find(([sql])=>String(sql).includes('FROM employee_object_assignments oa'))?.[1]).toEqual([tenant,site,employee]);
    expect(queryMock.mock.calls.some(([sql,values])=>String(sql).includes('INSERT INTO audit_events')&&values?.[2]==='site.location.created')).toBe(true);
  });

  it('requires building-area-zone parent types and rejects detached areas or zones',async()=>{
    const parent='00000000-0000-4000-8000-0000000000de';
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([sessionUser]);
      if(sql.includes('FROM sites WHERE'))return result([{id:site}]);
      if(sql.includes('FROM object_locations WHERE tenant_id=$1 AND site_id=$2 AND id=$3'))return result([{id:parent,location_type:'zone'}]);
      return result([]);
    });
    const cookie=['securityops_session=opaque','securityops_csrf=csrf-value'];
    const wrongParent=await request(app).post(`/api/v1/sites/${site}/locations`).set('Cookie',cookie).set('x-csrf-token','csrf-value')
      .send({name:'North area',location_type:'area',parent_id:parent});
    expect(wrongParent.status).toBe(400);
    expect(wrongParent.body.error).toContain('Parent location must be a building');
    const missingParent=await request(app).post(`/api/v1/sites/${site}/locations`).set('Cookie',cookie).set('x-csrf-token','csrf-value')
      .send({name:'North zone',location_type:'zone'});
    expect(missingParent.status).toBe(400);
    expect(missingParent.body.error).toContain('require a parent location');
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('INSERT INTO object_locations'))).toBe(false);
  });

  it('updates hierarchy fields only for a location in the authorized site and audits the edit',async()=>{
    const location='00000000-0000-4000-8000-0000000000de';
    const employee='00000000-0000-4000-8000-0000000000dd';
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([sessionUser]);
      if(sql.includes('FROM object_locations WHERE tenant_id=$1 AND site_id=$2 AND id=$3'))return result([{id:location,location_type:'building',parent_id:null}]);
      if(sql.includes('FROM employee_object_assignments oa'))return result([{id:'assignment-1'}]);
      if(sql.includes('UPDATE object_locations SET'))return result([{id:location,name:'North Lobby',security_level:'high',responsible_employee_id:employee}]);
      return result([]);
    });

    const response=await request(app).patch(`/api/v1/sites/${site}/locations/${location}`)
      .set('Cookie',['securityops_session=opaque','securityops_csrf=csrf-value'])
      .set('x-csrf-token','csrf-value')
      .send({name:'North Lobby',parent_id:null,security_level:'high',responsible_employee_id:employee});
    expect(response.status).toBe(200);
    expect(response.body.name).toBe('North Lobby');
    const update=queryMock.mock.calls.find(([sql])=>String(sql).includes('UPDATE object_locations SET'));
    expect(update?.[1]).toEqual([tenant,site,location,null,'North Lobby','high',employee]);
    expect(queryMock.mock.calls.some(([sql,values])=>String(sql).includes('INSERT INTO audit_events')&&values?.[2]==='site.location.updated')).toBe(true);
  });

  it('rejects off-site employees as location and hazard owners',async()=>{
    const employee='00000000-0000-4000-8000-0000000000dd';
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([sessionUser]);
      if(sql.includes('FROM sites WHERE'))return result([{id:site}]);
      if(sql.includes('FROM employee_object_assignments oa'))return result([]);
      return result([]);
    });
    const cookie=['securityops_session=opaque','securityops_csrf=csrf-value'];
    const location=await request(app).post(`/api/v1/sites/${site}/locations`).set('Cookie',cookie).set('x-csrf-token','csrf-value')
      .send({name:'North building',location_type:'building',responsible_employee_id:employee});
    expect(location.status).toBe(400);
    expect(location.body.error).toContain('assigned to this site');
    const hazard=await request(app).post(`/api/v1/sites/${site}/hazards`).set('Cookie',cookie).set('x-csrf-token','csrf-value')
      .send({title:'Entry risk',category:'unauthorized_access',description:'Unassigned guard',likelihood:2,impact:3,responsible_employee_id:employee});
    expect(hazard.status).toBe(400);
    expect(hazard.body.error).toContain('assigned to this site');
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('INSERT INTO object_locations'))).toBe(false);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('INSERT INTO object_hazards'))).toBe(false);
  });

  it('rejects hierarchy cycles and hazard dates that violate the risk review window',async()=>{
    const location='00000000-0000-4000-8000-0000000000de';
    const child='00000000-0000-4000-8000-0000000000df';
    const hazard='00000000-0000-4000-8000-0000000000e0';
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([sessionUser]);
      if(sql.includes('FROM object_locations WHERE tenant_id=$1 AND site_id=$2 AND id=$3'))return result([{id:location,location_type:'building',parent_id:null}]);
      if(sql.includes('WITH RECURSIVE descendants'))return result([{id:child}]);
      if(sql.includes('FROM object_hazards WHERE tenant_id=$1 AND site_id=$2 AND id=$3'))return result([{id:hazard,due_on:'2026-04-01',review_on:'2026-05-01',likelihood:2,impact:3}]);
      return result([]);
    });
    const cookie=['securityops_session=opaque','securityops_csrf=csrf-value'];
    const cycle=await request(app).patch(`/api/v1/sites/${site}/locations/${location}`)
      .set('Cookie',cookie).set('x-csrf-token','csrf-value').send({parent_id:child});
    expect(cycle.status).toBe(400);
    expect(cycle.body.error).toContain('hierarchy cycle');
    const invalidDates=await request(app).patch(`/api/v1/sites/${site}/hazards/${hazard}`)
      .set('Cookie',cookie).set('x-csrf-token','csrf-value').send({review_on:'2026-03-31'});
    expect(invalidDates.status).toBe(400);
    expect(invalidDates.body.error).toContain('review_on');
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('UPDATE object_locations SET'))).toBe(false);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('UPDATE object_hazards SET'))).toBe(false);
  });

  it('updates risk records with a recalculated score and audit event',async()=>{
    const hazard='00000000-0000-4000-8000-0000000000e0';
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([sessionUser]);
      if(sql.includes('FROM object_hazards WHERE tenant_id=$1 AND site_id=$2 AND id=$3'))return result([{id:hazard,due_on:null,review_on:null,likelihood:2,impact:3}]);
      if(sql.includes('UPDATE object_hazards SET'))return result([{id:hazard,status:'closed',likelihood:4,impact:3,risk_score:12}]);
      return result([]);
    });
    const response=await request(app).patch(`/api/v1/sites/${site}/hazards/${hazard}`)
      .set('Cookie',['securityops_session=opaque','securityops_csrf=csrf-value'])
      .set('x-csrf-token','csrf-value')
      .send({status:'closed',likelihood:4});
    expect(response.status).toBe(200);
    expect(response.body.risk_score).toBe(12);
    const update=queryMock.mock.calls.find(([sql])=>String(sql).includes('UPDATE object_hazards SET'));
    expect(update?.[1]).toEqual([tenant,site,hazard,4,'closed']);
    const audit=queryMock.mock.calls.find(([sql,values])=>String(sql).includes('INSERT INTO audit_events')&&values?.[2]==='site.hazard.updated');
    expect(audit?.[1]?.[5]).toEqual(expect.objectContaining({risk_score:12}));
  });

  it('tracks hazard measures with site validation, due dates, status changes and audit events',async()=>{
    const hazard='00000000-0000-4000-8000-0000000000e0';
    const measure='00000000-0000-4000-8000-0000000000e1';
    const employee='00000000-0000-4000-8000-0000000000dd';
    const scoped={...sessionUser,permission_grants:[{code:'sites:write',scope:'site'}],site_ids:[site]};
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([scoped]);
      if(sql.includes('FROM object_hazards WHERE tenant_id=$1 AND site_id=$2 AND id=$3'))return result([{id:hazard}]);
      if(sql.includes('FROM employee_object_assignments oa'))return result([{id:'assignment-1'}]);
      if(sql.includes('SELECT id,status FROM object_hazard_measures'))return result([{id:measure,status:'in_progress'}]);
      if(sql.includes('INSERT INTO object_hazard_measures'))return result([{id:measure,status:'open',due_on:'2026-12-01'}]);
      if(sql.includes('UPDATE object_hazard_measures SET'))return result([{id:measure,status:'completed',due_on:'2026-12-01',completed_at:'2026-11-25T10:00:00Z'}]);
      return result([]);
    });
    const cookie=['securityops_session=opaque','securityops_csrf=csrf-value'];
    const create=await request(app).post(`/api/v1/sites/${site}/hazards/${hazard}/measures`)
      .set('Cookie',cookie).set('x-csrf-token','csrf-value')
      .send({title:'Inspect extinguisher',description:'Check seal and pressure',responsible_employee_id:employee,due_on:'2026-12-01'});
    expect(create.status).toBe(201);
    expect(queryMock.mock.calls.find(([sql])=>String(sql).includes('INSERT INTO object_hazard_measures'))?.[1]).toEqual([tenant,site,hazard,'Inspect extinguisher','Check seal and pressure',employee,'2026-12-01','open',scoped.id]);
    const update=await request(app).patch(`/api/v1/sites/${site}/hazards/${hazard}/measures/${measure}`)
      .set('Cookie',cookie).set('x-csrf-token','csrf-value')
      .send({status:'completed',due_on:'2026-12-01'});
    expect(update.status).toBe(200);
    expect(update.body.completed_at).toBe('2026-11-25T10:00:00Z');
    const updateCall=queryMock.mock.calls.find(([sql])=>String(sql).includes('UPDATE object_hazard_measures SET'));
    expect(updateCall?.[0]).toContain("completed_at=CASE WHEN $4='completed'");
    expect(updateCall?.[1]).toEqual([tenant,site,hazard,'completed',measure,'2026-12-01','completed']);
    expect(queryMock.mock.calls.some(([sql,values])=>String(sql).includes('INSERT INTO audit_events')&&values?.[2]==='site.hazard_measure.created')).toBe(true);
    expect(queryMock.mock.calls.some(([sql,values])=>String(sql).includes('INSERT INTO audit_events')&&values?.[2]==='site.hazard_measure.updated')).toBe(true);
  });

  it('creates, separately approves and acknowledges the exact instruction version',async()=>{
    const instruction='00000000-0000-4000-8000-0000000000df';
    const nextInstruction='00000000-0000-4000-8000-0000000000e0';
    const employee='00000000-0000-4000-8000-0000000000dd';
    const approverId='00000000-0000-4000-8000-000000000002';
    const approver={...sessionUser,id:approverId,permissions:['sites:read','sites:write','employees:read'],permission_grants:[
      {code:'site_instructions:approve',scope:'site'},{code:'sites:write',scope:'site'},{code:'employees:read',scope:'site'},
    ],site_ids:[site]};
    let titleLookupCount=0;
    let approvalCount=0;
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([activeUser]);
      if(sql.includes('FROM sites WHERE'))return result([{id:site}]);
      if(sql.includes('SELECT id,status,created_by,version,title FROM site_instructions'))return result([{id:approvalCount++===0?instruction:nextInstruction,status:'pending_approval',created_by:sessionUser.id,version:approvalCount,title:'Evacuation'}]);
      if(sql.includes('SELECT id,version,status,title,requires_acknowledgement FROM site_instructions'))return result([{id:nextInstruction,version:2,status:'approved',title:'Evacuation',requires_acknowledgement:true}]);
      if(sql.includes('SELECT id,version,title FROM site_instructions'))return result([{id:instruction,version:1,title:'Evacuation'}]);
      if(sql.includes('SELECT id FROM site_instructions WHERE tenant_id=$1 AND site_id=$2 AND title=$3'))return result(titleLookupCount++===0?[]:titleLookupCount<4?[{id:instruction}]:[{id:nextInstruction}]);
      if(sql.includes('FROM employees e'))return result([{id:employee}]);
      if(sql.includes('INSERT INTO instruction_acknowledgements'))return result([{instruction_id:nextInstruction,employee_id:employee,acknowledged_version:2}]);
      if(sql.includes("UPDATE site_instructions SET status='approved'"))return result([{id:sql.includes('WHERE tenant_id=$1')&&queryMock.mock.calls.at(-1)?.[1]?.[2]===instruction?instruction:nextInstruction,status:'approved',approved_by:approverId}]);
      if(sql.includes('INSERT INTO site_instructions'))return result([{id:queryMock.mock.calls.at(-1)?.[1]?.[5]===2?nextInstruction:instruction,version:queryMock.mock.calls.at(-1)?.[1]?.[5],status:queryMock.mock.calls.at(-1)?.[1]?.[6],created_by:queryMock.mock.calls.at(-1)?.[1]?.[10]}]);
      return result([]);
    });
    const cookie=['securityops_session=opaque','securityops_csrf=csrf-value'];
    const directApproval=await request(app).post(`/api/v1/sites/${site}/instructions`).set('Cookie',cookie).set('x-csrf-token','csrf-value')
      .send({title:'Evacuation',content:'Use the marked exit.',version:1,status:'approved',requires_acknowledgement:true});
    expect(directApproval.status).toBe(400);
    const create=await request(app).post(`/api/v1/sites/${site}/instructions`).set('Cookie',cookie).set('x-csrf-token','csrf-value')
      .send({title:'Evacuation',content:'Use the marked exit.',version:1,status:'pending_approval',requires_acknowledgement:true});
    expect(create.status).toBe(201);
    activeUser=approver;
    const approveFirst=await request(app).post(`/api/v1/sites/${site}/instructions/${instruction}/approve`).set('Cookie',cookie).set('x-csrf-token','csrf-value');
    expect(approveFirst.status).toBe(200);
    activeUser=sessionUser;
    const nextVersion=await request(app).post(`/api/v1/sites/${site}/instructions`).set('Cookie',cookie).set('x-csrf-token','csrf-value')
      .send({title:'Evacuation',content:'Use the marked east exit.',version:2,status:'pending_approval',requires_acknowledgement:true,supersedes_id:instruction});
    expect(nextVersion.status).toBe(201);
    activeUser=approver;
    const approveSecond=await request(app).post(`/api/v1/sites/${site}/instructions/${nextInstruction}/approve`).set('Cookie',cookie).set('x-csrf-token','csrf-value');
    expect(approveSecond.status).toBe(200);
    const acknowledged=await request(app).post(`/api/v1/sites/${site}/instructions/${nextInstruction}/acknowledgements`).set('Cookie',cookie).set('x-csrf-token','csrf-value')
      .send({employee_id:employee});
    expect(acknowledged.status).toBe(201);
    expect(acknowledged.body.acknowledged_version).toBe(2);
    expect(queryMock.mock.calls.some(([sql,values])=>String(sql).includes('INSERT INTO instruction_acknowledgements')&&values?.[0]===tenant&&values?.[3]===2)).toBe(true);
    expect(queryMock.mock.calls.some(([sql,values])=>String(sql).includes('INSERT INTO audit_events')&&values?.[2]==='site.instruction.approved'&&values?.[1]===approverId)).toBe(true);
  });

  it('requires a separate authorized approver to return pending instructions for revision',async()=>{
    const instruction='00000000-0000-4000-8000-0000000000df';
    const approver={...sessionUser,id:'00000000-0000-4000-8000-000000000002',permission_grants:[{code:'site_instructions:approve',scope:'site'}],site_ids:[site]};
    const selfApprover={...sessionUser,permission_grants:[{code:'site_instructions:approve',scope:'site'}],site_ids:[site]};
    const cookie=['securityops_session=opaque','securityops_csrf=csrf-value'];
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([activeUser]);
      if(sql.includes('SELECT id,status,created_by,version,title FROM site_instructions'))return result([{id:instruction,status:'pending_approval',created_by:activeUser===selfApprover?selfApprover.id:sessionUser.id,version:1,title:'Evacuation'}]);
      if(sql.includes('SELECT id FROM site_instructions WHERE tenant_id=$1 AND site_id=$2 AND title=$3'))return result([{id:instruction}]);
      if(sql.includes("UPDATE site_instructions SET status='draft'"))return result([{id:instruction,status:'draft'}]);
      return result([]);
    });
    const unauthorized=await request(app).post(`/api/v1/sites/${site}/instructions/${instruction}/approve`).set('Cookie',cookie).set('x-csrf-token','csrf-value');
    expect(unauthorized.status).toBe(403);
    activeUser=selfApprover;
    const selfApproval=await request(app).post(`/api/v1/sites/${site}/instructions/${instruction}/approve`).set('Cookie',cookie).set('x-csrf-token','csrf-value');
    expect(selfApproval.status).toBe(403);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes("UPDATE site_instructions SET status='approved'"))).toBe(false);
    activeUser=approver;
    const returned=await request(app).post(`/api/v1/sites/${site}/instructions/${instruction}/return-for-revision`).set('Cookie',cookie).set('x-csrf-token','csrf-value')
      .send({reason:'Add the evacuation assembly point'});
    expect(returned.status).toBe(200);
    expect(queryMock.mock.calls.some(([sql,values])=>String(sql).includes('INSERT INTO audit_events')&&values?.[2]==='site.instruction.returned_for_revision')).toBe(true);
  });

  it('rejects unchained instruction versions and acknowledgements from non-object employees',async()=>{
    const instruction='00000000-0000-4000-8000-0000000000df';
    const employee='00000000-0000-4000-8000-0000000000dd';
    const scoped={...sessionUser,permissions:[...sessionUser.permissions,'employees:read'],permission_grants:[{code:'employees:read',scope:'site'}]};
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([scoped]);
      if(sql.includes('FROM sites WHERE'))return result([{id:site}]);
      if(sql.includes('SELECT id,version,status FROM site_instructions'))return result([{id:instruction,version:1,status:'approved'}]);
      if(sql.includes('SELECT id,version,title FROM site_instructions'))return result([{id:instruction,version:1,title:'Evacuation'}]);
      if(sql.includes('ORDER BY version DESC LIMIT 1'))return result([{id:'00000000-0000-4000-8000-0000000000e0'}]);
      return result([]);
    });
    const cookie=['securityops_session=opaque','securityops_csrf=csrf-value'];
    const invalidVersion=await request(app).post(`/api/v1/sites/${site}/instructions`).set('Cookie',cookie).set('x-csrf-token','csrf-value')
      .send({title:'Evacuation',content:'Use the marked exit.',version:2,status:'draft'});
    expect(invalidVersion.status).toBe(400);
    expect(invalidVersion.body.error).toContain('start at version 1');
    const changedTitle=await request(app).post(`/api/v1/sites/${site}/instructions`).set('Cookie',cookie).set('x-csrf-token','csrf-value')
      .send({title:'Different title',content:'Use the marked exit.',version:2,status:'draft',supersedes_id:instruction});
    expect(changedTitle.status).toBe(400);
    const staleVersion=await request(app).post(`/api/v1/sites/${site}/instructions`).set('Cookie',cookie).set('x-csrf-token','csrf-value')
      .send({title:'Evacuation',content:'Use the marked exit.',version:2,status:'draft',supersedes_id:instruction});
    expect(staleVersion.status).toBe(409);
    const unassignedAck=await request(app).post(`/api/v1/sites/${site}/instructions/${instruction}/acknowledgements`).set('Cookie',cookie).set('x-csrf-token','csrf-value')
      .send({employee_id:employee});
    expect(unassignedAck.status).toBe(404);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('INSERT INTO instruction_acknowledgements'))).toBe(false);
  });

  it('validates hazard scoring inputs server-side',async()=>{
    const response=await request(app).post(`/api/v1/sites/${site}/hazards`)
      .set('Cookie',['securityops_session=opaque','securityops_csrf=csrf-value'])
      .set('x-csrf-token','csrf-value')
      .send({title:'Fire loading bay',category:'fire',description:'Combustible storage',likelihood:6,impact:3});
    expect(response.status).toBe(400);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('INSERT INTO object_hazards'))).toBe(false);
  });

  it('reports mandatory document requirements with a single server-side status',async()=>{
    const scoped={...sessionUser,permissions:['sites:read'],permission_grants:[{code:'dms:read',scope:'site'}]};
    const documents=[
      {id:'doc-valid',document_type:'Security plan',document_status:'active',approval_status:'approved',valid_until:'2099-01-01',versions:[{lifecycle_state:'available'}]},
      {id:'doc-draft',document_type:'Shift plan',document_status:'active',approval_status:'draft',valid_until:null,versions:[{lifecycle_state:'available'}]},
    ];
    const requirements=[
      {id:'req-1',document_type:'Security plan',required:true,responsible_employee_id:null,responsible_employee_name:null,created_at:null,updated_at:null},
      {id:'req-2',document_type:'Shift plan',required:true,responsible_employee_id:null,responsible_employee_name:null,created_at:null,updated_at:null},
      {id:'req-3',document_type:'Fire safety plan',required:true,responsible_employee_id:null,responsible_employee_name:null,created_at:null,updated_at:null},
    ];
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([scoped]);
      if(sql.includes('FROM sites s'))return result([{id:site}]);
      if(sql.includes('FROM dms_documents d'))return result(documents);
      if(sql.includes('FROM dms_document_requirements r'))return result(requirements);
      return result([]);
    });
    const response=await request(app).get(`/api/v1/sites/${site}/object-context`).set('Cookie','securityops_session=opaque');
    expect(response.status).toBe(200);
    expect(response.body.documentRequirements).toEqual([
      expect.objectContaining({id:'req-1',missing:false,requirement_status:'gueltig',matching_document_id:'doc-valid'}),
      expect.objectContaining({id:'req-2',missing:false,requirement_status:'nicht_freigegeben',matching_document_id:'doc-draft'}),
      expect.objectContaining({id:'req-3',missing:true,requirement_status:'fehlend',matching_document_id:null}),
    ]);
    expect(String(queryMock.mock.calls.find(([sql])=>String(sql).includes('FROM dms_document_requirements r'))?.[0])).not.toContain('CASE WHEN r.required');
  });

  it('reports the same DMS status on object documents and linked maintenance evidence',async()=>{
    const scoped={...sessionUser,permissions:['sites:read'],permission_grants:[{code:'dms:read',scope:'site'},{code:'devices:read',scope:'site'}]};
    const document={id:'doc-valid',title:'Prüfprotokoll',document_status:'active',approval_status:'approved',valid_until:'2099-01-01',review_on:null,reviewed_at:null,versions:[{lifecycle_state:'available'}]};
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([scoped]);
      if(sql.includes('FROM sites s'))return result([{id:site,status:'active'}]);
      if(sql.includes('FROM dms_documents d'))return result([document]);
      if(sql.includes('FROM maintenance_orders o'))return result([{
        id:'order-1',site_id:site,device_id:null,order_number:'WO-1',maintenance_type:'inspection',
        description:'Prüfung',priority_code:'high',due_on:null,status:'open',responsible_employee_id:null,
        created_at:null,
        documents:[{id:'link-1',document_id:document.id,document_title:document.title,document_status:'active'}],
      }]);
      return result([]);
    });
    const response=await request(app).get(`/api/v1/sites/${site}/object-context`).set('Cookie','securityops_session=opaque');
    expect(response.status).toBe(200);
    expect(response.body.documents).toEqual([expect.objectContaining({id:document.id,computed_status:'gueltig',status_label:'Gültig'})]);
    expect(response.body.maintenanceOrders[0].documents).toEqual([expect.objectContaining({
      document_id:document.id,document_status:'Gültig',computed_status:'gueltig',
    })]);
  });
});
