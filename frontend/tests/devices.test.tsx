/** @vitest-environment jsdom */
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {MemoryRouter,Route,Routes} from 'react-router-dom';

const apiMock=vi.hoisted(()=>vi.fn());
const permissionMock=vi.hoisted(()=>vi.fn((_code?:string)=>true));
vi.mock('../src/lib/api',()=>({api:apiMock,hasPermission:permissionMock,storedUser:()=>null,csrf:()=>'token'}));

import {Devices,DeviceFile} from '../src/pages/Devices';

const siteId='00000000-0000-4000-8000-000000000001';
const otherSiteId='00000000-0000-4000-8000-000000000002';
const deviceId='00000000-0000-4000-8000-000000000011';
const employeeId='00000000-0000-4000-8000-000000000021';
const otherEmployeeId='00000000-0000-4000-8000-000000000022';
const locationId='00000000-0000-4000-8000-000000000031';

const device={
  id:deviceId,name:'Zutrittsleser 01',status:'online',operational_status:'active',site_id:siteId,
  site_name:'Hauptobjekt',location_id:locationId,location_name:'Eingang',
  responsible_employee_id:employeeId,responsible_employee_name:'Ava Worker',
  asset_number:'INV-1',category:'Zutritt',manufacturer:'Secura',model:'Reader 3000',serial_number:'SN-1',
  installed_on:'2026-01-01',commissioned_on:'2026-01-02',last_inspection_on:'2026-01-10',
  next_inspection_on:'2026-12-01',maintenance_interval_days:90,last_maintenance_on:'2026-02-01',
  next_maintenance_on:'2026-05-01',effective_maintenance_on:'2026-05-01',
  inspection_state:'soon',maintenance_state:'planned',created_at:'2026-01-01',updated_at:'2026-03-01',
};
const metrics={
  total_devices:12,active_devices:8,maintenance_devices:1,faulty_devices:1,
  overdue_inspections:2,upcoming_maintenance:3,
};
const inventory={rows:[device],total:26,page:1,pageSize:25,totalPages:2};
const fileData={
  device,
  maintenance_orders:[{
    id:'00000000-0000-4000-8000-000000000041',order_number:'MAIN-2026-000001',device_id:deviceId,
    device_name:device.name,maintenance_type:'inspection',description:'Prüfung durchführen',priority_code:'medium',
    due_on:'2026-12-01',status:'planned',computed_status:'planned',status_label:'Geplant',overdue:false,
    responsible_employee_id:employeeId,responsible_employee_name:'Ava Worker',performed_work:null,result:null,
    next_maintenance_on:'2027-03-01',documents:[],created_at:'2026-03-01',
  }],
  alarms:[{id:'alarm-1',severity:'high',status:'open',message:'Leser gestört',triggered_at:'2026-03-02',resolved_at:null}],
  documents:[{
    id:'doc-1',title:'Prüfprotokoll',document_number:'DOC-1',document_type:'Prüfung',document_status:'active',
    approval_status:'approved',valid_until:'2027-01-01',latest_version_id:'version-1',created_at:'2026-03-01',
  }],
  history:[{
    id:'audit-1',event_type:'devices.inspection_updated',entity_type:'device',
    details:{changed_fields:['next_inspection_on']},created_at:'2026-03-03',
  }],
};

function mockApi(){
  apiMock.mockImplementation(async(path:string,options?:RequestInit)=>{
    const method=options?.method??'GET';
    if(path==='/devices/overview')return metrics;
    if(path.startsWith('/devices/inventory'))return inventory;
    if(path==='/devices/filter-options')return {categories:['Zutritt'],manufacturers:['Secura']};
    if(path.startsWith('/devices/locations/'))return [{id:locationId,name:'Eingang',code:'EG',location_type:'area',parent_id:null}];
    if(path==='/sites')return [{id:siteId,name:'Hauptobjekt'},{id:otherSiteId,name:'Nebenobjekt'}];
    if(path==='/employees')return [{id:employeeId,name:'Ava Worker'},{id:otherEmployeeId,name:'Ben Worker'}];
    if(path===`/devices/${deviceId}/file`)return fileData;
    if(method==='POST'||method==='PATCH')return {id:deviceId};
    return {};
  });
}

