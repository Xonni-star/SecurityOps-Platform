import {FormEvent,useEffect,useState} from 'react';
import {Link,useNavigate} from 'react-router-dom';
import {api,hasPermission} from '../lib/api';

type Reminder={id:string;code:string;label:string;severity:'critical'|'warning';customer_id:string;customer_name:string;contract_id:string;contract_number:string;due_date:string|null;url:string};
type Dashboard={total:number;active:number;pipeline:number;at_risk:number;archived:number;paused:number;new_30d:number;incomplete_master_data:number;linked_customers:number;active_object_links:number;contracts:{total:number;active:number};contracts_expiring_90_days:number;open_tasks:number;overdue_tasks:number;reminders:Reminder[]};
type ActionEntry={id:string;bucket:'A'|'B'|'C';code:string;label:string;customer_id:string;customer_name:string;subject_type:string;subject_id:string|null;due_at:string|null};
type ActionList={A:ActionEntry[];B:ActionEntry[];C:ActionEntry[];generated_at:string};
type Customer={
  id:string;name:string;email:string|null;customer_number:string|null;legal_form:string|null;industry:string|null;
  customer_status:string;priority:string;risk_classification:string;city:string|null;postal_code:string|null;phone:string|null;
  active_sites:number;active_contracts:number;active_contacts:number;expiring_contracts:number;account_manager_name:string|null;
  account_manager_employee_id:string|null;next_contract_deadline:string|null;last_activity:string|null;open_tasks:number;overdue_tasks:number;
};
type Employee={id:string;name:string};
type SortKey='name'|'customer_number'|'customer_status'|'risk_classification'|'priority'|'city'|'active_sites'|'active_contracts'|'account_manager_name'|'next_contract_deadline'|'last_activity'|'open_tasks';
const apiBase='/api/v1';
const pageSize=10;
const emptyForm={name:'',email:'',customer_number:'',legal_form:'',industry:'',phone:'',city:'',postal_code:'',address_line1:'',country_code:'DE',customer_status:'active',priority:'normal',risk_classification:'unknown'};
const statusLabels:Record<string,string>={prospect:'Interessent',negotiating:'Verhandlung',active:'Aktiv',paused:'Pausiert',at_risk:'Gefährdet',terminated:'Beendet',archived:'Archiviert'};
const priorityLabels:Record<string,string>={low:'Niedrig',normal:'Normal',high:'Hoch',critical:'Kritisch'};
const riskLabels:Record<string,string>={unknown:'Nicht bewertet',low:'Niedrig',medium:'Mittel',high:'Hoch',critical:'Kritisch'};
const bucketLabels:Record<'A'|'B'|'C',string>={A:'Sofort handeln',B:'Zeitnah klären',C:'Beobachten'};
const actionSections:Record<string,string>={customer:'uebersicht',contacts:'ansprechpartner',contract:'vertraege',task:'aufgaben',site:'objekte',stammdaten:'stammdaten',verlauf:'verlauf'};
const displayDate=(value:string|null)=>value?new Date(value.length<=10?`${value}T00:00:00`:value).toLocaleDateString('de-DE'):'–';

function actionTarget(entry:ActionEntry){
  const section=actionSections[entry.subject_type]??'uebersicht';
  const query=entry.subject_id&&(entry.subject_type==='contract'||entry.subject_type==='site')?`?${entry.subject_type==='contract'?'contract':'site'}=${encodeURIComponent(entry.subject_id)}`:'';
  return `/customers/${entry.customer_id}/${section}${query}`;
}

