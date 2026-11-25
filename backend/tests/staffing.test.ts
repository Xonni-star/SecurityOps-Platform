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
const shift='00000000-0000-4000-8000-0000000000b2';
const employee='00000000-0000-4000-8000-000000000001';
const result=(rows:unknown[],rowCount=rows.length)=>({rows,rowCount}) as unknown as QueryResult;
const grants=['scheduling:read','employees:read','qualifications:read'].map(code=>({code,scope:'site'}));
const baseUser={
  id:'00000000-0000-4000-8000-000000000009',tenantId:tenant,email:'admin@example.invalid',role:'admin',
  permissions:grants.map(grant=>grant.code),permission_grants:grants,site_ids:[site],is_system_admin:false,
  session_id:'00000000-0000-4000-8000-0000000000ac',csrf_token:'csrf-value',expires_at:'2099-01-01',
};
let activeUser:Record<string,unknown>;
const shiftRow={id:shift,site_id:site,starts_at:'2026-12-01T08:00:00Z',ends_at:'2026-12-01T16:00:00Z',
  required_qualification_codes:['sachkunde_34a'],profile_parameters:{min_rest_minutes:10}};

beforeEach(()=>{
  queryMock.mockReset();
  activeUser=baseUser;
  queryMock.mockImplementation(async(sql:string)=>{
    if(sql.includes('FROM sessions'))return result([activeUser]);
    if(sql.includes('FROM schedule_shifts sh'))return result([shiftRow]);
    if(sql.includes('FROM employee_object_assignments oa'))return result([{
      id:employee,name:'Mia Guard',employment_status:'active',starts_on:'2026-01-01',ends_on:null,
    }]);
    if(sql.includes('FROM employee_qualifications q'))return result([{
      id:'qualification-1',employee_id:employee,code:'sachkunde_34a',status:'valid',
      valid_from:'2025-01-01',valid_until:'2027-01-01',revoked_at:null,document_id:'document-1',catalog_active:true,
    }]);
    if(sql.includes('FROM site_instructions i'))return result([{
      id:'instruction-1',title:'Unterweisung',status:'approved',version:2,requires_acknowledgement:true,valid_from:null,valid_until:null,
    }]);
    if(sql.includes('FROM instruction_acknowledgements'))return result([{instruction_id:'instruction-1',employee_id:employee,acknowledged_version:1}]);
    if(sql.includes('FROM employee_absences'))return result([]);
    if(sql.includes('FROM employee_availability'))return result([]);
    if(sql.includes('FROM schedule_assignments a'))return result([]);
    return result([]);
  });
});

describe('shift eligibility endpoint',()=>{
  const path=`/api/v1/sites/${site}/shifts/${shift}/eligibility`;

  it('returns a server verdict with reasons and qualification links',async()=>{
    const response=await request(app).get(path).set('Cookie','securityops_session=opaque');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({shift_id:shift,site_id:site,required_qualification_codes:['sachkunde_34a']});
    expect(response.body.employees[0]).toMatchObject({employee_id:employee,status:'ineligible'});
    expect(response.body.employees[0].reasons[0]).toMatchObject({code:'instruction_acknowledgement',link:{type:'instruction',id:'instruction-1'}});
  });

  it('withholds eligibility data without qualification read permission',async()=>{
    activeUser={...baseUser,permissions:['scheduling:read','employees:read'],permission_grants:grants.slice(0,2)};
    const response=await request(app).get(path).set('Cookie','securityops_session=opaque');
    expect(response.status).toBe(403);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('FROM employee_qualifications q'))).toBe(false);
  });

  it('withholds eligibility data outside the granted site',async()=>{
    activeUser={...baseUser,site_ids:['00000000-0000-4000-8000-0000000000ff']};
    const response=await request(app).get(path).set('Cookie','securityops_session=opaque');
    expect(response.status).toBe(403);
  });

  it('returns 404 if the shift belongs to another object',async()=>{
    queryMock.mockImplementation(async(sql:string)=>{
      if(sql.includes('FROM sessions'))return result([activeUser]);
      return result([]);
    });
    const response=await request(app).get(path).set('Cookie','securityops_session=opaque');
    expect(response.status).toBe(404);
  });
});
