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
const shift='00000000-0000-4000-8000-0000000000b2';
const employee='00000000-0000-4000-8000-000000000001';
const result=(rows:unknown[],rowCount=rows.length)=>({rows,rowCount}) as unknown as QueryResult;

const coverageGrants=['sites:read','employees:read','qualifications:read','scheduling:read']
  .map(code=>({code,scope:'site'}));
const coverageUser={
  id:'00000000-0000-4000-8000-000000000009',tenantId:tenant,email:'admin@example.invalid',role:'admin',
  permissions:coverageGrants.map(grant=>grant.code),permission_grants:coverageGrants,site_ids:[site],
  is_system_admin:false,session_id:'00000000-0000-4000-8000-0000000000ac',csrf_token:'csrf-value',
  expires_at:'2099-01-01',device_id:'00000000-0000-4000-8000-0000000000ad',
};
const dashboardSite={
  id:site,name:'Headquarters',site_number:'S-1',address:'Berlin',alias:null,site_type:'Leitstelle',
  status:'active',security_classification:'critical',object_manager_employee_id:null,object_manager_name:null,
  operations_manager_employee_id:null,operations_manager_name:null,customer_names:null,
  assigned_employee_count:1,active_contract_count:0,expiring_contract_count:0,contract_statuses:[],
  open_hazard_count:0,critical_hazard_count:0,overdue_measure_count:0,
  open_task_count:0,overdue_task_count:0,open_shift_count:1,undercovered_shift_count:0,
  required_staff_count:1,understaffed:false,available_document_count:0,valid_document_count:0,
  unapproved_document_count:0,expired_document_count:0,expiring_7d_document_count:0,
  expiring_30d_document_count:0,review_due_document_count:0,missing_requirement_count:0,
  open_maintenance_count:0,overdue_maintenance_count:0,last_activity:null,
};
const coverageShift={
  id:shift,site_id:site,starts_at:'2027-01-10T08:00:00Z',ends_at:'2027-01-10T16:00:00Z',
  required_qualification_codes:[],profile_parameters:null,
};
const employeeRow={id:employee,name:'Mia Guard',employment_status:'active',hire_date:'2025-01-01',termination_date:null};
const siteAssignment={starts_on:'2025-01-01',ends_on:null};
const validQualification={
  id:'qualification-1',code:'sachkunde_34a',status:'valid',valid_from:'2025-01-01',valid_until:'2027-12-31',
  revoked_at:null,document_id:null,catalog_active:true,required_document_type:null,required_documents:null,
  document_status:null,document_approval_status:null,document_lifecycle_state:null,
  document_valid_from:null,document_valid_until:null,
};

type CoverageResult={
  understaffed:boolean;
  staffing_coverage?:{
    covered:boolean;requirement_count:number;reason_codes:string[];
    eligible_employee_count:number;undercovered_shift_count:number;
  };
};

let activeUser:Record<string,unknown>;
let qualifications:unknown[];
let absences:unknown[];
let requirementRows:unknown[];
let overlapOwnAssignment:boolean;

beforeEach(()=>{
  queryMock.mockReset();
  activeUser=coverageUser;
  qualifications=[validQualification];
  absences=[];
  requirementRows=[{code:'sachkunde_34a'}];
  overlapOwnAssignment=false;
  queryMock.mockImplementation(async(sql:string,values?:unknown[])=>{
    if(sql.includes('FROM sessions'))return result([activeUser]);
    if(sql.includes('SELECT s.id FROM sites s'))return result([{id:site}]);
    if(sql.includes('FROM sites s'))return result([dashboardSite]);
    if(sql.includes('WITH customer_summary AS'))return result([dashboardSite]);
    if(sql.includes('WITH action_source AS'))return result([]);
    if(sql.includes('FROM schedule_shifts sh'))return result([coverageShift]);
    if(sql.includes('FROM schedule_assignments a')&&sql.includes('a.shift_id=$2')){
      return result([{employee_id:employee,employee_name:'Mia Guard',assignment_id:'assignment-1'}]);
    }
    if(sql.includes('a.id<>$5::uuid')){
      // Die eigene Zuordnung wird in der zentralen Prüfung per Parameter ausgeschlossen.
      return result(values?.[4]===null&&overlapOwnAssignment?[{id:'assignment-1'}]:[]);
    }
    if(sql.includes('FROM site_qualification_requirements r'))return result(requirementRows);
    if(sql.includes('FROM employees WHERE'))return result([employeeRow]);
    if(sql.includes('FROM employee_object_assignments\n'))return result([siteAssignment]);
    if(sql.includes('FROM employee_qualifications q'))return result(qualifications);
    if(sql.includes('FROM employee_absences'))return result(absences);
    return result([]);
  });
});

