import {FormEvent,useCallback,useEffect,useState} from 'react';
import {Link,useLocation,useNavigate} from 'react-router-dom';
import {api,hasPermission} from '../lib/api';
import {formatDate,formatDateTime,formatNumber,berlinToday} from '../lib/format';
import {statusLabel} from '../lib/status';
import {uuid} from '../lib/uuid';
import {
  asArray,display,errorText,field,isClosureBlocked,isSourceOpen,isUuid,numberOrNull,pagedGet,query,text,type Loose,
} from '../lib/operations';
import {useRealtimeRefresh} from '../lib/useRealtimeRefresh';
import {
  Badge,EmptyState,ErrorState,LoadingSkeleton,Modal,Pagination,ResponsiveTable,Section,type TableColumn,
} from '../components/operative/Common';

type TabKey='overview'|'incidents'|'alarms'|'measures'|'escalations'|'reports';
type Filters={
  q:string;status:string;type:string;priority:string;module:string;site_id:string;
  from:string;to:string;sort:string;dir:'asc'|'desc';overdue:boolean;page:number;page_size:number;
};
type Notice={kind:'error'|'success';message:string};

const tabs:{key:TabKey;label:string;path:string}[]=[
  {key:'overview',label:'Übersicht',path:'/einsatz'},
  {key:'incidents',label:'Vorfälle',path:'/einsatz/vorfaelle'},
  {key:'alarms',label:'Alarme',path:'/einsatz/alarme'},
  {key:'measures',label:'Maßnahmen',path:'/einsatz/massnahmen'},
  {key:'escalations',label:'Eskalationen',path:'/einsatz/eskalationen'},
  {key:'reports',label:'Auswertungen',path:'/einsatz/auswertungen'},
];
const initialFilters:Filters={
  q:'',status:'',type:'',priority:'',module:'',site_id:'',from:'',to:'',sort:'created_at',dir:'desc',
  overdue:false,page:1,page_size:25,
};
const statusOptions:Record<TabKey,Array<[string,string]>>={
  overview:[],
  incidents:[['initiated','Eingeleitet'],['en_route','Auf Anfahrt'],['on_site','Vor Ort'],
    ['completed','Abgeschlossen'],['cancelled','Abgebrochen']],
  alarms:[['open','Offen'],['acknowledged','Quittiert'],['escalated','Eskaliert'],['resolved','Erledigt']],
  measures:[['open','Offen'],['in_progress','In Bearbeitung'],['on_hold','Zurückgestellt'],
    ['done','Abgeschlossen'],['cancelled','Abgebrochen']],
  escalations:[],reports:[],
};
const sortOptions:Record<'incidents'|'alarms',Array<[string,string]>>={
  incidents:[['created_at','Erfasst'],['updated_at','Geändert'],['incident_number','Vorgangsnummer'],
    ['status','Status'],['priority','Priorität'],['type','Vorfallart']],
  alarms:[['triggered_at','Ausgelöst'],['created_at','Erfasst'],['status','Status'],
    ['severity','Priorität'],['site','Objekt']],
};
const priorityOptions:Array<[string,string]>=[
  ['critical','Kritisch'],['high','Hoch'],['medium','Mittel'],['low','Niedrig'],
];
const moduleOptions:Array<[string,string]>=[
  ['leitstelle','Leitstelle'],['einsatz','Einsatz'],['schicht','Schicht'],['objekt','Objekt'],
  ['mitarbeiter','Mitarbeiter'],['qualifikation','Qualifikation'],['dokument','Dokument'],
  ['nfc','NFC'],['schluessel','Schlüssel'],['kunde','Kunde'],['system','System'],
];
// Vom Backend-Migrationsskriber definierte Standardarten; zusätzlich werden
// Vorfallarten aus geladenen Datensätzen ergänzt.
const seededTypes:Array<[string,string]>=[
  ['technical_fault','Technischer Fehler'],['alarm','Alarm'],['key_loss','Schlüsselverlust'],
  ['nfc_loss','NFC-Verlust'],['qualification_gap','Qualifikationslücke'],['staffing_gap','Besetzungslücke'],
  ['hazard','Gefährdung'],['other','Sonstiges'],
];
const tone=(value:string)=>['critical','high','medium','low'].includes(value)
  ?value as 'critical'|'high'|'medium'|'low':'neutral';

