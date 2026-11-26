/** @vitest-environment jsdom */
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
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

const employeeId='00000000-0000-4000-8000-000000000111';
const profilePath=`/employees/${employeeId}/profile`;

const initialEmployee={
  id:employeeId,name:'Ava Worker',email:'ava@example.invalid',title:'Wachschutz',
  employee_number:'P-100',first_name:'Ava',last_name:'Worker',phone:'+49 30 111',mobile:null,
  address:'Teststraße 1',date_of_birth:'1990-01-01',hire_date:'2020-01-01',termination_date:null,
  employment_status:'active',employment_type:'employee',department:'Security',position:'Wache',
  work_location:'Zentrale',weekly_hours:40,user_id:null,
};

type Payload=Record<string,unknown>&{fields?:Record<string,string>};

function installProfileApi(){
  let employee:Record<string,unknown>={...initialEmployee};
  const saved:Payload[]=[];
  let rejection:Error|null=null;
  let pending:Promise<void>|null=null;
  apiMock.mockImplementation(async(path:string,options?:RequestInit)=>{
    if(path===profilePath&&options?.method==='PATCH'){
      const body=JSON.parse(String(options.body)) as Payload;
      saved.push(body);
      if(pending)await pending;
      if(rejection)throw rejection;
      const {reason:_reason,...fields}=body;
      employee={...employee,...fields};
      return employee;
    }
    if(path===profilePath)return {
      employee,contracts:[],qualifications:[],absences:[],object_assignments:[],work_time:[],documents:[],availability:[],
    };
    return {};
  });
  return {
    saved,
    setEmployee:(next:Record<string,unknown>)=>{employee=next;},
    reject:(error:Error|null)=>{rejection=error;},
    defer:()=>{let release!:()=>void;pending=new Promise<void>(resolve=>{release=()=>resolve();});return release;},
  };
}

function renderDetail(){
  return render(<MemoryRouter initialEntries={[`/employees/${employeeId}/stammdaten`]}><Routes>
    <Route path="/employees/:employeeId/:section" element={<EmployeeDetail/>}/>
    <Route path="/employees/:employeeId" element={<EmployeeDetail/>}/>
  </Routes></MemoryRouter>);
}

const save=()=>fireEvent.click(screen.getByRole('button',{name:'Stammdaten speichern'}));

