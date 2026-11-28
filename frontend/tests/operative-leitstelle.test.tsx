/** @vitest-environment jsdom */
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {MemoryRouter} from 'react-router-dom';

const apiMock=vi.hoisted(()=>vi.fn());
const permissionMock=vi.hoisted(()=>vi.fn());
vi.mock('../src/lib/api',()=>({
  api:apiMock,
  hasPermission:(code:string)=>permissionMock(code),
  csrf:()=>'csrf-token',
  storedUser:()=>null,
  ApiError:class ApiError extends Error{
    constructor(message:string,public status:number,public fields:Record<string,string>={},public reasonCode?:string){
      super(message);this.name='ApiError';
    }
  },
}));
vi.mock('../src/lib/useRealtimeRefresh',()=>({useRealtimeRefresh:vi.fn()}));

import {ApiError} from '../src/lib/api';
import {OperativeLeitstelle} from '../src/pages/OperativeLeitstelle';

const siteId='00000000-0000-4000-8000-000000000103';
const alarmId='00000000-0000-4000-8000-000000000107';
const measureId='00000000-0000-4000-8000-000000000106';
const shiftId='00000000-0000-4000-8000-000000000108';
const shift={
  id:shiftId,site_id:siteId,site_name:'Objekt Nord',customer_name:'Kunde Nord',role_code:'WACHE',
  starts_at:'2026-11-27T08:00:00Z',ends_at:'2026-11-27T16:00:00Z',target:2,actual:1,status:'unterbesetzt',
  qualification_status:'geprüft',reason_codes:[],notes:[],assignments:[],conflicts:[],
};
const alert={
  priority:'critical',code:'active_alarm',title:'Kritischer Alarm',description:'Alarm im Objekt Nord',
  recommendation:'Alarm Ursache prüfen',site_id:siteId,site_name:'Objekt Nord',employee_id:null,
  employee_name:null,shift_id:null,period:null,detected_at:'2026-11-27T08:00:00Z',
  link:`/einsatz/alarme/${alarmId}`,source_key:`alarm:${alarmId}`,
};
const center={
  generated_at:'2026-11-27T09:00:00Z',date:'2026-11-27',
  sections:{kpi:true,shifts:true,employees:true,sites:true,qualifications:true,documents:true,
    devices:true,keys:true,measures:true,alarms:true},
  operational_status:'kritisch',
  kpis:[{key:'open_shifts',label:'Offene Schichten',value:1,link:'/scheduling',definition:'Schichten ohne Besetzung'}],
  alerts:[alert],shifts:[shift],shifts_total:1,page:1,page_size:25,employees:[],sites:[],qualifications:[],
  documents:[],document_requirements:[],devices:[],keys:[],alarms:[],hazards:[],measures:[],
  summary:{open_shifts:1},
  filter_options:{sites:[{id:siteId,name:'Objekt Nord'}],customers:[],employees:[]},
};
const measure={
  id:measureId,title:'Alarm Ursache klären',description:'Maßnahme aus Alert',module:'einsatz',priority:'critical',
  status:'open',site_id:siteId,site_name:'Objekt Nord',source_type:'alarm',source_id:alarmId,
  source_key:`alarm:${alarmId}`,due_at:null,
};
const response=(body:unknown,headers:Record<string,string>={})=>({
  ok:true,status:200,
  headers:{get:(name:string)=>headers[name]??headers[name.toLowerCase()]??null},
  json:async()=>body,
});
const fetchMock=vi.hoisted(()=>vi.fn());
let centerBody:unknown;
let measuresBody:unknown;
let centerError:unknown;
let patchError:unknown;
let candidatesBody:unknown;

function renderPage(){
  return render(<MemoryRouter initialEntries={['/operative-leitstelle']}><OperativeLeitstelle/></MemoryRouter>);
}
const lastCenterUrl=()=>String([...apiMock.mock.calls].reverse().find(([path])=>String(path).includes('/operations/control-center?'))?.[0]??'');
const lastMeasuresUrl=()=>String([...fetchMock.mock.calls].reverse().find(([input])=>String(input).includes('/operations/measures?'))?.[0]??'');

