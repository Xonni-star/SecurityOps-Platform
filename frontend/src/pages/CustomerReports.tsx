import {FormEvent,useCallback,useEffect,useState} from 'react';
import {api,hasPermission} from '../lib/api';
import {useSearchParams} from 'react-router-dom';
import {berlinToday,formatDate,formatDateTime,formatNumber} from '../lib/format';
import {commonText} from '../lib/text';
import {
  Badge,EmptyState,ErrorState,LoadingSkeleton,Modal,Pagination,ResponsiveTable,Section,
} from '../components/operative/Common';

type Site={id:string;name:string};
type Customer={id:string;name:string};
type CustomerProfile={customer:{name:string};sites:{site_id:string;site_name:string}[]};
type Kind={slug:string;label:string;description:string;metricLabel:string};
type Row={
  id:string;occurred_at:string;site_id:string|null;site_name:string|null;
  category:string;label:string;status:string;metric:number;
};
type Filter={
  from:string;to:string;site_id:string|null;customer_id:string|null;q:string|null;
  sort:string;order:string;page:number;page_size:number;total:number;page_count:number;timezone:string;
};
type Preview={kind:string;kind_label:string;metric_label:string;rows:Row[];filter:Filter};
type Release={
  id:string;title:string;kind:string;kind_label:string;status:string;
  customer_id:string;customer_name:string|null;row_count:number;fingerprint:string;
  from:string;to:string;site_id:string|null;created_by:string;created_at:string;
  approved_by:string|null;approved_at:string|null;rejected_reason:string|null;
  revoked_reason:string|null;filters:Record<string,unknown>;
};
type ReleaseDetail=Release&{rows:Row[];allowed_site_ids:string[];current_row_count:number;data_basis_current:boolean};
type PortalDetail=Release&{rows:Row[];read_only:boolean;export_allowed:boolean};

const STATUS_LABEL:Record<string,string>={
  draft:'Entwurf',in_review:'In Prüfung',approved:'Freigegeben',rejected:'Zurückgegeben',revoked:'Widerrufen',
};
const STATUS_TONE:Record<string,'neutral'|'info'|'warning'|'good'|'critical'>={
  draft:'neutral',in_review:'info',approved:'good',rejected:'critical',revoked:'critical',
};
const exportUrl=(id:string,format:'csv'|'pdf'|'xlsx')=>
  `/api/v1/customer-reports/releases/${encodeURIComponent(id)}/export?format=${format}`;
const today=berlinToday();
async function required<T>(path:string,options:RequestInit={}):Promise<T>{
  const value=await api<T>(path,options);
  if(value===undefined)throw new Error(commonText.requestFailed);
  return value;
}

