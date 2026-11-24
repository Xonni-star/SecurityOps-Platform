import {FormEvent,useEffect,useMemo,useState} from 'react';
import {useNavigate} from 'react-router-dom';
import {api,hasPermission} from '../lib/api';

type Customer={
  id:string;name:string;email:string|null;customer_number:string|null;legal_form:string|null;industry:string|null;
  customer_status:string;priority:string;risk_classification:string;city:string|null;postal_code:string|null;phone:string|null;
  active_sites:number;active_contracts:number;active_contacts:number;expiring_contracts:number;account_manager_name:string|null;
};
type Dashboard={total:number;active:number;pipeline:number;at_risk:number;archived:number;active_object_links:number;contracts:{total:number;active:number};contracts_expiring_90_days:number};
const emptyForm={name:'',email:'',customer_number:'',legal_form:'',industry:'',phone:'',city:'',postal_code:'',address_line1:'',country_code:'DE',customer_status:'active',priority:'normal',risk_classification:'unknown'};

export function Customers(){
  const navigate=useNavigate();
  const [customers,setCustomers]=useState<Customer[]>([]);
  const [dashboard,setDashboard]=useState<Dashboard|null>(null);
  const [search,setSearch]=useState('');
  const [status,setStatus]=useState('all');
  const [sortKey,setSortKey]=useState<keyof Customer>('name');
  const [direction,setDirection]=useState<'asc'|'desc'>('asc');
  const [page,setPage]=useState(1);
  const [selected,setSelected]=useState<string[]>([]);
  const [createOpen,setCreateOpen]=useState(false);
  const [form,setForm]=useState(emptyForm);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const pageSize=10;

  const load=async()=>{
    setLoading(true);
    try{
      const [rows,metrics]=await Promise.all([api<Customer[]>('/customers'),api<Dashboard>('/customers/dashboard')]);
      setCustomers(rows??[]);setDashboard(metrics??null);setError('');
    }catch(e){setError((e as Error).message);}
    finally{setLoading(false);}
  };
  useEffect(()=>{void load();},[]);

  const filtered=useMemo(()=>customers.filter(customer=>{
    const text=`${customer.name} ${customer.customer_number??''} ${customer.email??''} ${customer.city??''} ${customer.industry??''} ${customer.account_manager_name??''}`.toLowerCase();
    return (!search||text.includes(search.toLowerCase()))&&(status==='all'||customer.customer_status===status);
  }),[customers,search,status]);
  const sorted=useMemo(()=>[...filtered].sort((a,b)=>{
    const left=String(a[sortKey]??'').toLocaleLowerCase('de');
    const right=String(b[sortKey]??'').toLocaleLowerCase('de');
    return direction==='asc'?left.localeCompare(right,'de'):right.localeCompare(left,'de');
  }),[filtered,sortKey,direction]);
  const pageCount=Math.max(1,Math.ceil(sorted.length/pageSize));
  const currentPage=Math.min(page,pageCount);
  const visible=sorted.slice((currentPage-1)*pageSize,currentPage*pageSize);
  const toggleSort=(key:typeof sortKey)=>{if(key===sortKey)setDirection(value=>value==='asc'?'desc':'asc');else{setSortKey(key);setDirection('asc');}setPage(1);};
  const toggleSelected=(id:string)=>setSelected(rows=>rows.includes(id)?rows.filter(row=>row!==id):[...rows,id]);
  const exportRows=selected.length?customers.filter(row=>selected.includes(row.id)):sorted;
  const exportCsv=()=>{
    const columns:[string,(customer:Customer)=>unknown][]=[
      ['Kundennummer',row=>row.customer_number],['Kunde',row=>row.name],['Status',row=>row.customer_status],
      ['Branche',row=>row.industry],['E-Mail',row=>row.email],['Telefon',row=>row.phone],
      ['PLZ',row=>row.postal_code],['Ort',row=>row.city],['Objekte',row=>row.active_sites],
      ['Verträge',row=>row.active_contracts],['Ansprechpartner',row=>row.active_contacts],
    ];
    const quote=(value:unknown)=>`"${String(value??'').split('"').join('""')}"`;
    const csv=[columns.map(([label])=>quote(label)).join(';'),...exportRows.map(row=>columns.map(([,get])=>quote(get(row))).join(';'))].join('\r\n');
    const blob=new Blob(['\ufeff',csv],{type:'text/csv;charset=utf-8'});
    const url=URL.createObjectURL(blob),link=document.createElement('a');
    link.href=url;link.download='kunden.csv';link.click();URL.revokeObjectURL(url);
  };
  const create=async(event:FormEvent)=>{
    event.preventDefault();
    try{
      const body={...form,email:form.email||null,customer_number:form.customer_number||null,legal_form:form.legal_form||null,industry:form.industry||null,phone:form.phone||null,city:form.city||null,postal_code:form.postal_code||null,address_line1:form.address_line1||null};
      const customer=await api<Customer>('/customers',{method:'POST',body:JSON.stringify(body)});
      if(!customer)throw new Error('Kunde wurde angelegt, aber es wurde kein Datensatz zurückgegeben.');
      setForm(emptyForm);setCreateOpen(false);await load();navigate(`/customers/${customer.id}`);
    }catch(e){setError((e as Error).message);}
  };
  const archiveSelected=async()=>{
    if(!selected.length||!window.confirm(`Möchten Sie ${selected.length} ausgewählte Kunden archivieren?`))return;
    try{for(const id of selected)await api(`/customers/${id}`,{method:'PATCH',body:JSON.stringify({customer_status:'archived'})});setSelected([]);await load();}
    catch(e){setError((e as Error).message);await load();}
  };

  return <section className="employee-management customer-management">
    <div className="employee-page-title">
      <div><h1>Kundenverwaltung</h1><p>Kundenstammdaten, Ansprechpartner, Verträge und Objektbeziehungen</p></div>
      <div className="employee-page-actions">
        {selected.length>0&&hasPermission('customers:write')&&<button type="button" onClick={()=>void archiveSelected()}>Auswahl archivieren ({selected.length})</button>}
        {hasPermission('customers:export')&&<button type="button" onClick={exportCsv}>Export{selected.length?` (${selected.length})`:''}</button>}
        {hasPermission('customers:write')&&<button type="button" onClick={()=>setCreateOpen(value=>!value)}>+ Kunde anlegen</button>}
      </div>
    </div>
    {error&&<p role="alert" className="error">{error}</p>}
    {dashboard&&<div className="stats-grid employee-metrics">
      <article><strong>{dashboard.total}</strong><span>Kunden gesamt</span></article>
      <article><strong>{dashboard.active}</strong><span>Aktiv</span></article>
      <article><strong>{dashboard.pipeline}</strong><span>Interessenten / Angebot</span></article>
      <article><strong>{dashboard.at_risk}</strong><span>Mit Risiko</span></article>
      <article><strong>{dashboard.active_object_links}</strong><span>Aktive Objektbeziehungen</span></article>
      <article><strong>{dashboard.contracts_expiring_90_days}</strong><span>Verträge laufen aus</span></article>
    </div>}
    {createOpen&&hasPermission('customers:write')&&<form onSubmit={create} className="employee-create open customer-create">
      <label>Unternehmen<input required maxLength={240} value={form.name} onChange={event=>setForm({...form,name:event.target.value})}/></label>
      <label>Kundennummer<input maxLength={80} value={form.customer_number} onChange={event=>setForm({...form,customer_number:event.target.value})}/></label>
      <label>E-Mail<input type="email" value={form.email} onChange={event=>setForm({...form,email:event.target.value})}/></label>
      <label>Telefon<input value={form.phone} onChange={event=>setForm({...form,phone:event.target.value})}/></label>
      <label>Rechtsform<input value={form.legal_form} onChange={event=>setForm({...form,legal_form:event.target.value})}/></label>
      <label>Branche<input value={form.industry} onChange={event=>setForm({...form,industry:event.target.value})}/></label>
      <label>Straße<input value={form.address_line1} onChange={event=>setForm({...form,address_line1:event.target.value})}/></label>
      <label>PLZ<input value={form.postal_code} onChange={event=>setForm({...form,postal_code:event.target.value})}/></label>
      <label>Ort<input value={form.city} onChange={event=>setForm({...form,city:event.target.value})}/></label>
      <label>Status<select value={form.customer_status} onChange={event=>setForm({...form,customer_status:event.target.value})}><option value="prospect">Interessent</option><option value="negotiating">In Verhandlung</option><option value="active">Aktiv</option><option value="paused">Pausiert</option><option value="at_risk">Gefährdet</option></select></label>
      <button type="submit">Kunde anlegen</button>
    </form>}
    <div className="employee-overview">
      <div className="employee-filterbar customer-filterbar">
        <input className="employee-search" placeholder="Kunde, Nummer, Ort, Branche oder E-Mail suchen" value={search} onChange={event=>{setSearch(event.target.value);setPage(1);}}/>
        <select aria-label="Kundenstatus" value={status} onChange={event=>{setStatus(event.target.value);setPage(1);}}>
          <option value="all">Alle Status</option><option value="prospect">Interessent</option><option value="negotiating">In Verhandlung</option><option value="active">Aktiv</option><option value="paused">Pausiert</option><option value="at_risk">Gefährdet</option><option value="terminated">Beendet</option><option value="archived">Archiviert</option>
        </select>
        <button type="button" onClick={()=>{setSearch('');setStatus('all');setPage(1);}}>Filter zurücksetzen</button>
      </div>
      <div className="employee-table employee-overview-table">
        <table><thead><tr>
          <th><input type="checkbox" aria-label="Alle Kunden dieser Seite auswählen" checked={visible.length>0&&visible.every(row=>selected.includes(row.id))} onChange={event=>setSelected(rows=>event.target.checked?Array.from(new Set([...rows,...visible.map(row=>row.id)])):rows.filter(id=>!visible.some(row=>row.id===id)))}/></th>
          <th><button type="button" onClick={()=>toggleSort('name')}>Kunde</button></th>
          <th><button type="button" onClick={()=>toggleSort('customer_number')}>Kundennummer</button></th>
          <th><button type="button" onClick={()=>toggleSort('customer_status')}>Status</button></th>
          <th><button type="button" onClick={()=>toggleSort('city')}>Standort</button></th>
          <th><button type="button" onClick={()=>toggleSort('active_sites')}>Objekte</button></th>
          <th><button type="button" onClick={()=>toggleSort('active_contracts')}>Aktive Verträge</button></th>
          <th><button type="button" onClick={()=>toggleSort('account_manager_name')}>Betreuung</button></th>
          <th>Aktion</th>
        </tr></thead><tbody>
          {visible.map(customer=><tr key={customer.id} className={selected.includes(customer.id)?'selected-row':''}>
            <td><input type="checkbox" aria-label={`${customer.name} auswählen`} checked={selected.includes(customer.id)} onChange={()=>toggleSelected(customer.id)}/></td>
            <td><button type="button" className="employee-name-link" onClick={()=>navigate(`/customers/${customer.id}`)}><strong>{customer.name}</strong><small>{customer.email||customer.industry||'Keine Kontaktangabe'}</small></button></td>
            <td>{customer.customer_number||'–'}</td>
            <td><span className={`employee-status ${customer.customer_status}`}>{({prospect:'Interessent',negotiating:'Verhandlung',active:'Aktiv',paused:'Pausiert',at_risk:'Gefährdet',terminated:'Beendet',archived:'Archiviert'} as Record<string,string>)[customer.customer_status]||customer.customer_status}</span></td>
            <td>{[customer.postal_code,customer.city].filter(Boolean).join(' ')||'–'}</td>
            <td>{customer.active_sites}</td><td>{customer.active_contracts}{customer.expiring_contracts>0&&<small className="customer-expiring"> · {customer.expiring_contracts} Frist</small>}</td>
            <td>{customer.account_manager_name||'–'}</td>
            <td><button type="button" onClick={()=>navigate(`/customers/${customer.id}`)}>Öffnen</button></td>
          </tr>)}
        </tbody></table>
        {loading&&<p className="employee-empty">Kunden werden geladen …</p>}
        {!loading&&filtered.length===0&&<p className="employee-empty">Keine Kunden entsprechen den aktiven Filtern.</p>}
        {filtered.length>0&&<div className="employee-pagination"><span>{filtered.length} Kunden · Seite {currentPage} von {pageCount}</span><button type="button" disabled={currentPage===1} onClick={()=>setPage(value=>Math.max(1,value-1))}>Zurück</button><button type="button" disabled={currentPage===pageCount} onClick={()=>setPage(value=>Math.min(pageCount,value+1))}>Weiter</button></div>}
      </div>
    </div>
  </section>;
}
