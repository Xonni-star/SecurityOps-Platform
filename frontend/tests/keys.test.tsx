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
import {Keys} from '../src/pages/Keys';

const siteId='00000000-0000-4000-8000-000000000011';
const employeeId='00000000-0000-4000-8000-000000000012';
const otherEmployeeId='00000000-0000-4000-8000-000000000013';
const bundleId='00000000-0000-4000-8000-000000000014';
const keyId='00000000-0000-4000-8000-000000000001';
const bundledKeyId='00000000-0000-4000-8000-000000000004';

const baseKey={site_id:siteId,site_name:'Objekt Nord',location:'Flur 1',building:'Haus A',area:'EG',access_point:'Tor 1',holder_user_id:null,holder_employee_id:null,holder_name:null,holder_personnel_number:null,holder_status:null,due_at:null,issued_at:null,returned_at:null,lost_at:null,deactivated_at:null,last_movement_at:'2026-11-25T10:00:00Z',last_movement_type:'created',bundle_id:null,bundle_name:null,responsible_employee_id:null,responsible_name:null,created_at:'2026-11-01T10:00:00Z'};
const rows=[
  {...baseKey,id:keyId,key_code:'K-1001',label:'Haupteingang',key_type:'physical',status:'available'},
  {...baseKey,id:'00000000-0000-4000-8000-000000000002',key_code:'K-1002',label:'Nebenpforte',key_type:'electronic',status:'issued',holder_employee_id:employeeId,holder_name:'Mia Guard',holder_personnel_number:'P-7',holder_status:'active',due_at:'2026-12-01T10:00:00Z',issued_at:'2026-11-20T10:00:00Z'},
  {...baseKey,id:'00000000-0000-4000-8000-000000000003',key_code:'K-1003',label:'Tresorraum',key_type:'physical',status:'lost',lost_at:'2026-11-24T10:00:00Z'},
  {...baseKey,id:bundledKeyId,key_code:'K-1004',label:'Bundschlüssel',key_type:'physical',status:'available',bundle_id:bundleId,bundle_name:'Nachschicht'},
];
const dashboard={total:25,available:10,issued:9,overdue:3,lost:2,blocked:1,critical_count:4,deactivated:0,without_site:1,without_holder:2,partial_bundles:1,due_today:1,due_7_days:2,due_30_days:4,recent_movements:[{id:'m-1',key_id:keyId,key_code:'K-1001',key_label:'Haupteingang',movement_type:'created',created_at:'2026-11-25T10:00:00Z'}]};
const actionList={
  A:[{id:'a-1',bucket:'A' as const,code:'overdue',label:'Rückgabe überfällig',key_id:rows[1].id,key_code:'K-1002',subject_type:'due',subject_id:rows[1].id,due_at:'2026-11-20T00:00:00Z',url:`/keys/${rows[1].id}/historie`,target:`/keys/${rows[1].id}/historie`,site_name:'Objekt Nord'}],
  B:[{id:'b-1',bucket:'B' as const,code:'bundle_partial',label:'Bund teils ausgegeben',key_id:keyId,key_code:'K-1001',subject_type:'bundle',subject_id:bundleId,due_at:null,url:`/keys/${keyId}`,target:`/keys/${keyId}`,site_name:null}],
  C:[{id:'c-1',bucket:'C' as const,code:'no_holder',label:'Kein Halter zugeordnet',key_id:keyId,key_code:'K-1001',subject_type:'holder',subject_id:keyId,due_at:null,url:`/keys/${keyId}`,target:`/keys/${keyId}`,site_name:null}],
  totals:{A:1,B:1,C:1},
  generated_at:'2026-11-26T00:00:00.000Z',
};
const sites=[{id:siteId,name:'Objekt Nord',site_number:'S-11',site_status:'active'},{id:'00000000-0000-4000-8000-000000000015',name:'Objekt Süd',site_number:'S-12'}];
const employees=[
  {id:employeeId,name:'Mia Guard',first_name:'Mia',last_name:'Guard',employee_number:'P-7',department:'Wache',status:'active'},
  {id:otherEmployeeId,name:'Leo Wache',first_name:'Leo',last_name:'Wache',employee_number:'P-8',department:'Wache',status:'probation'},
  {id:'00000000-0000-4000-8000-000000000016',name:'Alt Halter',employee_number:'P-1',status:'inactive'},
];
const bundles=[{id:bundleId,name:'Nachschicht',description:'Bund für die Nacht',site_id:siteId,site_name:'Objekt Nord',status:'available',item_count:2,issued_count:1,holder_name:'Mia Guard',last_movement_at:'2026-11-25T10:00:00Z'}];
const bundleDetail={...bundles[0],items:[{...rows[1],id:'item-1',key_code:'K-1005',label:'Bund A',status:'issued'},{...rows[0],id:'item-2',key_code:'K-1006',label:'Bund B',status:'available'}]};

