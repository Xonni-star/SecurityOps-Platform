import {useEffect,useMemo,useState} from 'react';
import {useNavigate} from 'react-router-dom';
import {api,hasPermission} from '../lib/api';
import {formatDate,formatDateTime,formatNumber} from '../lib/format';
import {commonText} from '../lib/text';
import {
  emptyNfcForm,nfcAssignmentLabel,nfcFormFromDevice,nfcMessage,nfcPayloadFromForm,nfcStatusClass,nfcStatusLabel,nfcStatusText,nfcTypeLabel,
  NfcDialog,NfcFormFields,NfcKpiCard,NfcReasonDialog,NfcRecoverDialog,NfcReplaceDialog,validateNfcForm,
  type NfcDevice,type NfcForm,type NfcOptions,type NfcOverview,
} from './nfcParts';

type Filters={
  q:string;device_type:string;status:string;site_id:string;control_point_id:string;employee_id:string;assignment:string;
  archived:string;recent:string;
};
type DialogKind='create'|'edit'|'block'|'lost'|'replace'|'reactivate'|'recover'|'archive'|null;

const emptyFilters:Filters={q:'',device_type:'',status:'',site_id:'',control_point_id:'',employee_id:'',assignment:'',archived:'',recent:''};
const emptyOptions:NfcOptions={sites:[],control_points:[],employees:[]};
const today=new Date().toISOString().slice(0,10);

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
  const [items,setItems]=useState<NfcDevice[]>([]);
  const [overview,setOverview]=useState<NfcOverview|null>(null);
  const [options,setOptions]=useState<NfcOptions>(emptyOptions);
  const [filters,setFilters]=useState<Filters>(emptyFilters);
  const [sort,setSort]=useState('updated_at');
  const [dir,setDir]=useState<'asc'|'desc'>('desc');
  const [page,setPage]=useState(1);
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
  const [replacement,setReplacement]=useState({identifier:'',device_type:'tag',manufacturer:'',mode:'new' as 'new'|'existing',
    existing_device_id:'',reason:'',notes:'',copy_assignment:true});
  const [recover,setRecover]=useState({found_at:today,identifier_confirmation:'',reason:''});
  const [dialogError,setDialogError]=useState('');
  const [busy,setBusy]=useState(false);

  const queryString=useMemo(()=>{
    const params=new URLSearchParams();
    for(const [key,value] of Object.entries(filters))if(value)params.set(key,value);
    params.set('sort',sort);params.set('dir',dir);params.set('page',String(page));params.set('pageSize','25');
    return params.toString();
  },[filters,sort,dir,page]);

  const load=async()=>{
    if(!canRead)return;
    setLoading(true);
    try{
      const [inventory,metrics]=await Promise.all([
        api<{rows:NfcDevice[];total:number;totalPages:number}>(`/nfc-devices/inventory?${queryString}`),
        api<NfcOverview>('/nfc-devices/overview'),
      ]);
      setItems(inventory?.rows??[]);
      setTotal(Number(inventory?.total??0));
      setTotalPages(Number(inventory?.totalPages??1));
      setOverview(metrics??null);
      setError('');
    }catch(cause){setError(nfcMessage(cause));}
    finally{setLoading(false);}
  };

  useEffect(()=>{void load();},[canRead,queryString]);
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

  const openDialog=(kind:Exclude<DialogKind,null>,device?:NfcDevice)=>{
    setError('');setSuccess('');setDialogError('');setBusy(false);setDialog(kind);
    if(kind==='create')setForm(emptyNfcForm());
    if(kind==='edit'&&device){setSelected(device);setForm(nfcFormFromDevice(device));}
    if(kind!=='create'&&kind!=='edit'&&device){
      setSelected(device);setReason('');setLostDate(today);
      setReplacement({identifier:'',device_type:device.device_type,manufacturer:device.manufacturer,mode:'new',
        existing_device_id:'',reason:'',notes:'',copy_assignment:true});
      setRecover({found_at:today,identifier_confirmation:'',reason:''});
    }
  };

  const execute=async(action:()=>Promise<void>,successText:string)=>{
    setDialogError('');setBusy(true);
    try{
      await action();
      setSuccess(successText);setError('');setDialog(null);
      await load();
    }catch(cause){setDialogError(nfcMessage(cause));}
    finally{setBusy(false);}
  };

  const saveForm=()=>{
    const validation=validateNfcForm(form);
    if(validation){setDialogError(validation);return;}
    const payload=nfcPayloadFromForm(form);
    if(dialog==='create'){
      void execute(async()=>{await api('/nfc-devices',{method:'POST',body:JSON.stringify(payload)});},'NFC-Gerät wurde registriert.');
    }else if(selected){
      void execute(async()=>{await api(`/nfc-devices/${selected.id}`,{method:'PATCH',body:JSON.stringify(payload)});},'NFC-Gerät wurde gespeichert.');
    }
  };

  const runStatus=(action:string,body:Record<string,unknown>,successText:string)=>{
    if(!selected)return;
    void execute(async()=>{await api(`/nfc-devices/${selected.id}/${action}`,{method:'POST',body:JSON.stringify(body)});},successText);
  };

  if(!canRead)return <section className="object-management"><h2>NFC-Geräte</h2><p>{commonText.noPermission}</p></section>;

  const filtersActive=Object.values(filters).some(Boolean);
  return <section className="object-management">
    <div className="object-page-header">
      <div>
        <p className="object-eyebrow">Verwaltung · NFC-Geräte</p>
        <h2>NFC-Geräteverwaltung</h2>
        <p>Tags und Lesegeräte registrieren, zuordnen, sperren und nachvollziehbar verwalten.</p>
      </div>
      <div className="object-page-actions">
        {canWrite&&<button type="button" onClick={()=>openDialog('create')}>NFC-Gerät registrieren</button>}
      </div>
    </div>

    {error&&<p className="object-warning" role="alert">{error}</p>}
    {success&&<p className="object-success" role="status">{success}</p>}

    <div className="object-summary-grid object-metrics">
      <NfcKpiCard label="Registrierte Geräte" value={overview?.total??0} onClick={()=>{setFilters(emptyFilters);setPage(1);}}/>
      <NfcKpiCard label="Aktive NFC-Tags" value={overview?.active_tags??0} hint="Für Kontrollpunkte nutzbar"
        onClick={()=>{setFilters({...emptyFilters,status:'active',device_type:'tag'});setPage(1);}}/>
      <NfcKpiCard label="Aktive Lesegeräte" value={overview?.active_readers??0}
        onClick={()=>{setFilters({...emptyFilters,status:'active',device_type:'reader'});setPage(1);}}/>
      <NfcKpiCard label="Gesperrt" value={overview?.blocked??0} onClick={()=>{setFilters({...emptyFilters,status:'blocked'});setPage(1);}}/>
      <NfcKpiCard label="Verloren" value={overview?.lost??0} onClick={()=>{setFilters({...emptyFilters,status:'lost'});setPage(1);}}/>
      <NfcKpiCard label="Ersetzt" value={overview?.replaced??0} onClick={()=>{setFilters({...emptyFilters,status:'replaced'});setPage(1);}}/>
      <NfcKpiCard label="Archiviert" value={overview?.archived??0} onClick={()=>{setFilters({...emptyFilters,archived:'true'});setPage(1);}}/>
      <NfcKpiCard label="Ohne Zuordnung" value={overview?.unassigned??0} onClick={()=>{setFilters({...emptyFilters,assignment:'unassigned'});setPage(1);}}/>
      <NfcKpiCard label="Kürzlich verwendet" value={overview?.recent_devices??0} hint={`Geräte mit Scans in ${overview?.days??30} Tagen`}
        onClick={()=>{setFilters({...emptyFilters,recent:'true'});setPage(1);}}/>
      <NfcKpiCard label={`Scans (${overview?.days??30} Tage)`} value={overview?.scans??0} hint="Tatsächlich erfasste Kontrollgänge"/>
    </div>

    {!!overview?.recent.length&&<div className="object-detail-content">
      <h3>Zuletzt verwendete NFC-Geräte</h3>
      <ul>{overview.recent.map(device=><li key={device.id}>
        <button type="button" onClick={()=>navigate(`/nfc-devices/${device.id}`)}>{device.identifier}</button>
        {' · '}{nfcTypeLabel(device.device_type)} · {formatDateTime(device.last_used_at)}
      </li>)}</ul>
    </div>}

    <div className="object-filterbar">
      <input aria-label="NFC-Kennung suchen" placeholder="NFC-Kennung suchen" value={filters.q}
        onChange={event=>changeFilter('q',event.target.value)}/>
      <label>Gerätetyp<select value={filters.device_type} onChange={event=>changeFilter('device_type',event.target.value)}>
        <option value="">Alle Typen</option><option value="tag">NFC-Tag</option><option value="reader">Lesegerät</option>
      </select></label>
      <label>Status<select value={filters.status} onChange={event=>changeFilter('status',event.target.value)}>
        <option value="">Alle Status</option>
        {['active','blocked','lost','replaced'].map(status=><option key={status} value={status}>{nfcStatusLabel(status)}</option>)}
      </select></label>
      <label>Objekt<select value={filters.site_id} onChange={event=>changeFilter('site_id',event.target.value)}>
        <option value="">Alle Objekte</option>
        {options.sites.map(site=><option key={site.id} value={site.id}>{site.name}</option>)}
      </select></label>
      <label>Kontrollpunkt<select value={filters.control_point_id} onChange={event=>changeFilter('control_point_id',event.target.value)}>
        <option value="">Alle Kontrollpunkte</option>
        {options.control_points.map(point=><option key={point.id} value={point.id}>{point.site_name?`${point.site_name} · ${point.name}`:point.name}</option>)}
      </select></label>
      <label>Mitarbeiter<select value={filters.employee_id} onChange={event=>changeFilter('employee_id',event.target.value)}>
        <option value="">Alle Mitarbeiter</option>
        {options.employees.map(employee=><option key={employee.id} value={employee.id}>{employee.name}</option>)}
      </select></label>
      <label>Zuordnung<select value={filters.assignment} onChange={event=>changeFilter('assignment',event.target.value)}>
        <option value="">Alle</option><option value="assigned">Zugewiesen</option><option value="unassigned">Nicht zugewiesen</option>
      </select></label>
      <label>Archivierung<select value={filters.archived} onChange={event=>changeFilter('archived',event.target.value)}>
        <option value="">Alle Geräte</option><option value="false">Nicht archiviert</option><option value="true">Archiviert</option>
      </select></label>
      <label>Verwendung<select value={filters.recent} onChange={event=>changeFilter('recent',event.target.value)}>
        <option value="">Alle Geräte</option><option value="true">Kürzlich verwendet</option>
      </select></label>
      {filtersActive&&<button type="button" onClick={()=>{setFilters(emptyFilters);setPage(1);}}>Filter zurücksetzen</button>}
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
            <td><strong>{device.identifier}</strong></td>
            <td>{nfcTypeLabel(device.device_type)}</td>
            <td>{device.manufacturer}</td>
            <td>{device.site_name??'–'}</td>
            <td>{device.control_point_name??'–'}</td>
            <td>{device.employee_name??'–'}</td>
            <td><span className={nfcStatusClass(device.status)}>{nfcStatusText(device)}</span></td>
            <td>{formatDate(device.registered_at)}</td>
            <td>{device.last_used_at?formatDateTime(device.last_used_at):'Noch kein Scan'}</td>
            <td onClick={event=>event.stopPropagation()}>
              <button type="button" onClick={()=>navigate(`/nfc-devices/${device.id}`)}>Akte</button>
              {canWrite&&<button type="button" onClick={()=>openDialog('edit',device)}>Bearbeiten</button>}
              {canSecurity&&!device.archived_at&&['active','lost'].includes(device.status)&&<button type="button" onClick={()=>openDialog('block',device)}>Sperren</button>}
              {canSecurity&&device.status==='active'&&!device.archived_at&&<button type="button" onClick={()=>openDialog('lost',device)}>Verlust melden</button>}
              {canSecurity&&(device.status==='lost'||device.status==='blocked'||device.status==='replaced')&&<button type="button" onClick={()=>openDialog('replace',device)}>Ersatz</button>}
              {canSecurity&&(device.status==='lost'||device.archived_at)&&<button type="button" onClick={()=>openDialog('recover',device)}>Wieder in Betrieb</button>}
              {canSecurity&&device.status==='blocked'&&!device.archived_at&&<button type="button" onClick={()=>openDialog('reactivate',device)}>Reaktivieren</button>}
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
        <NfcFormFields value={form} onChange={setForm} options={options}/>
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

    {dialog==='replace'&&selected&&<NfcReplaceDialog
      identifier={replacement.identifier} onIdentifier={value=>setReplacement(current=>({...current,identifier:value}))}
      deviceType={replacement.device_type} onDeviceType={value=>setReplacement(current=>({...current,device_type:value}))}
      manufacturer={replacement.manufacturer} onManufacturer={value=>setReplacement(current=>({...current,manufacturer:value}))}
      mode={replacement.mode} onMode={value=>setReplacement(current=>({...current,mode:value}))}
      existingDeviceId={replacement.existing_device_id}
      onExistingDeviceId={value=>setReplacement(current=>({...current,existing_device_id:value}))}
      devices={(options.devices??[]).filter(device=>device.id!==selected.id)}
      reason={replacement.reason} onReason={value=>setReplacement(current=>({...current,reason:value}))}
      notes={replacement.notes} onNotes={value=>setReplacement(current=>({...current,notes:value}))}
      copyAssignment={replacement.copy_assignment} onCopyAssignment={value=>setReplacement(current=>({...current,copy_assignment:value}))}
      error={dialogError} busy={busy}
      onConfirm={()=>{
        if(replacement.reason.trim().length<3){setDialogError(commonText.reasonRequired);return;}
        if(replacement.mode==='new'&&(!replacement.identifier.trim()||!replacement.manufacturer.trim())){
          setDialogError('Bitte Kennung und Hersteller des Ersatzgeräts angeben.');return;
        }
        if(replacement.mode==='existing'&&!replacement.existing_device_id){
          setDialogError('Bitte ein vorhandenes Ersatzgerät auswählen.');return;
        }
        const payload=replacement.mode==='existing'
          ?{new_device_id:replacement.existing_device_id,reason:replacement.reason.trim(),notes:replacement.notes.trim(),copy_assignment:replacement.copy_assignment}
          :{identifier:replacement.identifier.trim(),device_type:replacement.device_type,manufacturer:replacement.manufacturer.trim(),
            reason:replacement.reason.trim(),notes:replacement.notes.trim(),copy_assignment:replacement.copy_assignment};
        runStatus('replace',payload,'Austausch wurde dokumentiert.');
      }} onClose={()=>setDialog(null)}/>}
  </section>;
}
