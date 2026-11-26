/** @vitest-environment jsdom */
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {MemoryRouter,Route,Routes} from 'react-router-dom';

const apiMock=vi.hoisted(()=>vi.fn());
const permissionMock=vi.hoisted(()=>vi.fn());
const fetchMock=vi.hoisted(()=>vi.fn());
vi.mock('../src/lib/api',()=>({
  api:apiMock,
  hasPermission:(code:string)=>permissionMock(code),
  csrf:()=>'csrf-token',
}));
import {Customers} from '../src/pages/Customers';
import {CustomerDetail} from '../src/pages/CustomerDetail';

const customerId='00000000-0000-4000-8000-000000000001';
const otherId='00000000-0000-4000-8000-000000000002';
const managerId='00000000-0000-4000-8000-000000000003';
const contractId='00000000-0000-4000-8000-000000000004';

const rows=[
  {id:customerId,name:'Nordlicht GmbH',email:'kontakt@nordlicht.example',customer_number:'K-100',customer_status:'active',priority:'high',risk_classification:'low',city:'Hamburg',postal_code:'20095',phone:'040 123456',active_sites:2,active_contracts:1,active_contacts:3,expiring_contracts:0,account_manager_name:'Ava Manager',account_manager_employee_id:managerId,next_contract_deadline:'2026-12-01',last_activity:'2026-11-20',open_tasks:2,overdue_tasks:1},
  {id:otherId,name:'Hafenwacht AG',email:'office@hafenwacht.example',customer_number:'K-200',customer_status:'at_risk',priority:'normal',risk_classification:'high',city:'Bremen',postal_code:'28195',phone:null,active_sites:1,active_contracts:2,active_contacts:1,expiring_contracts:1,account_manager_name:null,account_manager_employee_id:null,next_contract_deadline:null,last_activity:null,open_tasks:0,overdue_tasks:0},
];
const dashboard={
  total:2,active:1,pipeline:0,at_risk:1,archived:0,paused:0,new_30d:1,incomplete_master_data:1,linked_customers:2,
  active_object_links:3,contracts:{total:3,active:2},contracts_expiring_90_days:1,open_tasks:2,overdue_tasks:1,
  reminders:[{id:`${contractId}:notice_reached`,code:'notice_reached',label:'Kündigungsfrist erreicht',severity:'critical' as const,customer_id:customerId,customer_name:'Nordlicht GmbH',contract_id:contractId,contract_number:'K-77',due_date:'2026-12-01',url:`/customers/${customerId}/vertraege?contract=${contractId}`}],
};
const actionList={
  A:[{id:`task_overdue:${customerId}`,bucket:'A' as const,code:'task_overdue',label:'Überfällige Aufgabe: Vertrag prüfen',customer_id:customerId,customer_name:'Nordlicht GmbH',subject_type:'task',subject_id:'00000000-0000-4000-8000-000000000005',due_at:'2026-11-01T00:00:00.000Z'}],
  B:[{id:`contract_expiry_30:${contractId}`,bucket:'B' as const,code:'contract_expiry_30',label:'Vertragsfrist K-77 in 30 Tagen',customer_id:customerId,customer_name:'Nordlicht GmbH',subject_type:'contract',subject_id:contractId,due_at:'2026-12-01'}],
  C:[{id:`no_recent_activity:${otherId}`,bucket:'C' as const,code:'no_recent_activity',label:'Keine aktuelle Aktivität',customer_id:otherId,customer_name:'Hafenwacht AG',subject_type:'verlauf',subject_id:null,due_at:null}],
  generated_at:'2026-11-26T00:00:00.000Z',
};
const baseCustomer={id:customerId,name:'Nordlicht GmbH',email:null,customer_number:'K-100',legal_form:null,industry:'Security',customer_status:'active',priority:'high',risk_classification:'low',started_on:null,ended_on:null,account_manager_employee_id:managerId,internal_notes:null,phone:null,website:null,billing_email:null,address_line1:null,address_line2:null,postal_code:null,city:'Hamburg',region:null,country_code:'DE',billing_address:null,communication_preferences:null,account_manager_name:'Ava Manager'};
const visibleAll={contacts:true,sites:true,contracts:true,documents:true,tasks:true,history:true};
const profileFixture=()=>({
  customer:baseCustomer,
  contacts:[{id:'contact-1',first_name:'Erika',last_name:'Kontakt',job_title:'Leitung',department:null,email:'erika@example.test',phone:null,mobile_phone:null,preferred_contact_method:'email',notes:null,status:'active',is_primary:true,is_decision_maker:true,is_security_contact:true,is_billing_contact:true,is_emergency_contact:true,sites:[]}],
  sites:[],
  contracts:[{id:contractId,contract_number:'K-77',contract_type:'Objektschutz',scope:null,starts_on:'2026-01-01',ends_on:'2026-12-01',renewal_type:'automatic',notice_period_days:30,next_termination_date:null,status:'active',total_value:null,monthly_value:null,billing_model:'fixed',sla:null,internal_notes:null,sites:[],services:[]}],
  documents:[],
  tasks:[{id:'task-1',title:'Vertrag prüfen',description:'Frist prüfen',due_at:'2026-12-01T00:00:00.000Z',status:'open',priority:'high',assigned_employee_id:null,assigned_employee_name:null}],
  history:[],
  operations:{assigned_employees:4,upcoming_shifts:2,open_incidents:1},
  reminders:dashboard.reminders,
  visible_sections:visibleAll,
});

