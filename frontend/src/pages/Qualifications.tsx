import {FormEvent,useEffect,useState} from 'react';
import {Link} from 'react-router-dom';
import {api,csrf,hasPermission} from '../lib/api';
import {berlinToday,formatDate,formatDateTime,formatNumber} from '../lib/format';
import {statusLabel} from '../lib/status';
import {isUuid} from '../lib/validation';
import {requiredUuidMessage} from '../lib/text';

type ComputedStatus='valid'|'expiring'|'expired'|'not_yet_valid'|'revoked'|'invalid'|'missing_evidence'|'awaiting_review';
type ValidUntilSource='manual'|'catalog_default'|'unlimited';
type DmsDocumentOption={
  id:string;title:string;employee_id?:string|null;document_type?:string|null;
  approval_status?:string|null;document_status?:string|null;computed_status?:string|null;
  status_label?:string|null;valid_from?:string|null;valid_until?:string|null;
  versions?:{id:string;version_no:number;lifecycle_state:string}[];
};
type Catalog={
  id:string;code:string;name:string;description:string|null;category:string|null;
  default_validity_days:number|null;required:boolean;required_document_type:string|null;
  required_documents:string[];active:boolean;created_at?:string;updated_at?:string;
};
type Row={
  id:string;employee_id:string;employee_name:string;personnel_number:string;
  qualification_name:string;code:string;category:string;site_name:string|null;
  issued_on:string|null;valid_from:string|null;valid_until:string|null;
  valid_until_source?:ValidUntilSource|null;document_id?:string|null;
  computed_status:ComputedStatus;status_label:string;issue_code:string;
  days_until_expiry:number|null;remaining_validity:string;
  document_title:string|null;document_approval_status:string|null;document_status:string|null;
  catalog_id:string|null;notes:string|null;issued_authority?:string|null;
};
type HistoryEvent={event_type:string;details:Record<string,unknown>|null;created_at:string;actor_user_id:string|null};
type Detail=Row&{history:HistoryEvent[]};
type Analytics={
  kpi:{total:number;valid:number;expiring:number;expired:number;invalid_revoked:number;missing_evidence:number}|null;
  categories:{category:string;count:number}[];
  expiring_30_days:Row[];expiring_90_days:Row[];
  missing_required:{employee_id:string;employee:string;code:string;qualification_name:string}[];
  site_coverage:{site_id:string;site:string;qualification_name:string;qualified:number;requirement_count:number}[];
};
type Filters={
  q:string;employee_id:string;site_id:string;catalog_id:string;category:string;status:string;
  expires_from:string;expires_to:string;days:string;missing_evidence:boolean;
  sort:string;dir:'asc'|'desc';page:number;pageSize:number;
};
type EmployeeOption={id:string;name:string};
type SiteOption={id:string;name:string};
type ReminderSettings={reminder_days:number[];updated_at:string|null};
type ReminderHistory={
  qualification_id:string;days:number;due_date:string;event_key:string;channel:string;
  sent_at:string|null;event_type:string;title:string;body:string;delivery_status:string|null;last_error:string|null;
  code:string|null;qualification_name:string|null;employee_name:string|null;
};

const initialFilters:Filters={
  q:'',employee_id:'',site_id:'',catalog_id:'',category:'',status:'',
  expires_from:'',expires_to:'',days:'',missing_evidence:false,
  sort:'valid_until',dir:'asc',page:1,pageSize:25,
};
const statusOptions:[ComputedStatus,string][]=[
  ['valid','Gültig'],['expiring','Läuft bald ab'],['expired','Abgelaufen'],['not_yet_valid','Noch nicht gültig'],
  ['revoked','Widerrufen'],['invalid','Ungültig'],['missing_evidence','Nachweis fehlt'],['awaiting_review','Prüfung ausstehend'],
];
const sortOptions:[string,string][]=[
  ['employee','Mitarbeiter'],['personnel_number','Personalnummer'],['qualification','Qualifikation'],['code','Code'],
  ['category','Kategorie'],['issued_on','Ausstellungsdatum'],['valid_from','Gültig ab'],['valid_until','Gültig bis'],
  ['status','Status'],['document','Nachweis'],
];
const catalogCodePattern=/^[a-z0-9][a-z0-9_-]{1,79}$/;
const validUntilSourceLabels:Record<ValidUntilSource,string>={
  manual:'Manuell festgelegt',catalog_default:'Aus Katalogstandard',unlimited:'Unbefristet',
};

function overviewQuery(filters:Filters):string{
  const params=new URLSearchParams();
  const text:(keyof Filters)[]=['q','employee_id','site_id','catalog_id','category','status','expires_from','expires_to','days','sort'];
  for(const key of text){const value=String(filters[key]??'').trim();if(value)params.set(key,value);}
  if(filters.missing_evidence)params.set('missing_evidence','true');
  params.set('dir',filters.dir);
  params.set('page',String(filters.page));
  params.set('pageSize',String(filters.pageSize));
  return params.toString();
}

function parseReminderDays(value:string):number[]{
  const days=value.split(',').map(part=>Number(part.trim())).filter(Number.isInteger);
  return [...new Set(days)];
}

function statusText(row:Row|Detail):string{
  return row.status_label||statusLabel(row.computed_status,'qualification');
}

function validUntilSourceLabel(value:ValidUntilSource|null|undefined):string{
  return value?validUntilSourceLabels[value]??'':'';
}

