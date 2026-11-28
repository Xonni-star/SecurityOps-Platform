import {FormEvent,useCallback,useEffect,useState} from 'react';
import {api,hasPermission} from '../lib/api';
import {formatDateTime,formatNumber} from '../lib/format';
import {statusLabel} from '../lib/status';
import {commonText} from '../lib/text';
import {errorText,text} from '../lib/operations';
import {
  Badge,EmptyState,ErrorState,LoadingSkeleton,Modal,Meta,Pagination,ResponsiveTable,Section,
  type TableColumn,
} from '../components/operative/Common';

type ReportingModule={
  key:string;slug:string;title:string;description:string;source:string;filters:string[];
};
type OverviewModule=ReportingModule&{total:number};
type FilterResponse={
  from:string;to:string;site_id:string|null;customer_id:string|null;employee_id:string|null;
  q:string|null;sort:FilterState['sort'];order:FilterState['order'];page:number;page_size:number;
};
type Overview={
  generated_at:string;timezone:string;filters:FilterResponse;
  scope:'site'|'tenant';modules:OverviewModule[];
};
type FilterState={
  from:string;to:string;site_id:string;customer_id:string;employee_id:string;
  q:string;sort:'occurred_at'|'label'|'status';order:'asc'|'desc';page:number;page_size:number;
};
type ReportingRow={
  id:string;label:string;status:string;occurred_at:string;
  site_id:string|null;customer_id:string|null;employee_id:string|null;
  site_name:string|null;customer_name:string|null;employee_name:string|null;
  details:Record<string,unknown>;metric:number|string|null;metric_label:string|null;total?:number;
};
type ModuleDetail={
  module:ReportingModule;filters:FilterResponse;total:number;page:number;page_size:number;page_count:number;rows:ReportingRow[];
};
type Option={id:string;name:string};

const initialFilters:FilterState={
  from:'',to:'',site_id:'',customer_id:'',employee_id:'',q:'',
  sort:'occurred_at',order:'desc',page:1,page_size:25,
};

const exportKinds:{kind:string;label:string}[]=[
  {kind:'employees',label:'Mitarbeiter'},
  {kind:'sites',label:'Objekte'},
  {kind:'patrols',label:'Kontrollgänge'},
  {kind:'alarms',label:'Alarme'},
  {kind:'incidents',label:'Einsätze'},
  {kind:'work-time',label:'Arbeitszeiten'},
];

function queryString(filters:FilterState,extra:Record<string,string>={}){
  const params=new URLSearchParams();
  for(const [key,value] of Object.entries(filters)){
    if(value!==''&&value!==null&&value!==undefined)params.set(key,String(value));
  }
  for(const [key,value] of Object.entries(extra))if(value)params.set(key,value);
  const query=params.toString();
  return query?`?${query}`:'';
}

function statusTone(value:string):'good'|'critical'|'warning'|'info'|'neutral'{
  const key=value.toLowerCase();
  if(['approved','valid','gueltig','resolved','completed','done','active','available'].includes(key))return 'good';
  if(['expired','abgelaufen','revoked','ueberfaellig','invalid','lost','cancelled','rejected'].includes(key))return 'critical';
  if(['pending_approval','bald faellig','in_progress','escalated','open','issued'].includes(key))return 'warning';
  if(['archived','draft'].includes(key))return 'info';
  return 'neutral';
}

function detailValue(value:unknown){
  if(value===null||value===undefined||value==='')return text(value);
  if(typeof value==='object')return JSON.stringify(value);
  return text(value);
}

