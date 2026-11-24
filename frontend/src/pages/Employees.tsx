import {FormEvent,useEffect,useState} from 'react';
import {api,hasPermission} from '../lib/api';

type Employee={
  id:string;name:string;email:string;title?:string|null;employee_number?:string|null;
  first_name?:string|null;last_name?:string|null;phone?:string|null;mobile?:string|null;
  address?:string|null;date_of_birth?:string|null;hire_date?:string|null;termination_date?:string|null;
  employment_status:string;employment_type:string;department?:string|null;position?:string|null;
  work_location?:string|null;weekly_hours?:number|null;user_id?:string|null;
};
type Dashboard={
  employees:{total:number;active:number;inactive:number;on_leave:number;sick:number;terminated:number};
  qualifications_expiring_90_days:number;
  qualifications_expired:number;
  upcoming_shift_assignments:number;
  open_absences:number;
  sick_employees:number;
  active_object_assignments:number;
  active_contracts:number;
  missing_required_qualifications:number;
  missing_documents:number;
  employees_without_object:number;
};
type Profile={
  employee:Employee;
  contracts:any[];
  qualifications:any[];
  absences:any[];
  object_assignments:any[];
  work_time:any[];
};

const empty:Employee={id:'',name:'',email:'',employment_status:'active',employment_type:'employee'};

