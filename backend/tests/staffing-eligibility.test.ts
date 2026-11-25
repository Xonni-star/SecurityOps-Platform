import {describe,expect,it} from '@jest/globals';
import {evaluateShiftEligibility,type EligibilityInput} from '../src/services/staffing-eligibility.js';

const shift={starts_at:'2026-12-01T08:00:00Z',ends_at:'2026-12-01T16:00:00Z',required_qualification_codes:['sachkunde_34a']};
const base:EligibilityInput={
  employee:{id:'00000000-0000-4000-8000-000000000001',name:'Mia Guard',employment_status:'active',
    assignment:{starts_on:'2026-01-01',ends_on:null}},
  shift,
  qualifications:[{id:'00000000-0000-4000-8000-000000000002',code:'sachkunde_34a',status:'valid',valid_from:'2025-01-01',valid_until:'2027-01-01',revoked_at:null,document_id:'00000000-0000-4000-8000-000000000003',catalog_active:true}],
  instructions:[],absences:[],availability:[],overlapping_shift:false,
};

describe('server-side shift eligibility',()=>{
  it('marks a fully qualified employee as eligible',()=>{
    expect(evaluateShiftEligibility(base)).toMatchObject({status:'eligible',matched_qualification_codes:['sachkunde_34a']});
  });

  it('rejects terminated employees, missing site assignment and overlapping shifts',()=>{
    const result=evaluateShiftEligibility({...base,employee:{...base.employee,employment_status:'terminated',assignment:null},overlapping_shift:true,qualifications:[]});
    expect(result.status).toBe('ineligible');
    expect(result.reasons.map(reason=>reason.code)).toEqual(expect.arrayContaining(['employment_status','site_assignment','qualification_missing','overlapping_shift']));
    expect(result.reasons.find(reason=>reason.code==='employment_status')?.link).toEqual({type:'employee',id:base.employee.id,label:'Mia Guard'});
  });

  it('rejects revoked and expired evidence at the time of deployment and links the document',()=>{
    const revoked=evaluateShiftEligibility({...base,qualifications:[{...base.qualifications[0],status:'revoked',revoked_at:'2026-11-01T00:00:00Z'}]});
    expect(revoked.status).toBe('ineligible');
    expect(revoked.reasons[0]).toMatchObject({code:'qualification_revoked',link:{type:'qualification',id:base.qualifications[0].document_id}});
    const expired=evaluateShiftEligibility({...base,qualifications:[{...base.qualifications[0],status:'expired',valid_until:'2026-11-30'}]});
    expect(expired.status).toBe('ineligible');
    expect(expired.reasons[0].code).toBe('qualification_expired');
  });

  it('requires instructions to be acknowledged in their current approved version',()=>{
    const result=evaluateShiftEligibility({...base,instructions:[{
      id:'00000000-0000-4000-8000-000000000004',title:'Einsatzunterweisung',status:'approved',requires_acknowledgement:true,
      version:3,valid_from:'2026-01-01',valid_until:null,acknowledged_version:2,
    }]});
    expect(result.status).toBe('ineligible');
    expect(result.reasons[0]).toMatchObject({code:'instruction_acknowledgement',link:{type:'instruction',id:'00000000-0000-4000-8000-000000000004'}});
    expect(evaluateShiftEligibility({...base,instructions:[{
      id:'instruction-1',title:'Einsatzunterweisung',status:'approved',requires_acknowledgement:true,
      version:3,valid_from:'2026-01-01',valid_until:null,acknowledged_version:3,
    }]}).status).toBe('eligible');
  });

  it('restricts requested absences and probation but blocks approved absences and availability exclusions',()=>{
    expect(evaluateShiftEligibility({...base,employee:{...base.employee,employment_status:'probation'},
      absences:[{id:'absence-1',starts_at:'2026-12-01T07:00:00Z',ends_at:'2026-12-01T09:00:00Z',status:'requested'}],
    })).toMatchObject({status:'restricted'});
    expect(evaluateShiftEligibility({...base,absences:[{id:'absence-2',starts_at:'2026-12-01T07:00:00Z',ends_at:'2026-12-01T09:00:00Z',status:'approved'}]}).status).toBe('ineligible');
    expect(evaluateShiftEligibility({...base,availability:[{weekday:2,starts_time:'12:00',ends_time:'18:00',available:false,valid_from:null,valid_until:null}]}).status).toBe('ineligible');
  });
});
