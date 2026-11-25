import {describe,expect,it} from '@jest/globals';
import {chronicleLink} from '../src/routes/object-chronicle.js';

const siteId='11111111-1111-4111-8111-111111111111';
const employeeId='22222222-2222-4222-8222-222222222222';

describe('object chronicle links',()=>{
  it('links maintenance, document and personnel events to existing object sections',()=>{
    expect(chronicleLink({
      event_kind:'maintenance_order.completed',entity_type:'maintenance_order',
      entity_id:'33333333-3333-4333-8333-333333333333',site_id:siteId,details:{},
    })).toEqual({target:`/sites/${siteId}/technik`,label:'Wartungsauftrag öffnen',permission:'devices:read'});
    expect(chronicleLink({
      event_kind:'dms.document.approved',entity_type:'dms_document',
      entity_id:'44444444-4444-4444-8444-444444444444',site_id:siteId,details:{},
    })).toEqual({target:`/sites/${siteId}/dokumente`,label:'Dokument öffnen',permission:'dms:read'});
    expect(chronicleLink({
      event_kind:'site.hazard.created',entity_type:'object_hazards',
      entity_id:'66666666-6666-4666-8666-666666666666',site_id:siteId,details:{},
    })).toEqual({target:`/sites/${siteId}/gefaehrdungen`,label:'Gefährdung öffnen',permission:'sites:read'});
    expect(chronicleLink({
      event_kind:'employee.object_assignment.created',entity_type:'employee_object_assignment',
      entity_id:'55555555-5555-4555-8555-555555555555',site_id:siteId,details:{employee_id:employeeId},
    })).toEqual({
      target:`/employees/${employeeId}`,label:'Mitarbeiterprofil öffnen',permission:'employees:read',
      entity_id:'55555555-5555-4555-8555-555555555555',entity_type:'employee_object_assignment',
    });
  });

  it('never invents a link when the event carries no usable target',()=>{
    expect(chronicleLink({event_kind:'site.instruction.created',entity_type:'site_instructions',entity_id:null,site_id:null,details:{}})).toBeNull();
    expect(chronicleLink({event_kind:'unknown.event',entity_type:'unknown',entity_id:'x',site_id:siteId,details:{}})).toBeNull();
    expect(chronicleLink({event_kind:'employee.object_assignment.created',entity_type:'employee_object_assignment',entity_id:'not-a-uuid',site_id:siteId,details:{employee_id:'not-a-uuid'}})).toEqual({target:`/sites/${siteId}/personal`,label:'Personalübersicht öffnen',permission:'employees:read'});
  });
});