function renderOverview(){
  return render(<MemoryRouter initialEntries={['/devices']}><Routes>
    <Route path="/devices" element={<Devices/>}/>
    <Route path="/devices/:deviceId" element={<div>Geräteakte-Ansicht</div>}/>
  </Routes></MemoryRouter>);
}

function renderFile(){
  return render(<MemoryRouter initialEntries={[`/devices/${deviceId}`]}><Routes>
    <Route path="/devices/:deviceId" element={<DeviceFile/>}/>
  </Routes></MemoryRouter>);
}

beforeEach(()=>{
  cleanup();
  apiMock.mockReset();
  permissionMock.mockReset();
  permissionMock.mockReturnValue(true);
  mockApi();
});

describe('zentrale Geräteverwaltung',()=>{
  it('zeigt echte Kennzahlen und kombiniert Suche, Filter, Sortierung und Pagination',async()=>{
    renderOverview();
    expect(await screen.findByText('12')).toBeTruthy();
    expect(screen.getByText('Überfällige Prüfungen')).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText('Name, Inventar- oder Seriennummer'),{target:{value:'Leser'}});
    fireEvent.change(screen.getByLabelText('Kategorie'),{target:{value:'Zutritt'}});
    fireEvent.click(screen.getByRole('button',{name:/Überfällige Prüfungen/}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith(expect.stringContaining('search=Leser&category=Zutritt')));
    const inventoryCalls=apiMock.mock.calls.filter(([path]:string[])=>String(path).startsWith('/devices/inventory'));
    const lastInventory=inventoryCalls[inventoryCalls.length-1]?.[0];
    expect(String(lastInventory)).toContain('inspection_due=overdue');
    expect(String(lastInventory)).toContain('page=1');

    fireEvent.click(screen.getByRole('button',{name:/Gerätebezeichnung/}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith(expect.stringContaining('sort=name&dir=asc')));
    fireEvent.click(screen.getByRole('button',{name:'Weiter'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith(expect.stringContaining('page=2')));
  });

  it('öffnet die Geräteakte über eine anklickbare Tabellenzeile',async()=>{
    renderOverview();
    fireEvent.click(await screen.findByText('Zutrittsleser 01'));
    expect(await screen.findByText('Geräteakte-Ansicht')).toBeTruthy();
  });

  it('zeigt Lade-, Leer- und Fehlerzustände getrennt an',async()=>{
    apiMock.mockImplementation(async(path:string)=>{
      if(path==='/devices/overview')return metrics;
      if(path.startsWith('/devices/inventory'))return {rows:[],total:0,page:1,pageSize:25,totalPages:1};
      return {};
    });
    renderOverview();
    expect(await screen.findByText('Keine Geräte für die gewählten Filter erfasst.')).toBeTruthy();

    cleanup();
    apiMock.mockImplementation(async(path:string)=>{
      if(path==='/devices/overview')return metrics;
      if(path.startsWith('/devices/inventory'))throw new Error('Geräteliste nicht verfügbar');
      return {};
    });
    renderOverview();
    expect((await screen.findByRole('alert')).textContent).toContain('Geräteliste nicht verfügbar');
  });

  it('blendet schreibende Aktionen ohne devices:write aus',async()=>{
    permissionMock.mockImplementation((code?:string)=>code!=='devices:write'&&code!=='devices:delete');
    renderOverview();
    await screen.findByText('Zutrittsleser 01');
    expect(screen.queryByRole('button',{name:'Gerät anlegen'})).toBeNull();
    expect(screen.queryByRole('button',{name:'Ausmustern'})).toBeNull();
  });
});

describe('digitale Geräteakte',()=>{
  it('lädt alle Bereiche und speichert Stammdaten, Zuordnungen, Prüfung, Wartung und Dokumente',async()=>{
    renderFile();
    expect(await screen.findByRole('heading',{name:'Zutrittsleser 01'})).toBeTruthy();
    expect(screen.getByText('INV-1')).toBeTruthy();

    fireEvent.click(screen.getByRole('button',{name:'Technische Stammdaten'}));
    fireEvent.change(screen.getByLabelText('Inventarnummer'),{target:{value:'INV-2'}});
    fireEvent.click(screen.getByRole('button',{name:'Speichern'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith(`/devices/${deviceId}`,{method:'PATCH',body:expect.stringContaining('"asset_number":"INV-2"')}));

    fireEvent.click(screen.getByRole('button',{name:'Objekt zuordnen'}));
    fireEvent.change(screen.getAllByLabelText('Objekt')[0],{target:{value:otherSiteId}});
    fireEvent.click(screen.getByRole('button',{name:'Zuordnung speichern'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith(`/devices/${deviceId}/assign-site`,{
      method:'POST',body:JSON.stringify({site_id:otherSiteId,location_id:null}),
    }));

    fireEvent.click(screen.getByRole('button',{name:'Verantwortlichen ändern'}));
    fireEvent.change(screen.getAllByLabelText('Verantwortlicher Mitarbeiter')[0],{target:{value:otherEmployeeId}});
    fireEvent.click(screen.getByRole('button',{name:'Verantwortlichen speichern'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith(`/devices/${deviceId}/assign-responsible`,{
      method:'POST',body:JSON.stringify({responsible_employee_id:otherEmployeeId}),
    }));

    fireEvent.click(screen.getByRole('button',{name:'Prüfungen'}));
    fireEvent.change(screen.getByLabelText('Nächste Prüfung'),{target:{value:'2027-01-01'}});
    fireEvent.click(screen.getByRole('button',{name:'Prüfungsdaten speichern'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith(`/devices/${deviceId}/inspection`,{
      method:'POST',body:expect.stringContaining('"next_inspection_on":"2027-01-01"'),
    }));

    fireEvent.click(screen.getByRole('button',{name:/^Wartung$/}));
    fireEvent.change(screen.getByLabelText('Beschreibung *'),{target:{value:'Prüfung vor Ort'}});
    fireEvent.click(screen.getAllByRole('button',{name:'Wartungsauftrag erstellen'})[1]);
    await waitFor(()=>{
      const call=apiMock.mock.calls.find((entry:unknown[])=>entry[0]===`/sites/${siteId}/maintenance-orders`&&(entry[1] as RequestInit|undefined)?.method==='POST') as [string,RequestInit]|undefined;
      expect((call?.[1].headers as Record<string,string>|undefined)?.['Idempotency-Key']).toBeTruthy();
      expect(call?.[1].body).toContain(`"device_id":"${deviceId}"`);
    });

    fireEvent.click(screen.getByRole('button',{name:'Dokumente'}));
    expect(screen.getByText('Prüfprotokoll')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Titel *'),{target:{value:'Neues Protokoll'}});
    const input=screen.getByLabelText('Datei *') as HTMLInputElement;
    Object.defineProperty(input,'files',{configurable:true,value:[new File(['content'],'protokoll.pdf',{type:'application/pdf'})]});
    fireEvent.change(input);
    const documentForm=screen.getByRole('button',{name:'Dokument speichern'}).closest('form');
    if (!documentForm) throw new Error('Dokumentformular nicht gefunden');
    fireEvent.submit(documentForm);
    await waitFor(()=>{
      const call=apiMock.mock.calls.find((entry:unknown[])=>entry[0]==='/dms/documents'&&(entry[1] as RequestInit|undefined)?.method==='POST') as [string,RequestInit]|undefined;
      expect(call?.[1].body).toContain(`"device_id":"${deviceId}"`);
    });

    fireEvent.click(screen.getByRole('button',{name:'Änderungshistorie'}));
    expect(screen.getByText('Geräte: Prüfungsdaten geändert')).toBeTruthy();
  });

  it('normalisiert API-Zeitstempel auf Datumswerte vor dem Speichern der Stammdaten',async()=>{
    const handler=apiMock.getMockImplementation();
    apiMock.mockImplementation(async(path:string,options?:RequestInit)=>{
      if(path===`/devices/${deviceId}/file`)return {
        ...fileData,
        device:{
          ...device,
          installed_on:'2026-01-01T00:00:00.000Z',commissioned_on:'2026-01-02T00:00:00.000Z',
          last_inspection_on:'2026-01-10T00:00:00.000Z',next_inspection_on:'2026-12-01T00:00:00.000Z',
          last_maintenance_on:'2026-02-01T00:00:00.000Z',next_maintenance_on:'2026-05-01T00:00:00.000Z',
        },
      };
      return handler?.(path,options);
    });
    renderFile();
    expect(await screen.findByRole('heading',{name:'Zutrittsleser 01'})).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'Technische Stammdaten'}));
    fireEvent.click(screen.getByRole('button',{name:'Speichern'}));
    await waitFor(()=>{
      const call=apiMock.mock.calls.find((entry:unknown[])=>entry[0]===`/devices/${deviceId}`&&(entry[1] as RequestInit|undefined)?.method==='PATCH') as [string,RequestInit]|undefined;
      expect(call?.[1].body).toContain('"installed_on":"2026-01-01"');
      expect(call?.[1].body).toContain('"next_inspection_on":"2026-12-01"');
      expect(call?.[1].body).not.toContain('T00:00:00.000Z');
    });
  });

  it('löscht ein Gerät nur mit devices:delete nach ausdrücklicher Bestätigung',async()=>{
    const confirmMock=vi.spyOn(window,'confirm').mockReturnValue(true);
    renderFile();
    expect(await screen.findByRole('heading',{name:'Zutrittsleser 01'})).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'Endgültig löschen'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith(`/devices/${deviceId}`,{method:'DELETE'}));
    expect(confirmMock).toHaveBeenCalledWith(expect.stringContaining('endgültig gelöscht'));
    confirmMock.mockRestore();
  });

  it('blendet die endgültige Löschung ohne devices:delete aus',async()=>{
    permissionMock.mockImplementation((code?:string)=>code!=='devices:delete');
    renderFile();
    expect(await screen.findByRole('heading',{name:'Zutrittsleser 01'})).toBeTruthy();
    expect(screen.queryByRole('button',{name:'Endgültig löschen'})).toBeNull();
  });

  it('zeigt Störungen und verhindert Aktionen ohne Schreibberechtigung',async()=>{
    permissionMock.mockImplementation((code?:string)=>code==='devices:read'||code==='dms:read');
    renderFile();
    expect(await screen.findByRole('heading',{name:'Zutrittsleser 01'})).toBeTruthy();
    expect(screen.queryByRole('button',{name:'Stammdaten bearbeiten'})).toBeNull();
    expect(screen.queryByRole('button',{name:'Objekt zuordnen'})).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'Störungen & Ereignisse'}));
    expect(screen.getByText(/Leser gestört/)).toBeTruthy();
  });

  it('meldet fehlende Geräteakte und bietet die Rückkehr zur Übersicht',async()=>{
    apiMock.mockImplementation(async()=>{
      throw new Error('Gerät nicht gefunden');
    });
    renderFile();
    expect((await screen.findByRole('alert')).textContent).toContain('Gerät nicht gefunden');
    expect(screen.getByRole('button',{name:'Zurück zur Übersicht'})).toBeTruthy();
  });
});