function listParams(tab:TabKey,filters:Filters){
  if(tab==='incidents')return query({
    q:filters.q,status:filters.status,incident_type:filters.type,priority_code:filters.priority,
    site_id:filters.site_id,from:filters.from,to:filters.to,sort:filters.sort,dir:filters.dir,
    page:filters.page,page_size:filters.page_size,
  });
  if(tab==='alarms')return query({
    q:filters.q,status:filters.status,severity:filters.priority,site_id:filters.site_id,
    from:filters.from,to:filters.to,sort:filters.sort,dir:filters.dir,
    page:filters.page,page_size:filters.page_size,
  });
  if(tab==='measures')return query({
    q:filters.q,status:filters.status,module:filters.module,site_id:filters.site_id,overdue:filters.overdue,
    page:filters.page,page_size:filters.page_size,
  });
  if(tab==='reports')return query({
    from:filters.from,to:filters.to,site_id:filters.site_id,incident_type:filters.type,format:'json',
  });
  return '';
}

function countTable(rows:Loose[],label:string){
  return <ResponsiveTable
    columns={[{key:'label',label:'Bezeichnung',render:row=>display(row,['name','status','code'],'–')},
      {key:'count',label:'Anzahl',render:row=>formatNumber(numberOrNull(field(row,['count'])))}]}
    rows={rows} rowKey={(row,index)=>display(row,['code','status','id'],String(index))} empty="Keine Daten"
    caption={label}/>;
}

const totalLabels:Record<string,string>={
  incidents:'Vorfälle',alarms:'Alarme',open_alarms:'Offene Alarme',acknowledged_alarms:'Quittierte Alarme',
  resolved_alarms:'Erledigte Alarme',escalations:'Eskalationen',open_measures:'Offene Maßnahmen',
  avg_minutes_to_acknowledge:'Ø Bestätigung (Min.)',avg_minutes_to_resolve:'Ø Lösung (Min.)',
};

function ReportPanel({stats,filters}:{stats:Loose|null;filters:Filters}){
  if(!stats)return <EmptyState>Keine Daten</EmptyState>;
  const totals=field(stats,['totals']);
  const rows=isLoose(totals)?Object.entries(totals):[];
  const csvParams=listParams('reports',filters).replace(/(^|&)format=[^&]*/,'')+'&format=csv';
  return <div className="ops-tab-panel">
    <p className="ops-generated">Berichtsdatum: {formatDateTime(field(stats,['generated_at']) as string)}</p>
    <div className="ops-kpis">
      {rows.length===0?<EmptyState/>:rows.map(([key,value])=><article className="ops-kpi" key={key}
        title="Kennzahl aus dem Backend-Bericht">
        <strong>{formatNumber(numberOrNull(value))}</strong>
        <span>{totalLabels[key]??key.replace(/_/g,' ')}</span>
      </article>)}
    </div>
    <div className="ops-grid">
      <Section title="Vorfälle nach Art">{countTable(asArray(field(stats,['incidents_by_type'])),'Vorfallarten')}</Section>
      <Section title="Vorfälle nach Priorität">{countTable(asArray(field(stats,['incidents_by_priority'])),'Prioritäten')}</Section>
      <Section title="Vorfälle nach Status">{countTable(asArray(field(stats,['incidents_by_status'])),'Status')}</Section>
      <Section title="Alarme nach Status">{countTable(asArray(field(stats,['alarms_by_status'])),'Alarmstatus')}</Section>
    </div>
    <Section title="Nach Objekt" actions={<a href={`/api/v1/einsatz/reports?${csvParams}`} download>Einsatzbericht als CSV</a>}>
      <ResponsiveTable rows={asArray(field(stats,['by_site']))} rowKey={(row,index)=>display(row,['site_id'],String(index))}
        empty="Keine Daten" columns={[
          {key:'site',label:'Objekt',render:row=>display(row,['site_name'])},
          {key:'incidents',label:'Vorfälle',render:row=>formatNumber(numberOrNull(field(row,['incidents'])))},
          {key:'alarms',label:'Alarme',render:row=>formatNumber(numberOrNull(field(row,['alarms'])))},
          {key:'escalations',label:'Eskalationen',render:row=>formatNumber(numberOrNull(field(row,['escalations'])))},
          {key:'measures',label:'Offene Maßnahmen',render:row=>formatNumber(numberOrNull(field(row,['open_measures'])))},
          {key:'ack',label:'Ø Bestätigung (Min.)',render:row=>formatNumber(numberOrNull(field(row,['avg_minutes_to_acknowledge'])))},
          {key:'resolve',label:'Ø Lösung (Min.)',render:row=>formatNumber(numberOrNull(field(row,['avg_minutes_to_resolve'])))},
        ]}/>
    </Section>
  </div>;
}
function isLoose(value:unknown):value is Loose{
  return value!==null&&typeof value==='object'&&!Array.isArray(value);
}

