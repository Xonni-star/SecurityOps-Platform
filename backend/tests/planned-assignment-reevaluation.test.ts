import request from 'supertest';
import type {PoolClient,QueryResult} from 'pg';
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
const {reevaluatePlannedAssignments}=await import('../src/services/staffing-verdict.js');

const result=(rows:unknown[],rowCount=rows.length)=>({rows,rowCount}) as unknown as QueryResult;
const tenant='00000000-0000-4000-8000-000000000010';
const otherTenant='00000000-0000-4000-8000-000000000011';
const userId='00000000-0000-4000-8000-000000000001';
const employee='00000000-0000-4000-8000-000000000002';
const qualification='00000000-0000-4000-8000-000000000003';
const catalog='00000000-0000-4000-8000-000000000004';
const site='00000000-0000-4000-8000-000000000020';
const period='00000000-0000-4000-8000-000000000021';
const shift='00000000-0000-4000-8000-000000000022';
const assignment='00000000-0000-4000-8000-000000000023';
const requirement='00000000-0000-4000-8000-000000000024';
const csrf={Cookie:['securityops_session=session-1','securityops_csrf=csrf-value'],'x-csrf-token':'csrf-value'};
const permissions=['qualifications:read','qualifications:write','qualifications:revoke','employees:read','employees:write',
  'scheduling:read','scheduling:write'];
const session={
  id:userId,tenantId:tenant,email:'admin@example.invalid',role:'admin',permissions,
  permission_grants:permissions.map(code=>({code,scope:'tenant'})),site_ids:[site],
  is_system_admin:false,session_id:'session-1',csrf_token:'csrf-value',expires_at:'2099-01-01',device_id:'device-1',
};
const qualificationCode='sachkunde_34a';
const futureStart=new Date(Date.now()+3*86_400_000).toISOString();
const futureEnd=new Date(Date.now()+3*86_400_000+8*3_600_000).toISOString();

type Handler={match:(sql:string)=>boolean;rows:(sql:string,values:unknown[])=>unknown[]};
let handlers:Handler[]=[];
function on(match:string,rows:unknown[]|((sql:string,values:unknown[])=>unknown[])){
  handlers.push({match:sql=>sql.includes(match),rows:typeof rows==='function'?rows:()=>rows});
}
function calls(match:string){return queryMock.mock.calls.filter(([sql])=>String(sql).includes(match));}
function conflicts(){return calls('INSERT INTO schedule_conflicts');}
function auditEvents(){return calls('INSERT INTO audit_events').map(call=>(call[1] as unknown[])??[]);}
function plannedConflict(overrides:Record<string,unknown>={}){
  return {id:'conflict-1',details:{source:'planned_assignment_reevaluation',reason_codes:['employment_status'],trigger:'employee.profile.updated'},...overrides};
}

