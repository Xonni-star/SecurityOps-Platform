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
  current_object?:string|null;
  qualification_status?:string|null;
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
  expiring_qualifications?:{employee:string;code:string;valid_until:string}[];
  missing_document_employees?:{employee:string;title:string}[];
  pending_tasks?:{employee:string;task:string;due:string}[];
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
  const [sortKey,setSortKey]=useState<'name'|'employee_number'|'position'|'department'|'employment_status'|'current_object'|'qualification_status'>('name');
  const [sortDirection,setSortDirection]=useState<'asc'|'desc'>('asc');
  const [page,setPage]=useState(1);
  const pageSize=10;
  const [createOpen,setCreateOpen]=useState(false);
  const [form,setForm]=useState(emptyEmployee);
  const [error,setError]=useState('');

  const load=async()=>{
    try{
      const [overview,metrics]=await Promise.all([
        api<Employee[]|null>('/employees/overview'),
        api<Dashboard>('/employees/dashboard'),
      ]);
      const rows=Array.isArray(overview)?overview:await api<Employee[]>('/employees');
      setEmployees(Array.isArray(rows)?rows:[]);
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
  const sorted=[...filtered].sort((a,b)=>{
    const av=String((a as any)[sortKey]||'').toLowerCase();
    const bv=String((b as any)[sortKey]||'').toLowerCase();
    return sortDirection==='asc'?av.localeCompare(bv):bv.localeCompare(av);
  });
  const pageCount=Math.max(1,Math.ceil(sorted.length/pageSize));
  const currentPage=Math.min(page,pageCount);
  const paged=sorted.slice((currentPage-1)*pageSize,currentPage*pageSize);
  const changeSort=(key:typeof sortKey)=>{
    if(sortKey===key)setSortDirection(value=>value==='asc'?'desc':'asc');
    else{setSortKey(key);setSortDirection('asc');}
    setPage(1);
  };

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
        <input className="employee-search" placeholder="Name, Personalnummer, Funktion oder E-Mail suchen" value={search} onChange={event=>{setSearch(event.target.value);setPage(1);}} />
        <select value={statusFilter} onChange={event=>{setStatusFilter(event.target.value);setPage(1);}} aria-label="Status">
          <option value="all">Status: Alle</option><option value="active">Status: Aktiv</option><option value="probation">Status: Probezeit</option><option value="leave">Status: Abwesenheit</option><option value="terminated">Status: Ausgeschieden</option>
        </select>
        <select value={departmentFilter} onChange={event=>{setDepartmentFilter(event.target.value);setPage(1);}} aria-label="Abteilung">
          <option value="all">Abteilung: Alle</option>{departments.map(department=><option key={department} value={department}>{department}</option>)}
        </select>
        <select value={functionFilter} onChange={event=>{setFunctionFilter(event.target.value);setPage(1);}} aria-label="Funktion">
          <option value="all">Funktion: Alle</option><option value="objekt">Objektdienst</option><option value="revier">Revierdienst</option><option value="leitstelle">Leitstelle</option>
        </select>
      </div>

      <div className="employee-table employee-overview-table">
        <table>
          <thead>
            <tr>
              <th>Auswahl</th>
              <th><button type="button" onClick={()=>changeSort('name')}>Mitarbeiter</button></th>
              <th><button type="button" onClick={()=>changeSort('employee_number')}>Personal-Nr.</button></th>
              <th><button type="button" onClick={()=>changeSort('position')}>Funktion</button></th>
              <th><button type="button" onClick={()=>changeSort('department')}>Abteilung</button></th>
              <th><button type="button" onClick={()=>changeSort('employment_status')}>Status</button></th>
              <th><button type="button" onClick={()=>changeSort('current_object')}>Aktuelles Objekt</button></th>
              <th><button type="button" onClick={()=>changeSort('qualification_status')}>Qualifikation</button></th>
              <th>Aktion</th>
            </tr>
          </thead>
          <tbody>
            {paged.map(employee=><tr key={employee.id}>
              <td><input type="checkbox" aria-label={`${employee.name} auswählen`} /></td>
              <td><button type="button" className="employee-name-link" onClick={()=>navigate(`/employees/${employee.id}`)}><strong>{employee.name}</strong><small>{employee.email}</small></button></td>
              <td>{employee.employee_number||'–'}</td>
              <td>{employee.position||employee.title||'–'}</td>
              <td>{employee.department||'–'}</td>
              <td><span className={`employee-status ${employee.employment_status}`}>{employee.employment_status==='active'?'Aktiv':employee.employment_status==='leave'?'Abwesenheit':employee.employment_status==='probation'?'Probezeit':employee.employment_status==='terminated'?'Ausgeschieden':employee.employment_status}</span></td>
              <td>{employee.current_object||'–'}</td>
              <td><span className={`qualification-mini ${employee.qualification_status==='abgelaufen'?'expired':''}`}>{employee.qualification_status||'keine Daten'}</span></td>
              <td><button type="button" onClick={()=>navigate(`/employees/${employee.id}`)}>Bearbeiten</button></td>
            </tr>)}
          </tbody>
        </table>
        {filtered.length===0&&<p className="employee-empty">Keine Mitarbeiter entsprechen den aktiven Filtern.</p>}
        {filtered.length>0&&<div className="employee-pagination">
          <span>{filtered.length} Mitarbeiter · Seite {currentPage} von {pageCount}</span>
          <button type="button" disabled={currentPage===1} onClick={()=>setPage(value=>Math.max(1,value-1))}>Zurück</button>
          <button type="button" disabled={currentPage===pageCount} onClick={()=>setPage(value=>Math.min(pageCount,value+1))}>Weiter</button>
        </div>}
      </div>
    </div>
    {dashboard&&<div className="employee-task-grid">
      <article>
        <h3>Auslaufende Qualifikationen</h3>
        {dashboard.expiring_qualifications?.length?<ul>{dashboard.expiring_qualifications.map((item:any)=><li key={`${item.employee}-${item.code}`}><strong>{item.employee}</strong><span>{item.code} · {item.valid_until}</span></li>)}</ul>:<p className="employee-empty">Keine auslaufenden Qualifikationen.</p>}
      </article>
      <article>
        <h3>Fehlende Dokumente</h3>
        {dashboard.missing_document_employees?.length?<ul>{dashboard.missing_document_employees.map((item:any,index:number)=><li key={`${item.employee}-${index}`}><strong>{item.employee}</strong><span>Personalakte unvollständig</span></li>)}</ul>:<p className="employee-empty">Keine fehlenden Dokumente.</p>}
      </article>
      <article>
        <h3>Anstehende Personalaufgaben</h3>
        {dashboard.pending_tasks?.length?<ul>{dashboard.pending_tasks.map((item:any,index:number)=><li key={`${item.employee}-${index}`}><strong>{item.employee}</strong><span>{item.task}</span></li>)}</ul>:<p className="employee-empty">Keine offenen Personalaufgaben.</p>}
      </article>
    </div>}
  </section>;
}