beforeEach(()=>{
  cleanup();apiMock.mockReset();permissionMock.mockReset();fetchMock.mockReset();
  permissionMock.mockReturnValue(true);
  centerBody=center;measuresBody=[measure];centerError=null;patchError=null;candidatesBody=[];
  apiMock.mockImplementation(async(path:string,init?:RequestInit)=>{
    if(String(path).includes('/operations/control-center/candidates'))return candidatesBody;
    if(String(path).includes('/operations/control-center?')){
      if(centerError)throw centerError;
      return centerBody;
    }
    if(init?.method==='PATCH'&&patchError)throw patchError;
    return {};
  });
  fetchMock.mockImplementation(async(input:string)=>{
    if(String(input).includes('/operations/measures?'))return response(measuresBody,{'X-Total-Count':'27','X-Page-Count':'14'});
    return response([]);
  });
  vi.stubGlobal('fetch',fetchMock);
});

describe('Operative Leitstelle frontend',()=>{
  it('renders server-provided KPIs, warnings, measures and German section headings',async()=>{
    renderPage();
    expect(await screen.findByRole('heading',{name:'Operative Leitstelle'})).toBeTruthy();
    expect(await screen.findByRole('heading',{name:'Kennzahlen'})).toBeTruthy();
    for(const name of ['Sofortiger Handlungsbedarf','Tagesübersicht Schichten','Verfügbarkeit','Objektstatus',
      'Qualifikationen und Nachweise','NFC- und Schlüsselstatus','Offene Maßnahmen']){
      expect(screen.getByRole('heading',{name})).toBeTruthy();
    }
    expect(screen.getByText('Kritischer Alarm')).toBeTruthy();
    expect((await screen.findAllByText('Alarm Ursache klären')).length).toBeGreaterThan(0);
    expect(screen.getByText('Operative Lage: kritisch')).toBeTruthy();
    expect(screen.getByText('Offene Schichten')).toBeTruthy();
    expect(screen.getByTitle('Schichten ohne Besetzung')).toBeTruthy();
  });

  it('passes all filters and pagination to the authorised server endpoints',async()=>{
    renderPage();
    await screen.findByText('Kritischer Alarm');
    const form=screen.getByRole('form',{name:'Leitstelle filtern'});
    fireEvent.change(within(form).getByLabelText('Objekt'),{target:{value:siteId}});
    fireEvent.change(within(form).getByLabelText('Suche'),{target:{value:'Alarm'}});
    fireEvent.change(within(form).getByLabelText('Maßnahmen-Modul'),{target:{value:'einsatz'}});
    fireEvent.change(within(form).getByLabelText('Maßnahmenstatus'),{target:{value:'open'}});
    fireEvent.click(within(form).getByRole('checkbox',{name:'Nur überfällige Maßnahmen'}));
    fireEvent.click(within(form).getByRole('button',{name:'Filter anwenden'}));
    await waitFor(()=>{
      const center=new URLSearchParams(lastCenterUrl().split('?')[1]);
      const list=new URLSearchParams(lastMeasuresUrl().split('?')[1]);
      expect(center.get('site_id')).toBe(siteId);
      expect(list.get('site_id')).toBe(siteId);
      expect(list.get('q')).toBe('Alarm');
      expect(list.get('module')).toBe('einsatz');
      expect(list.get('status')).toBe('open');
      expect(list.get('overdue')).toBe('true');
    });
    expect(screen.queryByText('Kritischer Alarm')).toBeTruthy();
    const nextButtons=screen.getAllByRole('button',{name:'Weiter'});
    fireEvent.click(nextButtons[nextButtons.length-1]!);
    await waitFor(()=>expect(new URLSearchParams(lastMeasuresUrl().split('?')[1]).get('page')).toBe('2'));
  });

  it('creates a measure from a warning with a stable source key and a client mutation id',async()=>{
    renderPage();
    fireEvent.click(await screen.findByRole('button',{name:'Maßnahme anlegen'}));
    const dialog=await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Bezeichnung'),{target:{value:'Alarm bearbeiten'}});
    fireEvent.click(within(dialog).getByRole('button',{name:'Maßnahme anlegen'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith('/operations/measures',{method:'POST',body:expect.any(String)}));
    const call=[...apiMock.mock.calls].find(([path,init])=>path==='/operations/measures'&&init?.method==='POST');
    const body=JSON.parse(String(call?.[1]?.body));
    expect(body).toMatchObject({title:'Alarm bearbeiten',module:'einsatz',priority:'critical',
      source_type:'alarm',source_id:alarmId,source_key:`alarm:${alarmId}`,site_id:siteId});
    expect(body.client_mutation_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await screen.findByText(/Die Maßnahme wurde angelegt/)).toBeTruthy();
  });

  it('shows an explicit source_open error and does not pretend a measure was closed',async()=>{
    patchError=new ApiError('Abschluss nicht möglich',409,{},'source_open');
    renderPage();
    const row=(await screen.findAllByText('Alarm Ursache klären'))[0];
    const tableRow=row.closest('tr')??row.closest('article')!;
    fireEvent.click(within(tableRow as HTMLElement).getByRole('button',{name:'Abschließen'}));
    const dialog=await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Begründung'),{target:{value:'Quittiert'} });
    fireEvent.click(within(dialog).getByRole('button',{name:'Status speichern'}));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(/Ursache der Maßnahme besteht weiterhin \(source_open\)/)).toBeTruthy();
  });

  it('requires a reason before closing and offers candidates from the staffing verdict',async()=>{
    candidatesBody=[{id:'c-1',name:'Mia Wache',status:'eligible',reasons:[]}];
    renderPage();
    const row=(await screen.findAllByText('Alarm Ursache klären'))[0];
    fireEvent.click(within((row.closest('tr')??row.closest('article')) as HTMLElement).getByRole('button',{name:'Abschließen'}));
    const dialog=await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button',{name:'Status speichern'}));
    expect(await screen.findByText('Bitte eine Begründung für den Abschluss angeben.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button',{name:'Dialog schließen'}));

    fireEvent.click((await screen.findAllByRole('button',{name:'Kandidaten'}))[0]);
    expect(await screen.findByText('Mia Wache')).toBeTruthy();
    expect(screen.getByText('Geeignet')).toBeTruthy();
    const call=[...apiMock.mock.calls].find(([path])=>String(path).includes('/candidates'));
    expect(new URLSearchParams(String(call?.[0]).split('?')[1]).get('shift_id')).toBe(shiftId);
  });

  it('shows loading, empty and error states truthfully',async()=>{
    centerBody={...center,alerts:[],kpis:[],shifts:[],sections:{...center.sections,shifts:false}};
    measuresBody=[];
    renderPage();
    expect((await screen.findAllByText('Keine Daten')).length).toBeGreaterThan(0);
    expect(screen.queryByText('Kritischer Alarm')).toBeNull();

    cleanup();
    centerError=new Error('Backend nicht erreichbar');
    renderPage();
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(/Leitstellendaten konnten nicht geladen werden: Backend nicht erreichbar/)).toBeTruthy();
  });

  it('hides the aggregate and write actions without the respective permissions',async()=>{
    permissionMock.mockImplementation((code:string)=>code==='operations_measures:read');
    renderPage();
    expect((await screen.findAllByText('Alarm Ursache klären')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('heading',{name:'Kennzahlen'})).toBeNull();
    expect(screen.queryByRole('button',{name:'Maßnahme anlegen'})).toBeNull();

    cleanup();
    permissionMock.mockReturnValue(false);
    renderPage();
    expect(await screen.findByText('Keine Berechtigung für die Operative Leitstelle.')).toBeTruthy();
  });
});