const response=(body:unknown,headers:Record<string,string>={})=>({
  ok:true,status:200,
  headers:{get:(name:string)=>headers[name]??headers[name.toLowerCase()]??null},
  json:async()=>body,
  blob:async()=>new Blob(['Kennziffer;Bezeichnung'],{type:'text/csv'}),
  text:async()=>JSON.stringify(body),
});
let listTotal=25;
let listPages=3;
const defaultApi=async(path:string)=>{
  if(path==='/keys/dashboard')return dashboard;
  if(path==='/keys/action-list')return actionList;
  if(path.startsWith('/keys?'))return rows;
  if(path.startsWith('/keys/picker?')){
    const params=new URLSearchParams(path.split('?')[1]??'');
    const q=(params.get('q')??'').toLowerCase();
    const site=params.get('site_id');
    const bundle=params.get('bundle_id');
    const excluded=params.get('exclude_bundle_id');
    const status=params.get('status');
    const cursor=Number(params.get('cursor')??0);
    const pageSize=Number(params.get('pageSize')??100);
    const filtered=rows.filter(key=>(!q||`${key.key_code} ${key.label}`.toLowerCase().includes(q))
      &&(!site||key.site_id===site)
      &&(!bundle||key.bundle_id===bundle)
      &&(!excluded||key.bundle_id!==excluded)
      &&(!status||key.status===status));
    const items=filtered.slice(cursor,cursor+pageSize);
    const next=cursor+items.length<filtered.length?String(cursor+items.length):null;
    return {items,total:filtered.length,next_cursor:next};
  }
  if(path==='/sites')return sites;
  if(path==='/employees')return employees;
  if(path==='/key-bundles')return bundles;
  if(path===`/key-bundles/${bundleId}`)return bundleDetail;
  if(path===`/key-bundles/${bundleId}/history`)return [{id:'h-1',created_at:'2026-11-25T10:00:00Z',movement_type:'issued',label:'Ausgabe'}];
  return [];
};
const renderKeys=()=>render(<MemoryRouter initialEntries={['/keys']}><Routes>
  <Route path="/keys" element={<Keys/>}/>
  <Route path="/keys/:keyId" element={<p>Schlüsselakte geöffnet</p>}/>
  <Route path="/keys/:keyId/:section" element={<p>Schlüsselabschnitt geöffnet</p>}/>
</Routes></MemoryRouter>);
const lastListUrl=()=>String([...fetchMock.mock.calls].reverse().find(([input])=>String(input).startsWith('/api/v1/keys?'))?.[0]??'');
const queryOf=(url:string)=>new URLSearchParams(url.split('?')[1]??'');
const bodyOf=(path:string,method='POST')=>{
  const call=[...apiMock.mock.calls].reverse().find(([requestPath,options])=>requestPath===path&&(options?.method??'GET')===method);
  return JSON.parse(String(call?.[1]?.body??'{}')) as Record<string,unknown>;
};
const lastExportUrl=()=>String([...fetchMock.mock.calls].reverse().find(([input])=>String(input).includes('/api/v1/keys/export'))?.[0]??'');

