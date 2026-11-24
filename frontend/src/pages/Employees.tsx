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
  documents:any[];
  availability:any[];
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
  const [editMode,setEditMode]=useState(false);
  const [createOpen,setCreateOpen]=useState(false);
  const [statusFilter,setStatusFilter]=useState('active');
  const [absenceFilter,setAbsenceFilter]=useState('all');
  const [functionFilter,setFunctionFilter]=useState('all');
  const [contractForm,setContractForm]=useState({contract_number:'',contract_type:'permanent',status:'active',starts_on:new Date().toISOString().slice(0,10),ends_on:'',weekly_hours:'',reason:''});
  const [assignmentForm,setAssignmentForm]=useState({site_id:'',assignment_type:'operational',role:'',starts_on:new Date().toISOString().slice(0,10),ends_on:'',primary_assignment:false,reason:''});
  const [absenceForm,setAbsenceForm]=useState({starts_at:'',ends_at:'',absence_type:'vacation',status:'approved',reason:'',document_id:'',audit_reason:''});
  const [availabilityForm,setAvailabilityForm]=useState({weekday:'1',starts_time:'08:00',ends_time:'16:00',available:true,valid_from:'',valid_until:'',note:'',reason:''});

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
  useEffect(()=>{
    if(!selected&&employees.length>0)void openProfile(employees[0]);
  },[employees]);

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
      setEditMode(false);
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

  const createAvailability=async(e:FormEvent)=>{
    e.preventDefault();if(!selected)return;
    try{
      await api(`/employees/${selected.id}/availability`,{method:'POST',body:JSON.stringify({
        weekday:Number(availabilityForm.weekday),
        starts_time:availabilityForm.starts_time,
        ends_time:availabilityForm.ends_time,
        available:availabilityForm.available,
        valid_from:availabilityForm.valid_from||null,
        valid_until:availabilityForm.valid_until||null,
        note:availabilityForm.note||null,
        reason:availabilityForm.reason,
      })});
      setAvailabilityForm(v=>({...v,note:'',reason:''}));
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
    <div className="employee-page-title"><div><h1>Mitarbeiter</h1><p>Verwalten Sie Mitarbeiter, Qualifikationen und Einsatzinformationen.</p></div><div className="employee-page-actions">{hasPermission('employees:write')&&<button type="button" onClick={()=>setCreateOpen(v=>!v)}>+ Mitarbeiter anlegen</button>}<a className="employee-export" href="/api/v1/reports/employees?format=csv" target="_blank" rel="noreferrer">Export</a></div></div>
    {error&&<p role="alert" className="error">{error}</p>}
    {dashboard&&<div className="stats-grid employee-metrics">
      <article><strong>{dashboard.employees.total}</strong><span>Mitarbeiter gesamt</span></article>
      <article><strong>{dashboard.employees.active}</strong><span>Aktiv</span></article>
      <article><strong>{dashboard.open_absences}</strong><span>Offene Abwesenheiten</span></article>
      <article><strong>{dashboard.sick_employees}</strong><span>Krank</span></article>
      <article><strong>{dashboard.upcoming_shift_assignments}</strong><span>Schichtzuordnungen</span></article>
      <article><strong>{dashboard.qualifications_expiring_90_days+dashboard.qualifications_expired}</strong><span>Qualifikationswarnungen</span></article>
    </div>}

    {hasPermission('employees:write')&&<form onSubmit={create} className={createOpen?'employee-create open':'employee-create'}>
      <label>Name<input required value={form.name||''} onChange={e=>setForm({...form,name:e.target.value})}/></label>
      <label>E-Mail<input required type="email" value={form.email||''} onChange={e=>setForm({...form,email:e.target.value})}/></label>
      <label>Personalnummer<input value={form.employee_number||''} onChange={e=>setForm({...form,employee_number:e.target.value})}/></label>
      <label>Funktion<input value={form.title||''} onChange={e=>setForm({...form,title:e.target.value})}/></label>
      <button>Anlegen</button>
    </form>}

    <div className="employee-layout">
      <div className="employee-table">
        <div className="employee-filterbar">
          <input className="employee-search" placeholder="Nach Name, Personalnummer, Objekt oder E-Mail suchen" value={search} onChange={e=>setSearch(e.target.value)} />
          <select value={statusFilter} onChange={e=>setStatusFilter(e.target.value)} aria-label="Status"><option value="all">Status: Alle</option><option value="active">Status: Aktiv</option><option value="leave">Status: Abwesenheit</option><option value="probation">Status: Probezeit</option><option value="terminated">Status: Ausgeschieden</option></select>
          <select value={absenceFilter} onChange={e=>setAbsenceFilter(e.target.value)} aria-label="Abwesenheit"><option value="all">Abwesenheit: Alle</option><option value="none">Abwesenheit: Keine</option><option value="leave">Abwesenheit: Urlaub/Krank</option></select>
          <select value={functionFilter} onChange={e=>setFunctionFilter(e.target.value)} aria-label="Funktion"><option value="all">Funktion: Alle</option><option value="objekt">Objektdienst</option><option value="revier">Revierdienst</option><option value="nsl">Leitstelle</option></select>
        </div>
        <table>
          <thead><tr><th></th><th>Mitarbeiter</th><th>Personal-Nr.</th><th>Funktion</th><th>Abteilung</th><th>Status</th><th>Qualifikationen</th><th>Aktion</th></tr></thead>
          <tbody>{employees.filter(employee=>{
            const haystack=`${employee.name} ${employee.email} ${employee.employee_number||''} ${employee.department||''} ${employee.position||''}`.toLowerCase();
            if(search && !haystack.includes(search.toLowerCase()))return false;
            if(statusFilter==='all')return true;
            if(statusFilter==='leave')return employee.employment_status==='leave';
            return employee.employment_status===statusFilter;
          }).map(employee=><tr key={employee.id} className={selected?.id===employee.id?'selected-row':''}>
            <td><input type="checkbox" aria-label={`${employee.name} auswählen`} /></td>
            <td><strong>{employee.name}</strong><br/><small>{employee.email}</small></td>
            <td>{employee.employee_number||'–'}</td>
            <td>{employee.position||employee.title||'–'}</td>
            <td>{employee.department||'–'}</td>
            <td><span className={`employee-status ${employee.employment_status}`}>{employee.employment_status==='active'?'Aktiv':employee.employment_status==='leave'?'Abwesenheit':employee.employment_status==='terminated'?'Ausgeschieden':employee.employment_status==='probation'?'Probezeit':employee.employment_status}</span></td>
            <td>{profile?.employee.id===employee.id&&profile.qualifications.length>0?<span className="qualification-mini">Qualifikationen: {profile.qualifications.length}</span>:<span className="qualification-mini muted">Keine Daten</span>}</td>
            <td><button type="button" onClick={()=>void openProfile(employee)}>Bearbeiten</button></td>
          </tr>)}</tbody>
        </table>
      </div>
      {selected&&<aside className={editMode?'employee-profile edit-mode':'employee-profile'}>
        <div className="employee-profile-summary">
          <div className="employee-avatar">{(selected.first_name||selected.name||'M').charAt(0)}{(selected.last_name||'').charAt(0)}</div>
          <div><h2>{selected.name}</h2><span className="employee-online">● Aktiv</span><p>{selected.position||selected.title||'Funktion nicht erfasst'} · {selected.employee_number||'Keine Personal-Nr.'}</p></div>
          {hasPermission('employees:write')&&<button type="button" className="employee-edit-button" onClick={()=>setEditMode(v=>!v)}>{editMode?'Schließen':'Bearbeiten'}</button>}
        </div>
        {hasPermission('employees:write')?<form onSubmit={update}>
          <label>Name<input required value={form.name||''} onChange={e=>setForm({...form,name:e.target.value})}/></label>
          <label>E-Mail<input required type="email" value={form.email||''} onChange={e=>setForm({...form,email:e.target.value})}/></label>
          <label>Personalnummer<input value={form.employee_number||''} onChange={e=>setForm({...form,employee_number:e.target.value})}/></label>
          <label>Vorname<input value={form.first_name||''} onChange={e=>setForm({...form,first_name:e.target.value})}/></label>
          <label>Nachname<input value={form.last_name||''} onChange={e=>setForm({...form,last_name:e.target.value})}/></label>
          <label>Telefon<input value={form.phone||''} onChange={e=>setForm({...form,phone:e.target.value})}/></label>
          <label>Mobil<input value={form.mobile||''} onChange={e=>setForm({...form,mobile:e.target.value})}/></label>
          <label>Geburtsdatum<input type="date" value={form.date_of_birth?.slice(0,10)||''} onChange={e=>setForm({...form,date_of_birth:e.target.value||null})}/></label>
          <label>Abteilung<input value={form.department||''} onChange={e=>setForm({...form,department:e.target.value})}/></label>
          <label>Position<input value={form.position||''} onChange={e=>setForm({...form,position:e.target.value})}/></label>
          <label>Standort<input value={form.work_location||''} onChange={e=>setForm({...form,work_location:e.target.value})}/></label>
          <label>Beschäftigungsstatus<select value={form.employment_status} onChange={e=>setForm({...form,employment_status:e.target.value})}><option value="active">Aktiv</option><option value="probation">Probezeit</option><option value="leave">Abwesend</option><option value="terminated">Ausgetreten</option><option value="archived">Archiviert</option></select></label>
          <label>Beschäftigungsart<select value={form.employment_type} onChange={e=>setForm({...form,employment_type:e.target.value})}><option value="employee">Angestellt</option><option value="temporary">Zeitarbeit</option><option value="contractor">Werkvertrag</option><option value="intern">Praktikum</option><option value="apprentice">Ausbildung</option><option value="freelancer">Freiberuflich</option></select></label>
          <label>Wöchentliche Stunden<input type="number" min="0" max="168" step="0.25" value={form.weekly_hours??''} onChange={e=>setForm({...form,weekly_hours:e.target.value===''?null:Number(e.target.value)})}/></label>
          <label>Eintritt<input type="date" value={form.hire_date?.slice(0,10)||''} onChange={e=>setForm({...form,hire_date:e.target.value||null})}/></label>
          <label>Austritt<input type="date" value={form.termination_date?.slice(0,10)||''} onChange={e=>setForm({...form,termination_date:e.target.value||null})}/></label>
          <label>Benutzerkonto-ID<input value={form.user_id||''} onChange={e=>setForm({...form,user_id:e.target.value||null})}/></label>
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
          <form className="employee-subform" onSubmit={createAvailability}>
            <h3>Verfügbarkeit</h3>
            <label>Wochentag<select value={availabilityForm.weekday} onChange={e=>setAvailabilityForm({...availabilityForm,weekday:e.target.value})}><option value="1">Montag</option><option value="2">Dienstag</option><option value="3">Mittwoch</option><option value="4">Donnerstag</option><option value="5">Freitag</option><option value="6">Samstag</option><option value="0">Sonntag</option></select></label>
            <label>Von<input type="time" required value={availabilityForm.starts_time} onChange={e=>setAvailabilityForm({...availabilityForm,starts_time:e.target.value})}/></label>
            <label>Bis<input type="time" required value={availabilityForm.ends_time} onChange={e=>setAvailabilityForm({...availabilityForm,ends_time:e.target.value})}/></label>
            <label><input type="checkbox" checked={availabilityForm.available} onChange={e=>setAvailabilityForm({...availabilityForm,available:e.target.checked})}/> Verfügbar</label>
            <label>Gültig ab<input type="date" value={availabilityForm.valid_from} onChange={e=>setAvailabilityForm({...availabilityForm,valid_from:e.target.value})}/></label>
            <label>Gültig bis<input type="date" value={availabilityForm.valid_until} onChange={e=>setAvailabilityForm({...availabilityForm,valid_until:e.target.value})}/></label>
            <label>Hinweis<input value={availabilityForm.note} onChange={e=>setAvailabilityForm({...availabilityForm,note:e.target.value})}/></label>
            <label>Änderungsgrund<input required value={availabilityForm.reason} onChange={e=>setAvailabilityForm({...availabilityForm,reason:e.target.value})}/></label>
            <button>Verfügbarkeit speichern</button>
          </form>
        </>}
        {profile&&<div className="employee-data-cards">
          <article><h3>Verträge</h3>{profile.contracts.length?profile.contracts.map((row:any)=><p key={row.id}><strong>{row.contract_type}</strong><br/><small>{row.starts_on} bis {row.ends_on||'offen'} · {row.status}</small></p>):<p>Keine Verträge erfasst</p>}</article>
          <article><h3>Qualifikationen</h3>{profile.qualifications.length?profile.qualifications.map((row:any)=><p key={row.id}><strong>{row.catalog_name||row.code}</strong><br/><small>bis {row.valid_until||'unbefristet'} · {row.status}</small></p>):<p>Keine Qualifikationen erfasst</p>}</article>
          <article><h3>Objektzuweisungen</h3>{profile.object_assignments.length?profile.object_assignments.map((row:any)=><p key={row.id}><strong>{row.site_name}</strong><br/><small>{row.starts_on} bis {row.ends_on||'offen'} · {row.assignment_type}</small></p>):<p>Keine Objektzuweisungen</p>}</article>
          <article><h3>Abwesenheiten</h3>{profile.absences.length?profile.absences.map((row:any)=><p key={row.id}><strong>{row.absence_type}</strong>{row.status==='approved'||row.status==='requested'?<button type="button" onClick={()=>void cancelAbsence(row.id)}>Stornieren</button>:null}<br/><small>{row.starts_at?.slice(0,16)} bis {row.ends_at?.slice(0,16)} · {row.status}</small></p>):<p>Keine Abwesenheiten</p>}</article>
          <article><h3>Arbeitszeit</h3>{profile.work_time.length?profile.work_time.slice(0,8).map((row:any)=><p key={row.id}><strong>{row.status}</strong><br/><small>{row.started_at?.slice(0,16)} · {row.minutes??0} Min.</small></p>):<p>Keine Arbeitszeitdaten</p>}</article>
          <article><h3>Dokumente</h3>{profile.documents?.length?profile.documents.map((row:any)=><p key={row.id}><strong>{row.title}</strong><br/><small>{row.employee_document_category||'Sonstige'} · {row.document_status}</small></p>):<p>Keine Personalakten-Dokumente</p>}</article>
          <article><h3>Verfügbarkeit</h3>{profile.availability?.length?profile.availability.map((row:any)=><p key={row.id}><strong>Wochentag {row.weekday}</strong><br/><small>{row.starts_time}–{row.ends_time} · {row.available?'verfügbar':'gesperrt'}</small></p>):<p>Keine Verfügbarkeit erfasst</p>}</article>
        </div>}
      </aside>}
    </div>
    {profile&&<div className="employee-qualification-alerts">
      <div className="employee-section-title"><strong>Qualifikationswarnungen</strong><button type="button">Alle anzeigen</button></div>
      {profile.qualifications.length?<table><thead><tr><th>Mitarbeiter</th><th>Qualifikation</th><th>Ablaufdatum</th><th>Tage</th><th>Status</th></tr></thead><tbody>{profile.qualifications.map((qualification:any)=>{
        const validUntil=qualification.valid_until?new Date(`${qualification.valid_until}T23:59:59`):null;
        const days=validUntil?Math.ceil((validUntil.getTime()-Date.now())/86400000):null;
        const status=days!==null&&days<0?'abgelaufen':days!==null&&days<=30?'läuft bald ab':qualification.status==='valid'?'gültig':'prüfen';
        return <tr key={qualification.id}><td>{selected?.name}</td><td>{qualification.catalog_name||qualification.code}</td><td>{qualification.valid_until||'unbefristet'}</td><td>{days===null?'—':days}</td><td><span className={`qualification-status ${status==='abgelaufen'?'expired':status==='läuft bald ab'?'warning':'ok'}`}>{status}</span></td></tr>;
      })}</tbody></table>:<p className="employee-empty">Keine Qualifikationswarnungen für diesen Mitarbeiter.</p>}
    </div>}
  </section>;
}
