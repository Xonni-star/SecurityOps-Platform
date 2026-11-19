/** @vitest-environment jsdom */
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {fireEvent,render,screen,waitFor} from '@testing-library/react';
const apiMock=vi.hoisted(()=>vi.fn());
const enqueueMock=vi.hoisted(()=>vi.fn());
const listOutboxMock=vi.hoisted(()=>vi.fn());
const syncOutboxMock=vi.hoisted(()=>vi.fn());
vi.mock('../src/lib/api',()=>({api:apiMock}));
vi.mock('../src/lib/offline',()=>({enqueue:enqueueMock,listOutbox:listOutboxMock,syncOutbox:syncOutboxMock,watchConnection:()=>()=>{}}));
import {MobileGuard} from '../src/pages/MobileGuard';

beforeEach(()=>{apiMock.mockReset();enqueueMock.mockResolvedValue(undefined);listOutboxMock.mockResolvedValue([]);syncOutboxMock.mockResolvedValue({synced:0,conflicts:0,remaining:0});});

describe('mobile guard workflow',()=>{
  it('keeps a panic event in the outbox while offline',async()=>{
    Object.defineProperty(navigator,'onLine',{configurable:true,value:false});
    render(<MobileGuard/>);
    fireEvent.click(screen.getByRole('button',{name:'PANIK'}));
    await waitFor(()=>expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({kind:'panic',path:'/api/v1/alarms/panic'})));
    expect(await screen.findByText(/Panik offline gespeichert/)).toBeTruthy();
  });
});
