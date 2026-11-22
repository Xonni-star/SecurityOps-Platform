/** @vitest-environment jsdom */
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {MemoryRouter} from 'react-router-dom';

const apiMock=vi.hoisted(()=>vi.fn());
vi.mock('../src/lib/api',()=>({
  api:apiMock,
  hasPermission:()=>true,
  storedUser:()=>({role:'admin',permissions:['settings:read','authenticated_devices:read','authenticated_devices:write','authenticated_sessions:read','authenticated_sessions:write']}),
}));
import {Admin} from '../src/pages/Admin';

beforeEach(()=>{cleanup();apiMock.mockReset();vi.stubGlobal('confirm',vi.fn(()=>true));});

describe('admin security settings',()=>{
  it('shows authenticated sessions and revokes a selected session',async()=>{
    apiMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({providers:[]})
      .mockResolvedValueOnce({providers:[],timescan:null})
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{id:'session-1',email:'admin@example.com',role:'admin',device_name:'MacBook',metadata:{platform:'macOS'},created_at:'2026-01-01T10:00:00Z',expires_at:'2099-01-01T10:00:00Z',last_seen_at:null,revoked_at:null}]);
    render(<MemoryRouter><Admin/></MemoryRouter>);
    expect(await screen.findByText(/admin@example.com/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'Sitzung widerrufen'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith('/auth/sessions/session-1/revoke',{method:'POST'}));
  });
});
