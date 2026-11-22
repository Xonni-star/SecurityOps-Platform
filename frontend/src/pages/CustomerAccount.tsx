import {useEffect,useState} from 'react';
import {useParams} from 'react-router-dom';
import {api} from '../lib/api';

type Account={
  customer:Record<string,string|null>;
  contacts:Array<Record<string,string|null|boolean>>;
  sites:Array<Record<string,string|null|boolean>>;
  contracts:Array<Record<string,string|null|number>>;
  services:Array<Record<string,string|null|number>>;
  timeline:Array<Record<string,unknown>>;
};

export function CustomerAccount(){
  const {id}=useParams();
  const [account,setAccount]=useState<Account|null>(null);
  const [error,setError]=useState('');
  useEffect(()=>{
    if(!id)return;
    void api<Account>(`/customers/${id}/360`).then(data=>{if(data)setAccount(data);}).catch(e=>setError((e as Error).message));
  },[id]);
  if(error)return <section><p role="alert">{error}</p></section>;
  if(!account)return <section><p>Lade Kundenakte …</p></section>;
  const c=account.customer;
  return <section>
    <h2>{c.name||'Kundenakte'}</h2>
    <p>{c.customer_number||'Keine Kundennummer'} · Status: {c.customer_status||'unbekannt'} · Priorität: {c.priority||'normal'}</p>
    <div className="dashboard-grid">
      <article><h3>Stammdaten</h3><p>{c.legal_form||'Rechtsform offen'} · {c.industry||'Branche offen'}</p><p>Accountmanager: {c.account_manager_name||'Nicht zugeordnet'}</p><p>{c.internal_notes||'Keine internen Notizen'}</p></article>
      <article><h3>Übersicht</h3><p>{account.contacts.length} Kontakte · {account.sites.length} Objekte · {account.contracts.length} Verträge · {account.services.length} Leistungen</p><p>Risikoklassifizierung: {c.risk_classification||'unbekannt'}</p></article>
    </div>
    <h2>Kontakte</h2>
    {account.contacts.length?<ul>{account.contacts.map(contact=><li key={String(contact.id)}><strong>{[contact.first_name,contact.last_name].filter(Boolean).join(' ')||'Kontakt'}</strong> · {contact.job_title||'Funktion offen'} · {contact.email||contact.phone||contact.mobile_phone||'Keine Kontaktdaten'}{contact.is_primary?' · Hauptansprechpartner':''}</li>)}</ul>:<p>Keine aktiven Kontakte hinterlegt.</p>}
    <h2>Objekte</h2>
    {account.sites.length?<ul>{account.sites.map(site=><li key={String(site.id)}><strong>{site.name}</strong> · {site.address||'Keine Adresse'} · {site.status||'unbekannt'} · Sicherheitsklasse {site.security_classification||'unbekannt'}</li>)}</ul>:<p>Keine aktiven Objekte verknüpft.</p>}
    <h2>Verträge und Leistungen</h2>
    {account.contracts.length?<ul>{account.contracts.map(contract=><li key={String(contract.id)}><strong>{contract.contract_number}</strong> · {contract.contract_type} · {contract.status} · Monatswert {contract.monthly_value??'—'}</li>)}</ul>:<p>Keine aktiven Verträge hinterlegt.</p>}
    {account.services.length?<ul>{account.services.map(service=><li key={`${service.contract_id}-${service.service_id}`}>{service.name} · Menge {service.quantity} · Preis {service.unit_price??'—'}</li>)}</ul>:<p>Keine Leistungen in aktiven Verträgen.</p>}
    <h2>Historie</h2>
    {account.timeline.length?<ul>{account.timeline.map(event=><li key={String(event.id)}>{new Date(String(event.created_at)).toLocaleString('de-DE')} · {String(event.event_type)} · {String(event.actor_email||'System')}</li>)}</ul>:<p>Noch keine kundenbezogenen Aktivitäten protokolliert.</p>}
  </section>;
}