describe('object coverage uses the central staffing verdict',()=>{
  it('marks an object understaffed when the headcount is full but the verdict is ineligible',async()=>{
    qualifications=[{...validQualification,status:'expired',valid_until:'2026-01-01'}];
    // Eine Anforderung darf nicht durch den Join mit Mitarbeitenden mehrfach gezählt werden.
    requirementRows=[{code:'sachkunde_34a'},{code:'sachkunde_34a'},{code:'erste_hilfe'}];

    const response=await request(app).get('/api/v1/sites/overview-dashboard').set('Cookie','securityops_session=opaque');

    expect(response.status).toBe(200);
    const reported=response.body.sites[0] as CoverageResult;
    expect(reported.understaffed).toBe(true);
    expect(response.body.metrics.sites_with_understaffing).toBe(1);
    expect(reported.staffing_coverage).toEqual(expect.objectContaining({
      covered:false,requirement_count:2,eligible_employee_count:0,undercovered_shift_count:1,
      reason_codes:expect.arrayContaining(['qualification_expired','qualification_missing']),
    }));
    const eligibilityCall=queryMock.mock.calls.find(([sql])=>String(sql).includes('FROM employee_qualifications q'));
    expect(eligibilityCall?.[0]).toContain('d.valid_until AS document_valid_until');
  });

  it('keeps an object covered when the central verdict is eligible',async()=>{
    const response=await request(app).get('/api/v1/sites/overview-dashboard').set('Cookie','securityops_session=opaque');

    expect(response.status).toBe(200);
    const reported=response.body.sites[0] as CoverageResult;
    expect(reported.understaffed).toBe(false);
    expect(reported.staffing_coverage).toEqual(expect.objectContaining({
      covered:true,requirement_count:1,eligible_employee_count:1,undercovered_shift_count:0,reason_codes:[],
    }));
  });

  it('exposes requirement-wise verdicts and unmodified reason codes in the object context',async()=>{
    absences=[{id:'absence-1',starts_at:'2027-01-10T07:00:00Z',ends_at:'2027-01-10T17:00:00Z',status:'approved'}];

    const response=await request(app).get(`/api/v1/sites/${site}/object-context`).set('Cookie','securityops_session=opaque');

    expect(response.status).toBe(200);
    const coverage=response.body.staffing_coverage;
    expect(coverage).toEqual(expect.objectContaining({
      site_id:site,requirement_count:1,understaffed:true,reason_codes:['absence_approved'],
    }));
    expect(coverage.requirements).toEqual([expect.objectContaining({
      code:'sachkunde_34a',requirement_count:1,covered:false,reason_codes:[],
    })]);
    expect(coverage.shifts[0].employees[0]).toEqual(expect.objectContaining({
      employee_id:employee,status:'ineligible',reason_codes:['absence_approved'],
      matched_qualification_codes:['sachkunde_34a'],
    }));
    expect(coverage.shifts[0].employees[0].reasons[0]).toMatchObject({
      code:'absence_approved',link:{type:'absence',id:'absence-1'},
    });
  });

  it('does not treat the employee\'s own assignment as an overlapping shift',async()=>{
    overlapOwnAssignment=true;

    const response=await request(app).get(`/api/v1/sites/${site}/object-context`).set('Cookie','securityops_session=opaque');

    expect(response.status).toBe(200);
    const coverage=response.body.staffing_coverage;
    expect(coverage.covered).toBe(true);
    expect(coverage.reason_codes).toEqual([]);
    expect(coverage.shifts[0].employees[0].status).toBe('eligible');
    const overlapCall=queryMock.mock.calls.find(([sql])=>String(sql).includes('a.id<>$5::uuid'));
    expect(overlapCall?.[1]?.[4]).toBe('assignment-1');
  });

  it('does not load eligibility data without the required site-scoped permissions',async()=>{
    activeUser={
      ...coverageUser,
      permissions:['sites:read','employees:read','scheduling:read'],
      permission_grants:coverageGrants.filter(grant=>grant.code!=='qualifications:read'),
    };
    const response=await request(app).get('/api/v1/sites/overview-dashboard').set('Cookie','securityops_session=opaque');

    expect(response.status).toBe(200);
    expect(response.body.sites[0].understaffed).toBe(false);
    expect(response.body.sites[0].staffing_coverage).toBeUndefined();
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('FROM site_qualification_requirements r'))).toBe(false);
    expect(queryMock.mock.calls.some(([sql])=>String(sql).includes('d.valid_until AS document_valid_until'))).toBe(false);
  });
});
