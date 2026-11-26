import {describe,expect,it,jest} from '@jest/globals';
import type {QueryResult} from 'pg';

const queryMock=jest.fn();
jest.unstable_mockModule('../src/db/pool.js',()=>({
  query:queryMock,
  withTransaction:async (work:(client:unknown)=>Promise<unknown>)=>work({query:queryMock}),
  withLoginContext:async (_value:string,work:()=>Promise<unknown>)=>work(),
  withSessionContext:async (_value:string,work:()=>Promise<unknown>)=>work(),
  withTenantContext:async (_value:string,work:()=>Promise<unknown>)=>work(),
}));
const {chronicleLink,resolveChronicleLinks}=await import('../src/routes/object-chronicle.js');

const siteId='11111111-1111-4111-8111-111111111111';
const tenant='11111111-1111-4111-8111-11111111110a';
const employeeId='22222222-2222-4222-8222-222222222222';
const recordId='33333333-3333-4333-8333-333333333333';
const allowAll=async()=>true;
const result=(rows:unknown[])=>({rows,rowCount:rows.length}) as unknown as QueryResult;

describe('object chronicle record links',()=>{
  it('links every supported type to the concrete record in the existing module section',()=>{
    const cases:Array<{entity_type:string;target:string;label:string;permission:string}>=[
      {entity_type:'maintenance_order',target:`/sites/${siteId}/technik?maintenance_order=${recordId}`,label:'Wartungsauftrag öffnen',permission:'devices:read'},
      {entity_type:'devices',target:`/sites/${siteId}/technik?device=${recordId}`,label:'Gerät öffnen',permission:'devices:read'},
      {entity_type:'dms_document',target:`/sites/${siteId}/dokumente?document=${recordId}`,label:'Dokument öffnen',permission:'dms:read'},
      {entity_type:'dms_document_requirement',target:`/sites/${siteId}/dokumente?requirement=${recordId}`,label:'Pflichtdokument öffnen',permission:'dms:read'},
      {entity_type:'object_location',target:`/sites/${siteId}/struktur?location=${recordId}`,label:'Bereich öffnen',permission:'sites:read'},
      {entity_type:'object_hazards',target:`/sites/${siteId}/gefaehrdungen?hazard=${recordId}`,label:'Gefährdung öffnen',permission:'sites:read'},
      {entity_type:'object_hazard_measure',target:`/sites/${siteId}/gefaehrdungen?measure=${recordId}`,label:'Maßnahme öffnen',permission:'sites:read'},
      {entity_type:'site_instruction',target:`/sites/${siteId}/anweisungen?instruction=${recordId}`,label:'Dienstanweisung öffnen',permission:'watchbook:read'},
      {entity_type:'employee_object_assignment',target:`/sites/${siteId}/personal?assignment=${recordId}`,label:'Personalzuordnung öffnen',permission:'employees:read'},
      {entity_type:'key',target:`/sites/${siteId}/schluessel?key=${recordId}`,label:'Schlüssel öffnen',permission:'keys:read'},
      {entity_type:'key_bundle',target:`/sites/${siteId}/schluessel?key_bundle=${recordId}`,label:'Schlüsselbund öffnen',permission:'keys:read'},
      {entity_type:'schedule_period',target:`/sites/${siteId}/dienstplanung?period=${recordId}`,label:'Dienstplan öffnen',permission:'scheduling:read'},
      {entity_type:'schedule_shift',target:`/sites/${siteId}/dienstplanung?shift=${recordId}`,label:'Schicht öffnen',permission:'scheduling:read'},
      {entity_type:'schedule_assignment',target:`/sites/${siteId}/dienstplanung?shift_assignment=${recordId}`,label:'Schichtzuweisung öffnen',permission:'scheduling:read'},
      {entity_type:'watchbook_entry',target:`/sites/${siteId}/journal?entry=${recordId}`,label:'Wachbucheintrag öffnen',permission:'watchbook:read'},
      {entity_type:'alarm',target:`/sites/${siteId}/vorfaelle?alarm=${recordId}`,label:'Alarm öffnen',permission:'alarms:read'},
      {entity_type:'incident',target:`/sites/${siteId}/vorfaelle?incident=${recordId}`,label:'Vorfall öffnen',permission:'incidents:read'},
      {entity_type:'handover',target:`/sites/${siteId}/uebersicht?handover=${recordId}`,label:'Übergabe öffnen',permission:'handover:read'},
      {entity_type:'customer_task',target:`/sites/${siteId}/aufgaben?task=${recordId}`,label:'Aufgabe öffnen',permission:'customers:read'},
    ];
    for(const item of cases){
      expect(chronicleLink({event_kind:'test.event',entity_type:item.entity_type,entity_id:recordId,site_id:siteId,details:{}})).toMatchObject({
        target:item.target,label:item.label,permission:item.permission,
        entity_id:recordId,entity_type:item.entity_type,record_id:recordId,
      });
    }
  });

  it('opens the exact qualification and its linked evidence document',()=>{
    expect(chronicleLink({
      event_kind:'qualification.employee.updated',entity_type:'qualification',entity_id:recordId,site_id:siteId,
      details:{employee_id:employeeId,document_id:'44444444-4444-4444-8444-444444444444'},
    })).toMatchObject({
      target:`/employees/${employeeId}/qualifikationen?qualification=${recordId}&document=44444444-4444-4444-8444-444444444444`,
      label:'Qualifikationsnachweis öffnen',permission:'qualifications:read',
      entity_id:recordId,entity_type:'qualification',record_id:recordId,
      verification_type:'qualification',
    });
    expect(chronicleLink({
      event_kind:'employee.object_assignment.created',entity_type:'employee_object_assignment',
      entity_id:recordId,site_id:siteId,details:{employee_id:employeeId},
    })).toEqual(expect.objectContaining({target:`/sites/${siteId}/personal?assignment=${recordId}`}));
    expect(chronicleLink({
      event_kind:'customer.site.linked',entity_type:'customer_site',entity_id:recordId,site_id:siteId,
      details:{customer_id:'55555555-5555-4555-8555-555555555555'},
    })).toEqual(expect.objectContaining({target:'/customers/55555555-5555-4555-8555-555555555555?site='+siteId,verification_type:'customer'}));
    expect(chronicleLink({
      event_kind:'site.instruction.acknowledged',entity_type:'instruction_acknowledgements',entity_id:recordId,site_id:siteId,
      details:{employee_id:employeeId,version:1},
    })).toEqual(expect.objectContaining({target:`/sites/${siteId}/anweisungen?instruction=${recordId}`,verification_type:'site_instruction'}));
  });

  it('never invents a record link when the event carries no usable target',()=>{
    expect(chronicleLink({event_kind:'site.instruction.created',entity_type:'site_instructions',entity_id:null,site_id:null,details:{}})).toBeNull();
    expect(chronicleLink({event_kind:'unknown.event',entity_type:'unknown',entity_id:'x',site_id:siteId,details:{}})).toBeNull();
    expect(chronicleLink({event_kind:'employee.object_assignment.created',entity_type:'employee_object_assignment',entity_id:'not-a-uuid',site_id:siteId,details:{employee_id:'not-a-uuid'}}))
      .toEqual({target:`/sites/${siteId}/personal`,label:'Personalzuordnung öffnen',permission:'employees:read'});
  });

  it('returns nothing when the user lacks the module permission',async()=>{
    queryMock.mockReset();
    queryMock.mockResolvedValueOnce(result([{type:'maintenance_order',id:recordId}]));
    const links=await resolveChronicleLinks([
      {event_kind:'maintenance_order.created',entity_type:'maintenance_order',entity_id:recordId,site_id:siteId,details:{}},
    ],tenant,siteId,async permission=>permission!=='devices:read');
    expect(links).toEqual([null]);
  });

  it('falls back to the module section when the record no longer exists',async()=>{
    queryMock.mockReset();
    queryMock.mockResolvedValueOnce(result([]));
    const links=await resolveChronicleLinks([
      {event_kind:'maintenance_order.created',entity_type:'maintenance_order',entity_id:recordId,site_id:siteId,details:{}},
    ],tenant,siteId,allowAll);
    expect(links[0]).toMatchObject({
      target:`/sites/${siteId}/technik`,label:'Wartungsauftrag öffnen (Datensatz nicht mehr verfügbar)',
      permission:'devices:read',entity_id:recordId,entity_type:'maintenance_order',record_id:recordId,record_available:false,
    });
  });

  it('verifies every candidate in tenant scope before exposing a direct link',async()=>{
    queryMock.mockReset();
    queryMock.mockResolvedValueOnce(result([{type:'object_hazard',id:recordId}]));
    const links=await resolveChronicleLinks([
      {event_kind:'site.hazard.created',entity_type:'object_hazard',entity_id:recordId,site_id:siteId,details:{}},
    ],tenant,siteId,allowAll);
    expect(links[0]?.target).toBe(`/sites/${siteId}/gefaehrdungen?hazard=${recordId}`);
    expect(links[0]?.record_available).toBeUndefined();
    const [sql,params]=queryMock.mock.calls[0] as unknown as [string,unknown[]];
    expect(sql).toContain('FROM object_hazards');
    expect(sql).toContain('tenant_id=$1');
    expect(sql).toContain('site_id=$2');
    expect(params[0]).toBe(tenant);
    expect(params[1]).toBe(siteId);
    expect(params).toHaveLength(3);
    expect(params[2]).toBe(recordId);
  });

  it('keeps section-level links for events without a concrete record id',()=>{
    expect(chronicleLink({event_kind:'maintenance_order.completed',entity_type:'maintenance_order',entity_id:null,site_id:siteId,details:{}})).toEqual({
      target:`/sites/${siteId}/technik`,label:'Wartungsauftrag öffnen',permission:'devices:read',
    });
    expect(chronicleLink({event_kind:'dms.document.approved',entity_type:'dms_document',entity_id:null,site_id:siteId,details:{}})).toEqual({
      target:`/sites/${siteId}/dokumente`,label:'Dokument öffnen',permission:'dms:read',
    });
    expect(chronicleLink({event_kind:'site.hazard.created',entity_type:'object_hazards',entity_id:null,site_id:siteId,details:{}})).toEqual({
      target:`/sites/${siteId}/gefaehrdungen`,label:'Gefährdung öffnen',permission:'sites:read',
    });
  });

  it('never resolves a record id from another tenant as available',async()=>{
    queryMock.mockReset();
    queryMock.mockImplementation(async(sql:string,values:unknown[])=>{
      expect(String(sql)).toContain('tenant_id=$1');
      expect(values[0]).toBe(tenant);
      return result([]);
    });
    const links=await resolveChronicleLinks([
      {event_kind:'qualification.employee.updated',entity_type:'employee_qualification',entity_id:recordId,site_id:siteId,
        details:{employee_id:employeeId}},
    ],tenant,siteId,allowAll);
    expect(links[0]?.record_available).toBe(false);
    expect(links[0]?.target).toBe(`/employees/${employeeId}/qualifikationen`);
  });

  it('removes a missing evidence document without breaking the qualification link',async()=>{
    queryMock.mockReset();
    queryMock.mockResolvedValueOnce(result([{type:'qualification',id:recordId}]));
    const links=await resolveChronicleLinks([
      {event_kind:'qualification.employee.updated',entity_type:'qualification',entity_id:recordId,site_id:siteId,
        details:{employee_id:employeeId,document_id:'44444444-4444-4444-8444-444444444444'}},
    ],tenant,siteId,allowAll);
    expect(links[0]).toMatchObject({
      target:`/employees/${employeeId}/qualifikationen?qualification=${recordId}`,
      evidence_id:null,
    });
  });
});
