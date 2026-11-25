/** @vitest-environment jsdom */
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {MemoryRouter,Route,Routes} from 'react-router-dom';

const apiMock=vi.hoisted(()=>vi.fn());
vi.mock('../src/lib/api',()=>({api:apiMock,hasPermission:()=>true}));
import {Sites} from '../src/pages/Sites';

const sites=Array.from({length:12},(_,index)=>({
  id:String(index),name:`Objekt ${String(index+1).padStart(2,'0')}`,site_number:`S${index+1}`,address:'Berlin',status:index===0?'active':'planning',security_classification:'unknown',
}));
beforeEach(()=>{cleanup();apiMock.mockReset();});
const renderSites=()=>render(<MemoryRouter initialEntries={['/sites']}><Routes><Route path="/sites" element={<Sites/>}/><Route path="/sites/:siteId" element={<Sites/>}/><Route path="/sites/:siteId/:section" element={<Sites/>}/></Routes></MemoryRouter>);

describe('Objektübersicht',()=>{
  it('filters, sorts and paginates actual site data',async()=>{
    apiMock.mockResolvedValue(sites);
    renderSites();
    expect(await screen.findByText('12 Objekte · Seite 1 von 2')).toBeTruthy();
    expect(screen.queryByRole('button',{name:'Objekt 12'})).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'Weiter'}));
    expect(screen.getByRole('button',{name:'Objekt 12'})).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'Objekt'}));
    expect(screen.getByRole('button',{name:'Objekt 12'})).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Status'),{target:{value:'active'}});
    expect(screen.getByText('1 Objekte · Seite 1 von 1')).toBeTruthy();
    expect(screen.getByRole('button',{name:'Objekt 01'})).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Objekte suchen'),{target:{value:'nicht vorhanden'}});
    expect(screen.getByText('Keine Objekte entsprechen den aktiven Filtern.')).toBeTruthy();
  });

  it('saves cleared optional site fields as null',async()=>{
    apiMock.mockImplementation(async(_path:string,options?:RequestInit)=>options?.method==='PATCH'?{}:sites.slice(0,1));
    renderSites();
    const row=(await screen.findByRole('button',{name:'Objekt 01'})).closest('tr')!;
    fireEvent.click(within(row).getByRole('button',{name:'Bearbeiten'}));
    fireEvent.change(screen.getByLabelText('Objektnummer'),{target:{value:''}});
    fireEvent.change(screen.getByLabelText('Adresse'),{target:{value:''}});
    fireEvent.click(screen.getByRole('button',{name:'Speichern'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith('/sites/0',expect.objectContaining({method:'PATCH',body:expect.stringContaining('"site_number":null')})));
    expect(JSON.parse(apiMock.mock.calls.find(([,options])=>options?.method==='PATCH')![1].body).address).toBeNull();
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
    fireEvent.click(screen.getByRole('button',{name:'Gefährdungen'}));
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
      hazards:[{id:'hazard-1',title:'Loading bay fire risk',category:'fire',description:'Original risk',likelihood:2,impact:3,risk_score:6,protective_measures:'Extinguishers',required_actions:'Inspect monthly',responsible_employee_id:null,due_on:'2026-12-01',review_on:'2026-12-15',status:'open',location_id:null,location_name:null,responsible_employee_name:null}],
      instructions:[],journal:null,staffing:[{id:'assignment-1',employee_id:'assigned',employee_name:'Site Guard'}],shifts:null,patrols:null,keys:null,keyBundles:null,documents:null,alarms:null,incidents:null,customerTasks:null,maintenance:null,qualifications:null,handovers:null,
    };
    apiMock.mockImplementation(async(path:string,options?:RequestInit)=>path==='/sites'?sites.slice(0,1):path==='/customers'?[]:path==='/employees'?[{id:'assigned',name:'Site Guard'},{id:'off-site',name:'Other employee'}]:options?.method==='PATCH'?{}:context);
    renderSites();
    fireEvent.click(await screen.findByRole('button',{name:'Objekt 01'}));
    fireEvent.click(await screen.findByRole('button',{name:'Gefährdungen'}));
    fireEvent.click(await screen.findByRole('button',{name:'Bearbeiten'}));
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
    fireEvent.click(await screen.findByRole('button',{name:'Personal & Dienste'}));
    expect(await screen.findByText('Mia Guard')).toBeTruthy();
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
    fireEvent.click(await screen.findByRole('button',{name:'Personal & Dienste'}));
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
    fireEvent.change(screen.getByLabelText('Dokumenttitel'),{target:{value:'Fluchtplan'}});
    const file=new File(['content'],'escape-plan.pdf',{type:'application/pdf'});
    Object.defineProperty(file,'arrayBuffer',{value:async()=>new TextEncoder().encode('content').buffer});
    const fileInput=screen.getByLabelText('Datei') as HTMLInputElement;
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
    fireEvent.click(await screen.findByRole('button',{name:'Einsätze & Alarme'}));
    expect(await screen.findByText('Assistance requested')).toBeTruthy();
    expect(screen.getByText('Respond to alarm')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button',{name:'Aufgaben & Wartung'}));
    expect(await screen.findByText('Review site access')).toBeTruthy();
    expect(screen.getByText('Inspect gate')).toBeTruthy();
    expect(await screen.findByRole('heading',{name:'Technik-/Instandhaltungseintrag erfassen'})).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Eintrag'),{target:{value:'Inspect backup generator'}});
    fireEvent.click(screen.getByRole('button',{name:'Im Wachbuch erfassen'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith('/watchbook/entries',expect.objectContaining({method:'POST'})));
    const maintenanceWrite=apiMock.mock.calls.find(([path,options])=>path==='/watchbook/entries'&&options?.method==='POST')!;
    expect(JSON.parse(maintenanceWrite[1].body)).toEqual(expect.objectContaining({site_id:'0',category_id:'maintenance-category',priority_code:'medium',content:'Inspect backup generator'}));
    expect(JSON.parse(maintenanceWrite[1].body).client_entry_id).toMatch(/^[0-9a-f-]{36}$/i);
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
    fireEvent.click(await screen.findByRole('button',{name:'Qualifikationen'}));
    expect(await screen.findByText('Mia Guard')).toBeTruthy();
    expect(screen.getByText(/Erste Hilfe/)).toBeTruthy();
    expect(screen.getByText(/Läuft bald ab/)).toBeTruthy();
    fireEvent.click(await screen.findByRole('button',{name:'Übergaben'}));
    expect(await screen.findByText('Night shift transfer')).toBeTruthy();
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
    fireEvent.click(await screen.findByRole('button',{name:'Personal & Dienste'}));
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
    fireEvent.click(await screen.findByRole('button',{name:'Berichte'}));
    const reportLink=await screen.findByRole('link',{name:'Berichte für dieses Objekt öffnen'});
    expect(reportLink.getAttribute('href')).toBe('/customer-reports?site_id=0');
  });
});
