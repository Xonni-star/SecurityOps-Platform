import {FormEvent,useEffect,useState} from 'react';
import {api,hasPermission} from '../lib/api';

type Site={id:string;name:string;site_number?:string|null;status:string;security_classification:string;address?:string|null};
type Customer={id:string;name:string;customer_number?:string|null};
type Context={
  site:Site&{object_manager_name?:string|null;operations_manager_name?:string|null};
  customers:{customer_id:string;customer_name:string;relationship_type:string;relationship_status:string}[];
  contracts:{id:string;contract_number:string;customer_name:string;status:string}[];
  locations:{id:string;parent_id:string|null;name:string;code:string|null;location_type:string;security_level:string}[];
  hazards:{id:string;title:string;risk_score:number;status:string;location_name:string|null}[];
  instructions:{id:string;title:string;version:number;status:string;acknowledgement_count:number}[];
  journal:{id:string;created_at:string}[]|null;
};
const statuses:Record<string,string>={planning:'Planung',setup:'Einrichtung',active:'Aktiv',restricted:'Eingeschränkt',temporarily_closed:'Temporär geschlossen',decommissioned:'Stillgelegt',archived:'Archiviert'};
const classifications:Record<string,string>={unknown:'Offen',low:'Niedrig',medium:'Mittel',high:'Hoch',critical:'Kritisch'};
const emptySite={name:'',site_number:'',address:'',status:'planning',security_classification:'unknown'};
type SiteForm=typeof emptySite;

