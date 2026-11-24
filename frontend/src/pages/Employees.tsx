import {FormEvent,useEffect,useState} from 'react';
import {useNavigate} from 'react-router-dom';
import {api,hasPermission} from '../lib/api';

type Employee={
  id:string;
  name:string;
  email:string;
  employee_number?:string|null;
  title?:string|null;
  department?:string|null;
  position?:string|null;
  employment_status:string;
  employment_type:string;
};

type Dashboard={
  employees:{total:number;active:number;inactive:number;on_leave:number;sick:number;terminated:number};
  qualifications_expiring_90_days:number;
  qualifications_expired:number;
  sick_employees:number;
  upcoming_shift_assignments:number;
  open_absences:number;
  active_object_assignments:number;
  missing_documents:number;
  employees_without_object:number;
};

const emptyEmployee={name:'',email:'',title:'',employee_number:''};

export function Employees(){
  const navigate=useNavigate();
  const [employees,setEmployees]=useState<Employee[]>([]);
  const [dashboard,setDashboard]=useState<Dashboard|null>(null);
  const [search,setSearch]=useState('');
  const [statusFilter,setStatusFilter]=useState('all');
  const [departmentFilter,setDepartmentFilter]=useState('all');
  const [functionFilter,setFunctionFilter]=useState('all');
  const [createOpen,setCreateOpen]=useState(false);
  const [form,setForm]=useState(emptyEmployee);
  const [error,setError]=useState('');

  const load=async()=>{
    try{
      const [rows,metrics]=await Promise.all([
        api<Employee[]>('/employees'),
        api<Dashboard>('/employees/dashboard'),
      ]);
      setEmployees(rows||[]);
      setDashboard(metrics||null);
      setError('');
    }catch(e){setError((e as Error).message);}
  };

  useEffect(()=>{void load();},[]);

  const createEmployee=async(event:FormEvent)=>{
    event.preventDefault();
    try{
      await api<Employee>('/employees',{method:'POST',body:JSON.stringify({
        name:form.name,
        email:form.email,
        title:form.title||null,
        employee_number:form.employee_number||null,
      })});
      setForm(emptyEmployee);
      setCreateOpen(false);
      await load();
    }catch(e){setError((e as Error).message);}
  };

  const departments=Array.from(new Set(employees.map(employee=>employee.department||employee.position||'').filter(Boolean))).sort();
  const filtered=employees.filter(employee=>{
    const haystack=`${employee.name} ${employee.email} ${employee.employee_number||''} ${employee.department||''} ${employee.position||''}`.toLowerCase();
    if(search&& !haystack.includes(search.toLowerCase()))return false;
    if(statusFilter!=='all'&&employee.employment_status!==statusFilter)return false;
    if(departmentFilter!=='all'&& (employee.department||employee.position||'')!==departmentFilter)return false;
    if(functionFilter!=='all'){
      const role=`${employee.position||employee.title||''}`.toLowerCase();
      if(functionFilter==='objekt'&&!role.includes('objekt'))return false;
      if(functionFilter==='revier'&&!role.includes('revier'))return false;
      if(functionFilter==='leitstelle'&&!role.includes('leitstelle')&&!role.includes('nsl'))return false;
    }
    return true;
  });

  return <section className="employee-management">
    <div className="employee-page-title">
      <div className="employee-page-title-spacer"></div>
      <div className="employee-page-actions">
        {hasPermission('employees:write')&&<button type="button" onClick={()=>setCreateOpen(value=>!value)}>+ Mitarbeiter anlegen</button>}
        <a className="employee-export" href="/api/v1/reports/employees?format=csv" target="_blank" rel="noreferrer">Export</a>
      </div>
    </div>

    {error&&<p role="alert" className="error">{error}</p>}

    {dashboard&&<div className="stats-grid employee-metrics">
      <article><strong>{dashboard.employees.total}</strong><span>Mitarbeiter gesamt</span></article>
      <article><strong>{dashboard.employees.active}</strong><span>Aktiv</span></article>
      <article><strong>{dashboard.open_absences}</strong><span>Offene Abwesenheiten</span></article>
      <article><strong>{dashboard.sick_employees}</strong><span>Krank</span></article>
      <article><strong>{dashboard.upcoming_shift_assignments}</strong><span>Aktuell im Dienst</span></article>
      <article><strong>{dashboard.qualifications_expiring_90_days+dashboard.qualifications_expired}</strong><span>Qualifikationswarnungen</span></article>
    </div>}

    {createOpen&&hasPermission('employees:write')&&<form onSubmit={createEmployee} className="employee-create open">
      <label>Name<input required value={form.name} onChange={event=>setForm({...form,name:event.target.value})}/></label>
      <label>E-Mail<input required type="email" value={form.email} onChange={event=>setForm({...form,email:event.target.value})}/></label>
      <label>Personalnummer<input value={form.employee_number} onChange={event=>setForm({...form,employee_number:event.target.value})}/></label>
      <label>Funktion<input value={form.title} onChange={event=>setForm({...form,title:event.target.value})}/></label>
      <button>Anlegen</button>
    </form>}

    <div className="employee-overview">
      <div className="employee-filterbar">
        <input className="employee-search" placeholder="Name, Personalnummer, Funktion oder E-Mail suchen" value={search} onChange={event=>setSearch(event.target.value)} />
        <select value={statusFilter} onChange={event=>setStatusFilter(event.target.value)} aria-label="Status">
          <option value="all">Status: Alle</option><option value="active">Status: Aktiv</option><option value="probation">Status: Probezeit</option><option value="leave">Status: Abwesenheit</option><option value="terminated">Status: Ausgeschieden</option>
        </select>
        <select value={departmentFilter} onChange={event=>setDepartmentFilter(event.target.value)} aria-label="Abteilung">
          <option value="all">Abteilung: Alle</option>{departments.map(department=><option key={department} value={department}>{department}</option>)}
        </select>
        <select value={functionFilter} onChange={event=>setFunctionFilter(event.target.value)} aria-label="Funktion">
          <option value="all">Funktion: Alle</option><option value="objekt">Objektdienst</option><option value="revier">Revierdienst</option><option value="leitstelle">Leitstelle</option>
        </select>
      </div>

      <div className="employee-table employee-overview-table">
        <table>
          <thead>
            <tr><th>Auswahl</th><th>Mitarbeiter</th><th>Personal-Nr.</th><th>Funktion</th><th>Abteilung</th><th>Status</th><th>Aktion</th></tr>
          </thead>
          <tbody>
            {filtered.map(employee=><tr key={employee.id}>
              <td><input type="checkbox" aria-label={`${employee.name} auswählen`} /></td>
              <td><button type="button" className="employee-name-link" onClick={()=>navigate(`/employees/${employee.id}`)}><strong>{employee.name}</strong><small>{employee.email}</small></button></td>
              <td>{employee.employee_number||'–'}</td>
              <td>{employee.position||employee.title||'–'}</td>
              <td>{employee.department||'–'}</td>
              <td><span className={`employee-status ${employee.employment_status}`}>{employee.employment_status==='active'?'Aktiv':employee.employment_status==='leave'?'Abwesenheit':employee.employment_status==='probation'?'Probezeit':employee.employment_status==='terminated'?'Ausgeschieden':employee.employment_status}</span></td>
              <td><button type="button" onClick={()=>navigate(`/employees/${employee.id}`)}>Bearbeiten</button></td>
            </tr>)}
          </tbody>
        </table>
        {filtered.length===0&&<p className="employee-empty">Keine Mitarbeiter entsprechen den aktiven Filtern.</p>}
      </div>
    </div>
  </section>;
}
