/** @vitest-environment jsdom */
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {MemoryRouter} from 'react-router-dom';

const apiMock=vi.hoisted(()=>vi.fn());
const permissionMock=vi.hoisted(()=>vi.fn(()=>true));
vi.mock('../src/lib/api',()=>({api:apiMock,hasPermission:permissionMock,storedUser:()=>null,csrf:()=>'token'}));

import {Devices} from '../src/pages/Devices';
import {AlarmForwarding} from '../src/pages/AlarmForwarding';
import {Handovers} from '../src/pages/Handovers';
import {Qualifications} from '../src/pages/Qualifications';

beforeEach(()=>{cleanup();apiMock.mockReset();permissionMock.mockReset();permissionMock.mockReturnValue(true);});

describe('strict backend contracts',()=>{
  it('creates a device with all master data fields and a real site UUID',async()=>{
    const siteId='00000000-0000-4000-8000-000000000001';
    apiMock.mockImplementation(async(path:string,options?:RequestInit)=>{
      if(path==='/sites')return [{id:siteId,name:'Hauptobjekt'}];
      if(path==='/employees')return [];
      if(path==='/devices/filter-options')return {categories:['Zutritt'],manufacturers:['Secura']};
      if(path==='/devices/overview')return {};
      if(path.startsWith('/devices/inventory'))return {rows:[],total:0,page:1,pageSize:25,totalPages:1};
      if(path.startsWith('/devices/locations/'))return [];
      if(path==='/devices'&&options?.method==='POST')return {id:'new'};
      return {};
    });
    render(<MemoryRouter><Devices/></MemoryRouter>);
    await waitFor(()=>expect(screen.getAllByRole('option',{name:'Hauptobjekt'}).length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('button',{name:'Gerät anlegen'}));
    fireEvent.change(screen.getByLabelText(/Gerätebezeichnung/),{target:{value:'Leser 1'}});
    fireEvent.change(screen.getByLabelText('Inventarnummer'),{target:{value:'INV-1'}});
    fireEvent.change(screen.getAllByLabelText('Kategorie')[0],{target:{value:'Zutritt'}});
    fireEvent.change(screen.getAllByLabelText('Hersteller')[0],{target:{value:'Secura'}});
    fireEvent.change(screen.getByLabelText('Modell'),{target:{value:'Reader 3000'}});
    fireEvent.change(screen.getByLabelText('Seriennummer'),{target:{value:'SN-1'}});
    fireEvent.change(screen.getAllByLabelText('Objekt')[0],{target:{value:siteId}});
    fireEvent.change(screen.getByLabelText('Nächste Prüfung'),{target:{value:'2027-01-01'}});
    fireEvent.click(screen.getByRole('button',{name:'Speichern'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith('/devices',{method:'POST',body:JSON.stringify({
      name:'Leser 1',status:'online',operational_status:'active',maintenance_interval_days:null,
      asset_number:'INV-1',category:'Zutritt',manufacturer:'Secura',model:'Reader 3000',serial_number:'SN-1',
      site_id:siteId,location_id:null,responsible_employee_id:null,installed_on:null,commissioned_on:null,
      last_inspection_on:null,next_inspection_on:'2027-01-01',last_maintenance_on:null,next_maintenance_on:null,
    })}));
  });

  it('blocks a webhook destination without an endpoint before the API call',async()=>{
    apiMock.mockImplementation(async(path:string)=>{
      if(path.endsWith('/destinations'))return [];
      if(path.endsWith('/rules'))return [];
      return [];
    });
    render(<MemoryRouter><AlarmForwarding/></MemoryRouter>);
    await waitFor(()=>expect(screen.getByPlaceholderText('Name des Ziels')).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText('Name des Ziels'),{target:{value:'Webhook'}});
    fireEvent.change(screen.getAllByPlaceholderText('Grund für die Änderung')[0],{target:{value:'Initial Newsletter'}});
    fireEvent.click(screen.getByRole('button',{name:'Ziel anlegen'}));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent','Für einen Webhook ist eine Zieladresse erforderlich.');
    expect(apiMock).not.toHaveBeenCalledWith('/alarm-forwarding/destinations',expect.objectContaining({method:'POST'}));
  });

  it('requires exactly one participant identity for a handover',async()=>{
    const handover={id:'00000000-0000-4000-8000-000000000002',site_id:'00000000-0000-4000-8000-000000000001',shift_id:null,title:'Frühschicht',status:'open',created_at:'2026-01-01',participant_count:0,confirmation_count:0,participants:[]};
    apiMock.mockImplementation(async(path:string)=>path==='/handover-protocols'?[handover]:path===`/handover-protocols/${handover.id}`?handover:[]);
    render(<MemoryRouter><Handovers/></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button',{name:'Details anzeigen'}));
    fireEvent.click(await screen.findByRole('button',{name:'Teilnehmer zuordnen'}));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent','Bitte genau eine Zuordnung angeben: entweder ein Benutzerkonto oder ein Mitarbeiter.');
    expect(apiMock).not.toHaveBeenCalledWith(expect.stringContaining('/participants'),expect.objectContaining({method:'POST'}));
  });

  it('sends null for a cleared qualification start date',async()=>{
    const employeeId='00000000-0000-4000-8000-000000000003';
    apiMock.mockImplementation(async(path:string)=>{
      if(path==='/qualifications/catalog')return [{id:'q-1',code:'first-aid',name:'Erste Hilfe',default_validity_days:365,active:true}];
      if(path==='/qualifications/reminders')return {reminder_days:[90,30]};
      if(path==='/employees')return [{id:employeeId,name:'E2E Mitarbeiter'}];
      if(path.endsWith('/qualifications'))return [];
      return [];
    });
    render(<MemoryRouter><Qualifications/></MemoryRouter>);
    await waitFor(()=>expect(screen.getByRole('option',{name:/Erste Hilfe/})).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Mitarbeiter'),{target:{value:employeeId}});
    fireEvent.change(screen.getByLabelText('Qualifikation'),{target:{value:'first-aid'}});
    fireEvent.change(screen.getByLabelText('Gültig ab'),{target:{value:''}});
    fireEvent.change(screen.getByLabelText('Begründung'),{target:{value:'Nachweis geprüft'}});
    fireEvent.click(screen.getByRole('button',{name:'Qualifikation speichern'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith(`/employees/${employeeId}/qualifications`,{method:'POST',body:JSON.stringify({code:'first-aid',valid_from:null,valid_until:null,reason:'Nachweis geprüft'})}));
  });
});
