/** @vitest-environment jsdom */
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import {MemoryRouter,Route,Routes} from 'react-router-dom';

const apiMock=vi.hoisted(()=>vi.fn());
vi.mock('../src/lib/api',()=>({api:apiMock,hasPermission:()=>true}));
import {CustomerReports} from '../src/pages/CustomerReports';

beforeEach(()=>{cleanup();apiMock.mockReset();});

describe('Customer reports',()=>{
  it('preselects the object supplied by the object file',async()=>{
    apiMock.mockResolvedValue([{id:'site-1',name:'North building'}]);
    render(<MemoryRouter initialEntries={['/customer-reports?site_id=site-1']}><Routes><Route path="/customer-reports" element={<CustomerReports/>}/></Routes></MemoryRouter>);
    const site=await screen.findByLabelText('Objekt') as HTMLSelectElement;
    expect(site.value).toBe('site-1');
    expect(screen.getByRole('option',{name:'North building'})).toBeTruthy();
  });
});
