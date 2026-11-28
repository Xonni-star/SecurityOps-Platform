/** @vitest-environment jsdom */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {MemoryRouter} from 'react-router-dom';

const apiMock=vi.hoisted(()=>vi.fn());
const permissionMock=vi.hoisted(()=>vi.fn((_code:string)=>true));
vi.mock('../src/lib/api',()=>({
  api:(path:string,options?:RequestInit)=>apiMock(path,options),
  hasPermission:(code:string)=>permissionMock(code),
  storedUser:()=>({email:'pruefer@example.invalid',role:'admin',permissions:[]}),
  csrf:()=>'csrf-token',
}));

import {Dms} from '../src/pages/Dms';

const documentId='00000000-0000-4000-8000-0000000000b1';
const versionId='00000000-0000-4000-8000-0000000000c1';
const siteId='00000000-0000-4000-8000-0000000000aa';
const row={
  id:documentId,title:'Sicherheitskonzept 2026',description:'Beschreibung',site_id:siteId,customer_id:null,
  employee_id:null,responsible_employee_id:null,document_number:'DMS-1',document_type:'Konzept',
  document_status:'active',approval_status:'approved',created_at:'2026-01-01T10:00:00Z',updated_at:'2026-01-02T10:00:00Z',
  valid_from:'2026-01-01',valid_until:'2027-01-01',review_on:'2027-01-01',approved_at:'2026-01-03T10:00:00Z',
  reviewed_at:'2026-01-03T10:00:00Z',approval_feedback:null,rejection_reason:null,
  versions:[{id:versionId,version_no:2,size_bytes:1024,content_type:'application/pdf',lifecycle_state:'available',rejection_reason:null,created_at:'2026-01-02T10:00:00Z',scanned_at:'2026-01-02T10:05:00Z',retention_until:null}],
  current_version:{id:versionId,version_no:2,size_bytes:1024,content_type:'application/pdf',lifecycle_state:'available',rejection_reason:null,created_at:'2026-01-02T10:00:00Z',scanned_at:'2026-01-02T10:05:00Z',retention_until:null},
  site_name:'Objekt Nord',customer_name:null,employee_name:null,responsible_employee_name:null,created_by_email:'autor@example.invalid',
  computed_status:'gueltig',status_label:'Gültig',expiry_bucket:'more_than_60_days',days_until_expiry:200,
  review_state:'none',has_available_version:true,is_approved:true,is_currently_valid:true,is_reviewed:true,scan_status:'available',
};
const stats={total:4,approved:2,draft:1,pending_approval:1,returned:0,archived:0,expired:0,expiring_30d:1,missing_file:0,scan_pending:0,quarantined:0,review_due:1};
const queryResponse={
  rows:[row],total:1,page:1,pages:1,page_size:25,stats,
  filter_options:{sites:[{id:siteId,name:'Objekt Nord'}],customers:[],employees:[],responsible_employees:[],types:['Konzept'],document_numbers:['DMS-1']},
};
const approval={id:documentId,title:row.title,document_type:'Konzept',created_by_email:'autor@example.invalid',site_name:'Objekt Nord',customer_name:null,created_at:row.created_at,current_version:row.current_version,scan_status:'available'};

function defaultApi(path:string){
  if(path.startsWith('/dms/documents/query'))return Promise.resolve(queryResponse);
  if(path.startsWith('/dms/overview'))return Promise.resolve({approvals:[approval],stats});
  if(path.endsWith('/history'))return Promise.resolve([]);
  if(path.includes('/return-for-revision')||path.includes('/approve')||path.includes('/request-review'))return Promise.resolve({...row,approval_status:'pending_approval'});
  if(path.startsWith('/sites'))return Promise.resolve([{id:siteId,name:'Objekt Nord'}]);
  if(path.startsWith('/customers')||path.startsWith('/employees'))return Promise.resolve([]);
  return Promise.resolve(row);
}

function renderDms(){
  render(<MemoryRouter><Dms/></MemoryRouter>);
}

beforeEach(()=>{
  cleanup();apiMock.mockReset();permissionMock.mockReset();permissionMock.mockReturnValue(true);
  apiMock.mockImplementation(defaultApi);
});
afterEach(()=>vi.restoreAllMocks());

