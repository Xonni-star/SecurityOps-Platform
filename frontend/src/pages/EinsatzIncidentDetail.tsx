import {FormEvent,useCallback,useEffect,useState} from 'react';
import {Link,useParams} from 'react-router-dom';
import {api,hasPermission} from '../lib/api';
import {formatDateTime,formatNumber} from '../lib/format';
import {statusLabel} from '../lib/status';
import {
  asArray,display,errorText,field,isClosureBlocked,isObject,numberOrNull,text,type Loose,
} from '../lib/operations';
import {useRealtimeRefresh} from '../lib/useRealtimeRefresh';
import {Badge,EmptyState,ErrorState,LoadingSkeleton,ResponsiveTable,Section,type TableColumn} from '../components/operative/Common';

type Notice={kind:'error'|'success';message:string};
type StatusKey='en_route'|'on_site'|'completed'|'cancelled';
const transitions:Record<string,StatusKey[]>={
  initiated:['en_route','cancelled'],en_route:['on_site','cancelled'],on_site:['completed','cancelled'],
  completed:[],cancelled:[],
};
const tone=(value:string)=>['critical','high','medium','low'].includes(value)
  ?value as 'critical'|'high'|'medium'|'low':'neutral';

function dmsLink(row:Loose){
  const documentId=display(row,['document_id'],'');
  const versionId=display(row,['version_id'],'');
  if(!documentId||!versionId)return <span>Keine verfügbare Version</span>;
  return <a href={`/api/v1/dms/documents/${documentId}/versions/${versionId}/download`} target="_blank"
    rel="noreferrer">DMS-Download</a>;
}