type PlannedRow={
  assignment_id:string;employee_id:string;period_id:string;shift_id:string;site_id:string;
  starts_at:string;ends_at:string;required_qualification_codes:unknown;profile_parameters:unknown;
  tenant_id?:string;
};
type Scenario={
  employment_status?:string;
  termination_date?:string|null;
  qualificationStatus?:string;
  revokedAt?:string|null;
  requirements?:Array<{code:string}>;
  existingConflicts?:unknown[];
  overlappingRows?:unknown[];
  extraPlannedRows?:PlannedRow[];
};
function installPlannedAssignment(options:Scenario={}){
  const plannedRows:PlannedRow[]=[{
    assignment_id:assignment,employee_id:employee,period_id:period,shift_id:shift,site_id:site,
    starts_at:futureStart,ends_at:futureEnd,required_qualification_codes:[qualificationCode],profile_parameters:null,
    tenant_id:tenant,
  },...(options.extraPlannedRows??[])];
  on('SELECT a.id assignment_id,a.employee_id,p.id period_id',(_sql,values)=>{
    const scopeTenant=String(values[0]);
    const employees=values[1] as string[]|null;
    const sites=values[2] as string[]|null;
    return plannedRows.filter(row=>(row.tenant_id??tenant)===scopeTenant
      &&(!employees||employees.includes(row.employee_id))
      &&(!sites||sites.includes(row.site_id)));
  });
  on(`FROM employees WHERE tenant_id=$1 AND id=$2`,[{
    id:employee,name:'Mitarbeiter',employment_status:options.employment_status??'active',
    hire_date:'2020-01-01',termination_date:options.termination_date??null,
  }]);
  on('SELECT starts_on,ends_on FROM employee_object_assignments',[{starts_on:'2020-01-01',ends_on:null}]);
  on('FROM employee_qualifications q',[{
    id:qualification,code:qualificationCode,status:options.qualificationStatus??'valid',
    valid_from:'2020-01-01',valid_until:null,revoked_at:options.revokedAt??null,document_id:null,
    catalog_active:true,required_document_type:null,required_documents:[],
  }]);
  on('FROM site_qualification_requirements r',options.requirements??[{code:qualificationCode}]);
  on('FROM schedule_conflicts',options.existingConflicts??[]);
  on(`WHERE a.tenant_id=$1 AND a.employee_id=$2 AND a.status='assigned'`,(_sql,values)=>{
    const excluded=values[4] as string|null|undefined;
    return (options.overlappingRows??[]).filter(row=>!excluded||(row as {id?:unknown}).id!==excluded);
  });
  on('INSERT INTO schedule_conflicts',[{id:'conflict-created'}]);
}
function installRevoke(){
  on('SELECT * FROM employee_qualifications WHERE tenant_id=$1 AND employee_id=$2 AND id=$3 FOR UPDATE',[{
    id:qualification,employee_id:employee,code:qualificationCode,status:'valid',revoked_at:null,
  }]);
  on("UPDATE employee_qualifications SET status='revoked'",[{
    id:qualification,employee_id:employee,code:qualificationCode,status:'revoked',revoked_at:'2026-11-27T10:00:00Z',
  }]);
  on('SELECT site_id FROM employee_object_assignments',[{site_id:site}]);
}
function installRemoval(){
  on('SELECT * FROM employee_qualifications WHERE tenant_id=$1 AND employee_id=$2 AND id=$3 FOR UPDATE',[{
    id:qualification,employee_id:employee,code:qualificationCode,status:'valid',revoked_at:null,
  }]);
  on("UPDATE employee_qualifications SET status='invalid'",[{
    id:qualification,employee_id:employee,code:qualificationCode,status:'invalid',revoked_at:null,
  }]);
  on('SELECT site_id FROM employee_object_assignments',[{site_id:site}]);
}
function installRequirementCreate(){
  on('FROM qualification_catalog WHERE tenant_id=$1 AND id=$2 AND active=true',[{id:catalog,code:qualificationCode,name:'Sachkunde'}]);
  on('INSERT INTO site_qualification_requirements',[{
    id:requirement,site_id:site,catalog_id:catalog,required:true,active:true,responsible_employee_id:null,
  }]);
}
function employeePayload(patch:Record<string,unknown>={}){
  return {
    name:'Mitarbeiter',email:'admin@example.invalid',title:null,employee_number:null,first_name:null,last_name:null,
    phone:null,mobile:null,address:null,date_of_birth:null,hire_date:'2020-01-01',termination_date:null,
    employment_status:'active',employment_type:'employee',department:null,position:null,work_location:null,
    weekly_hours:40,user_id:null,reason:'Austritt erfasst',...patch,
  };
}
function installProfilePatch(current:Record<string,unknown>){
  on('SELECT * FROM employees WHERE tenant_id=$1 AND id=$2',()=>[current]);
  on('UPDATE employees SET',[current]);
  on('INSERT INTO employee_history',[{id:'history-1'}]);
}

beforeEach(()=>{
  queryMock.mockReset();
  handlers=[];
  queryMock.mockImplementation(async(sql:string,values:unknown[]=[])=>{
    if(String(sql).includes('FROM sessions'))return result([session]);
    const handler=handlers.find(candidate=>candidate.match(String(sql)));
    if(!handler)return result([]);
    const rows=handler.rows(String(sql),values);
    return result(Array.isArray(rows)?rows:[]);
  });
});

