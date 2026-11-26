/** @vitest-environment jsdom */
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {MemoryRouter} from 'react-router-dom';

const apiMock=vi.hoisted(()=>vi.fn());
const permissionMock=vi.hoisted(()=>vi.fn(()=>true));
vi.mock('../src/lib/api',()=>({api:apiMock,hasPermission:permissionMock,storedUser:()=>null,csrf:()=>'token'}));

import {Resource} from '../src/pages/Resource';
import {AlarmForwarding} from '../src/pages/AlarmForwarding';
import {Handovers} from '../src/pages/Handovers';
import {Qualifications} from '../src/pages/Qualifications';

beforeEach(()=>{cleanup();apiMock.mockReset();permissionMock.mockReset();permissionMock.mockReturnValue(true);});

describe('strict backend contracts',()=>{
  it('creates a device with an enum status and a real site UUID',async()=>{
    apiMock.mockImplementation(async(path:string,options?:RequestInit)=>{
      if(path==='/sites')return [{id:'00000000-0000-4000-8000-000000000001',name:'Hauptobjekt'}];
      if(path==='/devices'&&options?.method==='POST')return {};
      if(path==='/devices')return [];
      return {};
    });
    render(<MemoryRouter><Resource name="devices" fields={['name','status','site_id']}/></MemoryRouter>);
    await waitFor(()=>expect(screen.getByRole('option',{name:'Hauptobjekt'})).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText('name'),{target:{value:'Leser 1'}});
    fireEvent.change(screen.getByLabelText('Status'),{target:{value:'online'}});
    fireEvent.change(screen.getByLabelText('Objekt'),{target:{value:'00000000-0000-4000-8000-000000000001'}});
    fireEvent.click(screen.getByRole('button',{name:'Add'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith('/devices',{method:'POST',body:JSON.stringify({name:'Leser 1',status:'online',site_id:'00000000-0000-4000-8000-000000000001'})}));
  });

  it('blocks a webhook destination without an endpoint before the API call',async()=>{
    apiMock.mockImplementation(async(path:string)=>{
      if(path.endsWith('/destinations'))return [];
      if(path.endsWith('/rules'))return [];
      return [];
    });
    render(<MemoryRouter><AlarmForwarding/></MemoryRouter>);
    await waitFor(()=>expect(screen.getByPlaceholderText('Name')).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText('Name'),{target:{value:'Webhook'}});
    fireEvent.change(screen.getAllByPlaceholderText('Änderungsgrund')[0],{target:{value:'Initial Newsletter'}});
    fireEvent.click(screen.getByRole('button',{name:'Anlegen'}));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent','Für einen Webhook ist ein Endpoint erforderlich.');
    expect(apiMock).not.toHaveBeenCalledWith('/alarm-forwarding/destinations',expect.objectContaining({method:'POST'}));
  });

  it('requires exactly one participant identity for a handover',async()=>{
    const handover={id:'00000000-0000-4000-8000-000000000002',site_id:'00000000-0000-4000-8000-000000000001',shift_id:null,title:'Frühschicht',status:'open',created_at:'2026-01-01',participant_count:0,confirmation_count:0,participants:[]};
    apiMock.mockImplementation(async(path:string)=>path==='/handover-protocols'?[handover]:path===`/handover-protocols/${handover.id}`?handover:[]);
    render(<MemoryRouter><Handovers/></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button',{name:'Details'}));
    fireEvent.click(await screen.findByRole('button',{name:'Teilnehmer binden'}));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent','Bitte genau eine Identität (Benutzer oder Mitarbeiter) angeben.');
    expect(apiMock).not.toHaveBeenCalledWith(expect.stringContaining('/participants'),expect.objectContaining({method:'POST'}));
  });

  it('sends null for a cleared qualification start date',async()=>{
    const employeeId='00000000-0000-4000-8000-000000000003';
    apiMock.mockImplementation(async(path:string)=>{
      if(path==='/qualifications/catalog')return [{id:'q-1',code:'first-aid',name:'Erste Hilfe',default_validity_days:365,active:true}];
      if(path==='/qualifications/reminders')return {reminder_days:[90,30]};
      if(path.endsWith('/qualifications'))return [];
      return [];
    });
    render(<MemoryRouter><Qualifications/></MemoryRouter>);
    await waitFor(()=>expect(screen.getByRole('option',{name:/Erste Hilfe/})).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Mitarbeiter-ID'),{target:{value:employeeId}});
    fireEvent.change(screen.getByLabelText('Qualifikation'),{target:{value:'first-aid'}});
    fireEvent.change(screen.getByLabelText('Gültig ab'),{target:{value:''}});
    fireEvent.change(screen.getByLabelText('Begründung'),{target:{value:'Nachweis geprüft'}});
    fireEvent.click(screen.getByRole('button',{name:'Speichern'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith(`/employees/${employeeId}/qualifications`,{method:'POST',body:JSON.stringify({code:'first-aid',valid_from:null,valid_until:null,reason:'Nachweis geprüft'})}));
  });
});
