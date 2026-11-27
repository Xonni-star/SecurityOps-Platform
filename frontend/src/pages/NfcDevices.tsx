import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {useNavigate,useSearchParams} from 'react-router-dom';
import {api,hasPermission} from '../lib/api';
import {formatDate,formatDateTime,formatNumber} from '../lib/format';
import {commonText} from '../lib/text';
import {
  emptyNfcForm,emptyNfcReplaceForm,nfcAssignmentLabel,nfcCanBlock,nfcCanReactivate,nfcCanRecover,nfcCanReplace,nfcFormFromDevice,
  nfcIsAssignable,nfcMasterDataPayloadFromForm,nfcMessage,nfcPayloadFromForm,nfcReplaceIsConfirmed,nfcReplacePayload,
  nfcReplaceSnapshot,nfcReplaceSummary,nfcStatusClass,nfcStatusLabel,nfcStatusText,nfcTypeLabel,updateNfcReplaceForm,
  validateNfcForm,validateNfcReplace,
  NfcDialog,NfcFormFields,NfcKpiCard,NfcReasonDialog,NfcRecoverDialog,NfcReplaceDialog,
  type NfcDevice,type NfcForm,type NfcOptions,type NfcOverview,type NfcReplaceForm,
} from './nfcParts';

type Filters={
  q:string;device_type:string;status:string;site_id:string;control_point_id:string;employee_id:string;assignment:string;
  archived:string;replaced:string;recent:string;
};
type DialogKind='create'|'edit'|'block'|'lost'|'replace'|'reactivate'|'recover'|'archive'|null;

const emptyFilters:Filters={q:'',device_type:'',status:'',site_id:'',control_point_id:'',employee_id:'',assignment:'',archived:'',replaced:'',recent:''};
const emptyOptions:NfcOptions={sites:[],control_points:[],employees:[]};
const daysOptions=[7,30,90,180,365];
const today=new Date().toISOString().slice(0,10);

const filterKeys=Object.keys(emptyFilters) as (keyof Filters)[];
const labels:Record<keyof Filters,string>={
  q:'Suche',device_type:'Gerätetyp',status:'Status',site_id:'Objekt',control_point_id:'Kontrollpunkt',
  employee_id:'Mitarbeiter',assignment:'Zuordnung',archived:'Archivierung',replaced:'Ersatzstatus',recent:'Verwendung',
};

type KpiPatch=Partial<Filters>;
const kpiFilters:Record<string,{label:string;patch:KpiPatch}>={
  registered:{label:'Registrierte Geräte',patch:{...emptyFilters}},
  active_tags:{label:'Aktive NFC-Tags',patch:{status:'active',device_type:'tag',archived:'false'}},
  active_readers:{label:'Aktive Lesegeräte',patch:{status:'active',device_type:'reader',archived:'false'}},
  blocked:{label:'Gesperrt',patch:{status:'blocked',archived:'false'}},
  lost:{label:'Verloren',patch:{status:'lost',archived:'false'}},
  unassigned:{label:'Ohne Zuordnung',patch:{assignment:'unassigned',archived:'false'}},
  replaced:{label:'Ersetzt',patch:{replaced:'true'}},
  archived:{label:'Archiviert',patch:{archived:'true'}},
  recent:{label:'Kürzlich verwendet',patch:{recent:'true'}},
  scans:{label:'Scans',patch:{recent:'true'}},
};

function parseState(params:URLSearchParams):{filters:Filters;days:number;sort:string;dir:'asc'|'desc';page:number;pageSize:number}{
  const filters={...emptyFilters};
  for(const key of filterKeys){
    const value=params.get(key);
    if(value!==null)filters[key]=value;
  }
  const dayValue=Number(params.get('days'));
  const days=daysOptions.includes(dayValue)?dayValue:30;
  const sort=params.get('sort')??'updated_at';
  const dir=params.get('dir')==='asc'?'asc':'desc';
  const page=Math.max(Number.parseInt(params.get('page')??'1',10)||1,1);
  const pageSize=Math.min(Math.max(Number.parseInt(params.get('pageSize')??'25',10)||25,5),100);
  return {filters,days,sort,dir,page,pageSize};
}

