import request from 'supertest';
import type {QueryResult} from 'pg';
import {beforeEach,describe,expect,it,jest} from '@jest/globals';

const queryMock=jest.fn();
const commitMock=jest.fn();
const rollbackMock=jest.fn();

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

const {app}=await import('../src/app.js');
const result=(rows:unknown[],rowCount=rows.length)=>({rows,rowCount}) as unknown as QueryResult;
const tenant='00000000-0000-4000-8000-000000000010';
const userId='00000000-0000-4000-8000-000000000001';
const employeeId='00000000-0000-4000-8000-000000000031';
const otherEmployeeId='00000000-0000-4000-8000-000000000032';
const otherTenantAccount='00000000-0000-4000-8000-000000000099';
const csrf={Cookie:['securityops_session=session-1','securityops_csrf=csrf-value'],'x-csrf-token':'csrf-value'};

const baseEmployee={
  id:employeeId,tenant_id:tenant,name:'Ava Worker',email:'ava@example.invalid',title:'Wachschutz',
  employee_number:'P-100',first_name:'Ava',last_name:'Worker',phone:'+49 30 111',mobile:null,
  address:'Teststraße 1',date_of_birth:'1990-01-01',hire_date:'2020-01-01',termination_date:null,
  employment_status:'active',employment_type:'employee',department:'Security',position:'Wache',
  work_location:'Zentrale',weekly_hours:40,user_id:null,created_at:'2026-01-01T00:00:00Z',updated_at:'2026-01-01T00:00:00Z',
};

function payload(patch:Record<string,unknown>={}){
  return {
    name:'Ava Worker',email:'ava@example.invalid',title:'Wachschutz',employee_number:'P-100',
    first_name:'Ava',last_name:'Worker',phone:'+49 30 111',mobile:null,address:'Teststraße 1',
    date_of_birth:'1990-01-01',hire_date:'2020-01-01',termination_date:null,
    employment_status:'active',employment_type:'employee',department:'Security',position:'Wache',
    work_location:'Zentrale',weekly_hours:40,user_id:null,reason:'Stammdaten korigiert',...patch,
  };
}

type Handler=(sql:string,values:unknown[])=>unknown;
function session(permissions:string[],role='operator'){
  return {
    id:userId,tenantId:tenant,email:'operator@example.invalid',role,
    permissions,permission_grants:permissions.map(code=>({code,scope:'tenant'})),
    site_ids:[],is_system_admin:false,session_id:'session-1',csrf_token:'csrf-value',
    expires_at:'2099-01-01',device_id:'device-1',
  };
}

function install(options:{permissions?:string[];role?:string;handler?:Handler}={}){
  const current=options.handler??(()=>undefined);
  queryMock.mockReset();
  queryMock.mockImplementation(async(sql:string,values:unknown[])=>{
    if(sql.includes('FROM sessions'))return result([session(options.permissions??['employees:read','employees:write'],options.role)]);
    return current(sql,values)??result([]);
  });
  return {call:(sql:string)=>queryMock.mock.calls.find(([statement])=>String(statement).includes(sql))};
}

function updateHandler(updateValues:(values:unknown[])=>void,overrides:Record<string,unknown>={}){
  return (sql:string,values:unknown[])=>{
    if(sql.includes('UPDATE employees SET')){
      updateValues(values);
      return result([{...baseEmployee,...overrides}]);
    }
    if(sql.includes('SELECT * FROM employees'))return result([{...baseEmployee,...overrides}]);
    if(sql.includes('SELECT id,name,email FROM employees'))return result([baseEmployee]);
    if(sql.includes('INSERT INTO employee_history'))return result([{id:'history-1'}],1);
    if(sql.includes('INSERT INTO audit_events'))return result([{id:'audit-1'}],1);
    return undefined;
  };
}

beforeEach(()=>{commitMock.mockReset();rollbackMock.mockReset();});

