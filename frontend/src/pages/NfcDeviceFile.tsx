import {useCallback,useEffect,useState} from 'react';
import {useNavigate,useParams} from 'react-router-dom';
import {api,csrf,hasPermission} from '../lib/api';
import {formatDate,formatDateTime} from '../lib/format';
import {auditEventLabel,commonText,historyDetailText} from '../lib/text';
import {
  emptyNfcForm,nfcAssignmentDetail,nfcAssignmentLabel,nfcFormFromDevice,nfcMessage,nfcPayloadFromForm,
  nfcScanAuthenticationLabel,nfcScanOutcome,nfcStatusClass,nfcStatusLabel,nfcStatusText,nfcTypeLabel,NfcDialog,NfcFormFields,NfcReasonDialog,
  NfcAssignmentFields,NfcRecoverDialog,NfcReplaceDialog,NfcTimeline,validateNfcForm,
  type NfcDocument,type NfcFileData,type NfcForm,type NfcOptions,type NfcScanRecord,
} from './nfcParts';

type Section='uebersicht'|'stammdaten'|'zuordnung'|'scans'|'verlauf'|'dokumente';
type ScanFilters={from:string;to:string;control_point_id:string;site_id:string;employee_id:string;outcome:string};
type ScanPage={rows:NfcScanRecord[];total:number;page:number;pageSize:number;totalPages:number};

const sections:{id:Section;label:string}[]=[
  {id:'uebersicht',label:'Übersicht'},
  {id:'stammdaten',label:'Technische Stammdaten'},
  {id:'zuordnung',label:'Zuordnung'},
  {id:'scans',label:'Scan-Historie'},
  {id:'verlauf',label:'Status & Ereignisse'},
  {id:'dokumente',label:'Dokumente'},
];

const emptyOptions:NfcOptions={sites:[],control_points:[],employees:[]};
const emptyScanFilters:ScanFilters={from:'',to:'',control_point_id:'',site_id:'',employee_id:'',outcome:''};
const emptyScanPage:ScanPage={rows:[],total:0,page:1,pageSize:25,totalPages:1};
const today=new Date().toISOString().slice(0,10);