export function Einsatz(){
  const location=useLocation();
  const navigate=useNavigate();
  const canWriteIncidents=hasPermission('incidents:write');
  const canWriteAlarms=hasPermission('alarms:write');
  const canWriteMeasures=hasPermission('operations_measures:write');
  const canReadMeasures=hasPermission('operations_measures:read');
  const canReadReports=hasPermission('einsatz:reports:read');
  const canWriteRules=hasPermission('escalation_rules:write');

  const pathTab=tabs.find(tab=>location.pathname===tab.path)?.key
    ??(/^\/einsatz\/vorfaelle\/.+/.test(location.pathname)?'incidents':undefined);
  const queryTab=new URLSearchParams(location.search).get('tab') as TabKey|null;
  const tab:TabKey=pathTab??(queryTab&&tabs.some(item=>item.key===queryTab)?queryTab:'overview');

  const [filters,setFilters]=useState<Filters>(initialFilters);
  const [rows,setRows]=useState<Loose[]>([]);
  const [total,setTotal]=useState(0);
  const [pages,setPages]=useState(1);
  const [stats,setStats]=useState<Loose|null>(null);
  const [overview,setOverview]=useState<{
    incidents:Loose[];alarms:Loose[];measures:Loose[];incidentsTotal:number;alarmsTotal:number;
  }>({incidents:[],alarms:[],measures:[],incidentsTotal:0,alarmsTotal:0});
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState<Notice|null>(null);
  const [busyId,setBusyId]=useState('');
  const [sites,setSites]=useState<Loose[]>([]);
  const [priorities,setPriorities]=useState<Loose[]>([]);
  const [types,setTypes]=useState<Array<[string,string]>>(seededTypes);

  const [createOpen,setCreateOpen]=useState(false);
  const [createForm,setCreateForm]=useState({description:'',type:'',priority_id:'',site_id:'',reason:''});
  const [createBusy,setCreateBusy]=useState(false);
  const [resolveFor,setResolveFor]=useState<Loose|null>(null);
  const [resolveReason,setResolveReason]=useState('');
  const [historyFor,setHistoryFor]=useState<Loose|null>(null);
  const [history,setHistory]=useState<Loose[]>([]);
  const [historyLoading,setHistoryLoading]=useState(false);
  const [historyError,setHistoryError]=useState('');
  const [statusFor,setStatusFor]=useState<Loose|null>(null);
  const [statusValue,setStatusValue]=useState('in_progress');
  const [statusReason,setStatusReason]=useState('');

  const load=useCallback(async()=>{
    setLoading(true);setError('');
    try{
      if(tab==='overview'){
        const [incidents,alarms,measures]=await Promise.all([
          pagedGet<Loose>('/einsatz/incidents?page=1&page_size=5',['items','incidents']),
          pagedGet<Loose>('/einsatz/alarms?page=1&page_size=5',['items','alarms']),
          canReadMeasures
            ?pagedGet<Loose>('/einsatz/measures?page=1&page_size=5',['items','measures']).catch(()=>({rows:[],total:0,pages:1}))
            :Promise.resolve({rows:[],total:0,pages:1}),
        ]);
        setOverview({incidents:incidents.rows,alarms:alarms.rows,measures:measures.rows,
          incidentsTotal:incidents.total,alarmsTotal:alarms.total});
        if(canReadReports){
          const report=await api<unknown>('/einsatz/reports').catch(()=>null);
          setStats(isLoose(report)?report:null);
        }else setStats(null);
        setRows([]);setTotal(0);setPages(1);
        return;
      }
      if(tab==='reports'){
        const report=await api<unknown>(`/einsatz/reports?${listParams(tab,filters)}`);
        setStats(isLoose(report)?report:null);setRows([]);setTotal(0);setPages(1);
        return;
      }
      if(tab==='escalations'){
        const result=await api<unknown>('/einsatz/escalation-rules');
        const ruleRows=asArray(result,['items','rules']);
        setRows(ruleRows);setTotal(ruleRows.length);setPages(1);
        return;
      }
      const path=tab==='incidents'?'/einsatz/incidents':tab==='alarms'?'/einsatz/alarms':'/einsatz/measures';
      const result=await pagedGet<Loose>(`${path}?${listParams(tab,filters)}`,['items','data','rows','incidents','alarms','measures']);
      setRows(result.rows);setTotal(result.total);setPages(result.pages);
    }catch(cause){setRows([]);setStats(null);setError(errorText(cause));}
    finally{setLoading(false);}
  },[tab,filters,canReadMeasures,canReadReports]);

  useEffect(()=>{void load();},[load]);
  useRealtimeRefresh(()=>{void load();},['alarm.','incident.','operations.measure.','notification.created']);

  useEffect(()=>{
    if(hasPermission('sites:read'))void api<unknown>('/sites').then(value=>setSites(asArray(value,['items','sites']))).catch(()=>setSites([]));
    if(hasPermission('alarm_priorities:read'))void api<unknown>('/alarm-priorities')
      .then(value=>setPriorities(asArray(value,['items','priorities']))).catch(()=>setPriorities([]));
  },[]);
  useEffect(()=>{
    const observed=rows.map(row=>[display(row,['incident_type_code'],''),display(row,['incident_type_name'],'')] as [string,string])
      .filter(([code])=>Boolean(code));
    if(observed.length)setTypes(current=>{
      const known=new Set(current.map(([code])=>code));
      return [...current,...observed.filter(([code])=>!known.has(code))];
    });
  },[rows]);

  const update=<K extends keyof Filters>(key:K,value:Filters[K])=>setFilters(current=>({
    ...current,[key]:value,page:key==='page'?Number(value):1,
  }));
  const goTab=(key:TabKey)=>{setFilters(initialFilters);setNotice(null);navigate(tabs.find(item=>item.key===key)?.path??'/einsatz');};
  const sortable=tab==='incidents'||tab==='alarms';

  const act=async(id:string,action:string,body:Record<string,unknown>={})=>{
    setBusyId(id);setNotice(null);
    try{
      const result=await api<unknown>(`/einsatz/alarms/${id}/${action}`,{method:'POST',body:JSON.stringify(body)});
      setNotice({kind:'success',message:`Aktion „${action}“ wurde vom Backend bestätigt: ${text((result as Loose)?.status,'Status nicht angegeben')}`});
      await load();
    }catch(cause){setNotice({kind:'error',message:errorText(cause)});}
    finally{setBusyId('');}
  };

  const openHistory=async(alarm:Loose)=>{
    const id=display(alarm,['id']);
    setHistoryFor(alarm);setHistory([]);setHistoryLoading(true);setHistoryError('');
    try{
      const result=await api<unknown>(`/einsatz/alarms/${id}/history`);
      setHistory(asArray(result,['history','items','events']));
    }catch(cause){setHistoryError(errorText(cause));}
    finally{setHistoryLoading(false);}
  };

  const toggleRule=async(rule:Loose)=>{
    const id=display(rule,['id']);setBusyId(id);setNotice(null);
    try{
      await api(`/einsatz/escalation-rules/${id}/toggle`,{method:'POST',body:JSON.stringify({})});
      setNotice({kind:'success',message:'Die Eskalationsregel wurde vom Backend geändert.'});await load();
    }catch(cause){setNotice({kind:'error',message:errorText(cause)});}
    finally{setBusyId('');}
  };

  const createIncident=async(event:FormEvent)=>{
    event.preventDefault();
    if(!canWriteIncidents||!createForm.type||!createForm.priority_id||!createForm.description.trim())return;
    setCreateBusy(true);setNotice(null);
    const mutation=uuid();
    try{
      await api('/einsatz/incidents',{method:'POST',body:JSON.stringify({
        incident_type_code:createForm.type,priority_id:createForm.priority_id,
        description:createForm.description.trim(),
        ...(isUuid(createForm.site_id)?{site_id:createForm.site_id}:{}),
        source:'manual',source_key:`manual:${mutation}`,client_mutation_id:mutation,
        reason:createForm.reason.trim()||undefined,
      })});
      setCreateOpen(false);
      setCreateForm({description:'',type:'',priority_id:'',site_id:'',reason:''});
      setNotice({kind:'success',message:'Der Vorfall wurde vom Backend erfasst.'});await load();
    }catch(cause){setNotice({kind:'error',message:errorText(cause)});}
    finally{setCreateBusy(false);}
  };

  const resolveAlarm=async(event:FormEvent)=>{
    event.preventDefault();
    if(!resolveFor||!resolveReason.trim())return;
    await act(display(resolveFor,['id']),'resolve',{reason:resolveReason.trim()});
    setResolveFor(null);setResolveReason('');
  };

  const changeMeasureStatus=async(event:FormEvent)=>{
    event.preventDefault();
    if(!statusFor||!canWriteMeasures)return;
    setNotice(null);setBusyId(display(statusFor,['id']));
    try{
      await api(`/operations/measures/${display(statusFor,['id'])}`,{method:'PATCH',body:JSON.stringify({
        status:statusValue,reason:statusReason.trim()||undefined,
      })});
      setStatusFor(null);setStatusReason('');
      setNotice({kind:'success',message:'Der Maßnahmenstatus wurde vom Backend gespeichert.'});await load();
    }catch(cause){
      setNotice({kind:'error',message:isSourceOpen(cause)
        ?'Abschluss abgelehnt: Die Ursache der Maßnahme besteht weiterhin (source_open). Eine Quittierung beseitigt sie nicht.'
        :isClosureBlocked(cause)?'Abschluss abgelehnt: Es bestehen noch offene Abhängigkeiten.'
        :errorText(cause)});
    }finally{setBusyId('');}
  };

  const incidentColumns:TableColumn<Loose>[]=[
    {key:'number',label:'Vorgang',render:row=><><strong>{display(row,['incident_number','number'],'–')}</strong>
      <small>{display(row,['incident_type_name','incident_type_code'],'–')}</small></>},
    {key:'description',label:'Beschreibung',render:row=>display(row,['description'])},
    {key:'priority',label:'Priorität',render:row=><Badge tone={tone(display(row,['priority_code']))}>
      {statusLabel(display(row,['priority_code']),'priority')}</Badge>},
    {key:'status',label:'Status',render:row=><Badge tone={display(row,['status'])==='completed'?'good':'info'}>
      {statusLabel(display(row,['status']),'incident')}</Badge>},
    {key:'site',label:'Objekt',render:row=>display(row,['site_name'])},
    {key:'created',label:'Erfasst',render:row=>formatDateTime(field(row,['created_at']) as string)},
    {key:'actions',label:'Aktion',render:row=><Link to={`/einsatz/vorfaelle/${display(row,['id'])}`}>Details</Link>},
  ];
  const alarmColumns:TableColumn<Loose>[]=[
    {key:'priority',label:'Priorität',render:row=><Badge tone={tone(display(row,['severity','priority_code']))}>
      {statusLabel(display(row,['severity','priority_code']),'priority')}</Badge>},
    {key:'description',label:'Alarm',render:row=><><strong>{display(row,['description','message'],'–')}</strong>
      <small>{display(row,['type','source'],'–')}</small></>},
    {key:'status',label:'Status',render:row=><Badge>{statusLabel(display(row,['status']),'alarm')}</Badge>},
    {key:'site',label:'Objekt',render:row=>display(row,['site_name'])},
    {key:'triggered',label:'Ausgelöst',render:row=>formatDateTime(field(row,['triggered_at','created_at']) as string)},
    {key:'actions',label:'Aktionen',render:row=>{
      const id=display(row,['id']);const status=display(row,['status']);
      return <div className="ops-row-actions">
        <button type="button" className="ops-secondary" disabled={busyId===id} onClick={()=>void openHistory(row)}>Verlauf</button>
        {canWriteAlarms&&status==='open'&&<button type="button" disabled={busyId===id}
          onClick={()=>void act(id,'acknowledge')}>Quittieren</button>}
        {canWriteAlarms&&status!=='resolved'&&status!=='open'&&<button type="button" disabled={busyId===id}
          onClick={()=>{setResolveFor(row);setResolveReason('');}}>Erledigen</button>}
      </div>;
    }},
  ];
  const measureColumns:TableColumn<Loose>[]=[
    {key:'title',label:'Maßnahme',render:row=><><strong>{display(row,['title'])}</strong>
      <small>{display(row,['description'],'–')}</small></>},
    {key:'status',label:'Status',render:row=><Badge tone={display(row,['status'])==='done'?'good':'info'}>
      {statusLabel(display(row,['status']),'general')}</Badge>},
    {key:'module',label:'Modul',render:row=>display(row,['module'])},
    {key:'priority',label:'Priorität',render:row=><Badge tone={tone(display(row,['priority']))}>
      {statusLabel(display(row,['priority']),'priority')}</Badge>},
    {key:'due',label:'Fällig',render:row=>formatDateTime(field(row,['due_at']) as string)},
    {key:'site',label:'Objekt',render:row=>display(row,['site_name'])},
    {key:'actions',label:'Status',render:row=>canWriteMeasures
      ?<button type="button" className="ops-secondary" disabled={busyId===display(row,['id'])}
        onClick={()=>{setStatusFor(row);setStatusValue('in_progress');setStatusReason('');}}>Ändern</button>
      :<span>Keine Schreibberechtigung</span>},
  ];
  const ruleColumns:TableColumn<Loose>[]=[
    {key:'name',label:'Regel',render:row=><><strong>{display(row,['name'])}</strong>
      <small>{display(row,['id'])}</small></>},
    {key:'target',label:'Zielstatus',render:row=>statusLabel(display(row,['target_status']),'alarm')},
    {key:'delay',label:'Verzögerung',render:row=>`${formatNumber(numberOrNull(field(row,['delay_seconds'])))} Sek.`},
    {key:'notify',label:'Benachrichtigung',render:row=>field(row,['notify_enabled'])===false?'Aus':'An'},
    {key:'enabled',label:'Status',render:row=><Badge tone={field(row,['enabled'])===true?'good':'neutral'}>
      {field(row,['enabled'])===true?'Aktiv':'Nicht aktiv'}</Badge>},
    {key:'actions',label:'Aktion',render:row=>canWriteRules
      ?<button type="button" className="ops-secondary" disabled={busyId===display(row,['id'])}
        onClick={()=>void toggleRule(row)}>{field(row,['enabled'])===true?'Deaktivieren':'Aktivieren'}</button>
      :<span>Keine Schreibberechtigung</span>},
  ];

  return <div className="ops-page">
    <div className="ops-head">
      <div><h2>Einsatzmanagement</h2>
        <p>Vorfälle, Alarme, Maßnahmen, Eskalationen und Auswertungen aus dem Einsatzmodul. Status und Zustellungen werden ausschließlich aus Backend-Daten angezeigt.</p>
      </div>
      {canWriteIncidents&&<button type="button" onClick={()=>setCreateOpen(true)}>Vorfall erfassen</button>}
    </div>

    <nav className="ops-tabs" aria-label="Bereiche des Einsatzmanagements">
      {tabs.map(item=><button type="button" key={item.key} className={tab===item.key?'active':''}
        onClick={()=>goTab(item.key)}>{item.label}</button>)}
    </nav>

    {notice&&<p className={notice.kind==='error'?'ops-error':'ops-success'} role={notice.kind==='error'?'alert':'status'}>{notice.message}</p>}

    {tab!=='overview'&&tab!=='escalations'&&<form className="ops-filters" onSubmit={event=>{event.preventDefault();update('page',1);}}
      aria-label="Einsatzdaten filtern">
      {(tab==='incidents'||tab==='alarms'||tab==='measures')&&<label>Suche<input type="search" value={filters.q}
        onChange={event=>update('q',event.target.value)} placeholder="Text, Nummer, Beschreibung"/></label>}
      {statusOptions[tab].length>0&&<label>Status<select value={filters.status} onChange={event=>update('status',event.target.value)}>
        <option value="">Alle Status</option>
        {statusOptions[tab].map(([value,label])=><option key={value} value={value}>{label}</option>)}
      </select></label>}
      {tab==='incidents'&&<label>Vorfallart<select value={filters.type} onChange={event=>update('type',event.target.value)}>
        <option value="">Alle Vorfallarten</option>
        {types.map(([value,label])=><option key={value} value={value}>{label}</option>)}
      </select></label>}
      {(tab==='incidents'||tab==='alarms')&&<label>Priorität<select value={filters.priority}
        onChange={event=>update('priority',event.target.value)}>
        <option value="">Alle Prioritäten</option>
        {priorityOptions.map(([value,label])=><option key={value} value={value}>{label}</option>)}
      </select></label>}
      {tab==='measures'&&<label>Modul<select value={filters.module} onChange={event=>update('module',event.target.value)}>
        <option value="">Alle Module</option>
        {moduleOptions.map(([value,label])=><option key={value} value={value}>{label}</option>)}
      </select></label>}
      {tab==='measures'&&<label className="ops-check"><input type="checkbox" checked={filters.overdue}
        onChange={event=>update('overdue',event.target.checked)}/> Nur überfällige Maßnahmen</label>}
      <label>Objekt{sites.length>0?<select value={filters.site_id} onChange={event=>update('site_id',event.target.value)}>
        <option value="">Alle Objekte</option>
        {sites.map(site=><option key={display(site,['id'])} value={display(site,['id'])}>{display(site,['name'])}</option>)}
      </select>:<input value={filters.site_id} onChange={event=>update('site_id',event.target.value)}
        placeholder="Objekt-UUID"/>}</label>
      {(tab==='incidents'||tab==='alarms'||tab==='reports')&&<>
        <label>Von<input type="date" value={filters.from} onChange={event=>update('from',event.target.value)}/></label>
        <label>Bis<input type="date" value={filters.to} onChange={event=>update('to',event.target.value)}/></label>
      </>}
      {sortable&&<>
        <label>Sortieren<select value={filters.sort} onChange={event=>update('sort',event.target.value)}>
          {sortOptions[tab==='alarms'?'alarms':'incidents'].map(([value,label])=>
            <option key={value} value={value}>{label}</option>)}
        </select></label>
        <label>Richtung<select value={filters.dir} onChange={event=>update('dir',event.target.value as 'asc'|'desc')}>
          <option value="desc">Absteigend</option><option value="asc">Aufsteigend</option>
        </select></label>
      </>}
      {tab!=='reports'&&<label>Einträge pro Seite<select value={filters.page_size}
        onChange={event=>update('page_size',Number(event.target.value))}>
        {[10,25,50,100,200].map(size=><option key={size} value={size}>{size}</option>)}
      </select></label>}
      <div className="ops-filter-actions">
        <button type="submit">Filter anwenden</button>
        <button type="button" className="ops-secondary" onClick={()=>{setFilters(initialFilters);}}>Zurücksetzen</button>
      </div>
    </form>}

    {tab==='overview'&&<div className="ops-tab-panel">
      {loading&&<LoadingSkeleton rows={4} label="Einsatzübersicht wird geladen …"/>}
      {error&&<ErrorState message={`Einsatzübersicht konnte nicht geladen werden: ${error}`} onRetry={()=>void load()}/>}
      {!loading&&!error&&<>
        <Section title="Aktuelle Vorfälle"
          description={`${formatNumber(overview.incidentsTotal)} Vorfälle insgesamt (Backend-Zähler).`}
          actions={<button type="button" className="ops-secondary" onClick={()=>goTab('incidents')}>Alle Vorfälle</button>}>
          <ResponsiveTable columns={incidentColumns} rows={overview.incidents} rowKey={row=>display(row,['id'])} empty="Keine Daten"/>
        </Section>
        <div className="ops-grid">
          <Section title="Aktive Alarme"
            description={`${formatNumber(overview.alarmsTotal)} Alarme insgesamt (Backend-Zähler).`}
            actions={<button type="button" className="ops-secondary" onClick={()=>goTab('alarms')}>Alle Alarme</button>}>
            <ResponsiveTable columns={alarmColumns} rows={overview.alarms} rowKey={row=>display(row,['id'])} empty="Keine Daten"/>
          </Section>
          <Section title="Offene Maßnahmen"
            actions={<button type="button" className="ops-secondary" onClick={()=>goTab('measures')}>Alle Maßnahmen</button>}>
            <ResponsiveTable columns={measureColumns} rows={overview.measures} rowKey={row=>display(row,['id'])} empty="Keine Daten"/>
          </Section>
        </div>
        <Section title="Auswertung" description="Kennzahlen stammen aus dem Backend-Bericht.">
          {canReadReports?<ReportPanel stats={stats} filters={filters}/>:
            <p className="ops-note" role="status">Auswertungen sind für Ihr Konto nicht freigegeben.</p>}
        </Section>
      </>}
    </div>}

    {tab!=='overview'&&<div className="ops-tab-panel">
      {loading&&<LoadingSkeleton rows={4} label="Daten werden geladen …"/>}
      {error&&<ErrorState message={`Daten konnten nicht geladen werden: ${error}`} onRetry={()=>void load()}/>}
      {!loading&&!error&&<Section title={{
        incidents:'Vorfälle',alarms:'Alarme',measures:'Maßnahmen',escalations:'Eskalationsregeln',reports:'Auswertungen',
      }[tab]}>
        {tab==='incidents'&&<ResponsiveTable columns={incidentColumns} rows={rows}
          rowKey={row=>display(row,['id'])} empty="Keine Daten"/>}
        {tab==='alarms'&&<ResponsiveTable columns={alarmColumns} rows={rows}
          rowKey={row=>display(row,['id'])} empty="Keine Daten"/>}
        {tab==='measures'&&<ResponsiveTable columns={measureColumns} rows={rows}
          rowKey={row=>display(row,['id'])} empty="Keine Daten"/>}
        {tab==='escalations'&&<>
          <ResponsiveTable columns={ruleColumns} rows={rows} rowKey={row=>display(row,['id'])} empty="Keine Daten"/>
          <p className="ops-note">Tatsächlich ausgelöste Eskalationen und Zustellstatus stehen im jeweiligen Vorfalldetail.</p>
        </>}
        {tab==='reports'&&<ReportPanel stats={stats} filters={filters}/>}
        {tab!=='reports'&&tab!=='escalations'&&<Pagination page={filters.page} pages={pages} total={total}
          label="Einträge" onChange={page=>update('page',page)}/>}
      </Section>}
    </div>}

    {createOpen&&<Modal title="Vorfall erfassen" subtitle="Der Vorfall wird erst nach erfolgreicher Backend-Antwort angezeigt."
      onClose={()=>setCreateOpen(false)} wide>
      <form className="ops-form-grid" onSubmit={createIncident}>
        <label className="ops-span-2">Beschreibung<textarea required maxLength={5000} value={createForm.description}
          onChange={event=>setCreateForm({...createForm,description:event.target.value})}/></label>
        <label>Vorfallart<select required value={createForm.type}
          onChange={event=>setCreateForm({...createForm,type:event.target.value})}>
          <option value="">Bitte wählen</option>
          {types.map(([value,label])=><option key={value} value={value}>{label}</option>)}
        </select></label>
        <label>Priorität<select required value={createForm.priority_id}
          onChange={event=>setCreateForm({...createForm,priority_id:event.target.value})}>
          <option value="">Bitte wählen</option>
          {priorities.map(priority=><option key={display(priority,['id'])} value={display(priority,['id'])}>
            {display(priority,['name','code'])}</option>)}
        </select></label>
        {priorities.length===0&&<p className="ops-note">Prioritäten konnten nicht geladen werden; das Backend prüft die Priorität trotzdem.</p>}
        <label>Objekt{sites.length>0?<select value={createForm.site_id}
          onChange={event=>setCreateForm({...createForm,site_id:event.target.value})}>
          <option value="">Kein Objekt</option>
          {sites.map(site=><option key={display(site,['id'])} value={display(site,['id'])}>{display(site,['name'])}</option>)}
        </select>:<input value={createForm.site_id} onChange={event=>setCreateForm({...createForm,site_id:event.target.value})}
          placeholder="Objekt-UUID (optional)"/>}</label>
        <label>Begründung<input value={createForm.reason} onChange={event=>setCreateForm({...createForm,reason:event.target.value})}/></label>
        <div className="ops-form-actions">
          <button type="submit" disabled={createBusy||!createForm.type||!createForm.priority_id}>
            {createBusy?'Wird gespeichert …':'Vorfall speichern'}</button>
          <button type="button" className="ops-secondary" onClick={()=>setCreateOpen(false)}>Abbrechen</button>
        </div>
      </form>
    </Modal>}

    {statusFor&&<Modal title="Maßnahmenstatus ändern" subtitle={display(statusFor,['title'])} onClose={()=>setStatusFor(null)}>
      <form className="ops-form-grid" onSubmit={changeMeasureStatus}>
        <label>Neuer Status<select value={statusValue} onChange={event=>setStatusValue(event.target.value)}>
          <option value="in_progress">In Bearbeitung</option><option value="on_hold">Zurückgestellt</option>
          <option value="done">Abgeschlossen</option>
        </select></label>
        <label>Begründung<input value={statusReason} onChange={event=>setStatusReason(event.target.value)}/></label>
        <p className="ops-lock">Ein Abschluss wird vom Backend abgelehnt, solange die Ursache fortbesteht.</p>
        <div className="ops-form-actions">
          <button type="submit" disabled={busyId===display(statusFor,['id'])}>Speichern</button>
          <button type="button" className="ops-secondary" onClick={()=>setStatusFor(null)}>Abbrechen</button>
        </div>
      </form>
    </Modal>}

    {resolveFor&&<Modal title="Alarm erledigen" subtitle={display(resolveFor,['description'],'–')} onClose={()=>setResolveFor(null)}>
      <form className="ops-form-grid" onSubmit={resolveAlarm}>
        <label className="ops-span-2">Begründung<textarea required value={resolveReason}
          onChange={event=>setResolveReason(event.target.value)}/></label>
        <p className="ops-note">Die Erledigung wird vom Backend mit Begründung protokolliert.</p>
        <div className="ops-form-actions">
          <button type="submit" disabled={busyId===display(resolveFor,['id'])}>Erledigen</button>
          <button type="button" className="ops-secondary" onClick={()=>setResolveFor(null)}>Abbrechen</button>
        </div>
      </form>
    </Modal>}

    {historyFor&&<Modal title="Alarmverlauf" subtitle={display(historyFor,['description'],'–')}
      onClose={()=>setHistoryFor(null)}>
      <p className="ops-note">Eine Quittierung bestätigt nur den Eingang; sie beseitigt die auslösende Ursache nicht.</p>
      {historyLoading&&<LoadingSkeleton rows={3} label="Verlauf wird geladen …"/>}
      {historyError&&<ErrorState message={`Verlauf konnte nicht geladen werden: ${historyError}`}
        onRetry={()=>void openHistory(historyFor)}/>}
      {!historyLoading&&!historyError&&<ul className="ops-history">{history.length===0?<EmptyState>Keine Daten</EmptyState>
        :history.map((entry,index)=><li key={display(entry,['id'],String(index))}>
          <time>{formatDateTime(field(entry,['created_at','occurred_at','at']) as string)}</time>
          <strong>{display(entry,['to_status','event_type','type','action'],'Ereignis')}</strong>{' · '}
          {display(entry,['note','message','actor'],'–')}
        </li>)}</ul>}
    </Modal>}

    <p className="ops-generated">Berichtsdatum: {formatDate(berlinToday())} · Daten werden bei relevanten Ereignissen automatisch aktualisiert.</p>
  </div>;
}