let listTotal=2;
let listPages=1;
const response=(body:unknown,headers:Record<string,string>={})=>({
  ok:true,status:200,
  headers:{get:(name:string)=>headers[name]??headers[name.toLowerCase()]??null},
  json:async()=>body,
  blob:async()=>new Blob(['Kundennummer;Firma'],{type:'text/csv'}),
  text:async()=>JSON.stringify(body),
});
const defaultApi=async(path:string)=>{
  if(path==='/customers/dashboard')return dashboard;
  if(path==='/customers/action-list')return actionList;
  if(path==='/employees')return [{id:managerId,name:'Ava Manager'},{id:'00000000-0000-4000-8000-000000000006',name:'Ben Betreuer'}];
  if(path==='/sites'||path==='/services')return [];
  if(path===`/customers/${customerId}/profile`)return profileFixture();
  return [];
};

const renderCustomers=()=>render(<MemoryRouter initialEntries={['/customers']}><Routes>
  <Route path="/customers" element={<Customers/>}/>
  <Route path="/customers/:customerId" element={<p>Kundenakte geöffnet</p>}/>
</Routes></MemoryRouter>);
const renderDetail=(section='uebersicht',profile=profileFixture())=>{
  apiMock.mockImplementation(async(path:string)=>path===`/customers/${customerId}/profile`?profile:defaultApi(path));
  return render(<MemoryRouter initialEntries={[`/customers/${customerId}/${section}`]}><Routes>
    <Route path="/customers/:customerId/:section" element={<CustomerDetail/>}/>
  </Routes></MemoryRouter>);
};
const lastListUrl=()=>String([...fetchMock.mock.calls].reverse().find(([input])=>String(input).startsWith('/api/v1/customers?'))?.[0]??'');
const queryOf=(url:string)=>new URLSearchParams(url.split('?')[1]??'');

beforeEach(()=>{
  cleanup();
  apiMock.mockReset();permissionMock.mockReset();fetchMock.mockReset();
  permissionMock.mockReturnValue(true);
  listTotal=2;listPages=1;
  apiMock.mockImplementation(defaultApi);
  fetchMock.mockImplementation(async(input:string)=>{
    const url=String(input);
    if(url.startsWith('/api/v1/customers/export'))return response([],{'Content-Disposition':'attachment; filename="kunden.csv"'});
    if(url.startsWith('/api/v1/customers?'))return response(rows,{
      'X-Total-Count':String(listTotal),'X-Page':'1','X-Page-Size':'10','X-Page-Count':String(listPages),
    });
    return response([]);
  });
  vi.stubGlobal('fetch',fetchMock);
  vi.stubGlobal('confirm',vi.fn(()=>true));
  Object.defineProperty(URL,'createObjectURL',{configurable:true,value:vi.fn(()=>'blob:test')});
  Object.defineProperty(URL,'revokeObjectURL',{configurable:true,value:vi.fn()});
});