describe('Dokumentenmanagement-Oberfläche',()=>{
  it('zeigt echte Kennzahlen und serverseitig gelieferte Dokumente',async()=>{
    renderDms();
    const kpis=await screen.findByRole('button',{name:'Nach Freigegeben filtern'});
    expect(kpis.textContent).toContain('2');
    expect(screen.getByRole('button',{name:'Nach In Prüfung filtern'}).textContent).toContain('1');
    const table=await screen.findByRole('table',{name:'Gefilterte Dokumente'});
    expect(within(table).getByText('Sicherheitskonzept 2026')).toBeTruthy();
    expect(within(table).getByText('Gültig')).toBeTruthy();
    expect(within(table).getByText('Freigegeben')).toBeTruthy();
    expect(within(table).getByText('Objekt Nord')).toBeTruthy();
    expect(screen.getByText('1 Dokumente · Seite 1 von 1')).toBeTruthy();
  });

  it('sendet kombinierbare Filter und Sortierung als Querystring an den Server',async()=>{
    renderDms();
    await screen.findByRole('table',{name:'Gefilterte Dokumente'});
    fireEvent.change(screen.getByPlaceholderText('Titel, Nummer, Art, Objekt …'),{target:{value:'Konzept'}});
    await userEvent.selectOptions(screen.getByLabelText('Freigabestatus'),'approved');
    await userEvent.selectOptions(screen.getByLabelText('Gültigkeit'),'valid');
    await userEvent.selectOptions(screen.getByLabelText('Sortierung'),'valid_until');
    await userEvent.selectOptions(screen.getByLabelText('Seitengröße'),'50');
    fireEvent.click(screen.getByRole('button',{name:'Filter anwenden'}));
    await waitFor(()=>{
      const urls=apiMock.mock.calls.map(([path])=>String(path)).filter(path=>path.startsWith('/dms/documents/query?q='));
      const url=urls[urls.length-1];
      expect(url).toBeTruthy();
      expect(url).toContain('q=Konzept');
      expect(url).toContain('approval_status=approved');
      expect(url).toContain('validity=valid');
      expect(url).toContain('sort=valid_until');
      expect(url).toContain('page_size=50');
    });
  });

  it('filtert die Liste beim Klick auf eine Kennzahl',async()=>{
    renderDms();
    await screen.findByRole('table',{name:'Gefilterte Dokumente'});
    fireEvent.click(screen.getByRole('button',{name:'Nach Zurückgegeben filtern'}));
    await waitFor(()=>{
      const url=apiMock.mock.calls.map(([path])=>String(path)).find(path=>path.startsWith('/dms/documents/query?approval_status=rejected'));
      expect(url).toBeTruthy();
    });
  });

  it('öffnet Details inklusive Fassungen und protokolliert eine Rückgabe mit Begründung',async()=>{
    renderDms();
    await screen.findByRole('table',{name:'Gefilterte Dokumente'});
    fireEvent.click(within(screen.getByRole('table',{name:'Gefilterte Dokumente'})).getByRole('button',{name:'Details'}));
    const dialog=await screen.findByRole('dialog',{name:row.title});
    expect(within(dialog).getByText('Fassungen')).toBeTruthy();
    expect(within(dialog).getByText('Änderungshistorie')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button',{name:'Zur Überarbeitung zurückgeben'}));
    const reasonDialog=await screen.findByRole('dialog',{name:'Zur Überarbeitung zurückgeben'});
    fireEvent.change(within(reasonDialog).getByLabelText('Begründung'),{target:{value:'Nachweis unvollständig'}});
    fireEvent.click(within(reasonDialog).getByRole('button',{name:'Zurückgeben'}));
    await waitFor(()=>{
      const call=apiMock.mock.calls.find(([path])=>String(path)===`/dms/documents/${documentId}/return-for-revision`);
      expect(call).toBeTruthy();
      expect(JSON.parse(String((call?.[1] as RequestInit).body)).reason).toBe('Nachweis unvollständig');
    });
  });

  it('bietet schreibenden Rollen den Upload und lesenden Rollen keine Workflow-Aktionen',async()=>{
    permissionMock.mockImplementation(code=>code==='dms:read');
    renderDms();
    await screen.findByRole('table',{name:'Gefilterte Dokumente'});
    expect(screen.getByText('Für das Hochladen von Dokumenten ist die Berechtigung „Dokumente schreiben“ erforderlich.')).toBeTruthy();
    fireEvent.click(within(screen.getByRole('table',{name:'Gefilterte Dokumente'})).getByRole('button',{name:'Details'}));
    const dialog=await screen.findByRole('dialog',{name:row.title});
    expect(within(dialog).queryByText('Freigabeworkflow')).toBeNull();
    expect(within(dialog).queryByRole('button',{name:'Dokument löschen'})).toBeNull();
    expect(screen.queryByText('Keine offenen Freigaben.')).toBeNull();
  });

  it('zeigt offene Freigaben aus der Übersicht',async()=>{
    renderDms();
    expect((await screen.findAllByText(row.title)).length).toBeGreaterThan(0);
    expect(screen.getByText(/Dokumente warten derzeit auf Prüfung und Freigabe/)).toBeTruthy();
  });
});
