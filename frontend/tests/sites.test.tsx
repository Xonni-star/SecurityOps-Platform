/** @vitest-environment jsdom */
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {MemoryRouter,Route,Routes} from 'react-router-dom';

const apiMock=vi.hoisted(()=>vi.fn());
const requestedPaths=vi.hoisted(()=>vi.fn());
const permissionMock=vi.hoisted(()=>vi.fn((_code:string)=>true));
vi.mock('../src/lib/api',()=>({api:(path:string,options?:RequestInit)=>{
  requestedPaths(path);
  const mockedPath=path==='/sites/overview-dashboard'?'/sites':path;
  const response=apiMock(mockedPath,options);
  if(path!=='/sites/overview-dashboard')return response;
  return Promise.resolve(response).then(value=>{
    if(!Array.isArray(value))return value;
    const rows=value as Array<{id:string;status:string;security_classification:string}>;
    const overviewSites=rows.map(site=>({...site,customer_names:null,object_manager_name:null,operations_manager_name:null,assigned_employee_count:null,active_contract_count:null,expiring_contract_count:null,open_hazard_count:0,overdue_measure_count:0,available_document_count:null,last_activity:null}));
    return {sites:overviewSites,metrics:{total_sites:rows.length,active_sites:rows.filter(site=>site.status==='active').length,preparation_sites:rows.filter(site=>site.status==='planning'||site.status==='setup').length,restricted_sites:rows.filter(site=>site.status==='restricted'||site.status==='temporarily_closed').length,critical_sites:rows.filter(site=>site.security_classification==='critical').length,open_hazards:0,overdue_measures:0,expiring_contracts:null,sites_without_available_documents:null}};
  });
},hasPermission:(code:string)=>permissionMock(code)}));
import {Sites} from '../src/pages/Sites';

const sites=Array.from({length:12},(_,index)=>({
  id:String(index),name:`Objekt ${String(index+1).padStart(2,'0')}`,site_number:`S${index+1}`,address:'Berlin',status:index===0?'active':'planning',security_classification:'unknown',
}));
beforeEach(()=>{cleanup();apiMock.mockReset();requestedPaths.mockReset();permissionMock.mockReset();permissionMock.mockReturnValue(true);});
const renderSites=()=>render(<MemoryRouter initialEntries={['/sites']}><Routes><Route path="/sites" element={<Sites/>}/><Route path="/sites/:siteId" element={<Sites/>}/><Route path="/sites/:siteId/:section" element={<Sites/>}/></Routes></MemoryRouter>);

