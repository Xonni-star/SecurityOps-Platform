import {FormEvent,useEffect,useState} from 'react';
import {useNavigate,useParams} from 'react-router-dom';
import {api,hasPermission} from '../lib/api';

type Employee={
  id:string;
  name:string;
  email:string;
  title?:string|null;
  employee_number?:string|null;
  first_name?:string|null;
  last_name?:string|null;
  phone?:string|null;
  mobile?:string|null;
  address?:string|null;
  date_of_birth?:string|null;
  hire_date?:string|null;
  termination_date?:string|null;
  employment_status:string;
  employment_type:string;
  department?:string|null;
  position?:string|null;
  work_location?:string|null;
  weekly_hours?:number|null;
  user_id?:string|null;
  account_email?:string|null;
  account_role?:string|null;
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

const tabs=[
  ['uebersicht','Übersicht'],
  ['stammdaten','Stammdaten'],
  ['qualifikationen','Qualifikationen'],
  ['vertraege','Verträge'],
  ['dokumente','Dokumente'],
  ['dienstplanung','Dienstplanung'],
  ['objektzuweisungen','Objektzuweisungen'],
  ['abwesenheiten','Abwesenheiten'],
  ['arbeitszeiten','Arbeitszeiten'],
  ['konto','Benutzerkonto & Berechtigungen'],
] as const;

export function EmployeeDetail(){
  const navigate=useNavigate();
  const {employeeId,section}=useParams<{employeeId:string;section?:string}>();
  const [profile,setProfile]=useState<Profile|null>(null);
  const [form,setForm]=useState<Employee|null>(null);
  const [reason,setReason]=useState('');
  const [error,setError]=useState('');
  const active=tabs.some(([key])=>key===section)?section:'uebersicht';

  const load=async()=>{
    if(!employeeId)return;
    try{
      const data=await api<Profile>(`/employees/${employeeId}/profile`);
      setProfile(data||null);
      if(data)setForm({...data.employee});
      setError('');
    }catch(e){setError((e as Error).message);}
  };

  useEffect(()=>{void load();},[employeeId]);

  const saveProfile=async(event:FormEvent)=>{
    event.preventDefault();
    if(!employeeId||!form)return;
    try{
      await api(`/employees/${employeeId}/profile`,{method:'PATCH',body:JSON.stringify({...form,reason:reason||'Mitarbeiterdaten aktualisiert'})});
      setReason('');
      await load();
    }catch(e){setError((e as Error).message);}
  };

  if(!profile){
    return <section className="employee-detail-page"><button type="button" className="employee-back" onClick={()=>navigate('/employees')}>Zurück zur Übersicht</button>{error&&<p role="alert" className="error">{error}</p>}<p>Mitarbeiter wird geladen.</p></section>;
  }

  const employee=profile.employee;
  const statusLabel=employee.employment_status==='active'?'Aktiv':employee.employment_status==='leave'?'Abwesenheit':employee.employment_status==='probation'?'Probezeit':employee.employment_status==='terminated'?'Ausgeschieden':'Archiviert';

  const renderOverview=()=><>
    <div className="employee-detail-kpis">
      <article><strong>{profile.contracts.length}</strong><span>Verträge</span></article>
      <article><strong>{profile.qualifications.length}</strong><span>Qualifikationen</span></article>
      <article><strong>{profile.object_assignments.length}</strong><span>Objektzuweisungen</span></article>
      <article><strong>{profile.absences.length}</strong><span>Abwesenheiten</span></article>
    </div>
    <div className="employee-detail-grid">
      <article><h3>Aktuelle Stammdaten</h3><dl><dt>Personalnummer</dt><dd>{employee.employee_number||'–'}</dd><dt>Abteilung</dt><dd>{employee.department||'–'}</dd><dt>Position</dt><dd>{employee.position||employee.title||'–'}</dd><dt>Wochenstunden</dt><dd>{employee.weekly_hours??'–'}</dd></dl></article>
      <article><h3>Nächste Qualifikationsdaten</h3>{profile.qualifications.length?profile.qualifications.slice(0,5).map((item:any)=><p key={item.id}><strong>{item.catalog_name||item.code}</strong><br/><small>{item.valid_until||'unbefristet'} · {item.status}</small></p>):<p>Keine Qualifikationen erfasst.</p>}</article>
      <article><h3>Aktuelle Objektzuweisung</h3>{profile.object_assignments.length?profile.object_assignments.slice(0,5).map((item:any)=><p key={item.id}><strong>{item.site_name}</strong><br/><small>{item.starts_on} bis {item.ends_on||'offen'}</small></p>):<p>Keine Objektzuweisung erfasst.</p>}</article>
      <article><h3>Arbeitszeit</h3>{profile.work_time.length?profile.work_time.slice(0,5).map((item:any)=><p key={item.id}><strong>{item.status}</strong><br/><small>{item.minutes??0} Minuten</small></p>):<p>Keine Arbeitszeitdaten erfasst.</p>}</article>
    </div>
  </>;

  const renderStammdaten=()=>hasPermission('employees:write')&&form?<form className="employee-detail-form" onSubmit={saveProfile}>
    <div className="form-grid">
      <label>Name<input required value={form.name} onChange={event=>setForm({...form,name:event.target.value})}/></label>
      <label>E-Mail<input required type="email" value={form.email} onChange={event=>setForm({...form,email:event.target.value})}/></label>
      <label>Personalnummer<input value={form.employee_number||''} onChange={event=>setForm({...form,employee_number:event.target.value||null})}/></label>
      <label>Vorname<input value={form.first_name||''} onChange={event=>setForm({...form,first_name:event.target.value||null})}/></label>
      <label>Nachname<input value={form.last_name||''} onChange={event=>setForm({...form,last_name:event.target.value||null})}/></label>
      <label>Telefon<input value={form.phone||''} onChange={event=>setForm({...form,phone:event.target.value||null})}/></label>
      <label>Mobil<input value={form.mobile||''} onChange={event=>setForm({...form,mobile:event.target.value||null})}/></label>
      <label>Geburtsdatum<input type="date" value={form.date_of_birth?.slice(0,10)||''} onChange={event=>setForm({...form,date_of_birth:event.target.value||null})}/></label>
      <label>Abteilung<input value={form.department||''} onChange={event=>setForm({...form,department:event.target.value||null})}/></label>
      <label>Position<input value={form.position||''} onChange={event=>setForm({...form,position:event.target.value||null})}/></label>
      <label>Standort<input value={form.work_location||''} onChange={event=>setForm({...form,work_location:event.target.value||null})}/></label>
      <label>Beschäftigungsstatus<select value={form.employment_status} onChange={event=>setForm({...form,employment_status:event.target.value})}><option value="active">Aktiv</option><option value="probation">Probezeit</option><option value="leave">Abwesenheit</option><option value="terminated">Ausgeschieden</option><option value="archived">Archiviert</option></select></label>
      <label>Beschäftigungsart<select value={form.employment_type} onChange={event=>setForm({...form,employment_type:event.target.value})}><option value="employee">Angestellt</option><option value="temporary">Zeitarbeit</option><option value="contractor">Werkvertrag</option><option value="intern">Praktikum</option><option value="apprentice">Ausbildung</option><option value="freelancer">Freiberuflich</option></select></label>
      <label>Eintritt<input type="date" value={form.hire_date?.slice(0,10)||''} onChange={event=>setForm({...form,hire_date:event.target.value||null})}/></label>
      <label>Austritt<input type="date" value={form.termination_date?.slice(0,10)||''} onChange={event=>setForm({...form,termination_date:event.target.value||null})}/></label>
      <label>Wöchentliche Stunden<input type="number" min="0" max="168" step="0.25" value={form.weekly_hours??''} onChange={event=>setForm({...form,weekly_hours:event.target.value===''?null:Number(event.target.value)})}/></label>
      <label>Benutzerkonto-ID<input value={form.user_id||''} onChange={event=>setForm({...form,user_id:event.target.value||null})}/></label>
      <label className="span-2">Adresse<textarea value={form.address||''} onChange={event=>setForm({...form,address:event.target.value||null})}/></label>
      <label className="span-2">Änderungsgrund<input required value={reason} onChange={event=>setReason(event.target.value)} /></label>
    </div>
    <button type="submit">Stammdaten speichern</button>
  </form>:<p>Keine Schreibberechtigung für Stammdaten.</p>;

  const simpleTable=(title:string,headers:string[],rows:(string|null|undefined)[][])=>{
    return <article className="employee-detail-table"><h3>{title}</h3><table><thead><tr>{headers.map(header=><th key={header}>{header}</th>)}</tr></thead><tbody>{rows.map((row,index)=><tr key={index}>{row.map((value,column)=><td key={column}>{value||'–'}</td>)}</tr>)}</tbody></table>{rows.length===0&&<p className="employee-empty">Keine Daten erfasst.</p>}</article>;
  };

  return <section className="employee-detail-page">
    <div className="employee-detail-header">
      <button type="button" className="employee-back" onClick={()=>navigate('/employees')}>Zur Mitarbeiterübersicht</button>
      <div className="employee-detail-title">
        <div className="employee-avatar">{(employee.first_name||employee.name||'M').charAt(0)}{(employee.last_name||'').charAt(0)}</div>
        <div><h1>{employee.name}</h1><p>{employee.employee_number||'Keine Personal-Nr.'} · {employee.position||employee.title||'Funktion nicht erfasst'}</p></div>
        <span className={`employee-status ${employee.employment_status}`}>{statusLabel}</span>
      </div>
      {hasPermission('employees:write')&&<button type="button" onClick={()=>navigate(`/employees/${employeeId}/stammdaten`)}>Bearbeiten</button>}
    </div>

    <nav className="employee-tabs" aria-label="Mitarbeiterbereiche">
      {tabs.map(([key,label])=><button type="button" key={key} className={active===key?'active':''} onClick={()=>navigate(`/employees/${employeeId}/${key}`)}>{label}</button>)}
    </nav>

    <div className="employee-detail-content">
      {active==='uebersicht'&&renderOverview()}
      {active==='stammdaten'&&renderStammdaten()}
      {active==='qualifikationen'&&simpleTable('Qualifikationen',['Qualifikation','Gültig ab','Gültig bis','Status'],profile.qualifications.map((item:any)=>[item.catalog_name||item.code,item.valid_from,item.valid_until,item.status]))}
      {active==='vertraege'&&simpleTable('Verträge',['Vertragsart','Status','Beginn','Ende'],profile.contracts.map((item:any)=>[item.contract_type,item.status,item.starts_on,item.ends_on]))}
      {active==='dokumente'&&simpleTable('Dokumente',['Titel','Kategorie','Status','Erstellt'],profile.documents.map((item:any)=>[item.title,item.employee_document_category,item.document_status,item.created_at]))}
      {active==='dienstplanung'&&simpleTable('Verfügbarkeit',['Wochentag','Von','Bis','Verfügbar'],profile.availability.map((item:any)=>[String(item.weekday),item.starts_time,item.ends_time,item.available?'Ja':'Nein']))}
      {active==='objektzuweisungen'&&simpleTable('Objektzuweisungen',['Objekt','Art','Funktion','Beginn','Ende'],profile.object_assignments.map((item:any)=>[item.site_name,item.assignment_type,item.role,item.starts_on,item.ends_on]))}
      {active==='abwesenheiten'&&simpleTable('Abwesenheiten',['Art','Von','Bis','Status'],profile.absences.map((item:any)=>[item.absence_type,item.starts_at,item.ends_at,item.status]))}
      {active==='arbeitszeiten'&&simpleTable('Arbeitszeiten',['Status','Beginn','Ende','Minuten'],profile.work_time.map((item:any)=>[item.status,item.started_at,item.ended_at,String(item.minutes??0)]))}
      {active==='konto'&&simpleTable('Benutzerkonto',['E-Mail','Rolle','Mitarbeiterkonto-ID'],[[employee.account_email||employee.email,employee.account_role||'–',employee.user_id||'–']])}
    </div>
  </section>;
}