export function CustomerReports(){
  const [searchParams]=useSearchParams();
  const initialCustomer=searchParams.get('customer_id');
  const initialSite=searchParams.get('site_id');
  const canRead=hasPermission('customer_reports:read')||hasPermission('customer_reports:write')||hasPermission('customer_reports:approve');
  const canWrite=hasPermission('customer_reports:write');
  const canApprove=hasPermission('customer_reports:approve');
  const canExport=hasPermission('customer_reports:export');
  const canPortal=hasPermission('customer_portal:read');

  const [tab,setTab]=useState<'create'|'releases'|'portal'>(canPortal&&!canRead?'portal':'create');
  const [kinds,setKinds]=useState<Kind[]>([]);
  const [customers,setCustomers]=useState<Customer[]>([]);
  const [sites,setSites]=useState<Site[]>([]);
  const [customerName,setCustomerName]=useState('');
  const [title,setTitle]=useState('');
  const [kind,setKind]=useState('control-walks');
  const [customerId,setCustomerId]=useState(initialCustomer??'');
  const [siteId,setSiteId]=useState(initialSite??'');
  const [from,setFrom]=useState('');
  const [to,setTo]=useState('');
  const [q,setQ]=useState('');
  const [sort,setSort]=useState('occurred_at');
  const [order,setOrder]=useState('desc');
  const [preview,setPreview]=useState<Preview|null>(null);
  const [releases,setReleases]=useState<Release[]>([]);
  const [portalReleases,setPortalReleases]=useState<Release[]>([]);
  const [detail,setDetail]=useState<ReleaseDetail|null>(null);
  const [portalDetail,setPortalDetail]=useState<PortalDetail|null>(null);
  const [reason,setReason]=useState('');
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState('');
  const [success,setSuccess]=useState('');

  const queryString=useCallback(()=>{
    const params=new URLSearchParams();
    if(from)params.set('from',from);
    if(to)params.set('to',to);
    if(siteId)params.set('site_id',siteId);
    if(customerId)params.set('customer_id',customerId);
    if(q.trim())params.set('q',q.trim());
    params.set('sort',sort);
    params.set('order',order);
    if(preview){
      params.set('page',String(preview.filter.page));
      params.set('page_size',String(preview.filter.page_size));
    }
    return params.toString();
  },[from,to,siteId,customerId,q,sort,order,preview]);

  const loadPreview=useCallback(async()=>{
    setLoading(true);setError('');
    try{
      const value=await required<Preview>(`/customer-reports/preview/${kind}?${queryString()}`);
      setPreview(value);
    }catch(cause){setError((cause as Error).message);}
    finally{setLoading(false);}
  },[kind,queryString]);

  const loadReleases=useCallback(async()=>{
    setLoading(true);setError('');
    try{
      const value=await required<{releases:Release[]}>('/customer-reports/releases');
      setReleases(value.releases??[]);
    }catch(cause){setError((cause as Error).message);}
    finally{setLoading(false);}
  },[]);

  const loadPortal=useCallback(async()=>{
    setLoading(true);setError('');
    try{
      const params=customerId?`?customer_id=${encodeURIComponent(customerId)}`:'';
      const value=await required<{releases:Release[]}>(`/customer-portal/releases${params}`);
      setPortalReleases(value.releases??[]);
    }catch(cause){setError((cause as Error).message);}
    finally{setLoading(false);}
  },[customerId]);

  useEffect(()=>{
    if(!canRead)return;
    required<{kinds:Kind[]}>('/customer-reports/kinds').then(value=>setKinds(value.kinds??[])).catch(()=>{});
    if(canWrite)required<Customer[]>('/customers?pageSize=100').then(value=>setCustomers(previous=>{
      const merged=[...(value??[])];
      for(const customer of previous)if(!merged.some(item=>item.id===customer.id))merged.push(customer);
      return merged;
    })).catch(()=>{});
  },[canRead,canWrite]);

  useEffect(()=>{
    if(customerId){
      required<CustomerProfile>(`/customers/${encodeURIComponent(customerId)}/profile`)
        .then(value=>{
          setCustomerName(value.customer.name);
          setCustomers(previous=>previous.some(customer=>customer.id===customerId)
            ?previous:[...previous,{id:customerId,name:value.customer.name}]);
          setSites(value.sites.map(site=>({id:site.site_id,name:site.site_name})));
        })
        .catch(cause=>setError((cause as Error).message));
    }else{
      setCustomerName('');
      required<Site[]>('/sites').then(value=>setSites(value??[])).catch(cause=>setError((cause as Error).message));
    }
    setSiteId(initialSite??'');
    setPreview(null);
  },[customerId,initialSite]);

  useEffect(()=>{
    if(kinds.length&&!kinds.some(item=>item.slug===kind))setKind(kinds[0].slug);
  },[kinds,kind]);

  useEffect(()=>{if(tab==='releases'&&canRead)void loadReleases();},[tab,canRead,loadReleases]);
  useEffect(()=>{if(tab==='portal'&&canPortal)void loadPortal();},[tab,canPortal,loadPortal]);

  async function createRelease(event:FormEvent){
    event.preventDefault();setError('');setSuccess('');
    if(!customerId){setError('Bitte einen Kunden auswählen.');return;}
    if(!preview){setError('Bitte zuerst eine Vorschau laden.');return;}
    setLoading(true);
    try{
      const created=await required<{id:string;row_count:number}>('/customer-reports/releases',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({title,kind,customer_id:customerId,filters:{
          from:preview.filter.from,to:preview.filter.to,site_id:preview.filter.site_id,
          customer_id:preview.filter.customer_id,sort:preview.filter.sort,order:preview.filter.order,
          page:1,page_size:preview.filter.page_size,
        }}),
      });
      setSuccess(`Entwurf mit ${formatNumber(created.row_count)} Nachweisen angelegt. Eine Freigabe steht noch aus.`);
      setReason('');
      if(canRead)await loadReleases();
      setTab('releases');
    }catch(cause){setError((cause as Error).message);}
    finally{setLoading(false);}
  }

  async function action(id:string,name:'submit'|'approve'|'reject'|'revoke'){
    setError('');setSuccess('');setLoading(true);
    try{
      await api(`/customer-reports/releases/${encodeURIComponent(id)}/${name}`,{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify(name==='reject'||name==='revoke'?{reason}:{}),
      });
      setSuccess(name==='approve'?'Der Kundenbericht ist freigegeben und im Kundenportal sichtbar.'
        :name==='submit'?'Der Bericht wurde zur Freigabe eingereicht.'
        :name==='reject'?'Der Bericht wurde zurückgegeben.':'Die Freigabe wurde widerrufen.');
      setReason('');
      await loadReleases();
      if(detail?.id===id)setDetail(await required<ReleaseDetail>(`/customer-reports/releases/${encodeURIComponent(id)}`));
      if(canPortal)void loadPortal();
    }catch(cause){setError((cause as Error).message);}
    finally{setLoading(false);}
  }

  async function openDetail(id:string){
    setError('');setLoading(true);
    try{setDetail(await required<ReleaseDetail>(`/customer-reports/releases/${encodeURIComponent(id)}`));}
    catch(cause){setError((cause as Error).message);}
    finally{setLoading(false);}
  }
  async function openPortalDetail(id:string){
    setError('');setLoading(true);
    try{setPortalDetail(await required<PortalDetail>(`/customer-portal/releases/${encodeURIComponent(id)}`));}
    catch(cause){setError((cause as Error).message);}
    finally{setLoading(false);}
  }

  if(!canRead&&!canPortal)return <section><h2>Kundenberichte</h2><p>{commonText.noPermission}</p></section>;

  const rowColumns=[
    {key:'occurred_at',label:'Zeitpunkt',render:(row:Row)=>formatDateTime(row.occurred_at)},
    {key:'site_name',label:'Objekt',render:(row:Row)=>row.site_name??commonText.notAvailable},
    {key:'category',label:'Kategorie',render:(row:Row)=>row.category},
    {key:'label',label:'Bezeichnung',render:(row:Row)=>row.label},
    {key:'status',label:'Status',render:(row:Row)=><Badge tone="neutral">{row.status}</Badge>},
    {key:'metric',label:'Kennzahl',render:(row:Row)=>formatNumber(row.metric)},
  ];

  return <section className="customer-report-page">
    <h2>Kundenberichte und Nachweise</h2>
    <p>Echte Nachweise aus den Fachmodulen werden mit gespeicherter Datenbasis geprüft, freigegeben und erst danach im Kundenportal bereitgestellt.</p>
    <nav className="employee-tabs" aria-label="Bereiche der Kundenberichte">
      {canRead&&<button type="button" className={tab==='create'?'active':''} onClick={()=>setTab('create')}>Bericht erstellen</button>}
      {canRead&&<button type="button" className={tab==='releases'?'active':''} onClick={()=>setTab('releases')}>Entwürfe und Freigaben</button>}
      {canPortal&&<button type="button" className={tab==='portal'?'active':''} onClick={()=>setTab('portal')}>Kundenportal</button>}
    </nav>
    {error&&<ErrorState message={error} onRetry={()=>{setError('');if(tab==='releases')void loadReleases();if(tab==='portal')void loadPortal();}}/>}
    {success&&<p className="customer-report-success" role="status">{success}</p>}
    {loading&&<LoadingSkeleton rows={3}/>}

    {tab==='create'&&canRead&&<>
      <Section id="customer-report-filter" title="Bericht vorbereiten" description="Filter, Sortierung und Zeitraum werden serverseitig auf echte Fachdaten angewendet.">
        <form onSubmit={createRelease} className="customer-report-form">
          {canWrite&&<label>Titel
            <input value={title} onChange={event=>setTitle(event.target.value)} minLength={3} maxLength={160} required placeholder="Nachweisbericht November"/>
          </label>}
          <label>Nachweisart
            <select value={kind} onChange={event=>{setKind(event.target.value);setPreview(null);}}>
              {(kinds.length?kinds:[{slug:'control-walks',label:'Kontrollgänge'},{slug:'watchbook',label:'Wachbuch'},
                {slug:'alarms',label:'Alarme'},{slug:'incidents',label:'Einsätze'}]).map(item=>
                <option key={item.slug} value={item.slug}>{item.label}</option>)}
            </select>
          </label>
          <label>Kunde
            <select value={customerId} onChange={event=>setCustomerId(event.target.value)}>
              <option value="">Kundenübergreifend (nur Vorschau)</option>
              {customers.map(customer=><option key={customer.id} value={customer.id}>{customer.name}</option>)}
            </select>
          </label>
          <label>Objekt
            <select value={siteId} onChange={event=>{setSiteId(event.target.value);setPreview(null);}}>
              <option value="">{customerId?'Alle verknüpften Kundenobjekte':'Alle freigegebenen Objekte'}</option>
              {sites.map(site=><option key={site.id} value={site.id}>{site.name}</option>)}
            </select>
          </label>
          <label>Von<input type="date" value={from} max={to||today} onChange={event=>setFrom(event.target.value)}/></label>
          <label>Bis<input type="date" value={to} min={from||undefined} max={today} onChange={event=>setTo(event.target.value)}/></label>
          <label>Suche<input value={q} onChange={event=>setQ(event.target.value)} placeholder="Objekt, Kategorie oder Bezeichnung"/></label>
          <label>Sortierung
            <select value={sort} onChange={event=>setSort(event.target.value)}>
              <option value="occurred_at">Zeitpunkt</option><option value="site_name">Objekt</option>
              <option value="category">Kategorie</option><option value="label">Bezeichnung</option>
              <option value="status">Status</option>
            </select>
          </label>
          <label>Richtung
            <select value={order} onChange={event=>setOrder(event.target.value)}>
              <option value="desc">Absteigend</option><option value="asc">Aufsteigend</option>
            </select>
          </label>
          <button type="button" onClick={()=>void loadPreview()}>Vorschau laden</button>
          {canWrite&&<button type="submit" disabled={loading}>Entwurf anlegen</button>}
        </form>
      </Section>
      {customerName&&<p>Berichtsbereich des Kunden <strong>{customerName}</strong>; die Auswertung berücksichtigt nur verknüpfte Objekte.</p>}
      {preview&&<Section id="customer-report-preview" title="Vorschau" description={`${formatNumber(preview.filter.total)} ${preview.metric_label} im gewählten Zeitraum. Ohne Freigabe keine Kundenweitergabe.`}>
        <ResponsiveTable columns={rowColumns} rows={preview.rows} rowKey={row=>row.id}
          empty="Keine Nachweise im gewählten Zeitraum." caption="Vorschau der Nachweise aus den Fachtabellen"/>
        <Pagination page={preview.filter.page} pages={preview.filter.page_count} total={preview.filter.total}
          onChange={page=>{setPreview({...preview,filter:{...preview.filter,page}});
            const params=new URLSearchParams(queryString());params.set('page',String(page));
            void required<Preview>(`/customer-reports/preview/${kind}?${params.toString()}`)
              .then(setPreview).catch(cause=>setError((cause as Error).message));}}
          label="Nachweise"/>
      </Section>}
      <p className="muted">Datumsangaben werden in Europe/Berlin ausgewertet. DIN 77200 ist ausschließlich ein Dokumentationsprofil, keine Zertifizierungs- oder Rechtsaussage.</p>
    </>}

    {tab==='releases'&&canRead&&<Section id="customer-report-releases" title="Entwürfe und Freigaben"
      description="Freigaben erfolgen durch eine andere Person und nur mit nachvollziehbarer Datenbasis.">
      <ResponsiveTable<Release> columns={[
        {key:'title',label:'Bericht',render:row=><strong>{row.title}</strong>},
        {key:'customer',label:'Kunde',render:row=>row.customer_name??row.customer_id},
        {key:'kind',label:'Nachweisart',render:row=>row.kind_label},
        {key:'status',label:'Status',render:row=><Badge tone={STATUS_TONE[row.status]??'neutral'}>{STATUS_LABEL[row.status]??row.status}</Badge>},
        {key:'period',label:'Zeitraum',render:row=>`${formatDate(row.from)} – ${formatDate(row.to)}`},
        {key:'rows',label:'Nachweise',render:row=>formatNumber(row.row_count)},
        {key:'actions',label:'Aktion',render:row=><button type="button" onClick={()=>void openDetail(row.id)}>Details</button>},
      ]} rows={releases} rowKey={row=>row.id} empty="Noch keine Kundenberichte angelegt."
        caption="Gespeicherte Kundenberichte des Mandanten"/>
    </Section>}

    {tab==='portal'&&canPortal&&<Section id="customer-report-portal" title="Kundenportal"
      description="Schreibgeschützte Ansicht ausschließlich freigegebener eigener Berichte. Exporte sind hier bewusst nicht verfügbar.">
      <ResponsiveTable<Release> columns={[
        {key:'title',label:'Bericht',render:row=><strong>{row.title}</strong>},
        {key:'customer',label:'Kunde',render:row=>row.customer_name??row.customer_id},
        {key:'kind',label:'Nachweisart',render:row=>row.kind_label},
        {key:'period',label:'Zeitraum',render:row=>`${formatDate(row.from)} – ${formatDate(row.to)}`},
        {key:'rows',label:'Nachweise',render:row=>formatNumber(row.row_count)},
        {key:'actions',label:'Aktion',render:row=><button type="button" onClick={()=>void openPortalDetail(row.id)}>Öffnen</button>},
      ]} rows={portalReleases} rowKey={row=>row.id}
        empty="Für diesen Kunden liegen keine freigegebenen Berichte vor."
        caption="Freigegebene Kundenberichte"/>
      <p className="muted">Interne Notizen, Bewertungen und Personaldaten werden im Kundenportal nicht angezeigt.</p>
    </Section>}

    {detail&&<Modal title={detail.title} subtitle={`${detail.kind_label} · ${STATUS_LABEL[detail.status]??detail.status}`}
      onClose={()=>setDetail(null)} wide>
      <dl className="ops-meta-list">
        <div className="ops-meta"><dt>Kunde</dt><dd>{detail.customer_name??detail.customer_id}</dd></div>
        <div className="ops-meta"><dt>Zeitraum</dt><dd>{formatDate(detail.from)} – {formatDate(detail.to)}</dd></div>
        <div className="ops-meta"><dt>Nachweise</dt><dd>{formatNumber(detail.row_count)}</dd></div>
        <div className="ops-meta"><dt>Datenbasis</dt><dd>{detail.data_basis_current?'Aktuell':'Seit dem Entwurf verändert'}</dd></div>
        <div className="ops-meta"><dt>Fingerprint</dt><dd><code>{detail.fingerprint.slice(0,16)}…</code></dd></div>
        {detail.rejected_reason&&<div className="ops-meta"><dt>Grund der Rückgabe</dt><dd>{detail.rejected_reason}</dd></div>}
        {detail.revoked_reason&&<div className="ops-meta"><dt>Grund des Widerrufs</dt><dd>{detail.revoked_reason}</dd></div>}
      </dl>
      <ResponsiveTable columns={rowColumns} rows={detail.rows} rowKey={row=>row.id}
        empty="Keine Nachweise in freigegebener Datenbasis." caption="Freigegebene Nachweise"/>
      {(canApprove||canWrite)&&<label>Begründung für Rückgabe oder Widerruf
        <textarea value={reason} onChange={event=>setReason(event.target.value)} maxLength={500} rows={2}/>
      </label>}
      <div className="ops-section-actions">
        {canWrite&&(detail.status==='draft'||detail.status==='rejected')&&<button type="button" disabled={loading||!detail.data_basis_current} onClick={()=>void action(detail.id,'submit')}>Zur Freigabe einreichen</button>}
        {canApprove&&detail.status==='in_review'&&<button type="button" disabled={loading} onClick={()=>void action(detail.id,'approve')}>Freigeben</button>}
        {canApprove&&detail.status==='in_review'&&<button type="button" className="ops-secondary" disabled={loading||reason.trim().length<3} onClick={()=>void action(detail.id,'reject')}>Zurückgeben</button>}
        {canApprove&&detail.status==='approved'&&<button type="button" className="ops-secondary" disabled={loading||reason.trim().length<3} onClick={()=>void action(detail.id,'revoke')}>Freigabe widerrufen</button>}
        {canExport&&detail.status==='approved'&&(['csv','pdf','xlsx'] as const).map(format=>
          <button key={format} type="button" className="ops-secondary"
            onClick={()=>window.open(exportUrl(detail.id,format),'_blank','noopener,noreferrer')}>
            {format.toUpperCase()} exportieren
          </button>)}
      </div>
    </Modal>}

    {portalDetail&&<Modal title={portalDetail.title} subtitle={`${portalDetail.kind_label} · freigegeben am ${formatDate(portalDetail.approved_at)}`}
      onClose={()=>setPortalDetail(null)} wide>
      <p className="muted">Schreibgeschützt. Exportfunktionen sind im Kundenportal nicht enthalten.</p>
      <dl className="ops-meta-list">
        <div className="ops-meta"><dt>Zeitraum</dt><dd>{formatDate(portalDetail.from)} – {formatDate(portalDetail.to)}</dd></div>
        <div className="ops-meta"><dt>Nachweise</dt><dd>{formatNumber(portalDetail.row_count)}</dd></div>
      </dl>
      <ResponsiveTable columns={rowColumns} rows={portalDetail.rows} rowKey={row=>row.id}
        empty="Keine Nachweise im freigegebenen Zeitraum." caption="Freigegebene Nachweise"/>
    </Modal>}
    {!detail&&!portalDetail&&loading&&<p>{commonText.loading}</p>}
    {!releases.length&&tab==='releases'&&!loading&&<EmptyState>Noch keine Kundenberichte angelegt.</EmptyState>}
    {!portalReleases.length&&tab==='portal'&&!loading&&<EmptyState>Keine freigegebenen Berichte vorhanden.</EmptyState>}
  </section>;
}