describe('Objektübersicht',()=>{
  it('filters, sorts and paginates actual site data',async()=>{
    apiMock.mockResolvedValue(sites);
    renderSites();
    expect(await screen.findByText('12 Objekte · Seite 1 von 2')).toBeTruthy();
    expect(requestedPaths).toHaveBeenCalledWith('/sites/overview-dashboard');
    expect(screen.queryByRole('button',{name:'Objekt 12'})).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'Weiter'}));
    expect(screen.getByRole('button',{name:'Objekt 12'})).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'Objekt'}));
    expect(screen.getByRole('button',{name:'Objekt 12'})).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox',{name:'Status'}),{target:{value:'active'}});
    expect(screen.getByText('1 Objekte · Seite 1 von 1')).toBeTruthy();
    expect(screen.getByRole('button',{name:'Objekt 01'})).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Objekte suchen'),{target:{value:'nicht vorhanden'}});
    expect(screen.getByText('Keine Objekte entsprechen den aktiven Filtern.')).toBeTruthy();
  });

  it('shows backend KPIs and filters the expanded site table with configurable columns',async()=>{
    const enriched=[{
      ...sites[0],site_type:'Leitstelle',customer_names:['North Client'],object_manager_employee_id:'manager-1',
      object_manager_name:'Mia Guard',operations_manager_employee_id:null,operations_manager_name:null,
      assigned_employee_count:4,active_contract_count:2,expiring_contract_count:1,open_hazard_count:3,
      overdue_measure_count:1,available_document_count:0,last_activity:'2026-11-25T10:00:00Z',
    }];
    apiMock.mockImplementation(async(path:string)=>path==='/sites'?{sites:enriched,metrics:{
      total_sites:1,active_sites:1,preparation_sites:0,restricted_sites:0,critical_sites:0,
      open_hazards:3,overdue_measures:1,expiring_contracts:1,sites_without_available_documents:1,
    }}:[]);
    renderSites();
    expect(await screen.findByText('1 Objekte · Seite 1 von 1')).toBeTruthy();
    expect(screen.getByRole('row',{name:/North Client/})).toBeTruthy();
    expect(screen.getByRole('row',{name:/Mia Guard/})).toBeTruthy();
    expect(screen.getByText('3',{selector:'strong'})).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Kunde filtern'),{target:{value:'North Client'}});
    fireEvent.change(screen.getByLabelText('Objektart filtern'),{target:{value:'Leitstelle'}});
    expect(screen.getByRole('button',{name:'Objekt 01'})).toBeTruthy();
    const columnPicker=screen.getByText('Spalten').closest('details')!;
    fireEvent.click(within(columnPicker).getByLabelText('Objektart'));
    expect(screen.queryByRole('columnheader',{name:'Objektart'})).toBeNull();
    expect(screen.getByRole('columnheader',{name:'Kunde'})).toBeTruthy();
  });

  it('saves cleared optional site fields as null',async()=>{
    apiMock.mockImplementation(async(_path:string,options?:RequestInit)=>options?.method==='PATCH'?{}:sites.slice(0,1));
    renderSites();
    const row=(await screen.findByRole('button',{name:'Objekt 01'})).closest('tr')!;
    fireEvent.click(within(row).getByRole('button',{name:'Bearbeiten'}));
    fireEvent.change(screen.getByRole('textbox',{name:'Objektnummer'}),{target:{value:''}});
    fireEvent.change(screen.getByRole('textbox',{name:'Adresse'}),{target:{value:''}});
    fireEvent.change(screen.getByRole('spinbutton',{name:'Sollbesetzung'}),{target:{value:'4'}});
    fireEvent.click(screen.getByRole('button',{name:'Speichern'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith('/sites/0',expect.objectContaining({method:'PATCH',body:expect.stringContaining('"site_number":null')})));
    expect(JSON.parse(apiMock.mock.calls.find(([,options])=>options?.method==='PATCH')![1].body).address).toBeNull();
    expect(JSON.parse(apiMock.mock.calls.find(([,options])=>options?.method==='PATCH')![1].body).required_staff_count).toBe(4);
  });

  it('retains the existing object context and distinguishes restricted journal access',async()=>{
    apiMock.mockImplementation(async(path:string)=>{
      if(path==='/sites')return sites.slice(0,1);
      if(path==='/customers'||path==='/employees')return [];
      return {site:sites[0],customers:[],contracts:[],locations:[],hazards:[],instructions:[],journal:null,staffing:null,shifts:null,patrols:null,keys:null,keyBundles:null,documents:null};
    });
    renderSites();
    fireEvent.click(await screen.findByRole('button',{name:'Objekt 01'}));
    fireEvent.click(await screen.findByRole('button',{name:'Journal'}));
    expect(await screen.findByText('Keine Berechtigung für das Wachbuch.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'Gefährdungen & Sicherheit'}));
    expect(screen.getByRole('heading',{name:'Gefährdungen'})).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'Dienstanweisungen'}));
    expect(screen.getByRole('heading',{name:'Dienstanweisungen'})).toBeTruthy();
  });

  it('edits object hierarchy through the site-scoped API',async()=>{
    const context={
      site:sites[0],customers:[],contracts:[],
      locations:[{id:'location-1',parent_id:null,name:'Main building',code:'B1',location_type:'building',security_level:'medium',description:'Original description',hazard_notes:null,access_rules:'Badge required',responsible_employee_id:null,responsible_employee_name:null,sort_order:0}],
      hazards:[],instructions:[],journal:null,staffing:null,shifts:null,patrols:null,keys:null,keyBundles:null,documents:null,alarms:null,incidents:null,customerTasks:null,maintenance:null,qualifications:null,handovers:null,
    };
    apiMock.mockImplementation(async(path:string,options?:RequestInit)=>path==='/sites'?sites.slice(0,1):path==='/customers'||path==='/employees'?[]:options?.method==='PATCH'?{}:context);
    renderSites();
    fireEvent.click(await screen.findByRole('button',{name:'Objekt 01'}));
    fireEvent.click(await screen.findByRole('button',{name:'Gebäude & Bereiche'}));
    fireEvent.click(await screen.findByRole('button',{name:'Bearbeiten'}));
    fireEvent.change(screen.getByLabelText('Bezeichnung'),{target:{value:'North building'}});
    fireEvent.change(screen.getByLabelText('Sicherheitsstufe'),{target:{value:'high'}});
    fireEvent.click(screen.getByRole('button',{name:'Struktur speichern'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith('/sites/0/locations/location-1',expect.objectContaining({method:'PATCH'})));
    const update=apiMock.mock.calls.find(([path,options])=>path==='/sites/0/locations/location-1'&&options?.method==='PATCH')!;
    expect(JSON.parse(update[1].body)).toEqual(expect.objectContaining({name:'North building',security_level:'high',parent_id:null}));
  });

  it('creates only valid hierarchy levels and displays the full building path',async()=>{
    const context={
      site:sites[0],customers:[],contracts:[],
      locations:[
        {id:'building',parent_id:null,name:'Main building',code:'B1',location_type:'building',security_level:'medium',description:null,hazard_notes:null,access_rules:null,responsible_employee_id:null,responsible_employee_name:null,sort_order:0},
        {id:'area',parent_id:'building',name:'North wing',code:null,location_type:'area',security_level:'medium',description:null,hazard_notes:null,access_rules:null,responsible_employee_id:null,responsible_employee_name:null,sort_order:0},
        {id:'zone',parent_id:'area',name:'Cash room',code:null,location_type:'zone',security_level:'high',description:null,hazard_notes:null,access_rules:null,responsible_employee_id:null,responsible_employee_name:null,sort_order:0},
      ],
      hazards:[],instructions:[],journal:null,staffing:null,shifts:null,patrols:null,keys:null,keyBundles:null,documents:null,alarms:null,incidents:null,customerTasks:null,maintenance:null,qualifications:null,handovers:null,
    };
    apiMock.mockImplementation(async(path:string,options?:RequestInit)=>path==='/sites'?sites.slice(0,1):path==='/customers'||path==='/employees'?[]:options?.method==='POST'&&path.endsWith('/locations')?{}:context);
    renderSites();
    fireEvent.click(await screen.findByRole('button',{name:'Objekt 01'}));
    fireEvent.click(await screen.findByRole('button',{name:'Gebäude & Bereiche'}));
    const zoneRow=screen.getAllByRole('listitem').find(item=>item.textContent?.includes('Cash room'));
    expect(zoneRow?.textContent).toContain('Main building / North wing / Cash room');
    fireEvent.change(screen.getByLabelText('Bezeichnung'),{target:{value:'South wing'}});
    fireEvent.change(screen.getByLabelText('Strukturtyp'),{target:{value:'area'}});
    const parent=screen.getByLabelText('Übergeordnete Struktur');
    expect(within(parent).getByRole('option',{name:'Main building'})).toBeTruthy();
    expect(within(parent).queryByRole('option',{name:'North wing'})).toBeNull();
    fireEvent.change(parent,{target:{value:'building'}});
    fireEvent.click(screen.getByRole('button',{name:'Struktur anlegen'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith('/sites/0/locations',expect.objectContaining({method:'POST'})));
    const create=apiMock.mock.calls.find(([path,options])=>path==='/sites/0/locations'&&options?.method==='POST')!;
    expect(JSON.parse(create[1].body)).toEqual(expect.objectContaining({name:'South wing',location_type:'area',parent_id:'building'}));
  });

  it('edits risk assessment fields and status through the site-scoped API',async()=>{
    const context={
      site:sites[0],customers:[],contracts:[],locations:[],
      hazards:[{id:'hazard-1',title:'Loading bay fire risk',category:'fire',description:'Original risk',likelihood:2,impact:3,risk_score:6,protective_measures:'Extinguishers',responsible_employee_id:null,due_on:'2026-12-01',review_on:'2026-12-15',status:'open',location_id:null,location_name:null,responsible_employee_name:null,measures:[]}],
      instructions:[],journal:null,staffing:[{id:'assignment-1',employee_id:'assigned',employee_name:'Site Guard'}],shifts:null,patrols:null,keys:null,keyBundles:null,documents:null,alarms:null,incidents:null,customerTasks:null,maintenance:null,qualifications:null,handovers:null,
    };
    apiMock.mockImplementation(async(path:string,options?:RequestInit)=>path==='/sites'?sites.slice(0,1):path==='/customers'?[]:path==='/employees'?[{id:'assigned',name:'Site Guard'},{id:'off-site',name:'Other employee'}]:options?.method==='PATCH'?{}:context);
    renderSites();
    fireEvent.click(await screen.findByRole('button',{name:'Objekt 01'}));
    fireEvent.click(await screen.findByRole('button',{name:'Gefährdungen & Sicherheit'}));
    fireEvent.click(await screen.findByRole('button',{name:'Gefährdung bearbeiten'}));
    const owner=screen.getByLabelText('Gefährdungsverantwortliche Person');
    expect(within(owner).getByRole('option',{name:'Site Guard'})).toBeTruthy();
    expect(within(owner).queryByRole('option',{name:'Other employee'})).toBeNull();
    fireEvent.change(screen.getByLabelText('Beschreibung'),{target:{value:'Updated risk description'}});
    fireEvent.change(screen.getByLabelText('Status'),{target:{value:'mitigated'}});
    fireEvent.click(screen.getByRole('button',{name:'Gefährdung speichern'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith('/sites/0/hazards/hazard-1',expect.objectContaining({method:'PATCH'})));
    const update=apiMock.mock.calls.find(([path,options])=>path==='/sites/0/hazards/hazard-1'&&options?.method==='PATCH')!;
    expect(JSON.parse(update[1].body)).toEqual(expect.objectContaining({description:'Updated risk description',status:'mitigated',likelihood:2,impact:3}));
  });

  it('shows confirmed and outstanding acknowledgements for site-assigned staff',async()=>{
    const context={
      site:sites[0],customers:null,contracts:null,locations:[],hazards:[],
      instructions:[{id:'instruction-1',title:'Evacuation',content:'Use the marked exit.',version:1,status:'approved',requires_acknowledgement:true,acknowledgement_count:1,acknowledgements:[{employee_id:'employee-1',employee_name:'Mia Guard',acknowledged_at:'2026-11-25T10:00:00Z'}],location_name:null}],
      journal:null,staffing:[
        {employee_id:'employee-1',employee_name:'Mia Guard',assignment_id:'assignment-1',starts_on:'2026-01-01',ends_on:null,assignment_status:'active'},
        {employee_id:'employee-2',employee_name:'Leo Guard',assignment_id:'assignment-2',starts_on:'2026-01-01',ends_on:null,assignment_status:'active'},
      ],shifts:null,patrols:null,keys:null,keyBundles:null,documents:null,alarms:null,incidents:null,customerTasks:null,maintenance:null,qualifications:null,handovers:null,
    };
    apiMock.mockImplementation(async(path:string,options?:RequestInit)=>path==='/sites'?sites.slice(0,1):path==='/employees'?[{id:'employee-1',name:'Mia Guard'},{id:'employee-2',name:'Leo Guard'}]:path==='/customers'?[]:options?.method==='POST'?{}:context);
    renderSites();
    fireEvent.click(await screen.findByRole('button',{name:'Objekt 01'}));
    fireEvent.click(await screen.findByRole('button',{name:'Dienstanweisungen'}));
    const status=await screen.findByRole('list',{name:'Kenntnisnahmestatus Evacuation v1'});
    expect(within(status).getByText(/Mia Guard: Bestätigt am/)).toBeTruthy();
    expect(within(status).getByText('Leo Guard: Ausstehend')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Mitarbeiter für Kenntnisnahme'),{target:{value:'employee-2'}});
    fireEvent.click(screen.getByRole('button',{name:'Kenntnisnahme erfassen'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith('/sites/0/instructions/instruction-1/acknowledgements',expect.objectContaining({method:'POST',body:'{"employee_id":"employee-2"}'})));
  });

  it('creates and updates dated hazard measures through the site API',async()=>{
    const hazard={id:'hazard-1',title:'Loading bay fire risk',category:'fire',description:'Original risk',likelihood:2,impact:3,risk_score:6,protective_measures:null,responsible_employee_id:null,due_on:null,review_on:null,status:'open',location_id:null,location_name:null,responsible_employee_name:null};
    let measures:Array<{id:string;hazard_id:string;title:string;description:string|null;responsible_employee_id:string|null;responsible_employee_name:string|null;due_on:string|null;status:'open'|'in_progress'|'completed'|'cancelled';completed_at:string|null}>=[];
    const context=()=>({
      site:sites[0],customers:[],contracts:[],locations:[],hazards:[{...hazard,measures}],instructions:[],journal:null,
      staffing:[{id:'assignment-1',employee_id:'employee-1',employee_name:'Mia Guard'}],shifts:null,patrols:null,keys:null,keyBundles:null,documents:null,
      alarms:null,incidents:null,customerTasks:null,maintenance:null,qualifications:null,handovers:null,
    });
    apiMock.mockImplementation(async(path:string,options?:RequestInit)=>{
      if(path==='/sites')return sites.slice(0,1);
      if(path==='/customers')return [];
      if(path==='/employees')return [{id:'employee-1',name:'Mia Guard'}];
      if(path==='/sites/0/object-context')return context();
      if(path.endsWith('/measures')&&options?.method==='POST'){
        const body=JSON.parse(options.body as string);
        measures=[{id:'measure-1',hazard_id:'hazard-1',...body,responsible_employee_name:'Mia Guard',completed_at:null}];
        return measures[0];
      }
      if(path.endsWith('/measures/measure-1')&&options?.method==='PATCH'){
        const body=JSON.parse(options.body as string);
        measures=[{...measures[0],...body,completed_at:body.status==='completed'?'2026-12-01T10:00:00Z':null}];
        return measures[0];
      }
      return {};
    });
    renderSites();
    fireEvent.click(await screen.findByRole('button',{name:'Objekt 01'}));
    fireEvent.click(await screen.findByRole('button',{name:'Gefährdungen & Sicherheit'}));
    fireEvent.click(screen.getByRole('button',{name:'Maßnahme hinzufügen'}));
    fireEvent.change(screen.getByLabelText('Maßnahmentitel'),{target:{value:'Inspect extinguisher'}});
    fireEvent.change(screen.getByLabelText('Maßnahme fällig am'),{target:{value:'2026-12-01'}});
    fireEvent.change(screen.getByLabelText('Maßnahmenstatus'),{target:{value:'in_progress'}});
    fireEvent.click(screen.getByRole('button',{name:'Maßnahme erfassen'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith('/sites/0/hazards/hazard-1/measures',expect.objectContaining({method:'POST'})));
    const create=apiMock.mock.calls.find(([path,options])=>path==='/sites/0/hazards/hazard-1/measures'&&options?.method==='POST')!;
    expect(JSON.parse(create[1].body)).toEqual(expect.objectContaining({title:'Inspect extinguisher',due_on:'2026-12-01',status:'in_progress'}));
    fireEvent.click(await screen.findByRole('button',{name:'Maßnahme bearbeiten'}));
    fireEvent.change(screen.getByLabelText('Maßnahmenstatus'),{target:{value:'completed'}});
    fireEvent.click(screen.getByRole('button',{name:'Maßnahme speichern'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith('/sites/0/hazards/hazard-1/measures/measure-1',expect.objectContaining({method:'PATCH'})));
    const update=apiMock.mock.calls.find(([path,options])=>path==='/sites/0/hazards/hazard-1/measures/measure-1'&&options?.method==='PATCH')!;
    expect(JSON.parse(update[1].body)).toEqual(expect.objectContaining({status:'completed',due_on:'2026-12-01'}));
  });

  it('shows approval controls only for an approver other than the instruction author',async()=>{
    const context={
      site:sites[0],customers:null,contracts:null,locations:[],hazards:[],
      instructions:[{id:'instruction-1',title:'Evacuation',content:'Use the marked exit.',version:1,status:'pending_approval',requires_acknowledgement:true,acknowledgement_count:0,acknowledgements:[],can_approve:true}],
      journal:null,staffing:null,shifts:null,patrols:null,keys:null,keyBundles:null,documents:null,alarms:null,incidents:null,customerTasks:null,maintenance:null,qualifications:null,handovers:null,
    };
    apiMock.mockImplementation(async(path:string,options?:RequestInit)=>path==='/sites'?sites.slice(0,1):path==='/customers'||path==='/employees'?[]:path==='/sites/0/object-context'?context:options?.method==='POST'?{}:context);
    renderSites();
    fireEvent.click(await screen.findByRole('button',{name:'Objekt 01'}));
    fireEvent.click(await screen.findByRole('button',{name:'Dienstanweisungen'}));
    expect(screen.queryByRole('option',{name:'Freigegeben'})).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'Freigabe erteilen'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith('/sites/0/instructions/instruction-1/approve',expect.objectContaining({method:'POST'})));
  });

  it('shows real object staffing assignments and upcoming duty shifts',async()=>{
    apiMock.mockImplementation(async(path:string)=>{
      if(path==='/sites')return sites.slice(0,1);
      if(path==='/customers'||path==='/employees')return [];
      return {
        site:sites[0],customers:null,contracts:null,locations:[],hazards:[],instructions:[],journal:null,
        staffing:[{id:'assignment-1',employee_id:'employee-1',employee_name:'Mia Guard',assignment_type:'operational',role:'Objektschutz',starts_on:'2026-01-01',ends_on:null,primary_assignment:true,notes:null}],
        shifts:[{id:'shift-1',period_id:'period-1',period_name:'Novemberplan',period_status:'published',period_starts_at:'2026-11-01T00:00:00Z',period_ends_at:'2026-12-01T00:00:00Z',role_code:'night_guard',starts_at:'2026-11-26T20:00:00Z',ends_at:'2026-11-27T06:00:00Z',assigned_count:1,assignments:[{id:'schedule-assignment-1',employee_name:'Mia Guard'}]}],
      };
    });
    renderSites();
    fireEvent.click(await screen.findByRole('button',{name:'Objekt 01'}));
    fireEvent.click(await screen.findByRole('button',{name:'Kunden & Verträge'}));
    expect(await screen.findByText('Keine Berechtigung für Kundenbeziehungen.')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button',{name:'Mitarbeiter & Verantwortlichkeiten'}));
    expect(await screen.findByText('Mia Guard')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button',{name:'Dienstplanung'}));
    expect(screen.getByText(/Novemberplan/)).toBeTruthy();
    expect(screen.getByText(/night_guard/)).toBeTruthy();
  });

  it('creates a site staffing assignment through the existing employee API with an audit reason',async()=>{
    const employee={id:'employee-1',name:'Mia Guard'};
    const context={
      site:sites[0],customers:null,contracts:null,locations:[],hazards:[],instructions:[],journal:null,
      staffing:[],shifts:[],patrols:null,keys:null,keyBundles:null,documents:null,alarms:null,incidents:null,customerTasks:null,maintenance:null,qualifications:null,handovers:null,
    };
    apiMock.mockImplementation(async(path:string,options?:RequestInit)=>path==='/sites'?sites.slice(0,1):path==='/customers'?[]:path==='/employees'?[employee]:options?.method==='POST'?{}:context);
    renderSites();
    fireEvent.click(await screen.findByRole('button',{name:'Objekt 01'}));
    fireEvent.click(await screen.findByRole('button',{name:'Mitarbeiter & Verantwortlichkeiten'}));
    fireEvent.change(screen.getByLabelText('Mitarbeiter'),{target:{value:'employee-1'}});
    fireEvent.change(screen.getByLabelText('Beginn'),{target:{value:'2026-11-25'}});
    fireEvent.change(screen.getByLabelText('Rolle'),{target:{value:'Objektschutz'}});
    fireEvent.change(screen.getByLabelText('Begründung für Audit'),{target:{value:'Coverage requirement'}});
    fireEvent.click(screen.getByRole('button',{name:'Personalzuordnung anlegen'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith('/employees/employee-1/object-assignments',expect.objectContaining({method:'POST'})));
    const create=apiMock.mock.calls.find(([path,options])=>path==='/employees/employee-1/object-assignments'&&options?.method==='POST')!;
    expect(JSON.parse(create[1].body)).toEqual(expect.objectContaining({site_id:'0',starts_on:'2026-11-25',role:'Objektschutz',reason:'Coverage requirement'}));
  });

  it('shows actual patrol plans and recent checkpoint activity, while explaining restricted access',async()=>{
    apiMock.mockImplementation(async(path:string)=>{
      if(path==='/sites')return sites.slice(0,1);
      if(path==='/customers'||path==='/employees')return [];
      return {
        site:sites[0],customers:null,contracts:null,locations:[],hazards:[],instructions:[],journal:null,staffing:null,shifts:null,
        patrols:{
          routes:[{id:'route-1',name:'Night perimeter',expected_start:'22:00:00',expected_end:'23:00:00',points:[{control_point_id:'point-1',name:'North gate',sequence:1,expected_offset_seconds:0}],assignments:[{id:'assignment-1',starts_at:'2026-11-25T22:00:00Z',ends_at:null,employee_name:'Mia Guard'}]}],
          recentScans:[{id:'scan-1',route_id:'route-1',route_name:'Night perimeter',control_point_id:'point-1',control_point_name:'North gate',scanned_at:'2026-11-24T22:15:00Z',deviation:'none',employee_name:'Mia Guard'}],
        },
      };
    });
    renderSites();
    fireEvent.click(await screen.findByRole('button',{name:'Objekt 01'}));
    fireEvent.click(await screen.findByRole('button',{name:'Kontrollgänge'}));
    expect(await screen.findAllByText('Night perimeter')).toHaveLength(2);
    expect(screen.getByText(/1\. North gate/)).toBeTruthy();
    expect(screen.getByText(/Zuweisungen: Mia Guard/)).toBeTruthy();
    expect(screen.getByText(/Ohne Abweichung/)).toBeTruthy();

    apiMock.mockImplementation(async(path:string)=>{
      if(path==='/sites')return sites.slice(0,1);
      if(path==='/customers'||path==='/employees')return [];
      return {site:sites[0],customers:null,contracts:null,locations:[],hazards:[],instructions:[],journal:null,staffing:null,shifts:null,patrols:null};
    });
    fireEvent.click(screen.getByRole('button',{name:'Zur Objektübersicht'}));
    fireEvent.click(await screen.findByRole('button',{name:'Objekt 01'}));
    fireEvent.click(await screen.findByRole('button',{name:'Kontrollgänge'}));
    expect(await screen.findAllByText('Keine Berechtigung für Kontrollgänge.')).toHaveLength(2);
  });

  it('shows site key inventory, bundle status and DMS versions with real read models',async()=>{
    apiMock.mockImplementation(async(path:string)=>{
      if(path==='/sites')return sites.slice(0,1);
      if(path==='/customers'||path==='/employees')return [];
      return {
        site:sites[0],customers:null,contracts:null,locations:[],hazards:[],instructions:[],journal:null,staffing:null,shifts:null,patrols:null,
        keys:{
          items:[{id:'key-1',key_code:'K-01',label:'Main entrance',key_type:'physical',status:'issued',holder_user_id:null,holder_employee_id:'employee-1',issued_at:null,returned_at:null,lost_at:null,deactivated_at:null}],
          recentMovements:[{id:'movement-1',key_id:'key-1',key_label:'Main entrance',movement_type:'issued',from_status:'available',to_status:'issued',created_at:'2026-11-25T10:00:00Z',employee_name:'Mia Guard'}],
        },
        keyBundles:[{id:'bundle-1',name:'Night shift',status:'issued',item_count:2,issued_count:2}],
        documents:[{id:'document-1',title:'Site instructions',description:null,document_status:'active',created_at:'2026-11-25T10:00:00Z',deleted_at:null,versions:[{id:'version-1',version_no:1,size_bytes:128,content_type:'application/pdf',lifecycle_state:'available',created_at:'2026-11-25T10:00:00Z',retention_until:null}]}],
      };
    });
    renderSites();
    fireEvent.click(await screen.findByRole('button',{name:'Objekt 01'}));
    fireEvent.click(await screen.findByRole('button',{name:'Schlüssel & Zutritt'}));
    expect(await screen.findByText(/K-01/)).toBeTruthy();
    expect(screen.getByText('Night shift')).toBeTruthy();
    expect(screen.getByRole('heading',{name:'Letzte Schlüsselbewegungen'})).toBeTruthy();
    expect(screen.getByText(/Mia Guard/)).toBeTruthy();
    fireEvent.click(await screen.findByRole('button',{name:'Dokumente'}));
    expect(await screen.findByText('Site instructions')).toBeTruthy();
    expect(screen.getByText(/Version 1 · available · 128 Bytes/)).toBeTruthy();
    expect(screen.getByRole('button',{name:'Dokument hochladen und prüfen'})).toBeTruthy();
  });

  it('issues and returns site keys through the existing idempotent key APIs',async()=>{
    const employee={id:'employee-1',name:'Mia Guard'};
    let keyStatus='available';
    const context=()=>({
      site:sites[0],customers:null,contracts:null,locations:[],hazards:[],instructions:[],journal:null,
      staffing:[{id:'assignment-1',employee_id:employee.id,employee_name:employee.name,assignment_type:'operational',role:'Objektschutz',starts_on:'2026-01-01',ends_on:null,primary_assignment:true,notes:null}],
      shifts:null,patrols:null,
      keys:{items:[{id:'key-1',key_code:'K-01',label:'Main entrance',key_type:'physical',status:keyStatus,holder_user_id:null,holder_employee_id:keyStatus==='issued'?employee.id:null,issued_at:null,returned_at:null,lost_at:null,deactivated_at:null}],recentMovements:[]},
      keyBundles:null,documents:null,alarms:null,incidents:null,customerTasks:null,maintenance:null,qualifications:null,handovers:null,
    });
    apiMock.mockImplementation(async(path:string,options?:RequestInit)=>{
      if(path==='/sites')return sites.slice(0,1);
      if(path==='/customers')return [];
      if(path==='/employees')return [employee];
      if(path==='/keys/key-1/issue'){keyStatus='issued';return {};}
      if(path==='/keys/key-1/return'){keyStatus='available';return {};}
      return context();
    });
    renderSites();
    fireEvent.click(await screen.findByRole('button',{name:'Objekt 01'}));
    fireEvent.click(await screen.findByRole('button',{name:'Schlüssel & Zutritt'}));
    fireEvent.click(await screen.findByRole('button',{name:'Ausgabe vorbereiten'}));
    fireEvent.change(screen.getByLabelText('Schlüsselhalter'),{target:{value:employee.id}});
    fireEvent.change(screen.getByLabelText('Grund'),{target:{value:'Night shift access'}});
    fireEvent.click(screen.getByRole('button',{name:'Schlüssel ausgeben'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith('/keys/key-1/issue',expect.objectContaining({method:'POST'})));
    const issue=apiMock.mock.calls.find(([path])=>path==='/keys/key-1/issue')!;
    expect(JSON.parse(issue[1].body)).toEqual(expect.objectContaining({holder_user_id:null,holder_employee_id:employee.id,reason:'Night shift access'}));
    expect(JSON.parse(issue[1].body).client_mutation_id).toMatch(/^[0-9a-f-]{36}$/i);
    fireEvent.click(await screen.findByRole('button',{name:'Rückgabe erfassen'}));
    fireEvent.change(screen.getByLabelText('Grund'),{target:{value:'End of shift'}});
    fireEvent.click(screen.getByRole('button',{name:'Rückgabe bestätigen'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith('/keys/key-1/return',expect.objectContaining({method:'POST'})));
    const returned=apiMock.mock.calls.find(([path])=>path==='/keys/key-1/return')!;
    expect(JSON.parse(returned[1].body)).toEqual(expect.objectContaining({reason:'End of shift'}));
    expect(JSON.parse(returned[1].body).client_mutation_id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('explains inaccessible key and DMS sections',async()=>{
    apiMock.mockImplementation(async(path:string)=>{
      if(path==='/sites')return sites.slice(0,1);
      if(path==='/customers'||path==='/employees')return [];
      return {site:sites[0],customers:null,contracts:null,locations:[],hazards:[],instructions:[],journal:null,staffing:null,shifts:null,patrols:null,keys:null,keyBundles:null,documents:null};
    });
    renderSites();
    fireEvent.click(await screen.findByRole('button',{name:'Objekt 01'}));
    fireEvent.click(await screen.findByRole('button',{name:'Schlüssel & Zutritt'}));
    expect(await screen.findByText('Keine Berechtigung für Schlüssel.')).toBeTruthy();
    expect(screen.getByText('Keine Berechtigung für die Schlüsselhistorie.')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button',{name:'Dokumente'}));
    expect(await screen.findByText('Keine Berechtigung für DMS-Dokumente.')).toBeTruthy();
    expect(screen.queryByRole('button',{name:'Dokument hochladen und prüfen'})).toBeNull();
  });

  it('uploads site documents through the existing DMS endpoint',async()=>{
    apiMock.mockImplementation(async(path:string)=>{
      if(path==='/sites')return sites.slice(0,1);
      if(path==='/customers'||path==='/employees')return [];
      return {
        site:sites[0],customers:null,contracts:null,locations:[],hazards:[],instructions:[],journal:null,staffing:null,shifts:null,patrols:null,
        keys:null,keyBundles:null,documents:[],
      };
    });
    renderSites();
    const user=userEvent.setup();
    fireEvent.click(await screen.findByRole('button',{name:'Objekt 01'}));
    fireEvent.click(await screen.findByRole('button',{name:'Dokumente'}));
    const uploadForm=screen.getByRole('button',{name:'Dokument hochladen und prüfen'}).closest('form')!;
    fireEvent.change(within(uploadForm).getByLabelText('Dokumenttitel'),{target:{value:'Fluchtplan'}});
    const file=new File(['content'],'escape-plan.pdf',{type:'application/pdf'});
    Object.defineProperty(file,'arrayBuffer',{value:async()=>new TextEncoder().encode('content').buffer});
    const fileInput=within(uploadForm).getByLabelText('Datei') as HTMLInputElement;
    await user.upload(fileInput,file);
    expect(fileInput.files?.[0]).toBe(file);
    fireEvent.submit(screen.getByRole('button',{name:'Dokument hochladen und prüfen'}).closest('form')!);
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith('/dms/documents',expect.objectContaining({method:'POST'})));
    const upload=apiMock.mock.calls.find(([path])=>path==='/dms/documents')!;
    const body=JSON.parse(upload[1].body);
    expect(body).toEqual(expect.objectContaining({title:'Fluchtplan',site_id:'0',content_type:'application/pdf',content_base64:btoa('content')}));
    expect(body.client_mutation_id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('shows linked incidents and maintenance and reuses customer-task actions',async()=>{
    apiMock.mockImplementation(async(path:string)=>path==='/sites'?sites.slice(0,1):path==='/customers'||path==='/employees'?[]:path==='/watchbook/categories'?[{id:'maintenance-category',code:'maintenance',name:'Technik / Instandhaltung'}]:path==='/watchbook/priorities'?[{code:'medium',name:'Mittel'}]:{
      site:sites[0],
      customers:[{customer_id:'customer-1',customer_name:'Northwind',relationship_type:'primary',relationship_status:'active'}],
      contracts:[],locations:[],hazards:[],instructions:[],journal:[{id:'entry-1',created_at:'2026-11-25T10:00:00Z',revision_no:2,content:'Shift report',status:'open',category_name:'Vorkommnis',priority_name:'Hoch'}],
      staffing:null,shifts:null,patrols:null,keys:null,keyBundles:null,documents:null,
      alarms:[{id:'alarm-1',type:'panic',description:'Assistance requested',severity:'critical',status:'open',triggered_at:'2026-11-25T10:00:00Z',acknowledged_at:null,resolved_at:null,priority_name:'Kritisch'}],
      incidents:[{id:'incident-1',alarm_id:'alarm-1',description:'Respond to alarm',status:'on_site',created_at:'2026-11-25T10:00:00Z',updated_at:'2026-11-25T10:00:00Z',priority_name:'Kritisch',employee_name:null,assigned_count:1,assignees:[]}],
      customerTasks:[{id:'task-1',customer_id:'customer-1',customer_name:'Northwind',title:'Review site access',description:null,status:'open',due_at:null,assigned_employee_name:null,created_at:'2026-11-25T10:00:00Z',completed_at:null}],
      maintenance:[{id:'maintenance-1',created_at:'2026-11-25T10:00:00Z',revision_no:1,content:'Inspect gate',status:'open',priority_name:'Hoch'}],
    });
    renderSites();
    fireEvent.click(await screen.findByRole('button',{name:'Objekt 01'}));
    fireEvent.click(await screen.findByRole('button',{name:'Vorfälle & Berichte'}));
    expect(await screen.findByText('Assistance requested')).toBeTruthy();
    expect(screen.getByText('Respond to alarm')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button',{name:'Aufgaben & Maßnahmen'}));
    expect(await screen.findByText('Review site access')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button',{name:'Ausstattung & Technik'}));
    expect(screen.getByText('Inspect gate')).toBeTruthy();
    expect(await screen.findByRole('heading',{name:'Technik-/Instandhaltungseintrag erfassen'})).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Eintrag'),{target:{value:'Inspect backup generator'}});
    fireEvent.click(screen.getByRole('button',{name:'Im Wachbuch erfassen'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith('/watchbook/entries',expect.objectContaining({method:'POST'})));
    const maintenanceWrite=apiMock.mock.calls.find(([path,options])=>path==='/watchbook/entries'&&options?.method==='POST')!;
    expect(JSON.parse(maintenanceWrite[1].body)).toEqual(expect.objectContaining({site_id:'0',category_id:'maintenance-category',priority_code:'medium',content:'Inspect backup generator'}));
    expect(JSON.parse(maintenanceWrite[1].body).client_entry_id).toMatch(/^[0-9a-f-]{36}$/i);
    fireEvent.click(await screen.findByRole('button',{name:'Aufgaben & Maßnahmen'}));
    fireEvent.change(screen.getByLabelText('Kunde'),{target:{value:'customer-1'}});
    fireEvent.change(screen.getByLabelText('Aufgabe / Wiedervorlage'),{target:{value:'Test emergency lights'}});
    fireEvent.click(screen.getByRole('button',{name:'Aufgabe anlegen'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith('/customers/customer-1/tasks',expect.objectContaining({method:'POST'})));
    fireEvent.click(screen.getByRole('button',{name:'Als erledigt markieren'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith('/customers/customer-1/tasks/task-1',expect.objectContaining({method:'PATCH',body:JSON.stringify({status:'completed'})})));
    fireEvent.click(await screen.findByRole('button',{name:'Journal'}));
    expect(await screen.findByText('Shift report')).toBeTruthy();
  });

  it('shows expiring qualifications for assigned staff and handover confirmation status',async()=>{
    apiMock.mockImplementation(async(path:string)=>path==='/sites'?sites.slice(0,1):path==='/customers'||path==='/employees'?[]:{
      site:sites[0],customers:null,contracts:null,locations:[],hazards:[],instructions:[],journal:null,staffing:null,shifts:null,patrols:null,
      keys:null,keyBundles:null,documents:null,alarms:null,incidents:null,customerTasks:null,maintenance:null,
      qualifications:[{id:'qualification-1',employee_id:'employee-1',employee_name:'Mia Guard',code:'first_aid',qualification_name:'Erste Hilfe',valid_from:'2026-01-01',valid_until:'2026-12-01',status:'valid',computed_status:'expiring'}],
      handovers:[{id:'handover-1',shift_id:null,title:'Night shift transfer',status:'open',created_at:'2026-11-25T10:00:00Z',participant_count:2,confirmation_count:1}],
    });
    renderSites();
    fireEvent.click(await screen.findByRole('button',{name:'Objekt 01'}));
    fireEvent.click(await screen.findByRole('button',{name:'Mitarbeiter & Verantwortlichkeiten'}));
    expect(await screen.findByText('Mia Guard')).toBeTruthy();
    expect(screen.getByText(/Erste Hilfe/)).toBeTruthy();
    expect(screen.getByText(/Läuft bald ab/)).toBeTruthy();
    fireEvent.click(await screen.findByRole('button',{name:'Übersicht'}));
    expect(await screen.findByText(/Night shift transfer/)).toBeTruthy();
    expect(screen.getByText(/1\/2 Bestätigungen/)).toBeTruthy();
  });

  it('assigns an object-assigned employee to an upcoming shift through scheduling',async()=>{
    const context={
      site:sites[0],customers:null,contracts:null,locations:[],hazards:[],instructions:[],journal:null,
      staffing:[{id:'staffing-1',employee_id:'employee-1',employee_name:'Mia Guard',assignment_type:'operational',role:null,starts_on:'2026-01-01',ends_on:null,primary_assignment:false,notes:null}],
      shifts:[{id:'shift-1',period_id:'period-1',period_name:'November',period_status:'published',period_starts_at:'2026-11-25T00:00:00Z',period_ends_at:'2026-11-26T00:00:00Z',role_code:'guard',starts_at:'2026-11-25T08:00:00Z',ends_at:'2026-11-25T16:00:00Z',assigned_count:0,assignments:[]}],
      patrols:null,keys:null,keyBundles:null,documents:null,alarms:null,incidents:null,customerTasks:null,maintenance:null,qualifications:null,handovers:null,
    };
    apiMock.mockImplementation(async(path:string,options?:RequestInit)=>path==='/sites'?sites.slice(0,1):path==='/customers'?[]:path==='/employees'?[{id:'employee-1',name:'Mia Guard'}]:path==='/scheduling/shifts/shift-1/assignments'?{}:context);
    renderSites();
    fireEvent.click(await screen.findByRole('button',{name:'Objekt 01'}));
    fireEvent.click(await screen.findByRole('button',{name:'Dienstplanung'}));
    fireEvent.change(await screen.findByLabelText('Mitarbeiter für guard'),{target:{value:'employee-1'}});
    fireEvent.click(screen.getByRole('button',{name:'Schicht besetzen'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith('/scheduling/shifts/shift-1/assignments',expect.objectContaining({method:'POST'})));
    const assignment=apiMock.mock.calls.find(([path,options])=>path==='/scheduling/shifts/shift-1/assignments'&&options?.method==='POST')!;
    expect(JSON.parse(assignment[1].body)).toEqual({employee_id:'employee-1',client_mutation_id:expect.stringMatching(/^[0-9a-f-]{36}$/i)});
  });

  it('links object report exports to the existing site-filtered report module',async()=>{
    apiMock.mockImplementation(async(path:string)=>path==='/sites'?sites.slice(0,1):path==='/customers'||path==='/employees'?[]:{
      site:sites[0],customers:null,contracts:null,locations:[],hazards:[],instructions:[],journal:null,staffing:null,shifts:null,patrols:null,
      keys:null,keyBundles:null,documents:null,alarms:null,incidents:null,customerTasks:null,maintenance:null,qualifications:null,handovers:null,
    });
    renderSites();
    fireEvent.click(await screen.findByRole('button',{name:'Objekt 01'}));
    fireEvent.click(await screen.findByRole('button',{name:'Vorfälle & Berichte'}));
    const reportLink=await screen.findByRole('link',{name:'Berichte für dieses Objekt öffnen'});
    expect(reportLink.getAttribute('href')).toBe('/customer-reports?site_id=0');
  });

  it('renders server-classified document statuses and sends approvals only through the workflow endpoints',async()=>{
    const expiredDocument={
      id:'document-1',title:'Security plan',description:null,document_status:'active',approval_status:'approved',
      created_at:'2026-01-01T00:00:00Z',deleted_at:null,document_number:null,document_type:'Security plan',
      responsible_employee_id:null,location_id:null,valid_from:null,valid_until:'2026-11-20',review_on:null,
      versions:[{id:'version-1',version_no:1,size_bytes:128,content_type:'application/pdf',lifecycle_state:'available',created_at:'2026-01-01T00:00:00Z',retention_until:null}],
      computed_status:'abgelaufen',status_label:'Abgelaufen',expiry_bucket:'expired',days_until_expiry:-5,
      review_state:'none',is_approved:true,is_currently_valid:false,
    };
    const draftDocument={...expiredDocument,id:'document-2',title:'Shift plan',approval_status:'draft',computed_status:'nicht_freigegeben',status_label:'Nicht freigegeben',expiry_bucket:'no_expiry',days_until_expiry:null,is_approved:false};
    const context={
      site:sites[0],customers:[],contracts:[],locations:[],hazards:[],instructions:[],journal:[],staffing:[],shifts:[],patrols:null,
      keys:null,keyBundles:null,documents:[expiredDocument,draftDocument],
      documentRequirements:[{id:'requirement-1',document_type:'Security plan',required:true,responsible_employee_id:null,responsible_employee_name:null,missing:false,requirement_status:'abgelaufen',status_label:'Abgelaufen',matching_document_id:'document-1'}],
      alarms:[],incidents:[],customerTasks:[],maintenance:[],maintenanceOrders:[],qualifications:[],handovers:[],devices:[],
    };
    const prompt=vi.spyOn(window,'prompt').mockReturnValue('Veraltet');
    apiMock.mockImplementation(async(path:string,options?:RequestInit)=>path==='/sites'?sites.slice(0,1):path==='/customers'||path==='/employees'?[]:path.startsWith('/sites/0/chronicle')?{site_id:'0',events:[]}:options?.method==='POST'?{}:context);
    renderSites();
    fireEvent.click(await screen.findByRole('button',{name:'Objekt 01'}));
    fireEvent.click(await screen.findByRole('button',{name:'Dokumente'}));
    expect((await screen.findAllByText(/Security plan/)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Abgelaufen/).length).toBeGreaterThan(0);
    expect(screen.getByText(/-5 Tage bis Ablauf/)).toBeTruthy();
    expect(screen.getByText(/Nicht freigegeben/)).toBeTruthy();
    expect(screen.queryByText(/Läuft innerhalb 30 Tage ab/)).toBeNull();
    expect(screen.queryByRole('option',{name:'Freigegeben'})).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'Freigabe anfordern'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith('/dms/documents/document-2/request-review',expect.objectContaining({method:'POST'})));
    fireEvent.click(screen.getByRole('button',{name:'Zur Überarbeitung zurückgeben'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith('/dms/documents/document-1/return-for-revision',expect.objectContaining({method:'POST',body:JSON.stringify({reason:'Veraltet'})})));
    fireEvent.click(screen.getAllByRole('button',{name:'Metadaten bearbeiten'})[0]);
    fireEvent.change(screen.getByLabelText('Dokumenttitel'),{target:{value:'Nur Upload'}});
    fireEvent.change(screen.getByLabelText('Dokumenttitel bearbeiten'),{target:{value:'Korrigierter Titel'}});
    fireEvent.click(screen.getByRole('button',{name:'Metadaten speichern'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith('/dms/documents/document-1',expect.objectContaining({method:'PATCH'})));
    const patch=apiMock.mock.calls.find(([path,options])=>path==='/dms/documents/document-1'&&options?.method==='PATCH')!;
    expect(JSON.parse(patch[1].body).title).toBe('Korrigierter Titel');
    expect(JSON.parse(patch[1].body)).not.toHaveProperty('approval_status');
    prompt.mockRestore();
  });

  it('creates, progresses and completes server-managed maintenance orders over existing devices',async()=>{
    const device={id:'device-1',name:'Gate camera',asset_number:'A-1',status:'online',site_id:'0',last_seen_at:null,metadata:{},category:'Videoüberwachung',manufacturer:null,model:null,serial_number:null,location_id:null,responsible_employee_id:null,operational_status:'active',installed_on:null,commissioned_on:null,last_inspection_on:null,next_inspection_on:null,maintenance_interval_days:90,next_maintenance_on:'2026-11-01',last_maintenance_on:null,created_at:'2026-01-01T00:00:00Z',updated_at:'2026-01-01T00:00:00Z'};
    const order={id:'order-1',site_id:'0',device_id:'device-1',device_name:'Gate camera',asset_number:'A-1',order_number:'MAIN-2026-000001',maintenance_type:'inspection',description:'Inspect camera',priority_code:'medium',due_on:'2026-11-01',status:'planned',computed_status:'overdue',status_label:'Überfällig',overdue:true,responsible_employee_id:null,responsible_employee_name:null,performed_work:null,result:null,remarks:null,next_maintenance_on:null,documents:[],created_at:'2026-01-01T00:00:00Z'};
    const context={
      site:sites[0],customers:[],contracts:[],locations:[],hazards:[],instructions:[],journal:[],staffing:[],shifts:[],patrols:null,
      keys:null,keyBundles:null,documents:[],documentRequirements:[],alarms:[],incidents:[],customerTasks:[],maintenance:[],
      maintenanceOrders:[order],qualifications:[],handovers:[],devices:[device],
    };
    apiMock.mockImplementation(async(path:string,options?:RequestInit)=>path==='/sites'?sites.slice(0,1):path==='/customers'?[]:path==='/employees'?[]:path==='/watchbook/categories'?[{id:'maintenance-category',code:'maintenance',name:'Technik / Instandhaltung'}]:path==='/watchbook/priorities'?[{code:'medium',name:'Mittel'}]:path.startsWith('/sites/0/chronicle')?{site_id:'0',events:[]}:options?.method==='POST'||options?.method==='PATCH'?{}:context);
    renderSites();
    fireEvent.click(await screen.findByRole('button',{name:'Objekt 01'}));
    fireEvent.click(await screen.findByRole('button',{name:'Ausstattung & Technik'}));
    expect(await screen.findByText(/MAIN-2026-000001/)).toBeTruthy();
    expect(screen.getByText(/Überfällig/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'Wartungsauftrag erfassen'}));
    fireEvent.change(screen.getByLabelText('Anlage'),{target:{value:'device-1'}});
    fireEvent.change(screen.getByLabelText('Beschreibung'),{target:{value:'Replace defective camera'}});
    fireEvent.change(screen.getByLabelText('Fällig am'),{target:{value:'2026-12-01'}});
    fireEvent.click(screen.getByRole('button',{name:'Auftrag anlegen'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith('/sites/0/maintenance-orders',expect.objectContaining({method:'POST'})));
    const created=JSON.parse(apiMock.mock.calls.find(([path,options])=>path==='/sites/0/maintenance-orders'&&options?.method==='POST')![1].body);
    expect(created).toEqual(expect.objectContaining({device_id:'device-1',description:'Replace defective camera',due_on:'2026-12-01',status:'planned'}));
    expect(created).not.toHaveProperty('watchbook_entry_id');
    fireEvent.click(screen.getByRole('button',{name:'In Bearbeitung nehmen'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith('/maintenance-orders/order-1',expect.objectContaining({method:'PATCH',body:JSON.stringify({status:'in_progress'})})));
    fireEvent.click(screen.getByRole('button',{name:'Abschließen'}));
    fireEvent.change(screen.getByLabelText('Durchgeführte Arbeit'),{target:{value:'Camera replaced'}});
    fireEvent.click(screen.getByRole('button',{name:'Abschluss erfassen'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith('/maintenance-orders/order-1/complete',expect.objectContaining({method:'POST'})));
    expect(JSON.parse(apiMock.mock.calls.find(([path])=>path==='/maintenance-orders/order-1/complete')![1].body)).toEqual(expect.objectContaining({performed_work:'Camera replaced'}));
    fireEvent.click(screen.getAllByRole('button',{name:'Abbrechen'})[0]);
    fireEvent.change(screen.getByLabelText('Begründung'),{target:{value:'Auftrag nicht mehr erforderlich'}});
    fireEvent.click(screen.getByRole('button',{name:'Abbruch erfassen'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith('/maintenance-orders/order-1/cancel',expect.objectContaining({method:'POST',body:JSON.stringify({reason:'Auftrag nicht mehr erforderlich'})})));
  });

  it('shows the authoritative shift eligibility verdict with reasons and evidence links',async()=>{
    const context={
      site:sites[0],customers:[],contracts:[],locations:[],hazards:[],instructions:[],journal:[],
      staffing:[{id:'assignment-1',employee_id:'employee-1',employee_name:'Mia Guard',employee_number:null,employment_status:'active',assignment_type:'operational',role:'guard',starts_on:'2026-01-01',ends_on:null,primary_assignment:true,notes:null}],
      shifts:[{id:'shift-1',period_id:'period-1',period_name:'November',period_status:'published',period_starts_at:'2026-11-01T00:00:00Z',period_ends_at:'2026-12-01T00:00:00Z',role_code:'night_guard',starts_at:'2026-11-25T08:00:00Z',ends_at:'2026-11-25T16:00:00Z',assigned_count:0,assignments:[]}],
      patrols:null,keys:null,keyBundles:null,documents:null,documentRequirements:null,alarms:[],incidents:[],customerTasks:[],maintenance:[],maintenanceOrders:[],
      qualifications:[],handovers:[],devices:[],
    };
    apiMock.mockImplementation(async(path:string)=>path==='/sites'?sites.slice(0,1):path==='/customers'||path==='/employees'?[]:path==='/sites/0/shifts/shift-1/eligibility'?{
      shift_id:'shift-1',site_id:'0',required_qualification_codes:['night_guard'],
      employees:[{employee_id:'employee-1',employee_name:'Mia Guard',status:'ineligible',reasons:[{code:'missing_qualification',message:'Erforderliche Qualifikation fehlt',link:{type:'qualification',id:'qualification-1',label:'night_guard'}}],matched_qualification_codes:[],missing_qualification_codes:['night_guard']}],
    }:path.startsWith('/sites/0/chronicle')?{site_id:'0',events:[]}:context);
    renderSites();
    fireEvent.click(await screen.findByRole('button',{name:'Objekt 01'}));
    fireEvent.click(await screen.findByRole('button',{name:'Dienstplanung'}));
    expect(await screen.findByText('Nicht einsatzfähig')).toBeTruthy();
    expect(screen.getByText(/Erforderliche Qualifikation fehlt/)).toBeTruthy();
    expect(screen.getByRole('link',{name:/Nachweis öffnen/}).getAttribute('href')).toBe('/employees/employee-1/qualifikationen');
    expect(screen.queryByText('Einsatzfähig')).toBeNull();
    expect(requestedPaths).toHaveBeenCalledWith('/sites/0/shifts/shift-1/eligibility');
  });

  it('filters the server chronicle and shows explicit loading and empty states',async()=>{
    const events=[
      {id:'event-2',site_id:'0',occurred_at:'2026-11-25T12:00:00Z',event_kind:'maintenance_order.completed',entity_type:'maintenance_order',entity_id:'order-1',category:'Technik & Wartung',summary:'Wartung abgeschlossen',details:{},actor_user_id:null,actor_email:null,actor_employee_name:null,source_table:'audit_events'},
      {id:'event-1',site_id:'0',occurred_at:'2026-11-25T08:00:00Z',event_kind:'dms.document_uploaded',entity_type:'dms_document',entity_id:'document-1',category:'Dokumente',summary:'Dokument hochgeladen',details:{},actor_user_id:null,actor_email:'admin@example.test',actor_employee_name:null,source_table:'audit_events'},
    ];
    const context={
      site:sites[0],customers:[],contracts:[],locations:[],hazards:[],instructions:[],
      journal:[{id:'entry-1',created_at:'2026-11-25T09:00:00Z',revision_no:1,content:'Shift report',status:'open',category_name:'Vorkommnis',priority_name:'Hoch'}],
      staffing:[],shifts:[],patrols:null,keys:null,keyBundles:null,documents:[],documentRequirements:[],alarms:[],incidents:[],customerTasks:[],maintenance:[],maintenanceOrders:[],qualifications:[],handovers:[],devices:[],
    };
    apiMock.mockImplementation(async(path:string)=>path==='/sites'?sites.slice(0,1):path==='/customers'||path==='/employees'?[]:path.includes('from=2030-01-01')?{site_id:'0',events:[]}:path.startsWith('/sites/0/chronicle?type=maintenance_order.completed')?{site_id:'0',events:[events[0]]}:path.startsWith('/sites/0/chronicle')?{site_id:'0',events}:context);
    renderSites();
    fireEvent.click(await screen.findByRole('button',{name:'Objekt 01'}));
    fireEvent.click(await screen.findByRole('button',{name:'Journal'}));
    expect(await screen.findByRole('heading',{name:'Serverchronik mit Filtern'})).toBeTruthy();
    const chronicleList=await waitFor(()=>{
      const list=screen.getByRole('heading',{name:'Serverchronik mit Filtern'}).parentElement?.querySelector('ol');
      if(!list)throw new Error('Chronik list not rendered');
      return list;
    });
    expect(chronicleList.querySelectorAll('li')[0].textContent).toContain('Wartung abgeschlossen');
    fireEvent.change(screen.getByLabelText('Ereignistyp filtern'),{target:{value:'maintenance_order.completed'}});
    fireEvent.change(screen.getByLabelText('Chronik von'),{target:{value:'2026-11-25'}});
    fireEvent.click(screen.getByRole('button',{name:'Chronik filtern'}));
    await waitFor(()=>expect(requestedPaths).toHaveBeenCalledWith('/sites/0/chronicle?type=maintenance_order.completed&from=2026-11-25&limit=100'));
    expect(await screen.findByText(/Wartung abgeschlossen/)).toBeTruthy();
    expect(screen.queryByText(/Dokument hochgeladen/)).toBeNull();
    fireEvent.change(screen.getByLabelText('Chronik von'),{target:{value:'2030-01-01'}});
    fireEvent.click(screen.getByRole('button',{name:'Chronik filtern'}));
    await waitFor(()=>expect(requestedPaths).toHaveBeenCalledWith('/sites/0/chronicle?type=maintenance_order.completed&from=2030-01-01&limit=100'));
    expect(await screen.findByText('Keine Ereignisse für die gewählten Filter vorhanden.')).toBeTruthy();
  });

  it('shows real backend document and maintenance KPIs on the object overview',async()=>{
    apiMock.mockImplementation(async(path:string)=>path==='/sites'?{sites:[],metrics:{
      total_sites:3,active_sites:2,preparation_sites:1,restricted_sites:0,critical_sites:0,
      sites_with_critical_hazards:0,sites_with_open_tasks:1,sites_with_understaffing:0,open_hazards:1,
      overdue_measures:2,open_tasks:4,overdue_tasks:1,open_shifts:2,undercovered_shifts:1,expiring_contracts:1,
      sites_without_available_documents:1,valid_documents:7,expired_documents:2,documents_expiring_7d:3,
      documents_expiring_30d:4,documents_review_due:5,unapproved_documents:6,missing_required_documents:8,
      open_maintenance:9,overdue_maintenance:10,
    }}:[]);
    renderSites();
    await waitFor(()=>expect(screen.queryByText('Objekte werden geladen …')).toBeNull());
    const metric=(label:string)=>screen.getByText(label).previousElementSibling?.textContent;
    expect(metric('Gültige Dokumente')).toBe('7');
    expect(metric('Abgelaufene Dokumente')).toBe('2');
    expect(metric('Dokumente ≤ 7 Tage')).toBe('3');
    expect(metric('Fehlende Pflichtdokumente')).toBe('8');
    expect(metric('Offene Wartungsaufträge')).toBe('9');
    expect(metric('Überfällige Wartungsaufträge')).toBe('10');
  });

  it('keeps the object-name column as a protected navigation anchor',async()=>{
    apiMock.mockResolvedValue(sites.slice(0,1));
    renderSites();
    await screen.findByRole('button',{name:'Objekt 01'});
    const picker=screen.getByText('Spalten').closest('details')!;
    const nameToggle=within(picker).getByLabelText('Objekt') as HTMLInputElement;
    expect(nameToggle.checked).toBe(true);
    fireEvent.click(nameToggle);
    expect((within(picker).getByLabelText('Objekt') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole('columnheader',{name:'Objekt'})).toBeTruthy();
  });

  it('hides object header quick actions behind their existing permissions',async()=>{
    permissionMock.mockImplementation(code=>code==='sites:read'||code==='sites:write');
    apiMock.mockImplementation(async(path:string)=>path==='/sites'?sites.slice(0,1):path==='/customers'||path==='/employees'?[]:{
      site:sites[0],customers:null,contracts:null,locations:[],hazards:[],instructions:[],journal:null,staffing:null,shifts:null,patrols:null,
      keys:null,keyBundles:null,documents:null,alarms:null,incidents:null,customerTasks:null,maintenance:null,maintenanceOrders:null,
      qualifications:null,handovers:null,devices:null,
    });
    renderSites();
    fireEvent.click(await screen.findByRole('button',{name:'Objekt 01'}));
    expect(await screen.findByRole('button',{name:'Objekt bearbeiten'})).toBeTruthy();
    expect(screen.queryByRole('button',{name:'Mitarbeiter zuweisen'})).toBeNull();
    expect(screen.queryByRole('button',{name:'Aufgabe erstellen'})).toBeNull();
    expect(screen.queryByRole('button',{name:'Dokument hinzufügen'})).toBeNull();
    expect(screen.queryByRole('button',{name:'Vorfall erfassen'})).toBeNull();
  });

  it('reports list, detail and chronicle failures as separate error states',async()=>{
    apiMock.mockRejectedValue(new Error('list offline'));
    renderSites();
    expect((await screen.findByRole('alert')).textContent).toContain('Objektübersicht konnte nicht geladen werden');
  });

  it('reports a failed object file load without hiding the overview list error channel',async()=>{
    apiMock.mockImplementation(async(path:string)=>path==='/sites'?sites.slice(0,1):Promise.reject(new Error('detail offline')));
    renderSites();
    fireEvent.click(await screen.findByRole('button',{name:'Objekt 01'}));
    expect((await screen.findByRole('alert')).textContent).toContain('Objektakte konnte nicht geladen werden');
  });

  it('reports a failed chronicle load independently of the object context',async()=>{
    apiMock.mockImplementation(async(path:string)=>{
      if(path==='/sites')return sites.slice(0,1);
      if(path==='/customers'||path==='/employees')return [];
      if(path.startsWith('/sites/0/chronicle'))throw new Error('chronicle offline');
      return {site:sites[0],customers:[],contracts:[],locations:[],hazards:[],instructions:[],journal:[],staffing:[],shifts:[],patrols:null,keys:null,keyBundles:null,documents:[],documentRequirements:[],alarms:[],incidents:[],customerTasks:[],maintenance:[],maintenanceOrders:[],qualifications:[],handovers:[],devices:[]};
    });
    renderSites();
    fireEvent.click(await screen.findByRole('button',{name:'Objekt 01'}));
    expect((await screen.findByRole('alert')).textContent).toContain('Chronik konnte nicht geladen werden');
  });

  it('uses server-derived document, personnel and maintenance evidence and renders chronicle links',async()=>{
    const context={
      site:sites[0],customers:[],contracts:[],locations:[],hazards:[],instructions:[],journal:[],
      staffing:[],shifts:[],patrols:null,keys:null,keyBundles:null,documents:[],
      documentStatusCounts:{gueltig:8,lauf_bald_ab:0,bald_pruefpflichtig:1,abgelaufen:2,fehlend:1,nicht_freigegeben:1,pruefung_ausstehend:1,noch_nicht_gueltig:0},
      documentWarningCounts:{expired:2,within_7_days:3,within_8_30_days:4,within_31_60_days:1,beyond_60_days:0,no_expiry:5},
      documentRequirements:[],
      alarms:[],incidents:[],customerTasks:[],maintenance:[],maintenanceOrders:[],
      maintenanceStatusCounts:{planned:1,open:2,in_progress:3,overdue:1,completed:4,cancelled:0},
      qualifications:[],
      personnelSummary:{assigned_employee_count:4,expiring_qualification_count:1,invalid_qualification_count:0,expiring_qualifications:[{employee_id:'employee-1',employee_name:'Mia Guard',code:'first_aid',qualification_name:'Erste Hilfe',days_until_expiry:12}],pending_acknowledgement_count:1,missing_acknowledgements:[{instruction_id:'instruction-1',title:'Evacuation',version:2,missing_employee_ids:['employee-2'],missing_employees:[{employee_id:'employee-2',employee_name:'Leo Guard'}]}]},
      recentPersonnelChanges:[{occurred_at:'2026-11-25T10:00:00Z',event_type:'employee.object_assignment.created',entity_id:'assignment-1',employee_id:'employee-2',employee_name:'Leo Guard',actor_email:'admin@example.test',details:{}}],
      handovers:[],devices:[],
    };
    const events=[{id:'event-1',site_id:'0',occurred_at:'2026-11-25T12:00:00Z',event_kind:'maintenance_order.completed',entity_type:'maintenance_order',entity_id:'order-1',category:'Technik & Wartung',summary:'Wartung abgeschlossen',details:{},actor_user_id:null,actor_email:null,actor_employee_name:null,source_table:'audit_events',link:{target:'/sites/0/technik',label:'Wartungsauftrag öffnen',permission:'devices:read'}}];
    apiMock.mockImplementation(async(path:string)=>path==='/sites'?sites.slice(0,1):path==='/customers'||path==='/employees'?[]:path.startsWith('/sites/0/chronicle')?{site_id:'0',events}:context);
    renderSites();
    fireEvent.click(await screen.findByRole('button',{name:'Objekt 01'}));
    expect(await screen.findByText(/Bald ablaufende Qualifikationen: 1/)).toBeTruthy();
    expect(screen.getByText(/Ausstehende Dienstanweisungs-Kenntnisnahmen: 1/)).toBeTruthy();
    expect(screen.getByText(/Geplant 1 · offen 2 · in Bearbeitung 3/)).toBeTruthy();
    expect(await screen.findByRole('heading',{name:'Personalüberblick'})).toBeTruthy();
    expect(screen.getByText(/Erste Hilfe/)).toBeTruthy();
    expect(screen.getAllByText(/Leo Guard/).length).toBeGreaterThan(0);
    expect(screen.getByText(/employee.object_assignment.created/)).toBeTruthy();
    expect(screen.getByRole('link',{name:'Wartungsauftrag öffnen'}).getAttribute('href')).toBe('/sites/0/technik');
    fireEvent.click(screen.getByRole('button',{name:'Journal'}));
    expect(await screen.findByRole('link',{name:'Wartungsauftrag öffnen'})).toBeTruthy();
  });
});