beforeEach(()=>{
  cleanup();apiMock.mockReset();permissionMock.mockReset();fetchMock.mockReset();
  permissionMock.mockReturnValue(true);listTotal=25;listPages=3;
  apiMock.mockImplementation(defaultApi);
  fetchMock.mockImplementation(async(input:string)=>{
    const url=String(input);
    if(url.startsWith('/api/v1/keys/export'))return response([],{'Content-Disposition':'attachment; filename="schluessel.csv"'});
    if(url.startsWith('/api/v1/keys?'))return response(rows,{'X-Total-Count':String(listTotal),'X-Page':'1','X-Page-Size':'10','X-Page-Count':String(listPages)});
    return response([]);
  });
  vi.stubGlobal('fetch',fetchMock);
  vi.stubGlobal('confirm',vi.fn(()=>true));
  vi.stubGlobal('print',vi.fn());
  Object.defineProperty(URL,'createObjectURL',{configurable:true,value:vi.fn(()=>'blob:test')});
  Object.defineProperty(URL,'revokeObjectURL',{configurable:true,value:vi.fn()});
  localStorage.setItem('securityops_user',JSON.stringify({id:'self-user-id',email:'self@example.invalid',role:'user',permissions:['keys:read']}));
});

describe('Schlüssel-Cockpit',()=>{
  it('loads server-side rows with all filters, sorting and pagination',async()=>{
    renderKeys();
    expect(await screen.findByLabelText('Haupteingang auswählen')).toBeTruthy();
    const metrics=screen.getByText('Gesamt').closest('.key-metrics')!;
    for(const label of ['Gesamt','Verfügbar','Ausgegeben','Überfällig','Verloren','Kritische Vorgänge'])expect(within(metrics as HTMLElement).getByText(label)).toBeTruthy();
    expect(within(metrics as HTMLElement).getByText('Kritische Vorgänge').parentElement?.textContent).toContain('4');

    fireEvent.change(screen.getByLabelText('Schlüssel suchen'),{target:{value:'Haupteingang'}});
    fireEvent.change(screen.getByLabelText('Schlüsselstatus'),{target:{value:'available'}});
    fireEvent.change(screen.getByLabelText('Schlüsseltyp'),{target:{value:'physical'}});
    fireEvent.change(screen.getByLabelText('Objekt'),{target:{value:siteId}});
    fireEvent.change(screen.getByLabelText('Halter'),{target:{value:employeeId}});
    fireEvent.change(screen.getByLabelText('Schlüsselbund'),{target:{value:bundleId}});
    fireEvent.change(screen.getByLabelText('Ort'),{target:{value:'Flur 1'}});
    fireEvent.click(screen.getByRole('button',{name:'Fällig'}));
    await waitFor(()=>{
      const params=queryOf(lastListUrl());
      expect(params.get('q')).toBe('Haupteingang');
      expect(params.get('status')).toBe('available');
      expect(params.get('key_type')).toBe('physical');
      expect(params.get('site_id')).toBe(siteId);
      expect(params.get('holder_employee_id')).toBe(employeeId);
      expect(params.get('bundle_id')).toBe(bundleId);
      expect(params.get('location')).toBe('Flur 1');
      expect(params.get('sort')).toBe('due_at');
      expect(params.get('dir')).toBe('asc');
      expect(params.get('page')).toBe('1');
      expect(params.get('pageSize')).toBe('10');
    });
    fireEvent.click(screen.getByRole('button',{name:'Weiter'}));
    await waitFor(()=>expect(queryOf(lastListUrl()).get('page')).toBe('2'));
    expect(screen.getByText(/25 Schlüssel · Seite 2 von 3/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'Filter zurücksetzen'}));
    await waitFor(()=>expect(queryOf(lastListUrl()).has('q')).toBe(false));
    expect(queryOf(lastListUrl()).get('sort')).toBe('key_code');
  });

  it('links every A/B/C entry to a concrete key file',async()=>{
    renderKeys();
    expect(await screen.findByRole('heading',{name:'Handlungsübersicht'})).toBeTruthy();
    expect(screen.getByRole('link',{name:/Rückgabe überfällig/}).getAttribute('href')).toBe(`/keys/${rows[1].id}/historie`);
    expect(screen.getByRole('link',{name:/Bund teils ausgegeben/}).getAttribute('href')).toBe(`/keys/${keyId}`);
    expect(screen.getByRole('link',{name:/Kein Halter zugeordnet/}).getAttribute('href')).toBe(`/keys/${keyId}`);
    expect(screen.getByText('Teilweise ausgegeben – 1 Schlüssel verfügbar.')).toBeTruthy();
  });

  it('exports the current filter set plus selected ids',async()=>{
    renderKeys();
    const checkbox=await screen.findByLabelText('Haupteingang auswählen') as HTMLInputElement;
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole('button',{name:/Export \(1\)/}));
    await waitFor(()=>{
      const params=new URLSearchParams(lastExportUrl().split('?')[1]??'');
      expect(params.get('ids')).toBe(keyId);
      expect(params.get('pageSize')).toBe('10');
      expect(params.get('sort')).toBe('key_code');
    });
  });

  it('can request a complete export and shows the truncation notice from the server',async()=>{
    fetchMock.mockImplementation(async(input:string)=>{
      if(String(input).includes('/api/v1/keys/export'))return response([],{
        'Content-Disposition':'attachment; filename="schluessel.csv"',
        'X-Key-Export-Truncated':'true','X-Key-Export-Count':'10000','X-Key-Export-Total':'12000',
      });
      if(String(input).startsWith('/api/v1/keys?'))return response(rows,{'X-Total-Count':String(listTotal),'X-Page':'1','X-Page-Size':'10','X-Page-Count':String(listPages)});
      return response([]);
    });
    renderKeys();
    await screen.findByLabelText('Haupteingang auswählen');
    fireEvent.click(screen.getByLabelText('Vollständig exportieren'));
    fireEvent.click(screen.getByRole('button',{name:'Export'}));
    await waitFor(()=>expect(new URLSearchParams(lastExportUrl().split('?')[1]??'').get('full')).toBe('true'));
    expect((await screen.findByRole('alert')).textContent).toContain('10000 von 12000');
  });

  it('hides all write controls without permissions and shows no UUID inputs',async()=>{
    permissionMock.mockImplementation((code:string)=>!['keys:create','keys:write','keys:update','keys:issue','keys:return','keys:manage','keys:report_loss','keys:export','keys:qr:read','keys:inventory:write','keys:bundle_write','keys:bundle_issue','keys:bundle_return','keys:bundle_deactivate'].includes(code));
    renderKeys();
    await screen.findByLabelText('Haupteingang auswählen');
    expect(screen.queryByRole('button',{name:/Schlüssel anlegen/})).toBeNull();
    expect(screen.queryByRole('button',{name:'Ausgabe vorbereiten'})).toBeNull();
    expect(screen.queryByRole('button',{name:'Rückgabe erfassen'})).toBeNull();
    expect(screen.queryByRole('button',{name:'Verlust melden'})).toBeNull();
    expect(screen.queryByRole('button',{name:'Sperren'})).toBeNull();
    expect(screen.queryByRole('button',{name:'QR-Code'})).toBeNull();
    expect(screen.queryByRole('button',{name:/Export/})).toBeNull();
    for(const label of ['Standort-ID','Halter-UUID','Schlüssel-UUID'])expect(screen.queryByLabelText(label)).toBeNull();
    expect(document.body.textContent).not.toContain('Standort-ID');
    expect(document.body.textContent).not.toContain('Halter-UUID');
    expect(document.body.textContent).not.toContain('Schlüssel-UUID');
  });

  it('creates a key through pickers and posts the full master-data body',async()=>{
    renderKeys();
    fireEvent.click(await screen.findByRole('button',{name:/\+ Schlüssel anlegen/}));
    const dialog=screen.getByRole('dialog',{name:'Schlüssel anlegen'});
    fireEvent.change(within(dialog).getByLabelText('Kennziffer'),{target:{value:'K-2000'}});
    fireEvent.change(within(dialog).getByLabelText('Bezeichnung'),{target:{value:'Neuer Schlüssel'}});
    fireEvent.change(within(dialog).getByLabelText('Objekt'),{target:{value:siteId}});
    fireEvent.change(within(dialog).getByLabelText('Verantwortliche Person'),{target:{value:employeeId}});
    fireEvent.change(within(dialog).getByLabelText('Standort / Ort'),{target:{value:'Eingang'}});
    fireEvent.click(within(dialog).getByRole('button',{name:'Schlüssel anlegen'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith('/keys',expect.objectContaining({method:'POST'})));
    const body=bodyOf('/keys');
    expect(body).toEqual(expect.objectContaining({key_code:'K-2000',label:'Neuer Schlüssel',key_type:'physical',site_id:siteId,responsible_employee_id:employeeId,location:'Eingang'}));
    expect(body.client_mutation_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(within(dialog).queryByLabelText(/UUID/)).toBeNull();
  });

  it('issues with an employee picker and explicit self option, then returns and reports loss',async()=>{
    renderKeys();
    fireEvent.click(await screen.findByRole('button',{name:'Ausgabe vorbereiten'}));
    let dialog=screen.getByRole('dialog',{name:/Schlüssel ausgeben/});
    expect(within(dialog).getByRole('option',{name:/Mich selbst/})).toBeTruthy();
    expect(within(dialog).getByRole('option',{name:/Mia Guard/})).toBeTruthy();
    expect(within(dialog).queryByRole('option',{name:/Alt Halter/})).toBeNull();
    fireEvent.change(within(dialog).getByLabelText('Schlüsselhalter'),{target:{value:employeeId}});
    fireEvent.change(within(dialog).getByLabelText('Fällig am'),{target:{value:'2026-12-10T08:30'}});
    fireEvent.change(within(dialog).getByLabelText('Grund'),{target:{value:'Nachschicht'}});
    fireEvent.change(within(dialog).getByLabelText('Bestätigungsname'),{target:{value:'Mia Guard'}});
    fireEvent.click(within(dialog).getByRole('button',{name:'Schlüssel ausgeben'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith(`/keys/${keyId}/issue`,expect.objectContaining({method:'POST'})));
    expect(bodyOf(`/keys/${keyId}/issue`)).toEqual(expect.objectContaining({
      holder_employee_id:employeeId,holder_user_id:null,reason:'Nachschicht',confirmation_name:'Mia Guard',
    }));
    expect(String(bodyOf(`/keys/${keyId}/issue`).due_at)).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const issuedRow=(await screen.findByLabelText('Nebenpforte auswählen')).closest('tr')!;
    fireEvent.click(within(issuedRow).getByRole('button',{name:'Rückgabe erfassen'}));
    dialog=screen.getByRole('dialog',{name:/Rückgabe erfassen/});
    fireEvent.change(within(dialog).getByLabelText('Zustand'),{target:{value:'damaged'}});
    fireEvent.change(within(dialog).getByLabelText('Grund'),{target:{value:'Schloss beschädigt'}});
    fireEvent.click(within(dialog).getByRole('button',{name:'Rückgabe bestätigen'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith(`/keys/${rows[1].id}/return`,expect.objectContaining({method:'POST'})));
    expect(bodyOf(`/keys/${rows[1].id}/return`)).toEqual(expect.objectContaining({condition:'damaged',reason:'Schloss beschädigt'}));

    fireEvent.click(within(issuedRow).getByRole('button',{name:'Verlust melden'}));
    dialog=screen.getByRole('dialog',{name:/Verlust melden/});
    fireEvent.change(within(dialog).getByLabelText('Melder'),{target:{value:'Leo Wache'}});
    fireEvent.change(within(dialog).getByLabelText('Beschreibung'),{target:{value:'Schlüssel verloren'}});
    fireEvent.click(within(dialog).getByRole('button',{name:'Verlust melden'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith(`/keys/${rows[1].id}/report-loss`,expect.objectContaining({method:'POST'})));
    const loss=bodyOf(`/keys/${rows[1].id}/report-loss`);
    expect(loss).toEqual(expect.objectContaining({reporter_name:'Leo Wache',description:'Schlüssel verloren',site_id:siteId,status:'reported',create_incident:false,last_holder_employee_id:employeeId}));
    expect(loss).not.toHaveProperty('holder_employee_id');
  });

  it('links DMS receipts and existing or new incidents from guided dialogs',async()=>{
    const documentId='00000000-0000-4000-8000-000000000060';
    const incidentId='00000000-0000-4000-8000-000000000061';
    const priorityId='00000000-0000-4000-8000-000000000062';
    apiMock.mockImplementation(async(path:string)=>{
      if(path==='/dms/documents')return [{id:documentId,title:'Übergabeprotokoll',site_id:siteId}];
      if(path==='/incidents')return [{id:incidentId,description:'Verdächtiger Vorfall',status:'initiated'}];
      if(path==='/alarm-priorities')return [{id:priorityId,name:'Hoch'}];
      return defaultApi(path);
    });
    renderKeys();
    fireEvent.click(await screen.findByRole('button',{name:'Ausgabe vorbereiten'}));
    let dialog=screen.getByRole('dialog',{name:/Schlüssel ausgeben/});
    fireEvent.change(within(dialog).getByLabelText('Schlüsselhalter'),{target:{value:employeeId}});
    fireEvent.change(within(dialog).getByLabelText('Fällig am'),{target:{value:'2026-12-10T08:30'}});
    fireEvent.change(within(dialog).getByLabelText('Grund'),{target:{value:'Nachschicht'}});
    fireEvent.change(within(dialog).getByLabelText('Bestätigungsname'),{target:{value:'Mia Guard'}});
    fireEvent.change(within(dialog).getByLabelText('Übergabeprotokoll (DMS)'),{target:{value:documentId}});
    fireEvent.click(within(dialog).getByRole('button',{name:'Schlüssel ausgeben'}));
    await waitFor(()=>expect(bodyOf(`/keys/${keyId}/issue`).receipt_document_id).toBe(documentId));

    const issuedRow=(await screen.findByLabelText('Nebenpforte auswählen')).closest('tr')!;
    fireEvent.click(within(issuedRow).getByRole('button',{name:'Verlust melden'}));
    dialog=screen.getByRole('dialog',{name:/Verlust melden/});
    fireEvent.change(within(dialog).getByLabelText('Melder'),{target:{value:'Leo Wache'}});
    fireEvent.change(within(dialog).getByLabelText('Beschreibung'),{target:{value:'Schlüssel verloren'}});
    fireEvent.change(within(dialog).getByLabelText('Vorfallverknüpfung'),{target:{value:'existing'}});
    fireEvent.change(within(dialog).getByLabelText('Bestehender Vorfall'),{target:{value:incidentId}});
    fireEvent.click(within(dialog).getByRole('button',{name:'Verlust melden'}));
    await waitFor(()=>expect(bodyOf(`/keys/${rows[1].id}/report-loss`).incident_id).toBe(incidentId));
    expect(bodyOf(`/keys/${rows[1].id}/report-loss`).create_incident).toBe(false);

    fireEvent.click(within(issuedRow).getByRole('button',{name:'Verlust melden'}));
    dialog=screen.getByRole('dialog',{name:/Verlust melden/});
    fireEvent.change(within(dialog).getByLabelText('Melder'),{target:{value:'Leo Wache'}});
    fireEvent.change(within(dialog).getByLabelText('Beschreibung'),{target:{value:'Schlüssel verloren'}});
    fireEvent.change(within(dialog).getByLabelText('Vorfallverknüpfung'),{target:{value:'new'}});
    fireEvent.change(within(dialog).getByLabelText('Vorfallpriorität'),{target:{value:priorityId}});
    fireEvent.click(within(dialog).getByRole('button',{name:'Verlust melden'}));
    await waitFor(()=>expect(bodyOf(`/keys/${rows[1].id}/report-loss`).create_incident).toBe(true));
    expect(bodyOf(`/keys/${rows[1].id}/report-loss`).incident_priority_id).toBe(priorityId);
  });

  it('blocks only after a reason and explicit confirmation',async()=>{
    renderKeys();
    const firstRow=(await screen.findByLabelText('Haupteingang auswählen')).closest('tr')!;
    fireEvent.click(within(firstRow).getByRole('button',{name:'Sperren'}));
    const dialog=screen.getByRole('dialog',{name:/Schlüssel sperren/});
    const submit=within(dialog).getByRole('button',{name:'Sperre bestätigen'}) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Grund'),{target:{value:'Verdacht auf Missbrauch'}});
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith(`/keys/${keyId}/block`,expect.objectContaining({method:'POST'})));
    expect(bodyOf(`/keys/${keyId}/block`)).toEqual(expect.objectContaining({reason:'Verdacht auf Missbrauch'}));
    expect(window.confirm).toHaveBeenCalled();
  });

  it('renders a QR image from the API URL without exposing the token',async()=>{
    apiMock.mockImplementation(async(path:string)=>path===`/keys/${keyId}/qr`?{token:'super-secret-token',url:'https://example.invalid/key/qr',expires_at:'2026-12-01T00:00:00Z'}:defaultApi(path));
    renderKeys();
    const firstRow=(await screen.findByLabelText('Haupteingang auswählen')).closest('tr')!;
    fireEvent.click(within(firstRow).getByRole('button',{name:'QR-Code'}));
    const dialog=screen.getByRole('dialog',{name:/QR-Code/});
    expect(await within(dialog).findByAltText(/Haupteingang/)).toBeTruthy();
    expect(document.body.textContent).not.toContain('super-secret-token');
  });

  it('records an inventory check for selected keys',async()=>{
    renderKeys();
    fireEvent.click(await screen.findByRole('button',{name:'Bestandskontrolle'}));
    const dialog=screen.getByRole('dialog',{name:'Bestandskontrolle erfassen'});
    fireEvent.change(within(dialog).getByLabelText('Prüfer'),{target:{value:'Leo Wache'}});
    fireEvent.click(await within(dialog).findByLabelText('K-1002 · Nebenpforte erwartet'));
    fireEvent.click(within(dialog).getByRole('button',{name:'Bestandskontrolle speichern'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith('/keys/inventory-checks',expect.objectContaining({method:'POST'})));
    const body=bodyOf('/keys/inventory-checks');
    expect(body).toEqual(expect.objectContaining({checker_name:'Leo Wache'}));
    expect(Array.isArray(body.results)).toBe(true);
  });

  it('loads further picker pages and keeps the selected key when filters change',async()=>{
    const many=Array.from({length:220},(_,index)=>({...rows[0],id:`00000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`,key_code:`K-${1500+index}`,label:`Schlüssel ${index+1}`,bundle_id:null}));
    const pickerApi=async(path:string)=>{
      const params=new URLSearchParams(path.split('?')[1]??'');
      const cursor=Number(params.get('cursor')??0);
      const pageSize=Number(params.get('pageSize')??100);
      const q=(params.get('q')??'').toLowerCase();
      const filtered=many.filter(key=>!q||`${key.key_code} ${key.label}`.toLowerCase().includes(q));
      const items=filtered.slice(cursor,cursor+pageSize);
      const next=cursor+items.length<filtered.length?String(cursor+items.length):null;
      return {items,total:filtered.length,next_cursor:next};
    };
    apiMock.mockImplementation(async(path:string)=>{
      if(path==='/keys/dashboard')return dashboard;
      if(path==='/keys/action-list')return actionList;
      if(path.startsWith('/keys/picker?'))return pickerApi(path);
      return defaultApi(path);
    });
    renderKeys();
    await screen.findByRole('heading',{name:'Nachschicht',level:3});
    fireEvent.click(screen.getByRole('button',{name:'Schlüssel anzeigen'}));
    const card=()=>screen.getByRole('heading',{name:'Nachschicht',level:3}).closest('article')!;
    const select=await within(card()).findByLabelText('Schlüssel für Bund');
    await waitFor(()=>expect(within(select).getAllByRole('option')).toHaveLength(101));
    expect(apiMock).toHaveBeenCalledWith(expect.stringContaining('/keys/picker?pageSize=100&cursor=0'));
    fireEvent.click(within(card()).getByRole('button',{name:/Weitere Schlüssel laden/}));
    await waitFor(()=>expect(within(select).getAllByRole('option')).toHaveLength(201));
    fireEvent.click(within(card()).getByRole('button',{name:/Weitere Schlüssel laden/}));
    await waitFor(()=>expect(within(select).getAllByRole('option')).toHaveLength(221));
    const selected=many[219];
    fireEvent.change(select,{target:{value:selected.id}});
    expect((select as HTMLSelectElement).value).toBe(selected.id);
    fireEvent.change(within(card()).getByLabelText('Schlüssel im Bund suchen'),{target:{value:'kein-treffer'}});
    await waitFor(()=>expect((select as HTMLSelectElement).value).toBe(selected.id));
    expect(within(select).getByRole('option',{name:/Schlüssel 220/})).toBeTruthy();
  });

  it('manages bundles: create, add a key, issue and return only checked keys',async()=>{
    renderKeys();
    fireEvent.click(await screen.findByRole('button',{name:/\+ Bund anlegen/}));
    let dialog=screen.getByRole('dialog',{name:'Schlüsselbund anlegen'});
    fireEvent.change(within(dialog).getByLabelText('Name'),{target:{value:'Neuer Bund'}});
    fireEvent.change(within(dialog).getByLabelText('Objekt'),{target:{value:siteId}});
    fireEvent.click(within(dialog).getByRole('button',{name:'Bund anlegen'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith('/key-bundles',expect.objectContaining({method:'POST'})));
    expect(bodyOf('/key-bundles')).toEqual(expect.objectContaining({name:'Neuer Bund',site_id:siteId}));

    const bundleCard=()=>screen.getByRole('heading',{name:'Nachschicht',level:3}).closest('article')!;
    await screen.findByRole('heading',{name:'Nachschicht',level:3});
    fireEvent.click(within(bundleCard()).getByRole('button',{name:'Schlüssel anzeigen'}));
    expect(await within(bundleCard()).findByRole('option',{name:/K-1001/})).toBeTruthy();
    fireEvent.change(within(bundleCard()).getByLabelText('Schlüssel im Bund suchen'),{target:{value:'K-1001'}});
    fireEvent.change(within(bundleCard()).getByLabelText('Schlüssel für Bund'),{target:{value:keyId}});
    fireEvent.click(within(bundleCard()).getByRole('button',{name:'Hinzufügen'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith(`/key-bundles/${bundleId}/items`,expect.objectContaining({method:'POST'})));
    expect(bodyOf(`/key-bundles/${bundleId}/items`)).toEqual(expect.objectContaining({key_id:keyId}));

    fireEvent.click(within(bundleCard()).getByRole('button',{name:'Bund ausgeben'}));
    dialog=screen.getByRole('dialog',{name:/Bund ausgeben/});
    fireEvent.change(within(dialog).getByLabelText('Schlüsselhalter'),{target:{value:employeeId}});
    fireEvent.change(within(dialog).getByLabelText('Fällig am'),{target:{value:'2026-12-12T08:00'}});
    fireEvent.change(within(dialog).getByLabelText('Grund'),{target:{value:'Nachschicht'}});
    fireEvent.click(within(dialog).getByRole('button',{name:'Bund ausgeben'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith(`/key-bundles/${bundleId}/issue`,expect.objectContaining({method:'POST'})));
    expect(bodyOf(`/key-bundles/${bundleId}/issue`)).toEqual(expect.objectContaining({holder_employee_id:employeeId,reason:'Nachschicht'}));

    fireEvent.click(within(bundleCard()).getByRole('button',{name:'Teilweise Rückgabe'}));
    dialog=await screen.findByRole('dialog',{name:'Teilweise Rückgabe'});
    expect(within(dialog).getByLabelText(/K-1005/)).toBeTruthy();
    fireEvent.click(within(dialog).getByLabelText(/K-1005/));
    fireEvent.change(within(dialog).getByLabelText('Grund'),{target:{value:'Schichtende'}});
    fireEvent.click(within(dialog).getByRole('button',{name:'Ausgewählte Schlüssel zurückgeben'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith(`/key-bundles/${bundleId}/return`,expect.objectContaining({method:'POST'})));
    expect(bodyOf(`/key-bundles/${bundleId}/return`)).toEqual(expect.objectContaining({key_ids:['item-1'],reason:'Schichtende'}));
  });

  it('prevents individual actions for bundled keys',async()=>{
    renderKeys();
    const link=await screen.findByText('K-1004');
    const row=link.closest('tr')!;
    expect(within(row).queryByRole('button',{name:'Ausgabe vorbereiten'})).toBeNull();
    expect(within(row).getByText('Nur über Bund verwaltbar')).toBeTruthy();
    expect(within(row).getByRole('link',{name:'Öffnen'}).getAttribute('href')).toBe(`/keys/${bundledKeyId}`);
  });
});