describe('Reevaluierung geplanter Einsätze',()=>{
  it('markiert nach Widerruf die künftige Schicht als Konflikt, ohne die Zuordnung anzutasten',async()=>{
    installRevoke();
    installPlannedAssignment({qualificationStatus:'revoked',revokedAt:'2026-11-27T10:00:00Z',
      overlappingRows:[{id:assignment}]});
    const response=await request(app)
      .post(`/api/v1/employees/${employee}/qualifications/${qualification}/revoke`)
      .set(csrf).send({reason:'Widerruf durch Aufsicht'});
    expect(response.status).toBe(200);
    expect(conflicts()).toHaveLength(1);
    expect(conflicts()[0]?.[1]?.[3]).toBe(assignment);
    expect(conflicts()[0]?.[1]?.[4]).toBe('ineligible_assignment');
    expect(conflicts()[0]?.[1]?.[5]).toMatchObject({
      source:'planned_assignment_reevaluation',trigger:'qualification.employee.revoked',
      reason_codes:['qualification_revoked'],
    });
    expect(auditEvents().some(event=>event[2]==='scheduling.planned_assignment_reevaluated'
      &&(event[5] as {action?:string}).action==='conflict_created')).toBe(true);
    expect(calls('DELETE FROM schedule_assignments')).toHaveLength(0);
    expect(calls('UPDATE schedule_assignments')).toHaveLength(0);
  });

  it('markiert nach Entfernung die künftige Schicht als Konflikt, ohne die Zuordnung anzutasten',async()=>{
    installRemoval();
    installPlannedAssignment({qualificationStatus:'invalid',requirements:[{code:qualificationCode}]});
    const response=await request(app)
      .delete(`/api/v1/employees/${employee}/qualifications/${qualification}`)
      .set(csrf).send({reason:'Nachweis ausgetauscht'});
    expect(response.status).toBe(204);
    expect(conflicts()[0]?.[1]?.[5]).toMatchObject({
      source:'planned_assignment_reevaluation',trigger:'qualification.employee.removed',
      reason_codes:['qualification_invalid'],
    });
    expect(auditEvents().some(event=>event[2]==='scheduling.planned_assignment_reevaluated'
      &&(event[5] as {action?:string}).action==='conflict_created')).toBe(true);
    expect(calls('DELETE FROM schedule_assignments')).toHaveLength(0);
    expect(calls('UPDATE schedule_assignments')).toHaveLength(0);
  });

  it('markiert künftige Einsätze bei Statuswechsel auf terminated',async()=>{
    installProfilePatch({id:employee,tenant_id:tenant,name:'Mitarbeiter',email:'admin@example.invalid',
      hire_date:'2020-01-01',termination_date:null,employment_status:'active'});
    installPlannedAssignment({employment_status:'terminated',requirements:[]});
    const response=await request(app).patch(`/api/v1/employees/${employee}/profile`).set(csrf)
      .send(employeePayload({employment_status:'terminated',termination_date:'2026-11-30'}));
    expect(response.status).toBe(200);
    expect(conflicts()[0]?.[1]?.[5]).toMatchObject({
      trigger:'employee.profile.updated',reason_codes:['employment_status'],
    });
  });

  it('markiert künftige Einsätze bei Austrittsdatum in der Vergangenheit',async()=>{
    installProfilePatch({id:employee,tenant_id:tenant,name:'Mitarbeiter',email:'admin@example.invalid',
      hire_date:'2020-01-01',termination_date:null,employment_status:'active'});
    installPlannedAssignment({termination_date:'2020-05-01',requirements:[]});
    const response=await request(app).patch(`/api/v1/employees/${employee}/profile`).set(csrf)
      .send(employeePayload({termination_date:'2020-05-01'}));
    expect(response.status).toBe(200);
    expect(conflicts()[0]?.[1]?.[5]).toMatchObject({reason_codes:['employment_ended']});
  });

  it('markiert künftige Einsätze bei neuer required Qualifikation des Objekts',async()=>{
    installRequirementCreate();
    installPlannedAssignment({requirements:[{code:qualificationCode}]});
    queryMock.mockImplementation(async(sql:string,values:unknown[]=[])=>{
      if(String(sql).includes('FROM sessions'))return result([session]);
      if(String(sql).includes('FROM employee_qualifications q')&&!String(sql).includes('schedule_assignments'))return result([]);
      const handler=handlers.find(candidate=>candidate.match(String(sql)));
      return result(handler?handler.rows(String(sql),values):[]);
    });
    const response=await request(app).post(`/api/v1/sites/${site}/qualification-requirements`).set(csrf).send({
      catalog_id:catalog,required:true,active:true,reason:'Neue Objektanforderung',
    });
    expect(response.status).toBe(201);
    expect(conflicts()[0]?.[1]?.[5]).toMatchObject({
      trigger:'site.qualification_requirement.created',reason_codes:['qualification_missing'],
    });
  });

  it('legt bei unveränderter Begründung keinen zweiten Konflikt an',async()=>{
    installPlannedAssignment({employment_status:'terminated',requirements:[],
      existingConflicts:[plannedConflict()]});
    const summary=await reevaluatePlannedAssignments({query:queryMock} as unknown as PoolClient,
      tenant,userId,'employee.profile.updated',{employee_ids:[employee]});
    expect(summary).toEqual({checked:1,conflicts_created:0,conflicts_updated:0,conflicts_resolved:0});
    expect(conflicts()).toHaveLength(0);
    expect(calls('UPDATE schedule_conflicts SET details')).toHaveLength(0);
  });

  it('löst nur eigene Konflikte auf, wenn das Urteil wieder gültig ist',async()=>{
    installPlannedAssignment({employment_status:'active',requirements:[],existingConflicts:[plannedConflict()]});
    const summary=await reevaluatePlannedAssignments({query:queryMock} as unknown as PoolClient,
      tenant,userId,'qualification.employee.updated',{employee_ids:[employee]});
    expect(summary).toEqual({checked:1,conflicts_created:0,conflicts_updated:0,conflicts_resolved:1});
    expect(calls('UPDATE schedule_conflicts SET resolved_at')).toHaveLength(1);
    expect(auditEvents().some(event=>event[2]==='scheduling.planned_assignment_reevaluated'
      &&(event[5] as {action?:string}).action==='conflict_resolved')).toBe(true);
    expect(calls('DELETE FROM schedule_conflicts')).toHaveLength(0);
  });

  it('bleibt auf Mandant und Scope der auslösenden Änderung beschränkt',async()=>{
    installPlannedAssignment({employment_status:'terminated',requirements:[],extraPlannedRows:[{
      assignment_id:'00000000-0000-4000-8000-000000000099',employee_id:employee,
      period_id:period,shift_id:shift,site_id:site,
      starts_at:futureStart,ends_at:futureEnd,required_qualification_codes:[qualificationCode],
      profile_parameters:null,tenant_id:otherTenant,
    }]});
    const summary=await reevaluatePlannedAssignments({query:queryMock} as unknown as PoolClient,
      tenant,userId,'employee.profile.updated',{employee_ids:[employee]});
    expect(summary.checked).toBe(1);
    expect(conflicts()).toHaveLength(1);
    expect(conflicts()[0]?.[1]?.[0]).toBe(tenant);
    expect(conflicts()[0]?.[1]?.[3]).toBe(assignment);
  });

  it('behandelt die geprüfte Zuordnung nicht als Überschneidung mit sich selbst',async()=>{
    installRevoke();
    installPlannedAssignment({qualificationStatus:'valid',revokedAt:null,requirements:[],
      overlappingRows:[{id:assignment}]});
    const summary=await reevaluatePlannedAssignments({query:queryMock} as unknown as PoolClient,
      tenant,userId,'qualification.employee.revoked',{employee_ids:[employee]});
    expect(summary.checked).toBe(1);
    expect(conflicts()).toHaveLength(0);
    expect(auditEvents()).toHaveLength(0);
  });
});
