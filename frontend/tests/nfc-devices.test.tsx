/** @vitest-environment jsdom */
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
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
import {NfcDeviceFile} from '../src/pages/NfcDeviceFile';
import {NfcDevices} from '../src/pages/NfcDevices';

const deviceId='00000000-0000-4000-8000-000000000020';
const siteId='00000000-0000-4000-8000-000000000030';
const pointId='00000000-0000-4000-8000-000000000031';
const employeeId='00000000-0000-4000-8000-000000000032';
const device={
  id:deviceId,identifier:'TAG-001',device_type:'tag',manufacturer:'Acme',status:'active',
  employee_id:null,site_id:null,control_point_id:pointId,employee_name:null,site_name:'Objekt 1',
  control_point_name:'Punkt 1',control_point_site_id:siteId,notes:'Notiz',
  registered_at:'2026-01-01T10:00:00Z',updated_at:'2026-01-02T10:00:00Z',last_used_at:'2026-11-26T10:00:00Z',
};
const overview={
  total:10,active_tags:6,active_readers:2,blocked:1,lost:1,replaced:1,unassigned:3,scans:42,devices:5,days:30,
  recent:[device],
};
const options={
  sites:[{id:siteId,name:'Objekt 1'}],
  control_points:[{id:pointId,site_id:siteId,name:'Punkt 1',site_name:'Objekt 1'}],
  employees:[{id:employeeId,name:'Ava Worker'}],
};
const inventory={rows:[device],total:26,page:1,pageSize:25,totalPages:2};
const fileData={
  device,
  assignment_history:[{id:'a-1',previous_assignment:{},assignment:{control_point_id:pointId},assigned_at:'2026-01-02T10:00:00Z',reason:'Initial'}],
  replacements:[],
  scans:[
    {id:'s-1',control_point_name:'Punkt 1',site_name:'Objekt 1',route_name:'Nacht_runde',employee_name:'Ava Worker',scanned_at:'2026-11-26T10:00:00Z',server_received_at:'2026-11-26T10:00:01Z',outcome:'accepted'},
    {id:'s-2',outcome:'rejected',reason:'NFC-Tag ist nicht aktiv',code:'NFC_TAG_NOT_ACTIVE',server_received_at:'2026-11-26T11:00:00Z'},
  ],
  documents:[{id:'doc-1',title:'Prüfprotokoll',document_number:'DOC-1',created_at:'2026-03-01T10:00:00Z',versions:[{id:'v2',version_no:2}]}],
  history:[{id:'audit-1',event_type:'nfc_device.created',details:{identifier:'TAG-001'},created_at:'2026-01-01T10:00:00Z'}],
};

function mockApi(fileOverride=fileData){
  apiMock.mockImplementation(async(path:string,init?:RequestInit)=>{
    const method=init?.method??'GET';
    if(path.startsWith('/nfc-devices/overview'))return overview;
    if(path.startsWith('/nfc-devices/inventory'))return inventory;
    if(path==='/nfc-devices/filter-options')return options;
    if(path===`/nfc-devices/${deviceId}/file`)return fileOverride;
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
      return {};
    });
    renderOverview();
    expect(await screen.findByText('Keine Daten erfasst.')).toBeTruthy();
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
  });

  it('speichert eine neue Zuordnung über den dedizierten Endpunkt',async()=>{
    renderFile();
    expect((await screen.findAllByText('TAG-001')).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('tab',{name:'Zuordnung'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith('/nfc-devices/filter-options'));
    fireEvent.change(screen.getAllByRole('combobox')[0],{target:{value:'employee'}});
    await screen.findByRole('option',{name:'Ava Worker'});
    fireEvent.change(screen.getAllByRole('combobox')[1],{target:{value:employeeId}});
    fireEvent.click(screen.getByRole('button',{name:'Zuordnung speichern'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith(`/nfc-devices/${deviceId}/assign`,
      expect.objectContaining({method:'POST',body:JSON.stringify({employee_id:employeeId})})));
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
});
