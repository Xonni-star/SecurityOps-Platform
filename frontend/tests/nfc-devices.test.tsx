/** @vitest-environment jsdom */
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {MemoryRouter,Route,Routes} from 'react-router-dom';

const apiMock=vi.hoisted(()=>vi.fn());
const permissionMock=vi.hoisted(()=>vi.fn((_code?:string)=>true));
vi.mock('../src/lib/api',()=>({
  api:apiMock,
  hasPermission:permissionMock,
  storedUser:()=>null,
  csrf:()=>'token',
  ApiError:class ApiError extends Error{
    fields:Record<string,string>;
    constructor(message:string,public status:number,fields:Record<string,string>={}){
      super(message);this.name='ApiError';this.fields=fields;
    }
  },
}));

import {ApiError} from '../src/lib/api';
import type {NfcDevice,NfcFileData} from '../src/pages/nfcParts';
import {NfcDeviceFile} from '../src/pages/NfcDeviceFile';
import {NfcDevices} from '../src/pages/NfcDevices';

const deviceId='00000000-0000-4000-8000-000000000020';
const newDeviceId='00000000-0000-4000-8000-000000000021';
const siteId='00000000-0000-4000-8000-000000000030';
const pointId='00000000-0000-4000-8000-000000000031';
const employeeId='00000000-0000-4000-8000-000000000032';
const device:NfcDevice={
  id:deviceId,identifier:'TAG-001',device_type:'tag',manufacturer:'Acme',status:'active',
  employee_id:null,site_id:null,control_point_id:pointId,employee_name:null,site_name:'Objekt 1',
  control_point_name:'Punkt 1',control_point_site_id:siteId,notes:'Notiz',
  registered_at:'2026-01-01T10:00:00Z',updated_at:'2026-01-02T10:00:00Z',last_used_at:'2026-11-26T10:00:00Z',
};
const overview={
  total:10,active_tags:6,active_readers:2,blocked:1,lost:1,replaced:1,unassigned:3,scans:42,devices:5,days:30,
  archived:2,recent_devices:4,recent:[device],
};
const options={
  sites:[{id:siteId,name:'Objekt 1'}],
  control_points:[{id:pointId,site_id:siteId,name:'Punkt 1',site_name:'Objekt 1'}],
  employees:[{id:employeeId,name:'Ava Worker'}],
  devices:[{id:newDeviceId,identifier:'TAG-002',device_type:'tag',manufacturer:'Acme',status:'active'}],
};
const inventory={rows:[device],total:26,page:1,pageSize:25,totalPages:2};
const scans={
  rows:[
    {id:'s-1',nfc_uid:'TAG-001',control_point_name:'Punkt 1',site_name:'Objekt 1',route_name:'Nacht_runde',employee_name:'Ava Worker',
      scanned_at:'2026-11-26T10:00:00Z',server_received_at:'2026-11-26T10:00:01Z',scan_authentication:'uid_registered',outcome:'accepted'},
    {id:'s-2',nfc_uid:'TAG-001',outcome:'rejected',rejection_reason:'NFC-Tag ist nicht aktiv',rejection_code:'NFC_TAG_NOT_ACTIVE',
      scanned_at:'2026-11-26T11:00:00Z',server_received_at:'2026-11-26T11:00:02Z'},
  ],
  total:27,page:1,pageSize:25,totalPages:2,
};
const fileData:NfcFileData={
  device,
  assignment_history:[{id:'a-1',previous_assignment:{},assignment:{control_point_id:pointId},assigned_at:'2026-01-02T10:00:00Z',reason:'Initial'}],
  replacements:[],
  documents:[{id:'doc-1',title:'Prüfprotokoll',document_number:'DOC-1',created_at:'2026-03-01T10:00:00Z',versions:[{id:'v2',version_no:2,lifecycle_state:'available'}]}],
  history:[
    {id:'audit-1',event_type:'nfc_device.created',details:{identifier:'TAG-001'},created_at:'2026-01-01T10:00:00Z',actor_email:'operator@example.invalid'},
    {id:'audit-2',event_type:'nfc_device.assigned',details:{assignment:{control_point_id:pointId},previous_assignment:{}},created_at:'2026-01-02T10:00:00Z',actor_email:'operator@example.invalid'},
  ],
};

function mockApi(fileOverride=fileData){
  apiMock.mockImplementation(async(path:string,init?:RequestInit)=>{
    const method=init?.method??'GET';
    if(path.startsWith('/nfc-devices/overview'))return overview;
    if(path.startsWith('/nfc-devices/inventory'))return inventory;
    if(path==='/nfc-devices/filter-options')return options;
    if(path===`/nfc-devices/${deviceId}/file`)return fileOverride;
    if(path.startsWith(`/nfc-devices/${deviceId}/scan-history`))return scans;
    if(method==='POST'||method==='PATCH')return device;
    return {};
  });
}

function renderOverview(){
  return render(<MemoryRouter initialEntries={['/nfc-devices']}><Routes>
    <Route path="/nfc-devices" element={<NfcDevices/>}/>
    <Route path="/nfc-devices/:deviceId" element={<div>Geräteakte-Ansicht</div>}/>
  </Routes></MemoryRouter>);
}