function addDays(date:string,days:number):string{
  const [year,month,day]=date.split('-').map(Number);
  if(!year||!month||!day)return '';
  return new Date(Date.UTC(year,month-1,day)+days*86_400_000).toISOString().slice(0,10);
}

function validityPreviewText(validFrom:string,days:number|null|undefined):string{
  if(typeof days!=='number'||!Number.isInteger(days)){
    return 'Für diesen Katalog ist keine Standardgültigkeit hinterlegt; ohne Datum bleibt der Nachweis unbefristet.';
  }
  const base=validFrom||berlinToday();
  const preview=addDays(base,days);
  return preview
    ?`Vorschau Ablaufdatum: ${formatDate(preview)} (Standardgültigkeit ${formatNumber(days)} Tage ab ${formatDate(base)}).`
    :'Bitte ein gültiges Datum für „Gültig ab“ angeben, um die Standardgültigkeit vorherzusagen.';
}

function dmsDocumentLabel(document:DmsDocumentOption):string{
  const approval=document.approval_status==='approved'?'Freigegeben'
    :document.approval_status==='pending_approval'?'Freigabe ausstehend'
    :document.approval_status==='returned_for_revision'?'Zur Überarbeitung zurückgegeben'
    :document.approval_status?statusLabel(document.approval_status,'document')
    :document.status_label??statusLabel(document.document_status??document.computed_status??'','document');
  const validity=document.valid_until?`gültig bis ${formatDate(document.valid_until)}`
    :document.valid_from?`ab ${formatDate(document.valid_from)}`:'ohne Gültigkeitsdatum';
  const version=document.versions?.find(item=>item.lifecycle_state==='available')??document.versions?.[0];
  const versionText=version?`Fassung ${formatNumber(version.version_no)} · ${version.lifecycle_state}`:'Keine Fassung';
  return `${document.title} · ${document.document_type||'Ohne Dokumenttyp'} · ${approval} · ${validity} · ${versionText}`;
}

