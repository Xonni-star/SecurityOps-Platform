import {FormEvent,useEffect,useState} from 'react';
import {api,hasPermission} from '../lib/api';
import {useSearchParams} from 'react-router-dom';
import {berlinDateToIso} from '../lib/format';
import {commonText} from '../lib/text';

type Site={id:string;name:string};
type CustomerProfile={customer:{name:string};sites:{site_id:string;site_name:string}[]};

export function CustomerReports(){
  const [searchParams]=useSearchParams();
  const customerId=searchParams.get('customer_id');
  const [sites,setSites]=useState<Site[]>([]);
  const [customerName,setCustomerName]=useState('');
  const [kind,setKind]=useState('control-walks');
  const [siteId,setSiteId]=useState(searchParams.get('site_id')??'');
  const [from,setFrom]=useState('');
  const [to,setTo]=useState('');
  const [error,setError]=useState('');

  useEffect(()=>{
    if(customerId){
      api<CustomerProfile>(`/customers/${customerId}/profile`)
        .then(value=>{
          if(!value)throw new Error('Die Kundenberichte konnten nicht geladen werden.');
          setCustomerName(value.customer.name);
          setSites(value.sites.map(site=>({id:site.site_id,name:site.site_name})));
        })
        .catch(cause=>setError((cause as Error).message));
    }else{
      api<Site[]>('/sites').then(value=>setSites(value||[])).catch(cause=>setError((cause as Error).message));
    }
  },[customerId]);

  function open(format:'csv'|'pdf',portal=false){
    const params=new URLSearchParams({format});
    if(siteId)params.set('site_id',siteId);
    if(customerId)params.set('customer_id',customerId);
    if(from)params.set('from',berlinDateToIso(from));
    if(to)params.set('to',berlinDateToIso(to,true));
    window.open(`/api/v1/${portal?'customer-portal':'customer-reports'}/${kind}?${params.toString()}`,'_blank','noopener,noreferrer');
  }

  function submit(event:FormEvent){
    event.preventDefault();
    open('csv');
  }

  if(!hasPermission('customer_reports:export')&&!hasPermission('customer_portal:read')){
    return <section><h2>Kundenberichte</h2><p>{commonText.noPermission}</p></section>;
  }

  return <section>
    <h2>Kundenberichte und Nachweise</h2>
    <p>Stellen Sie Berichte für Kunden zusammen und geben Sie diese kontrolliert frei.</p>
    {customerName&&<p>Berichtsbereich des Kunden <strong>{customerName}</strong>; Auswertungen berücksichtigen nur verknüpfte Objekte.</p>}
    {error&&<p role="alert">{error}</p>}
    <form onSubmit={submit}>
      <label>Berichtstyp
        <select value={kind} onChange={event=>setKind(event.target.value)}>
          <option value="control-walks">Kontrollgänge</option>
          <option value="watchbook">Wachbuch</option>
          <option value="alarms">Alarme</option>
          <option value="incidents">Einsätze</option>
        </select>
      </label>
      <label>Von
        <input type="date" value={from} onChange={event=>setFrom(event.target.value)}/>
      </label>
      <label>Bis
        <input type="date" value={to} onChange={event=>setTo(event.target.value)}/>
      </label>
      <label>Objekt
        <select value={siteId} onChange={event=>setSiteId(event.target.value)}>
          <option value="">{customerId?'Alle verknüpften Kundenobjekte':'Alle freigegebenen Objekte'}</option>
          {sites.map(site=><option key={site.id} value={site.id}>{site.name}</option>)}
        </select>
      </label>
      <button type="submit">Bericht als CSV exportieren</button>
    </form>
    {hasPermission('customer_reports:export')&&<p>
      <button onClick={()=>open('csv')}>{commonText.exportCsv}</button>
      <button onClick={()=>open('pdf')}>{commonText.exportPdf}</button>
    </p>}
    {hasPermission('customer_portal:read')&&<p>
      <button onClick={()=>open('csv',true)}>Schreibgeschützte Portalansicht öffnen</button>
    </p>}
    <p className="muted">Datumsangaben werden in der Zeitzone Europe/Berlin ausgewertet. DIN 77200 wird ausschließlich als Dokumentationsprofil ausgewiesen.</p>
  </section>;
}