function renderFile(){
  return render(<MemoryRouter initialEntries={[`/nfc-devices/${deviceId}`]}><Routes>
    <Route path="/nfc-devices/:deviceId" element={<NfcDeviceFile/>}/>
  </Routes></MemoryRouter>);
}

const candidateA='00000000-0000-4000-8000-000000000041';
const candidateB='00000000-0000-4000-8000-000000000042';
const assignedBlockedA={id:candidateA,identifier:'TAG-A',device_type:'tag',manufacturer:'Acme',status:'blocked',
  employee_id:employeeId,employee_name:'Ava Worker'};
const assignedBlockedB={id:candidateB,identifier:'TAG-B',device_type:'tag',manufacturer:'Acme',status:'blocked',
  employee_id:employeeId,employee_name:'Ava Worker'};

function mockReplaceApi(devices:typeof options.devices=options.devices){
  apiMock.mockImplementation(async(path:string,init?:RequestInit)=>{
    if(path.startsWith('/nfc-devices/overview'))return overview;
    if(path.startsWith('/nfc-devices/inventory'))return {...inventory,rows:[{...device,status:'lost'}]};
    if(path==='/nfc-devices/filter-options')return {...options,devices};
    if(init?.method==='POST')return device;
    if(path.startsWith(`/nfc-devices/${deviceId}/scan-history`))return scans;
    return {};
  });
}

async function openReplaceDialog(){
  renderOverview();
  fireEvent.click(await screen.findByRole('button',{name:'Ersatz'}));
  return await screen.findByRole('dialog');
}

function selectExistingCandidate(dialog:HTMLElement,id:string){
  fireEvent.change(screen.getByLabelText('Ersatzgerät-Art'),{target:{value:'existing'}});
  fireEvent.change(dialog.querySelector('select[aria-label="Ersatzgerät"]') as HTMLSelectElement,{target:{value:id}});
}

function requiredChecks(dialog:HTMLElement):HTMLInputElement[]{
  return Array.from(dialog.querySelectorAll('input[type="checkbox"][required]')) as HTMLInputElement[];
}

function checkRequired(dialog:HTMLElement){
  for(const check of requiredChecks(dialog))if(!check.checked)fireEvent.click(check);
}

function replaceBody():Record<string,unknown>|undefined{
  const call=apiMock.mock.calls.find(([path,init])=>String(path).endsWith('/replace')&&init?.method==='POST');
  return call?JSON.parse(String(call[1]?.body)):undefined;
}

beforeEach(()=>{
  cleanup();
  apiMock.mockReset();
  permissionMock.mockReset();
  permissionMock.mockReturnValue(true);
  mockApi();
});

