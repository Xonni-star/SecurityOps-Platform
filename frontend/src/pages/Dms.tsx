import {ChangeEvent,FormEvent,useEffect,useMemo,useRef,useState} from 'react';
import {useSearchParams} from 'react-router-dom';
import {api,csrf,hasPermission} from '../lib/api';
import {formatDate,formatDateTime,formatNumber} from '../lib/format';
import {statusLabel} from '../lib/status';
import {isUuid} from '../lib/validation';
import {requiredUuidMessage} from '../lib/text';
import {uuid} from '../lib/uuid';
import {Badge,EmptyState,ErrorState,LoadingSkeleton,Modal,Pagination,ResponsiveTable,Section} from '../components/operative/Common';

type Version={
  id:string;version_no:number;size_bytes:number;content_type:string;lifecycle_state:string;
  rejection_reason:string|null;created_at:string;scanned_at:string|null;retention_until:string|null;
  sha256?:string;uploaded_by?:string;
};
type DmsDocument={
  id:string;title:string;description:string|null;site_id:string|null;customer_id:string|null;
  employee_id:string|null;responsible_employee_id:string|null;document_number:string|null;document_type:string|null;
  document_status:string;approval_status:string;created_at:string;updated_at:string|null;
  valid_from:string|null;valid_until:string|null;review_on:string|null;approved_at:string|null;
  reviewed_at:string|null;approval_feedback:string|null;rejection_reason:string|null;
  versions:Version[];current_version:Version|null;site_name:string|null;customer_name:string|null;
  employee_name:string|null;responsible_employee_name:string|null;created_by_email:string|null;
  computed_status:string;status_label:string;expiry_bucket:string;days_until_expiry:number|null;
  review_state:string;has_available_version:boolean;is_approved:boolean;is_currently_valid:boolean;
  is_reviewed:boolean;scan_status:string;
};
type NamedOption={id:string;name:string};
type Stats={
  total:number;approved:number;draft:number;pending_approval:number;returned:number;archived:number;
  expired:number;expiring_30d:number;missing_file:number;scan_pending:number;quarantined:number;review_due:number;
};
type FilterOptions={sites:NamedOption[];customers:NamedOption[];employees:NamedOption[];responsible_employees:NamedOption[];types:string[];document_numbers:string[]};
type QueryResponse={rows:DmsDocument[];total:number;page:number;pages:number;page_size:number;stats:Stats;filter_options:FilterOptions};
type HistoryRow={id:string;event_type:string;entity_type:string|null;entity_id:string|null;details:Record<string,unknown>;created_at:string;actor_email:string|null};
type ApprovalRow={id:string;title:string;document_type:string|null;created_by_email:string|null;site_name:string|null;customer_name:string|null;created_at:string;current_version:Version|null;scan_status:string};

type Filters={
  q:string;site_id:string;customer_id:string;employee_id:string;document_type:string;document_number:string;
  approval_status:string;scan_status:string;validity:string;created_from:string;created_to:string;
  expiry_from:string;expiry_to:string;sort:string;order:string;page_size:string;include_deleted:boolean;
};

const emptyFilters:Filters={
  q:'',site_id:'',customer_id:'',employee_id:'',document_type:'',document_number:'',
  approval_status:'',scan_status:'',validity:'',created_from:'',created_to:'',expiry_from:'',expiry_to:'',
  sort:'created_at',order:'desc',page_size:'25',include_deleted:false,
};

const approvalLabels:Record<string,string>={
  draft:'Entwurf',pending_approval:'In Prüfung',approved:'Freigegeben',rejected:'Zurückgegeben',archived:'Archiviert',
};
const scanLabels:Record<string,string>={
  quarantined:'In Quarantäne',scanning:'Virenprüfung läuft',available:'Geprüft',rejected:'Abgelehnt',deleted:'Gelöscht',missing:'Keine Datei',
};
const validityLabels:Record<string,string>={
  valid:'Gültig',expiring:'Läuft bald ab',expired:'Abgelaufen',not_yet_valid:'Noch nicht gültig',undefined:'Ohne Ablaufdatum',
};

function toneForStatus(status:string):'good'|'warning'|'critical'|'info'|'neutral'{
  if(status==='gueltig')return 'good';
  if(status==='lauf_bald_ab'||status==='bald_pruefpflichtig')return 'warning';
  if(status==='abgelaufen'||status==='fehlend')return 'critical';
  if(status==='pruefung_ausstehend'||status==='nicht_freigegeben')return 'info';
  return 'neutral';
}
function toneForApproval(status:string):'good'|'warning'|'critical'|'info'|'neutral'{
  if(status==='approved')return 'good';
  if(status==='pending_approval')return 'warning';
  if(status==='rejected')return 'critical';
  if(status==='archived')return 'neutral';
  return 'info';
}
function toBase64(file:File,onProgress:(percent:number)=>void,signal?:AbortSignal){
  return new Promise<string>((resolve,reject)=>{
    const reader=new FileReader();
    reader.onprogress=event=>{
      if(signal?.aborted){reader.abort();return;}
      if(event.lengthComputable)onProgress(Math.round(event.loaded/event.total*90));
    };
    reader.onerror=()=>reject(reader.error??new Error('Die Datei konnte nicht gelesen werden.'));
    reader.onabort=()=>reject(new Error('Der Upload wurde abgebrochen.'));
    reader.onload=()=>{
      if(signal?.aborted){reject(new Error('Der Upload wurde abgebrochen.'));return;}
      onProgress(92);
      const value=String(reader.result).split(',')[1]??'';
      resolve(value);
    };
    reader.readAsDataURL(file);
  });
}
function queryString(filters:Filters,page:number){
  const params=new URLSearchParams();
  for(const [key,value] of Object.entries(filters)){
    if(value===''||value===false)continue;
    params.set(key,String(value));
  }
  params.set('page',String(page));
  return params.toString();
}

