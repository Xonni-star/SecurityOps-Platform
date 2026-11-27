import {FormEvent,useEffect,useState} from 'react';
import {useNavigate,useParams,useSearchParams} from 'react-router-dom';
import {api,csrf,hasPermission} from '../lib/api';
import type {ApiError} from '../lib/api';
import {formatDate,formatDateTime,formatNumber} from '../lib/format';
import {roleLabel,statusLabel} from '../lib/status';

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

/** Exactly the fields accepted by PATCH /employees/:id/profile. Never send the full profile row. */
type ProfilePayload={
  name:string;email:string;title:string|null;employee_number:string|null;first_name:string|null;
  last_name:string|null;phone:string|null;mobile:string|null;address:string|null;
  date_of_birth:string|null;hire_date:string|null;termination_date:string|null;
  employment_status:string;employment_type:string;department:string|null;position:string|null;
  work_location:string|null;weekly_hours:number|null;user_id:string|null;reason:string;
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
type CatalogOption={id:string;code:string;name:string;default_validity_days:number|null;required:boolean;required_document_type:string|null;active:boolean};
type QualificationForm={catalog_id:string;valid_from:string;valid_until:string;document_id:string;issuing_authority:string;notes:string;reason:string};

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
  const [searchParams,setSearchParams]=useSearchParams();
  const {employeeId,section}=useParams<{employeeId:string;section?:string}>();
  const [profile,setProfile]=useState<Profile|null>(null);
  const [form,setForm]=useState<Employee|null>(null);
  const [reason,setReason]=useState('');
  const [error,setError]=useState('');
  const [submitError,setSubmitError]=useState('');
  const [fieldErrors,setFieldErrors]=useState<Record<string,string>>({});
  const [saving,setSaving]=useState(false);
  const [saved,setSaved]=useState(false);
  const [qualificationCatalog,setQualificationCatalog]=useState<CatalogOption[]>([]);
  const [qualificationForm,setQualificationForm]=useState<QualificationForm>({catalog_id:'',valid_from:'',valid_until:'',document_id:'',issuing_authority:'',notes:'',reason:''});
  const [editingQualification,setEditingQualification]=useState<string|null>(null);
  const [qualificationAction,setQualificationAction]=useState<{id:string;type:'revoke'|'remove'}|null>(null);
  const [qualificationReason,setQualificationReason]=useState('');
  const [qualificationError,setQualificationError]=useState('');
  const [qualificationNotice,setQualificationNotice]=useState('');
  const [evidenceReason,setEvidenceReason]=useState('');
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

  useEffect(()=>{
    if(!hasPermission('qualifications:read'))return;
    let current=true;
    void Promise.resolve(api<CatalogOption[]>('/qualifications/catalog'))
      .then(value=>{if(current)setQualificationCatalog(Array.isArray(value)?value:[]);})
      .catch(()=>{if(current)setQualificationCatalog([]);});
    return ()=>{current=false;};
  },[employeeId]);

  const updateField=(patch:Partial<Employee>)=>{
    setForm(current=>current?{...current,...patch}:current);
    setSaved(false);
    setFieldErrors(current=>{
      const next={...current};
      for(const key of Object.keys(patch))delete next[key];
      return next;
    });
  };

  const saveProfile=async(event:FormEvent)=>{
    event.preventDefault();
    if(!employeeId||!form||saving)return;
    const errors:Record<string,string>={};
    if(!form.name.trim())errors.name='Bitte einen Namen angeben.';
    if(!form.email.trim()||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim()))errors.email='Bitte eine gültige E-Mail-Adresse angeben.';
    if(!reason.trim())errors.reason='Bitte einen Änderungsgrund angeben.';
    if(form.hire_date&&form.termination_date&&form.termination_date<form.hire_date)errors.termination_date='Der Austritt darf nicht vor dem Eintritt liegen.';
    if(form.weekly_hours!==null&&form.weekly_hours!==undefined&&(form.weekly_hours<0||form.weekly_hours>168))errors.weekly_hours='Bitte 0 bis 168 Stunden angeben.';
    if(form.user_id&&!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(form.user_id))errors.user_id='Bitte eine gültige Benutzerkennung im UUID-Format angeben.';
    if(Object.keys(errors).length){
      setFieldErrors(errors);setSubmitError('Bitte die markierten Felder prüfen.');setSaved(false);return;
    }
    const payload:ProfilePayload={
      name:form.name.trim(),email:form.email.trim(),title:form.title??null,
      employee_number:form.employee_number||null,first_name:form.first_name||null,last_name:form.last_name||null,
      phone:form.phone||null,mobile:form.mobile||null,address:form.address||null,
      date_of_birth:form.date_of_birth||null,hire_date:form.hire_date||null,termination_date:form.termination_date||null,
      employment_status:form.employment_status,employment_type:form.employment_type,
      department:form.department||null,position:form.position||null,work_location:form.work_location||null,
      weekly_hours:form.weekly_hours??null,user_id:form.user_id||null,reason:reason.trim(),
    };
    setSaving(true);setSubmitError('');setFieldErrors({});setSaved(false);
    try{
      await api(`/employees/${employeeId}/profile`,{method:'PATCH',body:JSON.stringify(payload)});
      setReason('');
      await load();
      setSaved(true);
    }catch(e){
      const failure=e as ApiError;
      setSubmitError(failure instanceof Error&&failure.message?failure.message:'Stammdaten konnten nicht gespeichert werden.');
      if(failure?.fields&&typeof failure.fields==='object')setFieldErrors(failure.fields);
    }finally{setSaving(false);}
  };

  if(!profile){
    return <section className="employee-detail-page"><button type="button" className="employee-back" onClick={()=>navigate('/employees')}>Zurück zur Übersicht</button>{error&&<p role="alert" className="error">{error}</p>}<p>Mitarbeiterdaten werden geladen …</p></section>;
  }

  const employee=profile.employee;
  const employmentStatusLabel=statusLabel(employee.employment_status,'employment');

  const qualificationId=searchParams.get('qualification');
  const documentId=searchParams.get('document');
  const focusedQualification=qualificationId?profile.qualifications.find((item:any)=>item.id===qualificationId):undefined;
  const focusedDocument=documentId?profile.documents.find((item:any)=>item.id===documentId):undefined;
  const clearFocus=()=>{const next=new URLSearchParams(searchParams);next.delete('qualification');next.delete('document');setSearchParams(next,{replace:true});};
  const downloadEvidence=async(document:any,version:any)=>{
    try{
      const response=await fetch(`/api/v1/dms/documents/${document.id}/versions/${version.id}/download`,{credentials:'include',headers:{'x-csrf-token':csrf()}});
      if(!response.ok)throw new Error((await response.json()).error||'Der Download konnte nicht abgeschlossen werden.');
      const blob=await response.blob();const url=URL.createObjectURL(blob);const link=window.document.createElement('a');
      link.href=url;link.download=`${document.title||'nachweis'}-v${version.version_no}`;link.click();URL.revokeObjectURL(url);
    }catch(e){setError((e as Error).message);}
  };
  const qualificationStatus=(item:any)=>item.status_label||statusLabel(item.computed_status??item.status,'qualification');
  const qualificationFormFor=(item?:any):QualificationForm=>({
    catalog_id:item?.catalog_id??'',valid_from:(item?.valid_from??'').slice(0,10),valid_until:(item?.valid_until??'').slice(0,10),
    document_id:item?.document_id??'',issuing_authority:item?.issuing_authority??'',notes:item?.notes??'',reason:'',
  });
  const saveQualification=async(event:FormEvent)=>{
    event.preventDefault();
    if(!employeeId||!hasPermission('qualifications:write'))return;
    if(!qualificationForm.catalog_id){setQualificationError('Bitte eine Qualifikation aus dem Katalog auswählen.');return;}
    if(!qualificationForm.reason.trim()){setQualificationError('Bitte eine Begründung angeben.');return;}
    const body:Record<string,unknown>={catalog_id:qualificationForm.catalog_id,
      valid_from:qualificationForm.valid_from||null,
      issuing_authority:qualificationForm.issuing_authority.trim()||null,
      notes:qualificationForm.notes.trim()||null,
      reason:qualificationForm.reason.trim()};
    if(qualificationForm.valid_until)body.valid_until=qualificationForm.valid_until;
    if(qualificationForm.document_id&&/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(qualificationForm.document_id))body.document_id=qualificationForm.document_id;
    try{
      await api(editingQualification
        ?`/employees/${employeeId}/qualifications/${editingQualification}`
        :`/employees/${employeeId}/qualifications`,
        {method:editingQualification?'PATCH':'POST',body:JSON.stringify(body)});
      setQualificationForm(qualificationFormFor());setEditingQualification(null);
      setQualificationError('');setQualificationNotice(editingQualification?'Die Qualifikation wurde geändert.':'Die Qualifikation wurde zugewiesen.');
      await load();
    }catch(e){setQualificationError((e as Error).message);}
  };
  const runQualificationAction=async()=>{
    if(!employeeId||!qualificationAction||!qualificationReason.trim()){setQualificationError('Bitte eine Begründung angeben.');return;}
    try{
      const {id,type}=qualificationAction;
      if(type==='revoke'&&hasPermission('qualifications:revoke')){
        await api(`/employees/${employeeId}/qualifications/${id}/revoke`,{method:'POST',body:JSON.stringify({reason:qualificationReason.trim()})});
      }else if(type==='remove'&&hasPermission('qualifications:write')){
        await api(`/employees/${employeeId}/qualifications/${id}`,{method:'DELETE',body:JSON.stringify({reason:qualificationReason.trim()})});
      }else return;
      setQualificationAction(null);setQualificationReason('');setQualificationError('');
      setQualificationNotice(type==='revoke'?'Die Qualifikation wurde widerrufen.':'Die Qualifikation wurde entfernt.');
      await load();
    }catch(e){setQualificationError((e as Error).message);}
  };
  const openQualificationEvidence=async(item:any)=>{
    if(!evidenceReason.trim()){setQualificationError('Bitte eine Begründung für den Nachweiszugriff angeben.');return;}
    setQualificationError('');
    if(hasPermission('qualifications:documents:read')){
      try{await api(`/qualifications/assignments/${item.id}/document`);}catch(e){setQualificationError((e as Error).message);return;}
    }
    const next=new URLSearchParams(searchParams);
    next.set('qualification',item.id);next.set('grund',evidenceReason.trim());
    setSearchParams(next,{replace:true});
  };
  const renderQualifications=()=>{
    if(!hasPermission('qualifications:read'))return <p>Keine Berechtigung für Qualifikationsdaten.</p>;
    const canWrite=hasPermission('qualifications:write');
    const canRevoke=hasPermission('qualifications:revoke');
    return <article className="employee-detail-table">
      <h3>Qualifikationen</h3>
      {qualificationError&&<p role="alert" className="error">{qualificationError}</p>}
      {qualificationNotice&&<p role="status" className="employee-save-success">{qualificationNotice}</p>}
      {profile.qualifications.length===0?<p className="employee-empty">Keine Qualifikationen erfasst.</p>:<table aria-label="Qualifikationen">
        <thead><tr><th>Qualifikation</th><th>Kategorie</th><th>Gültig ab</th><th>Gültig bis</th><th>Status</th><th>Nachweis</th><th>Aktionen</th></tr></thead>
        <tbody>{profile.qualifications.map((item:any)=><tr key={item.id} className={item.id===qualificationId?'object-record-highlight':''}>
          <td>{item.catalog_name||item.qualification_name||item.code}</td>
          <td>{item.category||'–'}</td>
          <td>{formatDate(item.valid_from)}</td>
          <td>{item.valid_until?formatDate(item.valid_until):'Unbefristet'}</td>
          <td><span className={`qualification-status ${item.computed_status??item.status}`}>{qualificationStatus(item)}</span>{item.days_until_expiry!=null?` · ${item.days_until_expiry} Tage`:''}</td>
          <td>{item.document_title||'Kein Nachweis verknüpft'}</td>
          <td>
            {canWrite&&<button type="button" onClick={()=>{setEditingQualification(item.id);setQualificationForm(qualificationFormFor(item));setQualificationError('');}}>Bearbeiten</button>}
            {hasPermission('qualifications:documents:read')&&<button type="button" onClick={()=>void openQualificationEvidence(item)}>Nachweis öffnen</button>}
            {canRevoke&&<button type="button" onClick={()=>{setQualificationAction({id:item.id,type:'revoke'});setQualificationReason('');}}>Widerruf einleiten</button>}
            {canWrite&&<button type="button" onClick={()=>{setQualificationAction({id:item.id,type:'remove'});setQualificationReason('');}}>Entfernen</button>}
          </td>
        </tr>)}</tbody>
      </table>}
      {qualificationAction&&<form onSubmit={event=>{event.preventDefault();void runQualificationAction();}} aria-label={qualificationAction.type==='revoke'?'Qualifikation widerrufen':'Qualifikation entfernen'}>
        <h4>{qualificationAction.type==='revoke'?'Qualifikation widerrufen':'Qualifikation entfernen'}</h4>
        <label>{qualificationAction.type==='revoke'?'Begründung für den Widerruf':'Begründung für das Entfernen'}<input required value={qualificationReason} onChange={event=>setQualificationReason(event.target.value)}/></label>
        <button type="submit">{qualificationAction.type==='revoke'?'Widerruf bestätigen':'Entfernung bestätigen'}</button>
        <button type="button" onClick={()=>{setQualificationAction(null);setQualificationReason('');}}>Abbrechen</button>
      </form>}
      {hasPermission('qualifications:documents:read')&&<label>Begründung für den Nachweiszugriff<input value={evidenceReason} onChange={event=>setEvidenceReason(event.target.value)} placeholder="Grund für das Öffnen des Nachweises"/></label>}
      {canWrite&&<form className="employee-detail-form" onSubmit={saveQualification} aria-label={editingQualification?'Qualifikation bearbeiten':'Qualifikation zuweisen'}>
        <h4>{editingQualification?'Qualifikation bearbeiten':'Neue Qualifikation zuweisen'}</h4>
        <label>Katalogqualifikation<select required value={qualificationForm.catalog_id} onChange={event=>setQualificationForm({...qualificationForm,catalog_id:event.target.value})}><option value="">Bitte wählen</option>{qualificationCatalog.filter(entry=>entry.active||entry.id===qualificationForm.catalog_id).map(entry=><option key={entry.id} value={entry.id}>{entry.name} ({entry.code})</option>)}</select></label>
        <label>Gültig ab<input type="date" value={qualificationForm.valid_from} onChange={event=>setQualificationForm({...qualificationForm,valid_from:event.target.value})}/></label>
        <label>Gültig bis<input type="date" value={qualificationForm.valid_until} onChange={event=>setQualificationForm({...qualificationForm,valid_until:event.target.value})}/></label>
        {(()=>{const selected=qualificationCatalog.find(entry=>entry.id===qualificationForm.catalog_id);return selected?.default_validity_days?<small>Leer lassen, um die Standardgültigkeit von {formatNumber(selected.default_validity_days)} Tagen anzuwenden.</small>:<small>Ohne Ablaufdatum wird die Standardgültigkeit des Katalogs angewendet, sofern hinterlegt.</small>;})()}
        <label>Nachweisdokument (UUID)<input value={qualificationForm.document_id} onChange={event=>setQualificationForm({...qualificationForm,document_id:event.target.value})}/></label>
        <label>Ausstellende Stelle<input value={qualificationForm.issuing_authority} onChange={event=>setQualificationForm({...qualificationForm,issuing_authority:event.target.value})}/></label>
        <label>Notizen<textarea value={qualificationForm.notes} onChange={event=>setQualificationForm({...qualificationForm,notes:event.target.value})}/></label>
        <label>Begründung für die Qualifikation<input required value={qualificationForm.reason} onChange={event=>setQualificationForm({...qualificationForm,reason:event.target.value})}/></label>
        <button type="submit">{editingQualification?'Änderung speichern':'Qualifikation zuweisen'}</button>
        {editingQualification&&<button type="button" onClick={()=>{setEditingQualification(null);setQualificationForm(qualificationFormFor());}}>Abbrechen</button>}
      </form>}
    </article>;
  };

  const focusPanel=(qualificationId||documentId)&&<section className="object-record-focus employee-record-focus" aria-label="Geöffneter Nachweis">
    <div>
      <span className="object-record-focus-label">Geöffneter Nachweis</span>
      {focusedQualification?<>
        <h3>{focusedQualification.catalog_name||focusedQualification.code||'Qualifikation'}</h3>
        <p>{focusedQualification.code||'Ohne Katalogkennung'} · {focusedQualification.status_label||statusLabel(focusedQualification.computed_status??focusedQualification.status,'qualification')}{focusedQualification.valid_until?` · gültig bis ${formatDate(focusedQualification.valid_until)}`:' · unbefristet'}</p>
      </>:qualificationId?<h3>Verknüpfte Qualifikation nicht mehr verfügbar</h3>:null}
      {documentId&&<p>{focusedDocument?<>Nachweisdokument: <strong>{focusedDocument.title}</strong> · {statusLabel(focusedDocument.document_status,'document')}{focusedDocument.versions?.some((version:any)=>version.lifecycle_state==='available')&&hasPermission('dms:read')&&<button type="button" onClick={()=>void downloadEvidence(focusedDocument,focusedDocument.versions.find((version:any)=>version.lifecycle_state==='available'))}>Nachweis herunterladen</button>}</>:hasPermission('dms:read')?<a href={`/dms?document=${documentId}`}>Nachweis im Dokumentenmanagement prüfen</a>:'Verknüpfter Nachweis ist nicht verfügbar.'}</p>}
    </div>
    <button type="button" onClick={clearFocus}>Fokus schließen</button>
  </section>;

  const renderOverview=()=><>
    <div className="employee-detail-kpis">
      <article><strong>{formatNumber(profile.contracts.length)}</strong><span>Verträge</span></article>
      <article><strong>{formatNumber(profile.qualifications.length)}</strong><span>Qualifikationen</span></article>
      <article><strong>{formatNumber(profile.object_assignments.length)}</strong><span>Objektzuweisungen</span></article>
      <article><strong>{formatNumber(profile.absences.length)}</strong><span>Abwesenheiten</span></article>
    </div>
    <div className="employee-detail-grid">
      <article><h3>Aktuelle Stammdaten</h3><dl><dt>Personalnummer</dt><dd>{employee.employee_number||'–'}</dd><dt>Abteilung</dt><dd>{employee.department||'–'}</dd><dt>Position</dt><dd>{employee.position||employee.title||'–'}</dd><dt>Wochenstunden</dt><dd>{employee.weekly_hours??'–'}</dd></dl></article>
      <article><h3>Nächste Qualifikationsdaten</h3>{profile.qualifications.length?profile.qualifications.slice(0,5).map((item:any)=><p key={item.id}><strong>{item.catalog_name||item.code}</strong><br/><small>{item.valid_until?formatDate(item.valid_until):'unbefristet'} · {item.status_label||statusLabel(item.computed_status??item.status,'qualification')}</small></p>):<p>Keine Qualifikationen erfasst.</p>}</article>
      <article><h3>Aktuelle Objektzuweisung</h3>{profile.object_assignments.length?profile.object_assignments.slice(0,5).map((item:any)=><p key={item.id}><strong>{item.site_name}</strong><br/><small>{formatDate(item.starts_on)} bis {item.ends_on?formatDate(item.ends_on):'offen'}</small></p>):<p>Keine Objektzuweisung erfasst.</p>}</article>
      <article><h3>Arbeitszeit</h3>{profile.work_time.length?profile.work_time.slice(0,5).map((item:any)=><p key={item.id}><strong>{statusLabel(item.status)}</strong><br/><small>{formatNumber(item.minutes??0)} Minuten</small></p>):<p>Keine Arbeitszeitdaten erfasst.</p>}</article>
    </div>
  </>;

  const fieldProps=(key:string)=>({'aria-invalid':Boolean(fieldErrors[key])});
  const errorFor=(key:string)=>fieldErrors[key]?<small className="field-error" role="alert">{fieldErrors[key]}</small>:null;

  const renderStammdaten=()=>{
    if(!hasPermission('employees:write'))return <p>Keine Schreibberechtigung für Stammdaten.</p>;
    if(!form)return <p>Stammdaten werden geladen …</p>;
    return <form className="employee-detail-form" onSubmit={saveProfile} noValidate>
      <p className="employee-edit-mode" role="status">Bearbeitungsmodus – Änderungen werden erst nach dem Speichern übernommen.</p>
      {submitError&&<p role="alert" className="error">{submitError}</p>}
      {saved&&<p role="status" className="employee-save-success">Stammdaten wurden gespeichert.</p>}
      <div className="form-grid">
        <label>Name<input required {...fieldProps('name')} value={form.name} onChange={event=>updateField({name:event.target.value})}/>{errorFor('name')}</label>
        <label>E-Mail<input required type="email" {...fieldProps('email')} value={form.email} onChange={event=>updateField({email:event.target.value})}/>{errorFor('email')}</label>
        <label>Titel<input {...fieldProps('title')} value={form.title||''} onChange={event=>updateField({title:event.target.value||null})}/>{errorFor('title')}</label>
        <label>Personalnummer<input {...fieldProps('employee_number')} value={form.employee_number||''} onChange={event=>updateField({employee_number:event.target.value||null})}/>{errorFor('employee_number')}</label>
        <label>Vorname<input {...fieldProps('first_name')} value={form.first_name||''} onChange={event=>updateField({first_name:event.target.value||null})}/>{errorFor('first_name')}</label>
        <label>Nachname<input {...fieldProps('last_name')} value={form.last_name||''} onChange={event=>updateField({last_name:event.target.value||null})}/>{errorFor('last_name')}</label>
        <label>Telefon<input {...fieldProps('phone')} value={form.phone||''} onChange={event=>updateField({phone:event.target.value||null})}/>{errorFor('phone')}</label>
        <label>Mobil<input {...fieldProps('mobile')} value={form.mobile||''} onChange={event=>updateField({mobile:event.target.value||null})}/>{errorFor('mobile')}</label>
        <label>Geburtsdatum<input type="date" {...fieldProps('date_of_birth')} value={form.date_of_birth?.slice(0,10)||''} onChange={event=>updateField({date_of_birth:event.target.value||null})}/>{errorFor('date_of_birth')}</label>
        <label>Standort<input {...fieldProps('work_location')} value={form.work_location||''} onChange={event=>updateField({work_location:event.target.value||null})}/>{errorFor('work_location')}</label>
        <label>Abteilung<input {...fieldProps('department')} value={form.department||''} onChange={event=>updateField({department:event.target.value||null})}/>{errorFor('department')}</label>
        <label>Position<input {...fieldProps('position')} value={form.position||''} onChange={event=>updateField({position:event.target.value||null})}/>{errorFor('position')}</label>
        <label>Beschäftigungsstatus<select {...fieldProps('employment_status')} value={form.employment_status} onChange={event=>updateField({employment_status:event.target.value})}><option value="active">Aktiv</option><option value="probation">In Probezeit</option><option value="leave">Beurlaubt</option><option value="terminated">Beendet</option><option value="archived">Archiviert</option></select>{errorFor('employment_status')}</label>
        <label>Beschäftigungsart<select {...fieldProps('employment_type')} value={form.employment_type} onChange={event=>updateField({employment_type:event.target.value})}><option value="employee">Angestellt</option><option value="temporary">Aushilfe</option><option value="contractor">Fremdpersonal</option><option value="intern">Praktikum</option><option value="apprentice">Ausbildung</option><option value="freelancer">Freiberuflich</option></select>{errorFor('employment_type')}</label>
        <label>Eintritt<input type="date" {...fieldProps('hire_date')} value={form.hire_date?.slice(0,10)||''} onChange={event=>updateField({hire_date:event.target.value||null})}/>{errorFor('hire_date')}</label>
        <label>Austritt<input type="date" {...fieldProps('termination_date')} value={form.termination_date?.slice(0,10)||''} onChange={event=>updateField({termination_date:event.target.value||null})}/>{errorFor('termination_date')}</label>
        <label>Wöchentliche Stunden<input type="number" min="0" max="168" step="0.25" {...fieldProps('weekly_hours')} value={form.weekly_hours??''} onChange={event=>updateField({weekly_hours:event.target.value===''?null:Number(event.target.value)})}/>{errorFor('weekly_hours')}</label>
        <label>Benutzerkennung (UUID)<input {...fieldProps('user_id')} placeholder="00000000-0000-4000-8000-000000000000" value={form.user_id||''} onChange={event=>updateField({user_id:event.target.value||null})}/>{errorFor('user_id')}</label>
        <label className="span-2">Adresse<textarea {...fieldProps('address')} value={form.address||''} onChange={event=>updateField({address:event.target.value||null})}/>{errorFor('address')}</label>
        <label className="span-2">Änderungsgrund<input required {...fieldProps('reason')} value={reason} onChange={event=>{setReason(event.target.value);setFieldErrors(current=>{const next={...current};delete next.reason;return next;});}}/>{errorFor('reason')}</label>
      </div>
      <div className="employee-detail-actions">
        <button type="submit" disabled={saving}>{saving?'Speichern …':'Stammdaten speichern'}</button>
        <button type="button" disabled={saving} onClick={()=>{setForm({...employee});setReason('');setFieldErrors({});setSubmitError('');setSaved(false);}}>Abbrechen</button>
      </div>
    </form>;
  };

  const simpleTable=(title:string,headers:string[],rows:(string|null|undefined)[][],rowClass?:(row:(string|null|undefined)[],index:number)=>string)=>{
    return <article className="employee-detail-table"><h3>{title}</h3><table><thead><tr>{headers.map(header=><th key={header}>{header}</th>)}</tr></thead><tbody>{rows.map((row,index)=><tr key={index} className={rowClass?.(row,index)}>{row.map((value,column)=><td key={column}>{value||'–'}</td>)}</tr>)}</tbody></table>{rows.length===0&&<p className="employee-empty">Keine Daten erfasst.</p>}</article>;
  };

  return <section className="employee-detail-page">
    <div className="employee-detail-header">
      <button type="button" className="employee-back" onClick={()=>navigate('/employees')}>Zur Mitarbeiterübersicht</button>
      <div className="employee-detail-title">
        <div className="employee-avatar">{(employee.first_name||employee.name||'M').charAt(0)}{(employee.last_name||'').charAt(0)}</div>
        <div><h1>{employee.name}</h1><p>{employee.employee_number||'Keine Personalnummer'} · {employee.position||employee.title||'Funktion nicht erfasst'}</p></div>
        <span className={`employee-status ${employee.employment_status}`}>{employmentStatusLabel}</span>
      </div>
      {hasPermission('employees:write')&&<button type="button" onClick={()=>navigate(`/employees/${employeeId}/stammdaten`)}>Bearbeiten</button>}
    </div>

    {focusPanel}

    <nav className="employee-tabs" aria-label="Mitarbeiterbereiche">
      {tabs.map(([key,label])=><button type="button" key={key} className={active===key?'active':''} onClick={()=>navigate(`/employees/${employeeId}/${key}`)}>{label}</button>)}
    </nav>

    <div className="employee-detail-content">
      {active==='uebersicht'&&renderOverview()}
      {active==='stammdaten'&&renderStammdaten()}
      {active==='qualifikationen'&&renderQualifications()}
      {active==='vertraege'&&simpleTable('Verträge',['Vertragsart','Status','Beginn','Ende'],profile.contracts.map((item:any)=>[statusLabel(item.contract_type,'employment'),statusLabel(item.status),formatDate(item.starts_on),formatDate(item.ends_on)]))}
      {active==='dokumente'&&simpleTable('Dokumente',['Titel','Kategorie','Status','Erstellt'],profile.documents.map((item:any)=>[item.title,statusLabel(item.employee_document_category,'documentCategory'),statusLabel(item.document_status,'document'),formatDate(item.created_at)]))}
      {active==='dienstplanung'&&simpleTable('Verfügbarkeit',['Wochentag','Von','Bis','Verfügbar'],profile.availability.map((item:any)=>[String(item.weekday),item.starts_time,item.ends_time,item.available?'Ja':'Nein']))}
      {active==='objektzuweisungen'&&simpleTable('Objektzuweisungen',['Objekt','Art','Funktion','Beginn','Ende'],profile.object_assignments.map((item:any)=>[item.site_name,item.assignment_type,item.role,item.starts_on,item.ends_on]))}
      {active==='abwesenheiten'&&simpleTable('Abwesenheiten',['Art','Von','Bis','Status'],profile.absences.map((item:any)=>[statusLabel(item.absence_type,'absence'),formatDate(item.starts_at),formatDate(item.ends_at),statusLabel(item.status,'absence')]))}
      {active==='arbeitszeiten'&&simpleTable('Arbeitszeiten',['Status','Beginn','Ende','Minuten'],profile.work_time.map((item:any)=>[statusLabel(item.status),formatDateTime(item.started_at),formatDateTime(item.ended_at),formatNumber(item.minutes??0)]))}
      {active==='konto'&&simpleTable('Benutzerkonto',['E-Mail','Rolle','Benutzerkennung'],[[employee.account_email||employee.email,roleLabel(employee.account_role),employee.user_id||'–']])}
    </div>
  </section>;
}
