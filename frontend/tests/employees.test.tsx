/** @vitest-environment jsdom */
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {MemoryRouter,Route,Routes} from 'react-router-dom';

const apiMock=vi.hoisted(()=>vi.fn());
vi.mock('../src/lib/api',()=>({
  api:apiMock,
  hasPermission:()=>true,
  storedUser:()=>({role:'admin',permissions:['employees:read','employees:write']}),
}));
import {Employees} from '../src/pages/Employees';
import {EmployeeDetail} from '../src/pages/EmployeeDetail';

beforeEach(()=>{cleanup();apiMock.mockReset();});

describe('employee management profile',()=>{
  it('shows dashboard metrics and creates an absence in the profile',async()=>{
    apiMock.mockImplementation(async(path:string,options?:RequestInit)=>{
      if(path==='/' )return [];
      if(path==='//employees')return [];
      if(path==='/employees')return [{
        id:'00000000-0000-4000-8000-000000000111',
        name:'Ava Worker',
        email:'ava@example.com',
        employment_status:'active',
        employment_type:'employee',
      }];
      if(path==='/employees/dashboard')return {
        employees:{total:1,active:1,inactive:0,on_leave:0,sick:0,terminated:0},
        qualifications_expiring_90_days:1,
        qualifications_expired:0,
        upcoming_shift_assignments:2,
        open_absences:1,
        sick_employees:0,
        active_object_assignments:1,
        active_contracts:1,
        missing_required_qualifications:0,
        missing_documents:0,
        employees_without_object:0,
      };
      if(path==='/sites')return [{id:'00000000-0000-4000-8000-000000000222',name:'HQ'}];
      if(path.endsWith('/profile')&&options?.method==='PATCH')return {};
      if(path.endsWith('/profile'))return {
        employee:{id:'00000000-0000-4000-8000-000000000111',name:'Ava Worker',email:'ava@example.com',employment_status:'active',employment_type:'employee'},
        contracts:[],qualifications:[],absences:[],object_assignments:[],work_time:[],documents:[],availability:[],
      };
      if(path.endsWith('/absences')&&options?.method==='POST')return {id:'absence-1'};
      return {};
    });

    render(<MemoryRouter initialEntries={['/employees']}><Routes><Route path="/employees" element={<Employees/>}/><Route path="/employees/:employeeId" element={<EmployeeDetail/>}/></Routes></MemoryRouter>);
    expect(await screen.findByText('Qualifikationswarnungen')).toBeTruthy();
    const buttons=screen.getAllByRole('button',{name:'Bearbeiten'});
    fireEvent.click(buttons[0]);
    expect(await screen.findByRole('heading',{name:'Ava Worker'})).toBeTruthy();
    expect(screen.getByRole('button',{name:'Zur Mitarbeiterübersicht'})).toBeTruthy();
  });
});