function SortButton({label,field,sort,dir,onSort}:{
  label:string;field:string;sort:string;dir:'asc'|'desc';onSort:(field:string)=>void;
}){
  return <button type="button" onClick={()=>onSort(field)} aria-label={`${label} sortieren`}>
    {label}{sort===field?(dir==='asc'?' ↑':' ↓'):''}
  </button>;
}

export function NfcDevices(){
  const navigate=useNavigate();
  const canRead=hasPermission('nfc_devices:read');
  const canWrite=hasPermission('nfc_devices:write');
  const canSecurity=hasPermission('nfc_devices:security');
  const [searchParams,setSearchParams]=useSearchParams();
  const initial=useMemo(()=>parseState(searchParams),[]);
  const [filters,setFilters]=useState<Filters>(initial.filters);
  const [days,setDays]=useState(initial.days);
  const [sort,setSort]=useState(initial.sort);
  const [dir,setDir]=useState<'asc'|'desc'>(initial.dir);
  const [page,setPage]=useState(initial.page);
  const [pageSize,setPageSize]=useState(initial.pageSize);
  const [searchInput,setSearchInput]=useState(initial.filters.q);
  const [showAdvanced,setShowAdvanced]=useState(false);
  const [showSecondary,setShowSecondary]=useState(false);
  const [items,setItems]=useState<NfcDevice[]>([]);
  const [overview,setOverview]=useState<NfcOverview|null>(null);
  const [options,setOptions]=useState<NfcOptions>(emptyOptions);
  const [total,setTotal]=useState(0);
  const [totalPages,setTotalPages]=useState(1);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const [success,setSuccess]=useState('');
  const [dialog,setDialog]=useState<DialogKind>(null);
  const [selected,setSelected]=useState<NfcDevice|null>(null);
  const [form,setForm]=useState<NfcForm>(emptyNfcForm());
  const [reason,setReason]=useState('');
  const [lostDate,setLostDate]=useState(today);
  const [replacement,setReplacement]=useState<NfcReplaceForm>(emptyNfcReplaceForm());
  const [replaceConfirmation,setReplaceConfirmation]=useState<string|null>(null);
  const [recover,setRecover]=useState({found_at:today,identifier_confirmation:'',reason:''});
  const [dialogError,setDialogError]=useState('');
  const [busy,setBusy]=useState(false);
  const abortRef=useRef<AbortController|null>(null);
  const reloadRef=useRef<()=>Promise<void>>(async()=>undefined);

  // Ein Zeitfenster pro Auswahl: Overview, Inventar und Zuordnungsfilter
  // verwenden exakt dieselben Grenzen, auch über mehrere Requests hinweg.
  const timeWindow=useMemo(()=>({
    from:new Date(Date.now()-days*86_400_000).toISOString(),
    to:new Date().toISOString(),
  }),[days]);
  const queryString=useMemo(()=>{
    const params=new URLSearchParams();
    for(const [key,value] of Object.entries(filters))if(value)params.set(key,value);
    params.set('days',String(days));
    params.set('from',timeWindow.from);params.set('to',timeWindow.to);
    params.set('sort',sort);params.set('dir',dir);
    params.set('page',String(page));params.set('pageSize',String(pageSize));
    return params.toString();
  },[filters,days,timeWindow,sort,dir,page,pageSize]);

  useEffect(()=>{
    const params=new URLSearchParams();
    for(const [key,value] of Object.entries(filters))if(value)params.set(key,value);
    params.set('days',String(days));params.set('sort',sort);params.set('dir',dir);
    params.set('page',String(page));params.set('pageSize',String(pageSize));
    setSearchParams(params,{replace:true});
  },[filters,days,sort,dir,page,pageSize,setSearchParams]);

  const load=useCallback(async()=>{
    if(!canRead)return;
    abortRef.current?.abort();
    const controller=new AbortController();
    abortRef.current=controller;
    setLoading(true);
    try{
      const [inventory,metrics]=await Promise.all([
        api<{rows:NfcDevice[];total:number;totalPages:number}>(`/nfc-devices/inventory?${queryString}`,{signal:controller.signal}),
        api<NfcOverview>(`/nfc-devices/overview?${new URLSearchParams({days:String(days),from:timeWindow.from,to:timeWindow.to}).toString()}`,{signal:controller.signal}),
      ]);
      if(controller.signal.aborted)return;
      setItems(inventory?.rows??[]);
      setTotal(Number(inventory?.total??0));
      setTotalPages(Number(inventory?.totalPages??1));
      setOverview(metrics??null);
      setError('');
    }catch(cause){
      if(controller.signal.aborted)return;
      setError(nfcMessage(cause));
    }finally{
      if(!controller.signal.aborted)setLoading(false);
    }
  },[canRead,queryString,days,timeWindow]);
  reloadRef.current=load;

  useEffect(()=>{void load();},[load]);
  useEffect(()=>()=>abortRef.current?.abort(),[]);
  useEffect(()=>{
    const handle=window.setTimeout(()=>{
      setFilters(current=>current.q===searchInput?current:{...current,q:searchInput});
    },300);
    return ()=>window.clearTimeout(handle);
  },[searchInput]);
  useEffect(()=>{setSearchInput(filters.q);},[filters.q]);
  useEffect(()=>{
    if(!canRead)return;
    void api<NfcOptions>('/nfc-devices/filter-options').then(value=>setOptions(value??emptyOptions)).catch(()=>undefined);
  },[canRead]);

  const changeFilter=(key:keyof Filters,value:string)=>{setFilters(current=>({...current,[key]:value}));setPage(1);};
  const changeSort=(field:string)=>{
    if(sort===field)setDir(current=>current==='asc'?'desc':'asc');
    else{setSort(field);setDir('asc');}
    setPage(1);
  };
  const resetAll=()=>{
    setFilters(emptyFilters);setSearchInput('');setDays(30);setSort('updated_at');setDir('desc');setPage(1);setPageSize(25);
    setShowAdvanced(false);setSuccess('');
  };
  const activeFilters=(Object.entries(filters) as [keyof Filters,string][]).filter(([,value])=>Boolean(value));
  const isKpiActive=(patch:KpiPatch)=>Object.entries(patch).every(([key,value])=>filters[key as keyof Filters]===value);
  const toggleKpi=(id:string)=>{
    const patch=kpiFilters[id].patch;
    const active=isKpiActive(patch);
    setFilters(current=>{
      const next={...current};
      if(active){
        for(const key of Object.keys(patch) as (keyof Filters)[])next[key]='';
      }else{
        Object.assign(next,patch);
      }
      return next;
    });
    setPage(1);
  };

  const openDialog=(kind:Exclude<DialogKind,null>,device?:NfcDevice)=>{
    setError('');setSuccess('');setDialogError('');setBusy(false);setDialog(kind);
    if(kind==='create')setForm(emptyNfcForm());
    if(kind==='edit'&&device){setSelected(device);setForm(nfcFormFromDevice(device));}
    if(kind!=='create'&&kind!=='edit'&&device){
      setSelected(device);setReason('');setLostDate(today);
      setReplacement(emptyNfcReplaceForm(device));setReplaceConfirmation(null);
      setRecover({found_at:today,identifier_confirmation:'',reason:''});
    }
  };

  const execute=async(action:()=>Promise<void>,successText:string)=>{
    setDialogError('');setBusy(true);
    try{
      await action();
      setSuccess(successText);setError('');setDialog(null);
      await reloadRef.current();
    }catch(cause){setDialogError(nfcMessage(cause));}
    finally{setBusy(false);}
  };

  const saveForm=()=>{
    const showAssignment=dialog==='create'||Boolean(selected&&nfcIsAssignable(selected));
    const validation=validateNfcForm(form,showAssignment);
    if(validation){setDialogError(validation);return;}
    if(dialog==='create'){
      const payload=nfcPayloadFromForm(form);
      void execute(async()=>{await api('/nfc-devices',{method:'POST',body:JSON.stringify(payload)});},'NFC-Gerät wurde registriert.');
    }else if(selected){
      const payload=nfcMasterDataPayloadFromForm(form);
      void execute(async()=>{await api(`/nfc-devices/${selected.id}`,{method:'PATCH',body:JSON.stringify(payload)});},'NFC-Gerät wurde gespeichert.');
    }
  };

  const runStatus=(action:string,body:Record<string,unknown>,successText:string)=>{
    if(!selected)return;
    void execute(async()=>{await api(`/nfc-devices/${selected.id}/${action}`,{method:'POST',body:JSON.stringify(body)});},successText);
  };

  const candidate=(options.devices??[]).find(item=>item.id===replacement.existing_device_id);
  const replacementSummary=selected?nfcReplaceSummary(replacement,selected,candidate):null;
  const replacementSnapshot=replacementSummary?nfcReplaceSnapshot(replacement,replacementSummary):null;
  const replaceConfirmed=!!replacementSummary&&nfcReplaceIsConfirmed(replacement,replacementSummary,replaceConfirmation);
  // Jede fachlich relevante Änderung geht über diesen Weg und entzieht damit
  // der bisherigen Bestätigung sofort ihre Gültigkeit.
  const changeReplacement=(patch:Partial<NfcReplaceForm>)=>{
    setReplacement(current=>updateNfcReplaceForm(current,patch));
    setReplaceConfirmation(null);
  };

  if(!canRead)return <section className="object-management"><h2>NFC-Geräte</h2><p>{commonText.noPermission}</p></section>;

  return <section className="object-management">
    <div className="object-page-header">
      <div>
        <p className="object-eyebrow">Verwaltung · NFC-Geräte</p>
        <h2>NFC-Geräteverwaltung</h2>
        <p>Tags und Lesegeräte registrieren, zuordnen, sperren und nachvollziehbar verwalten.</p>
      </div>
      <div className="object-page-actions">
        <label>Zeitraum <select aria-label="Auswertungszeitraum" value={days}
          onChange={event=>{setDays(Number(event.target.value));setPage(1);}}>
          {daysOptions.map(value=><option key={value} value={value}>{value} Tage</option>)}
        </select></label>
        {canWrite&&<button type="button" onClick={()=>openDialog('create')}>NFC-Gerät registrieren</button>}
      </div>
    </div>

    {error&&<p className="object-warning" role="alert">{error} <button type="button" onClick={()=>void load()}>Erneut laden</button></p>}
    {success&&<p className="object-success" role="status">{success}</p>}

    <div className="nfc-kpi-section">
      <div className="object-summary-grid object-metrics">
        {(Object.keys(kpiFilters) as (keyof typeof kpiFilters)[]).filter(id=>!['replaced','archived','recent','scans'].includes(id)).map(id=>{
          const kpi=kpiFilters[id];
          const value=Number((id==='registered'?overview?.total:overview?.[id as keyof NfcOverview])??0);
          return <NfcKpiCard key={id} label={kpi.label} value={value}
            hint={id==='active_tags'?'Für Kontrollpunkte nutzbar':undefined}
            active={isKpiActive(kpi.patch)} onClick={()=>toggleKpi(id)}/>;
        })}
      </div>
      <button type="button" className="nfc-disclosure" aria-expanded={showSecondary}
        onClick={()=>setShowSecondary(current=>!current)}>
        {showSecondary?'Weniger Kennzahlen':'Weitere Kennzahlen'} anzeigen
      </button>
      {showSecondary&&<div className="object-summary-grid object-metrics">
        {(['replaced','archived','recent','scans'] as const).map(id=>{
          const kpi=kpiFilters[id];
          const value=Number((id==='recent'?overview?.recent_devices:overview?.[id as keyof NfcOverview])??0);
          return <NfcKpiCard key={id} label={id==='scans'?`Scans (${days} Tage)`:kpi.label}
            value={value}
            hint={id==='recent'?`Geräte mit Scans in ${days} Tagen`:id==='scans'?'Tatsächlich erfasste Kontrollgänge':undefined}
            active={isKpiActive(kpi.patch)} onClick={()=>toggleKpi(id)}/>;
        })}
      </div>}
    </div>

    {!!overview?.recent.length&&<div className="object-detail-content nfc-recent">
      <h3>Zuletzt verwendete NFC-Geräte</h3>
      <ul>{overview.recent.map(device=><li key={device.id}>
        <button type="button" onClick={()=>navigate(`/nfc-devices/${device.id}`)}>{device.identifier}</button>
        {' · '}{nfcTypeLabel(device.device_type)} · {formatDateTime(device.last_used_at)}
      </li>)}</ul>
    </div>}

    <div className="nfc-filter-section">
      <div className="object-filterbar nfc-quick-filters">
        <input aria-label="NFC-Kennung suchen" placeholder="NFC-Kennung suchen" value={searchInput}
          onChange={event=>{setSearchInput(event.target.value);setPage(1);}}/>
        <label>Status<select aria-label="Status" value={filters.status} onChange={event=>changeFilter('status',event.target.value)}>
          <option value="">Alle Status</option>
          {['active','blocked','lost','replaced'].map(status=><option key={status} value={status}>{nfcStatusLabel(status)}</option>)}
        </select></label>
        <label>Zuordnung<select aria-label="Zuordnung" value={filters.assignment} onChange={event=>changeFilter('assignment',event.target.value)}>
          <option value="">Alle</option><option value="assigned">Zugewiesen</option><option value="unassigned">Nicht zugewiesen</option>
        </select></label>
        <label>Verwendung<select aria-label="Verwendung" value={filters.recent} onChange={event=>changeFilter('recent',event.target.value)}>
          <option value="">Alle Geräte</option><option value="true">Kürzlich verwendet</option>
        </select></label>
        <button type="button" aria-expanded={showAdvanced} onClick={()=>setShowAdvanced(current=>!current)}>
          {showAdvanced?'Weniger Filter':'Erweiterte Filter'}
        </button>
      </div>
      {showAdvanced&&<div className="object-filterbar nfc-advanced-filters">
        <label>Gerätetyp<select aria-label="Gerätetyp" value={filters.device_type} onChange={event=>changeFilter('device_type',event.target.value)}>
          <option value="">Alle Typen</option><option value="tag">NFC-Tag</option><option value="reader">Lesegerät</option>
        </select></label>
        <label>Objekt<select aria-label="Objekt" value={filters.site_id} onChange={event=>changeFilter('site_id',event.target.value)}>
          <option value="">Alle Objekte</option>
          {options.sites.map(site=><option key={site.id} value={site.id}>{site.name}</option>)}
        </select></label>
        <label>Kontrollpunkt<select aria-label="Kontrollpunkt" value={filters.control_point_id} onChange={event=>changeFilter('control_point_id',event.target.value)}>
          <option value="">Alle Kontrollpunkte</option>
          {options.control_points.map(point=><option key={point.id} value={point.id}>{point.site_name?`${point.site_name} · ${point.name}`:point.name}</option>)}
        </select></label>
        <label>Mitarbeiter<select aria-label="Mitarbeiter" value={filters.employee_id} onChange={event=>changeFilter('employee_id',event.target.value)}>
          <option value="">Alle Mitarbeiter</option>
          {options.employees.map(employee=><option key={employee.id} value={employee.id}>{employee.name}</option>)}
        </select></label>
        <label>Archivierung<select aria-label="Archivierung" value={filters.archived} onChange={event=>changeFilter('archived',event.target.value)}>
          <option value="">Alle Geräte</option><option value="false">Nicht archiviert</option><option value="true">Archiviert</option>
        </select></label>
        <label>Ersatzstatus<select aria-label="Ersatzstatus" value={filters.replaced} onChange={event=>changeFilter('replaced',event.target.value)}>
          <option value="">Alle Geräte</option><option value="true">Ersetzt</option>
        </select></label>
      </div>}
      <div className="nfc-filter-footer">
        <div className="nfc-active-filters" aria-label="Aktive Filter">
          {activeFilters.length?activeFilters.map(([key,value])=><button key={key} type="button" className="object-chip"
            onClick={()=>changeFilter(key,'')} aria-label={`${labels[key]} entfernen`}>
            {labels[key]}: {value==='true'?'Ja':value==='false'?'Nein':value} ×
          </button>):<span>Keine aktiven Filter</span>}
        </div>
        <div className="nfc-result-meta">
          <strong>{formatNumber(total)}</strong> Treffer
          <label>Einträge pro Seite <select aria-label="Einträge pro Seite" value={pageSize}
            onChange={event=>{setPageSize(Number(event.target.value));setPage(1);}}>
            {[5,10,25,50,100].map(value=><option key={value} value={value}>{value}</option>)}
          </select></label>
          {activeFilters.length>0&&<button type="button" onClick={resetAll}>Filter zurücksetzen</button>}
        </div>
      </div>
    </div>

    <div className="object-table">
      <table>
        <thead><tr>
          <th><SortButton label="NFC-Kennung" field="identifier" sort={sort} dir={dir} onSort={changeSort}/></th>
          <th><SortButton label="Gerätetyp" field="device_type" sort={sort} dir={dir} onSort={changeSort}/></th>
          <th><SortButton label="Hersteller" field="manufacturer" sort={sort} dir={dir} onSort={changeSort}/></th>
          <th><SortButton label="Objekt" field="site_name" sort={sort} dir={dir} onSort={changeSort}/></th>
          <th><SortButton label="Kontrollpunkt" field="control_point_name" sort={sort} dir={dir} onSort={changeSort}/></th>
          <th><SortButton label="Mitarbeiter" field="employee_name" sort={sort} dir={dir} onSort={changeSort}/></th>
          <th><SortButton label="Status" field="status" sort={sort} dir={dir} onSort={changeSort}/></th>
          <th><SortButton label="Registriert" field="registered_at" sort={sort} dir={dir} onSort={changeSort}/></th>
          <th><SortButton label="Letzte Verwendung" field="last_used_at" sort={sort} dir={dir} onSort={changeSort}/></th>
          <th>Aktionen</th>
        </tr></thead>
        <tbody>
          {loading&&<tr><td className="object-empty" colSpan={10} role="status">{commonText.loading}</td></tr>}
          {!loading&&!items.length&&<tr><td className="object-empty" colSpan={10}>{commonText.noData}</td></tr>}
          {!loading&&items.map(device=><tr key={device.id} tabIndex={0}
            onClick={()=>navigate(`/nfc-devices/${device.id}`)}
            onKeyDown={event=>{if(event.key==='Enter')navigate(`/nfc-devices/${device.id}`);}}>
            <td data-label="NFC-Kennung"><strong>{device.identifier}</strong></td>
            <td data-label="Gerätetyp">{nfcTypeLabel(device.device_type)}</td>
            <td data-label="Hersteller">{device.manufacturer}</td>
            <td data-label="Objekt">{device.site_name??'–'}</td>
            <td data-label="Kontrollpunkt">{device.control_point_name??'–'}</td>
            <td data-label="Mitarbeiter">{device.employee_name??'–'}</td>
            <td data-label="Status"><span className={nfcStatusClass(device.status)}>{nfcStatusText(device)}</span></td>
            <td data-label="Registriert">{formatDate(device.registered_at)}</td>
            <td data-label="Letzte Verwendung">{device.last_used_at?formatDateTime(device.last_used_at):'Noch kein Scan'}</td>
            <td data-label="Aktionen" onClick={event=>event.stopPropagation()}>
              <button type="button" onClick={()=>navigate(`/nfc-devices/${device.id}`)}>Akte</button>
              {canWrite&&<button type="button" onClick={()=>openDialog('edit',device)}>Bearbeiten</button>}
              {canSecurity&&nfcCanBlock(device)&&<button type="button" onClick={()=>openDialog('block',device)}>Sperren</button>}
              {canSecurity&&nfcIsAssignable(device)&&<button type="button" onClick={()=>openDialog('lost',device)}>Verlust melden</button>}
              {canSecurity&&nfcCanReplace(device)&&<button type="button" onClick={()=>openDialog('replace',device)}>Ersatz</button>}
              {canSecurity&&nfcCanRecover(device)&&<button type="button" onClick={()=>openDialog('recover',device)}>Wieder in Betrieb</button>}
              {canSecurity&&nfcCanReactivate(device)&&<button type="button" onClick={()=>openDialog('reactivate',device)}>Reaktivieren</button>}
              {canSecurity&&!device.archived_at&&<button type="button" onClick={()=>openDialog('archive',device)}>Archivieren</button>}
            </td>
          </tr>)}
        </tbody>
      </table>
    </div>
    <div className="object-pagination">
      <button type="button" disabled={page<=1} onClick={()=>setPage(value=>value-1)}>← Zurück</button>
      <span>Seite {page} von {totalPages} · {formatNumber(total)} Geräte</span>
      <button type="button" disabled={page>=totalPages} onClick={()=>setPage(value=>value+1)}>Weiter →</button>
    </div>

    {(dialog==='create'||dialog==='edit')&&<NfcDialog title={dialog==='create'?'NFC-Gerät registrieren':'NFC-Gerät bearbeiten'} onClose={()=>setDialog(null)} wide>
      <form className="object-detail-form" onSubmit={event=>{event.preventDefault();saveForm();}}>
        <NfcFormFields value={form} onChange={setForm} options={options}
          showAssignment={dialog==='create'||Boolean(selected&&nfcIsAssignable(selected))}/>
        {dialogError&&<p className="object-warning" role="alert">{dialogError}</p>}
        <div className="object-actions">
          <button type="submit" disabled={busy}>{busy?'Wird gespeichert …':commonText.save}</button>
          <button type="button" onClick={()=>setDialog(null)}>{commonText.cancel}</button>
        </div>
      </form>
    </NfcDialog>}

    {dialog==='block'&&selected&&<NfcReasonDialog title="NFC-Gerät sperren"
      description={`${selected.identifier} wird sofort für neue Kontrollgang-Scans gesperrt.`}
      reason={reason} onReason={setReason} error={dialogError} busy={busy} confirmLabel="Sperren"
      onConfirm={()=>{if(reason.trim().length<3){setDialogError(commonText.reasonRequired);return;}runStatus('block',{reason:reason.trim()},'NFC-Gerät wurde gesperrt.');}}
      onClose={()=>setDialog(null)}/>}

    {dialog==='lost'&&selected&&<NfcReasonDialog title="Verlust melden"
      description={`${selected.identifier} wird als verloren markiert und für Scans gesperrt.`}
      date={lostDate} onDate={setLostDate} reason={reason} onReason={setReason}
      error={dialogError} busy={busy} confirmLabel="Verlust melden"
      onConfirm={()=>{
        if(!lostDate){setDialogError('Bitte ein Verlustdatum angeben.');return;}
        if(reason.trim().length<3){setDialogError(commonText.reasonRequired);return;}
        runStatus('report-lost',{lost_at:lostDate,reason:reason.trim()},'Verlust wurde dokumentiert.');
      }} onClose={()=>setDialog(null)}/>}

    {dialog==='reactivate'&&selected&&<NfcReasonDialog title="NFC-Gerät reaktivieren"
      description={`${selected.identifier} darf nach der Reaktivierung wieder für gültige Scans verwendet werden.`}
      reason={reason} onReason={setReason} error={dialogError} busy={busy} confirmLabel="Reaktivieren"
      onConfirm={()=>{if(reason.trim().length<3){setDialogError(commonText.reasonRequired);return;}runStatus('reactivate',{reason:reason.trim()},'NFC-Gerät wurde reaktiviert.');}}
      onClose={()=>setDialog(null)}/>}

    {dialog==='recover'&&selected&&<NfcRecoverDialog
      identifier={selected.identifier} assignment={nfcAssignmentLabel(selected)}
      identifierConfirmation={recover.identifier_confirmation}
      onIdentifierConfirmation={value=>setRecover(current=>({...current,identifier_confirmation:value}))}
      reason={recover.reason} onReason={value=>setRecover(current=>({...current,reason:value}))}
      foundAt={recover.found_at} onFoundAt={value=>setRecover(current=>({...current,found_at:value}))}
      error={dialogError} busy={busy}
      onConfirm={confirmed=>{
        if(!recover.found_at){setDialogError('Bitte ein Wiederauffindungsdatum angeben.');return;}
        if(recover.identifier_confirmation.trim()!==selected.identifier){setDialogError('Die bestätigte NFC-Kennung stimmt nicht überein.');return;}
        if(!confirmed){setDialogError('Bitte Identität und Zuordnung bestätigen.');return;}
        if(recover.reason.trim().length<3){setDialogError(commonText.reasonRequired);return;}
        runStatus('recover',{found_at:recover.found_at,identifier_confirmation:recover.identifier_confirmation.trim(),
          assignment_confirmed:true,reason:recover.reason.trim()},'Gerät wurde wieder in Betrieb genommen und ist zunächst gesperrt.');
      }} onClose={()=>setDialog(null)}/>}

    {dialog==='archive'&&selected&&<NfcReasonDialog title="NFC-Gerät archivieren"
      description={`${selected.identifier} wird dauerhaft außer Betrieb genommen. Bestehende Scans und Nachweise bleiben erhalten.`}
      reason={reason} onReason={setReason} error={dialogError} busy={busy} confirmLabel="Archivieren"
      onConfirm={()=>{if(reason.trim().length<3){setDialogError(commonText.reasonRequired);return;}runStatus('archive',{reason:reason.trim()},'NFC-Gerät wurde archiviert.');}}
      onClose={()=>setDialog(null)}/>}

    {dialog==='replace'&&selected&&replacementSummary&&replacementSnapshot&&<NfcReplaceDialog
      identifier={replacement.identifier} onIdentifier={value=>changeReplacement({identifier:value})}
      deviceType={replacement.device_type} onDeviceType={value=>changeReplacement({device_type:value})}
      manufacturer={replacement.manufacturer} onManufacturer={value=>changeReplacement({manufacturer:value})}
      model={replacement.model} onModel={value=>changeReplacement({model:value})}
      serialNumber={replacement.serial_number} onSerialNumber={value=>changeReplacement({serial_number:value})}
      description={replacement.description} onDescription={value=>changeReplacement({description:value})}
      mode={replacement.mode} onMode={value=>changeReplacement({mode:value})}
      existingDeviceId={replacement.existing_device_id}
      onExistingDeviceId={value=>changeReplacement({existing_device_id:value})}
      devices={(options.devices??[]).filter(device=>device.id!==selected.id)}
      summary={replacementSummary}
      reason={replacement.reason} onReason={value=>changeReplacement({reason:value})}
      notes={replacement.notes} onNotes={value=>changeReplacement({notes:value})}
      copyAssignment={replacement.copy_assignment} onCopyAssignment={value=>changeReplacement({copy_assignment:value})}
      acknowledgeExisting={replacement.acknowledge_existing}
      onAcknowledgeExisting={value=>changeReplacement({acknowledge_existing:value})}
      acknowledgeRestricted={replacement.acknowledge_restricted}
      onAcknowledgeRestricted={value=>changeReplacement({acknowledge_restricted:value})}
      confirmed={replaceConfirmed}
      onConfirmed={value=>setReplaceConfirmation(value?replacementSnapshot:null)}
      error={dialogError} busy={busy}
      onConfirm={()=>{
        if(!nfcReplaceIsConfirmed(replacement,replacementSummary,replaceConfirmation)){
          setDialogError('Die Zusammenfassung hat sich geändert. Bitte erneut prüfen und bestätigen.');return;
        }
        const validation=validateNfcReplace(replacement,candidate);
        if(validation){setDialogError(validation);return;}
        runStatus('replace',nfcReplacePayload(replacement,candidate),'Austausch wurde dokumentiert.');
      }} onClose={()=>setDialog(null)}/>}
  </section>;
}
