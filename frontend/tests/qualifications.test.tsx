/** @vitest-environment jsdom */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {MemoryRouter,Route,Routes} from 'react-router-dom';

const apiMock=vi.hoisted(()=>vi.fn());
const permissionMock=vi.hoisted(()=>vi.fn((_code:string)=>true));
const fetchMock=vi.hoisted(()=>vi.fn());
vi.mock('../src/lib/api',()=>({
  api:apiMock,
  hasPermission:(code:string)=>permissionMock(code),
  storedUser:()=>({role:'admin',permissions:[]}),
  csrf:()=>'csrf-token',
}));

import {Qualifications} from '../src/pages/Qualifications';
import {EmployeeDetail} from '../src/pages/EmployeeDetail';
import {Sites} from '../src/pages/Sites';

const employeeId='00000000-0000-4000-8000-000000000111';
const catalogId='00000000-0000-4000-8000-000000000222';
const qualificationId='00000000-0000-4000-8000-000000000333';
const siteId='00000000-0000-4000-8000-000000000444';
const documentId='00000000-0000-4000-8000-000000000555';

const catalogEntry={id:catalogId,code:'first_aid',name:'Erste Hilfe',description:null,category:'Erste Hilfe und medizinische Qualifikationen',default_validity_days:365,required:true,required_document_type:'Nachweis',required_documents:[],active:true};
const overviewRow={
  id:qualificationId,employee_id:employeeId,employee_name:'Ava Worker',personnel_number:'P-100',
  qualification_name:'Erste Hilfe',code:'first_aid',category:'Erste Hilfe und medizinische Qualifikationen',
  site_name:'Objekt 01',issued_on:'2026-01-01',valid_from:'2026-01-01',valid_until:'2026-12-15',valid_until_source:'manual',
  computed_status:'expiring',status_label:'Läuft bald ab',issue_code:'expires_soon',
  days_until_expiry:18,remaining_validity:'Noch 18 Tage',
  document_title:'Nachweis Erste Hilfe',document_approval_status:'approved',document_status:'gueltig',
  catalog_id:catalogId,notes:null,catalog_active:true,created_at:'2026-01-01T10:00:00Z',updated_at:'2026-01-02T10:00:00Z',
};
const detailRow={...overviewRow,history:[{event_type:'qualification.created',details:null,created_at:'2026-01-01T10:00:00Z',actor_user_id:null}]};
const dmsDocument={id:documentId,employee_id:employeeId,title:'Nachweis Erste Hilfe',document_type:'Nachweis',approval_status:'approved',document_status:'gueltig',valid_from:'2026-01-01',valid_until:'2027-01-01',status_label:'Gültig',versions:[{id:'version-1',version_no:2,lifecycle_state:'available'}]};
const analytics={
  kpi:{total:12,valid:8,expiring:2,expired:1,invalid_revoked:1,missing_evidence:3},
  categories:[],expiring_30_days:[],expiring_90_days:[],missing_required:[],site_coverage:[],
};

function response(rows:unknown[],total=rows.length,pages=1){
  return {
    ok:true,
    status:200,
    headers:{get:(key:string)=>key==='X-Total-Count'?String(total):key==='X-Page-Count'?String(pages):null},
    json:async()=>rows,
    blob:async()=>new Blob(['csv']),
  };
}

function defaultApi(path:string){
  if(path==='/qualifications/analytics')return Promise.resolve(analytics);
  if(path==='/qualifications/catalog')return Promise.resolve([catalogEntry]);
  if(path==='/qualifications/categories')return Promise.resolve(['Erste Hilfe und medizinische Qualifikationen']);
  if(path==='/employees')return Promise.resolve([{id:employeeId,name:'Ava Worker'}]);
  if(path==='/sites')return Promise.resolve([{id:siteId,name:'Objekt 01'}]);
  if(path==='/dms/documents')return Promise.resolve([dmsDocument]);
  if(path==='/qualifications/reminders')return Promise.resolve({reminder_days:[90,30],updated_at:null});
  if(path==='/qualifications/reminders/history')return Promise.resolve([]);
  if(path===`/qualifications/assignments/${qualificationId}`)return Promise.resolve(detailRow);
  return Promise.resolve([]);
}