export function NfcDeviceFile(){
  const {deviceId}=useParams();
  const navigate=useNavigate();
  const canWrite=hasPermission('nfc_devices:write');
  const canSecurity=hasPermission('nfc_devices:security');
  const [data,setData]=useState<NfcFileData|null>(null);
  const [options,setOptions]=useState<NfcOptions>(emptyOptions);
  const [section,setSection]=useState<Section>('uebersicht');
  const [form,setForm]=useState<NfcForm>(emptyNfcForm());
  const [assignment,setAssignment]=useState<NfcForm>(emptyNfcForm());
  const [assignmentReason,setAssignmentReason]=useState('');
  const [dialog,setDialog]=useState<'edit'|'block'|'lost'|'replace'|'reactivate'|'recover'|'archive'|null>(null);
  const [reason,setReason]=useState('');
  const [lostDate,setLostDate]=useState(today);
  const [replacement,setReplacement]=useState({identifier:'',device_type:'tag',manufacturer:'',mode:'new' as 'new'|'existing',
    existing_device_id:'',reason:'',notes:'',copy_assignment:false,acknowledge_existing:false,acknowledge_restricted:false});
  const [recover,setRecover]=useState({found_at:today,identifier_confirmation:'',reason:''});
  const [scanFilters,setScanFilters]=useState<ScanFilters>(emptyScanFilters);
  const [scanPage,setScanPage]=useState(1);
  const [scanData,setScanData]=useState<ScanPage>(emptyScanPage);
  const [scanLoading,setScanLoading]=useState(false);
  const [scanError,setScanError]=useState('');
  const [error,setError]=useState('');
  const [success,setSuccess]=useState('');
  const [dialogError,setDialogError]=useState('');
  const [busy,setBusy]=useState(false);

  const load=async()=>{
    if(!deviceId)return;
    try{
      const value=await api<NfcFileData>(`/nfc-devices/${deviceId}/file`);
      setData(value??null);
      if(value?.device){
        setForm(nfcFormFromDevice(value.device));
        setAssignment(nfcFormFromDevice(value.device));
      }
      setError('');
    }catch(cause){setError(nfcMessage(cause));}
  };

  useEffect(()=>{void load();},[deviceId]);
  useEffect(()=>{
    void api<NfcOptions>('/nfc-devices/filter-options').then(value=>setOptions(value??emptyOptions)).catch(()=>undefined);
  },[]);

  const loadScans=useCallback(async()=>{
    if(!deviceId)return;
    setScanLoading(true);
    try{
      const params=new URLSearchParams({page:String(scanPage),pageSize:'25'});
      for(const [key,value] of Object.entries(scanFilters))if(value)params.set(key,value);
      const value=await api<ScanPage>(`/nfc-devices/${deviceId}/scan-history?${params.toString()}`);
      setScanData(value??emptyScanPage);
      setScanError('');
    }catch(cause){setScanError(nfcMessage(cause));}
    finally{setScanLoading(false);}
  },[deviceId,scanPage,scanFilters]);

  useEffect(()=>{
    if(section==='scans')void loadScans();
  },[section,loadScans]);

  const run=async(action:()=>Promise<void>,successText:string)=>{
    setError('');setSuccess('');setDialogError('');setBusy(true);
    try{await action();setSuccess(successText);setDialog(null);await load();}
    catch(cause){setDialogError(nfcMessage(cause));}
    finally{setBusy(false);}
  };

  const download=async(document:NfcDocument,versionId:string)=>{
    try{
      const response=await fetch(`/api/v1/dms/documents/${document.id}/versions/${versionId}/download`,{
        credentials:'include',headers:{'x-csrf-token':csrf()},
      });
      if(!response.ok)throw new Error('Der Download ist fehlgeschlagen.');
      const blob=await response.blob();
      const url=URL.createObjectURL(blob);
      const link=window.document.createElement('a');
      link.href=url;
      link.download=`${document.title}-v${document.versions.find(version=>version.id===versionId)?.version_no??1}`;
      link.click();
      URL.revokeObjectURL(url);
    }catch(cause){setError((cause as Error).message||'Der Download ist fehlgeschlagen.');}
  };

  if(!data)return <section className="object-management">
    <button type="button" className="object-back" onClick={()=>navigate('/nfc-devices')}>← {commonText.backToOverview}</button>
    <p role="status">{error||commonText.loading}</p>
  </section>;

  const device=data.device;
  const open=(kind:Exclude<typeof dialog,null>)=>{
    setError('');setSuccess('');setDialogError('');setReason('');setLostDate(today);setDialog(kind);
    setForm(nfcFormFromDevice(device));
    setReplacement({identifier:'',device_type:device.device_type,manufacturer:device.manufacturer,mode:'new',
      existing_device_id:'',reason:'',notes:'',copy_assignment:false,acknowledge_existing:false,acknowledge_restricted:false});
    setRecover({found_at:today,identifier_confirmation:'',reason:''});
  };

  const saveMaster=()=>{
    const validation=validateNfcForm(form);
    if(validation){setDialogError(validation);return;}
    void run(async()=>{await api(`/nfc-devices/${device.id}`,{method:'PATCH',body:JSON.stringify(nfcPayloadFromForm(form))});},'Stammdaten wurden gespeichert.');
  };

  const saveAssignment=()=>{
    const kind=assignment.assignment_kind;
    let body:Record<string,unknown>;
    if(kind==='site')body={site_id:assignment.site_id};
    else if(kind==='control_point')body={control_point_id:assignment.control_point_id};
    else if(kind==='employee')body={employee_id:assignment.employee_id};
    else body={site_id:null};
    if(kind!=='none'&&!Object.values(body)[0]){setDialogError('Bitte ein gültiges Zuordnungsziel auswählen.');return;}
    void run(async()=>{await api(`/nfc-devices/${device.id}/assign`,{method:'POST',body:JSON.stringify({...body,reason:assignmentReason.trim()||undefined})});},'Zuordnung wurde gespeichert.');
  };

  const runStatus=(action:string,body:Record<string,unknown>,successText:string)=>{
    void run(async()=>{await api(`/nfc-devices/${device.id}/${action}`,{method:'POST',body:JSON.stringify(body)});},successText);
  };

  const candidate=(options.devices??[]).find(item=>item.id===replacement.existing_device_id);
  const candidateAssignment=candidate
    ?[candidate.identifier,nfcAssignmentLabel(candidate),nfcStatusLabel(candidate.status)].join(' · ')
    :'Noch kein Ersatzgerät ausgewählt';
  const replacementPayload=()=>{
    const payload:Record<string,unknown>={
      reason:replacement.reason.trim(),notes:replacement.notes.trim(),copy_assignment:replacement.copy_assignment,
    };
    if(replacement.mode==='existing'){
      payload.new_device_id=replacement.existing_device_id;
      if(candidate?.employee_id||candidate?.site_id||candidate?.control_point_id)payload.acknowledge_existing_assignment=true;
      if(candidate&&['lost','blocked'].includes(candidate.status))payload.acknowledge_restricted=true;
    }else{
      payload.identifier=replacement.identifier.trim();
      payload.device_type=replacement.device_type;
      payload.manufacturer=replacement.manufacturer.trim();
    }
    return payload;
  };

  const changeScanFilter=(key:keyof ScanFilters,value:string)=>{
    setScanFilters(current=>({...current,[key]:value}));
    setScanPage(1);
  };

  return <section className="object-management object-detail-page">
    <button type="button" className="object-back" onClick={()=>navigate('/nfc-devices')}>← {commonText.backToOverview}</button>
    <div className="object-detail-header">
      <div>
        <p className="object-eyebrow">Digitale NFC-Geräteakte · {device.identifier}</p>
        <h2>{device.identifier}</h2>
        <div className="object-header-meta">
          <span className={nfcStatusClass(device.status)}>{nfcStatusText(device)}</span>
          <span>{nfcTypeLabel(device.device_type)}</span>
          <span>{device.manufacturer}</span>
          <span>{nfcAssignmentLabel(device)}</span>
          <span>Registriert: {formatDateTime(device.registered_at)}</span>
        </div>
      </div>
      <div className="object-actions">
        {canWrite&&<button type="button" onClick={()=>open('edit')}>Stammdaten bearbeiten</button>}
        {canSecurity&&!device.archived_at&&['active','lost'].includes(device.status)&&<button type="button" onClick={()=>open('block')}>Sperren</button>}
        {canSecurity&&device.status==='active'&&!device.archived_at&&<button type="button" onClick={()=>open('lost')}>Verlust melden</button>}
        {canSecurity&&(device.status==='lost'||device.status==='blocked'||device.status==='replaced')&&<button type="button" onClick={()=>open('replace')}>Ersatzgerät festlegen</button>}
        {canSecurity&&(device.status==='lost'||device.archived_at)&&<button type="button" onClick={()=>open('recover')}>Wieder in Betrieb nehmen</button>}
        {canSecurity&&device.status==='blocked'&&!device.archived_at&&<button type="button" onClick={()=>open('reactivate')}>Reaktivieren</button>}
        {canSecurity&&!device.archived_at&&<button type="button" onClick={()=>open('archive')}>Archivieren</button>}
      </div>
    </div>

    {error&&<p className="object-warning" role="alert">{error}</p>}
    {success&&<p className="object-success" role="status">{success}</p>}

    <div className="object-tabs" role="tablist">
      {sections.map(item=><button key={item.id} type="button" role="tab" aria-selected={section===item.id}
        className={section===item.id?'active':''} onClick={()=>setSection(item.id)}>{item.label}</button>)}
    </div>

    {section==='uebersicht'&&<>
      <div className="object-summary-grid">
        <article><h3>NFC-Kennung</h3><p>{device.identifier}</p></article>
        <article><h3>Gerätetyp</h3><p>{nfcTypeLabel(device.device_type)}</p></article>
        <article><h3>Hersteller</h3><p>{device.manufacturer}</p></article>
        <article><h3>Modell</h3><p>{device.model||commonText.notAvailable}</p></article>
        <article><h3>Seriennummer</h3><p>{device.serial_number||commonText.notAvailable}</p></article>
        <article><h3>Status</h3><p><span className={nfcStatusClass(device.status)}>{nfcStatusText(device)}</span></p></article>
        <article><h3>Zuordnung</h3><p>{nfcAssignmentLabel(device)}</p></article>
        <article><h3>Letzter Scan</h3><p>{device.last_used_at?formatDateTime(device.last_used_at):commonText.notAvailable}</p></article>
        <article><h3>Registriert</h3><p>{formatDateTime(device.registered_at)}</p></article>
        <article><h3>Aktualisiert</h3><p>{formatDateTime(device.updated_at)}</p></article>
      </div>
      <div className="object-detail-content">
        <h3>Beschreibung</h3><p>{device.description||'Keine Beschreibung hinterlegt.'}</p>
        <h3>Interne Notizen</h3><p>{device.notes||'Keine Notizen hinterlegt.'}</p>
        {device.archived_at&&<p><strong>Archiviert:</strong> {formatDateTime(device.archived_at)}
          {device.archived_reason?` · ${device.archived_reason}`:''}</p>}
        {device.recovered_at&&<p><strong>Wiedergefunden:</strong> {formatDateTime(device.recovered_at)}
          {device.recovered_reason?` · ${device.recovered_reason}`:''}</p>}
      </div>
      <div className="object-detail-content"><h3>Zeitachse</h3><NfcTimeline device={device} options={options}/></div>
    </>}

    {section==='stammdaten'&&<div className="object-detail-content">
      <h3>Technische Stammdaten</h3>
      <form className="object-detail-form" onSubmit={event=>{event.preventDefault();saveMaster();}}>
        <NfcFormFields value={form} onChange={setForm} options={options}/>
        {dialogError&&<p className="object-warning" role="alert">{dialogError}</p>}
        <div className="object-actions"><button type="submit" disabled={busy||!canWrite}>{commonText.save}</button></div>
      </form>
    </div>}

    {section==='zuordnung'&&<div className="object-detail-content">
      <h3>Aktuelle Zuordnung</h3>
      <p>{nfcAssignmentLabel(device)}</p>
      <form className="object-detail-form" onSubmit={event=>{event.preventDefault();saveAssignment();}}>
        <NfcAssignmentFields value={assignment} onChange={(value:NfcForm)=>setAssignment({...assignment,...value})} options={options}/>
        <label>Änderungsgrund <input maxLength={2000} value={assignmentReason}
          onChange={event=>setAssignmentReason(event.target.value)} placeholder="Grund der Zuordnung"/></label>
        {dialogError&&<p className="object-warning" role="alert">{dialogError}</p>}
        <div className="object-actions"><button type="submit" disabled={busy||!canWrite}>Zuordnung speichern</button></div>
      </form>
      <h4>Zuordnungshistorie</h4>
      {data.assignment_history.length?<ul>{data.assignment_history.map(event=><li key={event.id}>
        <time>{formatDateTime(event.assigned_at)}</time>: {nfcAssignmentDetail(event.previous_assignment,options)} → {nfcAssignmentDetail(event.assignment,options)}
        {` · Ausgeführt: ${event.actor_email??'Unbekannt'}`}
        {event.reason?` · ${event.reason}`:''}
      </li>)}</ul>:<p>{commonText.noData}</p>}
    </div>}

    {section==='scans'&&<div className="object-detail-content">
      <h3>Scan-Historie</h3>
      <div className="object-filterbar">
        <label>Von <input type="date" aria-label="Scanzeit von" value={scanFilters.from}
          onChange={event=>changeScanFilter('from',event.target.value)}/></label>
        <label>Bis <input type="date" aria-label="Scanzeit bis" value={scanFilters.to}
          onChange={event=>changeScanFilter('to',event.target.value)}/></label>
        <label>Kontrollpunkt <select aria-label="Kontrollpunkt filtern" value={scanFilters.control_point_id}
          onChange={event=>changeScanFilter('control_point_id',event.target.value)}>
          <option value="">Alle Kontrollpunkte</option>
          {options.control_points.map(point=><option key={point.id} value={point.id}>{point.name}</option>)}
        </select></label>
        <label>Objekt <select aria-label="Objekt filtern" value={scanFilters.site_id}
          onChange={event=>changeScanFilter('site_id',event.target.value)}>
          <option value="">Alle Objekte</option>
          {options.sites.map(site=><option key={site.id} value={site.id}>{site.name}</option>)}
        </select></label>
        <label>Mitarbeiter <select aria-label="Mitarbeiter filtern" value={scanFilters.employee_id}
          onChange={event=>changeScanFilter('employee_id',event.target.value)}>
          <option value="">Alle Mitarbeiter</option>
          {options.employees.map(employee=><option key={employee.id} value={employee.id}>{employee.name}</option>)}
        </select></label>
        <label>Ergebnis <select aria-label="Ergebnis filtern" value={scanFilters.outcome}
          onChange={event=>changeScanFilter('outcome',event.target.value)}>
          <option value="">Alle Ergebnisse</option>
          <option value="accepted">Erfolgreich</option>
          <option value="rejected">Abgelehnt</option>
        </select></label>
        <button type="button" onClick={()=>{setScanFilters(emptyScanFilters);setScanPage(1);}}>Filter zurücksetzen</button>
      </div>
      {scanError&&<p className="object-warning" role="alert">{scanError}</p>}
      <div className="object-table">
        <table>
          <thead><tr><th>Scanzeitpunkt</th><th>NFC-Kennung</th><th>Kontrollpunkt</th><th>Objekt</th><th>Kontrollgang</th>
            <th>Mitarbeiter</th><th>Authentifizierung</th><th>Abweichung</th><th>Ergebnis / Grund</th><th>Servereingang</th></tr></thead>
          <tbody>
            {!scanLoading&&!scanData.rows.length&&<tr><td className="object-empty" colSpan={10}>Keine Scan-Ereignisse für diese Auswahl erfasst.</td></tr>}
            {scanLoading&&<tr><td className="object-empty" colSpan={10}>Scan-Historie wird geladen …</td></tr>}
            {!scanLoading&&scanData.rows.map(scan=><tr key={`${scan.outcome}-${scan.id}`}>
              <td>{scan.scanned_at?formatDateTime(scan.scanned_at):commonText.notAvailable}</td>
              <td>{scan.nfc_uid??commonText.notAvailable}</td>
              <td>{scan.control_point_name??commonText.notAvailable}</td>
              <td>{scan.site_name??commonText.notAvailable}</td>
              <td>{scan.route_name??commonText.notAvailable}</td>
              <td>{scan.employee_name??commonText.notAvailable}</td>
              <td>{nfcScanAuthenticationLabel(scan.scan_authentication)}</td>
              <td>{scan.deviation&&scan.deviation!=='none'?scan.deviation:'Keine'}</td>
              <td>{nfcScanOutcome(scan)}</td>
              <td>{formatDateTime(scan.server_received_at)}</td>
            </tr>)}
          </tbody>
        </table>
      </div>
      <div className="object-pagination">
        <button type="button" disabled={scanPage<=1||scanLoading} onClick={()=>setScanPage(value=>value-1)}>← Zurück</button>
        <span>Seite {scanPage} von {scanData.totalPages} · {scanData.total} Scan-Ereignisse</span>
        <button type="button" disabled={scanPage>=scanData.totalPages||scanLoading} onClick={()=>setScanPage(value=>value+1)}>Weiter →</button>
      </div>
    </div>}

    {section==='verlauf'&&<div className="object-detail-content">
      <h3>Status- und Ereignishistorie</h3>
      {data.history.length?<ul>{data.history.map(event=><li key={event.id}>
        <time>{formatDateTime(event.created_at)}</time>: {auditEventLabel(event.event_type)}
        {` · Ausgeführt: ${event.actor_email??'Unbekannt'}`}
        {Object.entries(event.details??{}).filter(([key])=>!['changed','changed_fields'].includes(key)).map(([key,value])=>
          <div key={key}>{historyDetailText(key,typeof value==='object'&&value!==null?JSON.stringify(value):value)}</div>)}
      </li>)}</ul>:<p>{commonText.noData}</p>}
      <h4>Ersatzhistorie</h4>
      {data.replacements.length?<ul>{data.replacements.map(item=><li key={item.id}>
        <time>{formatDateTime(item.replaced_at)}</time>: {nfcAssignmentDetail(item.old_assignment,options)} → {nfcAssignmentDetail(item.new_assignment,options)}
        {` · Ausgeführt: ${item.actor_email??'Unbekannt'}`}
        {' · '}{item.reason}
        <button type="button" onClick={()=>navigate(`/nfc-devices/${item.new_device_id===device.id?item.old_device_id:item.new_device_id}`)}>
          Geräteakte öffnen
        </button>
      </li>)}</ul>:<p>Kein Ersatzvorgang erfasst.</p>}
    </div>}

    {section==='dokumente'&&<div className="object-detail-content">
      <h3>Dokumente und Unterlagen</h3>
      {data.documents.length?<ul>{data.documents.map(document=><li key={document.id}>
        <strong>{document.title}</strong>
        {document.document_number?` · ${document.document_number}`:''}
        {document.document_type?` · ${document.document_type}`:''}
        {' · '}Erstellt: {formatDate(document.created_at)}
        {document.versions.filter(version=>version.lifecycle_state==='available').map(version=><button key={version.id}
          type="button" onClick={()=>void download(document,version.id)}>Version {version.version_no} herunterladen</button>)}
      </li>)}</ul>:<p>Keine freigegebenen Dokumente zu diesem NFC-Gerät.</p>}
      <p>Technische Unterlagen und Austauschdokumentationen werden zentral im Dokumentenmanagement verwaltet und hier mit dem Gerät verknüpft.</p>
    </div>}

    {dialog==='edit'&&<NfcDialog title="NFC-Gerät bearbeiten" onClose={()=>setDialog(null)} wide>
      <form className="object-detail-form" onSubmit={event=>{event.preventDefault();saveMaster();}}>
        <NfcFormFields value={form} onChange={setForm} options={options}/>
        {dialogError&&<p className="object-warning" role="alert">{dialogError}</p>}
        <div className="object-actions"><button type="submit" disabled={busy}>{commonText.save}</button>
          <button type="button" onClick={()=>setDialog(null)}>{commonText.cancel}</button></div>
      </form>
    </NfcDialog>}

    {dialog==='block'&&<NfcReasonDialog title="NFC-Gerät sperren"
      description={`${device.identifier} wird sofort für neue Kontrollgang-Scans gesperrt.`}
      reason={reason} onReason={setReason} error={dialogError} busy={busy} confirmLabel="Sperren"
      onConfirm={()=>{if(reason.trim().length<3){setDialogError(commonText.reasonRequired);return;}runStatus('block',{reason:reason.trim()},'NFC-Gerät wurde gesperrt.');}}
      onClose={()=>setDialog(null)}/>}

    {dialog==='lost'&&<NfcReasonDialog title="Verlust melden"
      description={`${device.identifier} wird als verloren markiert und für Scans gesperrt.`}
      date={lostDate} onDate={setLostDate} reason={reason} onReason={setReason}
      error={dialogError} busy={busy} confirmLabel="Verlust melden"
      onConfirm={()=>{
        if(!lostDate){setDialogError('Bitte ein Verlustdatum angeben.');return;}
        if(reason.trim().length<3){setDialogError(commonText.reasonRequired);return;}
        runStatus('report-lost',{lost_at:lostDate,reason:reason.trim()},'Verlust wurde dokumentiert.');
      }} onClose={()=>setDialog(null)}/>}

    {dialog==='reactivate'&&<NfcReasonDialog title="NFC-Gerät reaktivieren"
      description={`${device.identifier} darf nach der Reaktivierung wieder für gültige Scans verwendet werden.`}
      reason={reason} onReason={setReason} error={dialogError} busy={busy} confirmLabel="Reaktivieren"
      onConfirm={()=>{if(reason.trim().length<3){setDialogError(commonText.reasonRequired);return;}runStatus('reactivate',{reason:reason.trim()},'NFC-Gerät wurde reaktiviert.');}}
      onClose={()=>setDialog(null)}/>}

    {dialog==='recover'&&<NfcRecoverDialog
      identifier={device.identifier} assignment={nfcAssignmentLabel(device)}
      identifierConfirmation={recover.identifier_confirmation}
      onIdentifierConfirmation={value=>setRecover(current=>({...current,identifier_confirmation:value}))}
      reason={recover.reason} onReason={value=>setRecover(current=>({...current,reason:value}))}
      foundAt={recover.found_at} onFoundAt={value=>setRecover(current=>({...current,found_at:value}))}
      error={dialogError} busy={busy}
      onConfirm={confirmed=>{
        if(!recover.found_at){setDialogError('Bitte ein Wiederauffindungsdatum angeben.');return;}
        if(recover.identifier_confirmation.trim()!==device.identifier){setDialogError('Die bestätigte NFC-Kennung stimmt nicht überein.');return;}
        if(!confirmed){setDialogError('Bitte Identität und Zuordnung bestätigen.');return;}
        if(recover.reason.trim().length<3){setDialogError(commonText.reasonRequired);return;}
        runStatus('recover',{found_at:recover.found_at,identifier_confirmation:recover.identifier_confirmation.trim(),
          assignment_confirmed:true,reason:recover.reason.trim()},'Gerät wurde zunächst in Quarantäne gesperrt.');
      }} onClose={()=>setDialog(null)}/>}

    {dialog==='archive'&&<NfcReasonDialog title="NFC-Gerät archivieren"
      description={`${device.identifier} wird dauerhaft außer Betrieb genommen. Bestehende Scans und Nachweise bleiben erhalten.`}
      reason={reason} onReason={setReason} error={dialogError} busy={busy} confirmLabel="Archivieren"
      onConfirm={()=>{if(reason.trim().length<3){setDialogError(commonText.reasonRequired);return;}runStatus('archive',{reason:reason.trim()},'NFC-Gerät wurde archiviert.');}}
      onClose={()=>setDialog(null)}/>}

    {dialog==='replace'&&<NfcReplaceDialog
      identifier={replacement.identifier} onIdentifier={value=>setReplacement(current=>({...current,identifier:value}))}
      deviceType={replacement.device_type} onDeviceType={value=>setReplacement(current=>({...current,device_type:value}))}
      manufacturer={replacement.manufacturer} onManufacturer={value=>setReplacement(current=>({...current,manufacturer:value}))}
      mode={replacement.mode} onMode={value=>setReplacement(current=>({...current,mode:value}))}
      existingDeviceId={replacement.existing_device_id}
      onExistingDeviceId={value=>setReplacement(current=>({...current,existing_device_id:value}))}
      devices={(options.devices??[]).filter(item=>item.id!==device.id)}
      currentAssignment={nfcAssignmentLabel(device)} candidateAssignment={candidateAssignment}
      reason={replacement.reason} onReason={value=>setReplacement(current=>({...current,reason:value}))}
      notes={replacement.notes} onNotes={value=>setReplacement(current=>({...current,notes:value}))}
      copyAssignment={replacement.copy_assignment} onCopyAssignment={value=>setReplacement(current=>({...current,copy_assignment:value}))}
      acknowledgeExisting={replacement.acknowledge_existing}
      onAcknowledgeExisting={value=>setReplacement(current=>({...current,acknowledge_existing:value}))}
      acknowledgeRestricted={replacement.acknowledge_restricted}
      onAcknowledgeRestricted={value=>setReplacement(current=>({...current,acknowledge_restricted:value}))}
      error={dialogError} busy={busy}
      onConfirm={()=>{
        if(replacement.reason.trim().length<3){setDialogError(commonText.reasonRequired);return;}
        if(replacement.mode==='new'&&(!replacement.identifier.trim()||!replacement.manufacturer.trim())){
          setDialogError('Bitte Kennung und Hersteller des Ersatzgeräts angeben.');return;
        }
        if(replacement.mode==='existing'&&!replacement.existing_device_id){
          setDialogError('Bitte ein vorhandenes Ersatzgerät auswählen.');return;
        }
        runStatus('replace',replacementPayload(),'Austausch wurde dokumentiert.');
      }} onClose={()=>setDialog(null)}/>}
  </section>;
}