describe('employee master data editing',()=>{
  it('saves first name, last name and phone and shows them after reopening the record',async()=>{
    const api=installProfileApi();
    renderDetail();
    expect(await screen.findByDisplayValue('Ava')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Vorname'),{target:{value:'Lena'}});
    fireEvent.change(screen.getByLabelText('Nachname'),{target:{value:'Fischer'}});
    fireEvent.change(screen.getByLabelText('Telefon'),{target:{value:'+49 30 999'}});
    fireEvent.change(screen.getByLabelText('Änderungsgrund'),{target:{value:'Namensänderung'}});
    save();
    expect(await screen.findByText('Stammdaten wurden gespeichert.')).toBeTruthy();
    expect(api.saved).toHaveLength(1);
    expect(api.saved[0].first_name).toBe('Lena');
    expect(api.saved[0].last_name).toBe('Fischer');
    expect(api.saved[0].phone).toBe('+49 30 999');
    expect(api.saved[0].id).toBeUndefined();
    expect(api.saved[0].tenant_id).toBeUndefined();
    expect(api.saved[0].account_email).toBeUndefined();

    cleanup();
    renderDetail();
    expect(await screen.findByDisplayValue('Lena')).toBeTruthy();
    expect(screen.getByDisplayValue('Fischer')).toBeTruthy();
    expect(screen.getByDisplayValue('+49 30 999')).toBeTruthy();
  });

  it('saves email, address, employment status and department in one request',async()=>{
    const api=installProfileApi();
    renderDetail();
    await screen.findByDisplayValue('Ava');
    fireEvent.change(screen.getByLabelText('E-Mail'),{target:{value:'lena@example.invalid'}});
    fireEvent.change(screen.getByLabelText('Adresse'),{target:{value:'Neustrasse 9'}});
    fireEvent.change(screen.getByLabelText('Abteilung'),{target:{value:'Qualitätssicherung'}});
    fireEvent.change(screen.getByLabelText('Beschäftigungsstatus'),{target:{value:'leave'}});
    fireEvent.change(screen.getByLabelText('Änderungsgrund'),{target:{value:'Umzug und Beurlaubung'}});
    save();
    expect(await screen.findByText('Stammdaten wurden gespeichert.')).toBeTruthy();
    expect(api.saved[0]).toMatchObject({
      email:'lena@example.invalid',address:'Neustrasse 9',department:'Qualitätssicherung',employment_status:'leave',
      first_name:'Ava',employee_number:'P-100',position:'Wache',weekly_hours:40,reason:'Umzug und Beurlaubung',
    });
  });

  it('clears optional fields with null values',async()=>{
    const api=installProfileApi();
    renderDetail();
    await screen.findByDisplayValue('Ava');
    fireEvent.change(screen.getByLabelText('Telefon'),{target:{value:''}});
    fireEvent.change(screen.getByLabelText('Adresse'),{target:{value:''}});
    fireEvent.change(screen.getByLabelText('Änderungsgrund'),{target:{value:'Bereinigung'}});
    save();
    expect(await screen.findByText('Stammdaten wurden gespeichert.')).toBeTruthy();
    expect(api.saved[0].phone).toBeNull();
    expect(api.saved[0].address).toBeNull();
  });

  it('marks invalid fields client-side and does not send a request',async()=>{
    const api=installProfileApi();
    renderDetail();
    await screen.findByDisplayValue('Ava');
    const emailInput=screen.getByLabelText('E-Mail');
    fireEvent.change(emailInput,{target:{value:'ungueltig'}});
    save();
    expect(await screen.findByText('Bitte die markierten Felder prüfen.')).toBeTruthy();
    expect(screen.getByText('Bitte eine gültige E-Mail-Adresse angeben.')).toBeTruthy();
    expect(screen.getByText('Bitte einen Änderungsgrund angeben.')).toBeTruthy();
    expect(emailInput.getAttribute('aria-invalid')).toBe('true');
    expect(api.saved).toHaveLength(0);
  });

  it('keeps entered values when the API rejects the save and shows the server field error',async()=>{
    const api=installProfileApi();
    const failure=new Error('Invalid employee profile') as Error&{fields?:Record<string,string>};
    failure.fields={email:'Ungültige E-Mail-Adresse'};
    api.reject(failure);
    renderDetail();
    await screen.findByDisplayValue('Ava');
    const emailInput=screen.getByLabelText('E-Mail');
    const firstNameInput=screen.getByLabelText('Vorname');
    fireEvent.change(emailInput,{target:{value:'kaputt@example.invalid'}});
    fireEvent.change(firstNameInput,{target:{value:'Lena'}});
    fireEvent.change(screen.getByLabelText('Änderungsgrund'),{target:{value:'Korrektur'}});
    save();
    expect(await screen.findByText('Invalid employee profile')).toBeTruthy();
    await waitFor(()=>expect(screen.getByText('Ungültige E-Mail-Adresse')).toBeTruthy());
    expect(emailInput).toHaveProperty('value','kaputt@example.invalid');
    expect(firstNameInput).toHaveProperty('value','Lena');
    expect(screen.queryByText('Stammdaten wurden gespeichert.')).toBeNull();
  });

  it('shows a loading state and prevents a second save while the request is running',async()=>{
    const api=installProfileApi();
    const release=api.defer();
    renderDetail();
    await screen.findByDisplayValue('Ava');
    fireEvent.change(screen.getByLabelText('Änderungsgrund'),{target:{value:'Korrektur'}});
    fireEvent.click(screen.getByRole('button',{name:'Stammdaten speichern'}));
    expect(screen.getByRole('button',{name:'Speichern …'}).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button',{name:'Speichern …'}));
    expect(api.saved).toHaveLength(1);
    await act(async()=>{release();});
    expect(await screen.findByText('Stammdaten wurden gespeichert.')).toBeTruthy();
  });

  it('restores the original values on cancel',async()=>{
    installProfileApi();
    renderDetail();
    await screen.findByDisplayValue('Ava');
    fireEvent.change(screen.getByLabelText('Vorname'),{target:{value:'Lena'}});
    fireEvent.click(screen.getByRole('button',{name:'Abbrechen'}));
    expect(screen.getByLabelText('Vorname')).toHaveProperty('value','Ava');
  });
});
