import {FormEvent,useCallback,useEffect,useState} from 'react';
import {Link} from 'react-router-dom';
import {api,hasPermission} from '../lib/api';
import {formatDate,formatDateTime,formatNumber,formatTime,berlinToday} from '../lib/format';
import {statusLabel} from '../lib/status';
import {uuid} from '../lib/uuid';
import {
  alertMeasureSource,asArray,display,errorText,field,isForbidden,isSourceOpen,matchesSearch,
  numberOrNull,pagedGet,query,text,
  type ControlAlert,type ControlCenter,type ControlShift,type Loose,type Measure,
} from '../lib/operations';
import {useRealtimeRefresh} from '../lib/useRealtimeRefresh';
import {
  Badge,EmptyState,ErrorState,LoadingSkeleton,Modal,Pagination,ResponsiveTable,Section,
  type TableColumn,
} from '../components/operative/Common';

type Filters={
  date:string;site_id:string;customer_id:string;employee_id:string;q:string;
  module:string;status:string;overdue:boolean;page:number;page_size:number;measure_page:number;
};

const initialFilters:Filters={
  date:berlinToday(),site_id:'',customer_id:'',employee_id:'',q:'',module:'',status:'',overdue:false,
  page:1,page_size:25,measure_page:1,
};

const modules:[string,string][]=[
  ['leitstelle','Leitstelle'],['einsatz','Einsatz'],['schicht','Schicht'],['objekt','Objekt'],
  ['mitarbeiter','Mitarbeiter'],['qualifikation','Qualifikation'],['dokument','Dokument'],
  ['nfc','NFC'],['schluessel','Schlüssel'],['kunde','Kunde'],['system','System'],
];
const measureStatuses:[string,string][]=[
  ['open','Offen'],['in_progress','In Bearbeitung'],['on_hold','Zurückgestellt'],
  ['done','Abgeschlossen'],['cancelled','Abgebrochen'],
];

const priorities=['critical','high','medium','low'];

function tone(value:string|null|undefined):'critical'|'high'|'medium'|'low'|'neutral'{
  const key=String(value??'').toLowerCase();
  return priorities.includes(key)?key as 'critical'|'high'|'medium'|'low':'neutral';
}

function shiftStatusLabel(value:string):string{
  const labels:Record<string,string>={
    geplant:'Geplant',laufend:'Laufend',besetzt:'Besetzt',unterbesetzt:'Unterbesetzt',
    unbesetzt:'Unbesetzt',konflikt:'Konflikt',abgeschlossen:'Abgeschlossen',
  };
  return labels[value]??value.replace(/_/g,' ');
}
function qualificationStatusLabel(value:string):string{
  const labels:Record<string,string>={
    geprueft:'Geprüft',offen:'Offen',eingeschraenkt:'Eingeschränkt',konflikt:'Konflikt',
  };
  return labels[value]??value.replace(/_/g,' ');
}
function employeeStatusLabel(value:string):string{
  const labels:Record<string,string>={
    verfuegbar:'Verfügbar',nicht_verfuegbar:'Nicht verfügbar',abwesend:'Abwesend',
    eingeplant:'Eingeplant',nicht_qualifiziert:'Nicht qualifiziert',
  };
  return labels[value]??value.replace(/_/g,' ');
}
function candidateStatusLabel(value:string):string{
  if(value==='eligible')return 'Geeignet';
  if(value==='restricted')return 'Eingeschränkt geeignet';
  return statusLabel(value,'scheduling');
}
function absentLabel(value:unknown):string{
  if(Array.isArray(value)&&value.length===0)return 'Keine';
  return value==null||value===''?'–':text(value);
}
function detailLink(path:string|null|undefined,label:string){
  if(!path)return <span>–</span>;
  return path.startsWith('/')?<Link to={path}>{label}</Link>:<a href={path} target="_blank" rel="noreferrer">{label}</a>;
}

