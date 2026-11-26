import {useEffect,useState} from 'react';
import {useNavigate,useParams} from 'react-router-dom';
import {api,hasPermission} from '../lib/api';
import {formatDateTime} from '../lib/format';
import {auditEventLabel,commonText,historyDetailText} from '../lib/text';
import {
  emptyNfcForm,nfcAssignmentDetail,nfcAssignmentLabel,nfcFormFromDevice,nfcMessage,nfcPayloadFromForm,
  nfcScanOutcome,nfcStatusClass,nfcStatusLabel,nfcTypeLabel,NfcDialog,NfcFormFields,NfcReasonDialog,
  NfcAssignmentFields,NfcReplaceDialog,NfcTimeline,validateNfcForm,
  type NfcFileData,type NfcForm,type NfcOptions,
} from './nfcParts';

type Section='uebersicht'|'stammdaten'|'zuordnung'|'scans'|'verlauf'|'dokumente';

const sections:{id:Section;label:string}[]=[
  {id:'uebersicht',label:'Übersicht'},
  {id:'stammdaten',label:'Technische Stammdaten'},
  {id:'zuordnung',label:'Zuordnung'},
  {id:'scans',label:'Scan-Historie'},
  {id:'verlauf',label:'Status & Ereignisse'},
  {id:'dokumente',label:'Dokumente'},
];

