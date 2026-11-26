import {FormEvent,useEffect,useState} from 'react';
import {Link,useNavigate,useParams,useSearchParams} from 'react-router-dom';
import {api,hasPermission} from '../lib/api';
import {
  BundleRow,DocumentOption,EmployeeOption,HolderInfo,IncidentOption,KeyProfile,KeyRow,PriorityOption,RecordedMovement,SiteOption,StatusBadge,
  BlockDialog,InventoryDialog,IssueDialog,LossDialog,QrCodeView,ReturnDialog,displayDate,displayDateTime,
  holderName,keyTypeLabels,lossStatusLabels,movementLabels,siteLabel,
} from './keyParts';

type MasterForm={key_code:string;label:string;key_type:string;site_id:string;responsible_employee_id:string;serial_number:string;manufacturer:string;location:string;building:string;area:string;access_point:string;description:string;remarks:string};
type LossDraft={status:string;immediate_measures:string;follow_up:string;notes:string};
type DialogState={kind:'issue'|'return'|'loss'|'block'|'reactivate'|'qr'|'inventory'}|null;
type HistoryResponse={rows:RecordedMovement[];total:number;pageCount:number};

const apiBase='/api/v1';
const historyPageSize=10;
const tabs=[
  ['uebersicht','Übersicht'],['stammdaten','Stammdaten'],['standort','Standort & Objekt'],
  ['besitz','Besitzverhältnisse'],['historie','Historie'],['verlust','Verlustmeldungen'],
  ['bestandskontrolle','Bestandskontrolle'],['qr','QR/Etikett'],
] as const;
const sectionLabels:Record<string,string>={master:'Stammdaten',history:'Historie',loss_reports:'Verlustmeldungen',inventory:'Bestandskontrolle',qr:'QR/Etikett'};

const masterFromKey=(key:KeyRow):MasterForm=>({
  key_code:key.key_code,label:key.label,key_type:key.key_type,site_id:key.site_id||'',
  responsible_employee_id:key.responsible_employee_id||'',
  serial_number:(key as KeyRow&{serial_number?:string|null}).serial_number||'',
  manufacturer:(key as KeyRow&{manufacturer?:string|null}).manufacturer||'',
  location:key.location||'',building:key.building||'',area:key.area||'',access_point:key.access_point||'',
  description:(key as KeyRow&{description?:string|null}).description||'',
  remarks:(key as KeyRow&{remarks?:string|null}).remarks||'',
});

