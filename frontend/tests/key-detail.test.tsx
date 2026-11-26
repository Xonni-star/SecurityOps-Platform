/** @vitest-environment jsdom */
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {MemoryRouter,Route,Routes} from 'react-router-dom';

const apiMock=vi.hoisted(()=>vi.fn());
const permissionMock=vi.hoisted(()=>vi.fn());
const fetchMock=vi.hoisted(()=>vi.fn());
vi.mock('../src/lib/api',()=>({
  api:apiMock,
  hasPermission:(code:string)=>permissionMock(code),
  csrf:()=>'csrf-token',
  storedUser:()=>({id:'self-user-id',email:'self@example.invalid',role:'user',permissions:[]}),
}));
vi.mock('qrcode',()=>({toDataURL:vi.fn(async()=>'data:image/png;base64,qr')}));
import {KeyDetail} from '../src/pages/KeyDetail';
import {holderOptions,type EmployeeOption,type KeyProfile,type KeyRow} from '../src/pages/keyParts';

const keyId='00000000-0000-4000-8000-000000000001';
const siteId='00000000-0000-4000-8000-000000000011';
const employeeId='00000000-0000-4000-8000-000000000012';
const key:KeyRow={
  id:keyId,key_code:'K-1001',label:'Haupteingang',key_type:'physical',status:'available',site_id:siteId,site_name:'Objekt Nord',
  location:'Flur 1',building:'Haus A',area:'EG',access_point:'Tor 1',holder_user_id:null,holder_employee_id:null,
  holder_name:null,holder_personnel_number:null,holder_status:null,due_at:null,issued_at:null,returned_at:null,
  lost_at:null,deactivated_at:null,last_movement_at:'2026-11-25T10:00:00Z',last_movement_type:'created',
  bundle_id:null,bundle_name:null,responsible_employee_id:null,responsible_name:null,created_at:'2026-11-01T10:00:00Z',
};
const profile:KeyProfile={
  key,holder:null,site:{id:siteId,name:'Objekt Nord',site_number:'S-11',site_status:'active'},bundle:null,
  recent_movements:[{id:'m-2',key_id:keyId,key_code:'K-1001',movement_type:'created',created_at:'2026-11-01T10:00:00Z',actor_name:'System'}],
  loss_reports:[{id:'report-1',status:'reported',lost_at:'2026-11-20T10:00:00Z',reported_at:'2026-11-21T10:00:00Z',reporter_name:'Mia Guard',description:'Schlüssel nicht zurückgegeben',risk_assessment:'Zutritt',immediate_measures:'Tor sperren',follow_up:'Ersatz besorgen',notes:'Erste Meldung',incident_id:null}],
  inventory_checks:[{id:'check-1',checked_at:'2026-11-25T10:00:00Z',checker_name:'Leo Wache',site_name:'Objekt Nord',notes:'Alles vorhanden',items:[{key_id:keyId,expected_present:true,found:true,actual_condition:'good'}]}],
  reminder_state:{overdue:false},
  visible_sections:{master:true,history:true,qr:true,loss_reports:true,inventory:true},
};
const sites=[{id:siteId,name:'Objekt Nord',site_number:'S-11'},{id:'site-2',name:'Objekt Süd',site_number:'S-12'}];
const employees=[{id:employeeId,name:'Mia Guard',first_name:'Mia',last_name:'Guard',employee_number:'P-7',department:'Wache',status:'active'}];
const historyEntries=[
  {id:'h-2',key_id:keyId,key_code:'K-1001',movement_type:'issued',previous_status:'available',new_status:'issued',actor_name:'Mia Guard',holder_employee_name:'Mia Guard',site_name:'Objekt Nord',reason:'Schichtwechsel',incident_id:'INC-1',receipt_id:'REC-1',created_at:'2026-11-25T12:00:00Z'},
  {id:'h-1',key_id:keyId,key_code:'K-1001',movement_type:'created',from_status:null,to_status:'available',actor_name:'System',reason:null,created_at:'2026-11-24T12:00:00Z'},
];
const response=(body:unknown,headers:Record<string,string>={})=>({ok:true,status:200,headers:{get:(name:string)=>headers[name]??null},json:async()=>body});
const defaultApi=async(path:string)=>{
  if(path===`/keys/${keyId}`)return profile;
  if(path==='/sites')return sites;
  if(path==='/employees')return employees;
  if(path==='/key-bundles')return [];
  if(path==='/keys?pageSize=100')return [key];
  if(path===`/keys/${keyId}/qr`)return {token:'hidden-token',url:'https://example.invalid/key/qr',expires_at:'2026-12-01T00:00:00Z'};
  return {};
};
type ApiHandler=(path:string,options?:RequestInit)=>Promise<unknown>;
const renderDetail=(section='uebersicht',data=profile,query='',apiHandler?:ApiHandler)=>{
  apiMock.mockImplementation(apiHandler??(async(path:string,options?:RequestInit)=>{
    if(path===`/keys/${keyId}`&&options?.method==='PATCH')return {};
    if(path.startsWith(`/keys/${keyId}/loss-reports/`))return {};
    return path===`/keys/${keyId}`?data:defaultApi(path);
  }));
  return render(<MemoryRouter initialEntries={[`${section==='root'?'/keys':`/keys/${keyId}/${section}`}${query}`]}><Routes>
    <Route path="/keys" element={<p>Schlüsselübersicht</p>}/>
    <Route path="/keys/:keyId" element={<KeyDetail/>}/>
    <Route path="/keys/:keyId/:section" element={<KeyDetail/>}/>
  </Routes></MemoryRouter>);
};
const bodyOf=(path:string,method='POST')=>{
  const call=[...apiMock.mock.calls].reverse().find(([requestPath,options])=>requestPath===path&&(options?.method??'GET')===method);
  return JSON.parse(String(call?.[1]?.body??'{}')) as Record<string,unknown>;
};