export function OperativeLeitstelle(){
  const canReadCenter=hasPermission('nsl:read');
  const canReadMeasures=hasPermission('operations_measures:read');
  const canWriteMeasures=hasPermission('operations_measures:write');
  const canReadCandidates=hasPermission('scheduling:read');
  const canAccess=canReadCenter||canReadMeasures;

  const [filters,setFilters]=useState<Filters>(initialFilters);
  const [center,setCenter]=useState<ControlCenter|null>(null);
  const [centerLoading,setCenterLoading]=useState(canReadCenter);
  const [centerError,setCenterError]=useState('');
  const [centerDenied,setCenterDenied]=useState(false);
  const [measures,setMeasures]=useState<Measure[]>([]);
  const [measureTotal,setMeasureTotal]=useState(0);
  const [measurePages,setMeasurePages]=useState(1);
  const [measureLoading,setMeasureLoading]=useState(canReadMeasures);
  const [measureError,setMeasureError]=useState('');
  const [notice,setNotice]=useState('');

  const [createFor,setCreateFor]=useState<ControlAlert|null>(null);
  const [createForm,setCreateForm]=useState({title:'',description:'',module:'leitstelle',priority:'medium',due_at:'',reason:''});
  const [createError,setCreateError]=useState('');
  const [createBusy,setCreateBusy]=useState(false);

  const [statusFor,setStatusFor]=useState<Measure|null>(null);
  const [statusValue,setStatusValue]=useState<'in_progress'|'on_hold'|'done'>('in_progress');
  const [statusReason,setStatusReason]=useState('');
  const [statusError,setStatusError]=useState('');
  const [statusBusy,setStatusBusy]=useState(false);

  const [candidateShift,setCandidateShift]=useState<ControlShift|null>(null);
  const [candidates,setCandidates]=useState<Loose[]>([]);
  const [candidatesLoading,setCandidatesLoading]=useState(false);
  const [candidatesError,setCandidatesError]=useState('');

  const loadCenter=useCallback(async()=>{
    if(!canReadCenter)return;
    setCenterLoading(true);
    try{
      const result=await api<ControlCenter>(`/operations/control-center?${query({
        date:filters.date,site_id:filters.site_id,customer_id:filters.customer_id,
        employee_id:filters.employee_id,page:filters.page,page_size:filters.page_size,
      })}`);
      setCenter(result??null);setCenterError('');setCenterDenied(false);
    }catch(cause){
      if(isForbidden(cause)){setCenterDenied(true);setCenterError('');}
      else{setCenterError(errorText(cause));setCenterDenied(false);}
      setCenter(null);
    }finally{setCenterLoading(false);}
  },[canReadCenter,filters.date,filters.site_id,filters.customer_id,filters.employee_id,filters.page,filters.page_size]);

  const loadMeasures=useCallback(async()=>{
    if(!canReadMeasures)return;
    setMeasureLoading(true);
    try{
      const result=await pagedGet<Measure>(`/operations/measures?${query({
        q:filters.q,status:filters.status,module:filters.module,site_id:filters.site_id,
        overdue:filters.overdue,page:filters.measure_page,page_size:filters.page_size,
      })}`);
      setMeasures(result.rows);setMeasureTotal(result.total);setMeasurePages(result.pages);setMeasureError('');
    }catch(cause){setMeasures([]);setMeasureTotal(0);setMeasurePages(1);setMeasureError(errorText(cause));}
    finally{setMeasureLoading(false);}
  },[canReadMeasures,filters.q,filters.status,filters.module,filters.site_id,filters.overdue,filters.measure_page,filters.page_size]);

  useEffect(()=>{void loadCenter();},[loadCenter]);
  useEffect(()=>{void loadMeasures();},[loadMeasures]);
  useRealtimeRefresh(()=>{void loadCenter();void loadMeasures();},
    ['alarm.','incident.','operations.measure.','notification.created'],canAccess);

  const update=<K extends keyof Filters>(key:K,value:Filters[K])=>setFilters(current=>({
    ...current,[key]:value,
    page:key==='page'?Number(value):(key==='date'||key==='site_id'||key==='customer_id'||key==='employee_id'?1:current.page),
    measure_page:key==='measure_page'?Number(value):(key==='page'?current.measure_page:1),
  }));
  const reset=()=>{setFilters(initialFilters);setNotice('');};
  const refreshAll=()=>{void loadCenter();void loadMeasures();};

  const search=filters.q.trim().toLocaleLowerCase('de-DE');
  const scoped=<T extends object>(rows:T[])=>search?rows.filter(row=>matchesSearch(row,search)):rows;
  const options=center?.filter_options??{sites:[],customers:[],employees:[]};
  const show=(key:string)=>center?.sections?.[key]===true;

  const shiftColumns:TableColumn<ControlShift>[]=[
    {key:'site',label:'Objekt / Rolle',render:row=><><strong>{row.site_name||'Kein Objekt'}</strong><small>{row.customer_name||'Kein Kunde'} · {text(row.role_code,'–')}</small></>},
    {key:'period',label:'Zeitraum',render:row=><>{formatTime(row.starts_at)} – {formatTime(row.ends_at)}<small>{formatDate(row.starts_at)}</small></>},
    {key:'staffing',label:'Besetzung',render:row=><>{formatNumber(row.actual)} / {formatNumber(row.target)}<small>{shiftStatusLabel(String(row.status))}</small></>},
    {key:'qualification',label:'Qualifikation',render:row=><Badge tone={row.qualification_status==='konflikt'?'critical':row.qualification_status==='eingeschraenkt'?'warning':'neutral'}>{qualificationStatusLabel(String(row.qualification_status))}</Badge>},
    {key:'reasons',label:'Hinweise',render:row=>row.notes?.length?<ul className="ops-badges">{row.notes.map((note,index)=><li key={`${note}-${index}`}><Badge tone="warning">{text(note)}</Badge></li>)}</ul>:<span>–</span>},
    {key:'actions',label:'Aktionen',render:row=><div className="ops-row-actions">
      {canReadCandidates&&<button type="button" className="ops-secondary" onClick={()=>void openCandidates(row)}>Kandidaten</button>}
      <Link to={`/scheduling?shift=${row.id}`}>Dienstplan</Link>
    </div>},
  ];

  const employeeColumns:TableColumn<Loose>[]=[
    {key:'name',label:'Mitarbeiter',render:row=><><strong>{display(row,['name'])}</strong><small>{display(row,['position'],'–')}</small></>},
    {key:'status',label:'Status',render:row=>{const value=display(row,['status']);return <Badge tone={value==='abwesend'||value==='nicht_qualifiziert'?'critical':value==='verfuegbar'?'good':'neutral'}>{employeeStatusLabel(value)}</Badge>;}},
    {key:'available',label:'Verfügbar jetzt',render:row=>field(row,['available_now'])===true?<Badge tone="good">Ja</Badge>:<Badge>Nein</Badge>},
    {key:'qualifications',label:'Qualifikationen',render:row=>absentLabel(field(row,['qualification_states']))},
    {key:'absences',label:'Abwesenheiten',render:row=>absentLabel(field(row,['absences']))},
    {key:'assignments',label:'Künftige Zuordnungen',render:row=>formatNumber(numberOrNull(field(row,['upcoming_assignments'])))},
    {key:'actions',label:'Akte',render:row=><Link to={`/employees/${display(row,['id'])}`}>Öffnen</Link>},
  ];

  const siteColumns:TableColumn<Loose>[]=[
    {key:'site',label:'Objekt',render:row=><><strong>{display(row,['name'])}</strong><small>{display(row,['site_number'],'–')} · {display(row,['customer_name'],'Kein Kunde')}</small></>},
    {key:'coverage',label:'Abdeckung',render:row=>{const target=numberOrNull(field(row,['target']))??0;const actual=numberOrNull(field(row,['actual']))??0;
      const percent=target>0?Math.min(100,Math.round(actual/target*100)):0;
      return <div className="ops-coverage"><span>{formatNumber(actual)} / {formatNumber(target)}</span><div className={`ops-coverage-bar ${percent<100?'low':''}`}><span style={{width:`${percent}%`}}/></div></div>;}},
    {key:'shifts',label:'Schichten',render:row=><>{formatNumber(numberOrNull(field(row,['today_shifts'])))} offen: {formatNumber(numberOrNull(field(row,['open_shifts'])))}</>},
    {key:'issues',label:'Hinweise',render:row=><div className="ops-badges"><Badge tone="warning">Qualifikation {formatNumber(numberOrNull(field(row,['qualification_issues'])))}</Badge><Badge tone={(numberOrNull(field(row,['alarms']))??0)>0?'critical':'neutral'}>Alarme {formatNumber(numberOrNull(field(row,['alarms'])))}</Badge></div>},
    {key:'activity',label:'Letzte Aktivität',render:row=>formatDateTime(field(row,['last_activity_at']) as string)},
    {key:'actions',label:'Akte',render:row=><Link to={`/sites/${display(row,['id'])}`}>Öffnen</Link>},
  ];

  const qualificationColumns:TableColumn<Loose>[]=[
    {key:'employee',label:'Mitarbeiter',render:row=><Link to={`/employees/${display(row,['employee_id'])}/qualifikationen`}>{display(row,['employee_name'])}</Link>},
    {key:'code',label:'Qualifikation',render:row=><>{display(row,['code'])}<small>{display(row,['status_label'])}</small></>},
    {key:'status',label:'Status',render:row=><Badge tone={['revoked','invalid','expired','missing_evidence'].includes(display(row,['status']))?'critical':'warning'}>{display(row,['status_label'])}</Badge>},
    {key:'valid',label:'Gültig bis',render:row=>formatDate(field(row,['valid_until']) as string)},
    {key:'sites',label:'Objekte',render:row=>asArray(field(row,['sites'])).map(site=>display(site,['site_name'])).filter(value=>value!=='–').join(', ')||'–'},
  ];

  const documentColumns:TableColumn<Loose>[]=[
    {key:'title',label:'Dokument',render:row=><><strong>{display(row,['title'])}</strong><small>{display(row,['document_type'],'–')}</small></>},
    {key:'status',label:'Status',render:row=><Badge tone={display(row,['computed_status'])==='nicht_freigegeben'?'critical':'warning'}>{display(row,['status_label'])}</Badge>},
    {key:'expiry',label:'Ablauf',render:row=>{const days=numberOrNull(field(row,['days_until_expiry']));return days===null?'–':`${formatNumber(days)} Tage`;}},
    {key:'review',label:'Prüfung',render:row=>display(row,['review_state'])},
    {key:'actions',label:'DMS',render:row=><Link to={`/dms?document=${display(row,['id'])}`}>Öffnen</Link>},
  ];

  const requirementColumns:TableColumn<Loose>[]=[
    {key:'site',label:'Objekt',render:row=><Link to={`/sites/${display(row,['site_id'])}`}>{display(row,['site_name'])}</Link>},
    {key:'type',label:'Nachweistyp',render:row=>display(row,['document_type'])},
    {key:'status',label:'Status',render:row=><Badge tone={field(row,['missing'])===true?'critical':'warning'}>{display(row,['status_label'])}</Badge>},
    {key:'actions',label:'DMS',render:_row=><Link to="/dms">Öffnen</Link>},
  ];

  const deviceColumns:TableColumn<Loose>[]=[
    {key:'device',label:'Gerät',render:row=><><strong>{display(row,['identifier'])}</strong><small>{display(row,['device_type'],'–')}</small></>},
    {key:'status',label:'Status',render:row=><Badge tone={field(row,['attention'])===true?'critical':'good'}>{statusLabel(String(field(row,['status'])??''),'device')}</Badge>},
    {key:'site',label:'Objekt / Person',render:row=><>{display(row,['site_name'],'–')}<small>{display(row,['employee_name'],'–')}</small></>},
    {key:'assignable',label:'Zuweisbar',render:row=>field(row,['assignable'])===true?'Ja':'Nein'},
    {key:'actions',label:'Akte',render:row=><Link to={`/nfc-devices/${display(row,['id'])}`}>Öffnen</Link>},
  ];

  const keyColumns:TableColumn<Loose>[]=[
    {key:'key',label:'Schlüssel',render:row=><><strong>{display(row,['key_code'])}</strong><small>{display(row,['label'],'–')}</small></>},
    {key:'status',label:'Status',render:row=><Badge tone={field(row,['attention'])===true?'critical':'good'}>{display(row,['display_status'],statusLabel(String(field(row,['status'])??''),'key'))}</Badge>},
    {key:'site',label:'Objekt / Inhaber',render:row=><>{display(row,['site_name'],'–')}<small>{display(row,['holder_name'],'–')}</small></>},
    {key:'due',label:'Fällig',render:row=>formatDateTime(field(row,['due_at']) as string)},
    {key:'loss',label:'Verlustmeldung',render:row=>display(row,['loss_report_status'])},
    {key:'actions',label:'Akte',render:row=><Link to={`/keys/${display(row,['id'])}`}>Öffnen</Link>},
  ];

  const measureColumns:TableColumn<Measure>[]=[
    {key:'title',label:'Maßnahme',render:row=><><strong>{row.title}</strong><small>{text(row.description,'–')}</small></>},
    {key:'module',label:'Modul / Priorität',render:row=><div className="ops-badges"><Badge>{modules.find(([value])=>value===row.module)?.[1]??text(row.module,'–')}</Badge><Badge tone={tone(row.priority)}>{statusLabel(row.priority,'priority')}</Badge></div>},
    {key:'status',label:'Status',render:row=><Badge tone={row.status==='done'?'good':row.status==='in_progress'?'info':row.status==='on_hold'?'warning':'neutral'}>{statusLabel(row.status,'general')}</Badge>},
    {key:'due',label:'Fällig',render:row=>formatDateTime(row.due_at)},
    {key:'site',label:'Objekt / Person',render:row=><>{display(row,['site_name'],'–')}<small>{display(row,['assigned_employee_name'],'–')}</small></>},
    {key:'source',label:'Quelle',render:row=><>{display(row,['source_type'],'Manuell')}<small>{text(row.source_key,'–')}</small></>},
    {key:'actions',label:'Status ändern',render:row=>canWriteMeasures?<div className="ops-row-actions">
      {row.status!=='in_progress'&&<button type="button" className="ops-secondary" onClick={()=>openStatus(row,'in_progress')}>In Bearbeitung</button>}
      {row.status!=='on_hold'&&<button type="button" className="ops-secondary" onClick={()=>openStatus(row,'on_hold')}>Zurückstellen</button>}
      {row.status!=='done'&&<button type="button" onClick={()=>openStatus(row,'done')}>Abschließen</button>}
    </div>:<span>Keine Schreibberechtigung</span>},
  ];

  async function openCandidates(shift:ControlShift){
    if(!canReadCandidates)return;
    setCandidateShift(shift);setCandidates([]);setCandidatesLoading(true);setCandidatesError('');
    try{
      const result=await api<unknown>(`/operations/control-center/candidates?${query({shift_id:shift.id})}`);
      setCandidates(asArray(result,['candidates','items']));
    }catch(cause){setCandidatesError(errorText(cause));}
    finally{setCandidatesLoading(false);}
  }

  function openCreate(alert:ControlAlert){
    const source=alertMeasureSource(alert);
    const context=[alert.description,alert.recommendation?`Empfehlung: ${alert.recommendation}`:'',alert.link?`Quelle: ${alert.link}`:'']
      .filter(Boolean).join('\n\n');
    setCreateForm({title:alert.title.slice(0,240),description:context.slice(0,5000),module:source.module,
      priority:source.priority,due_at:'',reason:''});
    setCreateError('');setCreateFor(alert);
  }

  async function submitCreate(event:FormEvent){
    event.preventDefault();
    if(!createFor||!canWriteMeasures)return;
    if(!createForm.title.trim()){setCreateError('Bitte eine Bezeichnung angeben.');return;}
    setCreateBusy(true);setCreateError('');
    const source=alertMeasureSource(createFor);
    try{
      await api('/operations/measures',{method:'POST',body:JSON.stringify({
        title:createForm.title.trim(),description:createForm.description||null,module:createForm.module,
        priority:createForm.priority,site_id:createFor.site_id||null,
        ...(source.source_type?{source_type:source.source_type}:{}),
        ...(source.source_id?{source_id:source.source_id}:{}),
        source_key:source.source_key,client_mutation_id:uuid(),
        due_at:createForm.due_at?new Date(`${createForm.due_at}T23:59:00`).toISOString():null,
        reason:createForm.reason.trim()||undefined,
      })});
      setCreateFor(null);setNotice('Die Maßnahme wurde angelegt. Die Ursache bleibt bis zu ihrer tatsächlichen Behebung bestehen.');
      refreshAll();
    }catch(cause){setCreateError(errorText(cause));}
    finally{setCreateBusy(false);}
  }

  function openStatus(measure:Measure,status:'in_progress'|'on_hold'|'done'){
    setStatusFor(measure);setStatusValue(status);setStatusReason('');setStatusError('');
  }

  async function submitStatus(event:FormEvent){
    event.preventDefault();
    if(!statusFor||!canWriteMeasures)return;
    if(statusValue==='done'&&!statusReason.trim()){
      setStatusError('Bitte eine Begründung für den Abschluss angeben.');return;
    }
    setStatusBusy(true);setStatusError('');
    try{
      await api(`/operations/measures/${statusFor.id}`,{method:'PATCH',body:JSON.stringify({
        status:statusValue,reason:statusReason.trim()||undefined,
      })});
      setStatusFor(null);setNotice('Der Maßnahmenstatus wurde vom Backend gespeichert.');refreshAll();
    }catch(cause){
      setStatusError(isSourceOpen(cause)
        ?'Abschluss nicht möglich: Die Ursache der Maßnahme besteht weiterhin (source_open). Bitte zuerst die Ursache beheben; eine Quittierung beseitigt sie nicht.'
        :errorText(cause));
    }finally{setStatusBusy(false);}
  }

  if(!canAccess)return <div className="ops-page"><EmptyState>Keine Berechtigung für die Operative Leitstelle.</EmptyState></div>;

  return <div className="ops-page">
    <div className="ops-head">
      <div>
        <h2>Operative Leitstelle</h2>
        <p>Tageslage, Handlungsbedarf und Maßnahmen aus den freigegebenen Backend-Daten. Filter wirken auf die geladenen Bereiche; die Suche filtert zusätzlich lokal.</p>
      </div>
      <div className="ops-head-actions">
        {center&&<Badge tone={center.operational_status==='kritisch'?'critical':center.operational_status==='erhöht'?'warning':'good'}>Operative Lage: {center.operational_status}</Badge>}
        <button type="button" className="ops-secondary" onClick={refreshAll}>Aktualisieren</button>
      </div>
    </div>

    <form className="ops-filters" onSubmit={event=>{event.preventDefault();update('page',1);update('measure_page',1);}} aria-label="Leitstelle filtern">
      <label>Datum<input type="date" value={filters.date} onChange={event=>update('date',event.target.value)}/></label>
      <label>Objekt<select value={filters.site_id} onChange={event=>update('site_id',event.target.value)}>
        <option value="">Alle Objekte</option>
        {options.sites.map(site=><option key={display(site,['id'])} value={display(site,['id'])}>{display(site,['name'])}</option>)}
      </select></label>
      <label>Kunde<select value={filters.customer_id} onChange={event=>update('customer_id',event.target.value)}>
        <option value="">Alle Kunden</option>
        {options.customers.map(customer=><option key={display(customer,['id'])} value={display(customer,['id'])}>{display(customer,['name'])}</option>)}
      </select></label>
      <label>Mitarbeiter<select value={filters.employee_id} onChange={event=>update('employee_id',event.target.value)}>
        <option value="">Alle Mitarbeitenden</option>
        {options.employees.map(employee=><option key={display(employee,['id'])} value={display(employee,['id'])}>{display(employee,['name'])}</option>)}
      </select></label>
      <label>Suche<input type="search" value={filters.q} onChange={event=>update('q',event.target.value)} placeholder="Mitarbeiter, Objekt, Hinweis, Maßnahme"/></label>
      <label>Maßnahmen-Modul<select value={filters.module} onChange={event=>update('module',event.target.value)}>
        <option value="">Alle Module</option>{modules.map(([value,label])=><option key={value} value={value}>{label}</option>)}
      </select></label>
      <label>Maßnahmenstatus<select value={filters.status} onChange={event=>update('status',event.target.value)}>
        <option value="">Alle Status</option>{measureStatuses.map(([value,label])=><option key={value} value={value}>{label}</option>)}
      </select></label>
      <label className="ops-check"><input type="checkbox" checked={filters.overdue} onChange={event=>update('overdue',event.target.checked)}/> Nur überfällige Maßnahmen</label>
      <label>Einträge pro Seite<select value={filters.page_size} onChange={event=>update('page_size',Number(event.target.value))}>
        {[10,25,50,100].map(size=><option key={size} value={size}>{size}</option>)}
      </select></label>
      <div className="ops-filter-actions">
        <button type="submit">Filter anwenden</button>
        <button type="button" className="ops-secondary" onClick={reset}>Zurücksetzen</button>
      </div>
    </form>

    {notice&&<p className="ops-success" role="status">{notice}</p>}
    {center?.generated_at&&<p className="ops-generated">Datenstand: {formatDateTime(center.generated_at)} · Berichtsdatum: {formatDate(center.date)}</p>}

    {centerDenied&&<p className="ops-note" role="status">Der operative Gesamtüberblick ist für Ihr Konto nicht freigegeben. Maßnahmen bleiben verfügbar.</p>}
    {centerLoading&&<LoadingSkeleton rows={5} label="Leitstellendaten werden geladen …"/>}
    {centerError&&<ErrorState message={`Leitstellendaten konnten nicht geladen werden: ${centerError}`} onRetry={()=>void loadCenter()}/>}

    {center&&show('kpi')&&<Section id="kennzahlen" title="Kennzahlen" description="Definitionen der Kennzahlen werden beim Überfahren der Maus als Hinweis angezeigt.">
      <div className="ops-kpis">{center.kpis.length===0?<EmptyState/>:center.kpis.map(kpi=><article className="ops-kpi" key={kpi.key} title={kpi.definition}>
        <strong>{formatNumber(numberOrNull(kpi.value))}</strong>
        <span>{kpi.label}</span>
        {detailLink(kpi.link,'Details anzeigen')}
      </article>)}</div>
    </Section>}

    {center&&<Section id="handlungsbedarf" title="Sofortiger Handlungsbedarf"
      description="Hinweise aus den freigegebenen Bereichen. Eine Quittierung beseitigt niemals die Ursache; Maßnahmen werden separat und quellenverknüpft angelegt.">
      {scoped(center.alerts).length===0?<EmptyState>Keine Daten</EmptyState>:<div className="ops-alerts">
        {scoped(center.alerts).map((alert,index)=><article className={`ops-alert ${tone(alert.priority)}`} key={`${alert.source_key}-${index}`}>
          <Badge tone={tone(alert.priority)}>{statusLabel(alert.priority,'priority')}</Badge>
          <div className="ops-alert-body">
            <h4>{alert.title}</h4>
            <p>{alert.description}</p>
            <p className="ops-alert-recommendation"><strong>Empfehlung:</strong> {alert.recommendation||'–'}</p>
            <p><small>{[alert.site_name,alert.employee_name,alert.period,formatDateTime(alert.detected_at)].filter(Boolean).join(' · ')||'Keine weiteren Angaben'}</small></p>
            <div className="ops-alert-actions">
              {detailLink(alert.link,'Betroffenen Datensatz öffnen')}
              {canWriteMeasures&&<button type="button" onClick={()=>openCreate(alert)}>Maßnahme anlegen</button>}
            </div>
          </div>
        </article>)}
      </div>}
    </Section>}

    {center&&show('shifts')&&<Section id="einsaetze" title="Tagesübersicht Schichten"
      description={`${formatNumber(center.shifts_total)} Schichten am gewählten Tag · Seite ${formatNumber(center.page)} von ${formatNumber(Math.max(1,Math.ceil(center.shifts_total/Math.max(1,center.page_size))))}.`}>
      <ResponsiveTable columns={shiftColumns} rows={scoped(center.shifts)} rowKey={row=>row.id} empty="Keine Daten"/>
      <Pagination page={center.page} pages={Math.max(1,Math.ceil(center.shifts_total/Math.max(1,center.page_size)))}
        total={center.shifts_total} label="Schichten" onChange={page=>update('page',page)}/>
    </Section>}

    {center&&show('employees')&&<Section id="verfuegbarkeit" title="Verfügbarkeit"
      description="Verfügbarkeit berücksichtigt Beschäftigung, Abwesenheiten und harte Qualifikationszustände; sie ist nicht gleichbedeutend mit „nicht eingeplant“.">
      <ResponsiveTable columns={employeeColumns} rows={scoped(center.employees)} rowKey={row=>display(row,['id'])} empty="Keine Daten"/>
    </Section>}

    {center&&show('sites')&&<Section id="objekte" title="Objektstatus">
      <ResponsiveTable columns={siteColumns} rows={scoped(center.sites)} rowKey={row=>display(row,['id'])} empty="Keine Daten"/>
    </Section>}

    {center&&(show('qualifications')||show('documents'))&&<Section id="nachweise" title="Qualifikationen und Nachweise">
      {show('qualifications')&&<>
        <h4>Qualifikationszustände</h4>
        <ResponsiveTable columns={qualificationColumns} rows={scoped(center.qualifications)} rowKey={(row,index)=>display(row,['qualification_id'],`qualifikation-${index}`)} empty="Keine Daten"/>
      </>}
      {show('documents')&&<>
        <h4>Dokumentstatus</h4>
        <ResponsiveTable columns={documentColumns} rows={scoped(center.documents)} rowKey={row=>display(row,['id'])} empty="Keine Daten"/>
        <h4>Fehlende Pflichtnachweise</h4>
        <ResponsiveTable columns={requirementColumns} rows={scoped(center.document_requirements)} rowKey={row=>display(row,['id'])} empty="Keine Daten"/>
      </>}
    </Section>}

    {center&&(show('devices')||show('keys'))&&<Section id="geraete-schluessel" title="NFC- und Schlüsselstatus">
      {show('devices')&&<>
        <h4>NFC-Geräte</h4>
        <ResponsiveTable columns={deviceColumns} rows={scoped(center.devices)} rowKey={row=>display(row,['id'])} empty="Keine Daten"/>
      </>}
      {show('keys')&&<>
        <h4>Schlüssel</h4>
        <ResponsiveTable columns={keyColumns} rows={scoped(center.keys)} rowKey={row=>display(row,['id'])} empty="Keine Daten"/>
      </>}
    </Section>}

    {canReadMeasures&&<Section id="massnahmen" title="Offene Maßnahmen"
      description="Statuswechsel werden serverseitig geprüft. Ein Abschluss wird bei fortbestehender Ursache mit source_open abgelehnt.">
      {measureLoading&&<LoadingSkeleton rows={3} label="Maßnahmen werden geladen …"/>}
      {measureError&&<ErrorState message={`Maßnahmen konnten nicht geladen werden: ${measureError}`} onRetry={()=>void loadMeasures()}/>}
      {!measureLoading&&!measureError&&<ResponsiveTable columns={measureColumns} rows={scoped(measures)} rowKey={row=>row.id} empty="Keine Daten"/>}
      {!measureError&&<Pagination page={filters.measure_page} pages={measurePages} total={measureTotal} label="Maßnahmen"
        onChange={page=>update('measure_page',page)}/>}
      <p className="ops-note">Maßnahmen können auch aus <Link to="/einsatz?tab=massnahmen">Einsatzmanagement → Maßnahmen</Link> eingesehen werden.</p>
    </Section>}

    {createFor&&<Modal title="Maßnahme aus Hinweis anlegen" subtitle={`Quelle: ${createFor.source_key||'–'}`} onClose={()=>setCreateFor(null)} wide>
      <p className="ops-note">Die Maßnahme wird mit dem stabilen Quellschlüssel verknüpft. Eine doppelte Anlage wird vom Backend erkannt. Die Ursache wird durch das Anlegen nicht beseitigt.</p>
      <form className="ops-form-grid" onSubmit={submitCreate}>
        <label className="ops-span-2">Bezeichnung<input required maxLength={240} value={createForm.title} onChange={event=>setCreateForm({...createForm,title:event.target.value})}/></label>
        <label className="ops-span-2">Beschreibung<textarea value={createForm.description} onChange={event=>setCreateForm({...createForm,description:event.target.value})}/></label>
        <label>Modul<select value={createForm.module} onChange={event=>setCreateForm({...createForm,module:event.target.value})}>
          {modules.map(([value,label])=><option key={value} value={value}>{label}</option>)}
        </select></label>
        <label>Priorität<select value={createForm.priority} onChange={event=>setCreateForm({...createForm,priority:event.target.value})}>
          <option value="critical">Kritisch</option><option value="high">Hoch</option><option value="medium">Mittel</option><option value="low">Niedrig</option>
        </select></label>
        <label>Fällig am<input type="date" value={createForm.due_at} onChange={event=>setCreateForm({...createForm,due_at:event.target.value})}/></label>
        <label>Begründung<input value={createForm.reason} onChange={event=>setCreateForm({...createForm,reason:event.target.value})}/></label>
        {createError&&<p className="ops-error" role="alert">{createError}</p>}
        <div className="ops-form-actions">
          <button type="submit" disabled={createBusy}>{createBusy?'Wird gespeichert …':'Maßnahme anlegen'}</button>
          <button type="button" className="ops-secondary" onClick={()=>setCreateFor(null)}>Abbrechen</button>
        </div>
      </form>
    </Modal>}

    {statusFor&&<Modal title={`Status ändern: ${statusFor.title}`} subtitle={`Aktuell: ${statusLabel(statusFor.status,'general')}`} onClose={()=>setStatusFor(null)}>
      <form className="ops-form-grid" onSubmit={submitStatus}>
        <label>Neuer Status<select value={statusValue} onChange={event=>setStatusValue(event.target.value as 'in_progress'|'on_hold'|'done')}>
          <option value="in_progress">In Bearbeitung</option><option value="on_hold">Zurückgestellt</option><option value="done">Abgeschlossen</option>
        </select></label>
        <label>Begründung<input value={statusReason} onChange={event=>setStatusReason(event.target.value)} placeholder={statusValue==='done'?'Erforderlich für Abschluss':'Optional'}/></label>
        {statusValue==='done'&&<p className="ops-lock">Ein Abschluss ist erst möglich, wenn die automatisch erkannte Ursache nicht mehr besteht. Das Backend prüft dies erneut.</p>}
        {statusError&&<p className="ops-error" role="alert">{statusError}</p>}
        <div className="ops-form-actions">
          <button type="submit" disabled={statusBusy}>{statusBusy?'Wird gespeichert …':'Status speichern'}</button>
          <button type="button" className="ops-secondary" onClick={()=>setStatusFor(null)}>Abbrechen</button>
        </div>
      </form>
    </Modal>}

    {candidateShift&&<Modal title="Geeignete Kandidaten" subtitle={`${candidateShift.site_name} · ${candidateShift.role_code}`} onClose={()=>setCandidateShift(null)}>
      <p className="ops-note">Vorschläge aus der fachlichen Einsatzprüfung. Es erfolgt keine automatische Zuweisung; die Besetzung bleibt in der Dienstplanung.</p>
      {candidatesLoading&&<LoadingSkeleton rows={3} label="Kandidaten werden geprüft …"/>}
      {candidatesError&&<ErrorState message={`Kandidaten konnten nicht geladen werden: ${candidatesError}`} onRetry={()=>void openCandidates(candidateShift)}/>}
      {!candidatesLoading&&!candidatesError&&candidates.length===0&&<EmptyState>Keine Daten</EmptyState>}
      {!candidatesLoading&&!candidatesError&&candidates.length>0&&<ul>
        {candidates.map(candidate=><li key={display(candidate,['id'])}>
          <strong>{display(candidate,['name'])}</strong> · <Badge tone={display(candidate,['status'])==='eligible'?'good':'warning'}>{candidateStatusLabel(display(candidate,['status']))}</Badge>
          {Array.isArray(field(candidate,['reasons']))&&(field(candidate,['reasons']) as unknown[]).length>0&&
            <ul>{(field(candidate,['reasons']) as unknown[]).map((reason,index)=><li key={index}>{text(reason)}</li>)}</ul>}
        </li>)}
      </ul>}
      <div className="ops-row-actions"><Link to={`/scheduling?shift=${candidateShift.id}`}>Schicht in der Dienstplanung öffnen</Link></div>
    </Modal>}
  </div>;
}
