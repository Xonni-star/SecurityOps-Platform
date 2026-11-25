/** @vitest-environment jsdom */
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';

const apiMock=vi.hoisted(()=>vi.fn());
vi.mock('../src/lib/api',()=>({api:apiMock,hasPermission:()=>true}));
import {Sites} from '../src/pages/Sites';

const sites=Array.from({length:12},(_,index)=>({
  id:String(index),name:`Objekt ${String(index+1).padStart(2,'0')}`,site_number:`S${index+1}`,address:'Berlin',status:index===0?'active':'planning',security_classification:'unknown',
}));
beforeEach(()=>{cleanup();apiMock.mockReset();});

describe('Objektübersicht',()=>{
  it('filters, sorts and paginates actual site data',async()=>{
    apiMock.mockResolvedValue(sites);
    render(<Sites/>);
    expect(await screen.findByText('12 Objekte · Seite 1 von 2')).toBeTruthy();
    expect(screen.queryByRole('button',{name:'Objekt 12'})).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'Weiter'}));
    expect(screen.getByRole('button',{name:'Objekt 12'})).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'Objekt'}));
    expect(screen.getByRole('button',{name:'Objekt 12'})).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Status'),{target:{value:'active'}});
    expect(screen.getByText('1 Objekte · Seite 1 von 1')).toBeTruthy();
    expect(screen.getByRole('button',{name:'Objekt 01'})).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Objekte suchen'),{target:{value:'nicht vorhanden'}});
    expect(screen.getByText('Keine Objekte entsprechen den aktiven Filtern.')).toBeTruthy();
  });

  it('saves cleared optional site fields as null',async()=>{
    apiMock.mockImplementation(async(_path:string,options?:RequestInit)=>options?.method==='PATCH'?{}:sites.slice(0,1));
    render(<Sites/>);
    const row=(await screen.findByRole('button',{name:'Objekt 01'})).closest('tr')!;
    fireEvent.click(within(row).getByRole('button',{name:'Bearbeiten'}));
    fireEvent.change(screen.getByLabelText('Objektnummer'),{target:{value:''}});
    fireEvent.change(screen.getByLabelText('Adresse'),{target:{value:''}});
    fireEvent.click(screen.getByRole('button',{name:'Speichern'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith('/sites/0',expect.objectContaining({method:'PATCH',body:expect.stringContaining('"site_number":null')})));
    expect(JSON.parse(apiMock.mock.calls.find(([,options])=>options?.method==='PATCH')![1].body).address).toBeNull();
  });

  it('retains the existing object context and distinguishes restricted journal access',async()=>{
    apiMock.mockImplementation(async(path:string)=>{
      if(path==='/sites')return sites.slice(0,1);
      if(path==='/customers')return [];
      return {site:sites[0],customers:[],contracts:[],locations:[],hazards:[],instructions:[],journal:null};
    });
    render(<Sites/>);
    fireEvent.click(await screen.findByRole('button',{name:'Objekt 01'}));
    expect(await screen.findByText('Keine Berechtigung für das Wachbuch.')).toBeTruthy();
    expect(screen.getByRole('heading',{name:'Gefährdungen'})).toBeTruthy();
    expect(screen.getByRole('heading',{name:'Dienstanweisungen'})).toBeTruthy();
  });
});