export function Sites(){
  const [sites,setSites]=useState<Site[]>([]);
  const [customers,setCustomers]=useState<Customer[]>([]);
  const [selected,setSelected]=useState<Context|null>(null);
  const [error,setError]=useState('');
  const [search,setSearch]=useState('');
  const [statusFilter,setStatusFilter]=useState('all');
  const [sortKey,setSortKey]=useState<'name'|'site_number'|'address'|'status'|'security_classification'>('name');
  const [descending,setDescending]=useState(false);
  const [page,setPage]=useState(1);
  const [editing,setEditing]=useState<Site|null>(null);
  const [form,setForm]=useState<SiteForm>(emptySite);
  const [formOpen,setFormOpen]=useState(false);
  const [customerId,setCustomerId]=useState('');
  const [locationForm,setLocationForm]=useState({name:'',location_type:'building',code:'',parent_id:''});
  const [hazardForm,setHazardForm]=useState({title:'',category:'other',description:'',likelihood:1,impact:1,protective_measures:'',required_actions:''});
  const [instructionForm,setInstructionForm]=useState({title:'',content:'',status:'draft',version:1,requires_acknowledgement:false});
  const writable=hasPermission('sites:write');

  async function load(){
    try{
      const rows=await api<Site[]>('/sites');
      setSites(rows??[]);setError('');
    }catch(e){setError((e as Error).message);}
  }
  useEffect(()=>{void load();},[]);
  async function open(site:Site){
    try{
      const [context,customerRows]=await Promise.all([
        api<Context>(`/sites/${site.id}/object-context`),
        writable&&hasPermission('customers:write')?api<Customer[]>('/customers'):Promise.resolve([]),
      ]);
      if(context)setSelected(context);
      setCustomers(customerRows??[]);setError('');
    }catch(e){setError((e as Error).message);}
  }
  async function refreshContext(){
    if(!selected)return;
    const context=await api<Context>(`/sites/${selected.site.id}/object-context`);
    if(context)setSelected(context);
  }
  function startEdit(site?:Site){
    setEditing(site??null);
    setForm(site?{name:site.name,site_number:site.site_number??'',address:site.address??'',status:site.status,security_classification:site.security_classification}:emptySite);
    setFormOpen(true);
  }
  async function save(event:FormEvent){
    event.preventDefault();
    try{
      const body={name:form.name,status:form.status,security_classification:form.security_classification,site_number:form.site_number.trim()||null,address:form.address.trim()||null};
      await api(editing?`/sites/${editing.id}`:'/sites',{method:editing?'PATCH':'POST',body:JSON.stringify(body)});
      setFormOpen(false);setEditing(null);setForm(emptySite);await load();
    }catch(e){setError((e as Error).message);}
  }
  async function archive(site:Site){
    if(!window.confirm(`Objekt „${site.name}“ archivieren?`))return;
    try{await api(`/sites/${site.id}`,{method:'PATCH',body:JSON.stringify({status:'archived'})});await load();}
    catch(e){setError((e as Error).message);}
  }
  async function linkCustomer(event:FormEvent){
    event.preventDefault();if(!selected||!customerId)return;
    try{await api(`/sites/${selected.site.id}/customer-links`,{method:'POST',body:JSON.stringify({customer_id:customerId})});setCustomerId('');await refreshContext();setError('');}
    catch(e){setError((e as Error).message);}
  }
  async function createLocation(event:FormEvent){
    event.preventDefault();if(!selected)return;
    try{await api(`/sites/${selected.site.id}/locations`,{method:'POST',body:JSON.stringify({...locationForm,code:locationForm.code||null,parent_id:locationForm.parent_id||null})});setLocationForm({name:'',location_type:'building',code:'',parent_id:''});await refreshContext();setError('');}
    catch(e){setError((e as Error).message);}
  }
  async function createHazard(event:FormEvent){
    event.preventDefault();if(!selected)return;
    try{await api(`/sites/${selected.site.id}/hazards`,{method:'POST',body:JSON.stringify(hazardForm)});setHazardForm({title:'',category:'other',description:'',likelihood:1,impact:1,protective_measures:'',required_actions:''});await refreshContext();setError('');}
    catch(e){setError((e as Error).message);}
  }
  async function createInstruction(event:FormEvent){
    event.preventDefault();if(!selected)return;
    try{await api(`/sites/${selected.site.id}/instructions`,{method:'POST',body:JSON.stringify(instructionForm)});setInstructionForm({title:'',content:'',status:'draft',version:1,requires_acknowledgement:false});await refreshContext();setError('');}
    catch(e){setError((e as Error).message);}
  }
  const filtered=sites.filter(site=>(statusFilter==='all'||site.status===statusFilter)&&`${site.name} ${site.site_number??''} ${site.address??''}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const sorted=[...filtered].sort((a,b)=>String(a[sortKey]??'').localeCompare(String(b[sortKey]??''),'de')*(descending?-1:1));
  const pages=Math.max(1,Math.ceil(sorted.length/10));
  const currentPage=Math.min(page,pages);
  const changeSort=(key:typeof sortKey)=>{if(key===sortKey)setDescending(!descending);else{setSortKey(key);setDescending(false);}setPage(1);};

  return <section className="employee-management">
    {error&&<p role="alert" className="error">{error}</p>}
    {selected?<article>
      <button type="button" onClick={()=>{setSelected(null);setError('');}}>Zur Objektübersicht</button>
      <h2>{selected.site.name}</h2>
      <p>{selected.site.address||'Keine Adresse'} · Sicherheitsklassifizierung: {classifications[selected.site.security_classification]}</p>
      <p>Objektleitung: {selected.site.object_manager_name||'–'} · Einsatzleitung: {selected.site.operations_manager_name||'–'}</p>
      <h3>Kundenbeziehungen</h3>
      <ul>{selected.customers.map(customer=><li key={customer.customer_id}>{customer.customer_name} ({customer.relationship_type}, {customer.relationship_status})</li>)}</ul>
      {writable&&hasPermission('customers:write')&&<form onSubmit={linkCustomer}><select aria-label="Kunde verknüpfen" value={customerId} onChange={e=>setCustomerId(e.target.value)} required><option value="">Kunde verknüpfen …</option>{customers.filter(customer=>!selected.customers.some(link=>link.customer_id===customer.id&&link.relationship_status!=='archived')).map(customer=><option key={customer.id} value={customer.id}>{customer.name}{customer.customer_number?` · ${customer.customer_number}`:''}</option>)}</select><button>Verknüpfen</button></form>}
      <h3>Verträge</h3><ul>{selected.contracts.map(contract=><li key={contract.id}>{contract.contract_number} · {contract.customer_name} · {contract.status}</li>)}</ul>
      <h3>Gebäude, Bereiche und Zonen</h3>
      {writable&&<form onSubmit={createLocation}><input placeholder="Bezeichnung" value={locationForm.name} onChange={e=>setLocationForm({...locationForm,name:e.target.value})} required/><input placeholder="Code" value={locationForm.code} onChange={e=>setLocationForm({...locationForm,code:e.target.value})}/><select aria-label="Strukturtyp" value={locationForm.location_type} onChange={e=>setLocationForm({...locationForm,location_type:e.target.value})}><option value="building">Gebäude</option><option value="area">Bereich</option><option value="zone">Zone</option></select><select aria-label="Übergeordnete Struktur" value={locationForm.parent_id} onChange={e=>setLocationForm({...locationForm,parent_id:e.target.value})}><option value="">Keine übergeordnete Struktur</option>{selected.locations.map(location=><option key={location.id} value={location.id}>{location.name}</option>)}</select><button>Struktur anlegen</button></form>}
      <ul>{selected.locations.map(location=><li key={location.id}>{location.parent_id?`${selected.locations.find(parent=>parent.id===location.parent_id)?.name??'–'} / `:''}{location.code||'–'} · {location.name} ({location.location_type}, Sicherheitsstufe {location.security_level})</li>)}</ul>
      <h3>Gefährdungen</h3>
      {writable&&<form onSubmit={createHazard}><input placeholder="Gefährdung" value={hazardForm.title} onChange={e=>setHazardForm({...hazardForm,title:e.target.value})} required/><input placeholder="Beschreibung" value={hazardForm.description} onChange={e=>setHazardForm({...hazardForm,description:e.target.value})} required/><select aria-label="Gefährdungskategorie" value={hazardForm.category} onChange={e=>setHazardForm({...hazardForm,category:e.target.value})}><option value="other">Sonstige</option><option value="fire">Brand</option><option value="burglary">Einbruch</option><option value="unauthorized_access">Unbefugter Zutritt</option><option value="technical">Technische Störung</option></select><label>Eintritt <input type="number" min="1" max="5" value={hazardForm.likelihood} onChange={e=>setHazardForm({...hazardForm,likelihood:Number(e.target.value)})}/></label><label>Auswirkung <input type="number" min="1" max="5" value={hazardForm.impact} onChange={e=>setHazardForm({...hazardForm,impact:Number(e.target.value)})}/></label><input placeholder="Schutzmaßnahmen" value={hazardForm.protective_measures} onChange={e=>setHazardForm({...hazardForm,protective_measures:e.target.value})}/><input placeholder="Erforderliche Maßnahmen" value={hazardForm.required_actions} onChange={e=>setHazardForm({...hazardForm,required_actions:e.target.value})}/><button>Gefährdung erfassen</button></form>}
      <ul>{selected.hazards.map(hazard=><li key={hazard.id}>{hazard.title} · Risiko {hazard.risk_score} · {hazard.status}{hazard.location_name?` · ${hazard.location_name}`:''}</li>)}</ul>
      <h3>Dienstanweisungen</h3>
      {writable&&<form onSubmit={createInstruction}><input placeholder="Titel" value={instructionForm.title} onChange={e=>setInstructionForm({...instructionForm,title:e.target.value})} required/><textarea placeholder="Inhalt" value={instructionForm.content} onChange={e=>setInstructionForm({...instructionForm,content:e.target.value})} required/><select aria-label="Anweisungsstatus" value={instructionForm.status} onChange={e=>setInstructionForm({...instructionForm,status:e.target.value})}><option value="draft">Entwurf</option><option value="pending_approval">Freigabe ausstehend</option><option value="approved">Freigegeben</option></select><label><input type="checkbox" checked={instructionForm.requires_acknowledgement} onChange={e=>setInstructionForm({...instructionForm,requires_acknowledgement:e.target.checked})}/> Kenntnisnahme erforderlich</label><button>Anweisung speichern</button></form>}
      <ul>{selected.instructions.map(instruction=><li key={instruction.id}>{instruction.title} v{instruction.version} · {instruction.status} · Kenntnisnahmen: {instruction.acknowledgement_count}</li>)}</ul>
      <h3>Objektjournal</h3>{selected.journal===null?<p>Keine Berechtigung für das Wachbuch.</p>:<ul>{selected.journal.map(entry=><li key={entry.id}>{new Date(entry.created_at).toLocaleString()}</li>)}</ul>}
    </article>:<>
      <div className="employee-page-title"><div className="employee-page-title-spacer"/><div className="employee-page-actions">{writable&&<button type="button" onClick={()=>startEdit()}>+ Objekt anlegen</button>}</div></div>
      <div className="stats-grid employee-metrics">
        <article><strong>{sites.length}</strong><span>Objekte gesamt</span></article>
        <article><strong>{sites.filter(site=>site.status==='active').length}</strong><span>Aktiv</span></article>
        <article><strong>{sites.filter(site=>site.status==='planning'||site.status==='setup').length}</strong><span>In Vorbereitung</span></article>
        <article><strong>{sites.filter(site=>site.status==='restricted'||site.status==='temporarily_closed').length}</strong><span>Eingeschränkt</span></article>
        <article><strong>{sites.filter(site=>site.status==='archived').length}</strong><span>Archiviert</span></article>
      </div>
      {formOpen&&writable&&<form onSubmit={save} className="employee-create open">
        <label>Objektname<input required value={form.name} onChange={e=>setForm({...form,name:e.target.value})}/></label>
        <label>Objektnummer<input value={form.site_number} onChange={e=>setForm({...form,site_number:e.target.value})}/></label>
        <label>Adresse<input value={form.address} onChange={e=>setForm({...form,address:e.target.value})}/></label>
        <label>Status<select value={form.status} onChange={e=>setForm({...form,status:e.target.value})}>{Object.entries(statuses).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
        <label>Sicherheitsklassifizierung<select value={form.security_classification} onChange={e=>setForm({...form,security_classification:e.target.value})}>{Object.entries(classifications).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
        <button>Speichern</button><button type="button" onClick={()=>setFormOpen(false)}>Abbrechen</button>
      </form>}
      <div className="employee-overview">
        <div className="employee-filterbar"><input className="employee-search" aria-label="Objekte suchen" placeholder="Name, Objektnummer oder Adresse suchen" value={search} onChange={e=>{setSearch(e.target.value);setPage(1);}}/><select aria-label="Status" value={statusFilter} onChange={e=>{setStatusFilter(e.target.value);setPage(1);}}><option value="all">Status: Alle</option>{Object.entries(statuses).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></div>
        <div className="employee-table employee-overview-table"><table><thead><tr>{([['name','Objekt'],['site_number','Objektnummer'],['address','Adresse'],['status','Status'],['security_classification','Sicherheitsklassifizierung']] as const).map(([key,label])=><th key={key}><button type="button" onClick={()=>changeSort(key)}>{label}</button></th>)}<th>Aktion</th></tr></thead><tbody>
          {sorted.slice((currentPage-1)*10,currentPage*10).map(site=><tr key={site.id}><td><button className="employee-name-link" type="button" onClick={()=>void open(site)}>{site.name}</button></td><td>{site.site_number||'–'}</td><td>{site.address||'–'}</td><td>{statuses[site.status]??site.status}</td><td>{classifications[site.security_classification]??site.security_classification}</td><td>{writable&&<><button type="button" onClick={()=>startEdit(site)}>Bearbeiten</button>{['planning','setup','decommissioned'].includes(site.status)&&<button type="button" onClick={()=>void archive(site)}>Archivieren</button>}</>}</td></tr>)}
        </tbody></table>{filtered.length===0&&<p className="employee-empty">Keine Objekte entsprechen den aktiven Filtern.</p>}
        {filtered.length>0&&<div className="employee-pagination"><span>{filtered.length} Objekte · Seite {currentPage} von {pages}</span><button type="button" disabled={currentPage===1} onClick={()=>setPage(value=>Math.max(1,value-1))}>Zurück</button><button type="button" disabled={currentPage===pages} onClick={()=>setPage(value=>Math.min(pages,value+1))}>Weiter</button></div>}</div>
      </div>
    </>}
  </section>;
}