export function Qualifications(){
  const [filters,setFilters]=useState<Filters>(initialFilters);
  const [rows,setRows]=useState<Row[]>([]);
  const [total,setTotal]=useState(0);
  const [pages,setPages]=useState(1);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState('');
  const [success,setSuccess]=useState('');
  const [analytics,setAnalytics]=useState<Analytics|null>(null);
  const [analyticsLoading,setAnalyticsLoading]=useState(true);
  const [analyticsError,setAnalyticsError]=useState('');
  const [dmsDocuments,setDmsDocuments]=useState<DmsDocumentOption[]>([]);
  const [catalog,setCatalog]=useState<Catalog[]>([]);
  const [categories,setCategories]=useState<string[]>([]);
  const [employees,setEmployees]=useState<EmployeeOption[]>([]);
  const [sites,setSites]=useState<SiteOption[]>([]);
  const [detail,setDetail]=useState<Detail|null>(null);
  const [detailLoading,setDetailLoading]=useState(false);
  const [editForm,setEditForm]=useState({valid_from:'',valid_until:'',issuing_authority:'',notes:'',document_id:'',reason:''});
  const [editing,setEditing]=useState(false);
  const [revokeReason,setRevokeReason]=useState('');
  const [removeReason,setRemoveReason]=useState('');
  const [actionError,setActionError]=useState('');
  const [evidenceUrl,setEvidenceUrl]=useState<{title:string;download_url:string}|null>(null);
  const [catalogForm,setCatalogForm]=useState({id:'',code:'',name:'',description:'',category:'',default_validity_days:'',required:false,required_document_type:'',required_documents:'',active:true,reason:''});
  const [catalogError,setCatalogError]=useState('');
  const [reminderDays,setReminderDays]=useState('90,60,30,7');
  const [reminderReason,setReminderReason]=useState('');
  const [reminderHistory,setReminderHistory]=useState<ReminderHistory[]>([]);
  const [reminderUpdated,setReminderUpdated]=useState<string|null>(null);
  const [reminderError,setReminderError]=useState('');
  const [assignmentForm,setAssignmentForm]=useState({employeeId:'',code:'',valid_from:berlinToday(),valid_until:'',document_id:'',reason:''});
  const read=hasPermission('qualifications:read');
  const write=hasPermission('qualifications:write');
  const catalogWrite=hasPermission('qualifications:catalog:write');
  const canRevoke=hasPermission('qualifications:revoke');
  const canExport=hasPermission('qualifications:export');
  const canDownloadDocument=hasPermission('qualifications:documents:download');
  const canReadDms=hasPermission('dms:read');
  const remindersWrite=hasPermission('qualifications:reminders:write');

  const loadOverview=async()=>{
    if(!read)return;
    setLoading(true);
    try{
      const response=await fetch(`/api/v1/qualifications/overview?${overviewQuery(filters)}`,{credentials:'include'});
      if(!response.ok)throw new Error('Die Qualifikationsübersicht konnte nicht geladen werden.');
      const data=await response.json() as Row[];
      setRows(Array.isArray(data)?data:[]);
      setTotal(Number(response.headers.get('X-Total-Count')??(Array.isArray(data)?data.length:0))||0);
      setPages(Math.max(1,Number(response.headers.get('X-Page-Count')??1)||1));
      setError('');
    }catch(cause){setRows([]);setTotal(0);setPages(1);setError((cause as Error).message);}
    finally{setLoading(false);}
  };

  useEffect(()=>{
    if(!read)return;
    let current=true;
    void (async()=>{
      setLoading(true);
      try{
        const response=await fetch(`/api/v1/qualifications/overview?${overviewQuery(filters)}`,{credentials:'include'});
        if(!response.ok)throw new Error('Die Qualifikationsübersicht konnte nicht geladen werden.');
        const data=await response.json() as Row[];
        if(!current)return;
        setRows(Array.isArray(data)?data:[]);
        setTotal(Number(response.headers.get('X-Total-Count')??(Array.isArray(data)?data.length:0))||0);
        setPages(Math.max(1,Number(response.headers.get('X-Page-Count')??1)||1));
        setError('');
      }catch(cause){if(current){setRows([]);setTotal(0);setPages(1);setError((cause as Error).message);}}
      finally{if(current)setLoading(false);}
    })();
    return ()=>{current=false;};
  },[read,filters]);

  const loadAnalytics=async()=>{
    if(!read)return;
    setAnalyticsLoading(true);
    try{
      const stats=await api<Analytics>('/qualifications/analytics');
      setAnalytics(stats?.kpi?stats:null);
      setAnalyticsError('');
    }catch(cause){setAnalytics(null);setAnalyticsError((cause as Error).message||'Kennzahlen konnten nicht geladen werden.');}
    finally{setAnalyticsLoading(false);}
  };

  useEffect(()=>{void loadAnalytics();},[read]);

  useEffect(()=>{
    if(!read)return;
    let current=true;
    void Promise.all([
      Promise.resolve(api<Catalog[]>('/qualifications/catalog')).then(value=>Array.isArray(value)?value:[]).catch(()=>[]),
      Promise.resolve(api<string[]>('/qualifications/categories')).then(value=>Array.isArray(value)?value:[]).catch(()=>[]),
      Promise.resolve(api<EmployeeOption[]>('/employees')).then(value=>Array.isArray(value)?value:[]).catch(()=>[]),
      Promise.resolve(api<SiteOption[]>('/sites')).then(value=>Array.isArray(value)?value:[]).catch(()=>[]),
      Promise.resolve(api<ReminderSettings>('/qualifications/reminders')).catch(()=>null),
      Promise.resolve(api<ReminderHistory[]>('/qualifications/reminders/history')).then(value=>Array.isArray(value)?value:[]).catch(()=>[]),
      Promise.resolve(canReadDms?api<DmsDocumentOption[]>('/dms/documents').then(value=>Array.isArray(value)?value:[]).catch(()=>[]):[]),
    ]).then(([catalogRows,categoryRows,employeeRows,siteRows,reminders,history,documentRows])=>{
      if(!current)return;
      setCatalog(catalogRows);
      setCategories(categoryRows);
      setEmployees(employeeRows);
      setSites(siteRows);
      if(reminders?.reminder_days)setReminderDays(reminders.reminder_days.join(','));
      setReminderUpdated(reminders?.updated_at??null);
      setReminderHistory(history);
      setDmsDocuments(documentRows);
    });
    return ()=>{current=false;};
  },[read,canReadDms]);

  const updateFilter=<K extends keyof Filters>(key:K,value:Filters[K])=>setFilters(current=>({...current,[key]:value,page:key==='page'?Number(value):1}));
  const resetFilters=()=>{setFilters(initialFilters);setError('');setSuccess('');};
  const documentsForEmployee=(employeeId:string)=>dmsDocuments.filter(document=>!document.employee_id||!employeeId||document.employee_id===employeeId);
  const catalogFor=(catalogId:string|null|undefined,code:string)=>catalog.find(entry=>entry.id===catalogId)??catalog.find(entry=>entry.code===code);

  const openDetail=async(row:Row)=>{
    if(!read)return;
    setDetailLoading(true);setActionError('');setEvidenceUrl(null);setEditing(false);
    try{
      const data=await api<Detail>(`/qualifications/assignments/${row.id}`);
      setDetail(data??null);
      setEditForm({
        valid_from:(data?.valid_from??'').slice(0,10),valid_until:(data?.valid_until??'').slice(0,10),
        issuing_authority:data?.issued_authority??'',notes:data?.notes??'',document_id:data?.document_id??'',reason:'',
      });
    }catch(cause){setDetail(null);setActionError((cause as Error).message);}
    finally{setDetailLoading(false);}
  };

  const saveAssignmentEdit=async(event:FormEvent)=>{
    event.preventDefault();
    if(!detail||!write)return;
    if(!editForm.reason.trim()){setActionError('Bitte eine Begründung für die Änderung angeben.');return;}
    try{
      const body:Record<string,unknown>={catalog_id:detail.catalog_id??undefined,code:detail.code,
        valid_from:editForm.valid_from||null,issuing_authority:editForm.issuing_authority.trim()||null,
        notes:editForm.notes.trim()||null,reason:editForm.reason.trim()};
      if(editForm.valid_until)body.valid_until=editForm.valid_until;
      if(editForm.document_id)body.document_id=editForm.document_id;
      else if(detail.document_id||detail.document_title)body.document_id=null;
      await api(`/employees/${detail.employee_id}/qualifications/${detail.id}`,{method:'PATCH',body:JSON.stringify(body)});
      await openDetail(detail);await loadOverview();setEditing(false);setActionError('');setSuccess('Die Qualifikation wurde geändert.');
    }catch(cause){setActionError((cause as Error).message);}
  };

  const revoke=async()=>{
    if(!detail||!canRevoke)return;
    if(!revokeReason.trim()){setActionError('Bitte eine Begründung für den Widerruf angeben.');return;}
    try{
      await api(`/employees/${detail.employee_id}/qualifications/${detail.id}/revoke`,{method:'POST',body:JSON.stringify({reason:revokeReason.trim()})});
      setRevokeReason('');await openDetail(detail);await loadOverview();setActionError('');setSuccess('Die Qualifikation wurde widerrufen.');
    }catch(cause){setActionError((cause as Error).message);}
  };

  const remove=async()=>{
    if(!detail||!write)return;
    if(!removeReason.trim()){setActionError('Bitte eine Begründung für das Entfernen angeben.');return;}
    try{
      await api(`/employees/${detail.employee_id}/qualifications/${detail.id}`,{method:'DELETE',body:JSON.stringify({reason:removeReason.trim()})});
      setDetail(null);setRemoveReason('');await loadOverview();setActionError('');setSuccess('Die Qualifikation wurde revisionsfähig entfernt.');
    }catch(cause){setActionError((cause as Error).message);}
  };

  const openEvidence=async()=>{
    if(!detail||!canDownloadDocument)return;
    try{
      const result=await api<{document_id:string;title:string;download_url:string}>(`/qualifications/assignments/${detail.id}/document`);
      setEvidenceUrl(result??null);setActionError('');
    }catch(cause){setEvidenceUrl(null);setActionError((cause as Error).message);}
  };

  const downloadEvidence=async()=>{
    if(!detail||!evidenceUrl||!canDownloadDocument)return;
    try{
      const response=await fetch(`/api/v1${evidenceUrl.download_url}`,{credentials:'include',headers:{'x-csrf-token':csrf()}});
      if(!response.ok)throw new Error('Der Nachweis konnte nicht heruntergeladen werden.');
      const blob=await response.blob();const href=URL.createObjectURL(blob);const link=document.createElement('a');
      link.href=href;link.download=evidenceUrl.title||'nachweis';document.body.appendChild(link);link.click();link.remove();URL.revokeObjectURL(href);
      setActionError('');
    }catch(cause){setActionError((cause as Error).message);}
  };

  const exportCsv=()=>{
    if(!canExport)return;
    const link=document.createElement('a');
    link.href=`/api/v1/qualifications/export?${overviewQuery(filters)}`;
    link.download=`qualifikationen-${berlinToday()}.csv`;
    document.body.appendChild(link);link.click();link.remove();
  };

  const startCatalogEdit=(entry:Catalog)=>{
    setCatalogForm({id:entry.id,code:entry.code,name:entry.name,description:entry.description??'',category:entry.category??'',
      default_validity_days:entry.default_validity_days?String(entry.default_validity_days):'',required:entry.required,
      required_document_type:entry.required_document_type??'',required_documents:(entry.required_documents??[]).join(', '),
      active:entry.active,reason:''});
    setCatalogError('');
  };

  const saveCatalog=async(event:FormEvent)=>{
    event.preventDefault();
    if(!catalogWrite)return;
    const code=catalogForm.code.trim().toLowerCase();
    if(!catalogCodePattern.test(code)){setCatalogError('Der Code muss mit einem Kleinbuchstaben oder einer Ziffer beginnen und 2 bis 80 Zeichen enthalten.');return;}
    if(!catalogForm.name.trim()){setCatalogError('Bitte eine Bezeichnung angeben.');return;}
    if(!catalogForm.reason.trim()){setCatalogError('Bitte eine Begründung für die Katalogänderung angeben.');return;}
    const days=catalogForm.default_validity_days.trim()?Number(catalogForm.default_validity_days):null;
    if(days!==null&&(!Number.isInteger(days)||days<1)){setCatalogError('Die Standardgültigkeit muss eine positive ganze Zahl in Tagen sein.');return;}
    try{
      const body={
        ...(catalogForm.id?{}:{code}),name:catalogForm.name.trim(),description:catalogForm.description.trim()||null,
        category:catalogForm.category||null,default_validity_days:days,required:catalogForm.required,
        required_document_type:catalogForm.required_document_type.trim()||null,
        required_documents:catalogForm.required_documents.split(',').map(value=>value.trim()).filter(Boolean),
        active:catalogForm.active,reason:catalogForm.reason.trim(),
      };
      await api(catalogForm.id?`/qualifications/catalog/${catalogForm.id}`:'/qualifications/catalog',
        {method:catalogForm.id?'PATCH':'POST',body:JSON.stringify(body)});
      setCatalogForm({id:'',code:'',name:'',description:'',category:'',default_validity_days:'',required:false,required_document_type:'',required_documents:'',active:true,reason:''});
      setCatalogError('');setSuccess('Der Katalogeintrag wurde gespeichert.');
      const refreshed=await Promise.resolve(api<Catalog[]>('/qualifications/catalog'));
      setCatalog(Array.isArray(refreshed)?refreshed:[]);
    }catch(cause){setCatalogError((cause as Error).message);}
  };

  const deactivateCatalog=async(entry:Catalog)=>{
    if(!catalogWrite)return;
    if(!catalogForm.reason.trim()){setCatalogError('Bitte eine Begründung für die Deaktivierung angeben.');return;}
    try{
      await api(`/qualifications/catalog/${entry.id}`,{method:'PATCH',body:JSON.stringify({active:false,reason:catalogForm.reason.trim()})});
      const refreshed=await Promise.resolve(api<Catalog[]>('/qualifications/catalog'));
      setCatalog(Array.isArray(refreshed)?refreshed:[]);setCatalogError('');setSuccess('Der Katalogeintrag wurde deaktiviert.');
    }catch(cause){setCatalogError((cause as Error).message);}
  };

  const saveReminders=async(event:FormEvent)=>{
    event.preventDefault();
    if(!remindersWrite)return;
    const days=parseReminderDays(reminderDays);
    if(!days.length||days.length>8||days.some(day=>day<1||day>3650)){
      setReminderError('Bitte 1 bis 8 eindeutige Erinnerungstage zwischen 1 und 3650 angeben.');return;
    }
    if(!reminderReason.trim()){setReminderError('Bitte eine Begründung für die Erinnerungseinstellungen angeben.');return;}
    try{
      const result=await api<ReminderSettings>('/qualifications/reminders',{method:'PUT',body:JSON.stringify({reminder_days:days,reason:reminderReason.trim()})});
      if(result?.reminder_days)setReminderDays(result.reminder_days.join(','));
      setReminderReason('');setReminderError('');setSuccess('Die Erinnerungstage wurden gespeichert.');
      const history=await Promise.resolve(api<ReminderHistory[]>('/qualifications/reminders/history'));
      setReminderHistory(Array.isArray(history)?history:[]);
    }catch(cause){setReminderError((cause as Error).message);}
  };

  const assignQualification=async(event:FormEvent)=>{
    event.preventDefault();
    if(!write)return;
    if(!isUuid(assignmentForm.employeeId)){setError(requiredUuidMessage('Mitarbeiter','maskulin'));return;}
    if(!assignmentForm.code){setError('Bitte eine Qualifikation aus dem Katalog auswählen.');return;}
    if(!assignmentForm.reason.trim()){setError('Bitte eine Begründung für die Zuweisung angeben.');return;}
    try{
      const body:Record<string,unknown>={code:assignmentForm.code,valid_from:assignmentForm.valid_from||null,reason:assignmentForm.reason.trim()};
      if(assignmentForm.valid_until)body.valid_until=assignmentForm.valid_until;
      if(assignmentForm.document_id)body.document_id=assignmentForm.document_id;
      await api(`/employees/${assignmentForm.employeeId}/qualifications`,{method:'POST',body:JSON.stringify(body)});
      setAssignmentForm(current=>({...current,reason:''}));setError('');setSuccess('Die Qualifikation wurde erfasst.');
      await loadOverview();
    }catch(cause){setError((cause as Error).message);}
  };

  if(!read)return <section><h2>Qualifikationen</h2><p role="status">Keine Berechtigung für die Qualifikationsverwaltung.</p></section>;

  return <section className="qualifications-page">
    <h2>Qualifikationen</h2>
    <p>Zentrale Übersicht über Qualifikationen, Nachweise, Katalog und Erinnerungen.</p>
    {error&&<p role="alert">{error}</p>}
    {success&&<p role="status">{success}</p>}

    <section aria-label="Kennzahlen zur Qualifikationsverwaltung">
      <h3>Kennzahlen</h3>
      <div role="group" aria-label="Qualifikationskennzahlen">
        {([
          ['Gesamt',analytics?.kpi?.total,'qualification-total'],
          ['Gültig',analytics?.kpi?.valid,'qualification-valid'],
          ['Läuft bald ab',analytics?.kpi?.expiring,'qualification-expiring'],
          ['Abgelaufen',analytics?.kpi?.expired,'qualification-expired'],
          ['Ungültig oder widerrufen',analytics?.kpi?.invalid_revoked,'qualification-invalid'],
          ['Nachweis fehlt',analytics?.kpi?.missing_evidence,'qualification-missing'],
        ] as const).map(([label,value,key])=><article key={key} aria-label={label}><strong>{value===undefined?'–':formatNumber(value)}</strong><span>{label}</span></article>)}
      </div>
      {analyticsLoading&&<p role="status">Kennzahlen werden geladen …</p>}
      {analyticsError&&<p role="alert">Kennzahlen konnten nicht geladen werden: {analyticsError} <button type="button" onClick={()=>void loadAnalytics()}>Kennzahlen erneut laden</button></p>}
      {!analyticsLoading&&!analyticsError&&!analytics&&<p role="status">Keine Kennzahlen verfügbar.</p>}
      {Array.isArray(analytics?.site_coverage)&&<section aria-label="Objektabdeckung">
        <h4>Abdeckung nach Objekt</h4>
        {analytics.site_coverage.length===0?<p role="status">Keine Objektabdeckung erfasst.</p>:<table aria-label="Objektabdeckung">
          <thead><tr><th>Objekt</th><th>Qualifikation</th><th>Qualifiziert</th><th>Anforderungen</th></tr></thead>
          <tbody>{analytics.site_coverage.map((entry,index)=><tr key={`${entry.site_id}-${entry.qualification_name}-${index}`}>
            <td>{entry.site}</td><td>{entry.qualification_name}</td>
            <td>{formatNumber(entry.qualified)}</td><td>{formatNumber(entry.requirement_count)}</td>
          </tr>)}</tbody>
        </table>}
      </section>}
    </section>

    <section aria-label="Qualifikationsübersicht">
      <h3>Qualifikationsübersicht</h3>
      <form className="qualification-filters" onSubmit={event=>{event.preventDefault();updateFilter('page',1);}} aria-label="Qualifikationen filtern">
        <label>Suche<input value={filters.q} onChange={event=>updateFilter('q',event.target.value)} placeholder="Mitarbeiter, Personalnummer oder Qualifikation"/></label>
        <label>Mitarbeiter filtern<select value={filters.employee_id} onChange={event=>updateFilter('employee_id',event.target.value)}><option value="">Alle Mitarbeitenden</option>{employees.map(employee=><option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></label>
        <label>Objekt filtern<select value={filters.site_id} onChange={event=>updateFilter('site_id',event.target.value)}><option value="">Alle Objekte</option>{sites.map(site=><option key={site.id} value={site.id}>{site.name}</option>)}</select></label>
        <label>Katalogeintrag filtern<select value={filters.catalog_id} onChange={event=>updateFilter('catalog_id',event.target.value)}><option value="">Alle Katalogeinträge</option>{catalog.map(entry=><option key={entry.id} value={entry.id}>Katalogcode {entry.code}</option>)}</select></label>
        <label>Kategorie filtern<select value={filters.category} onChange={event=>updateFilter('category',event.target.value)}><option value="">Alle Kategorien</option>{categories.map(category=><option key={category} value={category}>{category}</option>)}</select></label>
        <label>Status filtern<select value={filters.status} onChange={event=>updateFilter('status',event.target.value)}><option value="">Alle Status</option>{statusOptions.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
        <label>Ablauf von<input type="date" value={filters.expires_from} onChange={event=>updateFilter('expires_from',event.target.value)}/></label>
        <label>Ablauf bis<input type="date" value={filters.expires_to} onChange={event=>updateFilter('expires_to',event.target.value)}/></label>
        <label>Tage bis Ablauf<input type="number" min="0" value={filters.days} onChange={event=>updateFilter('days',event.target.value)}/></label>
        <label><input type="checkbox" checked={filters.missing_evidence} onChange={event=>updateFilter('missing_evidence',event.target.checked)}/> Nachweis fehlt</label>
        <label>Sortieren nach<select value={filters.sort} onChange={event=>updateFilter('sort',event.target.value)}>{sortOptions.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
        <label>Sortierrichtung<select value={filters.dir} onChange={event=>updateFilter('dir',event.target.value as 'asc'|'desc')}><option value="asc">Aufsteigend</option><option value="desc">Absteigend</option></select></label>
        <label>Einträge pro Seite<select value={filters.pageSize} onChange={event=>updateFilter('pageSize',Number(event.target.value))}><option value={10}>10</option><option value={25}>25</option><option value={50}>50</option><option value={100}>100</option></select></label>
        <button type="submit">Filter anwenden</button><button type="button" onClick={resetFilters}>Filter zurücksetzen</button>
        {canExport&&<button type="button" onClick={exportCsv} aria-label="Qualifikationen als CSV exportieren">CSV exportieren</button>}
      </form>
      {loading&&<p role="status">Qualifikationen werden geladen …</p>}
      {!loading&&rows.length===0&&<p role="status">Keine Qualifikationen für die gewählten Filter vorhanden.</p>}
      {rows.length>0&&<table aria-label="Qualifikationsübersicht">
        <thead><tr><th>Mitarbeiter</th><th>Qualifikation</th><th>Kategorie</th><th>Objekt</th><th>Gültig bis</th><th>Restlaufzeit</th><th>Status</th><th>Aktionen</th></tr></thead>
        <tbody>{rows.map(row=><tr key={row.id}>
          <td>{row.employee_name}{row.personnel_number?` (${row.personnel_number})`:''}</td>
          <td>{row.qualification_name||row.code}<small>{row.code}</small></td>
          <td>{row.category}</td><td>{row.site_name||'–'}</td>
          <td>{row.valid_until?formatDate(row.valid_until):'Unbefristet'}{validUntilSourceLabel(row.valid_until_source)?<small>{validUntilSourceLabel(row.valid_until_source)}</small>:null}</td>
          <td>{row.remaining_validity}</td>
          <td><span className={`qualification-status ${row.computed_status}`}>{statusText(row)}</span></td>
          <td><button type="button" onClick={()=>void openDetail(row)} aria-label={`Details zu ${row.qualification_name||row.code} von ${row.employee_name}`}>Details anzeigen</button></td>
        </tr>)}</tbody>
      </table>}
      {total>0&&<p aria-live="polite">{formatNumber(total)} Einträge · Seite {formatNumber(filters.page)} von {formatNumber(pages)}</p>}
      <div role="group" aria-label="Seitennavigation">
        <button type="button" disabled={filters.page<=1} onClick={()=>updateFilter('page',filters.page-1)}>Zurück</button>
        <button type="button" disabled={filters.page>=pages} onClick={()=>updateFilter('page',filters.page+1)}>Weiter</button>
      </div>
    </section>

    {detailLoading&&<p role="status">Qualifikationsdetails werden geladen …</p>}
    {detail&&<section role="dialog" aria-modal="true" aria-label="Qualifikationsdetails" className="qualification-detail">
      <h3>Details: {detail.qualification_name||detail.code} · {detail.employee_name}</h3>
      <p>{statusText(detail)} · {detail.remaining_validity} · Nachweis: {detail.document_title||'Kein Nachweis verknüpft'}</p>
      <p>Gültig bis: {detail.valid_until?formatDate(detail.valid_until):'Unbefristet'}{validUntilSourceLabel(detail.valid_until_source)?` (Herkunft: ${validUntilSourceLabel(detail.valid_until_source)})`:''}</p>
      {actionError&&<p role="alert">{actionError}</p>}
      <h4>Verlauf</h4>
      {detail.history.length===0?<p role="status">Keine Änderungen protokolliert.</p>:<ul>{detail.history.map((event,index)=><li key={`${event.created_at}-${index}`}>{formatDateTime(event.created_at)} · {event.event_type}</li>)}</ul>}
      <div role="group" aria-label="Qualifikationsaktionen">
        {write&&<button type="button" onClick={()=>{setEditing(value=>!value);setActionError('');}}>Bearbeiten</button>}
        {canDownloadDocument&&<button type="button" onClick={()=>void openEvidence()}>Nachweis öffnen</button>}
        {evidenceUrl&&canDownloadDocument&&<button type="button" onClick={()=>void downloadEvidence()}>Nachweis herunterladen</button>}
        {canRevoke&&<button type="button" onClick={()=>void revoke()}>Widerrufen</button>}
        {write&&<button type="button" onClick={()=>void remove()}>Entfernen</button>}
        <button type="button" onClick={()=>setDetail(null)}>Schließen</button>
      </div>
      {canRevoke&&<label>Begründung für den Widerruf<input value={revokeReason} onChange={event=>setRevokeReason(event.target.value)} placeholder="Grund für den Widerruf"/></label>}
      {write&&<label>Begründung für das Entfernen<input value={removeReason} onChange={event=>setRemoveReason(event.target.value)} placeholder="Grund für das Entfernen"/></label>}
      {editing&&write&&<form onSubmit={saveAssignmentEdit} aria-label="Qualifikation bearbeiten">
        <h4>Qualifikation bearbeiten</h4>
        <label>Gültig ab bearbeiten<input type="date" value={editForm.valid_from} onChange={event=>setEditForm({...editForm,valid_from:event.target.value})}/></label>
        <label>Gültig bis bearbeiten<input type="date" aria-label="Gültig bis bearbeiten" value={editForm.valid_until} onChange={event=>setEditForm({...editForm,valid_until:event.target.value})}/><small>{validityPreviewText(editForm.valid_from,catalogFor(detail.catalog_id,detail.code)?.default_validity_days)}</small></label>
        <label>Ausstellende Stelle<input value={editForm.issuing_authority} onChange={event=>setEditForm({...editForm,issuing_authority:event.target.value})}/></label>
        <label>Nachweisdokument<select value={editForm.document_id} onChange={event=>setEditForm({...editForm,document_id:event.target.value})}><option value="">Kein Nachweis verknüpft</option>{documentsForEmployee(detail.employee_id).map(document=><option key={document.id} value={document.id}>{dmsDocumentLabel(document)}</option>)}</select></label>
        {detail.document_title&&<small>Aktuell verknüpft: {detail.document_title}</small>}
        <small>Neue Nachweise werden über das <Link to="/dms">Dokumentenmanagement</Link> hochgeladen.</small>
        <label>Notizen<textarea value={editForm.notes} onChange={event=>setEditForm({...editForm,notes:event.target.value})}/></label>
        <label>Begründung für die Änderung<input required value={editForm.reason} onChange={event=>setEditForm({...editForm,reason:event.target.value})}/></label>
        <button type="submit">Änderung speichern</button>
      </form>}
    </section>}

    <section aria-label="Katalogverwaltung">
      <h3>Qualifikationskatalog</h3>
      {catalog.length===0?<p role="status">Keine Katalogeinträge vorhanden.</p>:<table aria-label="Qualifikationskatalog">
        <thead><tr><th>Code</th><th>Bezeichnung</th><th>Kategorie</th><th>Standardgültigkeit</th><th>Pflicht</th><th>Dokumenttyp</th><th>Status</th><th>Aktionen</th></tr></thead>
        <tbody>{catalog.map(entry=><tr key={entry.id}>
          <td>{entry.code}</td><td>{entry.name}</td><td>{entry.category||'–'}</td>
          <td>{entry.default_validity_days?`${formatNumber(entry.default_validity_days)} Tage`:'Unbefristet'}</td>
          <td>{entry.required?' Ja':' Nein'}</td><td>{entry.required_document_type||'–'}</td>
          <td>{entry.active?'Aktiv':'Deaktiviert'}</td>
          <td>{catalogWrite&&<><button type="button" onClick={()=>startCatalogEdit(entry)}>Katalogeintrag bearbeiten</button>{entry.active&&<button type="button" onClick={()=>void deactivateCatalog(entry)}>Deaktivieren</button>}</>}</td>
        </tr>)}</tbody>
      </table>}
      {catalogError&&<p role="alert">{catalogError}</p>}
      {catalogWrite&&<form onSubmit={saveCatalog} aria-label="Katalogeintrag bearbeiten">
        <h4>{catalogForm.id?'Katalogeintrag bearbeiten':'Neuen Katalogeintrag anlegen'}</h4>
        <label>Code<input required value={catalogForm.code} onChange={event=>setCatalogForm({...catalogForm,code:event.target.value})} placeholder="zum Beispiel erste_hilfe"/></label>
        <label>Bezeichnung<input required value={catalogForm.name} onChange={event=>setCatalogForm({...catalogForm,name:event.target.value})}/></label>
        <label>Beschreibung<textarea value={catalogForm.description} onChange={event=>setCatalogForm({...catalogForm,description:event.target.value})}/></label>
        <label>Kategorie<select value={catalogForm.category} onChange={event=>setCatalogForm({...catalogForm,category:event.target.value})}><option value="">Ohne Kategorie</option>{categories.map(category=><option key={category} value={category}>{category}</option>)}</select></label>
        <label>Standardgültigkeit in Tagen<input type="number" min="1" value={catalogForm.default_validity_days} onChange={event=>setCatalogForm({...catalogForm,default_validity_days:event.target.value})}/></label>
        <label><input type="checkbox" checked={catalogForm.required} onChange={event=>setCatalogForm({...catalogForm,required:event.target.checked})}/> Pflichtqualifikation</label>
        <label>Erforderlicher Dokumenttyp<input value={catalogForm.required_document_type} onChange={event=>setCatalogForm({...catalogForm,required_document_type:event.target.value})}/></label>
        <label>Erforderliche Nachweise<input value={catalogForm.required_documents} onChange={event=>setCatalogForm({...catalogForm,required_documents:event.target.value})} placeholder="Mehrere Nachweise mit Komma trennen"/></label>
        <label><input type="checkbox" checked={catalogForm.active} onChange={event=>setCatalogForm({...catalogForm,active:event.target.checked})}/> Aktiv</label>
        <label>Begründung für die Katalogänderung<input value={catalogForm.reason} onChange={event=>setCatalogForm({...catalogForm,reason:event.target.value})} aria-invalid={Boolean(catalogError&&!catalogForm.reason.trim())}/></label>
        <button type="submit">Katalogeintrag speichern</button>
        {catalogForm.id&&<button type="button" onClick={()=>setCatalogForm({id:'',code:'',name:'',description:'',category:'',default_validity_days:'',required:false,required_document_type:'',required_documents:'',active:true,reason:''})}>Abbrechen</button>}
      </form>}
    </section>

    <section aria-label="Erinnerungen vor Ablauf">
      <h3>Erinnerungen vor Ablauf</h3>
      <p>Geben Sie zwischen 1 und 8 eindeutige Tage vor Ablauf an. Die Einstellungen werden revisionsfähig gespeichert.</p>
      {reminderUpdated&&<p>Zuletzt geändert: {formatDateTime(reminderUpdated)}</p>}
      {reminderError&&<p role="alert">{reminderError}</p>}
      {remindersWrite&&<form onSubmit={saveReminders}>
        <label>Erinnerungstage<input value={reminderDays} onChange={event=>setReminderDays(event.target.value)} placeholder="zum Beispiel 90,60,30,7"/></label>
        <label>Begründung für die Erinnerungseinstellungen<input required value={reminderReason} onChange={event=>setReminderReason(event.target.value)}/></label>
        <button type="submit">Erinnerungen speichern</button>
      </form>}
      <h4>Versandhistorie</h4>
      {reminderHistory.length===0?<p role="status">Keine Erinnerungen versendet.</p>:<table aria-label="Erinnerungshistorie">
        <thead><tr><th>Ereignis</th><th>Titel</th><th>Tage</th><th>Fällig am</th><th>Zustellung</th><th>Fehler</th></tr></thead>
        <tbody>{reminderHistory.map((item,index)=><tr key={`${item.event_key}-${index}`}>
          <td>{item.event_type}</td><td>{item.title}{item.employee_name?` · ${item.employee_name}`:''}</td>
          <td>{formatNumber(item.days)}</td><td>{item.due_date?formatDate(item.due_date):'–'}</td>
          <td>{item.delivery_status??'–'}{item.sent_at?` · ${formatDateTime(item.sent_at)}`:''}</td>
          <td>{item.last_error||'–'}</td>
        </tr>)}</tbody>
      </table>}
    </section>

    {write&&<form onSubmit={assignQualification} aria-label="Qualifikation einem Mitarbeiter zuweisen">
      <h3>Qualifikation eines Mitarbeiters</h3>
      <label>Mitarbeiter<select value={assignmentForm.employeeId} onChange={event=>setAssignmentForm({...assignmentForm,employeeId:event.target.value})}><option value="">Mitarbeiter auswählen</option>{employees.map(employee=><option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></label>
      <label>Qualifikation<select required value={assignmentForm.code} onChange={event=>setAssignmentForm({...assignmentForm,code:event.target.value})}><option value="">Bitte wählen</option>{catalog.filter(entry=>entry.active).map(entry=><option key={entry.id} value={entry.code}>{entry.name} ({entry.code})</option>)}</select></label>
      <label>Gültig ab<input type="date" value={assignmentForm.valid_from} onChange={event=>setAssignmentForm({...assignmentForm,valid_from:event.target.value})}/></label>
      <label>Gültig bis<input type="date" aria-label="Gültig bis" value={assignmentForm.valid_until} onChange={event=>setAssignmentForm({...assignmentForm,valid_until:event.target.value})}/><small>{validityPreviewText(assignmentForm.valid_from,catalogFor(null,assignmentForm.code)?.default_validity_days)}</small></label>
      <label>Nachweisdokument<select value={assignmentForm.document_id} onChange={event=>setAssignmentForm({...assignmentForm,document_id:event.target.value})}><option value="">Kein Nachweis verknüpft</option>{documentsForEmployee(assignmentForm.employeeId).map(document=><option key={document.id} value={document.id}>{dmsDocumentLabel(document)}</option>)}</select></label>
      <small>Neue Nachweise werden über das <Link to="/dms">Dokumentenmanagement</Link> hochgeladen.</small>
      <label>Begründung<input required value={assignmentForm.reason} onChange={event=>setAssignmentForm({...assignmentForm,reason:event.target.value})} placeholder="Grund für die Erfassung"/></label>
      <button type="submit">Qualifikation speichern</button>
    </form>}
  </section>;
}