export function KeyDetail(){
  const {keyId,section}=useParams<{keyId:string;section?:string}>();
  const navigate=useNavigate();
  const [searchParams]=useSearchParams();
  const qrReference=searchParams.get('ref');
  const [profile,setProfile]=useState<KeyProfile|null>(null);
  const [form,setForm]=useState<MasterForm|null>(null);
  const [sites,setSites]=useState<SiteOption[]>([]);
  const [employees,setEmployees]=useState<EmployeeOption[]>([]);
  const [documents,setDocuments]=useState<DocumentOption[]>([]);
  const [incidents,setIncidents]=useState<IncidentOption[]>([]);
  const [priorities,setPriorities]=useState<PriorityOption[]>([]);
  const [bundles,setBundles]=useState<BundleRow[]>([]);
  const [history,setHistory]=useState<HistoryResponse|null>(null);
  const [qrCheck,setQrCheck]=useState<{valid:boolean;message:string}|null>(null);
  const [historyPage,setHistoryPage]=useState(1);
  const [lossDrafts,setLossDrafts]=useState<Record<string,LossDraft>>({});
  const [dialog,setDialog]=useState<DialogState>(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const [reloadToken,setReloadToken]=useState(0);

  const canRead=hasPermission('keys:read');
  const canUpdate=hasPermission('keys:update');
  const canIssue=hasPermission('keys:issue');
  const canReturn=hasPermission('keys:return');
  const canManage=hasPermission('keys:manage')||hasPermission('keys:report_loss');
  const canQr=hasPermission('keys:qr:read');
  const canInventory=hasPermission('keys:inventory:write');
  const canHistory=hasPermission('keys:view_history');
  const active=tabs.some(([key])=>key===section)?section:'uebersicht';

  const load=async()=>{
    if(!keyId||!canRead)return;
    setLoading(true);
    try{
      const [data,siteRows,employeeRows,documentRows,incidentRows,priorityRows,bundleRows]=await Promise.all([
        api<KeyProfile>(`/keys/${keyId}`),
        hasPermission('sites:read')?api<SiteOption[]>('/sites').catch(()=>[]):Promise.resolve([]),
        hasPermission('employees:read')?api<EmployeeOption[]>('/employees').catch(()=>[]):Promise.resolve([]),
        hasPermission('dms:read')?api<DocumentOption[]>('/dms/documents').catch(()=>[]):Promise.resolve([]),
        hasPermission('incidents:read')?api<IncidentOption[]>('/incidents').catch(()=>[]):Promise.resolve([]),
        hasPermission('alarm_priorities:read')?api<PriorityOption[]>('/alarm-priorities').catch(()=>[]):Promise.resolve([]),
        hasPermission('keys:bundle_read')?api<BundleRow[]>('/key-bundles').catch(()=>[]):Promise.resolve([]),
      ]);
      if(!data?.key)throw new Error('Schlüsselakte konnte nicht gefunden werden.');
      setProfile(data);setForm(masterFromKey(data.key));
      setSites(Array.isArray(siteRows)?siteRows:[]);
      setEmployees(Array.isArray(employeeRows)?employeeRows:[]);
      setDocuments(Array.isArray(documentRows)?documentRows:[]);
      setIncidents(Array.isArray(incidentRows)?incidentRows:[]);
      setPriorities(Array.isArray(priorityRows)?priorityRows:[]);
      setBundles(Array.isArray(bundleRows)?bundleRows:[]);
      setError('');
    }catch(cause){setError((cause as Error).message);setProfile(null);}
    finally{setLoading(false);}
  };
  useEffect(()=>{void load();},[keyId,reloadToken,canRead]);

  useEffect(()=>{
    if(!keyId||!canHistory||active!=='historie')return;
    let cancelled=false;
    void (async()=>{
      try{
        const response=await fetch(`${apiBase}/keys/${keyId}/history?page=${historyPage}&pageSize=${historyPageSize}`,{
          credentials:'include',headers:{'Content-Type':'application/json'},
        });
        if(!response.ok)throw new Error('Historie konnte nicht geladen werden.');
        const rows=await response.json() as RecordedMovement[];
        const totalHeader=Number(response.headers.get('X-Total-Count'));
        const pagesHeader=Number(response.headers.get('X-Page-Count'));
        const total=Number.isFinite(totalHeader)?totalHeader:(Array.isArray(rows)?rows.length:0);
        const pageCount=Number.isFinite(pagesHeader)&&pagesHeader>0?pagesHeader:Math.max(1,Math.ceil(total/historyPageSize));
        if(!cancelled)setHistory({rows:Array.isArray(rows)?rows:[],total,pageCount});
      }catch{ if(!cancelled)setHistory({rows:[],total:0,pageCount:1});}
    })();
    return ()=>{cancelled=true;};
  },[keyId,active,historyPage,reloadToken,canHistory]);

  useEffect(()=>{
    if(!keyId||!qrReference||!canQr)return;
    let cancelled=false;
    void (async()=>{
      try{
        const result=await api<{valid:boolean;expires_at:string}>(`/keys/${keyId}/qr/verify?ref=${encodeURIComponent(qrReference)}`);
        if(!result)throw new Error('QR verification returned no result');
        if(!cancelled)setQrCheck(result.valid===true
          ?{valid:true,message:`QR-Verweis gültig bis ${displayDateTime(result.expires_at)}`}
          :{valid:false,message:'QR-Verweis ungültig.'});
      }catch{if(!cancelled)setQrCheck({valid:false,message:'QR-Verweis ungültig oder abgelaufen.'});}
    })();
    return ()=>{cancelled=true;};
  },[keyId,qrReference,canQr]);

  const reload=()=>{setReloadToken(token=>token+1);setHistory(null);};
  const closeDialog=()=>setDialog(null);
  const done=()=>{setDialog(null);reload();};

  const saveMaster=async(event:FormEvent)=>{
    event.preventDefault();if(!keyId||!form)return;
    try{
      await api(`/keys/${keyId}`,{method:'PATCH',body:JSON.stringify({
        label:form.label,key_type:form.key_type,site_id:form.site_id||null,
        responsible_employee_id:form.responsible_employee_id||null,serial_number:form.serial_number||null,
        manufacturer:form.manufacturer||null,location:form.location||null,building:form.building||null,
        area:form.area||null,access_point:form.access_point||null,description:form.description||null,remarks:form.remarks||null,
      })});
      reload();
    }catch(cause){setError((cause as Error).message);}
  };
  const saveLossReport=async(reportId:string,draft:LossDraft)=>{
    if(!keyId)return;
    try{
      await api(`/keys/${keyId}/loss-reports/${reportId}`,{method:'PATCH',body:JSON.stringify({
        status:draft.status,immediate_measures:draft.immediate_measures||null,
        follow_up:draft.follow_up||null,notes:draft.notes||null,
      })});
      reload();
    }catch(cause){setError((cause as Error).message);}
  };

  const visible=profile?.visible_sections;
  const canSee=(flag:string)=>{
    if(!visible)return true;
    if(Array.isArray(visible))return visible.includes(flag);
    return visible[flag]!==false;
  };
  const denied=(flag:string)=><p className="employee-empty" role="status">{`Keine Berechtigung für ${sectionLabels[flag]||flag}.`}</p>;
  const field=(label:string,value:string|number|null|undefined)=><><dt>{label}</dt><dd>{value||value===0?value:'–'}</dd></>;

  if(!canRead)return <section className="employee-detail-page customer-detail-page key-detail-page"><p role="status">Keine Berechtigung zum Anzeigen von Schlüsseln.</p></section>;
  if(loading&&!profile)return <section className="employee-detail-page customer-detail-page key-detail-page"><button type="button" className="employee-back" onClick={()=>navigate('/keys')}>Zurück zur Schlüsselübersicht</button><p>Schlüsselakte wird geladen …</p></section>;
  if(!profile)return <section className="employee-detail-page customer-detail-page key-detail-page"><button type="button" className="employee-back" onClick={()=>navigate('/keys')}>Zurück zur Schlüsselübersicht</button>{error&&<p role="alert" className="error">{error}</p>}<p>Die Schlüsselakte konnte nicht geladen werden.</p></section>;

  const key:KeyRow={...profile.key,status:profile.key.display_status||profile.key.status};
  const holder:HolderInfo=profile.holder??{
    holder_user_id:key.holder_user_id,holder_employee_id:key.holder_employee_id,
    holder_name:key.holder_name,holder_personnel_number:key.holder_personnel_number,holder_status:key.holder_status,
  };
  const site=profile.site??(key.site_id?{id:key.site_id,name:key.site_name||'Objekt',site_number:null}:null);
  const objectLink=site?`/sites/${site.id}/schluessel?key=${key.id}`:null;
  const bundled=!!key.bundle_id||!!profile.bundle;
  const movements=history&&active==='historie'?history.rows:profile.recent_movements??[];

  const dialogNode=(()=>{
    if(!dialog)return null;
    switch(dialog.kind){
      case 'issue':return <IssueDialog item={key} employees={employees} documents={documents} onClose={closeDialog} onDone={done}/>;
      case 'return':return <ReturnDialog item={key} documents={documents} onClose={closeDialog} onDone={done}/>;
      case 'loss':return <LossDialog item={key} employees={employees} sites={sites} incidents={incidents} priorities={priorities} onClose={closeDialog} onDone={done}/>;
      case 'block':return <BlockDialog item={key} action="block" onClose={closeDialog} onDone={done}/>;
      case 'reactivate':return <BlockDialog item={key} action="reactivate" onClose={closeDialog} onDone={done}/>;
      case 'qr':return <QrDialogDetail item={key} onClose={closeDialog}/>;
      case 'inventory':return <InventoryDialog sites={sites} bundles={bundles} onClose={closeDialog} onDone={done}/>;
    }
  })();

  return <section className="employee-detail-page customer-detail-page key-detail-page">
    {error&&<p role="alert" className="error">{error}</p>}
    <div className="employee-detail-header key-detail-header">
      <button type="button" className="employee-back" onClick={()=>navigate('/keys')}>Zurück zur Schlüsselübersicht</button>
      <div className="employee-detail-title">
        <div className="employee-avatar">{key.key_code.slice(0,2).toUpperCase()}</div>
        <div><h1>{key.label}</h1><p>{key.key_code} · {keyTypeLabels[key.key_type]||key.key_type} · {siteLabel(site)}</p></div>
        <StatusBadge status={key.status}/>
      </div>
      <div className="key-detail-actions">
        {!bundled&&canIssue&&key.status==='available'&&<button type="button" onClick={()=>setDialog({kind:'issue'})}>Ausgabe vorbereiten</button>}
        {!bundled&&canReturn&&(key.status==='issued'||key.status==='overdue')&&<button type="button" onClick={()=>setDialog({kind:'return'})}>Rückgabe erfassen</button>}
        {!bundled&&canManage&&(key.status==='issued'||key.status==='overdue')&&<button type="button" onClick={()=>setDialog({kind:'loss'})}>Verlust melden</button>}
        {!bundled&&canManage&&key.status!=='blocked'&&key.status!=='deactivated'&&<button type="button" onClick={()=>setDialog({kind:'block'})}>Sperren</button>}
        {!bundled&&canManage&&key.status==='blocked'&&<button type="button" onClick={()=>setDialog({kind:'reactivate'})}>Reaktivieren</button>}
        {canQr&&canSee('qr')&&<button type="button" onClick={()=>navigate(`/keys/${key.id}/qr`)}>QR-Code</button>}
      </div>
    </div>
    {bundled&&<p role="status" className="key-bundled-hint">Dieser Schlüssel gehört zum Bund {profile.bundle?.name||key.bundle_name}. Einzelaktionen sind im Schlüsselbund zu steuern.</p>}
    {qrCheck&&active!=='qr'&&<p role="status" className={qrCheck.valid?'key-qr-check-valid':'key-qr-check-invalid'}>{qrCheck.message}</p>}
    <nav className="employee-tabs key-detail-tabs" aria-label="Schlüsselbereiche">
      {tabs.map(([tab,label])=><button type="button" key={tab} className={active===tab?'active':''} onClick={()=>navigate(`/keys/${key.id}/${tab}`)}>{label}</button>)}
    </nav>
    <div className="employee-detail-content key-detail-content">
      {active==='uebersicht'&&<>
        <div className="employee-detail-kpis">
          <article><strong>{key.key_code}</strong><span>Kennziffer</span></article>
          <article><strong>{statusLabel(key.status)}</strong><span>Status</span></article>
          <article><strong>{holderName(holder)}</strong><span>Aktueller Halter</span></article>
          <article><strong>{site?.name||'–'}</strong><span>Objekt</span></article>
          <article><strong>{displayDate(key.due_at)}</strong><span>Rückgabe fällig</span></article>
          <article><strong>{profile.bundle?.name||key.bundle_name||'–'}</strong><span>Schlüsselbund</span></article>
        </div>
        <div className="employee-detail-grid">
          <article><h3>Schlüssel</h3><dl>{field('Bezeichnung',key.label)}{field('Kennziffer',key.key_code)}{field('Typ',keyTypeLabels[key.key_type]||key.key_type)}{field('Standort',key.location)}{field('Zugangspunkt',key.access_point)}</dl></article>
          <article><h3>Objekt & Halter</h3><dl>{field('Objekt',siteLabel(site))}{field('Halter',holderName(holder))}{field('Fällig',displayDate(key.due_at))}{field('Ausgegeben',displayDateTime(key.issued_at))}</dl>{objectLink&&<Link to={objectLink}>Objektseite öffnen</Link>}</article>
          <article className="key-history"><h3>Letzte Bewegungen</h3>{movements.length?movements.slice(0,5).map(movement=><p key={movement.id}><strong>{movementText(movement.movement_type)}</strong><br/><small>{displayDateTime(movement.created_at)} · {movement.actor_name||'System'}{movement.holder_name?` · ${movement.holder_name}`:''}</small></p>):<p className="employee-empty">Keine Bewegungen erfasst.</p>}</article>
          <article><h3>Verlustmeldungen & Bestand</h3><p>{canSee('loss_reports')?`${profile.loss_reports?.length??0} Verlustmeldung(en) erfasst.`:denied('loss_reports')}</p><p>{canSee('inventory')?`${profile.inventory_checks?.length??0} Bestandskontrolle(n) erfasst.`:denied('inventory')}</p></article>
        </div>
      </>}

      {active==='stammdaten'&&(!canSee('master')?denied('master'):canUpdate&&form?<form className="employee-detail-form key-detail-form" onSubmit={saveMaster}><div className="form-grid">
        <label>Kennziffer<input value={form.key_code} readOnly aria-readonly="true"/></label>
        <label>Bezeichnung<input required value={form.label} onChange={event=>setForm({...form,label:event.target.value})}/></label>
        <label>Schlüsseltyp<select value={form.key_type} onChange={event=>setForm({...form,key_type:event.target.value})}>{Object.entries(keyTypeLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
        <label>Objekt<select aria-label="Objekt" value={form.site_id} onChange={event=>setForm({...form,site_id:event.target.value})}><option value="">Kein Objekt</option>{sites.map(site=><option key={site.id} value={site.id}>{siteLabel(site)}</option>)}</select></label>
        <label>Verantwortliche Person<select aria-label="Verantwortliche Person" value={form.responsible_employee_id} onChange={event=>setForm({...form,responsible_employee_id:event.target.value})}><option value="">Nicht zugewiesen</option>{employees.map(employee=><option key={employee.id} value={employee.id}>{[employee.first_name,employee.last_name].filter(Boolean).join(' ')||employee.name||employee.email||employee.id}</option>)}</select></label>
        <label>Seriennummer<input value={form.serial_number} onChange={event=>setForm({...form,serial_number:event.target.value})}/></label>
        <label>Hersteller<input value={form.manufacturer} onChange={event=>setForm({...form,manufacturer:event.target.value})}/></label>
        <label>Standort / Ort<input value={form.location} onChange={event=>setForm({...form,location:event.target.value})}/></label>
        <label>Gebäude<input value={form.building} onChange={event=>setForm({...form,building:event.target.value})}/></label>
        <label>Bereich<input value={form.area} onChange={event=>setForm({...form,area:event.target.value})}/></label>
        <label>Zugangspunkt<input value={form.access_point} onChange={event=>setForm({...form,access_point:event.target.value})}/></label>
        <label className="span-2">Beschreibung<textarea value={form.description} onChange={event=>setForm({...form,description:event.target.value})}/></label>
        <label className="span-2">Bemerkungen<textarea value={form.remarks} onChange={event=>setForm({...form,remarks:event.target.value})}/></label>
      </div><div className="key-detail-form-actions"><button type="submit">Stammdaten speichern</button><button type="button" onClick={()=>setForm(masterFromKey(key))}>Änderungen verwerfen</button></div></form>:<article className="employee-detail-table"><h3>Stammdaten</h3><dl>
        {field('Kennziffer',key.key_code)}{field('Bezeichnung',key.label)}{field('Typ',keyTypeLabels[key.key_type]||key.key_type)}{field('Standort',key.location)}{field('Gebäude',key.building)}{field('Bereich',key.area)}{field('Zugangspunkt',key.access_point)}{field('Verantwortlich',key.responsible_name)}
        {!canUpdate&&<dt role="status">Keine Berechtigung zum Bearbeiten der Stammdaten.</dt>}
      </dl></article>)}

      {active==='standort'&&<article className="employee-detail-table key-detail-site"><h3>Standort & Objekt</h3>
        <dl>{field('Objekt',siteLabel(site))}{field('Objektnummer',site?.site_number)}{field('Adresse',site?.address)}{field('Standort / Ort',key.location)}{field('Gebäude',key.building)}{field('Bereich',key.area)}{field('Zugangspunkt',key.access_point)}</dl>
        {objectLink?<Link to={objectLink}>Objektseite öffnen</Link>:<p className="employee-empty">Kein Objekt zugeordnet.</p>}
      </article>}

      {active==='besitz'&&<article className="employee-detail-table"><h3>Besitzverhältnisse</h3>
        <dl>{field('Halter',holderName(holder))}{field('Personalnummer',holder.holder_personnel_number??holder.personnel_number)}{field('Halterstatus',holder.holder_status??holder.status)}{field('Ausgegeben am',displayDateTime(key.issued_at))}{field('Rückgabe fällig',displayDateTime(key.due_at))}{field('Zurückgegeben am',displayDateTime(key.returned_at))}{field('Bund',profile.bundle?.name||key.bundle_name)}{field('Verantwortlich',key.responsible_name)}</dl>
        {bundled&&<p role="status" className="key-bundled-hint">Besitzwechsel erfolgen über den Schlüsselbund.</p>}
      </article>}

      {active==='historie'&&(!canSee('history')?denied('history'):!canHistory?<p className="employee-empty" role="status">Keine Berechtigung für die Schlüsselhistorie.</p>:<article className="key-history"><h3>Schlüsselbewegungen</h3>
        {movements.length?<ol>{movements.map(movement=><li key={movement.id}>
          <strong>{movementText(movement.movement_type)}</strong>
          <p>{displayDateTime(movement.created_at)}{movement.actor_name?` · Ausgeführt von ${movement.actor_name}`:''}{movementHolder(movement)?` · Halter: ${movementHolder(movement)}`:''}{movement.site_name?` · Objekt: ${movement.site_name}`:''}</p>
          {(movementFrom(movement)||movementTo(movement))&&<small>Status: {movementFrom(movement)||'–'} → {movementTo(movement)||'–'}</small>}
          {movement.reason&&<small> · Grund: {movement.reason}</small>}
          {movement.incident_id&&<small> · Vorfall: {movement.incident_id}</small>}
          {(movement.receipt_id||movement.reference)&&<small> · Beleg: {movement.receipt_id||movement.reference}</small>}
        </li>)}</ol>:<p className="employee-empty">Keine Bewegungen erfasst.</p>}
        {history&&history.pageCount>1&&<div className="key-history-pagination"><span>{history.total} Einträge · Seite {historyPage} von {history.pageCount}</span><button type="button" disabled={historyPage===1} onClick={()=>setHistoryPage(value=>Math.max(1,value-1))}>Zurück</button><button type="button" disabled={historyPage>=history.pageCount} onClick={()=>setHistoryPage(value=>value+1)}>Weiter</button></div>}
      </article>)}

      {active==='verlust'&&(!canSee('loss_reports')?denied('loss_reports'):<>
        {canManage&&<button type="button" onClick={()=>setDialog({kind:'loss'})}>Verlust melden</button>}
        {(profile.loss_reports??[]).length===0&&<p className="employee-empty">Keine Verlustmeldungen erfasst.</p>}
        {(profile.loss_reports??[]).map(report=>{
          const draft=lossDrafts[report.id]??{status:report.status??'reported',immediate_measures:report.immediate_measures??'',follow_up:report.follow_up??'',notes:report.notes??''};
          return <article className="key-loss-report" key={report.id}><header><h3>Verlustmeldung</h3><StatusBadge status={report.status||'reported'}/></header>
            <dl>{field('Gemeldet am',displayDateTime(report.reported_at))}{field('Verlustzeitpunkt',displayDateTime(report.lost_at))}{field('Melder',report.reporter_name)}{field('Beschreibung',report.description)}</dl>
            {canManage?<div className="key-loss-form"><label>Status<select aria-label="Status der Verlustmeldung" value={draft.status} onChange={event=>setLossDrafts(current=>({...current,[report.id]:{...draft,status:event.target.value}}))}>{Object.entries(lossStatusLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
              <label>Sofortmaßnahmen<textarea value={draft.immediate_measures} onChange={event=>setLossDrafts(current=>({...current,[report.id]:{...draft,immediate_measures:event.target.value}}))}/></label>
              <label>Folge Maßnahmen<textarea value={draft.follow_up} onChange={event=>setLossDrafts(current=>({...current,[report.id]:{...draft,follow_up:event.target.value}}))}/></label>
              <label>Notizen<textarea value={draft.notes} onChange={event=>setLossDrafts(current=>({...current,[report.id]:{...draft,notes:event.target.value}}))}/></label>
              <button type="button" onClick={()=>void saveLossReport(report.id,draft)}>Verlustmeldung speichern</button>
            </div>:<dl>{field('Sofortmaßnahmen',report.immediate_measures)}{field('Folge Maßnahmen',report.follow_up)}{field('Notizen',report.notes)}</dl>}
          </article>;
        })}
      </>)}

      {active==='bestandskontrolle'&&(!canSee('inventory')?denied('inventory'):<>
        {canInventory&&<button type="button" onClick={()=>setDialog({kind:'inventory'})}>Bestandskontrolle erfassen</button>}
        {(profile.inventory_checks??[]).length===0&&<p className="employee-empty">Keine Bestandskontrollen erfasst.</p>}
        {(profile.inventory_checks??[]).map(check=><article className="key-inventory-card" key={check.id}><h3>Bestandskontrolle</h3>
          <dl>{field('Prüfer',check.checker_name)}{field('Geprüft am',displayDateTime(check.checked_at))}{field('Objekt',check.site_name)}{field('Notizen',check.notes)}</dl>
          {(check.items??check.results??[]).length>0&&<ul>{(check.items??check.results??[]).map(result=><li key={result.key_id}>{result.key_id} · {result.expected_present?'erwartet':'nicht erwartet'} · {result.actual_condition||'–'}</li>)}</ul>}
        </article>)}
      </>)}

      {active==='qr'&&(!canSee('qr')?denied('qr'):canQr?<article className="key-detail-qr"><h3>QR-Code & Etikett</h3>
        {qrCheck&&<p role="status" className={qrCheck.valid?'key-qr-check-valid':'key-qr-check-invalid'}>{qrCheck.message}</p>}
        <QrCodeView keyId={key.id} label={`${key.key_code} ${key.label}`} reference={qrReference}/></article>:<p className="employee-empty" role="status">Keine Berechtigung zum Anzeigen des QR-Codes.</p>)}
    </div>
    {dialogNode}
  </section>;
}

function QrDialogDetail({item,onClose}:{item:KeyRow;onClose:()=>void}){
  return <div className="key-dialog-backdrop"><section className="key-dialog" role="dialog" aria-modal="true" aria-label={`QR-Code & Etikett · ${item.key_code}`}>
    <header><h2>{`QR-Code & Etikett · ${item.key_code}`}</h2><button type="button" aria-label="Dialog schließen" onClick={onClose}>×</button></header>
    <div className="key-dialog-body"><QrCodeView keyId={item.id} label={`${item.key_code} ${item.label}`}/><div className="key-dialog-actions"><button type="button" onClick={onClose}>Schließen</button></div></div>
  </section></div>;
}

function statusLabel(status:string){return ({available:'Verfügbar',issued:'Ausgegeben',overdue:'Überfällig',lost:'Verloren',blocked:'Gesperrt',deactivated:'Deaktiviert'} as Record<string,string>)[status]||status;}
function movementText(type:string){return movementLabels[type]||type;}
function movementHolder(movement:RecordedMovement){return movement.holder_name??movement.holder_user_name??movement.holder_employee_name??null;}
function movementFrom(movement:RecordedMovement){return movement.previous_status??movement.from_status??null;}
function movementTo(movement:RecordedMovement){return movement.new_status??movement.to_status??null;}