export function Dms(){
  const [searchParams,setSearchParams]=useSearchParams();
  const [filters,setFilters]=useState<Filters>(emptyFilters);
  const [page,setPage]=useState(1);
  const [data,setData]=useState<QueryResponse|null>(null);
  const [approvals,setApprovals]=useState<ApprovalRow[]>([]);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const [success,setSuccess]=useState('');
  const [selected,setSelected]=useState<DmsDocument|null>(null);
  const [history,setHistory]=useState<HistoryRow[]>([]);
  const [preview,setPreview]=useState<{url:string;name:string}|null>(null);
  const [reason,setReason]=useState('');
  const [reasonAction,setReasonAction]=useState<'return'|'delete'|null>(null);
  const [busy,setBusy]=useState(false);

  const [sites,setSites]=useState<NamedOption[]>([]);
  const [customers,setCustomers]=useState<NamedOption[]>([]);
  const [employees,setEmployees]=useState<NamedOption[]>([]);
  const [title,setTitle]=useState('');
  const [description,setDescription]=useState('');
  const [uploadSite,setUploadSite]=useState('');
  const [uploadCustomer,setUploadCustomer]=useState('');
  const [uploadEmployee,setUploadEmployee]=useState('');
  const [category,setCategory]=useState('other');
  const [customerCategory,setCustomerCategory]=useState('contract');
  const [documentNumber,setDocumentNumber]=useState('');
  const [documentType,setDocumentType]=useState('');
  const [validFrom,setValidFrom]=useState('');
  const [validUntil,setValidUntil]=useState('');
  const [reviewOn,setReviewOn]=useState('');
  const [retentionUntil,setRetentionUntil]=useState('');
  const [file,setFile]=useState<File|null>(null);
  const [uploadMutation,setUploadMutation]=useState('');
  const [uploadProgress,setUploadProgress]=useState(0);
  const [uploading,setUploading]=useState(false);
  const uploadAbort=useRef<AbortController|null>(null);

  const [versionFile,setVersionFile]=useState<File|null>(null);
  const [versionMutation,setVersionMutation]=useState('');
  const [versionProgress,setVersionProgress]=useState(0);
  const [versionUploading,setVersionUploading]=useState(false);
  const versionAbort=useRef<AbortController|null>(null);

  const canWrite=hasPermission('dms:write');
  const canDelete=hasPermission('dms:delete');
  const query=useMemo(()=>queryString(filters,page),[filters,page]);

  const load=async()=>{
    setLoading(true);setError('');
    try{
      const [result,overview,siteRows,customerRows,employeeRows]=await Promise.all([
        api<QueryResponse>(`/dms/documents/query?${query}`),
        api<{approvals:ApprovalRow[]}>(`/dms/overview?${query}`),
        hasPermission('sites:read')?api<NamedOption[]>('/sites'):Promise.resolve([]),
        hasPermission('customers:read')?api<NamedOption[]>('/customers'):Promise.resolve([]),
        hasPermission('employees:read')?api<NamedOption[]>('/employees'):Promise.resolve([]),
      ]);
      if(!result)throw new Error('Die Dokumentliste konnte nicht geladen werden.');
      setData(result);setApprovals(overview?.approvals??[]);
      setSites(result.filter_options?.sites??siteRows??[]);
      setCustomers(result.filter_options?.customers??customerRows??[]);
      setEmployees(result.filter_options?.employees??employeeRows??[]);
    }catch(cause){setError((cause as Error).message);}
    finally{setLoading(false);}
  };

  useEffect(()=>{void load();},[query]);

  const focusedId=searchParams.get('document');
  useEffect(()=>{
    if(!focusedId||!data?.rows.length){if(!focusedId)setSelected(null);return;}
    const row=data.rows.find(item=>item.id===focusedId);
    if(row)setSelected(row);
  },[focusedId,data]);

  const openDetails=async(row:DmsDocument)=>{
    setSelected(row);setError('');setSuccess('');
    const next=new URLSearchParams(searchParams);next.set('document',row.id);
    setSearchParams(next,{replace:true});
    if(!canWrite){setHistory([]);return;}
    try{setHistory((await api<HistoryRow[]>(`/dms/documents/${row.id}/history`))??[]);}
    catch(cause){setError((cause as Error).message);setHistory([]);}
  };
  const closeDetails=()=>{
    setSelected(null);setPreview(null);setReason('');setReasonAction(null);
    const next=new URLSearchParams(searchParams);next.delete('document');
    setSearchParams(next,{replace:true});
  };

  const mutate=async(path:string,body?:unknown,method='POST')=>{
    setBusy(true);setError('');setSuccess('');
    try{
      const updated=await api<DmsDocument>(path,{method,body:body===undefined?undefined:JSON.stringify(body)});
      setSuccess('Die Änderung wurde gespeichert und im Audit dokumentiert.');
      if(updated)setSelected(updated);
      await load();
      return updated;
    }catch(cause){setError((cause as Error).message);return null;}
    finally{setBusy(false);}
  };

  const upload=async(event:FormEvent)=>{
    event.preventDefault();
    if(!file)return;
    if(uploadSite&&!isUuid(uploadSite)){setError(requiredUuidMessage('Objekt','neutral'));return;}
    if(uploadCustomer&&!isUuid(uploadCustomer)){setError('Bitte einen gültigen Kunden auswählen.');return;}
    if(uploadEmployee&&!isUuid(uploadEmployee)){setError(requiredUuidMessage('Mitarbeiter','maskulin'));return;}
    if(Boolean(uploadCustomer)===Boolean(uploadEmployee)){
      setError('Bitte entweder einen Kunden oder einen Mitarbeiter zuordnen – nicht beides und nicht keines.');return;
    }
    const controller=new AbortController();uploadAbort.current=controller;
    setUploading(true);setUploadProgress(0);setError('');setSuccess('');
    const mutationId=uploadMutation||uuid();setUploadMutation(mutationId);
    try{
      const content=await toBase64(file,setUploadProgress,controller.signal);
      setUploadProgress(95);
      await api('/dms/documents',{method:'POST',signal:controller.signal,body:JSON.stringify({
        title,description:description||null,site_id:uploadSite||null,
        customer_id:uploadCustomer||null,customer_document_category:uploadCustomer?customerCategory:null,
        employee_id:uploadEmployee||null,employee_document_category:uploadEmployee?category:null,
        document_number:documentNumber||null,document_type:documentType||null,
        valid_from:validFrom||null,valid_until:validUntil||null,review_on:reviewOn||null,
        retention_until:retentionUntil?new Date(`${retentionUntil}T23:59:59`).toISOString():null,
        content_type:file.type,content_base64:content,client_mutation_id:mutationId,
      })});
      setUploadProgress(100);
      setSuccess('Das Dokument wurde hochgeladen und durchläuft die Virenprüfung.');
      setTitle('');setDescription('');setUploadSite('');setUploadCustomer('');setUploadEmployee('');
      setCategory('other');setCustomerCategory('contract');setDocumentNumber('');setDocumentType('');
      setValidFrom('');setValidUntil('');setReviewOn('');setRetentionUntil('');setFile(null);setUploadMutation('');
      await load();
    }catch(cause){setError((cause as Error).message);}
    finally{setUploading(false);uploadAbort.current=null;}
  };

  const uploadVersion=async(event:FormEvent)=>{
    event.preventDefault();
    if(!selected||!versionFile)return;
    const controller=new AbortController();versionAbort.current=controller;
    setVersionUploading(true);setVersionProgress(0);setError('');setSuccess('');
    const mutationId=versionMutation||uuid();setVersionMutation(mutationId);
    try{
      const content=await toBase64(versionFile,setVersionProgress,controller.signal);
      setVersionProgress(95);
      const updated=await api<Version>(`/dms/documents/${selected.id}/versions`,{method:'POST',signal:controller.signal,body:JSON.stringify({
        content_base64:content,content_type:versionFile.type,
        retention_until:retentionUntil?new Date(`${retentionUntil}T23:59:59`).toISOString():null,
        client_mutation_id:mutationId,
      })});
      if(!updated)throw new Error('Die neue Fassung konnte nicht bestätigt werden.');
      setVersionProgress(100);setVersionFile(null);setVersionMutation('');
      setSuccess(`Fassung ${updated.version_no} wurde hochgeladen und geprüft. Die Freigabe wurde entzogen.`);
      setSelected({...selected,versions:[updated,...(selected.versions??[]).filter(version=>version.id!==updated.id)],current_version:updated,approval_status:'pending_approval',is_approved:false});
      await load();
    }catch(cause){setError((cause as Error).message);}
    finally{setVersionUploading(false);versionAbort.current=null;}
  };

  const download=async(row:DmsDocument,version:Version,inline=false)=>{
    try{
      const response=await fetch(`/api/v1/dms/documents/${row.id}/versions/${version.id}/${inline?'preview':'download'}`,{
        credentials:'include',headers:{'x-csrf-token':csrf()},
      });
      if(!response.ok)throw new Error(((await response.json().catch(()=>({}))) as {error?:string}).error||'Der Zugriff ist fehlgeschlagen.');
      const blob=await response.blob();
      if(inline){
        if(preview)URL.revokeObjectURL(preview.url);
        setPreview({url:URL.createObjectURL(blob),name:row.title});
        return;
      }
      const url=URL.createObjectURL(blob);
      const link=window.document.createElement('a');
      link.href=url;link.download=`${row.title.replace(/[^a-zA-Z0-9._-]+/g,'_')||'dokument'}-v${version.version_no}`;
      link.click();URL.revokeObjectURL(url);
      setSuccess('Der Download wurde im Audit protokolliert.');
    }catch(cause){setError((cause as Error).message);}
  };

  const confirmAction=async()=>{
    if(!selected||!reasonAction)return;
    const target=reasonAction;setReasonAction(null);
    if(target==='return')await mutate(`/dms/documents/${selected.id}/return-for-revision`,{reason});
    if(target==='delete')await mutate(`/dms/documents/${selected.id}`,{reason},'DELETE');
    setReason('');
  };

  const patchMetadata=async(event:FormEvent)=>{
    event.preventDefault();
    if(!selected)return;
    await mutate(`/dms/documents/${selected.id}`,{
      title:selected.title,description:selected.description||null,
      document_number:selected.document_number||null,document_type:selected.document_type||null,
      responsible_employee_id:selected.responsible_employee_id||null,
      valid_from:selected.valid_from||null,valid_until:selected.valid_until||null,review_on:selected.review_on||null,
    },'PATCH');
  };

  const applyKpi=(patch:Partial<Filters>)=>{
    setFilters({...emptyFilters,...patch});setPage(1);
  };

  const stats=data?.stats;
  const kpis:[string,number,Partial<Filters>][]=[
    ['Gesamt',stats?.total??0,{}],
    ['Freigegeben',stats?.approved??0,{approval_status:'approved'}],
    ['In Prüfung',stats?.pending_approval??0,{approval_status:'pending_approval'}],
    ['Entwürfe',stats?.draft??0,{approval_status:'draft'}],
    ['Zurückgegeben',stats?.returned??0,{approval_status:'rejected'}],
    ['Archiviert',stats?.archived??0,{approval_status:'archived'}],
    ['Abgelaufen',stats?.expired??0,{validity:'expired'}],
    ['Läuft bald ab',stats?.expiring_30d??0,{validity:'expiring'}],
    ['Datei fehlt',stats?.missing_file??0,{scan_status:'missing'}],
    ['Virenprüfung offen',stats?.scan_pending??0,{scan_status:'scanning'}],
    ['In Quarantäne',stats?.quarantined??0,{scan_status:'quarantined'}],
    ['Prüfung fällig',stats?.review_due??0,{}],
  ];
  const activeKpi=(patch:Partial<Filters>)=>Object.entries(patch).every(([key,value])=>filters[key as keyof Filters]===value);

  const downloadable=(row:DmsDocument)=>row.document_status==='active'&&row.is_approved&&row.scan_status==='available'&&row.current_version;

  return <section className="dms-page">
    <h2>Dokumentenmanagement</h2>
    <p>Alle Dokumente werden mandantengetrennt, versionsbasiert und revisionssicher verwaltet. Die Freigabe erfolgt erst nach erfolgreicher Virenprüfung durch eine berechtigte Person.</p>
    {error&&<ErrorState message={error} onRetry={()=>void load()}/>}
    {success&&<p role="status" className="dms-success">{success}</p>}

    <Section id="dms-kennzahlen" title="Kennzahlen" description="Ein Klick auf eine Kennzahl filtert die Dokumentliste. Die Werte stammen ausschließlich aus den autorisierten Dokumentdaten.">
      <div className="ops-kpis">
        {kpis.map(([label,value,patch],index)=><article className={`ops-kpi${activeKpi(patch)&&index>0?' active':''}`} key={label}>
          <button type="button" onClick={()=>applyKpi(patch)} aria-label={`Nach ${label} filtern`}>
            <strong>{formatNumber(value)}</strong>
            <span>{label}</span>
          </button>
        </article>)}
      </div>
    </Section>

    <Section id="dms-upload" title="Dokument hochladen" description="Erlaubt sind PDF, JPEG, PNG, WebP und Textdateien bis zur konfigurierten Höchstgröße. Der Upload ist wiederholbar, ohne doppelte Fassungen zu erzeugen.">
      {!canWrite?<p>Für das Hochladen von Dokumenten ist die Berechtigung „Dokumente schreiben“ erforderlich.</p>:<form onSubmit={upload}>
        <div className="ops-grid">
          <label>Titel<input required maxLength={240} value={title} onChange={event=>setTitle(event.target.value)} placeholder="z. B. Sicherheitskonzept 2026"/></label>
          <label>Dokumentnummer<input maxLength={100} value={documentNumber} onChange={event=>setDocumentNumber(event.target.value)}/></label>
          <label>Dokumentart<input maxLength={160} list="dms-document-types" value={documentType} onChange={event=>setDocumentType(event.target.value)}/>
            <datalist id="dms-document-types">{(data?.filter_options?.types??[]).map(type=><option key={type} value={type}/>)}</datalist>
          </label>
          <label>Objekt<select value={uploadSite} onChange={event=>setUploadSite(event.target.value)}>
            <option value="">Kein Objekt</option>{sites.map(site=><option key={site.id} value={site.id}>{site.name}</option>)}
          </select></label>
          <label>Kunde<select value={uploadCustomer} onChange={event=>{setUploadCustomer(event.target.value);if(event.target.value)setUploadEmployee('');}}>
            <option value="">Kein Kunde</option>{customers.map(customer=><option key={customer.id} value={customer.id}>{customer.name}</option>)}
          </select></label>
          {uploadCustomer&&<label>Kundendokumentkategorie<select value={customerCategory} onChange={event=>setCustomerCategory(event.target.value)}>
            <option value="contract">Vertrag</option><option value="service">Leistung</option><option value="insurance">Versicherung</option>
            <option value="security_plan">Sicherheitskonzept</option><option value="correspondence">Schriftverkehr</option><option value="other">Sonstiges</option>
          </select></label>}
          <label>Mitarbeiter<select value={uploadEmployee} onChange={event=>{setUploadEmployee(event.target.value);if(event.target.value)setUploadCustomer('');}}>
            <option value="">Kein Mitarbeiter</option>{employees.map(employee=><option key={employee.id} value={employee.id}>{employee.name}</option>)}
          </select></label>
          {uploadEmployee&&<label>Personaldokumentkategorie<select value={category} onChange={event=>setCategory(event.target.value)}>
            <option value="contract">Arbeitsvertrag</option><option value="qualification">Qualifikationsnachweis</option><option value="training">Schulung</option>
            <option value="instruction">Unterweisung</option><option value="personal">Personalunterlage</option><option value="other">Sonstiges</option>
          </select></label>}
          <label>Gültig ab<input type="date" value={validFrom} onChange={event=>setValidFrom(event.target.value)}/></label>
          <label>Gültig bis<input type="date" value={validUntil} onChange={event=>setValidUntil(event.target.value)}/></label>
          <label>Nächste Prüfung<input type="date" value={reviewOn} onChange={event=>setReviewOn(event.target.value)}/></label>
          <label>Aufbewahrung bis<input type="date" value={retentionUntil} onChange={event=>setRetentionUntil(event.target.value)}/></label>
        </div>
        <label>Beschreibung<textarea maxLength={4000} rows={2} value={description} onChange={event=>setDescription(event.target.value)}/></label>
        <div className="dms-file-drop" onDragOver={event=>event.preventDefault()} onDrop={event=>{
          event.preventDefault();const dropped=event.dataTransfer.files?.[0];
          if(dropped){setFile(dropped);setUploadMutation(uuid());}
        }}>
          <label>Datei<input required type="file" onChange={(event:ChangeEvent<HTMLInputElement>)=>{setFile(event.target.files?.[0]??null);setUploadMutation(uuid());}}/></label>
          {file&&<span>{file.name} · {formatNumber(file.size)} Byte</span>}
          {uploading&&<div className="dms-progress" role="progressbar" aria-valuenow={uploadProgress} aria-valuemin={0} aria-valuemax={100}>
            <div style={{width:`${uploadProgress}%`}}/><span>{uploadProgress} %</span>
          </div>}
          {uploading&&<button type="button" className="ops-secondary" onClick={()=>uploadAbort.current?.abort()}>Upload abbrechen</button>}
        </div>
        <button type="submit" disabled={uploading||!file}>{uploading?'Wird hochgeladen …':'Hochladen und prüfen'}</button>
      </form>}
    </Section>

    <Section id="dms-freigaben" title="Offene Freigaben" description={`${formatNumber(approvals.length)} Dokumente warten derzeit auf Prüfung und Freigabe.`}>
      {approvals.length===0?<EmptyState>Keine offenen Freigaben.</EmptyState>:<ul className="dms-approval-list">
        {approvals.map(row=><li key={row.id}>
          <button type="button" onClick={()=>{
            const full=data?.rows.find(item=>item.id===row.id);
            if(full)void openDetails(full);
          }}>{row.title}</button>
          <span>{row.customer_name??row.site_name??'Ohne Zuordnung'} · {row.created_by_email??'Unbekannt'} · {formatDateTime(row.created_at)}</span>
        </li>)}
      </ul>}
    </Section>

    <Section id="dms-liste" title="Dokumente" description="Suche, Filter, Sortierung und Seitennavigation werden serverseitig ausgeführt.">
      <form className="ops-filters" onSubmit={event=>{event.preventDefault();setPage(1);void load();}} aria-label="Dokumente filtern">
        <label aria-label="Dokumente suchen">Suche<input value={filters.q} onChange={event=>setFilters({...filters,q:event.target.value})} placeholder="Titel, Nummer, Art, Objekt …"/></label>
        <label>Objekt<select value={filters.site_id} onChange={event=>setFilters({...filters,site_id:event.target.value})}>
          <option value="">Alle Objekte</option>{(data?.filter_options?.sites??sites).map(site=><option key={site.id} value={site.id}>{site.name}</option>)}
        </select></label>
        <label>Kunde<select value={filters.customer_id} onChange={event=>setFilters({...filters,customer_id:event.target.value})}>
          <option value="">Alle Kunden</option>{(data?.filter_options?.customers??customers).map(customer=><option key={customer.id} value={customer.id}>{customer.name}</option>)}
        </select></label>
        <label>Mitarbeiter<select value={filters.employee_id} onChange={event=>setFilters({...filters,employee_id:event.target.value})}>
          <option value="">Alle Mitarbeiter</option>{(data?.filter_options?.employees??employees).map(employee=><option key={employee.id} value={employee.id}>{employee.name}</option>)}
        </select></label>
        <label>Dokumentart<input list="dms-filter-types" value={filters.document_type} onChange={event=>setFilters({...filters,document_type:event.target.value})}/>
          <datalist id="dms-filter-types">{(data?.filter_options?.types??[]).map(type=><option key={type} value={type}/>)}</datalist>
        </label>
        <label>Dokumentnummer<input list="dms-filter-numbers" value={filters.document_number} onChange={event=>setFilters({...filters,document_number:event.target.value})}/>
          <datalist id="dms-filter-numbers">{(data?.filter_options?.document_numbers??[]).map(number=><option key={number} value={number}/>)}</datalist>
        </label>
        <label>Freigabestatus<select value={filters.approval_status} onChange={event=>setFilters({...filters,approval_status:event.target.value})}>
          <option value="">Alle</option>{Object.entries(approvalLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}
        </select></label>
        <label>Dateistatus<select value={filters.scan_status} onChange={event=>setFilters({...filters,scan_status:event.target.value})}>
          <option value="">Alle</option>{Object.entries(scanLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}
        </select></label>
        <label>Gültigkeit<select value={filters.validity} onChange={event=>setFilters({...filters,validity:event.target.value})}>
          <option value="">Alle</option>{Object.entries(validityLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}
        </select></label>
        <label>Erstellt ab<input type="date" value={filters.created_from} onChange={event=>setFilters({...filters,created_from:event.target.value})}/></label>
        <label>Erstellt bis<input type="date" value={filters.created_to} onChange={event=>setFilters({...filters,created_to:event.target.value})}/></label>
        <label>Gültig ab<input type="date" value={filters.expiry_from} onChange={event=>setFilters({...filters,expiry_from:event.target.value})}/></label>
        <label>Gültig bis<input type="date" value={filters.expiry_to} onChange={event=>setFilters({...filters,expiry_to:event.target.value})}/></label>
        <label>Sortierung<select value={filters.sort} onChange={event=>setFilters({...filters,sort:event.target.value})}>
          <option value="created_at">Erstellungsdatum</option><option value="updated_at">Änderungsdatum</option>
          <option value="title">Titel</option><option value="document_number">Dokumentnummer</option>
          <option value="valid_until">Gültig bis</option><option value="review_on">Nächste Prüfung</option>
        </select></label>
        <label>Richtung<select value={filters.order} onChange={event=>setFilters({...filters,order:event.target.value})}>
          <option value="desc">Absteigend</option><option value="asc">Aufsteigend</option>
        </select></label>
        <label>Seitengröße<select value={filters.page_size} onChange={event=>setFilters({...filters,page_size:event.target.value})}>
          {['10','25','50','100'].map(size=><option key={size} value={size}>{size}</option>)}
        </select></label>
        {canDelete&&<label className="dms-checkbox"><input type="checkbox" checked={filters.include_deleted} onChange={event=>setFilters({...filters,include_deleted:event.target.checked})}/>Gelöschte anzeigen</label>}
        <button type="submit">Filter anwenden</button>
        <button type="button" className="ops-secondary" onClick={()=>{setFilters(emptyFilters);setPage(1);}}>Zurücksetzen</button>
      </form>

      {loading?<LoadingSkeleton rows={6}/>:<>
        <ResponsiveTable<DmsDocument>
          caption="Gefilterte Dokumente"
          rows={data?.rows??[]}
          rowKey={row=>row.id}
          empty="Keine Dokumente entsprechen den aktiven Filtern."
          columns={[
            {key:'title',label:'Dokument',render:row=><>
              <button type="button" onClick={()=>void openDetails(row)}>{row.title}</button>
              <small>{row.document_number??row.document_type??'–'}</small>
            </>},
            {key:'status',label:'Status',render:row=><Badge tone={toneForStatus(row.computed_status)}>{row.status_label}</Badge>},
            {key:'approval',label:'Freigabe',render:row=><Badge tone={toneForApproval(row.approval_status)}>{approvalLabels[row.approval_status]??row.approval_status}</Badge>},
            {key:'assignment',label:'Zuordnung',render:row=><>{row.customer_name??row.site_name??row.employee_name??'–'}</>},
            {key:'version',label:'Fassung',render:row=><>{row.current_version?`v${row.current_version.version_no}`:'–'}<small>{scanLabels[row.scan_status]??row.scan_status}</small></>},
            {key:'validity',label:'Gültig bis',render:row=><>{formatDate(row.valid_until)}{typeof row.days_until_expiry==='number'&&<small>{row.days_until_expiry} Tage</small>}</>},
            {key:'review',label:'Prüfung',render:row=><>{formatDate(row.review_on)}</>},
            {key:'actions',label:'Aktionen',render:row=><div className="dms-row-actions">
              <button type="button" className="ops-secondary" onClick={()=>void openDetails(row)}>Details</button>
              {downloadable(row)&&<>
                <button type="button" className="ops-secondary" onClick={()=>void download(row,row.current_version!,true)}>Vorschau</button>
                <button type="button" onClick={()=>void download(row,row.current_version!,false)}>Download</button>
              </>}
            </div>},
          ]}
        />
        <Pagination page={page} pages={data?.pages??1} total={data?.total??0} label="Dokumente" onChange={setPage}/>
      </>}
    </Section>

    {selected&&<Modal title={selected.title} subtitle={`${selected.document_number??'Ohne Nummer'} · erstellt am ${formatDateTime(selected.created_at)}`} wide onClose={closeDetails}>
      <div className="dms-detail">
        <div className="dms-detail-header">
          <Badge tone={toneForStatus(selected.computed_status)}>{selected.status_label}</Badge>
          <Badge tone={toneForApproval(selected.approval_status)}>{approvalLabels[selected.approval_status]??selected.approval_status}</Badge>
          <Badge tone={selected.scan_status==='available'?'good':selected.scan_status==='rejected'?'critical':'warning'}>{scanLabels[selected.scan_status]??selected.scan_status}</Badge>
          {selected.document_status!=='active'&&<Badge tone="critical">Gelöscht</Badge>}
        </div>
        {selected.rejection_reason&&<p role="alert">Rückgabegrund: {selected.rejection_reason}</p>}
        {selected.approval_feedback&&<p>Freigabevermerk: {selected.approval_feedback}</p>}
        <div className="ops-grid">
          <div><strong>Objekt:</strong> {selected.site_name??'–'}</div>
          <div><strong>Kunde:</strong> {selected.customer_name??'–'}</div>
          <div><strong>Mitarbeiter:</strong> {selected.employee_name??'–'}</div>
          <div><strong>Verantwortlich:</strong> {selected.responsible_employee_name??'–'}</div>
          <div><strong>Gültig ab:</strong> {formatDate(selected.valid_from)}</div>
          <div><strong>Gültig bis:</strong> {formatDate(selected.valid_until)}</div>
          <div><strong>Nächste Prüfung:</strong> {formatDate(selected.review_on)}</div>
          <div><strong>Freigegeben am:</strong> {formatDateTime(selected.approved_at)}</div>
          <div><strong>Erstellt von:</strong> {selected.created_by_email??'–'}</div>
          <div><strong>Letzte Änderung:</strong> {formatDateTime(selected.updated_at)}</div>
        </div>
        {selected.description&&<p>{selected.description}</p>}

        {canWrite&&selected.document_status==='active'&&<form className="dms-metadata" onSubmit={patchMetadata}>
          <h4>Metadaten bearbeiten</h4>
          <div className="ops-grid">
            <label>Titel<input value={selected.title} onChange={event=>setSelected({...selected,title:event.target.value})}/></label>
            <label>Dokumentnummer<input value={selected.document_number??''} onChange={event=>setSelected({...selected,document_number:event.target.value})}/></label>
            <label>Dokumentart<input value={selected.document_type??''} onChange={event=>setSelected({...selected,document_type:event.target.value})}/></label>
            <label>Gültig ab<input type="date" value={selected.valid_from??''} onChange={event=>setSelected({...selected,valid_from:event.target.value||null})}/></label>
            <label>Gültig bis<input type="date" value={selected.valid_until??''} onChange={event=>setSelected({...selected,valid_until:event.target.value||null})}/></label>
            <label>Nächste Prüfung<input type="date" value={selected.review_on??''} onChange={event=>setSelected({...selected,review_on:event.target.value||null})}/></label>
          </div>
          <button type="submit" className="ops-secondary" disabled={busy}>Metadaten speichern</button>
        </form>}

        <div className="dms-versions">
          <h4>Fassungen</h4>
          <ResponsiveTable<Version> rows={selected.versions??[]} rowKey={version=>version.id} empty="Keine Fassungen vorhanden."
            columns={[
              {key:'no',label:'Fassung',render:version=>`v${version.version_no}`},
              {key:'state',label:'Scanstatus',render:version=><Badge tone={version.lifecycle_state==='available'?'good':version.lifecycle_state==='rejected'?'critical':'warning'}>{scanLabels[version.lifecycle_state]??version.lifecycle_state}</Badge>},
              {key:'size',label:'Größe',render:version=>`${formatNumber(version.size_bytes)} Byte`},
              {key:'created',label:'Hochgeladen',render:version=>formatDateTime(version.created_at)},
              {key:'retention',label:'Aufbewahrung',render:version=>formatDate(version.retention_until)},
              {key:'actions',label:'Aktionen',render:version=>downloadable(selected)&&selected.current_version?.id===version.id?<div className="dms-row-actions">
                <button type="button" className="ops-secondary" onClick={()=>void download(selected,version,true)}>Vorschau</button>
                <button type="button" onClick={()=>void download(selected,version,false)}>Download</button>
              </div>:<span>–</span>},
            ]}/>
        </div>

        {canWrite&&selected.document_status==='active'&&<form className="dms-version-upload" onSubmit={uploadVersion}>
          <h4>Neue Fassung hochladen</h4>
          <p>Eine neue Fassung entzieht die aktuelle Freigabe sofort und muss erneut geprüft werden.</p>
          <label>Datei<input required type="file" onChange={event=>{setVersionFile(event.target.files?.[0]??null);setVersionMutation(uuid());}}/></label>
          <label>Aufbewahrung bis<input type="date" value={retentionUntil} onChange={event=>setRetentionUntil(event.target.value)}/></label>
          {versionUploading&&<div className="dms-progress" role="progressbar" aria-valuenow={versionProgress} aria-valuemin={0} aria-valuemax={100}>
            <div style={{width:`${versionProgress}%`}}/><span>{versionProgress} %</span>
          </div>}
          <div className="dms-row-actions">
            <button type="submit" disabled={versionUploading||!versionFile}>{versionUploading?'Wird hochgeladen …':'Fassung hochladen'}</button>
            {versionUploading&&<button type="button" className="ops-secondary" onClick={()=>versionAbort.current?.abort()}>Abbrechen</button>}
          </div>
        </form>}

        {canWrite&&selected.document_status==='active'&&<div className="dms-workflow">
          <h4>Freigabeworkflow</h4>
          <div className="dms-row-actions">
            {['draft','rejected'].includes(selected.approval_status)&&<button type="button" disabled={busy} onClick={()=>void mutate(`/dms/documents/${selected.id}/request-review`)}>Zur Prüfung einreichen</button>}
            {['pending_approval','draft','rejected'].includes(selected.approval_status)&&<button type="button" disabled={busy} onClick={()=>void mutate(`/dms/documents/${selected.id}/approve`,{feedback:null})}>Freigeben</button>}
            {['pending_approval','approved'].includes(selected.approval_status)&&<button type="button" className="ops-secondary" disabled={busy} onClick={()=>setReasonAction('return')}>Zur Überarbeitung zurückgeben</button>}
            {selected.approval_status!=='archived'&&<button type="button" className="ops-secondary" disabled={busy} onClick={()=>void mutate(`/dms/documents/${selected.id}/archive`)}>Archivieren</button>}
            {selected.approval_status==='archived'&&<button type="button" className="ops-secondary" disabled={busy} onClick={()=>void mutate(`/dms/documents/${selected.id}/restore`)}>Wiederherstellen</button>}
            {canDelete&&<button type="button" className="ops-danger" disabled={busy} onClick={()=>setReasonAction('delete')}>Dokument löschen</button>}
          </div>
          <p className="muted">Eine Selbstfreigabe durch die hochladende Person ist ohne Systemadministratorrecht nicht möglich.</p>
        </div>}

        <div className="dms-history">
          <h4>Änderungshistorie</h4>
          {!canWrite?<p>Die Änderungshistorie ist nur für Rollen mit Dokumentbearbeitungsrecht sichtbar.</p>
            :history.length===0?<EmptyState>Keine Audit-Einträge vorhanden.</EmptyState>:<ul>{history.map(item=><li key={item.id}>
            <strong>{formatDateTime(item.created_at)}</strong> · {item.event_type} · {item.actor_email??'System'}
            {item.details&&Object.keys(item.details).length>0&&<small>{JSON.stringify(item.details)}</small>}
          </li>)}</ul>}
        </div>
      </div>
    </Modal>}

    {reasonAction&&<Modal title={reasonAction==='delete'?'Dokument löschen':'Zur Überarbeitung zurückgeben'} onClose={()=>{setReasonAction(null);setReason('');}}>
      <p>{reasonAction==='delete'
        ?'Das Dokument wird aus der aktiven Übersicht entfernt. Die Audit-Historie bleibt erhalten.'
        :'Die Freigabe wird entzogen. Bitte nennen Sie den Grund für die Rückgabe.'}</p>
      <label>Begründung<textarea required rows={3} maxLength={2000} value={reason} onChange={event=>setReason(event.target.value)}/></label>
      <div className="dms-row-actions">
        <button type="button" className="ops-danger" disabled={!reason.trim()||busy} onClick={()=>void confirmAction()}>{reasonAction==='delete'?'Endgültig löschen':'Zurückgeben'}</button>
        <button type="button" className="ops-secondary" onClick={()=>{setReasonAction(null);setReason('');}}>Abbrechen</button>
      </div>
    </Modal>}

    {preview&&<Modal title={`Vorschau: ${preview.name}`} wide onClose={()=>{URL.revokeObjectURL(preview.url);setPreview(null);}}>
      {selected?.current_version?.content_type==='application/pdf'
        ?<iframe className="dms-preview" src={preview.url} title="Dokumentvorschau"/>
        :selected?.current_version?.content_type.startsWith('image/')
          ?<img className="dms-preview-image" src={preview.url} alt="Dokumentvorschau"/>
          :<p>Für diesen Dateityp ist keine direkte Vorschau verfügbar. Bitte nutzen Sie den Download.</p>}
    </Modal>}
  </section>;
}