beforeEach(()=>{
  cleanup();apiMock.mockReset();permissionMock.mockReset();fetchMock.mockReset();
  permissionMock.mockReturnValue(true);apiMock.mockImplementation(defaultApi);
  fetchMock.mockImplementation(async(input:string)=>{
    if(String(input).includes(`/keys/${keyId}/history`))return response(historyEntries,{'X-Total-Count':'2','X-Page':'1','X-Page-Size':'10','X-Page-Count':'1'});
    return response([]);
  });
  vi.stubGlobal('fetch',fetchMock);
  vi.stubGlobal('confirm',vi.fn(()=>true));
  vi.stubGlobal('print',vi.fn());
});

describe('Schlüsselakte',()=>{
  it('shows safe fallback sections when visible_sections is missing',async()=>{
    renderDetail('stammdaten',{...profile,visible_sections:undefined});
    expect(await screen.findByLabelText('Bezeichnung')).toBeTruthy();
    expect(screen.queryByText(/Keine Berechtigung für/)).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'Historie'}));
    expect(await screen.findByText(/Schichtwechsel/)).toBeTruthy();
  });

  it('keeps the file usable and shows fallback text for denied sections',async()=>{
    renderDetail('stammdaten',{...profile,visible_sections:{master:false,history:false,qr:false,loss_reports:false,inventory:false}});
    expect(await screen.findByText('Keine Berechtigung für Stammdaten.')).toBeTruthy();
    expect(screen.getByRole('heading',{name:'Haupteingang'})).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'Übersicht'}));
    expect(await screen.findByText('Keine Berechtigung für Verlustmeldungen.')).toBeTruthy();
    expect(screen.getAllByText(/K-1001/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button',{name:'QR/Etikett'}));
    expect(screen.getByText('Keine Berechtigung für QR/Etikett.')).toBeTruthy();
  });

  it('renders enriched chronological history with actor, status, reason and reference',async()=>{
    renderDetail('historie');
    expect(await screen.findByText(/Ausgeführt von Mia Guard/)).toBeTruthy();
    expect(screen.getByText(/Halter: Mia Guard/)).toBeTruthy();
    expect(screen.getByText(/Status: available → issued/)).toBeTruthy();
    expect(screen.getByText(/Grund: Schichtwechsel/)).toBeTruthy();
    expect(screen.getByText(/Vorfall: INC-1/)).toBeTruthy();
    expect(screen.getByText(/Beleg: REC-1/)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining(`/keys/${keyId}/history?page=1&pageSize=10`),expect.anything());
  });

  it('links the object section to the existing object key tab with the key query',async()=>{
    renderDetail('standort');
    const link=await screen.findByRole('link',{name:'Objektseite öffnen'});
    expect(link.getAttribute('href')).toBe(`/sites/${siteId}/schluessel?key=${keyId}`);
    fireEvent.click(screen.getByRole('button',{name:'Übersicht'}));
    expect(screen.getAllByRole('link',{name:'Objektseite öffnen'}).length).toBeGreaterThan(0);
  });

  it('saves only master data fields on PATCH',async()=>{
    renderDetail('stammdaten');
    fireEvent.change(await screen.findByLabelText('Bezeichnung'),{target:{value:'Haupteingang Nord'}});
    fireEvent.change(screen.getByLabelText('Objekt'),{target:{value:'site-2'}});
    fireEvent.click(screen.getByRole('button',{name:'Stammdaten speichern'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith(`/keys/${keyId}`,expect.objectContaining({method:'PATCH'})));
    const body=bodyOf(`/keys/${keyId}`,'PATCH');
    expect(body).toEqual(expect.objectContaining({label:'Haupteingang Nord',site_id:'site-2'}));
    expect(body).not.toHaveProperty('id');
    expect(body).not.toHaveProperty('key_code');
    expect(body).not.toHaveProperty('client_mutation_id');
  });

  it('issues, returns, reports loss, blocks and reactivates from the file',async()=>{
    renderDetail('uebersicht');
    fireEvent.click(await screen.findByRole('button',{name:'Ausgabe vorbereiten'}));
    let dialog=screen.getByRole('dialog',{name:/Schlüssel ausgeben/});
    expect(within(dialog).getByText('Objekt Nord')).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Schlüsselhalter'),{target:{value:employeeId}});
    fireEvent.change(within(dialog).getByLabelText('Fällig am'),{target:{value:'2026-12-10T08:30'}});
    fireEvent.change(within(dialog).getByLabelText('Grund'),{target:{value:'Nachschicht'}});
    fireEvent.change(within(dialog).getByLabelText('Bestätigungsname'),{target:{value:'Mia Guard'}});
    fireEvent.click(within(dialog).getByRole('button',{name:'Schlüssel ausgeben'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith(`/keys/${keyId}/issue`,expect.objectContaining({method:'POST'})));
    expect(bodyOf(`/keys/${keyId}/issue`)).toEqual(expect.objectContaining({holder_employee_id:employeeId,reason:'Nachschicht'}));

    cleanup();
    renderDetail('uebersicht',{...profile,key:{...key,status:'issued',holder_employee_id:employeeId,holder_name:'Mia Guard',due_at:'2026-12-10T08:30:00Z'}});
    fireEvent.click(await screen.findByRole('button',{name:'Rückgabe erfassen'}));
    dialog=screen.getByRole('dialog',{name:/Rückgabe erfassen/});
    expect(within(dialog).getByText('Mia Guard')).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Zustand'),{target:{value:'good'}});
    fireEvent.change(within(dialog).getByLabelText('Grund'),{target:{value:'Schichtende'}});
    fireEvent.click(within(dialog).getByRole('button',{name:'Rückgabe bestätigen'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith(`/keys/${keyId}/return`,expect.objectContaining({method:'POST'})));
    expect(bodyOf(`/keys/${keyId}/return`)).toEqual(expect.objectContaining({condition:'good',reason:'Schichtende'}));

    fireEvent.click(screen.getByRole('button',{name:'Verlust melden'}));
    dialog=screen.getByRole('dialog',{name:/Verlust melden/});
    fireEvent.change(within(dialog).getByLabelText('Melder'),{target:{value:'Mia Guard'}});
    fireEvent.change(within(dialog).getByLabelText('Beschreibung'),{target:{value:'Schlüssel verloren'}});
    fireEvent.click(within(dialog).getByRole('button',{name:'Verlust melden'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith(`/keys/${keyId}/report-loss`,expect.objectContaining({method:'POST'})));

    cleanup();
    renderDetail('uebersicht');
    fireEvent.click(await screen.findByRole('button',{name:'Sperren'}));
    dialog=screen.getByRole('dialog',{name:/Schlüssel sperren/});
    fireEvent.change(within(dialog).getByLabelText('Grund'),{target:{value:'Sicherheitsverdacht'}});
    fireEvent.click(within(dialog).getByRole('button',{name:'Sperre bestätigen'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith(`/keys/${keyId}/block`,expect.objectContaining({method:'POST'})));

    cleanup();
    renderDetail('uebersicht',{...profile,key:{...key,status:'blocked'}});
    fireEvent.click(await screen.findByRole('button',{name:'Reaktivieren'}));
    dialog=screen.getByRole('dialog',{name:/Schlüssel reaktivieren/});
    fireEvent.change(within(dialog).getByLabelText('Grund'),{target:{value:'Geprüft'}});
    fireEvent.click(within(dialog).getByRole('button',{name:'Reaktivierung bestätigen'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith(`/keys/${keyId}/reactivate`,expect.objectContaining({method:'POST'})));
    expect(bodyOf(`/keys/${keyId}/reactivate`)).toEqual(expect.objectContaining({reason:'Geprüft'}));
  });

  it('renders the QR image from the returned URL and prints the label',async()=>{
    renderDetail('qr');
    expect(await screen.findByAltText(/Haupteingang/)).toBeTruthy();
    expect(document.body.textContent).not.toContain('hidden-token');
    fireEvent.click(screen.getByRole('button',{name:'Etikett drucken'}));
    expect(window.print).toHaveBeenCalled();
  });

  it('verifies a QR reference from the key file link',async()=>{
    const verifyApi=async(path:string)=>{
      if(path===`/keys/${keyId}/qr/verify?ref=valid-ref`)return {valid:true,expires_at:'2026-12-01T00:00:00Z'};
      if(path===`/keys/${keyId}/qr/verify?ref=bad-ref`)throw new Error('Invalid QR reference');
      return path===`/keys/${keyId}`?profile:defaultApi(path);
    };
    renderDetail('qr',profile,'?ref=valid-ref',verifyApi);
    expect(await screen.findByText(/QR-Verweis gültig bis/)).toBeTruthy();
    expect(apiMock).toHaveBeenCalledWith(`/keys/${keyId}/qr/verify?ref=valid-ref`);
    cleanup();
    renderDetail('qr',profile,'?ref=bad-ref',verifyApi);
    expect(await screen.findByText('QR-Verweis ungültig oder abgelaufen.')).toBeTruthy();
  });

  it('offers employees returned with employment_status as holders',()=>{
    const options=holderOptions([
      {id:'active-1',name:'Aktiv',employment_status:'active'},
      {id:'unknown-1',name:'Ohne Status'},
      {id:'left-1',name:'Ausgeschieden',employment_status:'terminated'},
    ] as EmployeeOption[]);
    expect(options.map(option=>option.value)).toContain('active-1');
    expect(options.map(option=>option.value)).toContain('unknown-1');
    expect(options.map(option=>option.value)).not.toContain('left-1');
  });

  it('updates an existing loss report with status and follow-up',async()=>{
    renderDetail('verlust');
    fireEvent.change(await screen.findByLabelText('Status der Verlustmeldung'),{target:{value:'closed'}});
    fireEvent.click(screen.getByRole('button',{name:'Verlustmeldung speichern'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith(`/keys/${keyId}/loss-reports/report-1`,expect.objectContaining({method:'PATCH'})));
    const body=bodyOf(`/keys/${keyId}/loss-reports/report-1`,'PATCH');
    expect(body).toEqual(expect.objectContaining({status:'closed',immediate_measures:'Tor sperren',follow_up:'Ersatz besorgen'}));
    expect(body).not.toHaveProperty('client_mutation_id');
  });
});
