import {useEffect,useState} from 'react';
import {Link,useNavigate} from 'react-router-dom';
import {api,csrf,hasPermission,storedUser} from '../lib/api';
import {formatNumber} from '../lib/format';
import {statusLabel} from '../lib/status';
import {commonText} from '../lib/text';
import {uuid} from '../lib/uuid';
import {
  ActionEntry,ActionList,BundleDetail,BundleRow,Dashboard,DocumentOption,EmployeeOption,IncidentOption,KeyRow,PriorityOption,SiteOption,StatusBadge,
  BundleCreateDialog,BundleDeactivateDialog,BundleIssueDialog,BundleReturnDialog,BlockDialog,
  CreateKeyDialog,InventoryDialog,IssueDialog,LossDialog,QrDialog,ReturnDialog,KeySearchSelect,displayDate,employeeLabel,keyTypeLabels,statusLabels,
} from './keyParts';

type SortKey='key_code'|'label'|'status'|'key_type'|'site_name'|'holder_name'|'due_at'|'last_movement_at';
type DialogState=
  |{kind:'create'}|{kind:'issue';item:KeyRow}|{kind:'return';item:KeyRow}|{kind:'loss';item:KeyRow}
  |{kind:'block'|'reactivate';item:KeyRow}|{kind:'qr';item:KeyRow}|{kind:'inventory'}
  |{kind:'bundle-create'}|{kind:'bundle-issue';bundle:BundleRow}
  |{kind:'bundle-return';bundle:BundleRow;items:KeyRow[];partial:boolean}
  |{kind:'bundle-deactivate';bundle:BundleRow}|null;

const apiBase='/api/v1';
const pageSize=10;
const bucketLabels:Record<'A'|'B'|'C',string>={A:'Sofort handeln',B:'Zeitnah klären',C:'Beobachten'};

async function fetchKeyPage(query:string){
  const response=await fetch(`${apiBase}/keys?${query}`,{credentials:'include',headers:{'Content-Type':'application/json'}});
  if(!response.ok){
    const hint='Bitte prüfen Sie Ihre Filter und versuchen Sie es erneut.';
    let message=`Schlüssel konnten nicht geladen werden. ${hint}`;
    try{const body=await response.json() as {error?:string};if(body?.error)message=`${body.error} ${hint}`;}catch{/* response has no JSON body */}
    throw new Error(message);
  }
  const rows=await response.json() as KeyRow[];
  const totalHeader=Number(response.headers.get('X-Total-Count'));
  const pagesHeader=Number(response.headers.get('X-Page-Count'));
  const total=Number.isFinite(totalHeader)?totalHeader:(Array.isArray(rows)?rows.length:0);
  const pageCount=Number.isFinite(pagesHeader)&&pagesHeader>0?pagesHeader:Math.max(1,Math.ceil(total/pageSize));
  return {rows:Array.isArray(rows)?rows:[],total,pageCount};
}

function actionTarget(entry:ActionEntry){
  if(entry.url)return entry.url;
  if(entry.target)return entry.target;
  if(entry.key_id)return `/keys/${entry.key_id}`;
  if(entry.subject_type==='key'&&entry.subject_id)return `/keys/${entry.subject_id}`;
  if(entry.subject_type==='bundle'&&entry.subject_id)return `/keys#bundle-${entry.subject_id}`;
  return '/keys';
}

