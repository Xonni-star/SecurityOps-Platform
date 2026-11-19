/** @vitest-environment jsdom */
import {describe,it,expect,beforeEach,vi} from 'vitest';
import {cleanup,render,screen,fireEvent,waitFor} from '@testing-library/react';
import {MemoryRouter} from 'react-router-dom';
const apiMock=vi.hoisted(()=>vi.fn());
const loginMock=vi.hoisted(()=>vi.fn());
const logoutMock=vi.hoisted(()=>vi.fn());
vi.mock('../src/lib/api',()=>({api:apiMock,login:loginMock,logout:logoutMock}));
import {Login} from '../src/pages/Login';
import {Resource} from '../src/pages/Resource';
import App from '../src/App';

const storage=new Map<string,string>();
beforeEach(()=>{cleanup();vi.stubGlobal('localStorage',{clear:()=>storage.clear(),getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>storage.set(key,value),removeItem:(key:string)=>storage.delete(key)});storage.clear();apiMock.mockReset();loginMock.mockReset();logoutMock.mockResolvedValue(undefined);});

describe('login and protected navigation',()=>{
  it('submits credentials and enters the protected area',async()=>{
    loginMock.mockResolvedValue({user:{email:'admin@example.com',role:'admin',permissions:[]},csrfToken:'csrf'});
    render(<MemoryRouter><Login/></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('Email'),{target:{value:'operator@example.com'}});
    fireEvent.change(screen.getByLabelText('Password'),{target:{value:'secret'}});
    fireEvent.click(screen.getByRole('button',{name:'Sign in'}));
    await waitFor(()=>expect(loginMock).toHaveBeenCalledWith('operator@example.com','secret'));
    expect(localStorage.getItem('securityops_authenticated')).toBe('true');
  });

  it('redirects unauthenticated users away from protected navigation',()=>{
    render(<App/>);
    expect(screen.getByRole('heading',{name:'Sign in'})).toBeTruthy();
  });
});

describe('basic CRUD',()=>{
  it('loads and creates an employee through the API client',async()=>{
    apiMock.mockResolvedValueOnce([{id:'e-1',name:'Ava',email:'ava@example.com'}]).mockResolvedValueOnce({id:'e-2',name:'Ben'}).mockResolvedValueOnce([{id:'e-1',name:'Ava',email:'ava@example.com'},{id:'e-2',name:'Ben'}]);
    render(<MemoryRouter><Resource name="employees" fields={['name','email']}/></MemoryRouter>);
    expect(await screen.findByText('Ava — ava@example.com')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('name'),{target:{value:'Ben'}});
    fireEvent.change(screen.getByPlaceholderText('email'),{target:{value:'ben@example.com'}});
    fireEvent.click(screen.getByRole('button',{name:'Add'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith('/employees',{method:'POST',body:JSON.stringify({name:'Ben',email:'ben@example.com'})}));
    expect(await screen.findByText('Ben')).toBeTruthy();
  });
});