async function fetchCustomerPage(query:string){
  const response=await fetch(`${apiBase}/customers?${query}`,{credentials:'include',headers:{'Content-Type':'application/json'}});
  if(!response.ok){
    let message='Kunden konnten nicht geladen werden.';
    try{const body=await response.json() as {error?:string};if(body?.error)message=body.error;}catch{/* response has no JSON body */}
    throw new Error(message);
  }
  const rows=await response.json() as Customer[];
  const headerTotal=Number(response.headers.get('X-Total-Count'));
  const headerPages=Number(response.headers.get('X-Page-Count'));
  const total=Number.isFinite(headerTotal)?headerTotal:(Array.isArray(rows)?rows.length:0);
  const pageCount=Number.isFinite(headerPages)&&headerPages>0?headerPages:Math.max(1,Math.ceil(total/pageSize));
  return {rows:Array.isArray(rows)?rows:[],total,pageCount};
}

export function Customers(){
  const navigate=useNavigate();
  const [customers,setCustomers]=useState<Customer[]>([]);
  const [total,setTotal]=useState(0);
  const [pageCount,setPageCount]=useState(1);
  const [dashboard,setDashboard]=useState<Dashboard|null>(null);
  const [actions,setActions]=useState<ActionList>({A:[],B:[],C:[],generated_at:''});
  const [managers,setManagers]=useState<Employee[]>([]);
  const [search,setSearch]=useState('');
  const [status,setStatus]=useState('all');
  const [risk,setRisk]=useState('all');
  const [priority,setPriority]=useState('all');
  const [manager,setManager]=useState('all');
  const [contractStatus,setContractStatus]=useState('all');
  const [active,setActive]=useState('all');
  const [sortKey,setSortKey]=useState<SortKey>('name');
  const [direction,setDirection]=useState<'asc'|'desc'>('asc');
  const [page,setPage]=useState(1);
  const [reloadToken,setReloadToken]=useState(0);
  const [selected,setSelected]=useState<string[]>([]);
  const [createOpen,setCreateOpen]=useState(false);
  const [form,setForm]=useState(emptyForm);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');

  const query=new URLSearchParams();
  if(search.trim())query.set('q',search.trim());
  if(status!=='all')query.set('customer_status',status);
  if(risk!=='all')query.set('risk_classification',risk);
  if(priority!=='all')query.set('priority',priority);
  if(manager!=='all')query.set('account_manager_employee_id',manager);
  if(contractStatus!=='all')query.set('contract_status',contractStatus);
  if(active!=='all')query.set('active',active);
  query.set('sort',sortKey);query.set('dir',direction);query.set('page',String(page));query.set('pageSize',String(pageSize));
  const queryString=query.toString();

  useEffect(()=>{
    let cancelled=false;
    setLoading(true);
    void fetchCustomerPage(queryString).then(result=>{
      if(cancelled)return;
      setCustomers(result.rows);setTotal(result.total);setPageCount(result.pageCount);setError('');
    }).catch(cause=>{if(!cancelled)setError((cause as Error).message);})
      .finally(()=>{if(!cancelled)setLoading(false);});
    return ()=>{cancelled=true;};
  },[queryString,reloadToken]);

  useEffect(()=>{
    let cancelled=false;
    const loadExtras=async()=>{
      const [metrics,list,employeeRows]=await Promise.all([
        api<Dashboard>('/customers/dashboard').catch(()=>null),
        api<ActionList>('/customers/action-list').catch(()=>({A:[],B:[],C:[],generated_at:''})),
        hasPermission('employees:read')?api<Employee[]>('/employees').catch(()=>[]):Promise.resolve([]),
      ]);
      if(cancelled)return;
      setDashboard(metrics&&typeof metrics.total==='number'?metrics:null);
      setActions({A:list?.A??[],B:list?.B??[],C:list?.C??[],generated_at:list?.generated_at??''});
      setManagers(Array.isArray(employeeRows)?employeeRows:[]);
    };
    void loadExtras();
    return ()=>{cancelled=true;};
  },[]);

  const resetFilters=()=>{
    setSearch('');setStatus('all');setRisk('all');setPriority('all');setManager('all');setContractStatus('all');setActive('all');setSortKey('name');setDirection('asc');setPage(1);
  };
  const toggleSort=(key:SortKey)=>{if(key===sortKey)setDirection(value=>value==='asc'?'desc':'asc');else{setSortKey(key);setDirection('asc');}setPage(1);};
  const toggleSelected=(id:string)=>setSelected(rows=>rows.includes(id)?rows.filter(row=>row!==id):[...rows,id]);
  const canWrite=hasPermission('customers:write');
  const canExport=hasPermission('customers:export');

  const applyBulk=async(action:'archive'|'set_status'|'set_manager',value?:string)=>{
    if(!selected.length)return;
    if(action==='archive'&&!window.confirm(`Möchten Sie ${selected.length} ausgewählte Kunden archivieren?`))return;
    try{
      await api('/customers/bulk',{method:'POST',body:JSON.stringify({ids:selected,action,...(value?{value}:{})})});
      setSelected([]);setError('');setReloadToken(token=>token+1);
    }catch(cause){setError((cause as Error).message);}
  };
  const exportCsv=async()=>{
    try{
      const exportQuery=new URLSearchParams(queryString);
      if(selected.length)exportQuery.set('ids',selected.join(','));
      const response=await fetch(`${apiBase}/customers/export?${exportQuery.toString()}`,{credentials:'include',headers:{'Content-Type':'application/json'}});
      if(!response.ok)throw new Error('Kundenexport fehlgeschlagen.');
      const blob=await response.blob();
      const disposition=response.headers.get('Content-Disposition')??'';
      const filename=/filename="?([^";]+)"?/i.exec(disposition)?.[1]??'kunden.csv';
      const url=URL.createObjectURL(blob),link=document.createElement('a');
      link.href=url;link.download=filename;link.click();URL.revokeObjectURL(url);
    }catch(cause){setError((cause as Error).message);}
  };
  const create=async(event:FormEvent)=>{
    event.preventDefault();
    try{
      const body={...form,email:form.email||null,customer_number:form.customer_number||null,legal_form:form.legal_form||null,industry:form.industry||null,phone:form.phone||null,city:form.city||null,postal_code:form.postal_code||null,address_line1:form.address_line1||null};
      const customer=await api<Customer>('/customers',{method:'POST',body:JSON.stringify(body)});
      if(!customer)throw new Error('Kunde wurde angelegt, aber es wurde kein Datensatz zurückgegeben.');
      setForm(emptyForm);setCreateOpen(false);setReloadToken(token=>token+1);navigate(`/customers/${customer.id}`);
    }catch(cause){setError((cause as Error).message);}
  };

  return <section className="employee-management customer-management">
    <div className="employee-page-title">
      <div><h1>Kundenverwaltung</h1><p>Kundenstammdaten, Ansprechpartner, Verträge und Objektbeziehungen</p></div>
      <div className="employee-page-actions">
        {selected.length>0&&canWrite&&<>
          <button type="button" onClick={()=>void applyBulk('archive')}>Auswahl archivieren ({selected.length})</button>
          <select aria-label="Status der Auswahl setzen" value="" onChange={event=>{if(event.target.value)void applyBulk('set_status',event.target.value);}}>
            <option value="">Status setzen</option>{Object.entries(statusLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}
          </select>
          {managers.length>0&&<select aria-label="Betreuer der Auswahl setzen" value="" onChange={event=>{if(event.target.value)void applyBulk('set_manager',event.target.value);}}>
            <option value="">Betreuer setzen</option>{managers.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}
          </select>}
        </>}
        {canExport&&<button type="button" onClick={()=>void exportCsv()}>Export{selected.length?` (${selected.length})`:''}</button>}
        {canWrite&&<button type="button" onClick={()=>setCreateOpen(value=>!value)}>+ Kunde anlegen</button>}
      </div>
    </div>
    {error&&<p role="alert" className="error">{error}</p>}
    {dashboard&&<div className="stats-grid employee-metrics">
      {([
        [dashboard.total,'Kunden gesamt'],[dashboard.active,'Aktiv'],[dashboard.pipeline,'Interessenten / Angebot'],[dashboard.at_risk,'Mit Risiko'],
        [dashboard.paused,'Pausiert'],[dashboard.new_30d,'Neu in 30 Tagen'],[dashboard.incomplete_master_data,'Stammdaten unvollständig'],
        [dashboard.active_object_links,'Aktive Objektbeziehungen'],[dashboard.contracts_expiring_90_days,'Verträge laufen aus'],
        [dashboard.open_tasks,'Offene Aufgaben'],[dashboard.overdue_tasks,'Überfällige Aufgaben'],
      ] as [number,string][]).map(([value,label])=><article key={label}><strong>{value}</strong><span>{label}</span></article>)}
    </div>}
    {dashboard&&dashboard.reminders?.length>0&&<article className="customer-reminder-list customer-cockpit-panel">
      <h3>Vertragsfristen & Erinnerungen</h3>
      <ul>{dashboard.reminders.map(reminder=><li key={reminder.id} className={reminder.severity}>
        <span className="customer-reminder-severity">{reminder.severity==='critical'?'Kritisch':'Warnung'}</span>
        <Link to={reminder.url}><strong>{reminder.label}</strong></Link>
        <small>{reminder.customer_name} · {reminder.contract_number} · Fällig {displayDate(reminder.due_date)}</small>
      </li>)}</ul>
    </article>}
    <section className="customer-action-board" aria-label="Handlungsübersicht">
      <h2>Handlungsübersicht</h2>
      <div className="customer-action-columns">{(['A','B','C'] as const).map(bucket=><article key={bucket} className={`customer-action-column bucket-${bucket}`}>
        <h3>{bucket} · {bucketLabels[bucket]} <small>{actions[bucket].length}</small></h3>
        <ul>{actions[bucket].length?actions[bucket].map(entry=><li key={entry.id}>
          <Link to={actionTarget(entry)}><strong>{entry.label}</strong><small>{entry.customer_name}</small></Link>
          {entry.due_at&&<small className="customer-action-due">Fällig {displayDate(entry.due_at)}</small>}
        </li>):<li className="employee-empty">Keine Einträge</li>}</ul>
      </article>)}</div>
    </section>
    {createOpen&&canWrite&&<form onSubmit={create} className="employee-create open customer-create">
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
        <select aria-label="Risikoklasse" value={risk} onChange={event=>{setRisk(event.target.value);setPage(1);}}>
          <option value="all">Alle Risikoklassen</option><option value="unknown">Nicht bewertet</option><option value="low">Niedrig</option><option value="medium">Mittel</option><option value="high">Hoch</option><option value="critical">Kritisch</option>
        </select>
        <select aria-label="Priorität" value={priority} onChange={event=>{setPriority(event.target.value);setPage(1);}}>
          <option value="all">Alle Prioritäten</option><option value="low">Niedrig</option><option value="normal">Normal</option><option value="high">Hoch</option><option value="critical">Kritisch</option>
        </select>
        <select aria-label="Betreuer" value={manager} onChange={event=>{setManager(event.target.value);setPage(1);}}>
          <option value="all">Alle Betreuer</option>{managers.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <select aria-label="Vertragsstatus" value={contractStatus} onChange={event=>{setContractStatus(event.target.value);setPage(1);}}>
          <option value="all">Alle Vertragsstatus</option><option value="draft">Entwurf</option><option value="in_review">In Prüfung</option><option value="pending_approval">Freigabe ausstehend</option><option value="active">Aktiv</option><option value="paused">Pausiert</option><option value="termination_received">Kündigung eingegangen</option><option value="expiring">Läuft aus</option><option value="ended">Beendet</option><option value="archived">Archiviert</option>
        </select>
        <select aria-label="Aktivitätsstatus" value={active} onChange={event=>{setActive(event.target.value);setPage(1);}}>
          <option value="all">Alle Aktivitätsstatus</option><option value="true">Nur aktive Kunden</option><option value="false">Nicht aktiv</option>
        </select>
        <button type="button" onClick={resetFilters}>Filter zurücksetzen</button>
      </div>
      <div className="employee-table employee-overview-table">
        <table><thead><tr>
          <th><input type="checkbox" aria-label="Alle Kunden dieser Seite auswählen" checked={customers.length>0&&customers.every(row=>selected.includes(row.id))} onChange={event=>setSelected(rows=>event.target.checked?Array.from(new Set([...rows,...customers.map(row=>row.id)])):rows.filter(id=>!customers.some(row=>row.id===id)))}/></th>
          <th><button type="button" onClick={()=>toggleSort('customer_number')}>Kundennummer</button></th>
          <th><button type="button" onClick={()=>toggleSort('name')}>Firma</button></th>
          <th><button type="button" onClick={()=>toggleSort('customer_status')}>Status</button></th>
          <th><button type="button" onClick={()=>toggleSort('priority')}>Priorität</button></th>
          <th><button type="button" onClick={()=>toggleSort('risk_classification')}>Risiko</button></th>
          <th><button type="button" onClick={()=>toggleSort('account_manager_name')}>Betreuer</button></th>
          <th><button type="button" onClick={()=>toggleSort('active_sites')}>Aktive Objekte</button></th>
          <th><button type="button" onClick={()=>toggleSort('active_contracts')}>Aktive Verträge</button></th>
          <th><button type="button" onClick={()=>toggleSort('next_contract_deadline')}>Nächste Vertragsfrist</button></th>
          <th><button type="button" onClick={()=>toggleSort('last_activity')}>Letzte Aktivität</button></th>
          <th><button type="button" onClick={()=>toggleSort('open_tasks')}>Offene Aufgaben</button></th>
          <th>Aktion</th>
        </tr></thead><tbody>
          {customers.map(customer=><tr key={customer.id} className={selected.includes(customer.id)?'selected-row':''}>
            <td><input type="checkbox" aria-label={`${customer.name} auswählen`} checked={selected.includes(customer.id)} onChange={()=>toggleSelected(customer.id)}/></td>
            <td>{customer.customer_number||'–'}</td>
            <td><button type="button" className="employee-name-link" onClick={()=>navigate(`/customers/${customer.id}`)}><strong>{customer.name}</strong><small>{customer.email||customer.industry||'Keine Kontaktangabe'}</small></button></td>
            <td><span className={`employee-status ${customer.customer_status}`}>{statusLabels[customer.customer_status]||customer.customer_status}</span></td>
            <td>{priorityLabels[customer.priority]||customer.priority}</td>
            <td>{riskLabels[customer.risk_classification]||customer.risk_classification}</td>
            <td>{customer.account_manager_name||'–'}</td>
            <td>{customer.active_sites}</td>
            <td>{customer.active_contracts}{customer.expiring_contracts>0&&<small className="customer-expiring"> · {customer.expiring_contracts} Frist</small>}</td>
            <td>{displayDate(customer.next_contract_deadline)}</td>
            <td>{displayDate(customer.last_activity)}</td>
            <td>{customer.open_tasks}{customer.overdue_tasks>0&&<small className="customer-expiring"> · {customer.overdue_tasks} überfällig</small>}</td>
            <td><button type="button" onClick={()=>navigate(`/customers/${customer.id}`)}>Öffnen</button></td>
          </tr>)}
        </tbody></table>
        {loading&&<p className="employee-empty">Kunden werden geladen …</p>}
        {!loading&&customers.length===0&&<p className="employee-empty">Keine Kunden entsprechen den aktiven Filtern.</p>}
        {total>0&&<div className="employee-pagination"><span>{total} Kunden · Seite {page} von {pageCount}</span><button type="button" disabled={page===1} onClick={()=>setPage(value=>Math.max(1,value-1))}>Zurück</button><button type="button" disabled={page>=pageCount} onClick={()=>setPage(value=>value+1)}>Weiter</button></div>}
      </div>
    </div>
  </section>;
}