export function Reports(){
  const canRead=hasPermission('reports:read');
  const [draft,setDraft]=useState<FilterState>(initialFilters);
  const [applied,setApplied]=useState<FilterState>(initialFilters);
  const [selected,setSelected]=useState('');
  const [overview,setOverview]=useState<Overview|null>(null);
  const [detail,setDetail]=useState<ModuleDetail|null>(null);
  const [sites,setSites]=useState<Option[]>([]);
  const [customers,setCustomers]=useState<Option[]>([]);
  const [employees,setEmployees]=useState<Option[]>([]);
  const [loading,setLoading]=useState(canRead);
  const [error,setError]=useState('');
  const [detailRow,setDetailRow]=useState<ReportingRow|null>(null);

  const loadOverview=useCallback(async()=>{
    const value=await api<Overview>(`/reports/center/overview${queryString(applied)}`);
    if(!value)throw new Error('Die Modulübersicht konnte nicht geladen werden.');
    setOverview(value);
    setSelected(current=>current||value.modules[0]?.slug||'');
    return value;
  },[applied]);

  const loadDetail=useCallback(async()=>{
    if(!selected)return;
    const value=await api<ModuleDetail>(`/reports/center/modules/${selected}${queryString(applied)}`);
    if(!value)throw new Error('Die Modulauswertung konnte nicht geladen werden.');
    setDetail(value);
  },[applied,selected]);

  const reload=useCallback(async()=>{
    setLoading(true);setError('');
    try{await Promise.all([loadOverview(),loadDetail()]);}
    catch(cause){setError(errorText(cause));}
    finally{setLoading(false);}
  },[loadOverview,loadDetail]);

  useEffect(()=>{
    if(!canRead)return;
    void reload();
  },[canRead,reload]);

  useEffect(()=>{
    if(!canRead)return;
    void Promise.all([
      api<Option[]>('/sites').catch(()=>[]),
      api<Option[]>('/customers').catch(()=>[]),
      api<Option[]>('/employees').catch(()=>[]),
    ]).then(([siteOptions,customerOptions,employeeOptions])=>{
      setSites(Array.isArray(siteOptions)?siteOptions:[]);
      setCustomers(Array.isArray(customerOptions)?customerOptions:[]);
      setEmployees(Array.isArray(employeeOptions)?employeeOptions:[]);
    });
  },[canRead]);

  function submit(event:FormEvent){
    event.preventDefault();
    setApplied({...draft,page:1});
  }

  function reset(){
    setDraft(initialFilters);setApplied(initialFilters);setSelected('');setOverview(null);setDetail(null);
  }

  function changePage(page:number){
    setDraft(current=>({...current,page}));
    setApplied(current=>({...current,page}));
  }

  function openExport(format:'csv'|'pdf'|'xlsx'){
    if(!selected)return;
    const query=queryString(applied,{module:selected,format});
    window.open(`/api/v1/reports/center/export${query}`,'_blank','noopener,noreferrer');
  }

  if(!canRead)return <section><h1>Reporting-Zentrum</h1><p>{commonText.noPermission}</p></section>;

  const columns:TableColumn<ReportingRow>[]=[
    {key:'occurred_at',label:'Zeitpunkt',render:row=><span>{formatDateTime(row.occurred_at)}</span>},
    {key:'label',label:'Bezeichnung',render:row=><strong>{row.label}</strong>},
    {key:'status',label:'Status',render:row=><Badge tone={statusTone(row.status)}>{statusLabel(row.status)}</Badge>},
    {key:'site_name',label:'Objekt',render:row=>text(row.site_name??row.site_id)},
    {key:'customer_name',label:'Kunde',render:row=>text(row.customer_name??row.customer_id)},
    {key:'employee_name',label:'Mitarbeiter',render:row=>text(row.employee_name??row.employee_id)},
    {key:'metric',label:'Kennzahl',render:row=>row.metric===null||row.metric===undefined?'–':`${formatNumber(Number(row.metric))} ${row.metric_label??''}`.trim()},
    {key:'details',label:'Details',render:row=><button type="button" className="ops-secondary" onClick={()=>setDetailRow(row)}>Ansehen</button>},
  ];

  return <section>
    <h1>Reporting-Zentrum</h1>
    <p>Alle Auswertungen werden live aus den vorhandenen Fachdaten des Mandanten abgeleitet. Es gibt keine zweite Datenbank, keine zwischengespeicherten Kennzahlen und keine Beispieldaten.</p>
    {error&&<ErrorState message={error} onRetry={()=>void reload()}/>}

    <Section id="reporting-filter" title="Zentraler Filter" description="Kalendertage und Zeiten werden in Europe/Berlin ausgewertet.">
      <form className="ops-filters" onSubmit={submit}>
        <label>Von
          <input type="date" value={draft.from} onChange={event=>setDraft({...draft,from:event.target.value})}/>
        </label>
        <label>Bis
          <input type="date" value={draft.to} onChange={event=>setDraft({...draft,to:event.target.value})}/>
        </label>
        <label>Objekt
          <select value={draft.site_id} onChange={event=>setDraft({...draft,site_id:event.target.value})}>
            <option value="">Alle Objekte</option>
            {sites.map(site=><option key={site.id} value={site.id}>{site.name}</option>)}
          </select>
        </label>
        <label>Kunde
          <select value={draft.customer_id} onChange={event=>setDraft({...draft,customer_id:event.target.value})}>
            <option value="">Alle Kunden</option>
            {customers.map(customer=><option key={customer.id} value={customer.id}>{customer.name}</option>)}
          </select>
        </label>
        <label>Mitarbeiter
          <select value={draft.employee_id} onChange={event=>setDraft({...draft,employee_id:event.target.value})}>
            <option value="">Alle Mitarbeiter</option>
            {employees.map(employee=><option key={employee.id} value={employee.id}>{employee.name}</option>)}
          </select>
        </label>
        <label>Suche
          <input type="search" value={draft.q} maxLength={160} placeholder="Bezeichnung, Status oder Details" onChange={event=>setDraft({...draft,q:event.target.value})}/>
        </label>
        <label>Sortierung
          <select value={draft.sort} onChange={event=>setDraft({...draft,sort:event.target.value as FilterState['sort']})}>
            <option value="occurred_at">Zeitpunkt</option>
            <option value="label">Bezeichnung</option>
            <option value="status">Status</option>
          </select>
        </label>
        <label>Richtung
          <select value={draft.order} onChange={event=>setDraft({...draft,order:event.target.value as FilterState['order']})}>
            <option value="desc">Absteigend</option>
            <option value="asc">Aufsteigend</option>
          </select>
        </label>
        <label>Einträge je Seite
          <select value={draft.page_size} onChange={event=>setDraft({...draft,page_size:Number(event.target.value)})}>
            {[25,50,100,250,500].map(size=><option key={size} value={size}>{size}</option>)}
          </select>
        </label>
        <div className="ops-filter-actions">
          <button type="submit">Filter anwenden</button>
          <button type="button" className="ops-secondary" onClick={reset}>Zurücksetzen</button>
        </div>
      </form>
      {overview&&<p className="ops-generated">
        Zeitraum: {overview.filters.from} bis {overview.filters.to} · Scope: {overview.scope==='site'?'Objektbereich':'Mandant'} · Stand: {formatDateTime(overview.generated_at)}
      </p>}
    </Section>

    <Section id="reporting-modules" title="Module A–M" description="Kennzahlen stammen aus den Fachtabellen der jeweiligen Betriebsdomäne.">
      {loading&&!overview?<LoadingSkeleton rows={4}/>:overview?
        <div className="ops-grid">
          {overview.modules.map(module=><article className="ops-tile" key={module.slug}>
            <h4><Badge tone="info">{module.key}</Badge> {module.title}</h4>
            <p className="ops-note">{module.description}</p>
            <div className="ops-kpis"><div className="ops-kpi">
              <strong>{formatNumber(module.total)}</strong><span>Datensätze im Filter</span>
            </div></div>
            <button type="button" className="ops-secondary" aria-pressed={selected===module.slug} onClick={()=>setSelected(module.slug)}>
              {selected===module.slug?'Ausgewählt':'Details anzeigen'}
            </button>
          </article>)}
        </div>:<EmptyState>{commonText.noData}</EmptyState>}
    </Section>

    {selected&&<Section id="reporting-detail" title={detail?.module.title??'Modulauswertung'} description={detail?.module.description}
      actions={<>
        <button type="button" className="ops-secondary" onClick={()=>openExport('csv')}>{commonText.exportCsv}</button>
        <button type="button" className="ops-secondary" onClick={()=>openExport('pdf')}>{commonText.exportPdf}</button>
        <button type="button" className="ops-secondary" onClick={()=>openExport('xlsx')}>XLSX exportieren</button>
      </>}>
      {loading&&!detail?<LoadingSkeleton rows={5}/>:detail?
        <>
          <ResponsiveTable columns={columns} rows={detail.rows} rowKey={row=>row.id}
            caption={`Gefilterte Datensätze aus ${detail.module.source}`}
            empty="Für diesen Filter und dieses Modul wurden keine Datensätze gefunden."/>
          <Pagination page={detail.page} pages={detail.page_count} total={detail.total} onChange={changePage} label="Datensätze"/>
          <p className="ops-note">Exporte sind auf 5.000 Zeilen begrenzt; eine Kürzung wird im Download und im Auditprotokoll ausgewiesen.</p>
        </>:<EmptyState>{commonText.noData}</EmptyState>}
    </Section>}

    <Section id="reporting-legacy-exports" title="Weitere Standardexporte" description="Bestehende Mitarbeiter-, Objekt-, Kontrollgang-, Alarm-, Vorfalls- und Arbeitszeitberichte bleiben unverändert verfügbar.">
      <ul>{exportKinds.map(({kind,label})=><li key={kind}>
        {label}: {' '}
        <a href={`/api/v1/reports/${kind}?format=csv`} target="_blank" rel="noreferrer">CSV-Datei</a>
        {' · '}<a href={`/api/v1/reports/${kind}?format=pdf`} target="_blank" rel="noreferrer">PDF-Datei</a>
      </li>)}</ul>
    </Section>

    {detailRow&&<Modal title="Berichtsdetails" subtitle={detailRow.label} onClose={()=>setDetailRow(null)}>
      <div className="ops-meta-list">
        <Meta label="Zeitpunkt" value={formatDateTime(detailRow.occurred_at)}/>
        <Meta label="Status" value={statusLabel(detailRow.status)}/>
        <Meta label="Objekt" value={text(detailRow.site_name??detailRow.site_id)}/>
        <Meta label="Kunde" value={text(detailRow.customer_name??detailRow.customer_id)}/>
        <Meta label="Mitarbeiter" value={text(detailRow.employee_name??detailRow.employee_id)}/>
        {detailRow.metric!==null&&detailRow.metric!==undefined&&<Meta label="Kennzahl" value={`${formatNumber(Number(detailRow.metric))} ${detailRow.metric_label??''}`.trim()}/>}
      </div>
      <h4>Weitere Angaben</h4>
      <div className="ops-meta-list">
        {Object.entries(detailRow.details??{}).map(([key,value])=><Meta key={key} label={key} value={detailValue(value)}/>)}
      </div>
    </Modal>}
  </section>;
}
