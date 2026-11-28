/** @vitest-environment jsdom */
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';

const apiMock=vi.hoisted(()=>vi.fn());
const permissionMock=vi.hoisted(()=>vi.fn(()=>true));
vi.mock('../src/lib/api',()=>({api:apiMock,hasPermission:permissionMock}));
import {Reports} from '../src/pages/Reports';

const module={
  key:'C',slug:'documents',title:'Dokumentenmanagement',description:'Dokumente und Freigabestatus',
  source:'dms_documents',filters:['from','to'],
};
const row={
  id:'doc-1',label:'Prüfprotokoll',status:'approved',occurred_at:'2026-11-20T10:00:00Z',
  site_id:null,customer_id:null,employee_id:null,site_name:'Nordgebäude',customer_name:'Beispielkunde',
  employee_name:'A. Schmidt',details:{Dokumentart:'Prüfprotokoll',Version:2},metric:12.5,metric_label:'KiB',total:1,
};
const overview={
  generated_at:'2026-11-28T10:00:00Z',timezone:'Europe/Berlin',
  filters:{from:'',to:'',page:1,page_size:25},scope:'tenant',
  modules:[{...module,total:1}],
};
const detail={module,filters:overview.filters,total:1,page:1,page_size:25,page_count:1,rows:[row]};

beforeEach(()=>{
  cleanup();
  apiMock.mockReset();
  permissionMock.mockReset();
  permissionMock.mockReturnValue(true);
  apiMock.mockImplementation(async(path:string)=>{
    if(path.startsWith('/reports/center/overview'))return overview;
    if(path.startsWith('/reports/center/modules/documents'))return detail;
    if(path==='/sites')return [{id:'site-1',name:'Nordgebäude'}];
    if(path==='/customers')return [{id:'customer-1',name:'Beispielkunde'}];
    if(path==='/employees')return [{id:'employee-1',name:'A. Schmidt'}];
    return [];
  });
});

describe('Reporting-Zentrum',()=>{
  it('shows live module totals and the detail table',async()=>{
    render(<Reports/>);
    expect(await screen.findByRole('heading',{name:/Reporting-Zentrum/})).toBeTruthy();
    const moduleCard=await screen.findByText('Dokumentenmanagement');
    expect(moduleCard).toBeTruthy();
    expect(await screen.findByRole('table',{name:/Gefilterte Datensätze aus dms_documents/})).toBeTruthy();
    const table=await screen.findByRole('table',{name:/Gefilterte Datensätze aus dms_documents/});
    expect(within(table).getByText('Prüfprotokoll')).toBeTruthy();
    expect(within(table).queryByText(/Beispieldaten/)).toBeNull();
  });

  it('applies central filters and offers all export formats',async()=>{
    render(<Reports/>);
    await screen.findByText('Prüfprotokoll');
    fireEvent.change(screen.getByLabelText('Von'),{target:{value:'2026-11-01'}});
    fireEvent.change(screen.getByLabelText('Bis'),{target:{value:'2026-11-30'}});
    fireEvent.click(screen.getByRole('button',{name:'Filter anwenden'}));
    await vi.waitFor(()=>{
      const calls=apiMock.mock.calls.filter(([path])=>String(path).startsWith('/reports/center/overview?'));
      const call=calls[calls.length-1];
      expect(String(call?.[0])).toContain('from=2026-11-01');
      expect(String(call?.[0])).toContain('to=2026-11-30');
    });
    expect(screen.getByRole('button',{name:'CSV exportieren'})).toBeTruthy();
    expect(screen.getByRole('button',{name:'PDF exportieren'})).toBeTruthy();
    expect(screen.getByRole('button',{name:'XLSX exportieren'})).toBeTruthy();
  });

  it('opens the row detail dialog',async()=>{
    render(<Reports/>);
    const table=await screen.findByRole('table');
    fireEvent.click(within(table).getByRole('button',{name:'Ansehen'}));
    const dialog=await screen.findByRole('dialog',{name:'Berichtsdetails'});
    expect(within(dialog).getByText('Nordgebäude')).toBeTruthy();
    expect(within(dialog).getByText('Beispielkunde')).toBeTruthy();
  });

  it('does not render restricted content without reports permission',()=>{
    permissionMock.mockReturnValue(false);
    render(<Reports/>);
    expect(screen.getByText('Keine Berechtigung.')).toBeTruthy();
    expect(apiMock).not.toHaveBeenCalled();
  });
});