describe('customer overview',()=>{
  it('loads the table from the server with combinable filters, sorting and pagination',async()=>{
    listTotal=25;listPages=3;
    renderCustomers();
    expect(await screen.findAllByText('Nordlicht GmbH')).toBeTruthy();
    expect(screen.getByText('Aktive Objektbeziehungen')).toBeTruthy();
    for(const heading of ['Kundennummer','Firma','Status','Priorität','Risiko','Betreuer','Aktive Objekte','Aktive Verträge','Nächste Vertragsfrist','Letzte Aktivität','Offene Aufgaben'])expect(screen.getByRole('columnheader',{name:heading})).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText(/Kunde, Nummer/),{target:{value:'Nordlicht'}});
    fireEvent.change(screen.getByLabelText('Kundenstatus'),{target:{value:'active'}});
    fireEvent.change(screen.getByLabelText('Risikoklasse'),{target:{value:'low'}});
    fireEvent.change(screen.getByLabelText('Priorität'),{target:{value:'high'}});
    fireEvent.change(screen.getByLabelText('Betreuer'),{target:{value:managerId}});
    fireEvent.change(screen.getByLabelText('Vertragsstatus'),{target:{value:'active'}});
    fireEvent.change(screen.getByLabelText('Aktivitätsstatus'),{target:{value:'true'}});
    fireEvent.click(screen.getByRole('button',{name:'Letzte Aktivität'}));
    await waitFor(()=>{
      const params=queryOf(lastListUrl());
      expect(params.get('q')).toBe('Nordlicht');
      expect(params.get('customer_status')).toBe('active');
      expect(params.get('risk_classification')).toBe('low');
      expect(params.get('priority')).toBe('high');
      expect(params.get('account_manager_employee_id')).toBe(managerId);
      expect(params.get('contract_status')).toBe('active');
      expect(params.get('active')).toBe('true');
      expect(params.get('sort')).toBe('last_activity');
      expect(params.get('dir')).toBe('asc');
      expect(params.get('page')).toBe('1');
      expect(params.get('pageSize')).toBe('10');
    });
    fireEvent.click(screen.getByRole('button',{name:'Weiter'}));
    await waitFor(()=>expect(queryOf(lastListUrl()).get('page')).toBe('2'));
    expect(screen.getByText(/25 Kunden · Seite 2 von 3/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'Filter zurücksetzen'}));
    await waitFor(()=>{
      const params=queryOf(lastListUrl());
      expect(params.has('q')).toBe(false);
      expect(params.get('sort')).toBe('name');
    });
  });

  it('renders the A/B/C action list and dashboard reminders with deep links',async()=>{
    renderCustomers();
    expect(await screen.findByRole('heading',{name:'Handlungsübersicht'})).toBeTruthy();
    expect(screen.getByText('Überfällige Aufgabe: Vertrag prüfen')).toBeTruthy();
    expect(screen.getByText('Keine aktuelle Aktivität')).toBeTruthy();
    expect(screen.getByText('Kündigungsfrist erreicht')).toBeTruthy();
    expect(screen.getByRole('link',{name:/Kündigungsfrist erreicht/}).getAttribute('href')).toBe(`/customers/${customerId}/vertraege?contract=${contractId}`);
    expect(screen.getByRole('link',{name:/Vertragsfrist K-77/}).getAttribute('href')).toBe(`/customers/${customerId}/vertraege?contract=${contractId}`);
    expect(screen.getByRole('link',{name:/Überfällige Aufgabe/}).getAttribute('href')).toBe(`/customers/${customerId}/aufgaben`);
    expect(screen.getByRole('link',{name:/Keine aktuelle Aktivität/}).getAttribute('href')).toBe(`/customers/${otherId}/verlauf`);
  });

  it('exports selected customers and applies bulk actions through the dedicated endpoints',async()=>{
    renderCustomers();
    const selectRow=async()=>{
      const checkbox=await screen.findByLabelText('Nordlicht GmbH auswählen') as HTMLInputElement;
      if(!checkbox.checked)fireEvent.click(checkbox);
    };
    const lastBulkBody=()=>{
      const calls=apiMock.mock.calls.filter(([path,options])=>path==='/customers/bulk'&&options?.method==='POST');
      return JSON.parse(String(calls[calls.length-1]?.[1]?.body));
    };

    await selectRow();
    fireEvent.click(screen.getByRole('button',{name:/CSV exportieren \(1\)/}));
    await waitFor(()=>{
      const url=String([...fetchMock.mock.calls].reverse().find(([input])=>String(input).includes('/customers/export'))?.[0]??'');
      expect(url).toContain(`ids=${customerId}`);
      expect(url).toContain('pageSize=10');
    });
    await selectRow();
    fireEvent.change(screen.getByLabelText('Status der Auswahl setzen'),{target:{value:'paused'}});
    await waitFor(()=>expect(lastBulkBody()).toEqual({ids:[customerId],action:'set_status',value:'paused'}));
    await selectRow();
    fireEvent.change(screen.getByLabelText('Betreuer der Auswahl setzen'),{target:{value:managerId}});
    await waitFor(()=>expect(lastBulkBody()).toEqual({ids:[customerId],action:'set_manager',value:managerId}));
    await selectRow();
    fireEvent.click(screen.getByRole('button',{name:/Auswahl archivieren/}));
    await waitFor(()=>expect(lastBulkBody()).toEqual({ids:[customerId],action:'archive'}));
  });

  it('creates a customer using the customer API and opens its record',async()=>{
    const newCustomer={...rows[0],id:'00000000-0000-4000-8000-000000000009',name:'Weser Schutz GmbH'};
    apiMock.mockImplementation(async(path:string,options?:RequestInit)=>{
      if(path==='/customers'&&options?.method==='POST')return newCustomer;
      return defaultApi(path);
    });
    renderCustomers();
    fireEvent.click(await screen.findByRole('button',{name:/Kunde anlegen/}));
    fireEvent.change(screen.getByLabelText('Unternehmen'),{target:{value:'Weser Schutz GmbH'}});
    fireEvent.click(screen.getAllByRole('button',{name:/Kunde anlegen/})[1]);
    expect(await screen.findByText('Kundenakte geöffnet')).toBeTruthy();
    expect(apiMock).toHaveBeenCalledWith('/customers',expect.objectContaining({method:'POST'}));
  });
});

