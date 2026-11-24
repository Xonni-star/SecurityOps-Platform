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
  const [absenceForm,setAbsenceForm]=useState({starts_at:'',ends_at:'',absence_type:'vacation',status:'approved',reason:'',document_id:'',audit_reason:''});

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

  const createAbsence=async(e:FormEvent)=>{
    e.preventDefault();if(!selected||!absenceForm.starts_at||!absenceForm.ends_at)return;
    try{
      await api(`/employees/${selected.id}/absences`,{method:'POST',body:JSON.stringify({
        starts_at:new Date(absenceForm.starts_at).toISOString(),
        ends_at:new Date(absenceForm.ends_at).toISOString(),
        absence_type:absenceForm.absence_type,
        status:absenceForm.status,
        reason:absenceForm.reason||null,
        document_id:absenceForm.document_id||null,
        audit_reason:absenceForm.audit_reason,
      })});
      setAbsenceForm(v=>({...v,starts_at:'',ends_at:'',reason:'',document_id:'',audit_reason:''}));
      await openProfile(selected);await load();
    }catch(e){setError((e as Error).message);}
  };

  const cancelAbsence=async(absenceId:string)=>{
    if(!selected)return;
    try{
      await api(`/employees/${selected.id}/absences/${absenceId}`,{method:'DELETE',body:JSON.stringify({audit_reason:'Absence cancelled from employee profile'})});
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
          <tbody>{employees.filter(employee=>`${employee.name} ${employee.email} ${employee.employee_number||''}`.toLowerCase().includes(search.toLowerCase())).map(employee=><tr key={employee.id}>
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
        {hasPermission('employees:write')&&<>
          <form className="employee-subform" onSubmit={createContract}>
            <h3>Vertrag</h3>
            <label>Vertrags-Nr.<input value={contractForm.contract_number} onChange={e=>setContractForm({...contractForm,contract_number:e.target.value})}/></label>
            <label>Vertragsart<select value={contractForm.contract_type} onChange={e=>setContractForm({...contractForm,contract_type:e.target.value})}><option value="permanent">Unbefristet</option><option value="fixed_term">Befristet</option><option value="part_time">Teilzeit</option><option value="temporary">Zeitarbeit</option><option value="internship">Praktikum</option><option value="freelance">Freiberuflich</option></select></label>
            <label>Status<select value={contractForm.status} onChange={e=>setContractForm({...contractForm,status:e.target.value})}><option value="active">Aktiv</option><option value="draft">Entwurf</option><option value="ended">Beendet</option><option value="cancelled">Storniert</option></select></label>
            <label>Beginn<input type="date" required value={contractForm.starts_on} onChange={e=>setContractForm({...contractForm,starts_on:e.target.value})}/></label>
            <label>Ende<input type="date" value={contractForm.ends_on} onChange={e=>setContractForm({...contractForm,ends_on:e.target.value})}/></label>
            <label>Wochenstunden<input type="number" min="0" max="168" step="0.25" value={contractForm.weekly_hours} onChange={e=>setContractForm({...contractForm,weekly_hours:e.target.value})}/></label>
            <label>Grund<input required value={contractForm.reason} onChange={e=>setContractForm({...contractForm,reason:e.target.value})}/></label>
            <button>Vertrag speichern</button>
          </form>
          <form className="employee-subform" onSubmit={createAssignment}>
            <h3>Objektzuweisung</h3>
            <label>Objekt<select required value={assignmentForm.site_id} onChange={e=>setAssignmentForm({...assignmentForm,site_id:e.target.value})}><option value="">Bitte wählen</option>{sites.map(site=><option key={site.id} value={site.id}>{site.name}</option>)}</select></label>
            <label>Art<select value={assignmentForm.assignment_type} onChange={e=>setAssignmentForm({...assignmentForm,assignment_type:e.target.value})}><option value="operational">Operativ</option><option value="management">Leitung</option><option value="support">Unterstützung</option><option value="temporary">Temporär</option><option value="reserve">Reserve</option></select></label>
            <label>Rolle<input value={assignmentForm.role} onChange={e=>setAssignmentForm({...assignmentForm,role:e.target.value})}/></label>
            <label>Beginn<input type="date" required value={assignmentForm.starts_on} onChange={e=>setAssignmentForm({...assignmentForm,starts_on:e.target.value})}/></label>
            <label>Ende<input type="date" value={assignmentForm.ends_on} onChange={e=>setAssignmentForm({...assignmentForm,ends_on:e.target.value})}/></label>
            <label><input type="checkbox" checked={assignmentForm.primary_assignment} onChange={e=>setAssignmentForm({...assignmentForm,primary_assignment:e.target.checked})}/> Primärobjekt</label>
            <label>Grund<input required value={assignmentForm.reason} onChange={e=>setAssignmentForm({...assignmentForm,reason:e.target.value})}/></label>
            <button>Zuweisen</button>
          </form>
          <form className="employee-subform" onSubmit={createAbsence}>
            <h3>Abwesenheit</h3>
            <label>Beginn<input type="datetime-local" required value={absenceForm.starts_at} onChange={e=>setAbsenceForm({...absenceForm,starts_at:e.target.value})}/></label>
            <label>Ende<input type="datetime-local" required value={absenceForm.ends_at} onChange={e=>setAbsenceForm({...absenceForm,ends_at:e.target.value})}/></label>
            <label>Art<select value={absenceForm.absence_type} onChange={e=>setAbsenceForm({...absenceForm,absence_type:e.target.value})}><option value="vacation">Urlaub</option><option value="sick">Krankheit</option><option value="training">Fortbildung</option><option value="special_leave">Sonderurlaub</option><option value="compensatory">Freizeitausgleich</option><option value="unavailable">Nicht verfügbar</option><option value="other">Sonstige</option></select></label>
            <label>Status<select value={absenceForm.status} onChange={e=>setAbsenceForm({...absenceForm,status:e.target.value})}><option value="approved">Genehmigt</option><option value="requested">Antrag</option><option value="rejected">Abgelehnt</option><option value="cancelled">Storniert</option></select></label>
            <label>Grund<input value={absenceForm.reason} onChange={e=>setAbsenceForm({...absenceForm,reason:e.target.value})}/></label>
            <label>DMS-Dokument-ID<input value={absenceForm.document_id} onChange={e=>setAbsenceForm({...absenceForm,document_id:e.target.value})}/></label>
            <label>Änderungsgrund<input required value={absenceForm.audit_reason} onChange={e=>setAbsenceForm({...absenceForm,audit_reason:e.target.value})}/></label>
            <button>Abwesenheit speichern</button>
          </form>
        </>}
        {profile&&<div className="employee-data-cards">
          <article><h3>Verträge</h3>{profile.contracts.length?profile.contracts.map((row:any)=><p key={row.id}><strong>{row.contract_type}</strong><br/><small>{row.starts_on} bis {row.ends_on||'offen'} · {row.status}</small></p>):<p>Keine Verträge erfasst</p>}</article>
          <article><h3>Qualifikationen</h3>{profile.qualifications.length?profile.qualifications.map((row:any)=><p key={row.id}><strong>{row.catalog_name||row.code}</strong><br/><small>bis {row.valid_until||'unbefristet'} · {row.status}</small></p>):<p>Keine Qualifikationen erfasst</p>}</article>
          <article><h3>Objektzuweisungen</h3>{profile.object_assignments.length?profile.object_assignments.map((row:any)=><p key={row.id}><strong>{row.site_name}</strong><br/><small>{row.starts_on} bis {row.ends_on||'offen'} · {row.assignment_type}</small></p>):<p>Keine Objektzuweisungen</p>}</article>
          <article><h3>Abwesenheiten</h3>{profile.absences.length?profile.absences.map((row:any)=><p key={row.id}><strong>{row.absence_type}</strong>{row.status==='approved'||row.status==='requested'?<button type="button" onClick={()=>void cancelAbsence(row.id)}>Stornieren</button>:null}<br/><small>{row.starts_at?.slice(0,16)} bis {row.ends_at?.slice(0,16)} · {row.status}</small></p>):<p>Keine Abwesenheiten</p>}</article>
          <article><h3>Arbeitszeit</h3>{profile.work_time.length?profile.work_time.slice(0,8).map((row:any)=><p key={row.id}><strong>{row.status}</strong><br/><small>{row.started_at?.slice(0,16)} · {row.minutes??0} Min.</small></p>):<p>Keine Arbeitszeitdaten</p>}</article>
        </div>}
      </aside>}
    </div>
  </section>;
}