const emptyOptions:NfcOptions={sites:[],control_points:[],employees:[]};
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
  const [dialog,setDialog]=useState<'edit'|'block'|'lost'|'replace'|'reactivate'|null>(null);
  const [reason,setReason]=useState('');
  const [lostDate,setLostDate]=useState(today);
  const [replacement,setReplacement]=useState({identifier:'',device_type:'tag',manufacturer:'',reason:'',notes:'',copy_assignment:true});
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
    }catch(cause){setError(nfcMessage(cause));}
  };

  useEffect(()=>{void load();},[deviceId]);
  useEffect(()=>{
    void api<NfcOptions>('/nfc-devices/filter-options').then(value=>setOptions(value??emptyOptions)).catch(()=>undefined);
  },[]);

  const run=async(action:()=>Promise<void>,successText:string)=>{
    setError('');setSuccess('');setDialogError('');setBusy(true);
    try{await action();setSuccess(successText);setDialog(null);await load();}
    catch(cause){setDialogError(nfcMessage(cause));}
    finally{setBusy(false);}
  };

  if(!data)return <section className="object-management">
    <button type="button" className="object-back" onClick={()=>navigate('/nfc-devices')}>← {commonText.backToOverview}</button>
    <p role="status">{error||commonText.loading}</p>
  </section>;

  const device=data.device;
  const open=(kind:Exclude<typeof dialog,null>)=>{
    setError('');setSuccess('');setDialogError('');setReason('');setLostDate(today);setDialog(kind);
    setForm(nfcFormFromDevice(device));
    setReplacement({identifier:'',device_type:device.device_type,manufacturer:device.manufacturer,reason:'',notes:'',copy_assignment:true});
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

  return <section className="object-management object-detail-page">
    <button type="button" className="object-back" onClick={()=>navigate('/nfc-devices')}>← {commonText.backToOverview}</button>
    <div className="object-detail-header">
      <div>
        <p className="object-eyebrow">Digitale NFC-Geräteakte · {device.identifier}</p>
        <h2>{device.identifier}</h2>
        <div className="object-header-meta">
          <span className={nfcStatusClass(device.status)}>{nfcStatusLabel(device.status)}</span>
          <span>{nfcTypeLabel(device.device_type)}</span>
          <span>{device.manufacturer}</span>
          <span>{nfcAssignmentLabel(device)}</span>
          <span>Registriert: {formatDateTime(device.registered_at)}</span>
        </div>
      </div>
      <div className="object-actions">
        {canWrite&&<button type="button" onClick={()=>open('edit')}>Stammdaten bearbeiten</button>}
        {canSecurity&&['active','lost'].includes(device.status)&&<button type="button" onClick={()=>open('block')}>Sperren</button>}
        {canSecurity&&device.status==='active'&&<button type="button" onClick={()=>open('lost')}>Verlust melden</button>}
        {canSecurity&&device.status==='lost'&&<button type="button" onClick={()=>open('replace')}>Ersatzgerät registrieren</button>}
        {canSecurity&&device.status==='blocked'&&<button type="button" onClick={()=>open('reactivate')}>Reaktivieren</button>}
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
        <article><h3>Status</h3><p><span className={nfcStatusClass(device.status)}>{nfcStatusLabel(device.status)}</span></p></article>
        <article><h3>Zuordnung</h3><p>{nfcAssignmentLabel(device)}</p></article>
        <article><h3>Letzter Scan</h3><p>{device.last_used_at?formatDateTime(device.last_used_at):commonText.notAvailable}</p></article>
        <article><h3>Registriert</h3><p>{formatDateTime(device.registered_at)}</p></article>
        <article><h3>Aktualisiert</h3><p>{formatDateTime(device.updated_at)}</p></article>
      </div>
      <div className="object-detail-content">
        <h3>Interne Notizen</h3><p>{device.notes||'Keine Notizen hinterlegt.'}</p>
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
        {event.reason?` · ${event.reason}`:''}
      </li>)}</ul>:<p>{commonText.noData}</p>}
    </div>}

    {section==='scans'&&<div className="object-table">
      <table>
        <thead><tr><th>Scanzeitpunkt</th><th>Kontrollpunkt</th><th>Objekt</th><th>Kontrollgang</th>
          <th>Mitarbeiter</th><th>Ergebnis</th><th>Servereingang</th></tr></thead>
        <tbody>
          {!data.scans.length&&<tr><td className="object-empty" colSpan={7}>Keine Scan-Ereignisse für dieses Gerät erfasst.</td></tr>}
          {data.scans.map(scan=><tr key={scan.id}>
            <td>{scan.scanned_at?formatDateTime(scan.scanned_at):commonText.notAvailable}</td>
            <td>{scan.control_point_name??'–'}</td>
            <td>{scan.site_name??'–'}</td>
            <td>{scan.route_name??'–'}</td>
            <td>{scan.employee_name??'–'}</td>
            <td>{nfcScanOutcome(scan)}</td>
            <td>{formatDateTime(scan.server_received_at)}</td>
          </tr>)}
        </tbody>
      </table>
    </div>}

    {section==='verlauf'&&<div className="object-detail-content">
      <h3>Status- und Ereignishistorie</h3>
      {data.history.length?<ul>{data.history.map(event=><li key={event.id}>
        <time>{formatDateTime(event.created_at)}</time>: {auditEventLabel(event.event_type)}
        {Object.entries(event.details??{}).filter(([key])=>!['changed','changed_fields'].includes(key)).map(([key,value])=>
          <div key={key}>{historyDetailText(key,typeof value==='object'&&value!==null?JSON.stringify(value):value)}</div>)}
      </li>)}</ul>:<p>{commonText.noData}</p>}
      <h4>Ersatzhistorie</h4>
      {data.replacements.length?<ul>{data.replacements.map(item=><li key={item.id}>
        <time>{formatDateTime(item.replaced_at)}</time>: {nfcAssignmentDetail(item.old_assignment,options)} → {nfcAssignmentDetail(item.new_assignment,options)}
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
        {' · '}Version {Math.max(...document.versions.map(version=>version.version_no))}
        {' · '}Erstellt: {formatDateTime(document.created_at)}
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

    {dialog==='replace'&&<NfcReplaceDialog
      identifier={replacement.identifier} onIdentifier={value=>setReplacement(current=>({...current,identifier:value}))}
      deviceType={replacement.device_type} onDeviceType={value=>setReplacement(current=>({...current,device_type:value}))}
      manufacturer={replacement.manufacturer} onManufacturer={value=>setReplacement(current=>({...current,manufacturer:value}))}
      reason={replacement.reason} onReason={value=>setReplacement(current=>({...current,reason:value}))}
      notes={replacement.notes} onNotes={value=>setReplacement(current=>({...current,notes:value}))}
      copyAssignment={replacement.copy_assignment} onCopyAssignment={value=>setReplacement(current=>({...current,copy_assignment:value}))}
      error={dialogError} busy={busy}
      onConfirm={()=>{
        if(!replacement.identifier.trim()||!replacement.manufacturer.trim()){setDialogError('Bitte Kennung und Hersteller des Ersatzgeräts angeben.');return;}
        if(replacement.reason.trim().length<3){setDialogError(commonText.reasonRequired);return;}
        runStatus('replace',replacement,'Ersatzgerät wurde registriert.');
      }} onClose={()=>setDialog(null)}/>}
  </section>;
}