export function EinsatzIncidentDetail(){
  const {id=''}=useParams<{id:string}>();
  const canWrite=hasPermission('incidents:write');
  const canReadEmployees=hasPermission('employees:read');
  const canReadDms=hasPermission('dms:read');
  const canReadNotifications=hasPermission('notifications:read');
  const canWriteDocuments=hasPermission('incident_documents:write');
  const canWriteReports=hasPermission('incident_reports:write');
  const canEscalate=hasPermission('incidents:escalate');

  const [detail,setDetail]=useState<Loose|null>(null);
  const [notifications,setNotifications]=useState<Loose[]>([]);
  const [employees,setEmployees]=useState<Loose[]>([]);
  const [documents,setDocuments]=useState<Loose[]>([]);
  const [rules,setRules]=useState<Loose[]>([]);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState<Notice|null>(null);
  const [busy,setBusy]=useState(false);

  const [statusReason,setStatusReason]=useState('');
  const [force,setForce]=useState(false);
  const [employeeId,setEmployeeId]=useState('');
  const [documentForm,setDocumentForm]=useState({document_id:'',category:'attachment',note:''});
  const [reportForm,setReportForm]=useState({summary:'',cause:'',actions:'',result:''});
  const [escalationForm,setEscalationForm]=useState({rule_id:'',target_status:'escalated',reason:''});

  const load=useCallback(async()=>{
    if(!id)return;
    setLoading(true);setError('');
    try{
      const result=await api<unknown>(`/einsatz/incidents/${id}`);
      setDetail(isObject(result)?result:{id});
      if(canReadNotifications){
        const deliveries=await api<unknown>(`/einsatz/notifications/${id}`).catch(()=>[]);
        setNotifications(asArray(deliveries));
      }else setNotifications([]);
    }catch(cause){setDetail(null);setError(errorText(cause));}
    finally{setLoading(false);}
  },[id,canReadNotifications]);

  useEffect(()=>{void load();},[load]);
  useRealtimeRefresh(()=>{void load();},['incident.','alarm.','operations.measure.','notification.created']);

  useEffect(()=>{
    if(canReadEmployees)void api<unknown>('/employees').then(value=>setEmployees(asArray(value,['items','employees']))).catch(()=>setEmployees([]));
    if(canReadDms)void api<unknown>('/dms/documents').then(value=>setDocuments(asArray(value,['items','documents']))).catch(()=>setDocuments([]));
    if(hasPermission('escalation_rules:read'))void api<unknown>('/einsatz/escalation-rules')
      .then(value=>setRules(asArray(value,['items','rules']))).catch(()=>setRules([]));
  },[canReadEmployees,canReadDms]);

  useEffect(()=>{
    const report=isObject(field(detail,['report']))?field(detail,['report']) as Loose:null;
    if(report)setReportForm({
      summary:text(field(report,['summary']),''),cause:text(field(report,['cause']),''),
      actions:text(field(report,['actions']),''),result:text(field(report,['result']),''),
    });
  },[detail]);

  const runAction=async(label:string,path:string,body:Record<string,unknown>,method:'POST'|'PATCH'|'DELETE'='POST')=>{
    setBusy(true);setNotice(null);
    try{
      const result=await api<unknown>(`/einsatz/incidents/${id}/${path}`,{method,body:JSON.stringify(body)});
      const status=text((result as Loose)?.status??(result as Loose)?.to_status,'vom Backend bestätigt');
      setNotice({kind:'success',message:`${label}: ${status}`});
      await load();
      return true;
    }catch(cause){
      if(isClosureBlocked(cause)){
        const details=isObject((cause as Error&{details?:unknown}).details)?(cause as Error&{details?:unknown}).details as Loose:null;
        const open=asArray(field(details,['open_measures'])).map(measure=>display(measure,['title','id'])).join(', ');
        setNotice({kind:'error',message:`Abschlussbedingungen nicht erfüllt${open?`: offene Maßnahmen: ${open}`:''}. Das Backend hat den Abschluss abgelehnt.`});
      }else setNotice({kind:'error',message:errorText(cause)});
      return false;
    }finally{setBusy(false);}
  };

  const submitStatus=async(status:StatusKey)=>{
    if(force&&statusReason.trim().length<10){
      setNotice({kind:'error',message:'Für eine erzwungene Statusänderung ist eine Begründung mit mindestens 10 Zeichen erforderlich.'});
      return;
    }
    if(await runAction(`Status „${statusLabel(status,'incident')}“`,'status',{
      status,reason:statusReason.trim()||undefined,force:force||undefined,
    }))setStatusReason('');
  };

  const submitAssignment=async(event:FormEvent)=>{
    event.preventDefault();
    if(!canWrite||!employeeId)return;
    if(await runAction('Zuordnung erfasst','assignments',{employee_id:employeeId}))setEmployeeId('');
  };

  const submitDocument=async(event:FormEvent)=>{
    event.preventDefault();
    if(!canWriteDocuments||!documentForm.document_id)return;
    if(await runAction('Dokument verknüpft','documents',{
      document_id:documentForm.document_id,category:documentForm.category,note:documentForm.note.trim()||null,
    }))setDocumentForm({document_id:'',category:'attachment',note:''});
  };

  const submitReport=async(event:FormEvent)=>{
    event.preventDefault();
    if(!canWriteReports)return;
    const body:Record<string,string>={};
    for(const [key,value] of Object.entries(reportForm))if(value.trim())body[key]=value.trim();
    if(!Object.keys(body).length)return;
    await runAction('Bericht gespeichert','report',body,'PATCH');
  };

  const submitEscalation=async(event:FormEvent)=>{
    event.preventDefault();
    if(!canEscalate)return;
    if(await runAction('Eskalation ausgelöst','escalations',{
      ...(escalationForm.rule_id?{rule_id:escalationForm.rule_id}:{}),
      target_status:escalationForm.target_status,reason:escalationForm.reason.trim()||undefined,
    }))setEscalationForm({rule_id:'',target_status:'escalated',reason:''});
  };

  const history=asArray(field(detail,['history']));
  const assignees=asArray(field(detail,['assignees']));
  const incidentDocuments=asArray(field(detail,['documents']));
  const measures=asArray(field(detail,['measures']));
  const escalationLog=asArray(field(detail,['escalation_log']));
  const report=isObject(field(detail,['report']))?field(detail,['report']) as Loose:null;
  const currentStatus=display(detail,['status']);
  const openMeasures=measures.filter(measure=>!['done','cancelled'].includes(display(measure,['status'])));

  const assignmentColumns:TableColumn<Loose>[]=[
    {key:'employee',label:'Mitarbeiter',render:row=>display(row,['name','employee_id'])},
    {key:'assigned',label:'Zugeordnet',render:row=>formatDateTime(field(row,['assigned_at']) as string)},
  ];
  const documentColumns:TableColumn<Loose>[]=[
    {key:'title',label:'Dokument',render:row=><><strong>{display(row,['title'],'–')}</strong>
      <small>{display(row,['category'],'–')}</small></>},
    {key:'version',label:'Fassung',render:row=>display(row,['version_no'],'–')},
    {key:'status',label:'Dokumentstatus',render:row=>display(row,['document_status','approval_status'],'–')},
    {key:'note',label:'Notiz',render:row=>display(row,['note'],'–')},
    {key:'download',label:'Download',render:row=>dmsLink(row)},
    {key:'actions',label:'Aktion',render:row=>canWriteDocuments
      ?<button type="button" className="ops-secondary" disabled={busy}
        onClick={()=>void runAction('Verknüpfung entfernt',`documents/${display(row,['id'])}`,{},'DELETE')}>
        Entfernen</button>:<span>Keine Berechtigung</span>},
  ];
  const measureColumns:TableColumn<Loose>[]=[
    {key:'title',label:'Maßnahme',render:row=>display(row,['title'])},
    {key:'status',label:'Status',render:row=><Badge tone={display(row,['status'])==='done'?'good':'info'}>
      {statusLabel(display(row,['status']),'general')}</Badge>},
    {key:'priority',label:'Priorität',render:row=><Badge tone={tone(display(row,['priority']))}>
      {statusLabel(display(row,['priority']),'priority')}</Badge>},
    {key:'due',label:'Fällig',render:row=>formatDateTime(field(row,['due_at']) as string)},
    {key:'actions',label:'Übersicht',render:_row=><Link to="/operative-leitstelle">Leitstelle</Link>},
  ];
  const escalationColumns:TableColumn<Loose>[]=[
    {key:'rule',label:'Regel',render:row=>display(row,['rule_name'],'Manuell')},
    {key:'transition',label:'Wechsel',render:row=><>{display(row,['from_status'],'–')} → {display(row,['to_status'],'–')}</>},
    {key:'trigger',label:'Auslöser',render:row=>display(row,['trigger'],'–')},
    {key:'reason',label:'Begründung',render:row=>display(row,['reason'],'–')},
    {key:'actor',label:'Ausgelöst von',render:row=>display(row,['actor_email'],'–')},
    {key:'at',label:'Zeitpunkt',render:row=>formatDateTime(field(row,['created_at']) as string)},
  ];
  const notificationColumns:TableColumn<Loose>[]=[
    {key:'channel',label:'Kanal',render:row=>statusLabel(display(row,['channel']),'channel')},
    {key:'status',label:'Zustellstatus',render:row=><Badge
      tone={['failed','exhausted'].includes(display(row,['status']))?'critical':'neutral'}>
      {statusLabel(display(row,['status']),'delivery')}</Badge>},
    {key:'attempts',label:'Versuche',render:row=>formatNumber(numberOrNull(field(row,['attempts'])))},
    {key:'recipient',label:'Empfänger',render:row=>display(row,['recipient_masked'],'–')},
    {key:'sent',label:'Gesendet',render:row=>formatDateTime(field(row,['sent_at']) as string)},
  ];

  if(loading)return <div className="ops-page"><LoadingSkeleton rows={6} label="Vorfall wird geladen …"/></div>;
  if(error)return <div className="ops-page"><ErrorState message={`Vorfall konnte nicht geladen werden: ${error}`}
    onRetry={()=>void load()}/><Link to="/einsatz/vorfaelle">Zurück zur Vorfallliste</Link></div>;
  if(!detail)return <div className="ops-page"><EmptyState>Keine Daten</EmptyState></div>;

  return <div className="ops-page">
    <div className="ops-head">
      <div>
        <h2>{display(detail,['incident_number'],'Vorfall')}: {display(detail,['incident_type_name'],'Einsatz')}</h2>
        <p>{display(detail,['description'],'Keine Beschreibung hinterlegt.')}</p>
      </div>
      <div className="ops-head-actions">
        <Badge tone={currentStatus==='completed'?'good':'info'}>{statusLabel(currentStatus,'incident')}</Badge>
        <Badge tone={tone(display(detail,['priority_code']))}>{statusLabel(display(detail,['priority_code']),'priority')}</Badge>
        <Link to="/einsatz/vorfaelle">Zurück zur Vorfallliste</Link>
      </div>
    </div>

    {notice&&<p className={notice.kind==='error'?'ops-error':'ops-success'} role={notice.kind==='error'?'alert':'status'}>{notice.message}</p>}

    <Section title="Vorfalldaten">
      <div className="ops-meta-list">
        <div className="ops-meta"><dt>Vorgangsnummer</dt><dd>{display(detail,['incident_number','id'])}</dd></div>
        <div className="ops-meta"><dt>Vorfallart</dt><dd>{display(detail,['incident_type_name','incident_type_code'])}</dd></div>
        <div className="ops-meta"><dt>Priorität</dt><dd>{statusLabel(display(detail,['priority_code']),'priority')}</dd></div>
        <div className="ops-meta"><dt>Objekt</dt><dd>{display(detail,['site_name'])}</dd></div>
        <div className="ops-meta"><dt>Kunde</dt><dd>{display(detail,['customer_name'])}</dd></div>
        <div className="ops-meta"><dt>Erfasst</dt><dd>{formatDateTime(field(detail,['created_at']) as string)}</dd></div>
        <div className="ops-meta"><dt>Geändert</dt><dd>{formatDateTime(field(detail,['updated_at']) as string)}</dd></div>
        <div className="ops-meta"><dt>Geschlossen</dt><dd>{formatDateTime(field(detail,['closed_at']) as string)}</dd></div>
        <div className="ops-meta"><dt>Quelle</dt><dd>{display(detail,['source'],'–')}</dd></div>
        <div className="ops-meta"><dt>Verantwortlich</dt><dd>{display(detail,['employee_name'],'–')}</dd></div>
      </div>
    </Section>

    <Section title="Status und Abschlussbedingungen"
      description="Zulässige Statuswechsel werden vom Backend erneut geprüft; offene Alarme und Maßnahmen blockieren den Abschluss.">
      {openMeasures.length>0&&<p className="ops-lock" role="status">
        {openMeasures.length} offene Maßnahmen verhindern derzeit den Abschluss.</p>}
      {canWrite&&<div className="ops-inline-form">
        <label>Begründung<input value={statusReason} onChange={event=>setStatusReason(event.target.value)}
          placeholder="Für erzwungene Wechsel mindestens 10 Zeichen"/></label>
        <label className="ops-check"><input type="checkbox" checked={force} onChange={event=>setForce(event.target.checked)}/>
          Erzwungener Wechsel (nur mit Begründung)</label>
        <div className="ops-form-actions">
          {(transitions[currentStatus]??[]).map(status=><button key={status} type="button" disabled={busy}
            className={status==='en_route'?'ops-secondary':''} onClick={()=>void submitStatus(status)}>
            {statusLabel(status,'incident')}</button>)}
          {(transitions[currentStatus]??[]).length===0&&<span>Kein weiterer Statuswechsel möglich.</span>}
        </div>
      </div>}
      {!canWrite&&<p className="ops-note" role="status">Keine Berechtigung zum Ändern des Vorfallstatus.</p>}
    </Section>

    <div className="ops-grid">
      <Section title="Bearbeitungsverlauf">
        <ul className="ops-history">{history.length===0?<EmptyState>Keine Daten</EmptyState>:history.map((entry,index)=>
          <li key={display(entry,['id'],String(index))}>
            <time>{formatDateTime(field(entry,['created_at']) as string)}</time>
            <strong>{display(entry,['event_type'],'Ereignis')}</strong>{' · '}
            {display(entry,['from_status'],'–')} → {display(entry,['to_status'],'–')}
            {' · '}{display(entry,['note','changed_by'],'–')}
          </li>)}</ul>
      </Section>
      <Section title="Benachrichtigungsstellungen"
        description="Nur tatsächlich vom Backend gemeldete Zustellungen werden ausgewiesen.">
        {!canReadNotifications?<p className="ops-note" role="status">Zustellungen sind für Ihr Konto nicht freigegeben.</p>
          :<ResponsiveTable columns={notificationColumns} rows={notifications}
            rowKey={(row,index)=>display(row,['id'],String(index))} empty="Keine Daten"/>}
      </Section>
    </div>

    <Section title="Beteiligte">
      <ResponsiveTable columns={assignmentColumns} rows={assignees}
        rowKey={(row,index)=>display(row,['id'],String(index))} empty="Keine Daten"/>
      {canWrite&&<form className="ops-inline-form" onSubmit={submitAssignment}>
        <label>Mitarbeiter<select required value={employeeId} onChange={event=>setEmployeeId(event.target.value)}>
          <option value="">Bitte wählen</option>
          {employees.map(employee=><option key={display(employee,['id'])} value={display(employee,['id'])}>
            {display(employee,['name','email'])}</option>)}
        </select></label>
        {!canReadEmployees&&<p className="ops-note">Mitarbeiterliste ist für Ihr Konto nicht freigegeben.</p>}
        <div className="ops-form-actions"><button type="submit" disabled={busy||!employeeId}>Zuordnung speichern</button></div>
      </form>}
    </Section>

    <Section title="Anhänge und Nachweise"
      description="Nur Metadaten und vom Backend bereitgestellte Download-Links; keine Datei wird über dieses Formular hochgeladen.">
      <ResponsiveTable columns={documentColumns} rows={incidentDocuments}
        rowKey={(row,index)=>display(row,['id'],String(index))} empty="Keine Daten"/>
      {canWriteDocuments&&<form className="ops-inline-form" onSubmit={submitDocument}>
        <label>Dokument<select required value={documentForm.document_id}
          onChange={event=>setDocumentForm({...documentForm,document_id:event.target.value})}>
          <option value="">Bitte wählen</option>
          {documents.map(document=><option key={display(document,['id'])} value={display(document,['id'])}>
            {display(document,['title','file_name'])}</option>)}
        </select></label>
        {!canReadDms&&<p className="ops-note">Dokumentliste ist für Ihr Konto nicht freigegeben.</p>}
        <label>Kategorie<select value={documentForm.category}
          onChange={event=>setDocumentForm({...documentForm,category:event.target.value})}>
          <option value="attachment">Anhang</option><option value="report">Bericht</option>
          <option value="evidence">Beweismittel</option>
        </select></label>
        <label>Notiz<input value={documentForm.note} onChange={event=>setDocumentForm({...documentForm,note:event.target.value})}/></label>
        <div className="ops-form-actions"><button type="submit" disabled={busy||!documentForm.document_id}>
          Dokument verknüpfen</button></div>
      </form>}
    </Section>

    <Section title="Maßnahmen" description="Statuswechsel erfolgen zentral in der operativen Leitstelle.">
      <ResponsiveTable columns={measureColumns} rows={measures}
        rowKey={(row,index)=>display(row,['id'],String(index))} empty="Keine Daten"/>
    </Section>

    <Section title="Bericht">
      {report?<div className="ops-meta-list">
        <div className="ops-meta"><dt>Zusammenfassung</dt><dd>{display(report,['summary'],'–')}</dd></div>
        <div className="ops-meta"><dt>Ursache</dt><dd>{display(report,['cause'],'–')}</dd></div>
        <div className="ops-meta"><dt>Maßnahmen</dt><dd>{display(report,['actions'],'–')}</dd></div>
        <div className="ops-meta"><dt>Ergebnis</dt><dd>{display(report,['result'],'–')}</dd></div>
        <div className="ops-meta"><dt>Geändert</dt><dd>{formatDateTime(field(report,['updated_at']) as string)}</dd></div>
      </div>:<EmptyState>Kein Bericht hinterlegt.</EmptyState>}
      {canWriteReports&&<form className="ops-inline-form" onSubmit={submitReport}>
        <label>Zusammenfassung<textarea value={reportForm.summary}
          onChange={event=>setReportForm({...reportForm,summary:event.target.value})}/></label>
        <label>Ursache<textarea value={reportForm.cause}
          onChange={event=>setReportForm({...reportForm,cause:event.target.value})}/></label>
        <label>Maßnahmen<textarea value={reportForm.actions}
          onChange={event=>setReportForm({...reportForm,actions:event.target.value})}/></label>
        <label>Ergebnis<textarea value={reportForm.result}
          onChange={event=>setReportForm({...reportForm,result:event.target.value})}/></label>
        <div className="ops-form-actions"><button type="submit" disabled={busy}>Bericht speichern</button></div>
      </form>}
    </Section>

    <Section title="Eskalationen">
      <ResponsiveTable columns={escalationColumns} rows={escalationLog}
        rowKey={(row,index)=>display(row,['id'],String(index))} empty="Keine Daten"/>
      {canEscalate&&<form className="ops-inline-form" onSubmit={submitEscalation}>
        <label>Regel<select value={escalationForm.rule_id}
          onChange={event=>setEscalationForm({...escalationForm,rule_id:event.target.value})}>
          <option value="">Manuell ohne Regel</option>
          {rules.map(rule=><option key={display(rule,['id'])} value={display(rule,['id'])}>
            {display(rule,['name'])}</option>)}
        </select></label>
        <label>Zielstatus<select value={escalationForm.target_status}
          onChange={event=>setEscalationForm({...escalationForm,target_status:event.target.value})}>
          <option value="escalated">Eskaliert</option><option value="acknowledged">Bestätigt</option>
        </select></label>
        <label>Begründung<input value={escalationForm.reason}
          onChange={event=>setEscalationForm({...escalationForm,reason:event.target.value})}/></label>
        <div className="ops-form-actions"><button type="submit" disabled={busy}>Eskalation auslösen</button></div>
      </form>}
      <p className="ops-note">Zustellstatus von Eskalationen werden nicht als erfolgreicher Versand ausgegeben, solange das Backend keinen Erfolg meldet.</p>
    </Section>

    <p className="ops-generated">Vorfall-ID: {display(detail,['id'])} · Verlaufseinträge: {formatNumber(history.length)}</p>
  </div>;
}