describe('employee master data PATCH /employees/:id/profile',()=>{
  it('persists changed first/last name and phone in the tenant scope',async()=>{
    let values:unknown[]=[];
    const {call}=install({handler:updateHandler(captured=>{values=captured;},{first_name:'Lena',last_name:'Fischer',phone:'+49 30 999'})});
    const response=await request(app).patch(`/api/v1/employees/${employeeId}/profile`).set(csrf).send(payload({first_name:'Lena',last_name:'Fischer',phone:'+49 30 999',reason:'Namensänderung'}));
    expect(response.status).toBe(200);
    expect(response.body.first_name).toBe('Lena');
    expect(values[4]).toBe('Lena');
    expect(values[5]).toBe('Fischer');
    expect(values[6]).toBe('+49 30 999');
    expect(values[19]).toBe(tenant);
    expect(values[20]).toBe(employeeId);
    expect(call('UPDATE employees SET')).toBeTruthy();
    expect(call('INSERT INTO employee_history')).toBeTruthy();
    expect(call('INSERT INTO audit_events')).toBeTruthy();
    expect(commitMock).toHaveBeenCalledTimes(1);
  });

  it('persists email, address and employment status together without nulling untouched fields',async()=>{
    let values:unknown[]=[];
    install({handler:updateHandler(captured=>{values=captured;},{email:'lena@example.invalid',address:'Neustrasse 9',employment_status:'leave'})});
    const response=await request(app).patch(`/api/v1/employees/${employeeId}/profile`).set(csrf).send(payload({
      email:'lena@example.invalid',address:'Neustrasse 9',employment_status:'leave',reason:'Umzug und Beurlaubung',
    }));
    expect(response.status).toBe(200);
    expect(values[1]).toBe('lena@example.invalid');
    expect(values[8]).toBe('Neustrasse 9');
    expect(values[12]).toBe('leave');
    expect(values[3]).toBe('P-100');
    expect(values[14]).toBe('Security');
    expect(values[15]).toBe('Wache');
    expect(values[17]).toBe(40);
    expect(values[19]).toBe(tenant);
  });

  it('allows clearing optional fields to null',async()=>{
    let values:unknown[]=[];
    install({handler:updateHandler(captured=>{values=captured;},{phone:null,address:null,department:null,weekly_hours:null})});
    const response=await request(app).patch(`/api/v1/employees/${employeeId}/profile`).set(csrf).send(payload({
      phone:null,address:null,department:null,weekly_hours:null,reason:'Optionale Felder bereinigt',
    }));
    expect(response.status).toBe(200);
    for(const index of [6,8,14,17])expect(values[index]).toBeNull();
    expect(values[4]).toBe('Ava');
  });

  it('reloads the updated row from the database after saving',async()=>{
    install({handler:updateHandler(()=>{},{first_name:'Lena',last_name:'Fischer'})});
    const response=await request(app).patch(`/api/v1/employees/${employeeId}/profile`).set(csrf).send(payload({first_name:'Lena',last_name:'Fischer'}));
    expect(response.status).toBe(200);
    expect(response.body.first_name).toBe('Lena');
    expect(response.body.last_name).toBe('Fischer');
  });

  it('rejects unknown, malformed and out-of-range fields with field-level errors',async()=>{
    const cases:[Record<string,unknown>,string][]=[
      [{...payload(),id:employeeId},'id'],
      [{...payload(),tenant_id:tenant},'tenant_id'],
      [payload({email:'not-an-email'}),'email'],
      [payload({employment_status:'retired'}),'employment_status'],
      [payload({weekly_hours:200}),'weekly_hours'],
      [payload({hire_date:'01.01.2020'}),'hire_date'],
      [payload({termination_date:'2019-01-01'}),'termination_date'],
      [payload({reason:''}),'reason'],
    ];
    for(const [body,field] of cases){
      const {call}=install({handler:updateHandler(()=>{})});
      const response=await request(app).patch(`/api/v1/employees/${employeeId}/profile`).set(csrf).send(body);
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Ungültiges Mitarbeiterprofil');
      expect(response.body.fields[field]).toBeTruthy();
      expect(call('UPDATE employees SET')).toBeUndefined();
    }
  });

  it('requires employees:write and a valid CSRF token',async()=>{
    install({permissions:['employees:read'],handler:updateHandler(()=>{})});
    expect((await request(app).patch(`/api/v1/employees/${employeeId}/profile`).set(csrf).send(payload())).status).toBe(403);
    install({handler:updateHandler(()=>{})});
    expect((await request(app).patch(`/api/v1/employees/${employeeId}/profile`)
      .set('Cookie',['securityops_session=session-1','securityops_csrf=csrf-value']).send(payload())).status).toBe(403);
    expect((await request(app).patch(`/api/v1/employees/${employeeId}/profile`).send(payload())).status).toBe(401);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('UPDATE employees SET'))).toBe(false);
  });

  it('does not update employees from another tenant',async()=>{
    const {call}=install({handler:(sql)=>{
      if(sql.includes('SELECT id,name,email FROM employees'))return result([]);
      return undefined;
    }});
    const response=await request(app).patch(`/api/v1/employees/${otherEmployeeId}/profile`).set(csrf).send(payload());
    expect(response.status).toBe(404);
    expect(response.body.error).toBe('Mitarbeiter nicht gefunden');
    expect(call('UPDATE employees SET')).toBeUndefined();
  });

  it('rejects a user account from another tenant',async()=>{
    const {call}=install({handler:(sql)=>{
      if(sql.includes('FROM sessions'))return result([session(['employees:read','employees:write'])]);
      if(sql.includes('SELECT id,name,email FROM employees'))return result([baseEmployee]);
      if(sql.includes('SELECT id FROM users'))return result([]);
      return undefined;
    }});
    const response=await request(app).patch(`/api/v1/employees/${employeeId}/profile`).set(csrf).send(payload({user_id:otherTenantAccount}));
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Konto nicht im Mandanten gefunden');
    expect(call('UPDATE employees SET')).toBeUndefined();
  });

  it('rolls back business data, history and audit together when the transaction fails',async()=>{
    install({handler:(sql)=>{
      if(sql.includes('SELECT id,name,email FROM employees'))return result([baseEmployee]);
      if(sql.includes('UPDATE employees SET'))return result([baseEmployee]);
      if(sql.includes('INSERT INTO employee_history'))return result([{id:'history-1'}],1);
      if(sql.includes('INSERT INTO audit_events'))throw new Error('audit unavailable');
      return undefined;
    }});
    const response=await request(app).patch(`/api/v1/employees/${employeeId}/profile`).set(csrf).send(payload());
    expect(response.status).toBe(500);
    expect(rollbackMock).toHaveBeenCalledTimes(1);
    expect(commitMock).not.toHaveBeenCalled();
  });
});