describe('NFC-Geräteverwaltung',()=>{
  it('zeigt echte Kennzahlen und kombiniert Suche, Filter, Sortierung und Pagination',async()=>{
    renderOverview();
    expect(await screen.findByText('42')).toBeTruthy();
    expect(screen.getByText('Aktive NFC-Tags')).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText('NFC-Kennung suchen'),{target:{value:'TAG'}});
    fireEvent.change(screen.getByLabelText('Status'),{target:{value:'active'}});
    fireEvent.click(screen.getByRole('button',{name:/NFC-Kennung sortieren/}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith(expect.stringContaining('q=TAG&status=active')));
    const lastInventory=[...apiMock.mock.calls].reverse().find(([path])=>String(path).startsWith('/nfc-devices/inventory'))?.[0];
    expect(String(lastInventory)).toContain('sort=identifier');
    expect(String(lastInventory)).toContain('dir=asc');

    fireEvent.click(screen.getByRole('button',{name:'Weiter →'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith(expect.stringContaining('page=2')));
  });

  it('öffnet die Geräteakte über die Tabellenzeile',async()=>{
    renderOverview();
    fireEvent.click((await screen.findAllByText('TAG-001'))[0]);
    expect(await screen.findByText('Geräteakte-Ansicht')).toBeTruthy();
  });

  it('validiert die Registrierung und zeigt Duplikatfehler',async()=>{
    renderOverview();
    fireEvent.click(await screen.findByRole('button',{name:'NFC-Gerät registrieren'}));
    const dialog=await screen.findByRole('dialog');
    const form=dialog.querySelector('form') as HTMLFormElement;
    fireEvent.submit(form);
    expect(await screen.findByText('Bitte eine NFC-Kennung angeben.')).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText('z. B. NFC-0042'),{target:{value:'TAG-001'}});
    fireEvent.change(screen.getByPlaceholderText('Herstellername'),{target:{value:'Acme'}});
    apiMock.mockImplementation(async(path:string,options?:RequestInit)=>{
      if((options?.method??'GET')==='POST')throw new ApiError('Diese NFC-Kennung ist bereits vergeben',409,{identifier:'Diese NFC-Kennung ist bereits vergeben'});
      if(path.startsWith('/nfc-devices/overview'))return overview;
      if(path.startsWith('/nfc-devices/inventory'))return inventory;
      if(path==='/nfc-devices/filter-options')return options;
      if(path.startsWith(`/nfc-devices/${deviceId}/scan-history`))return scans;
      return {};
    });
    fireEvent.submit(form);
    expect(await screen.findByText('Diese NFC-Kennung ist bereits vergeben.')).toBeTruthy();
  });

  it('führt eine bestätigungspflichtige Sperre mit Begründung aus',async()=>{
    renderOverview();
    fireEvent.click(await screen.findByRole('button',{name:'Sperren'}));
    const dialog=await screen.findByRole('dialog');
    fireEvent.change(await screen.findByPlaceholderText('Grund der Änderung'),{target:{value:'Missbrauch verdächtig'}});
    fireEvent.click(dialog.querySelector('button[type="submit"]') as HTMLButtonElement);
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith('/nfc-devices/'+deviceId+'/block',
      expect.objectContaining({method:'POST',body:JSON.stringify({reason:'Missbrauch verdächtig'})})));
  });

  it('zeigt leere Datenbestände ohne Fehler an',async()=>{
    apiMock.mockImplementation(async(path:string)=>{
      if(path.startsWith('/nfc-devices/overview'))return {...overview,recent:[]};
      if(path.startsWith('/nfc-devices/inventory'))return {rows:[],total:0,page:1,pageSize:25,totalPages:1};
      if(path==='/nfc-devices/filter-options')return options;
      if(path.startsWith(`/nfc-devices/${deviceId}/scan-history`))return scans;
      return {};
    });
    renderOverview();
    expect(await screen.findByText('Keine Daten erfasst.')).toBeTruthy();
  });

  it('filtert die Liste über die Kennzahlen für archivierte und kürzlich verwendete Geräte',async()=>{
    renderOverview();
    fireEvent.click(await screen.findByRole('button',{name:/Archiviert/}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith(expect.stringContaining('archived=true')));
    fireEvent.click(screen.getByRole('button',{name:/Kürzlich verwendet/}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith(expect.stringContaining('recent=true')));
  });

  it('registriert Gerät mit Modell, Seriennummer und Beschreibung',async()=>{
    renderOverview();
    fireEvent.click(await screen.findByRole('button',{name:'NFC-Gerät registrieren'}));
    const dialog=await screen.findByRole('dialog');
    fireEvent.change(screen.getByPlaceholderText('z. B. NFC-0042'),{target:{value:'TAG-003'}});
    fireEvent.change(screen.getByPlaceholderText('Herstellername'),{target:{value:'Acme'}});
    fireEvent.change(screen.getByPlaceholderText('z. B. MIFARE Classic 1K'),{target:{value:'MIFARE 1K'}});
    fireEvent.change(screen.getByPlaceholderText('Seriennummer'),{target:{value:'SN-12345'}});
    fireEvent.change(screen.getByPlaceholderText('Kurzbeschreibung'),{target:{value:'Eingangskarte'}});
    fireEvent.submit(dialog.querySelector('form') as HTMLFormElement);
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith('/nfc-devices',expect.objectContaining({method:'POST'})));
    const body=String(apiMock.mock.calls.find(([path,init])=>path==='/nfc-devices'&&init?.method==='POST')?.[1]?.body);
    expect(body).toContain('MIFARE 1K');
    expect(body).toContain('SN-12345');
    expect(body).toContain('Eingangskarte');
  });

  it('nimmt ein verlorenes Gerät erst nach Bestätigung in die Quarantäne',async()=>{
    apiMock.mockImplementation(async(path:string,init?:RequestInit)=>{
      if(path.startsWith('/nfc-devices/overview'))return overview;
      if(path.startsWith('/nfc-devices/inventory'))return {...inventory,rows:[{...device,status:'lost'}]};
      if(path==='/nfc-devices/filter-options')return options;
      if(init?.method==='POST')return {...device,status:'blocked'};
      if(path.startsWith(`/nfc-devices/${deviceId}/scan-history`))return scans;
      return {};
    });
    renderOverview();
    fireEvent.click(await screen.findByRole('button',{name:'Wieder in Betrieb'}));
    const dialog=await screen.findByRole('dialog');
    fireEvent.change(screen.getByPlaceholderText('TAG-001'),{target:{value:'TAG-001'}});
    fireEvent.click(dialog.querySelector('input[type="checkbox"]') as HTMLInputElement);
    fireEvent.change(screen.getByPlaceholderText('Grund der Änderung'),{target:{value:'Wiedergefunden und geprüft'}});
    fireEvent.click(screen.getByRole('button',{name:'Wieder in Betrieb nehmen'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith(`/nfc-devices/${deviceId}/recover`,expect.objectContaining({method:'POST'})));
    const call=apiMock.mock.calls.find(([path])=>String(path).endsWith('/recover'));
    expect(JSON.parse(String(call?.[1]?.body))).toEqual(expect.objectContaining({
      identifier_confirmation:'TAG-001',assignment_confirmed:true,reason:'Wiedergefunden und geprüft',
    }));
  });

  it('zeigt im Austauschdialog auch die Kennung eines neuen Ersatzgeräts in der Zusammenfassung',async()=>{
    apiMock.mockImplementation(async(path:string,init?:RequestInit)=>{
      if(path.startsWith('/nfc-devices/overview'))return overview;
      if(path.startsWith('/nfc-devices/inventory'))return {...inventory,rows:[{...device,status:'lost'}]};
      if(path==='/nfc-devices/filter-options')return options;
      if(init?.method==='POST')return device;
      return {};
    });
    renderOverview();
    fireEvent.click(await screen.findByRole('button',{name:'Ersatz'}));
    fireEvent.change(await screen.findByLabelText(/NFC-Kennung des Ersatzgeräts/),{target:{value:'TAG-NEU'}});
    expect(await screen.findByText(/TAG-NEU · Nicht zugewiesen · Neu nach Austausch aktiv/)).toBeTruthy();
  });

  it('tauscht gegen ein vorhandenes Gerät ohne Neu-registrierung',async()=>{
    apiMock.mockImplementation(async(path:string,init?:RequestInit)=>{
      if(path.startsWith('/nfc-devices/overview'))return overview;
      if(path.startsWith('/nfc-devices/inventory'))return {...inventory,rows:[{...device,status:'lost'}]};
      if(path==='/nfc-devices/filter-options')return options;
      if(init?.method==='POST')return device;
      if(path.startsWith(`/nfc-devices/${deviceId}/scan-history`))return scans;
      return {};
    });
    renderOverview();
    fireEvent.click(await screen.findByRole('button',{name:'Ersatz'}));
    const dialog=await screen.findByRole('dialog');
    fireEvent.change(screen.getByLabelText('Ersatzgerät-Art'),{target:{value:'existing'}});
    fireEvent.change(dialog.querySelector('select[aria-label="Ersatzgerät"]') as HTMLSelectElement,{target:{value:newDeviceId}});
    fireEvent.change(screen.getByLabelText(/Austauschgrund/),{target:{value:'Defekt'}});
    fireEvent.click(screen.getByLabelText(/bestätige den Austausch/));
    fireEvent.click(screen.getByRole('button',{name:'Austausch durchführen'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith(`/nfc-devices/${deviceId}/replace`,expect.objectContaining({method:'POST'})));
    const call=apiMock.mock.calls.find(([path])=>String(path).endsWith('/replace'));
    expect(JSON.parse(String(call?.[1]?.body))).toEqual(expect.objectContaining({new_device_id:newDeviceId,reason:'Defekt',copy_assignment:false}));
  });

  it('zeigt die Zuordnung des Ersatzgeräts und verlangt eine ausdrückliche Freigabe',async()=>{
    apiMock.mockImplementation(async(path:string,init?:RequestInit)=>{
      if(path.startsWith('/nfc-devices/overview'))return overview;
      if(path.startsWith('/nfc-devices/inventory'))return {...inventory,rows:[{...device,status:'lost'}]};
      if(path==='/nfc-devices/filter-options')return {...options,devices:[{...options.devices[0],status:'blocked',control_point_id:pointId,control_point_name:'Punkt 1',site_name:'Objekt 1'}]};
      if(init?.method==='POST')return device;
      return {};
    });
    renderOverview();
    fireEvent.click(await screen.findByRole('button',{name:'Ersatz'}));
    const dialog=await screen.findByRole('dialog');
    fireEvent.change(screen.getByLabelText('Ersatzgerät-Art'),{target:{value:'existing'}});
    fireEvent.change(dialog.querySelector('select[aria-label="Ersatzgerät"]') as HTMLSelectElement,{target:{value:newDeviceId}});
    expect(await screen.findByText(/Punkt 1 · Objekt 1 · Gesperrt/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Austauschgrund/),{target:{value:'Defekt'}});
    const checks=Array.from(dialog.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
    for(const check of checks)if(check.required)fireEvent.click(check);
    fireEvent.click(screen.getByRole('button',{name:'Austausch durchführen'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith(`/nfc-devices/${deviceId}/replace`,expect.objectContaining({method:'POST'})));
    const body=JSON.parse(String(apiMock.mock.calls.find(([path])=>String(path).endsWith('/replace'))?.[1]?.body));
    expect(body).toEqual(expect.objectContaining({acknowledge_existing_assignment:true,acknowledge_restricted:true,copy_assignment:false}));
  });

  it('Szenario A: setzt Bestätigungen beim Wechsel von Ersatzgerät A auf B zurück',async()=>{
    mockReplaceApi([assignedBlockedA,assignedBlockedB]);
    const dialog=await openReplaceDialog();
    selectExistingCandidate(dialog,candidateA);
    fireEvent.change(screen.getByLabelText(/Austauschgrund/),{target:{value:'Defekt A'}});
    checkRequired(dialog);
    expect(requiredChecks(dialog).every(check=>check.checked)).toBe(true);

    selectExistingCandidate(dialog,candidateB);
    expect(requiredChecks(dialog).every(check=>!check.checked)).toBe(true);
    expect(screen.getByText(/TAG-B · Ava Worker · Gesperrt/)).toBeTruthy();
    fireEvent.submit(dialog.querySelector('form') as HTMLFormElement);
    expect(replaceBody()).toBeUndefined();
    expect(screen.getByText(/Zusammenfassung hat sich geändert/)).toBeTruthy();

    // Ein Wechsel zurück darf die alte Bestätigung nicht wiederherstellen.
    selectExistingCandidate(dialog,candidateA);
    expect(requiredChecks(dialog).every(check=>!check.checked)).toBe(true);
    selectExistingCandidate(dialog,candidateB);
    checkRequired(dialog);
    fireEvent.click(screen.getByRole('button',{name:'Austausch durchführen'}));
    await waitFor(()=>expect(replaceBody()).toBeDefined());
    expect(replaceBody()).toEqual(expect.objectContaining({
      new_device_id:candidateB,acknowledged_device_id:candidateB,reason:'Defekt A',
      acknowledge_existing_assignment:true,acknowledge_restricted:true,
    }));
  });

  it('Szenario B: macht die Bestätigung beim Wechsel auf ein neues Gerät ungültig',async()=>{
    mockReplaceApi([assignedBlockedA]);
    const dialog=await openReplaceDialog();
    selectExistingCandidate(dialog,candidateA);
    fireEvent.change(screen.getByLabelText(/Austauschgrund/),{target:{value:'Defekt'}});
    checkRequired(dialog);
    expect(requiredChecks(dialog).every(check=>check.checked)).toBe(true);

    fireEvent.change(screen.getByLabelText('Ersatzgerät-Art'),{target:{value:'new'}});
    expect(requiredChecks(dialog).every(check=>!check.checked)).toBe(true);
    expect(screen.getByText(/Neu nach Austausch aktiv/)).toBeTruthy();
    fireEvent.submit(dialog.querySelector('form') as HTMLFormElement);
    expect(replaceBody()).toBeUndefined();
    fireEvent.change(screen.getByLabelText(/NFC-Kennung des Ersatzgeräts/),{target:{value:'TAG-NEU'}});
    fireEvent.change(within(dialog).getByLabelText(/Hersteller/),{target:{value:'Acme'}});
    checkRequired(dialog);
    fireEvent.click(screen.getByRole('button',{name:'Austausch durchführen'}));
    await waitFor(()=>expect(replaceBody()).toBeDefined());
    expect(replaceBody()).toEqual(expect.objectContaining({
      identifier:'TAG-NEU',manufacturer:'Acme',reason:'Defekt',copy_assignment:false,
    }));
    expect(replaceBody()?.new_device_id).toBeUndefined();
  });

  it('Szenario C: setzt Bestätigung und Zuordnungsfreigabe bei geänderter Übernahme zurück',async()=>{
    mockReplaceApi([assignedBlockedA]);
    const dialog=await openReplaceDialog();
    selectExistingCandidate(dialog,candidateA);
    fireEvent.change(screen.getByLabelText(/Austauschgrund/),{target:{value:'Defekt'}});
    fireEvent.click(screen.getByLabelText(/Zuordnung übernehmen/));
    checkRequired(dialog);
    expect(screen.getByText(/Die bisherige Zuordnung wird auf das Ersatzgerät übernommen/)).toBeTruthy();

    fireEvent.click(screen.getByLabelText(/Zuordnung übernehmen/));
    expect((screen.getByLabelText(/bestätige den Austausch/) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText(/Bestehende Zuordnung des Ersatzgeräts/) as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText(/nicht übernommen und nur in der Historie/)).toBeTruthy();
    fireEvent.submit(dialog.querySelector('form') as HTMLFormElement);
    expect(replaceBody()).toBeUndefined();
    checkRequired(dialog);
    fireEvent.click(screen.getByRole('button',{name:'Austausch durchführen'}));
    await waitFor(()=>expect(replaceBody()).toBeDefined());
    expect(replaceBody()).toEqual(expect.objectContaining({
      new_device_id:candidateA,copy_assignment:false,acknowledge_existing_assignment:true,
    }));
  });

  it('Szenario D: ungültige Bestätigung nach Änderung des Austauschgrunds',async()=>{
    mockReplaceApi([assignedBlockedA]);
    const dialog=await openReplaceDialog();
    selectExistingCandidate(dialog,candidateA);
    fireEvent.change(screen.getByLabelText(/Austauschgrund/),{target:{value:'Defekt'}});
    checkRequired(dialog);
    fireEvent.change(screen.getByLabelText(/Austauschgrund/),{target:{value:'Verschleiß'}});
    expect((screen.getByLabelText(/bestätige den Austausch/) as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText(/Verschleiß/)).toBeTruthy();
    fireEvent.submit(dialog.querySelector('form') as HTMLFormElement);
    expect(replaceBody()).toBeUndefined();
    checkRequired(dialog);
    fireEvent.click(screen.getByRole('button',{name:'Austausch durchführen'}));
    await waitFor(()=>expect(replaceBody()?.reason).toBe('Verschleiß'));
  });

  it('Szenario E: blockiert eine sofortige Ausführung nach geänderter Notiz',async()=>{
    mockReplaceApi([assignedBlockedA]);
    const dialog=await openReplaceDialog();
    selectExistingCandidate(dialog,candidateA);
    fireEvent.change(screen.getByLabelText(/Austauschgrund/),{target:{value:'Defekt'}});
    checkRequired(dialog);
    fireEvent.change(screen.getByLabelText(/Notizen/),{target:{value:'Neue information'}});
    expect((screen.getByLabelText(/bestätige den Austausch/) as HTMLInputElement).checked).toBe(false);
    fireEvent.submit(dialog.querySelector('form') as HTMLFormElement);
    expect(replaceBody()).toBeUndefined();
    expect(screen.getByText(/Zusammenfassung hat sich geändert/)).toBeTruthy();
  });

  it('archiviert ein Gerät über den begründeten Workflow',async()=>{
    renderOverview();
    fireEvent.click(await screen.findByRole('button',{name:'Archivieren'}));
    const dialog=await screen.findByRole('dialog');
    fireEvent.change(screen.getByPlaceholderText('Grund der Änderung'),{target:{value:'Außerbetriebnahme'}});
    fireEvent.click(dialog.querySelector('button[type="submit"]') as HTMLButtonElement);
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith(`/nfc-devices/${deviceId}/archive`,
      expect.objectContaining({method:'POST',body:JSON.stringify({reason:'Außerbetriebnahme'})})));
  });
});

describe('NFC-Geräteakte',()=>{
  it('zeigt Stammdaten, Zuordnungshistorie, Scan-Historie und Dokumente',async()=>{
    renderFile();
    expect((await screen.findAllByText('TAG-001')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Punkt 1 · Objekt 1').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('tab',{name:'Zuordnung'}));
    expect(await screen.findByText('Zuordnungshistorie')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab',{name:'Scan-Historie'}));
    expect(await screen.findByText('Erfolgreich')).toBeTruthy();
    expect(screen.getByText(/Abgelehnt · NFC-Tag ist nicht aktiv/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab',{name:'Dokumente'}));
    expect(await screen.findByText('Prüfprotokoll')).toBeTruthy();
    expect(screen.getByRole('button',{name:'Version 2 herunterladen'})).toBeTruthy();
  });

  it('speichert eine neue Zuordnung über den dedizierten Endpunkt',async()=>{
    renderFile();
    expect((await screen.findAllByText('TAG-001')).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('tab',{name:'Zuordnung'}));
    expect(screen.getByLabelText('Zuordnung',{exact:true})).toBeTruthy();
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith('/nfc-devices/filter-options'));
    fireEvent.change(screen.getAllByRole('combobox')[0],{target:{value:'employee'}});
    await screen.findByRole('option',{name:'Ava Worker'});
    fireEvent.change(screen.getAllByRole('combobox')[1],{target:{value:employeeId}});
    fireEvent.click(screen.getByRole('button',{name:'Zuordnung speichern'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith(`/nfc-devices/${deviceId}/assign`,
      expect.objectContaining({method:'POST',body:JSON.stringify({employee_id:employeeId})})));
  });

  it('trennt Stammdaten von der Zuordnung und speichert alle technischen Felder',async()=>{
    renderFile();
    await screen.findByRole('heading',{name:'TAG-001'});
    fireEvent.click(screen.getByRole('tab',{name:'Technische Stammdaten'}));
    expect(await screen.findByText(/ausschließlich die technischen Eigenschaften/)).toBeTruthy();
    expect(screen.queryByLabelText('Zuordnung')).toBeNull();
    fireEvent.change(screen.getByLabelText(/Modell/),{target:{value:'MX-20'}});
    fireEvent.change(screen.getByLabelText(/Seriennummer/),{target:{value:'SN-2'}});
    fireEvent.change(screen.getByLabelText(/Beschreibung/),{target:{value:'Technik'}});
    fireEvent.change(screen.getByLabelText(/Interne Notizen/),{target:{value:'Intern'}});
    fireEvent.click(screen.getByRole('button',{name:'Speichern'}));
    await waitFor(()=>{
      const call=apiMock.mock.calls.find(([path,init])=>path===`/nfc-devices/${deviceId}`&&init?.method==='PATCH');
      expect(call).toBeTruthy();
      const body=JSON.parse(String(call?.[1]?.body));
      expect(body).toEqual(expect.objectContaining({model:'MX-20',serial_number:'SN-2',description:'Technik',notes:'Intern'}));
      expect(body).not.toHaveProperty('employee_id');
      expect(body).not.toHaveProperty('site_id');
      expect(body).not.toHaveProperty('control_point_id');
    });
  });

  it('fragt bei nicht gespeicherten Stammdaten vor dem Verlassen des Bereichs nach',async()=>{
    const confirmMock=vi.spyOn(window,'confirm').mockReturnValue(false);
    renderFile();
    await screen.findByRole('heading',{name:'TAG-001'});
    fireEvent.click(screen.getByRole('tab',{name:'Technische Stammdaten'}));
    fireEvent.change(screen.getByLabelText(/Modell/),{target:{value:'MX-20'}});
    fireEvent.click(screen.getByRole('tab',{name:'Zuordnung'}));
    expect(confirmMock).toHaveBeenCalled();
    expect(screen.getByRole('tab',{name:'Technische Stammdaten'}).getAttribute('aria-selected')).toBe('true');
    confirmMock.mockRestore();
  });

  it('zeigt Zuordnungen im Ereignisverlauf als lesbare Namen statt Rohdaten',async()=>{
    renderFile();
    await screen.findByRole('heading',{name:'TAG-001'});
    fireEvent.click(screen.getByRole('tab',{name:'Status & Ereignisse'}));
    expect(await screen.findByText('Zuordnung: Punkt 1 · Objekt 1')).toBeTruthy();
    expect(screen.queryByText(/control_point_id/)).toBeNull();
  });

  it('verwirft Änderungen nach Bestätigung vollständig und zeigt keine Warnung mehr',async()=>{
    const confirmMock=vi.spyOn(window,'confirm').mockReturnValue(true);
    renderFile();
    await screen.findByRole('heading',{name:'TAG-001'});
    fireEvent.click(screen.getByRole('tab',{name:'Technische Stammdaten'}));
    fireEvent.change(screen.getByLabelText(/Modell/),{target:{value:'MX-20'}});
    fireEvent.click(screen.getByRole('tab',{name:'Zuordnung'}));
    expect(screen.getByRole('tab',{name:'Zuordnung'}).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByText(/Nicht gespeicherte Änderungen/)).toBeNull();
    fireEvent.click(screen.getByRole('tab',{name:'Technische Stammdaten'}));
    expect((screen.getByLabelText(/Modell/) as HTMLInputElement).value).toBe('');
    confirmMock.mockRestore();
  });

  it('setzt den Änderungsstatus vor der Erfolgsmeldung zurück und erlaubt dann den Bereichswechsel',async()=>{
    let finishReload!:()=>void;
    const pendingReload=new Promise<void>(resolve=>{finishReload=resolve;});
    let fileCalls=0;
    apiMock.mockImplementation(async(path:string,init?:RequestInit)=>{
      if(path===`/nfc-devices/${deviceId}/file`){
        fileCalls+=1;
        return fileCalls===1?fileData:pendingReload.then(()=>fileData);
      }
      if(path==='/nfc-devices/filter-options')return options;
      if(path===`/nfc-devices/${deviceId}`&&init?.method==='PATCH')return device;
      return {};
    });
    const confirmMock=vi.spyOn(window,'confirm').mockReturnValue(false);
    renderFile();
    await screen.findByRole('heading',{name:'TAG-001'});
    fireEvent.click(screen.getByRole('tab',{name:'Technische Stammdaten'}));
    fireEvent.change(screen.getByLabelText(/Modell/),{target:{value:'MX-20'}});
    fireEvent.click(screen.getByRole('button',{name:'Speichern'}));
    expect(await screen.findByText('Stammdaten wurden gespeichert.')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab',{name:'Zuordnung'}));
    expect(confirmMock).not.toHaveBeenCalled();
    expect(screen.getByRole('tab',{name:'Zuordnung'}).getAttribute('aria-selected')).toBe('true');
    finishReload();
    confirmMock.mockRestore();
  });

  it('verhindert mehrfaches Speichern der Stammdaten während eines laufenden Vorgangs',async()=>{
    let finish!:()=>void;
    const pending=new Promise<void>(resolve=>{finish=resolve;});
    apiMock.mockImplementation(async(path:string,init?:RequestInit)=>{
      if(path===`/nfc-devices/${deviceId}/file`)return fileData;
      if(path==='/nfc-devices/filter-options')return options;
      if(path===`/nfc-devices/${deviceId}`&&init?.method==='PATCH')return pending.then(()=>device);
      return {};
    });
    renderFile();
    await screen.findByRole('heading',{name:'TAG-001'});
    fireEvent.click(screen.getByRole('tab',{name:'Technische Stammdaten'}));
    const button=screen.getByRole('button',{name:'Speichern'}) as HTMLButtonElement;
    fireEvent.click(button);
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain('Wird gespeichert');
    fireEvent.click(button);
    finish();
    await waitFor(()=>expect(apiMock.mock.calls.filter(([path,init])=>path===`/nfc-devices/${deviceId}`&&init?.method==='PATCH')).toHaveLength(1));
  });

  it('zeigt Downloadfehler direkt im Dokumentenbereich',async()=>{
    const fetchMock=vi.fn().mockRejectedValue(new Error('Download nicht verfügbar'));
    vi.stubGlobal('fetch',fetchMock);
    try{
      renderFile();
      await screen.findByRole('heading',{name:'TAG-001'});
      fireEvent.click(screen.getByRole('tab',{name:'Dokumente'}));
      fireEvent.click(await screen.findByRole('button',{name:'Version 2 herunterladen'}));
      expect((await screen.findByRole('alert')).textContent).toContain('Download nicht verfügbar');
    }finally{vi.unstubAllGlobals();}
  });

  it('meldet Verlust mit Datum und Begründung über den Workflow-Endpunkt',async()=>{
    renderFile();
    fireEvent.click(await screen.findByRole('button',{name:'Verlust melden'}));
    const dialog=await screen.findByRole('dialog');
    fireEvent.change(screen.getByPlaceholderText('Grund der Änderung'),{target:{value:'Verloren im Transit'}});
    fireEvent.click(dialog.querySelector('button[type="submit"]') as HTMLButtonElement);
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith(`/nfc-devices/${deviceId}/report-lost`,
      expect.objectContaining({method:'POST'})));
  });

  it('zeigt Wiederauffindung, Archivierung und ausführende Benutzer im Verlauf',async()=>{
    mockApi({...fileData,device:{...device,status:'blocked',recovered_at:'2026-11-27T09:00:00Z',archived_at:'2026-11-28T09:00:00Z'}});
    renderFile();
    expect(await screen.findByText('Wiedergefunden')).toBeTruthy();
    expect(screen.getAllByText('Archiviert').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('tab',{name:'Status & Ereignisse'}));
    expect((await screen.findAllByText(/Ausgeführt: operator@example.invalid/)).length).toBeGreaterThan(0);
  });

  it('lädt die echte Scan-Historie mit Filtern und Pagination aus dem dedizierten Endpunkt',async()=>{
    renderFile();
    expect((await screen.findAllByText('TAG-001')).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('tab',{name:'Scan-Historie'}));
    expect(await screen.findByText('Erfolgreich')).toBeTruthy();
    expect(screen.getByText(/Abgelehnt · NFC-Tag ist nicht aktiv/)).toBeTruthy();
    expect(screen.getByText('Registrierte NFC-Kennung')).toBeTruthy();
    expect(await screen.findByText('Seite 1 von 2 · 27 Scan-Ereignisse')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Ergebnis filtern'),{target:{value:'rejected'}});
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith(expect.stringContaining('outcome=rejected')));
    fireEvent.click(screen.getByRole('button',{name:'Weiter →'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith(expect.stringContaining('page=2')));
  });

  it('blendet die Ersatzaktion bei ersetzten und archivierten Geräten aus',async()=>{
    mockApi({...fileData,device:{...device,status:'replaced',replaced_at:'2026-11-26T12:00:00Z'}});
    renderFile();
    expect((await screen.findAllByText(/Ersetzt/)).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button',{name:'Ersatzgerät festlegen'})).toBeNull();
    expect(screen.queryByRole('button',{name:'Wieder in Betrieb nehmen'})).toBeNull();
    cleanup();

    mockApi({...fileData,device:{...device,status:'blocked',archived_at:'2026-11-26T12:00:00Z'}});
    renderFile();
    await screen.findByRole('heading',{name:'TAG-001'});
    expect(screen.queryByRole('button',{name:'Ersatzgerät festlegen'})).toBeNull();
    expect(screen.queryByRole('button',{name:'Reaktivieren'})).toBeNull();
  });

  it('Geräteakte: setzt Bestätigungen beim Ersatzgerätewechsel zurück und sendet erst nach erneuter Prüfung',async()=>{
    apiMock.mockImplementation(async(path:string,init?:RequestInit)=>{
      if(path===`/nfc-devices/${deviceId}/file`)return {...fileData,device:{...device,status:'lost'}};
      if(path==='/nfc-devices/filter-options')return {...options,devices:[assignedBlockedA,assignedBlockedB]};
      if(init?.method==='POST')return device;
      return {};
    });
    renderFile();
    fireEvent.click(await screen.findByRole('button',{name:'Ersatzgerät festlegen'}));
    const dialog=await screen.findByRole('dialog');
    selectExistingCandidate(dialog,candidateA);
    fireEvent.change(screen.getByLabelText(/Austauschgrund/),{target:{value:'Verlust'}});
    checkRequired(dialog);
    expect(requiredChecks(dialog).every(check=>check.checked)).toBe(true);

    selectExistingCandidate(dialog,candidateB);
    expect(requiredChecks(dialog).every(check=>!check.checked)).toBe(true);
    fireEvent.submit(dialog.querySelector('form') as HTMLFormElement);
    expect(replaceBody()).toBeUndefined();
    checkRequired(dialog);
    fireEvent.click(screen.getByRole('button',{name:'Austausch durchführen'}));
    await waitFor(()=>expect(replaceBody()).toEqual(expect.objectContaining({
      new_device_id:candidateB,acknowledged_device_id:candidateB,reason:'Verlust',
    })));
  });

  it('verhindert Zuordnungsänderungen an gesperrten Geräten auch über die Stammdaten',async()=>{
    mockApi({...fileData,device:{...device,status:'blocked',blocked_at:'2026-11-26T12:00:00Z'}});
    renderFile();
    fireEvent.click(await screen.findByRole('tab',{name:'Zuordnung'}));
    expect(screen.getByText(/Nur aktive, nicht archivierte und nicht ersetzte Geräte/)).toBeTruthy();
    expect(screen.queryByRole('button',{name:'Zuordnung speichern'})).toBeNull();

    fireEvent.click(screen.getByRole('button',{name:'Stammdaten bearbeiten'}));
    const dialog=await screen.findByRole('dialog');
    fireEvent.click(dialog.querySelector('button[type="submit"]') as HTMLButtonElement);
    await waitFor(()=>{
      const call=apiMock.mock.calls.find(([path,init])=>path===`/nfc-devices/${deviceId}`&&init?.method==='PATCH');
      expect(call).toBeTruthy();
      const body=JSON.parse(String(call?.[1]?.body));
      expect(body).not.toHaveProperty('employee_id');
      expect(body).not.toHaveProperty('site_id');
      expect(body).not.toHaveProperty('control_point_id');
    });
  });
});