export function Employees(){
  const [employees,setEmployees]=useState<Employee[]>([]);
  const [dashboard,setDashboard]=useState<Dashboard|null>(null);
  const [selected,setSelected]=useState<Employee|null>(null);
  const [form,setForm]=useState<Employee>(empty);
  const [reason,setReason]=useState('');
  const [error,setError]=useState('');
  const [profile,setProfile]=useState<Profile|null>(null);
  const [sites,setSites]=useState<{id:string;name:string}[]>([]);
  const [search,setSearch]=useState('');
  const [contractForm,setContractForm]=useState({contract_number:'',contract_type:'permanent',status:'active',starts_on:new Date().toISOString().slice(0,10),ends_on:'',weekly_hours:'',reason:''});
  const [assignmentForm,setAssignmentForm]=useState({site_id:'',assignment_type:'operational',role:'',starts_on:new Date().toISOString().slice(0,10),ends_on:'',primary_assignment:false,reason:''});

  const load=async()=>{
    try{
      const [rows,metrics]=await Promise.all([
        api<Employee[]>('/employees'),
        api<Dashboard>('/employees/dashboard'),
      ]);
      setEmployees(rows||[]);
      setDashboard(metrics ?? null);
      const siteRows=await api<{id:string;name:string}[]>('/sites').catch(()=>[]);
      setSites(siteRows||[]);
      setError('');
    }catch(e){setError((e as Error).message);}
  };
  useEffect(()=>{void load();},[]);

  const create=async(e:FormEvent)=>{
    e.preventDefault();
    try{
      await api<Employee>('/employees',{method:'POST',body:JSON.stringify({
        name:form.name,email:form.email,title:form.title||null,employee_number:form.employee_number||null,
      })});
      setForm(empty);await load();
    }catch(e){setError((e as Error).message);}
  };

  const openProfile=async(employee:Employee)=>{
    try{
      const profile=await api<Profile>(`/employees/${employee.id}/profile`);
      if(!profile)throw new Error('Mitarbeiterprofil nicht gefunden');
      setProfile(profile);
      setSelected(profile.employee);
      setForm({...profile.employee});
      setError('');
    }catch(e){setError((e as Error).message);}
  };

  const update=async(e:FormEvent)=>{
    e.preventDefault();
    if(!selected)return;
    try{
      await api<Employee>(`/employees/${selected.id}/profile`,{method:'PATCH',body:JSON.stringify({...form,reason:reason||'Employee profile updated'})});
      setReason('');
      await load();
      await openProfile(selected);
    }catch(e){setError((e as Error).message);}
  };

  const createContract=async(e:FormEvent)=>{
    e.preventDefault();if(!selected)return;
    try{
      await api(`/employees/${selected.id}/contracts`,{method:'POST',body:JSON.stringify({
        ...contractForm,
        contract_number:contractForm.contract_number||null,
        ends_on:contractForm.ends_on||null,
        weekly_hours:contractForm.weekly_hours===''?null:Number(contractForm.weekly_hours),
      })});
      setContractForm(v=>({...v,contract_number:'',reason:''}));
      await openProfile(selected);await load();
    }catch(e){setError((e as Error).message);}
  };

  const createAssignment=async(e:FormEvent)=>{
    e.preventDefault();if(!selected||!assignmentForm.site_id)return;
    try{
      await api(`/employees/${selected.id}/object-assignments`,{method:'POST',body:JSON.stringify({
        ...assignmentForm,
        role:assignmentForm.role||null,
        ends_on:assignmentForm.ends_on||null,
      })});
      setAssignmentForm(v=>({...v,site_id:'',role:'',reason:''}));
      await openProfile(selected);await load();
    }catch(e){setError((e as Error).message);}
  };

  return <section className="employee-management">
    <h1>Mitarbeiter</h1>
    {error&&<p role="alert" className="error">{error}</p>}
    {dashboard&&<div className="stats-grid employee-metrics">
      <article><strong>{dashboard.employees.total}</strong><span>Mitarbeiter gesamt</span></article>
      <article><strong>{dashboard.employees.active}</strong><span>Aktiv</span></article>
      <article><strong>{dashboard.qualifications_expiring_90_days}</strong><span>Qualifikationen &lt; 90 Tage</span></article>
      <article><strong>{dashboard.open_absences}</strong><span>Offene Abwesenheiten</span></article>
      <article><strong>{dashboard.active_contracts}</strong><span>Aktive Verträge</span></article>
      <article><strong>{dashboard.active_object_assignments}</strong><span>Objektzuordnungen</span></article>
      <article><strong>{dashboard.upcoming_shift_assignments}</strong><span>Schichtzuordnungen</span></article>
      <article><strong>{dashboard.employees.on_leave}</strong><span>In Abwesenheit</span></article>
      <article><strong>{dashboard.employees.inactive}</strong><span>Inaktiv/Ausgeschieden</span></article>
      <article><strong>{dashboard.qualifications_expired}</strong><span>Abgelaufene Qualifikationen</span></article>
      <article><strong>{dashboard.missing_documents}</strong><span>Mitarbeiter ohne Dokumente</span></article>
      <article><strong>{dashboard.employees_without_object}</strong><span>Ohne aktuelle Objektzuweisung</span></article>
    </div>}

    {hasPermission('employees:write')&&<form onSubmit={create} className="employee-create">
      <label>Name<input required value={form.name||''} onChange={e=>setForm({...form,name:e.target.value})}/></label>
      <label>E-Mail<input required type="email" value={form.email||''} onChange={e=>setForm({...form,email:e.target.value})}/></label>
      <label>Personalnummer<input value={form.employee_number||''} onChange={e=>setForm({...form,employee_number:e.target.value})}/></label>
      <label>Funktion<input value={form.title||''} onChange={e=>setForm({...form,title:e.target.value})}/></label>
      <button>Anlegen</button>
    </form>}

    <div className="employee-layout">
      <div className="employee-table">
        <input className="employee-search" placeholder="Mitarbeiter suchen" value={search} onChange={e=>setSearch(e.target.value)} />
        <table>
          <thead><tr><th>Mitarbeiter</th><th>Personal-Nr.</th><th>Abteilung</th><th>Status</th><th>Aktion</th></tr></thead>
          <tbody>{employees.map(employee=><tr key={employee.id}>
            <td><strong>{employee.name}</strong><br/><small>{employee.email}</small></td>
            <td>{employee.employee_number||'–'}</td>
            <td>{employee.department||employee.position||'–'}</td>
            <td>{employee.employment_status}</td>
            <td><button type="button" onClick={()=>void openProfile(employee)}>Profil</button></td>
          </tr>)}</tbody>
        </table>
      </div>
      {selected&&<aside className="employee-profile">
        <h2>Mitarbeiterprofil</h2>
        {hasPermission('employees:write')?<form onSubmit={update}>
          <label>Name<input required value={form.name||''} onChange={e=>setForm({...form,name:e.target.value})}/></label>
          <label>E-Mail<input required type="email" value={form.email||''} onChange={e=>setForm({...form,email:e.target.value})}/></label>
          <label>Personalnummer<input value={form.employee_number||''} onChange={e=>setForm({...form,employee_number:e.target.value})}/></label>
          <label>Vorname<input value={form.first_name||''} onChange={e=>setForm({...form,first_name:e.target.value})}/></label>
          <label>Nachname<input value={form.last_name||''} onChange={e=>setForm({...form,last_name:e.target.value})}/></label>
          <label>Telefon<input value={form.phone||''} onChange={e=>setForm({...form,phone:e.target.value})}/></label>
          <label>Mobil<input value={form.mobile||''} onChange={e=>setForm({...form,mobile:e.target.value})}/></label>
          <label>Abteilung<input value={form.department||''} onChange={e=>setForm({...form,department:e.target.value})}/></label>
          <label>Position<input value={form.position||''} onChange={e=>setForm({...form,position:e.target.value})}/></label>
          <label>Standort<input value={form.work_location||''} onChange={e=>setForm({...form,work_location:e.target.value})}/></label>
          <label>Beschäftigungsstatus<select value={form.employment_status} onChange={e=>setForm({...form,employment_status:e.target.value})}><option value="active">Aktiv</option><option value="probation">Probezeit</option><option value="leave">Abwesend</option><option value="terminated">Ausgetreten</option><option value="archived">Archiviert</option></select></label>
          <label>Beschäftigungsart<select value={form.employment_type} onChange={e=>setForm({...form,employment_type:e.target.value})}><option value="employee">Angestellt</option><option value="temporary">Zeitarbeit</option><option value="contractor">Werkvertrag</option><option value="intern">Praktikum</option><option value="apprentice">Ausbildung</option><option value="freelancer">Freiberuflich</option></select></label>
          <label>Wöchentliche Stunden<input type="number" min="0" max="168" step="0.25" value={form.weekly_hours??''} onChange={e=>setForm({...form,weekly_hours:e.target.value===''?null:Number(e.target.value)})}/></label>
          <label>Eintritt<input type="date" value={form.hire_date?.slice(0,10)||''} onChange={e=>setForm({...form,hire_date:e.target.value||null})}/></label>
          <label>Adresse<textarea value={form.address||''} onChange={e=>setForm({...form,address:e.target.value})}/></label>
          <label>Änderungsgrund<input required value={reason} onChange={e=>setReason(e.target.value)} placeholder="Grund der Änderung"/></label>
          <button>Profil speichern</button>
        </form>:<dl><dt>E-Mail</dt><dd>{selected.email}</dd><dt>Status</dt><dd>{selected.employment_status}</dd><dt>Abteilung</dt><dd>{selected.department||'–'}</dd></dl>}
      </aside>}
    </div>
  </section>;
}