export function Keys(){
  const navigate=useNavigate();
  const [keys,setKeys]=useState<KeyRow[]>([]);
  const [bundles,setBundles]=useState<BundleRow[]>([]);
  const [sites,setSites]=useState<SiteOption[]>([]);
  const [employees,setEmployees]=useState<EmployeeOption[]>([]);
  const [documents,setDocuments]=useState<DocumentOption[]>([]);
  const [incidents,setIncidents]=useState<IncidentOption[]>([]);
  const [priorities,setPriorities]=useState<PriorityOption[]>([]);
  const [dashboard,setDashboard]=useState<Dashboard|null>(null);
  const [actions,setActions]=useState<ActionList>({A:[],B:[],C:[],generated_at:''});
  const [search,setSearch]=useState('');
  const [status,setStatus]=useState('all');
  const [keyType,setKeyType]=useState('all');
  const [siteFilter,setSiteFilter]=useState('all');
  const [holderFilter,setHolderFilter]=useState('all');
  const [bundleFilter,setBundleFilter]=useState('all');
  const [location,setLocation]=useState('');
  const [sortKey,setSortKey]=useState<SortKey>('key_code');
  const [direction,setDirection]=useState<'asc'|'desc'>('asc');
  const [page,setPage]=useState(1);
  const [total,setTotal]=useState(0);
  const [pageCount,setPageCount]=useState(1);
  const [reloadToken,setReloadToken]=useState(0);
  const [selected,setSelected]=useState<string[]>([]);
  const [exportFull,setExportFull]=useState(false);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const [dialog,setDialog]=useState<DialogState>(null);
  const [bundleItems,setBundleItems]=useState<Record<string,KeyRow[]>>({});
  const [bundleHistory,setBundleHistory]=useState<Record<string,{id:string;created_at:string;movement_type?:string;label?:string;description?:string}[]>>({});
  const [bundleKeySelection,setBundleKeySelection]=useState<Record<string,string>>({});

  const canRead=hasPermission('keys:read');
  const canCreate=hasPermission('keys:create')||hasPermission('keys:write');
  const canUpdate=hasPermission('keys:update');
  const canIssue=hasPermission('keys:issue');
  const canReturn=hasPermission('keys:return');
  const canManage=hasPermission('keys:manage')||hasPermission('keys:report_loss');
  const canExport=hasPermission('keys:export');
  const canQr=hasPermission('keys:qr:read');
  const canInventory=hasPermission('keys:inventory:write');
  const canBundleRead=hasPermission('keys:bundle_read');
  const canBundleWrite=hasPermission('keys:bundle_write');
  const canBundleIssue=hasPermission('keys:bundle_issue');
  const canBundleReturn=hasPermission('keys:bundle_return');
  const canBundleDeactivate=hasPermission('keys:bundle_deactivate');
  const canBundleHistory=hasPermission('keys:bundle_history_read');

  const query=new URLSearchParams();
  if(search.trim())query.set('q',search.trim());
  if(status!=='all')query.set('status',status);
  if(keyType!=='all')query.set('key_type',keyType);
  if(siteFilter!=='all')query.set('site_id',siteFilter);
  if(holderFilter!=='all'){
    if(holderFilter.startsWith('user:'))query.set('holder_user_id',holderFilter.slice(5));
    else query.set('holder_employee_id',holderFilter);
  }
  if(bundleFilter!=='all')query.set('bundle_id',bundleFilter);
  if(location.trim())query.set('location',location.trim());
  query.set('sort',sortKey);query.set('dir',direction);query.set('page',String(page));query.set('pageSize',String(pageSize));
  const queryString=query.toString();
  const reload=()=>setReloadToken(token=>token+1);

  useEffect(()=>{
    if(!canRead)return;
    let cancelled=false;
    setLoading(true);
    void fetchKeyPage(queryString).then(result=>{
      if(cancelled)return;
      setKeys(result.rows);setTotal(result.total);setPageCount(result.pageCount);setError('');
    }).catch(cause=>{if(!cancelled)setError((cause as Error).message);})
      .finally(()=>{if(!cancelled)setLoading(false);});
    return ()=>{cancelled=true;};
  },[queryString,reloadToken,canRead]);

  useEffect(()=>{
    let cancelled=false;
    const loadExtras=async()=>{
      const [metrics,list,siteRows,employeeRows,documentRows,incidentRows,priorityRows,bundleRows]=await Promise.all([
        api<Dashboard>('/keys/dashboard').catch(()=>null),
        api<ActionList>('/keys/action-list').catch(():ActionList=>({A:[],B:[],C:[],generated_at:''})),
        hasPermission('sites:read')?api<SiteOption[]>('/sites').catch(()=>[]):Promise.resolve([]),
        hasPermission('employees:read')?api<EmployeeOption[]>('/employees').catch(()=>[]):Promise.resolve([]),
        hasPermission('dms:read')?api<DocumentOption[]>('/dms/documents').catch(()=>[]):Promise.resolve([]),
        hasPermission('incidents:read')?api<IncidentOption[]>('/incidents').catch(()=>[]):Promise.resolve([]),
        hasPermission('alarm_priorities:read')?api<PriorityOption[]>('/alarm-priorities').catch(()=>[]):Promise.resolve([]),
        canBundleRead?api<BundleRow[]>('/key-bundles').catch(()=>[]):Promise.resolve([]),
      ]);
      if(cancelled)return;
      setDashboard(metrics&&typeof metrics.total==='number'?metrics:null);
      setActions({A:list?.A??[],B:list?.B??[],C:list?.C??[],totals:list?.totals??{A:list?.A?.length??0,B:list?.B?.length??0,C:list?.C?.length??0},generated_at:list?.generated_at??''});
      setSites(Array.isArray(siteRows)?siteRows:[]);
      setEmployees(Array.isArray(employeeRows)?employeeRows:[]);
      setDocuments(Array.isArray(documentRows)?documentRows:[]);
      setIncidents(Array.isArray(incidentRows)?incidentRows:[]);
      setPriorities(Array.isArray(priorityRows)?priorityRows:[]);
      setBundles(Array.isArray(bundleRows)?bundleRows:[]);
    };
    void loadExtras();
    return ()=>{cancelled=true;};
  },[reloadToken,canRead,canBundleRead]);

  const resetFilters=()=>{
    setSearch('');setStatus('all');setKeyType('all');setSiteFilter('all');setHolderFilter('all');setBundleFilter('all');setLocation('');
    setSortKey('key_code');setDirection('asc');setPage(1);
  };
  const toggleSort=(key:SortKey)=>{
    if(key===sortKey)setDirection(value=>value==='asc'?'desc':'asc');
    else{setSortKey(key);setDirection('asc');}
    setPage(1);
  };
  const toggleSelected=(id:string)=>setSelected(rows=>rows.includes(id)?rows.filter(row=>row!==id):[...rows,id]);

  const exportCsv=async()=>{
    try{
      const exportQuery=new URLSearchParams(queryString);
      if(selected.length)exportQuery.set('ids',selected.join(','));
      if(exportFull)exportQuery.set('full','true');
      const response=await fetch(`${apiBase}/keys/export?${exportQuery.toString()}`,{
        credentials:'include',headers:{'Content-Type':'application/json','x-csrf-token':typeof csrf==='function'?csrf():''},
      });
      if(!response.ok)throw new Error('Der CSV-Export konnte nicht abgeschlossen werden. Bitte versuchen Sie es erneut.');
      const disposition=response.headers.get('Content-Disposition')??'';
      const filename=/filename="?([^";]+)"?/i.exec(disposition)?.[1]??'schluessel.csv';
      const url=URL.createObjectURL(await response.blob());
      const link=document.createElement('a');link.href=url;link.download=filename;link.click();URL.revokeObjectURL(url);
      const count=response.headers.get('X-Key-Export-Count');
      const total=response.headers.get('X-Key-Export-Total');
      if(response.headers.get('X-Key-Export-Truncated')==='true')setError(`Der CSV-Export ist auf ${formatNumber(Number(count))} von ${formatNumber(Number(total))} Treffern begrenzt. Aktivieren Sie „Vollständig exportieren“, um alle Treffer zu exportieren.`);
      else setError('');
    }catch(cause){setError((cause as Error).message);}
  };

  const openBundleReturn=async(bundle:BundleRow,partial:boolean)=>{
    try{
      const detail=await api<BundleDetail>(`/key-bundles/${bundle.id}`);
      setDialog({kind:'bundle-return',bundle,items:detail?.items??[],partial});
    }catch(cause){setError((cause as Error).message);}
  };
  const loadBundleItems=async(bundle:BundleRow)=>{
    try{
      const detail=await api<BundleDetail>(`/key-bundles/${bundle.id}`);
      setBundleItems(current=>({...current,[bundle.id]:detail?.items??[]}));
    }catch(cause){setError((cause as Error).message);}
  };
  const loadBundleHistory=async(bundle:BundleRow)=>{
    try{
      const history=await api<{id:string;created_at:string;movement_type?:string;label?:string;description?:string}[]>(`/key-bundles/${bundle.id}/history`);
      setBundleHistory(current=>({...current,[bundle.id]:Array.isArray(history)?history:[]}));
    }catch(cause){setError((cause as Error).message);}
  };
  const addBundleKey=async(bundle:BundleRow)=>{
    const keyId=bundleKeySelection[bundle.id];if(!keyId)return;
    try{
      await api(`/key-bundles/${bundle.id}/items`,{method:'POST',body:JSON.stringify({key_id:keyId,client_mutation_id:uuid()})});
      setBundleKeySelection(current=>({...current,[bundle.id]:''}));reload();
    }catch(cause){setError((cause as Error).message);}
  };
  const removeBundleKey=async(bundle:BundleRow,keyId:string)=>{
    try{
      await api(`/key-bundles/${bundle.id}/items/${keyId}`,{method:'DELETE',body:JSON.stringify({client_mutation_id:uuid()})});
      await loadBundleItems(bundle);reload();
    }catch(cause){setError((cause as Error).message);}
  };

  const dialogNode=(()=>{
    if(!dialog)return null;
    const done=()=>{setDialog(null);reload();};
    const close=()=>setDialog(null);
    switch(dialog.kind){
      case 'create':return <CreateKeyDialog sites={sites} employees={employees} onClose={close} onDone={done}/>;
      case 'issue':return <IssueDialog item={dialog.item} employees={employees} documents={documents} onClose={close} onDone={done}/>;
      case 'return':return <ReturnDialog item={dialog.item} documents={documents} onClose={close} onDone={done}/>;
      case 'loss':return <LossDialog item={dialog.item} employees={employees} sites={sites} incidents={incidents} priorities={priorities} onClose={close} onDone={done}/>;
      case 'block':case 'reactivate':return <BlockDialog item={dialog.item} action={dialog.kind} onClose={close} onDone={done}/>;
      case 'qr':return <QrDialog item={dialog.item} onClose={close}/>;
      case 'inventory':return <InventoryDialog sites={sites} bundles={bundles} onClose={close} onDone={done}/>;
      case 'bundle-create':return <BundleCreateDialog sites={sites} onClose={close} onDone={done}/>;
      case 'bundle-issue':return <BundleIssueDialog bundle={dialog.bundle} employees={employees} onClose={close} onDone={done}/>;
      case 'bundle-return':return <BundleReturnDialog bundle={dialog.bundle} items={dialog.items} partial={dialog.partial} onClose={close} onDone={done}/>;
      case 'bundle-deactivate':return <BundleDeactivateDialog bundle={dialog.bundle} onClose={close} onDone={done}/>;
    }
  })();

  if(!canRead)return <section className="employee-management customer-management key-management"><p role="status">Keine Berechtigung zum Anzeigen von Schlüsseln.</p></section>;

  const criticalActions=dashboard?.critical_count??0;
  const primaryCards:[number,string][]=[
    [dashboard?.total??0,'Gesamt'],[dashboard?.available??0,'Verfügbar'],[dashboard?.issued??0,'Ausgegeben'],
    [dashboard?.overdue??0,'Überfällig'],[dashboard?.lost??0,'Verloren'],[criticalActions,'Kritische Vorgänge'],
  ];
  const detailCards:[number,string][]=[
    [dashboard?.blocked??0,'Gesperrt'],[dashboard?.deactivated??0,'Deaktiviert'],[dashboard?.without_site??0,'Ohne Objekt'],
    [dashboard?.without_holder??0,'Ohne Halter'],[dashboard?.partial_bundles??0,'Unvollständige Schlüsselbünde'],
    [dashboard?.due_today??0,'Heute fällig'],[dashboard?.due_7_days??0,'In 7 Tagen fällig'],[dashboard?.due_30_days??0,'In 30 Tagen fällig'],
  ];
  const bundleKeys=(bundle:BundleRow)=>bundleItems[bundle.id]??[];

  return <section className="employee-management customer-management key-management">
    <div className="employee-page-title">
      <div><h1>Schlüsselverwaltung</h1><p>Ausgabe, Rückgabe, Verlust, Schlüsselbund und Bestandskontrolle revisionssicher im Blick.</p></div>
      <div className="employee-page-actions">
        {canInventory&&<button type="button" onClick={()=>setDialog({kind:'inventory'})}>Bestandskontrolle</button>}
        {canExport&&<>
          <label className="key-export-full"><input type="checkbox" checked={exportFull} onChange={event=>setExportFull(event.target.checked)}/> Vollständig exportieren</label>
          <button type="button" onClick={()=>void exportCsv()}>{commonText.exportCsv}{selected.length?` (${formatNumber(selected.length)})`:''}</button>
        </>}
        {canCreate&&<button type="button" onClick={()=>setDialog({kind:'create'})}>Schlüssel anlegen</button>}
        {canBundleWrite&&<button type="button" onClick={()=>setDialog({kind:'bundle-create'})}>Schlüsselbund anlegen</button>}
      </div>
    </div>
    {error&&<p role="alert" className="error">{error}</p>}
    {dashboard&&<>
      <div className="stats-grid employee-metrics key-metrics">
        {primaryCards.map(([value,label])=><article key={label}><strong>{formatNumber(value)}</strong><span>{label}</span></article>)}
      </div>
      <details className="key-more-metrics"><summary>Weitere Kennzahlen</summary>
        <div className="stats-grid employee-metrics">{detailCards.map(([value,label])=><article key={label}><strong>{formatNumber(value)}</strong><span>{label}</span></article>)}</div>
        {dashboard.recent_movements?.length>0&&<ul className="key-recent-movements">{dashboard.recent_movements.slice(0,6).map(movement=><li key={movement.id}>
          <Link to={`/keys/${movement.key_id}`}>{movement.key_code||movement.key_label||'Schlüssel'}</Link> · {statusLabel(movement.movement_type,'movement')} · {displayDate(movement.created_at)}
        </li>)}</ul>}
      </details>
    </>}
    <section className="customer-action-board key-action-board" aria-label="Handlungsübersicht">
      <h2>Handlungsübersicht</h2>
      <div className="customer-action-columns">{(['A','B','C'] as const).map(bucket=>{
        const total=actions.totals?.[bucket]??actions[bucket]?.length??0;
        const shown=actions[bucket]?.length??0;
        return <article key={bucket} className={`customer-action-column bucket-${bucket}`}>
          <h3>{bucketLabels[bucket]} <small>{formatNumber(total)}</small></h3>
          <ul>{shown?actions[bucket].map(entry=><li key={entry.id}>
            <Link to={actionTarget(entry)}><strong>{entry.label}</strong><small>{entry.key_code||entry.site_name||''}</small></Link>
            {entry.due_at&&<small className="customer-action-due">Fällig {displayDate(entry.due_at)}</small>}
          </li>):<li className="employee-empty">Keine Einträge vorhanden.</li>}</ul>
          {total>shown&&<p className="key-action-more" role="status">Weitere {formatNumber(total-shown)} Vorgänge sind in der Gesamtzahl enthalten.</p>}
        </article>;
      })}</div>
    </section>

    {canBundleRead&&<section className="key-bundle-section" aria-label="Schlüsselbünde">
      <div className="key-section-heading"><h2>Schlüsselbünde</h2><span>{formatNumber(bundles.length)} Schlüsselbünde</span></div>
      {bundles.length===0&&<p className="employee-empty">Keine Schlüsselbünde erfasst.</p>}
      <div className="key-bundle-grid">{bundles.map(bundle=>{
        const partial=bundle.issued_count>0&&bundle.issued_count<bundle.item_count;
        const items=bundleKeys(bundle);
        return <article key={bundle.id} id={`bundle-${bundle.id}`} className={`key-bundle-card${partial?' inconsistent':''}`}>
          <header><div><h3>{bundle.name}</h3><p>{siteLabelForBundle(bundle)} · {bundle.description||'Keine Beschreibung'}</p></div><StatusBadge status={bundle.status}/></header>
          <dl><dt>Schlüssel</dt><dd>{formatNumber(bundle.item_count)}</dd><dt>Ausgegeben</dt><dd>{formatNumber(bundle.issued_count)}</dd><dt>Halter</dt><dd>{bundle.holder_name||'–'}</dd></dl>
          {partial&&<p role="status" className="key-partial-warning">Teilweise ausgegeben – {formatNumber(bundle.item_count-bundle.issued_count)} Schlüssel verfügbar.</p>}
          {bundle.item_count===0&&<p role="status" className="key-partial-warning">Leerer Schlüsselbund – bitte ordnen Sie Schlüssel zu.</p>}
          <div className="key-bundle-actions">
            <button type="button" onClick={()=>void loadBundleItems(bundle)}>Schlüssel anzeigen</button>
            {canBundleHistory&&<button type="button" onClick={()=>void loadBundleHistory(bundle)}>Historie</button>}
            {canBundleIssue&&bundle.status==='available'&&<button type="button" onClick={()=>setDialog({kind:'bundle-issue',bundle})}>Schlüsselbund ausgeben</button>}
            {canBundleReturn&&bundle.issued_count>0&&<button type="button" onClick={()=>void openBundleReturn(bundle,true)}>Teilweise Rückgabe</button>}
            {canBundleReturn&&bundle.issued_count>0&&<button type="button" onClick={()=>void openBundleReturn(bundle,false)}>Vollständige Rückgabe</button>}
            {canBundleDeactivate&&bundle.status!=='deactivated'&&<button type="button" onClick={()=>setDialog({kind:'bundle-deactivate',bundle})}>Deaktivieren</button>}
          </div>
          {bundleHistory[bundle.id]&&<div className="key-history"><h4>Historie</h4>{bundleHistory[bundle.id].length?bundleHistory[bundle.id].map(entry=><p key={entry.id}>{displayDate(entry.created_at)} · {entry.movement_type?statusLabel(entry.movement_type,'movement'):entry.label||'Ereignis'}{entry.description?` · ${entry.description}`:''}</p>):<p className="employee-empty">Keine Ereignisse erfasst.</p>}</div>}
          {bundleItems[bundle.id]&&<div className="bundle-member-list">
            {items.length?items.map(item=><div key={item.id}><Link to={`/keys/${item.id}`}>{item.key_code} · {item.label}</Link><StatusBadge status={item.status}/>{canBundleWrite&&<button type="button" onClick={()=>void removeBundleKey(bundle,item.id)}>Entfernen</button>}</div>):<p className="employee-empty">Keine Schlüssel im Schlüsselbund.</p>}
            {canBundleWrite&&<div className="key-bundle-add">
              <KeySearchSelect label="Schlüssel für den Schlüsselbund" searchLabel="Schlüssel im Schlüsselbund suchen" siteId={bundle.site_id??''} excludeBundleId={bundle.id} status="available"
                value={bundleKeySelection[bundle.id]||''} onChange={value=>setBundleKeySelection(current=>({...current,[bundle.id]:value}))}/>
              <button type="button" disabled={!bundleKeySelection[bundle.id]} onClick={()=>void addBundleKey(bundle)}>Hinzufügen</button>
            </div>}
          </div>}
        </article>;
      })}</div>
    </section>}

    <div className="employee-overview">
      <div className="employee-filterbar key-filterbar">
        <input className="employee-search" aria-label="Schlüssel suchen" placeholder="Schlüssel, Kennziffer, Objekt oder Halter suchen" value={search} onChange={event=>{setSearch(event.target.value);setPage(1);}}/>
        <select aria-label="Schlüsselstatus" value={status} onChange={event=>{setStatus(event.target.value);setPage(1);}}>
          <option value="all">Status: Alle</option>{Object.entries(statusLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}
        </select>
        <select aria-label="Schlüsseltyp" value={keyType} onChange={event=>{setKeyType(event.target.value);setPage(1);}}>
          <option value="all">Alle Schlüsseltypen</option>{Object.entries(keyTypeLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}
        </select>
        <select aria-label="Objekt" value={siteFilter} onChange={event=>{setSiteFilter(event.target.value);setPage(1);}}>
          <option value="all">Alle Objekte</option>{sites.map(site=><option key={site.id} value={site.id}>{site.site_number?`${site.site_number} · ${site.name}`:site.name}</option>)}
        </select>
        <select aria-label="Halter" value={holderFilter} onChange={event=>{setHolderFilter(event.target.value);setPage(1);}}>
          <option value="all">Alle Halter</option>
          {(()=>{const self=selfFilterOption();return self?<option value={self.value}>{self.label}</option>:null;})()}
          {employees.map(employee=><option key={employee.id} value={employee.id}>{employeeLabel(employee)}</option>)}
        </select>
        <select aria-label="Schlüsselbund" value={bundleFilter} onChange={event=>{setBundleFilter(event.target.value);setPage(1);}}>
          <option value="all">Alle Schlüsselbünde</option>{bundles.map(bundle=><option key={bundle.id} value={bundle.id}>{bundle.name}</option>)}
        </select>
        <input aria-label="Ort" placeholder="Ort / Gebäude" value={location} onChange={event=>{setLocation(event.target.value);setPage(1);}}/>
        <button type="button" onClick={resetFilters}>Filter zurücksetzen</button>
      </div>
      <div className="employee-table key-table">
        <table><thead><tr>
          <th><input type="checkbox" aria-label="Alle Schlüssel dieser Seite auswählen" checked={keys.length>0&&keys.every(row=>selected.includes(row.id))} onChange={event=>setSelected(rows=>event.target.checked?Array.from(new Set([...rows,...keys.map(row=>row.id)])):rows.filter(id=>!keys.some(row=>row.id===id)))}/></th>
          <th><button type="button" onClick={()=>toggleSort('key_code')}>Kennziffer</button></th>
          <th><button type="button" onClick={()=>toggleSort('label')}>Bezeichnung</button></th>
          <th><button type="button" onClick={()=>toggleSort('status')}>Status</button></th>
          <th><button type="button" onClick={()=>toggleSort('key_type')}>Schlüsseltyp</button></th>
          <th><button type="button" onClick={()=>toggleSort('site_name')}>Objekt</button></th>
          <th><button type="button" onClick={()=>toggleSort('holder_name')}>Halter</button></th>
          <th><button type="button" onClick={()=>toggleSort('due_at')}>Fällig</button></th>
          <th><button type="button" onClick={()=>toggleSort('last_movement_at')}>Letzte Bewegung</button></th>
          <th>Aktionen</th>
        </tr></thead><tbody>
          {keys.map(key=><tr key={key.id} className={selected.includes(key.id)?'selected-row':''}>
            <td><input type="checkbox" aria-label={`${key.label} auswählen`} checked={selected.includes(key.id)} onChange={()=>toggleSelected(key.id)}/></td>
            <td><Link to={`/keys/${key.id}`}><strong>{key.key_code}</strong></Link></td>
            <td><button type="button" className="employee-name-link" onClick={()=>navigate(`/keys/${key.id}`)}><strong>{key.label}</strong><small>{key.location||key.building||'Kein Standort erfasst'}</small></button></td>
            <td><StatusBadge status={key.status}/></td>
            <td>{statusLabel(key.key_type,'keyType')}</td>
            <td>{key.site_name||'Ohne Objekt'}</td>
            <td>{key.holder_name||'Kein Halter'}{key.bundle_name&&<small className="key-bundle-tag"> · {key.bundle_name}</small>}</td>
            <td>{displayDate(key.due_at)}</td>
            <td>{key.last_movement_type?`${statusLabel(key.last_movement_type,'movement')} · ${displayDate(key.last_movement_at)}`:'–'}</td>
            <td><div className="key-row-actions">
              <Link to={`/keys/${key.id}`}>Öffnen</Link>
              {key.bundle_id?<span className="key-bundled-hint">Nur über den Schlüsselbund verwaltbar</span>:<>
                {canIssue&&key.status==='available'&&<button type="button" onClick={()=>setDialog({kind:'issue',item:key})}>Ausgabe vorbereiten</button>}
                {canReturn&&key.status==='issued'&&<button type="button" onClick={()=>setDialog({kind:'return',item:key})}>Rückgabe erfassen</button>}
                {canManage&&(key.status==='issued'||key.status==='overdue')&&<button type="button" onClick={()=>setDialog({kind:'loss',item:key})}>Verlust melden</button>}
                {canManage&&key.status!=='blocked'&&key.status!=='deactivated'&&<button type="button" onClick={()=>setDialog({kind:'block',item:key})}>Sperren</button>}
                {canManage&&key.status==='blocked'&&<button type="button" onClick={()=>setDialog({kind:'reactivate',item:key})}>Reaktivieren</button>}
                {canQr&&<button type="button" onClick={()=>setDialog({kind:'qr',item:key})}>QR-Code</button>}
              </>}
              {canUpdate&&key.status!=='deactivated'&&<Link to={`/keys/${key.id}/stammdaten`}>Bearbeiten</Link>}
            </div></td>
          </tr>)}
        </tbody></table>
        {loading&&<p className="employee-empty">Schlüssel werden geladen …</p>}
        {!loading&&keys.length===0&&<p className="employee-empty">Keine Schlüssel entsprechen den aktiven Filtern.</p>}
        {total>0&&<div className="employee-pagination"><span>{formatNumber(total)} Schlüssel · Seite {formatNumber(page)} von {formatNumber(pageCount)}</span><button type="button" disabled={page===1} onClick={()=>setPage(value=>Math.max(1,value-1))}>Zurück</button><button type="button" disabled={page>=pageCount} onClick={()=>setPage(value=>value+1)}>Weiter</button></div>}
      </div>
    </div>
    {!canUpdate&&<p className="key-permission-note" role="status">Stammdaten und Statusänderungen sind nur mit entsprechenden Schlüsselberechtigungen verfügbar.</p>}
    {dialogNode}
  </section>;
}

function selfFilterOption(){
  try{
    const user=typeof storedUser==='function'?storedUser():null;
    return user?.id?{value:`user:${user.id}`,label:`Mich selbst${user.email?` (${user.email})`:''}`}:null;
  }catch{return null;}
}

function siteLabelForBundle(bundle:BundleRow){
  return bundle.site_name||'Kein Objekt';
}