describe('customer detail',()=>{
  it('saves only editable customer fields from the profile form',async()=>{
    renderDetail('stammdaten');
    const name=await screen.findByLabelText('Unternehmen');
    fireEvent.change(name,{target:{value:'Nordlicht Sicherheitsdienst GmbH'}});
    fireEvent.click(screen.getByRole('button',{name:'Stammdaten speichern'}));
    await waitFor(()=>{
      const request=apiMock.mock.calls.find(([path,options])=>path===`/customers/${customerId}`&&options?.method==='PATCH');
      expect(request).toBeTruthy();
      const body=JSON.parse(String(request?.[1]?.body));
      expect(body.name).toBe('Nordlicht Sicherheitsdienst GmbH');
      expect(body).not.toHaveProperty('id');
      expect(body).not.toHaveProperty('account_manager_name');
    });
  });

  it('gates sections by visible_sections and keeps overview operations data visible',async()=>{
    const profile={...profileFixture(),visible_sections:{contacts:false,sites:false,contracts:false,documents:false,tasks:false,history:false}};
    renderDetail('ansprechpartner',profile);
    expect(await screen.findByText('Keine Berechtigung für Ansprechpartner.')).toBeTruthy();
    expect(screen.queryByText('Erika Kontakt')).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'Verträge & Leistungen'}));
    expect(await screen.findByText('Keine Berechtigung für Verträge.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'Dokumente'}));
    expect(await screen.findByText('Keine Berechtigung für Dokumente.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'Aufgaben'}));
    expect(await screen.findByText('Keine Berechtigung für Aufgaben.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'Verlauf'}));
    expect(await screen.findByText('Keine Berechtigung für Verlauf.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'Übersicht'}));
    expect(screen.queryByText('Aktive Verträge')).toBeNull();
    expect(document.querySelector('.employee-detail-kpis')?.textContent).not.toContain('Ansprechpartner');
    expect(document.querySelector('.employee-detail-kpis')?.textContent).not.toContain('Offene Aufgaben');
    expect(screen.getByText('Zugeordnetes Personal')).toBeTruthy();
    expect(screen.getByText('Offene Einsätze')).toBeTruthy();
  });

  it('shows derived reminders on the overview and in the contract section',async()=>{
    renderDetail();
    expect(await screen.findByText('Kündigungsfrist erreicht')).toBeTruthy();
    expect(screen.getByText('Kritisch')).toBeTruthy();
    expect(screen.getByRole('link',{name:/Kündigungsfrist erreicht/}).getAttribute('href')).toBe(`/customers/${customerId}/vertraege?contract=${contractId}`);
    fireEvent.click(screen.getByRole('button',{name:'Verträge & Leistungen'}));
    expect(await screen.findByRole('link',{name:/Kündigungsfrist erreicht/})).toBeTruthy();
  });

  it('shows all contact roles and keeps a single primary contact in the UI',async()=>{
    const profile=profileFixture();
    profile.contacts=[{...profile.contacts[0],id:'contact-1',first_name:'Erika',last_name:'Kontakt',is_primary:true},
      {...profile.contacts[0],id:'contact-2',first_name:'Ben',last_name:'Kontakt',is_primary:false}];
    let currentProfile=profile;
    apiMock.mockImplementation(async(path:string,options?:RequestInit)=>{
      if(path===`/customers/${customerId}/contacts/contact-2`&&options?.method==='PATCH'){
        currentProfile={...currentProfile,contacts:currentProfile.contacts.map(contact=>({...contact,is_primary:contact.id==='contact-2'}))};
        return {};
      }
      return path===`/customers/${customerId}/profile`?currentProfile:defaultApi(path);
    });
    render(<MemoryRouter initialEntries={[`/customers/${customerId}/ansprechpartner`]}><Routes>
      <Route path="/customers/:customerId/:section" element={<CustomerDetail/>}/>
    </Routes></MemoryRouter>);
    expect(await screen.findByText(/Rollen: Hauptansprechpartner · Entscheider · Sicherheitskontakt · Rechnungskontakt · Notfallkontakt/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'Als Hauptansprechpartner setzen'}));
    await waitFor(()=>expect(document.querySelectorAll('.customer-primary')).toHaveLength(1));
    expect(document.querySelector('.customer-primary')?.parentElement?.querySelector('strong')?.textContent).toBe('Ben Kontakt');
    await waitFor(()=>{
      const call=apiMock.mock.calls.find(([path,options])=>path===`/customers/${customerId}/contacts/contact-2`&&options?.method==='PATCH');
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({is_primary:true});
    });
  });

  it('only shows task write controls with customer_tasks:write',async()=>{
    permissionMock.mockImplementation((code:string)=>code!=='customer_tasks:write');
    renderDetail('aufgaben');
    expect(await screen.findByText(/Priorität: Hoch/)).toBeTruthy();
    expect(screen.queryByRole('button',{name:'Aufgabe anlegen'})).toBeNull();
    expect(screen.queryByRole('button',{name:'Erledigt'})).toBeNull();
    expect(screen.queryByRole('button',{name:'Bearbeiten'})).toBeNull();
  });

  it('shows task priority and sends priority on create and full task PATCH',async()=>{
    renderDetail('aufgaben');
    expect(await screen.findByText(/Priorität: Hoch/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'Bearbeiten'}));
    const editForm=screen.getByRole('button',{name:'Aufgabe speichern'}).closest('form')!;
    fireEvent.change(editForm.querySelector('input')!,{target:{value:'Vertrag final prüfen'}});
    fireEvent.change(screen.getAllByLabelText('Priorität')[1],{target:{value:'critical'}});
    fireEvent.change(screen.getByLabelText('Status'),{target:{value:'completed'}});
    fireEvent.click(screen.getByRole('button',{name:'Aufgabe speichern'}));
    await waitFor(()=>{
      const call=apiMock.mock.calls.find(([path,options])=>path===`/customers/${customerId}/tasks/task-1`&&options?.method==='PATCH');
      expect(call).toBeTruthy();
      const body=JSON.parse(String(call?.[1]?.body));
      expect(body).toEqual({title:'Vertrag final prüfen',description:'Frist prüfen',due_at:'2026-12-01T00:00:00.000Z',assigned_employee_id:null,priority:'critical',status:'completed'});
    });
    fireEvent.change(screen.getByLabelText('Aufgabe / Wiedervorlage'),{target:{value:'Neue Wiedervorlage'}});
    fireEvent.change(screen.getAllByLabelText('Priorität')[0],{target:{value:'high'}});
    fireEvent.click(screen.getByRole('button',{name:'Aufgabe anlegen'}));
    await waitFor(()=>{
      const call=apiMock.mock.calls.find(([path,options])=>path===`/customers/${customerId}/tasks`&&options?.method==='POST');
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call?.[1]?.body)).priority).toBe('high');
    });
  });
});