function renderQualifications(){
  render(<MemoryRouter><Qualifications/></MemoryRouter>);
}

function postedBody(path:string):Record<string,unknown>|null{
  const call=apiMock.mock.calls.find(([url,options])=>url===path&&['POST','PATCH'].includes(String((options as RequestInit|undefined)?.method)));
  const body=call?.[1] as RequestInit|undefined;
  return body?.body?JSON.parse(String(body.body)) as Record<string,unknown>:null;
}

beforeEach(()=>{
  cleanup();
  apiMock.mockReset();
  permissionMock.mockReset();
  permissionMock.mockReturnValue(true);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async(url:string)=>response(String(url).includes('/qualifications/overview')?[overviewRow]:[]));
  vi.stubGlobal('fetch',fetchMock);
});

afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});

describe('Qualifikationsverwaltung',()=>{
  it('zeigt Kennzahlen und klassifizierte Zeilen aus dem Backend',async()=>{
    apiMock.mockImplementation(defaultApi);
    renderQualifications();
    const kpis=await screen.findByRole('group',{name:'Qualifikationskennzahlen'});
    expect(within(kpis).getByLabelText('Gesamt').textContent).toContain('12');
    expect(within(kpis).getByLabelText('Läuft bald ab').textContent).toContain('2');
    expect(within(kpis).getByLabelText('Nachweis fehlt').textContent).toContain('3');
    const table=await screen.findByRole('table',{name:'Qualifikationsübersicht'});
    expect(within(table).getByText('Läuft bald ab')).toBeTruthy();
    expect(within(table).getByText('Ava Worker (P-100)')).toBeTruthy();
    expect(within(table).getByText('Noch 18 Tage')).toBeTruthy();
  });

  it('sendet Filter, Sortierung und Seite als Querystring an den Server',async()=>{
    fetchMock.mockImplementation(async(url:string)=>response(String(url).includes('/qualifications/overview')?[overviewRow]:[],12,4));
    apiMock.mockImplementation(defaultApi);
    renderQualifications();
    await waitFor(()=>expect(fetchMock).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('Status filtern'),{target:{value:'expired'}});
    fireEvent.change(screen.getByLabelText('Sortieren nach'),{target:{value:'employee'}});
    fireEvent.change(screen.getByLabelText('Sortierrichtung'),{target:{value:'desc'}});
    fireEvent.change(screen.getByLabelText('Einträge pro Seite'),{target:{value:'50'}});
    await waitFor(()=>{
      const url=String(fetchMock.mock.calls[fetchMock.mock.calls.length-1]?.[0]);
      expect(url).toContain('/api/v1/qualifications/overview?');
      expect(url).toContain('status=expired');
      expect(url).toContain('sort=employee');
      expect(url).toContain('dir=desc');
      expect(url).toContain('pageSize=50');
      expect(url).toContain('page=1');
    });
    fireEvent.click(screen.getByRole('button',{name:'Weiter'}));
    await waitFor(()=>expect(String(fetchMock.mock.calls[fetchMock.mock.calls.length-1]?.[0])).toContain('page=2'));
    const filterForm=screen.getByRole('form',{name:'Qualifikationen filtern'});
    fireEvent.click(within(filterForm).getByLabelText('Nachweis fehlt'));
    await waitFor(()=>expect(String(fetchMock.mock.calls[fetchMock.mock.calls.length-1]?.[0])).toContain('missing_evidence=true'));
    const kpis=await screen.findByRole('group',{name:'Qualifikationskennzahlen'});
    expect(within(kpis).getByLabelText('Nachweis fehlt').textContent).toContain('3');
  });

  async function catalogForm(){
    apiMock.mockImplementation(defaultApi);
    renderQualifications();
    const region=await screen.findByRole('region',{name:'Katalogverwaltung'});
    return {region,code:within(region).getByLabelText('Code'),name:within(region).getByLabelText('Bezeichnung'),reason:within(region).getByLabelText('Begründung für die Katalogänderung'),save:within(region).getByRole('button',{name:'Katalogeintrag speichern'})};
  }

  it('validiert den Katalogcode vor dem Speichern',async()=>{
    const {region,code,name,reason,save}=await catalogForm();
    fireEvent.change(code,{target:{value:'X'}});
    fireEvent.change(name,{target:{value:'Erste Hilfe'}});
    fireEvent.change(reason,{target:{value:'Gesetzliche Anforderung'}});
    fireEvent.click(save);
    expect((await within(region).findByRole('alert')).textContent).toContain('Code');
    expect(apiMock).not.toHaveBeenCalledWith('/qualifications/catalog',expect.objectContaining({method:'POST'}));
  });

  it('verlangt eine Begründung für Katalogänderungen',async()=>{
    const {region,code,name,save}=await catalogForm();
    fireEvent.change(code,{target:{value:'first_aid'}});
    fireEvent.change(name,{target:{value:'Erste Hilfe'}});
    fireEvent.click(save);
    expect((await within(region).findByRole('alert')).textContent).toContain('Begründung');
    expect(apiMock).not.toHaveBeenCalledWith('/qualifications/catalog',expect.objectContaining({method:'POST'}));
  });

  it('speichert einen gültigen Katalogeintrag mit Pflichtbegründung',async()=>{
    const {code,name,reason,save}=await catalogForm();
    fireEvent.change(code,{target:{value:'first_aid'}});
    fireEvent.change(name,{target:{value:'Erste Hilfe'}});
    fireEvent.change(reason,{target:{value:'Gesetzliche Anforderung'}});
    fireEvent.click(save);
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith('/qualifications/catalog',{
      method:'POST',
      body:JSON.stringify({code:'first_aid',name:'Erste Hilfe',description:null,category:null,default_validity_days:null,required:false,required_document_type:null,required_documents:[],active:true,reason:'Gesetzliche Anforderung'}),
    }));
  });

  it('erzwingt Begründungen für Widerruf und Entfernen',async()=>{
    apiMock.mockImplementation(defaultApi);
    renderQualifications();
    fireEvent.click(await screen.findByRole('button',{name:'Details zu Erste Hilfe von Ava Worker'}));
    const dialog=await screen.findByRole('dialog',{name:'Qualifikationsdetails'});
    fireEvent.click(within(dialog).getByRole('button',{name:'Widerrufen'}));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('Begründung');
    expect(apiMock).not.toHaveBeenCalledWith(expect.stringContaining('/revoke'),expect.anything());
    fireEvent.change(within(dialog).getByLabelText('Begründung für den Widerruf'),{target:{value:'Nachweis nicht mehr gültig'}});
    fireEvent.click(within(dialog).getByRole('button',{name:'Widerrufen'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith(`/employees/${employeeId}/qualifications/${qualificationId}/revoke`,{method:'POST',body:JSON.stringify({reason:'Nachweis nicht mehr gültig'})}));

    fireEvent.click(within(dialog).getByRole('button',{name:'Entfernen'}));
    await waitFor(()=>expect(within(dialog).getByRole('alert').textContent).toContain('Begründung'));
    expect(apiMock).not.toHaveBeenCalledWith(`/employees/${employeeId}/qualifications/${qualificationId}`,expect.objectContaining({method:'DELETE'}));
    fireEvent.change(within(dialog).getByLabelText('Begründung für das Entfernen'),{target:{value:'Fehlerhafte Erfassung'}});
    fireEvent.click(within(dialog).getByRole('button',{name:'Entfernen'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith(`/employees/${employeeId}/qualifications/${qualificationId}`,{method:'DELETE',body:JSON.stringify({reason:'Fehlerhafte Erfassung'})}));
  });

  it('verbirgt schreibende Aktionen ohne qualifications:write',async()=>{
    permissionMock.mockImplementation((code:string)=>code==='qualifications:read');
    apiMock.mockImplementation(defaultApi);
    renderQualifications();
    await screen.findByRole('table',{name:'Qualifikationsübersicht'});
    expect(screen.queryByRole('button',{name:'Qualifikation speichern'})).toBeNull();
    expect(screen.queryByRole('button',{name:'Katalogeintrag speichern'})).toBeNull();
    expect(screen.queryByRole('button',{name:'Erinnerungen speichern'})).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'Details zu Erste Hilfe von Ava Worker'}));
    const dialog=await screen.findByRole('dialog',{name:'Qualifikationsdetails'});
    expect(within(dialog).queryByRole('button',{name:'Bearbeiten'})).toBeNull();
    expect(within(dialog).queryByRole('button',{name:'Widerrufen'})).toBeNull();
    expect(within(dialog).queryByRole('button',{name:'Entfernen'})).toBeNull();
    expect(apiMock.mock.calls.some(([,options])=>['POST','PATCH','DELETE','PUT'].includes(String((options as RequestInit|undefined)?.method)))).toBe(false);
  });

  it('lässt das Ablaufdatum leer, zeigt die Katalogvorschau und nutzt die DMS-Auswahl',async()=>{
    apiMock.mockImplementation(defaultApi);
    renderQualifications();
    const form=await screen.findByRole('form',{name:'Qualifikation einem Mitarbeiter zuweisen'});
    fireEvent.change(within(form).getByLabelText('Mitarbeiter'),{target:{value:employeeId}});
    fireEvent.change(within(form).getByLabelText('Qualifikation'),{target:{value:'first_aid'}});
    fireEvent.change(within(form).getByLabelText('Gültig ab'),{target:{value:'2026-01-01'}});
    fireEvent.change(within(form).getByLabelText('Begründung'),{target:{value:'Nachweis geprüft'}});
    expect(within(form).getByText(/Vorschau Ablaufdatum/).textContent).toContain('01.01.2027');
    const documentSelect=within(form).getByLabelText('Nachweisdokument');
    expect(documentSelect.tagName).toBe('SELECT');
    expect(within(documentSelect).getByRole('option',{name:/Nachweis Erste Hilfe/})).toBeTruthy();
    fireEvent.change(documentSelect,{target:{value:documentId}});
    fireEvent.click(within(form).getByRole('button',{name:'Qualifikation speichern'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith(`/employees/${employeeId}/qualifications`,expect.objectContaining({method:'POST'})));
    const body=postedBody(`/employees/${employeeId}/qualifications`);
    expect(body).toMatchObject({code:'first_aid',valid_from:'2026-01-01',reason:'Nachweis geprüft',document_id:documentId});
    expect('valid_until' in (body??{})).toBe(false);
  });

  it('zeigt die Herkunft des Ablaufdatums und löst die Nachweisverknüpfung ohne UUID-Eingabe',async()=>{
    apiMock.mockImplementation((path:string)=>path===`/qualifications/assignments/${qualificationId}`
      ?Promise.resolve({...detailRow,valid_until_source:'catalog_default',document_id:documentId})
      :defaultApi(path));
    renderQualifications();
    expect((await screen.findByRole('table',{name:'Qualifikationsübersicht'})).textContent).toContain('Manuell festgelegt');
    fireEvent.click(await screen.findByRole('button',{name:'Details zu Erste Hilfe von Ava Worker'}));
    const dialog=await screen.findByRole('dialog',{name:'Qualifikationsdetails'});
    expect(dialog.textContent).toContain('Herkunft: Aus Katalogstandard');
    fireEvent.click(within(dialog).getByRole('button',{name:'Bearbeiten'}));
    const form=within(dialog).getByRole('form',{name:'Qualifikation bearbeiten'});
    expect(form.textContent).toContain('Aktuell verknüpft: Nachweis Erste Hilfe');
    expect(within(form).queryByLabelText('Nachweisdokument (UUID)')).toBeNull();
    const documentSelect=within(form).getByLabelText('Nachweisdokument');
    expect(documentSelect.tagName).toBe('SELECT');
    expect((documentSelect as HTMLSelectElement).value).toBe(documentId);
    fireEvent.change(within(form).getByLabelText('Gültig bis bearbeiten'),{target:{value:''}});
    expect(within(form).getByText(/Vorschau Ablaufdatum/).textContent).toContain('01.01.2027');
    fireEvent.change(documentSelect,{target:{value:''}});
    fireEvent.change(within(form).getByLabelText('Begründung für die Änderung'),{target:{value:'Katalogstandard prüfen'}});
    fireEvent.click(within(form).getByRole('button',{name:'Änderung speichern'}));
    await waitFor(()=>expect(postedBody(`/employees/${employeeId}/qualifications/${qualificationId}`)).not.toBeNull());
    const body=postedBody(`/employees/${employeeId}/qualifications/${qualificationId}`);
    expect(body?.document_id).toBeNull();
    expect('valid_until' in (body??{})).toBe(false);
  });

  it('zeigt einen Analysek Fehler mit Retry statt dauerhaft zu laden und rendert die Objektabdeckung',async()=>{
    let fail=true;
    apiMock.mockImplementation((path:string)=>{
      if(path==='/qualifications/analytics'){
        return fail
          ?Promise.reject(new Error('Statistikdienst nicht erreichbar'))
          :Promise.resolve({...analytics,site_coverage:[{site_id:siteId,site:'Objekt 01',qualification_name:'Erste Hilfe',qualified:3,requirement_count:4}]});
      }
      return defaultApi(path);
    });
    renderQualifications();
    expect((await screen.findByRole('alert')).textContent).toContain('Statistikdienst nicht erreichbar');
    expect(screen.queryByText('Kennzahlen werden geladen …')).toBeNull();
    fail=false;
    fireEvent.click(screen.getByRole('button',{name:'Kennzahlen erneut laden'}));
    const kpis=await screen.findByRole('group',{name:'Qualifikationskennzahlen'});
    await waitFor(()=>expect(within(kpis).getByLabelText('Nachweis fehlt').textContent).toContain('3'));
    expect(screen.getByRole('table',{name:'Objektabdeckung'}).textContent).toContain('3');
    expect(screen.getByRole('table',{name:'Objektabdeckung'}).textContent).toContain('4');
  });

  it('gate den Nachweiszugriff an qualifications:documents:download',async()=>{
    permissionMock.mockImplementation((code:string)=>code==='qualifications:read'||code==='qualifications:write');
    apiMock.mockImplementation(defaultApi);
    renderQualifications();
    fireEvent.click(await screen.findByRole('button',{name:'Details zu Erste Hilfe von Ava Worker'}));
    const dialog=await screen.findByRole('dialog',{name:'Qualifikationsdetails'});
    expect(within(dialog).queryByRole('button',{name:'Nachweis öffnen'})).toBeNull();
    expect(apiMock).not.toHaveBeenCalledWith(expect.stringContaining('/document'),expect.anything());
  });
});

describe('Qualifikationen im Mitarbeiterprofil',()=>{
  it('zeigt den berechneten Status aus dem Backend',async()=>{
    const profile={
      employee:{id:employeeId,name:'Ava Worker',email:'ava@example.com',employment_status:'active',employment_type:'full_time'},
      contracts:[],
      qualifications:[{...detailRow,computed_status:'expiring',status_label:null}],
      absences:[],object_assignments:[],work_time:[],documents:[],availability:[],
    };
    apiMock.mockImplementation((path:string)=>path===`/employees/${employeeId}/profile`?Promise.resolve(profile):defaultApi(path));
    render(<MemoryRouter initialEntries={[`/employees/${employeeId}`]}><Routes>
      <Route path="/employees/:employeeId/:section" element={<EmployeeDetail/>}/>
      <Route path="/employees/:employeeId" element={<EmployeeDetail/>}/>
    </Routes></MemoryRouter>);
    const overviewCard=await screen.findByRole('heading',{name:'Nächste Qualifikationsdaten'});
    expect(overviewCard.parentElement?.textContent).toContain('Läuft bald ab');
    fireEvent.click(within(screen.getByRole('navigation',{name:'Mitarbeiterbereiche'})).getByRole('button',{name:'Qualifikationen'}));
    const table=await screen.findByRole('table',{name:'Qualifikationen'});
    expect(within(table).getByText('Läuft bald ab')).toBeTruthy();
  });

  it('verwendet im Mitarbeiterprofil die DMS-Auswahl und omits ein leeres Ablaufdatum',async()=>{
    const profile={
      employee:{id:employeeId,name:'Ava Worker',email:'ava@example.com',employment_status:'active',employment_type:'full_time'},
      contracts:[],
      qualifications:[{...detailRow,catalog_id:catalogId,valid_from:'2026-01-01',valid_until:'2026-12-15',valid_until_source:'manual',document_id:documentId}],
      absences:[],object_assignments:[],work_time:[],documents:[],availability:[],
    };
    apiMock.mockImplementation((path:string)=>path===`/employees/${employeeId}/profile`?Promise.resolve(profile):defaultApi(path));
    render(<MemoryRouter initialEntries={[`/employees/${employeeId}/qualifikationen`]}><Routes>
      <Route path="/employees/:employeeId/:section" element={<EmployeeDetail/>}/>
      <Route path="/employees/:employeeId" element={<EmployeeDetail/>}/>
    </Routes></MemoryRouter>);
    const table=await screen.findByRole('table',{name:'Qualifikationen'});
    expect(table.textContent).toContain('Manuell festgelegt');
    fireEvent.click(within(table).getByRole('button',{name:'Bearbeiten'}));
    const form=await screen.findByRole('form',{name:'Qualifikation bearbeiten'});
    expect(form.textContent).toContain('Aktuell verknüpft: Nachweis Erste Hilfe');
    const documentSelect=within(form).getByLabelText('Nachweisdokument');
    expect(documentSelect.tagName).toBe('SELECT');
    expect((documentSelect as HTMLSelectElement).value).toBe(documentId);
    fireEvent.change(within(form).getByLabelText('Gültig bis'),{target:{value:''}});
    expect(within(form).getByText(/Vorschau Ablaufdatum/).textContent).toContain('01.01.2027');
    fireEvent.change(documentSelect,{target:{value:''}});
    fireEvent.change(within(form).getByLabelText('Begründung für die Qualifikation'),{target:{value:'Nachweis gelöst'}});
    fireEvent.click(within(form).getByRole('button',{name:'Änderung speichern'}));
    await waitFor(()=>expect(postedBody(`/employees/${employeeId}/qualifications/${qualificationId}`)).not.toBeNull());
    const body=postedBody(`/employees/${employeeId}/qualifications/${qualificationId}`);
    expect(body?.document_id).toBeNull();
    expect('valid_until' in (body??{})).toBe(false);
  });

  it('blendet den Nachweiszugriff ohne documents:download aus',async()=>{
    permissionMock.mockImplementation((code:string)=>code!=='qualifications:documents:download');
    const profile={
      employee:{id:employeeId,name:'Ava Worker',email:'ava@example.com',employment_status:'active',employment_type:'full_time'},
      contracts:[],qualifications:[{...detailRow}],absences:[],object_assignments:[],work_time:[],documents:[],availability:[],
    };
    apiMock.mockImplementation((path:string)=>path===`/employees/${employeeId}/profile`?Promise.resolve(profile):defaultApi(path));
    render(<MemoryRouter initialEntries={[`/employees/${employeeId}/qualifikationen`]}><Routes>
      <Route path="/employees/:employeeId/:section" element={<EmployeeDetail/>}/>
      <Route path="/employees/:employeeId" element={<EmployeeDetail/>}/>
    </Routes></MemoryRouter>);
    const table=await screen.findByRole('table',{name:'Qualifikationen'});
    expect(within(table).queryByRole('button',{name:'Nachweis öffnen'})).toBeNull();
    expect(apiMock).not.toHaveBeenCalledWith(expect.stringContaining('/document'),expect.anything());
  });
});

describe('Pflichtqualifikationen in der Objektakte',()=>{
  it('sendet die Anforderung mit Begründung und Verantwortlichem',async()=>{
    const context={
      site:{id:siteId,name:'Objekt 01',site_number:'OBJ-01',address:'Berlin',status:'active',security_classification:'medium',required_staff_count:2},
      customers:[],contracts:[],locations:[],hazards:[],instructions:[],journal:[],staffing:[],assignmentHistory:[],
      shifts:[],patrols:null,keys:null,keyBundles:null,documents:[],documentRequirements:[],
      alarms:[],incidents:[],customerTasks:[],maintenance:[],maintenanceOrders:[],qualifications:[],handovers:[],devices:[],
    };
    apiMock.mockImplementation((path:string)=>{
      if(path===`/sites/${siteId}/object-context`)return Promise.resolve(context);
      if(path===`/sites/${siteId}/qualification-requirements`)return Promise.resolve([]);
      if(path==='/qualifications/catalog')return Promise.resolve([catalogEntry]);
      if(path==='/employees')return Promise.resolve([{id:employeeId,name:'Ava Worker'}]);
      return Promise.resolve([]);
    });
    render(<MemoryRouter initialEntries={[`/sites/${siteId}/personal`]}><Routes>
      <Route path="/sites/:siteId/:section" element={<Sites/>}/>
      <Route path="/sites/:siteId" element={<Sites/>}/>
    </Routes></MemoryRouter>);
    const form=await screen.findByRole('form',{name:'Pflichtqualifikation hinterlegen'});
    fireEvent.change(within(form).getByLabelText('Pflichtqualifikation aus Katalog'),{target:{value:catalogId}});
    fireEvent.change(within(form).getByLabelText('Verantwortlich für die Qualifikation'),{target:{value:employeeId}});
    fireEvent.change(within(form).getByLabelText('Begründung'),{target:{value:'Objektbezogene Pflicht'}});
    fireEvent.click(within(form).getByRole('button',{name:'Pflichtqualifikation speichern'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith(`/sites/${siteId}/qualification-requirements`,{
      method:'POST',
      body:JSON.stringify({catalog_id:catalogId,required:true,active:true,responsible_employee_id:employeeId,notes:null,reason:'Objektbezogene Pflicht'}),
    }));
  });

  const requirement={id:'requirement-1',site_id:siteId,catalog_id:catalogId,code:'first_aid',qualification_name:'Erste Hilfe',category:null,required:true,active:true,responsible_employee_id:null,notes:null};
  const shift={id:'shift-1',period_id:'period-1',period_name:'Frühschicht',period_status:'published',period_starts_at:'2026-01-01T06:00:00Z',period_ends_at:'2026-01-01T14:00:00Z',role_code:'security_training',starts_at:'2026-01-01T06:00:00Z',ends_at:'2026-01-01T14:00:00Z',assigned_count:1,assignments:[{id:'assignment-1',employee_id:employeeId,employee_name:'Ava Worker'}]};
  const siteContext=(overrides:Record<string,unknown>={})=>({
    site:{id:siteId,name:'Objekt 01',site_number:'OBJ-01',address:'Berlin',status:'active',security_classification:'medium',required_staff_count:2},
    customers:[],contracts:[],locations:[],hazards:[],instructions:[],journal:[],staffing:[],assignmentHistory:[],
    shifts:[],patrols:null,keys:null,keyBundles:null,documents:[],documentRequirements:[],
    alarms:[],incidents:[],customerTasks:[],maintenance:[],maintenanceOrders:[],qualifications:[],handovers:[],devices:[],
    ...overrides,
  });
  const renderSite=(section:string)=>render(<MemoryRouter initialEntries={[`/sites/${siteId}/${section}`]}><Routes>
    <Route path="/sites/:siteId/:section" element={<Sites/>}/>
    <Route path="/sites/:siteId" element={<Sites/>}/>
  </Routes></MemoryRouter>);

  it('sendet den Deaktivierungsgrund der Objektanforderung mit',async()=>{
    apiMock.mockImplementation((path:string)=>{
      if(path===`/sites/${siteId}/object-context`)return Promise.resolve(siteContext());
      if(path===`/sites/${siteId}/qualification-requirements`)return Promise.resolve([requirement]);
      if(path==='/qualifications/catalog')return Promise.resolve([catalogEntry]);
      if(path==='/employees')return Promise.resolve([{id:employeeId,name:'Ava Worker'}]);
      return Promise.resolve([]);
    });
    vi.spyOn(window,'prompt').mockReturnValue('Anforderung veraltet');
    renderSite('personal');
    fireEvent.click(await screen.findByRole('button',{name:'Anforderung deaktivieren'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith(`/sites/${siteId}/qualification-requirements/${requirement.id}`,{
      method:'DELETE',body:JSON.stringify({reason:'Anforderung veraltet'}),
    }));
  });

  it('zeigt neue Eligibility-Reason-Codes deutsch an',async()=>{
    const verdict={
      shift_id:shift.id,site_id:siteId,required_qualification_codes:['first_aid'],
      employees:[{employee_id:employeeId,employee_name:'Ava Worker',status:'restricted',
        reasons:[
          {code:'qualification_not_yet_valid',message:'qualification_not_yet_valid',link:null},
          {code:'qualification_evidence_missing',message:'qualification_evidence_missing',link:null},
          {code:'qualification_evidence_unapproved',message:'qualification_evidence_unapproved',link:null},
        ],
        matched_qualification_codes:[],missing_qualification_codes:['first_aid']}],
    };
    apiMock.mockImplementation((path:string)=>{
      if(path===`/sites/${siteId}/object-context`)return Promise.resolve(siteContext({shifts:[shift]}));
      if(path===`/sites/${siteId}/qualification-requirements`)return Promise.resolve([]);
      if(path===`/sites/${siteId}/shifts/${shift.id}/eligibility`)return Promise.resolve(verdict);
      if(path==='/qualifications/catalog')return Promise.resolve([catalogEntry]);
      if(path==='/employees')return Promise.resolve([{id:employeeId,name:'Ava Worker'}]);
      return Promise.resolve([]);
    });
    renderSite('dienstplanung');
    expect(await screen.findByText('Qualifikation noch nicht gültig')).toBeTruthy();
    expect(screen.getByText('Qualifikationsnachweis fehlt')).toBeTruthy();
    expect(screen.getByText('Qualifikationsnachweis nicht freigegeben')).toBeTruthy();
    expect(screen.queryByText('Keine Berechtigung für die serverseitige Einsatzprüfung.')).toBeNull();
  });

  it('stellt Eligibility-Fehler nicht als fehlende Berechtigung dar',async()=>{
    apiMock.mockImplementation((path:string)=>{
      if(path===`/sites/${siteId}/object-context`)return Promise.resolve(siteContext({shifts:[shift]}));
      if(path===`/sites/${siteId}/qualification-requirements`)return Promise.resolve([]);
      if(path===`/sites/${siteId}/shifts/${shift.id}/eligibility`)return Promise.reject(Object.assign(new Error('Prüfdienst nicht erreichbar'),{status:500}));
      if(path==='/qualifications/catalog')return Promise.resolve([catalogEntry]);
      if(path==='/employees')return Promise.resolve([{id:employeeId,name:'Ava Worker'}]);
      return Promise.resolve([]);
    });
    renderSite('dienstplanung');
    expect((await screen.findByRole('alert')).textContent).toContain('Prüfdienst nicht erreichbar');
    expect(screen.queryByText('Keine Berechtigung für die serverseitige Einsatzprüfung.')).toBeNull();
  });
});
