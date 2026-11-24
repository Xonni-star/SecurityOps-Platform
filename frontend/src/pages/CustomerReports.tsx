import {FormEvent,useEffect,useState} from 'react';
import {api,hasPermission} from '../lib/api';
import {useSearchParams} from 'react-router-dom';
type Site={id:string;name:string};
export function CustomerReports(){
  const [searchParams]=useSearchParams();const customerId=searchParams.get('customer_id');
  const [sites,setSites]=useState<Site[]>([]);const [customerName,setCustomerName]=useState('');const [kind,setKind]=useState('control-walks');const [siteId,setSiteId]=useState('');const [from,setFrom]=useState('');const [to,setTo]=useState('');const [error,setError]=useState('');
  useEffect(()=>{
    if(customerId){
      api<{customer:{name:string};sites:{site_id:string;site_name:string}[]}>(`/customers/${customerId}/profile`)
        .then(value=>{if(!value)throw new Error('Kundenberichte konnten nicht geladen werden.');setCustomerName(value.customer.name);setSites(value.sites.map(site=>({id:site.site_id,name:site.site_name})));})
        .catch(e=>setError(e.message));
    }else api<Site[]>('/sites').then(value=>setSites(value||[])).catch(e=>setError(e.message));
  },[customerId]);
  function open(format:'csv'|'pdf',portal=false){const params=new URLSearchParams({format});if(siteId)params.set('site_id',siteId);if(customerId)params.set('customer_id',customerId);if(from)params.set('from',new Date(`${from}T00:00:00`).toISOString());if(to)params.set('to',new Date(`${to}T23:59:59`).toISOString());window.open(`/api/v1/${portal?'customer-portal':'customer-reports'}/${kind}?${params.toString()}`,'_blank','noopener,noreferrer');}
  function submit(event:FormEvent){event.preventDefault();open('csv');}
  if(!hasPermission('customer_reports:export')&&!hasPermission('customer_portal:read'))return <section><h1>Kundenberichte</h1><p>Keine Berechtigung.</p></section>;
  return <section><h1>Kundenberichte & Nachweise</h1>{customerName&&<p>Berichtsbereich des Kunden <strong>{customerName}</strong>; Auswertungen berücksichtigen nur verknüpfte Objekte.</p>}{error&&<p role="alert">{error}</p>}<form onSubmit={submit}><label>Berichtstyp<select value={kind} onChange={e=>setKind(e.target.value)}><option value="control-walks">Kontrollgänge</option><option value="watchbook">Wachbuch</option><option value="alarms">Alarme</option><option value="incidents">Einsätze</option></select></label><label>Von<input type="date" value={from} onChange={e=>setFrom(e.target.value)}/></label><label>Bis<input type="date" value={to} onChange={e=>setTo(e.target.value)}/></label><label>Objekt<select value={siteId} onChange={e=>setSiteId(e.target.value)}><option value="">{customerId?'Alle verknüpften Kundenobjekte':'Alle freigegebenen Objekte'}</option>{sites.map(site=><option key={site.id} value={site.id}>{site.name}</option>)}</select></label><button type="submit">Filter anwenden</button></form>{hasPermission('customer_reports:export')&&<p><button onClick={()=>open('csv')}>CSV exportieren</button> <button onClick={()=>open('pdf')}>PDF exportieren</button></p>}{hasPermission('customer_portal:read')&&<p><button onClick={()=>open('csv',true)}>Read-only-Portalansicht öffnen</button></p>}<p>Zeitzone: lokale Browser-Zeitzone. DIN-77200 wird ausschließlich als Dokumentationsprofil ausgewiesen.</p></section>;
}
