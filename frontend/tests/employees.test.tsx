/** @vitest-environment jsdom */
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {MemoryRouter} from 'react-router-dom';

const apiMock=vi.hoisted(()=>vi.fn());
vi.mock('../src/lib/api',()=>({
  api:apiMock,
  hasPermission:()=>true,
  storedUser:()=>({role:'admin',permissions:['employees:read','employees:write']}),
}));
import {Employees} from '../src/pages/Employees';

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

    render(<MemoryRouter><Employees/></MemoryRouter>);
    expect(await screen.findByText('Qualifikationen < 90 Tage')).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'Profil'}));
    expect(await screen.findByText('Abwesenheit')).toBeTruthy();
    const absenceHeadings=screen.getAllByRole('heading',{name:'Abwesenheit'});
    const absenceHeading=absenceHeadings[absenceHeadings.length-1];
    const absenceForm=absenceHeading?.closest('form');
    expect(absenceForm).toBeTruthy();
    fireEvent.change(absenceForm!.querySelector('input[type="datetime-local"]') as HTMLInputElement,{target:{value:'2026-12-01T08:00'}});
    const datetimeInputs=absenceForm!.querySelectorAll('input[type="datetime-local"]');
    fireEvent.change(datetimeInputs[1] as HTMLInputElement,{target:{value:'2026-12-01T16:00'}});
    fireEvent.change(within(absenceForm as HTMLFormElement).getByLabelText('Änderungsgrund'),{target:{value:'Urlaubsantrag'}});
    fireEvent.click(screen.getByRole('button',{name:'Abwesenheit speichern'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith(
      '/employees/00000000-0000-4000-8000-000000000111/absences',
      expect.objectContaining({method:'POST'}),
    ));
  });
});
