/** @vitest-environment jsdom */
import {describe,it,expect,beforeEach,vi} from 'vitest';
import {cleanup,render,screen,fireEvent,waitFor} from '@testing-library/react';
import {MemoryRouter} from 'react-router-dom';
const apiMock=vi.hoisted(()=>vi.fn());
const loginMock=vi.hoisted(()=>vi.fn());
const logoutMock=vi.hoisted(()=>vi.fn());
vi.mock('../src/lib/api',()=>({
  api:apiMock,
  login:loginMock,
  logout:logoutMock,
  hasPermission:()=>true,
  storedUser:()=>({email:'admin@example.com',role:'admin',permissions:['employees:read','employees:write']}),
}));
import {Login} from '../src/pages/Login';
import {Resource} from '../src/pages/Resource';
import App from '../src/App';

const storage=new Map<string,string>();
beforeEach(()=>{cleanup();vi.stubGlobal('localStorage',{clear:()=>storage.clear(),getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>storage.set(key,value),removeItem:(key:string)=>storage.delete(key)});storage.clear();apiMock.mockReset();loginMock.mockReset();logoutMock.mockResolvedValue(undefined);});

describe('login and protected navigation',()=>{
  it('submits credentials and enters the protected area',async()=>{
    loginMock.mockResolvedValue({user:{email:'admin@example.com',role:'admin',permissions:[]},csrfToken:'csrf'});
    render(<MemoryRouter><Login/></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('E-Mail-Adresse'),{target:{value:'operator@example.com'}});
    fireEvent.change(screen.getByLabelText('Passwort'),{target:{value:'secret'}});
    fireEvent.click(screen.getByRole('button',{name:'Anmelden'}));
    await waitFor(()=>expect(loginMock).toHaveBeenCalledWith('operator@example.com','secret'));
    expect(localStorage.getItem('securityops_authenticated')).toBe('true');
  });

  it('redirects unauthenticated users away from protected navigation',()=>{
    render(<App/>);
    expect(screen.getByRole('heading',{name:'Willkommen zurück'})).toBeTruthy();
  });

  it('renders employees inside exactly one global app shell',async()=>{
    storage.set('securityops_authenticated','true');
    storage.set('securityops_user',JSON.stringify({email:'admin@example.com',role:'admin',permissions:['employees:read','employees:write']}));
    window.history.pushState({},'','/employees');
    apiMock.mockImplementation(async(path:string)=>{
      if(path===' /employees')return [];
      if(path==='/employees')return [];
      if(path==='/employees/dashboard')return {
        employees:{total:0,active:0,inactive:0,on_leave:0,sick:0,terminated:0},
        qualifications_expiring_90_days:0,
        qualifications_expired:0,
        upcoming_shift_assignments:0,
        open_absences:0,
        sick_employees:0,
        active_object_assignments:0,
        active_contracts:0,
        missing_required_qualifications:0,
        missing_documents:0,
        employees_without_object:0,
      };
      if(path==='/sites')return [];
      return {};
    });
    render(<App/>);
    expect(await screen.findByRole('heading',{name:'Mitarbeiter'})).toBeTruthy();
    expect(document.querySelectorAll('.app-shell')).toHaveLength(1);
    expect(document.querySelectorAll('.sidebar')).toHaveLength(1);
  });

  it('renders a direct employee detail route inside the same app shell',async()=>{
    storage.set('securityops_authenticated','true');
    storage.set('securityops_user',JSON.stringify({email:'admin@example.com',role:'admin',permissions:['employees:read','employees:write']}));
    window.history.pushState({},'','/employees/00000000-4000-4000-8000-000000000111');
    apiMock.mockImplementation(async(path:string)=>{
      if(path.endsWith('/profile'))return {
        employee:{id:'00000000-4000-4000-8000-000000000111',name:'Ava Worker',email:'ava@example.com',employment_status:'active',employment_type:'employee'},
        contracts:[],qualifications:[],absences:[],object_assignments:[],work_time:[],documents:[],availability:[],
      };
      return {};
    });
    render(<App/>);
    expect(await screen.findByRole('heading',{name:'Ava Worker'})).toBeTruthy();
    expect(document.querySelectorAll('.app-shell')).toHaveLength(1);
    expect(document.querySelectorAll('.sidebar')).toHaveLength(1);
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
