/** @vitest-environment jsdom */
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {MemoryRouter,Route,Routes} from 'react-router-dom';

const apiMock=vi.hoisted(()=>vi.fn());
const hasPermissionMock=vi.hoisted(()=>vi.fn<(code:string)=>boolean>());
vi.mock('../src/lib/api',()=>({api:apiMock,hasPermission:hasPermissionMock}));
import {CustomerReports} from '../src/pages/CustomerReports';

const siteId='00000000-0000-4000-8000-0000000000cc';
const customerId='00000000-0000-4000-8000-0000000000bb';
const row={
  id:'row-1',occurred_at:'2026-11-05T10:00:00.000Z',site_id:siteId,site_name:'Nordgebäude',
  category:'Einsatz',label:'Tor 1',status:'Abgeschlossen',metric:1,
};
const filter={
  from:'2026-11-01',to:'2026-11-28',site_id:siteId,customer_id:customerId,q:'Tor',
  sort:'occurred_at',order:'desc',page:1,page_size:25,total:1,page_count:1,timezone:'Europe/Berlin',
};
const preview={kind:'incidents',kind_label:'Einsätze',metric_label:'Einsätze',rows:[row],filter};
const release={
  id:'release-1',title:'Nachweisbericht November',kind:'incidents',kind_label:'Einsätze',
  status:'in_review',customer_id:customerId,customer_name:'Nordlicht GmbH',row_count:1,
  fingerprint:'a'.repeat(64),from:'2026-11-01',to:'2026-11-28',site_id:siteId,
  created_by:'author',created_at:'2026-11-28T09:00:00.000Z',approved_by:null,approved_at:null,
  rejected_reason:null,revoked_reason:null,filters:filter,
};
const allPermissions=[
  'customer_reports:read','customer_reports:write','customer_reports:approve',
  'customer_reports:export','customer_portal:read',
];

function renderPage(path='/customer-reports'){
  return render(<MemoryRouter initialEntries={[path]}>
    <Routes><Route path="/customer-reports" element={<CustomerReports/>}/></Routes>
  </MemoryRouter>);
}

let detailStatus:string;

beforeEach(()=>{
  cleanup();apiMock.mockReset();hasPermissionMock.mockReset();
  detailStatus='in_review';
  hasPermissionMock.mockImplementation((code:string)=>allPermissions.includes(code));
  apiMock.mockImplementation(async(path:string)=>{
    if(path.startsWith('/customer-reports/kinds'))return {kinds:[
      {slug:'incidents',label:'Einsätze',description:'',metricLabel:'Einsätze'},
    ]};
    if(path.startsWith('/customers?'))return [{id:customerId,name:'Nordlicht GmbH'}];
    if(path==='/sites')return [{id:siteId,name:'Nordgebäude'}];
    if(path.startsWith('/customer-reports/preview'))return preview;
    if(path==='/customer-reports/releases')return {releases:[release]};
    if(path==='/customer-reports/releases/release-1')return {
      ...release,status:detailStatus,rows:[row],allowed_site_ids:[siteId],current_row_count:1,data_basis_current:true,
    };
    if(path.startsWith('/customer-portal/releases?'))return {releases:[{...release,status:'approved'}]};
    if(path==='/customer-portal/releases/release-1')return {
      ...release,status:'approved',rows:[row],read_only:true,export_allowed:false,
    };
    if(path.includes('/approve')){
      detailStatus='approved';
      return {id:'release-1',status:'approved'};
    }
    if(path.includes('/releases'))return {id:'release-1',status:'draft',row_count:1};
    return {};
  });
});

describe('Customer reports page',()=>{
  it('preselects the object supplied by the object file',async()=>{
    renderPage(`/customer-reports?site_id=${siteId}`);
    const site=await screen.findByLabelText('Objekt') as HTMLSelectElement;
    expect(site.value).toBe(siteId);
    expect(screen.getByRole('option',{name:'Nordgebäude'})).toBeTruthy();
  });

  it('loads a server-side preview and only creates a draft after that preview',async()=>{
    renderPage(`/customer-reports?customer_id=${customerId}`);
    fireEvent.change(await screen.findByLabelText('Titel'),{target:{value:'Nachweisbericht November'}});
    fireEvent.change(screen.getByLabelText('Von'),{target:{value:'2026-11-01'}});
    fireEvent.change(screen.getByLabelText('Bis'),{target:{value:'2026-11-28'}});
    fireEvent.click(screen.getByRole('button',{name:'Vorschau laden'}));
    expect(await screen.findByText('Tor 1')).toBeTruthy();
    expect(screen.getByText(/1 Einsätze im gewählten Zeitraum/)).toBeTruthy();
    expect(apiMock.mock.calls.some(([path])=>String(path).startsWith('/customer-reports/preview/incidents?'))).toBe(true);

    fireEvent.click(screen.getByRole('button',{name:'Entwurf anlegen'}));
    await waitFor(()=>expect(apiMock.mock.calls.some(([path,options])=>
      path==='/customer-reports/releases'&&options?.method==='POST')).toBe(true));
    expect(await screen.findByText(/Eine Freigabe steht noch aus/)).toBeTruthy();
  });

  it('offers read-only portal data without any export action for customer_portal:read',async()=>{
    hasPermissionMock.mockImplementation((code:string)=>code==='customer_portal:read');
    renderPage(`/customer-reports?customer_id=${customerId}`);
    expect(screen.queryByRole('button',{name:'Bericht erstellen'})).toBeNull();
    expect(await screen.findByText('Nachweisbericht November')).toBeTruthy();
    expect(screen.getByText(/Schreibgeschützte Ansicht ausschließlich freigegebener eigener Berichte/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button',{name:'Öffnen'}));
    expect(await screen.findByText(/Exportfunktionen sind im Kundenportal nicht enthalten/)).toBeTruthy();
    expect(screen.queryByRole('button',{name:/exportieren/})).toBeNull();
    expect(apiMock.mock.calls.some(([path])=>String(path).includes('/customer-reports/releases/'))).toBe(false);
  });

  it('runs the approval workflow from the release list',async()=>{
    renderPage('/customer-reports');
    fireEvent.click(screen.getByRole('button',{name:'Entwürfe und Freigaben'}));
    fireEvent.click(await screen.findByRole('button',{name:'Details'}));
    const approve=await screen.findByRole('button',{name:'Freigeben'});
    fireEvent.click(approve);
    await waitFor(()=>expect(apiMock.mock.calls.some(([path,options])=>
      String(path).includes('/approve')&&options?.method==='POST')).toBe(true));
    expect(await screen.findByText(/Der Kundenbericht ist freigegeben/)).toBeTruthy();
    expect(screen.getByRole('button',{name:'CSV exportieren'})).toBeTruthy();
    expect(screen.getByRole('button',{name:'PDF exportieren'})).toBeTruthy();
    expect(screen.getByRole('button',{name:'XLSX exportieren'})).toBeTruthy();
  });
});
