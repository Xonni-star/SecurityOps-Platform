import {ChangeEvent,FormEvent,useEffect,useState} from 'react';
import {useNavigate,useParams} from 'react-router-dom';
import {api,csrf,hasPermission} from '../lib/api';
import {uuid} from '../lib/uuid';

type Customer={
  id:string;name:string;email:string|null;customer_number:string|null;legal_form:string|null;industry:string|null;
  customer_status:string;priority:string;risk_classification:string;started_on:string|null;ended_on:string|null;
  account_manager_employee_id:string|null;internal_notes:string|null;phone:string|null;website:string|null;
  billing_email:string|null;address_line1:string|null;address_line2:string|null;postal_code:string|null;city:string|null;
  region:string|null;country_code:string;billing_address:string|null;communication_preferences:string|null;account_manager_name:string|null;
};
type Contact={id:string;first_name:string|null;last_name:string|null;job_title:string|null;department:string|null;email:string|null;phone:string|null;mobile_phone:string|null;preferred_contact_method:string|null;notes:string|null;status:string;is_primary:boolean;is_decision_maker:boolean;is_security_contact:boolean;is_billing_contact:boolean;is_emergency_contact:boolean;sites:{id:string;name:string;site_number:string|null}[]};
type Site={id:string;site_id:string;site_name:string;site_number:string|null;address:string|null;site_status:string;relationship_type:string;relationship_status:string;security_classification:string;assigned_employees:number;upcoming_shifts:number;open_incidents:number};
type Service={id:string;service_code:string|null;name:string;description:string|null;unit:string|null;default_unit_price:number|null};
type Contract={id:string;contract_number:string;contract_type:string;scope:string|null;starts_on:string;ends_on:string|null;renewal_type:string;notice_period_days:number|null;next_termination_date:string|null;status:string;total_value:number|null;monthly_value:number|null;billing_model:string|null;sla:string|null;internal_notes:string|null;sites:{id:string;name:string;site_number:string|null}[];services:{id:string;name:string;quantity:number;unit:string|null;unit_price:number|null}[]};
type Task={id:string;title:string;description:string|null;due_at:string|null;status:string;assigned_employee_name:string|null};
type Document={id:string;title:string;description:string|null;customer_document_category:string;document_status:string;created_at:string;versions:{id:string;version_no:number;size_bytes:number;lifecycle_state:string}[]};
type Profile={customer:Customer;contacts:Contact[];sites:Site[];contracts:Contract[];documents:Document[];tasks:Task[];history:{id:string;event_type:string;details:Record<string,string>;created_at:string;actor_email:string|null}[];operations:{assigned_employees:number;upcoming_shifts:number;open_incidents:number}};
type ContactForm={first_name:string;last_name:string;job_title:string;department:string;email:string;phone:string;mobile_phone:string;preferred_contact_method:string;notes:string;status:string;is_primary:boolean;is_decision_maker:boolean;is_security_contact:boolean;is_billing_contact:boolean;is_emergency_contact:boolean;site_ids:string[]};
const emptyContact:ContactForm={first_name:'',last_name:'',job_title:'',department:'',email:'',phone:'',mobile_phone:'',preferred_contact_method:'email',notes:'',status:'active',is_primary:false,is_decision_maker:false,is_security_contact:false,is_billing_contact:false,is_emergency_contact:false,site_ids:[]};
const tabs=[['uebersicht','Übersicht'],['stammdaten','Stammdaten'],['ansprechpartner','Ansprechpartner'],['objekte','Objekte & Einsätze'],['vertraege','Verträge & Leistungen'],['dokumente','Dokumente'],['aufgaben','Aufgaben'],['verlauf','Verlauf']] as const;
const dateToday=()=>new Date().toISOString().slice(0,10);
const emptyContract={contract_number:'',contract_type:'Objektschutz',scope:'',starts_on:dateToday(),ends_on:'',renewal_type:'manual',notice_period_days:'',next_termination_date:'',status:'draft',total_value:'',monthly_value:'',billing_model:'fixed',sla:'',internal_notes:''};

function fileToBase64(file:File){
  return file.arrayBuffer().then(buffer=>{
    let binary='';const bytes=new Uint8Array(buffer);
    for(let index=0;index<bytes.length;index+=0x8000)binary+=String.fromCharCode(...bytes.subarray(index,index+0x8000));
    return btoa(binary);
  });
}

export function CustomerDetail(){
  const navigate=useNavigate();
  const {customerId,section}=useParams<{customerId:string;section?:string}>();
  const [profile,setProfile]=useState<Profile|null>(null);
  const [form,setForm]=useState<Customer|null>(null);
  const [sites,setSites]=useState<{id:string;name:string;site_number?:string|null}[]>([]);
  const [employees,setEmployees]=useState<{id:string;name:string}[]>([]);
  const [services,setServices]=useState<Service[]>([]);
  const [error,setError]=useState('');
  const [loading,setLoading]=useState(true);
  const [contactForm,setContactForm]=useState<ContactForm>(emptyContact);
  const [editingContact,setEditingContact]=useState('');
  const [siteId,setSiteId]=useState('');
  const [contractForm,setContractForm]=useState(emptyContract);
  const [taskTitle,setTaskTitle]=useState('');
  const [taskDue,setTaskDue]=useState('');
  const [taskAssignee,setTaskAssignee]=useState('');
  const [documentTitle,setDocumentTitle]=useState('');
  const [documentCategory,setDocumentCategory]=useState('contract');
  const [documentSite,setDocumentSite]=useState('');
  const [file,setFile]=useState<File|null>(null);
  const [versionFiles,setVersionFiles]=useState<Record<string,File|null>>({});
  const [contractSite,setContractSite]=useState<Record<string,string>>({});
  const [serviceForms,setServiceForms]=useState<Record<string,{service_id:string;quantity:string;unit_price:string}>>({});
  const [newService,setNewService]=useState({name:'',service_code:'',unit:'',default_unit_price:''});
  const active=tabs.some(([key])=>key===section)?section:'uebersicht';

  const load=async()=>{
    if(!customerId)return;
    setLoading(true);
    try{
      const [data,siteRows,serviceRows,employeeRows]=await Promise.all([
        api<Profile>(`/customers/${customerId}/profile`),
        hasPermission('sites:read')?api<typeof sites>('/sites'):Promise.resolve([]),
        hasPermission('contracts:read')?api<Service[]>('/services'):Promise.resolve([]),
        hasPermission('employees:read')?api<{id:string;name:string}[]>('/employees'):Promise.resolve([]),
      ]);
      if(!data)throw new Error('Kundenakte konnte nicht gefunden werden.');
      setProfile(data);setForm({...data.customer});setSites(siteRows??[]);setServices(serviceRows??[]);setEmployees(employeeRows??[]);setError('');
    }catch(e){setError((e as Error).message);setProfile(null);}
    finally{setLoading(false);}
  };
  useEffect(()=>{void load();},[customerId]);

  const saveCustomer=async(event:FormEvent)=>{
    event.preventDefault();if(!customerId||!form)return;
    try{
      await api(`/customers/${customerId}`,{method:'PATCH',body:JSON.stringify({
        name:form.name,email:form.email||null,customer_number:form.customer_number,legal_form:form.legal_form,industry:form.industry,
        customer_status:form.customer_status,priority:form.priority,risk_classification:form.risk_classification,
        started_on:form.started_on,ended_on:form.ended_on,account_manager_employee_id:form.account_manager_employee_id,
        internal_notes:form.internal_notes,phone:form.phone,website:form.website||null,billing_email:form.billing_email||null,
        address_line1:form.address_line1,address_line2:form.address_line2,postal_code:form.postal_code,city:form.city,
        region:form.region,country_code:form.country_code,billing_address:form.billing_address,
        communication_preferences:form.communication_preferences,
      })});
      await load();
    }catch(e){setError((e as Error).message);}
  };
  const saveContact=async(event:FormEvent)=>{
    event.preventDefault();if(!customerId)return;
    const body={...contactForm,first_name:contactForm.first_name||null,last_name:contactForm.last_name||null,job_title:contactForm.job_title||null,department:contactForm.department||null,email:contactForm.email||null,phone:contactForm.phone||null,mobile_phone:contactForm.mobile_phone||null,preferred_contact_method:contactForm.preferred_contact_method||null,notes:contactForm.notes||null};
    try{
      await api(editingContact?`/customers/${customerId}/contacts/${editingContact}`:`/customers/${customerId}/contacts`,{method:editingContact?'PATCH':'POST',body:JSON.stringify(body)});
      setContactForm(emptyContact);setEditingContact('');await load();
    }catch(e){setError((e as Error).message);}
  };
  const editContact=(contact:Contact)=>{
    setEditingContact(contact.id);
    setContactForm({first_name:contact.first_name??'',last_name:contact.last_name??'',job_title:contact.job_title??'',department:contact.department??'',email:contact.email??'',phone:contact.phone??'',mobile_phone:contact.mobile_phone??'',preferred_contact_method:contact.preferred_contact_method??'',notes:contact.notes??'',status:contact.status,is_primary:contact.is_primary,is_decision_maker:contact.is_decision_maker,is_security_contact:contact.is_security_contact,is_billing_contact:contact.is_billing_contact,is_emergency_contact:contact.is_emergency_contact,site_ids:contact.sites.map(item=>item.id)});
  };
  const linkSite=async(event:FormEvent)=>{
    event.preventDefault();if(!customerId||!siteId)return;
    try{await api(`/customers/${customerId}/sites`,{method:'POST',body:JSON.stringify({site_id:siteId,relationship_type:'operational'})});setSiteId('');await load();}
    catch(e){setError((e as Error).message);}
  };
  const createContract=async(event:FormEvent)=>{
    event.preventDefault();if(!customerId)return;
    try{
      await api(`/customers/${customerId}/contracts`,{method:'POST',body:JSON.stringify({...contractForm,ends_on:contractForm.ends_on||null,notice_period_days:contractForm.notice_period_days?Number(contractForm.notice_period_days):null,next_termination_date:contractForm.next_termination_date||null,total_value:contractForm.total_value?Number(contractForm.total_value):null,monthly_value:contractForm.monthly_value?Number(contractForm.monthly_value):null})});
      setContractForm(emptyContract);await load();
    }catch(e){setError((e as Error).message);}
  };
  const updateContract=async(contract:Contract,updates:Record<string,unknown>)=>{
    if(!customerId)return;
    try{await api(`/customers/${customerId}/contracts/${contract.id}`,{method:'PATCH',body:JSON.stringify(updates)});await load();}
    catch(e){setError((e as Error).message);}
  };
  const addContractSite=async(contract:Contract)=>{
    const selected=contractSite[contract.id];if(!selected||!customerId)return;
    try{await api(`/customers/${customerId}/contracts/${contract.id}/sites`,{method:'POST',body:JSON.stringify({site_id:selected})});setContractSite({...contractSite,[contract.id]:''});await load();}
    catch(e){setError((e as Error).message);}
  };
  const setSiteRelationshipStatus=async(site:Site,relationship_status:string)=>{
    try{await api(`/customers/${customerId}/sites/${site.site_id}`,{method:'PATCH',body:JSON.stringify({relationship_status})});await load();}
    catch(e){setError((e as Error).message);}
  };
  const addContractService=async(contract:Contract)=>{
    const service=serviceForms[contract.id];if(!service?.service_id||!customerId)return;
    const selectedService=services.find(item=>item.id===service.service_id);
    try{
      await api(`/customers/${customerId}/contracts/${contract.id}/services`,{method:'POST',body:JSON.stringify({service_id:service.service_id,quantity:Number(service.quantity||1),unit:selectedService?.unit??null,unit_price:service.unit_price?Number(service.unit_price):selectedService?.default_unit_price??null})});
      setServiceForms({...serviceForms,[contract.id]:{service_id:'',quantity:'1',unit_price:''}});await load();
    }catch(e){setError((e as Error).message);}
  };
  const createService=async(event:FormEvent)=>{
    event.preventDefault();
    try{await api('/services',{method:'POST',body:JSON.stringify({...newService,service_code:newService.service_code||null,unit:newService.unit||null,default_unit_price:newService.default_unit_price?Number(newService.default_unit_price):null})});setNewService({name:'',service_code:'',unit:'',default_unit_price:''});await load();}
    catch(e){setError((e as Error).message);}
  };
  const createTask=async(event:FormEvent)=>{
    event.preventDefault();if(!customerId)return;
    try{await api(`/customers/${customerId}/tasks`,{method:'POST',body:JSON.stringify({title:taskTitle,due_at:taskDue?new Date(taskDue).toISOString():null,assigned_employee_id:taskAssignee||null})});setTaskTitle('');setTaskDue('');setTaskAssignee('');await load();}
    catch(e){setError((e as Error).message);}
  };
  const setTaskStatus=async(task:Task,status:string)=>{
    try{await api(`/customers/${customerId}/tasks/${task.id}`,{method:'PATCH',body:JSON.stringify({status})});await load();}
    catch(e){setError((e as Error).message);}
  };
  const uploadDocument=async(event:FormEvent)=>{
    event.preventDefault();if(!customerId||!file)return;
    try{
      await api('/dms/documents',{method:'POST',body:JSON.stringify({title:documentTitle,customer_id:customerId,customer_document_category:documentCategory,site_id:documentSite||null,content_type:file.type||'application/octet-stream',content_base64:await fileToBase64(file),client_mutation_id:uuid()})});
      setDocumentTitle('');setFile(null);await load();
    }catch(e){setError((e as Error).message);}
  };
  const uploadDocumentVersion=async(document:Document)=>{
    const versionFile=versionFiles[document.id];if(!versionFile)return;
    try{
      await api(`/dms/documents/${document.id}/versions`,{method:'POST',body:JSON.stringify({content_type:versionFile.type||'application/octet-stream',content_base64:await fileToBase64(versionFile),client_mutation_id:uuid()})});
      setVersionFiles({...versionFiles,[document.id]:null});await load();
    }catch(e){setError((e as Error).message);}
  };
  const download=async(document:Document,version:Document['versions'][number])=>{
    try{
      const response=await fetch(`/api/v1/dms/documents/${document.id}/versions/${version.id}/download`,{credentials:'include',headers:{'x-csrf-token':csrf()}});
      if(!response.ok)throw new Error((await response.json()).error||'Download fehlgeschlagen');
      const url=URL.createObjectURL(await response.blob()),link=window.document.createElement('a');
      link.href=url;link.download=`${document.title}-v${version.version_no}`;link.click();URL.revokeObjectURL(url);
    }catch(e){setError((e as Error).message);}
  };
  if(loading&&!profile)return <section className="employee-detail-page customer-detail-page"><button className="employee-back" onClick={()=>navigate('/customers')}>Zurück zur Kundenübersicht</button><p>Kundenakte wird geladen …</p></section>;
  if(!profile)return <section className="employee-detail-page customer-detail-page"><button className="employee-back" onClick={()=>navigate('/customers')}>Zurück zur Kundenübersicht</button>{error&&<p role="alert" className="error">{error}</p>}<p>Kundenakte konnte nicht geladen werden.</p></section>;

  const customer=profile.customer;
  const statusLabels:Record<string,string>={prospect:'Interessent',negotiating:'In Verhandlung',active:'Aktiv',paused:'Pausiert',at_risk:'Gefährdet',terminated:'Beendet',archived:'Archiviert'};
  const profileForm=(field:keyof Customer,value:string)=>setForm(current=>current?({...current,[field]:value||null} as Customer):current);
  const selectContactSites=(event:ChangeEvent<HTMLSelectElement>)=>setContactForm({...contactForm,site_ids:Array.from(event.target.selectedOptions,item=>item.value)});
  const renderSimpleTable=(title:string,headers:string[],rows:string[][])=><article className="employee-detail-table"><h3>{title}</h3><table><thead><tr>{headers.map(header=><th key={header}>{header}</th>)}</tr></thead><tbody>{rows.map((row,index)=><tr key={index}>{row.map((value,column)=><td key={column}>{value||'–'}</td>)}</tr>)}</tbody></table>{rows.length===0&&<p className="employee-empty">Keine Daten erfasst.</p>}</article>;

  return <section className="employee-detail-page customer-detail-page">
    {error&&<p role="alert" className="error">{error}</p>}
    <div className="employee-detail-header">
      <button type="button" className="employee-back" onClick={()=>navigate('/customers')}>Zur Kundenübersicht</button>
      <div className="employee-detail-title"><div className="employee-avatar">{customer.name.slice(0,2).toUpperCase()}</div><div><h1>{customer.name}</h1><p>{customer.customer_number||'Keine Kundennummer'} · {customer.legal_form||customer.industry||'Unternehmensprofil'}</p></div><span className={`employee-status ${customer.customer_status}`}>{statusLabels[customer.customer_status]||customer.customer_status}</span></div>
      {hasPermission('customers:write')&&<button type="button" onClick={()=>navigate(`/customers/${customer.id}/stammdaten`)}>Stammdaten bearbeiten</button>}
    </div>
    <nav className="employee-tabs" aria-label="Kundenbereiche">{tabs.map(([key,label])=><button type="button" key={key} className={active===key?'active':''} onClick={()=>navigate(`/customers/${customer.id}/${key}`)}>{label}</button>)}</nav>
    <div className="employee-detail-content">
      {active==='uebersicht'&&<>
        {(hasPermission('customer_reports:export')||hasPermission('customer_portal:read'))&&<p><button type="button" onClick={()=>navigate(`/customer-reports?customer_id=${customer.id}`)}>Kundenberichte & Nachweise öffnen</button></p>}
        <div className="employee-detail-kpis">
          <article><strong>{profile.sites.length}</strong><span>Objekte</span></article>
          <article><strong>{profile.contracts.filter(item=>item.status==='active').length}</strong><span>Aktive Verträge</span></article>
          <article><strong>{profile.contacts.filter(item=>item.status==='active').length}</strong><span>Ansprechpartner</span></article>
          <article><strong>{profile.operations.assigned_employees}</strong><span>Zugeordnetes Personal</span></article>
          <article><strong>{profile.operations.upcoming_shifts}</strong><span>Kommende Schichten</span></article>
          <article><strong>{profile.operations.open_incidents}</strong><span>Offene Einsätze</span></article>
        </div>
        <div className="employee-detail-grid">
          <article><h3>Unternehmen</h3><dl><dt>Status</dt><dd>{statusLabels[customer.customer_status]||customer.customer_status}</dd><dt>Branche</dt><dd>{customer.industry||'–'}</dd><dt>Priorität</dt><dd>{customer.priority}</dd><dt>Risikoklassifizierung</dt><dd>{customer.risk_classification}</dd></dl></article>
          <article><h3>Kontakt & Anschrift</h3><p>{customer.email||customer.billing_email||'Keine E-Mail erfasst'}<br/>{customer.phone||'Kein Telefon erfasst'}</p><p>{[customer.address_line1,customer.address_line2,[customer.postal_code,customer.city].filter(Boolean).join(' '),customer.region,customer.country_code].filter(Boolean).join(', ')||'Keine Anschrift erfasst'}</p></article>
          <article><h3>Hauptansprechpartner</h3>{profile.contacts.find(item=>item.is_primary&&item.status==='active')?(()=>{const contact=profile.contacts.find(item=>item.is_primary&&item.status==='active')!;return <p><strong>{[contact.first_name,contact.last_name].filter(Boolean).join(' ')}</strong><br/>{contact.job_title||''}<br/>{contact.email||contact.phone||contact.mobile_phone||'Keine Kontaktdaten'}</p>;})():<p>Kein Hauptansprechpartner festgelegt.</p>}</article>
          <article><h3>Vertragsfristen</h3>{profile.contracts.filter(item=>item.ends_on&&item.status!=='ended'&&item.status!=='archived').length?profile.contracts.filter(item=>item.ends_on&&item.status!=='ended'&&item.status!=='archived').slice(0,4).map(contract=><p key={contract.id}><strong>{contract.contract_number}</strong><br/><small>Endet {contract.ends_on} · {contract.renewal_type==='automatic'?'automatische':'manuelle'} Verlängerung</small></p>):<p>Keine auslaufenden Vertragsdaten.</p>}</article>
        </div>
      </>}
      {active==='stammdaten'&&hasPermission('customers:write')&&form&&<form className="employee-detail-form" onSubmit={saveCustomer}><div className="form-grid">
        <label>Unternehmen<input required value={form.name} onChange={event=>profileForm('name',event.target.value)}/></label>
        <label>Kundennummer<input value={form.customer_number||''} onChange={event=>profileForm('customer_number',event.target.value)}/></label>
        <label>Rechtsform<input value={form.legal_form||''} onChange={event=>profileForm('legal_form',event.target.value)}/></label>
        <label>Branche<input value={form.industry||''} onChange={event=>profileForm('industry',event.target.value)}/></label>
        <label>Interne Kundenbetreuung<select value={form.account_manager_employee_id||''} onChange={event=>setForm({...form,account_manager_employee_id:event.target.value||null})}><option value="">Nicht zugewiesen</option>{employees.map(employee=><option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></label>
        <label>Status<select value={form.customer_status} onChange={event=>setForm({...form,customer_status:event.target.value})}><option value="prospect">Interessent</option><option value="negotiating">In Verhandlung</option><option value="active">Aktiv</option><option value="paused">Pausiert</option><option value="at_risk">Gefährdet</option><option value="terminated">Beendet</option><option value="archived">Archiviert</option></select></label>
        <label>Priorität<select value={form.priority} onChange={event=>setForm({...form,priority:event.target.value})}><option value="low">Niedrig</option><option value="normal">Normal</option><option value="high">Hoch</option><option value="critical">Kritisch</option></select></label>
        <label>Risikoklassifizierung<select value={form.risk_classification} onChange={event=>setForm({...form,risk_classification:event.target.value})}><option value="unknown">Nicht bewertet</option><option value="low">Niedrig</option><option value="medium">Mittel</option><option value="high">Hoch</option><option value="critical">Kritisch</option></select></label>
        <label>Beginn<input type="date" value={form.started_on?.slice(0,10)||''} onChange={event=>profileForm('started_on',event.target.value)}/></label>
        <label>Ende<input type="date" value={form.ended_on?.slice(0,10)||''} onChange={event=>profileForm('ended_on',event.target.value)}/></label>
        <label>Telefon<input value={form.phone||''} onChange={event=>profileForm('phone',event.target.value)}/></label>
        <label>Allgemeine E-Mail<input type="email" value={form.email||''} onChange={event=>profileForm('email',event.target.value)}/></label>
        <label>Website<input type="url" value={form.website||''} onChange={event=>profileForm('website',event.target.value)}/></label>
        <label>Rechnungs-E-Mail<input type="email" value={form.billing_email||''} onChange={event=>profileForm('billing_email',event.target.value)}/></label>
        <label className="span-2">Straße und Hausnummer<input value={form.address_line1||''} onChange={event=>profileForm('address_line1',event.target.value)}/></label>
        <label>Adresszusatz<input value={form.address_line2||''} onChange={event=>profileForm('address_line2',event.target.value)}/></label>
        <label>PLZ<input value={form.postal_code||''} onChange={event=>profileForm('postal_code',event.target.value)}/></label>
        <label>Ort<input value={form.city||''} onChange={event=>profileForm('city',event.target.value)}/></label>
        <label>Bundesland / Region<input value={form.region||''} onChange={event=>profileForm('region',event.target.value)}/></label>
        <label>Land (ISO-3166-1 alpha-2)<input maxLength={2} value={form.country_code} onChange={event=>setForm({...form,country_code:event.target.value.toUpperCase()})}/></label>
        <label className="span-2">Rechnungsanschrift<textarea value={form.billing_address||''} onChange={event=>profileForm('billing_address',event.target.value)}/></label>
        <label className="span-2">Kommunikationspräferenzen<textarea value={form.communication_preferences||''} onChange={event=>profileForm('communication_preferences',event.target.value)}/></label>
        <label className="span-2">Interne Notizen<textarea value={form.internal_notes||''} onChange={event=>profileForm('internal_notes',event.target.value)}/></label>
      </div><button type="submit">Stammdaten speichern</button></form>}
      {active==='stammdaten'&&!hasPermission('customers:write')&&<p>Keine Schreibberechtigung für Kundenstammdaten.</p>}
      {active==='ansprechpartner'&&<>
        <article className="customer-contact-list"><h3>Ansprechpartner</h3>{profile.contacts.length?profile.contacts.map(contact=><div className="customer-contact-card" key={contact.id}><div><strong>{[contact.first_name,contact.last_name].filter(Boolean).join(' ')||contact.email||'Kontakt'}</strong>{contact.is_primary&&<span className="customer-primary">Hauptansprechpartner</span>}<p>{contact.job_title||contact.department||'Funktion nicht erfasst'} · {contact.status}</p><p>{contact.email||'–'} · {contact.phone||contact.mobile_phone||'–'}</p><small>{[contact.is_security_contact&&'Sicherheitskontakt',contact.is_billing_contact&&'Abrechnung',contact.is_emergency_contact&&'Notfallkontakt',contact.is_decision_maker&&'Entscheider'].filter(Boolean).join(' · ')||'Keine Zusatzrolle'}{contact.sites.length?` · Objekte: ${contact.sites.map(site=>site.site_number||site.name).join(', ')}`:''}</small></div>{hasPermission('customer_contacts:write')&&<button type="button" onClick={()=>editContact(contact)}>Bearbeiten</button>}</div>):<p className="employee-empty">Keine Ansprechpartner hinterlegt.</p>}</article>
        {hasPermission('customer_contacts:write')&&<form className="employee-detail-form customer-form" onSubmit={saveContact}><h3>{editingContact?'Ansprechpartner bearbeiten':'Ansprechpartner hinzufügen'}</h3><div className="form-grid">
          <label>Vorname<input value={contactForm.first_name} onChange={event=>setContactForm({...contactForm,first_name:event.target.value})}/></label><label>Nachname<input value={contactForm.last_name} onChange={event=>setContactForm({...contactForm,last_name:event.target.value})}/></label>
          <label>Funktion<input value={contactForm.job_title} onChange={event=>setContactForm({...contactForm,job_title:event.target.value})}/></label><label>Abteilung<input value={contactForm.department} onChange={event=>setContactForm({...contactForm,department:event.target.value})}/></label>
          <label>E-Mail<input type="email" value={contactForm.email} onChange={event=>setContactForm({...contactForm,email:event.target.value})}/></label><label>Telefon<input value={contactForm.phone} onChange={event=>setContactForm({...contactForm,phone:event.target.value})}/></label>
          <label>Mobil<input value={contactForm.mobile_phone} onChange={event=>setContactForm({...contactForm,mobile_phone:event.target.value})}/></label><label>Bevorzugter Kontakt<select value={contactForm.preferred_contact_method} onChange={event=>setContactForm({...contactForm,preferred_contact_method:event.target.value})}><option value="">Nicht festgelegt</option><option value="email">E-Mail</option><option value="phone">Telefon</option><option value="mobile">Mobil</option><option value="mail">Post</option></select></label>
          <label>Status<select value={contactForm.status} onChange={event=>setContactForm({...contactForm,status:event.target.value})}><option value="active">Aktiv</option><option value="inactive">Inaktiv</option><option value="archived">Archiviert</option></select></label><label>Objektzuordnung<select multiple value={contactForm.site_ids} onChange={selectContactSites}>{profile.sites.map(site=><option key={site.id} value={site.id}>{site.site_number||'–'} · {site.site_name}</option>)}</select></label>
          <label className="span-2">Notiz<textarea value={contactForm.notes} onChange={event=>setContactForm({...contactForm,notes:event.target.value})}/></label>
          <div className="customer-checkboxes"><label><input type="checkbox" checked={contactForm.is_primary} onChange={event=>setContactForm({...contactForm,is_primary:event.target.checked})}/> Hauptansprechpartner</label><label><input type="checkbox" checked={contactForm.is_security_contact} onChange={event=>setContactForm({...contactForm,is_security_contact:event.target.checked})}/> Sicherheitskontakt</label><label><input type="checkbox" checked={contactForm.is_billing_contact} onChange={event=>setContactForm({...contactForm,is_billing_contact:event.target.checked})}/> Rechnungskontakt</label><label><input type="checkbox" checked={contactForm.is_emergency_contact} onChange={event=>setContactForm({...contactForm,is_emergency_contact:event.target.checked})}/> Notfallkontakt</label><label><input type="checkbox" checked={contactForm.is_decision_maker} onChange={event=>setContactForm({...contactForm,is_decision_maker:event.target.checked})}/> Entscheider</label></div>
        </div><div><button type="submit">Speichern</button> {editingContact&&<button type="button" onClick={()=>{setEditingContact('');setContactForm(emptyContact);}}>Abbrechen</button>}</div></form>}
      </>}
      {active==='objekte'&&<>
        {hasPermission('customers:write')&&hasPermission('sites:read')&&<form className="customer-inline-form" onSubmit={linkSite}><label>Vorhandenes Objekt verknüpfen<select required value={siteId} onChange={event=>setSiteId(event.target.value)}><option value="">Objekt auswählen</option>{sites.filter(site=>!profile.sites.some(link=>link.site_id===site.id)).map(site=><option key={site.id} value={site.id}>{site.site_number||'–'} · {site.name}</option>)}</select></label><button type="submit">Objekt zuordnen</button></form>}
        <div className="customer-object-grid">{profile.sites.map(site=><article key={site.site_id}><h3>{site.site_number||'Objekt'} · {site.site_name}</h3><p>{site.address||'Keine Anschrift'} · {site.site_status} · Sicherheitsstufe {site.security_classification}</p><dl><dt>Personal zugeordnet</dt><dd>{site.assigned_employees}</dd><dt>Kommende Schichten</dt><dd>{site.upcoming_shifts}</dd><dt>Offene Einsätze</dt><dd>{site.open_incidents}</dd><dt>Beziehung</dt><dd>{site.relationship_type} · {site.relationship_status}</dd></dl>{site.relationship_status==='active'&&hasPermission('customers:write')&&<button type="button" onClick={()=>void setSiteRelationshipStatus(site,'inactive')}>Beziehung beenden</button>}</article>)}</div>
        {profile.sites.length===0&&<p className="employee-empty">Noch keine Objekte mit diesem Kunden verknüpft.</p>}
      </>}
      {active==='vertraege'&&<>
        {hasPermission('contracts:write')&&<form className="employee-detail-form customer-form" onSubmit={createContract}><h3>Vertrag anlegen</h3><div className="form-grid">
          <label>Vertragsnummer<input required value={contractForm.contract_number} onChange={event=>setContractForm({...contractForm,contract_number:event.target.value})}/></label><label>Vertragsart<input required value={contractForm.contract_type} onChange={event=>setContractForm({...contractForm,contract_type:event.target.value})}/></label>
          <label>Status<select value={contractForm.status} onChange={event=>setContractForm({...contractForm,status:event.target.value})}><option value="draft">Entwurf</option><option value="in_review">In Prüfung</option><option value="pending_approval">Freigabe ausstehend</option><option value="active">Aktiv</option></select></label><label>Abrechnungsmodell<select value={contractForm.billing_model} onChange={event=>setContractForm({...contractForm,billing_model:event.target.value})}><option value="fixed">Pauschale</option><option value="hourly">Stundenbasiert</option><option value="usage_based">Nutzungsbasiert</option><option value="mixed">Gemischt</option></select></label>
          <label>Beginn<input required type="date" value={contractForm.starts_on} onChange={event=>setContractForm({...contractForm,starts_on:event.target.value})}/></label><label>Ende<input type="date" value={contractForm.ends_on} onChange={event=>setContractForm({...contractForm,ends_on:event.target.value})}/></label>
          <label>Verlängerung<select value={contractForm.renewal_type} onChange={event=>setContractForm({...contractForm,renewal_type:event.target.value})}><option value="manual">Manuell</option><option value="automatic">Automatisch</option><option value="none">Keine</option></select></label><label>Kündigungsfrist (Tage)<input type="number" min="0" value={contractForm.notice_period_days} onChange={event=>setContractForm({...contractForm,notice_period_days:event.target.value})}/></label>
          <label>Nächster Kündigungstermin<input type="date" value={contractForm.next_termination_date} onChange={event=>setContractForm({...contractForm,next_termination_date:event.target.value})}/></label><label>Vertragswert (€)<input type="number" min="0" step="0.01" value={contractForm.total_value} onChange={event=>setContractForm({...contractForm,total_value:event.target.value})}/></label>
          <label>Monatswert (€)<input type="number" min="0" step="0.01" value={contractForm.monthly_value} onChange={event=>setContractForm({...contractForm,monthly_value:event.target.value})}/></label><label>Leistungsumfang<input value={contractForm.scope} onChange={event=>setContractForm({...contractForm,scope:event.target.value})}/></label>
          <label className="span-2">SLA / Reaktionszeit<textarea value={contractForm.sla} onChange={event=>setContractForm({...contractForm,sla:event.target.value})}/></label><label className="span-2">Interne Vertragsnotiz<textarea value={contractForm.internal_notes} onChange={event=>setContractForm({...contractForm,internal_notes:event.target.value})}/></label>
        </div><button type="submit">Vertrag speichern</button></form>}
        {profile.contracts.map(contract=><article className="customer-contract-card" key={contract.id}><header><div><h3>{contract.contract_number} · {contract.contract_type}</h3><p>{contract.status} · {contract.starts_on} bis {contract.ends_on||'unbefristet'} · {contract.renewal_type==='automatic'?'automatische Verlängerung':contract.renewal_type==='none'?'keine Verlängerung':'manuelle Verlängerung'}</p></div>{hasPermission('contracts:write')&&<select aria-label={`Status ${contract.contract_number}`} value={contract.status} onChange={event=>void updateContract(contract,{status:event.target.value})}><option value="draft">Entwurf</option><option value="in_review">In Prüfung</option><option value="pending_approval">Freigabe ausstehend</option><option value="active">Aktiv</option><option value="paused">Pausiert</option><option value="termination_received">Kündigung eingegangen</option><option value="expiring">Läuft aus</option><option value="ended">Beendet</option><option value="archived">Archiviert</option></select>}</header>
          <p>Frist: {contract.notice_period_days??'–'} Tage · nächster Kündigungstermin: {contract.next_termination_date||'–'} · Wert: {contract.total_value===null?'–':`${contract.total_value} €`} · Monatlich: {contract.monthly_value===null?'–':`${contract.monthly_value} €`}</p>
          <p>Leistungsumfang: {contract.scope||'Nicht angegeben'} · SLA: {contract.sla||'Nicht angegeben'}</p>
          <div className="customer-contract-links"><div><strong>Objekte</strong><ul>{contract.sites.map(site=><li key={site.id}>{site.site_number||'–'} · {site.name}</li>)}</ul>{hasPermission('contracts:write')&&profile.sites.length>0&&<div className="customer-small-form"><select value={contractSite[contract.id]||''} onChange={event=>setContractSite({...contractSite,[contract.id]:event.target.value})}><option value="">Objekt verknüpfen</option>{profile.sites.filter(site=>!contract.sites.some(link=>link.id===site.site_id)).map(site=><option key={site.site_id} value={site.site_id}>{site.site_number||'–'} · {site.site_name}</option>)}</select><button type="button" onClick={()=>void addContractSite(contract)}>Zuordnen</button></div>}</div><div><strong>Sicherheitsleistungen</strong><ul>{contract.services.map(service=><li key={service.id}>{service.name} · {service.quantity} {service.unit||''} · {service.unit_price??'–'} €</li>)}</ul>{hasPermission('contracts:write')&&services.length>0&&<div className="customer-small-form"><select value={serviceForms[contract.id]?.service_id||''} onChange={event=>setServiceForms({...serviceForms,[contract.id]:{service_id:event.target.value,quantity:'1',unit_price:''}})}><option value="">Leistung verknüpfen</option>{services.map(service=><option key={service.id} value={service.id}>{service.name}{service.service_code?` · ${service.service_code}`:''}</option>)}</select><input aria-label="Leistungsmenge" type="number" min="0.001" step="0.001" value={serviceForms[contract.id]?.quantity||'1'} onChange={event=>setServiceForms({...serviceForms,[contract.id]:{service_id:serviceForms[contract.id]?.service_id||'',quantity:event.target.value,unit_price:serviceForms[contract.id]?.unit_price||''}})}/><button type="button" onClick={()=>void addContractService(contract)}>Zuordnen</button></div>}</div></div>
        </article>)}
        {profile.contracts.length===0&&<p className="employee-empty">Keine Kundenverträge hinterlegt.</p>}
        {hasPermission('contracts:write')&&<form className="customer-inline-form" onSubmit={createService}><h3>Leistungskatalog ergänzen</h3><label>Leistung<input required value={newService.name} onChange={event=>setNewService({...newService,name:event.target.value})}/></label><label>Code<input value={newService.service_code} onChange={event=>setNewService({...newService,service_code:event.target.value})}/></label><label>Einheit<input placeholder="z. B. Stunde" value={newService.unit} onChange={event=>setNewService({...newService,unit:event.target.value})}/></label><label>Preis (€)<input type="number" min="0" step="0.01" value={newService.default_unit_price} onChange={event=>setNewService({...newService,default_unit_price:event.target.value})}/></label><button>Leistung anlegen</button></form>}
        {!hasPermission('contracts:write')&&renderSimpleTable('Leistungskatalog',['Code','Leistung','Einheit','Preis'],services.map(service=>[service.service_code||'',service.name,service.unit||'',service.default_unit_price===null?'':`${service.default_unit_price} €`]))}
      </>}
      {active==='dokumente'&&<>
        <p className="customer-security-note">Kundendokumente sind vertraulich und benötigen zusätzlich zur DMS-Berechtigung die Berechtigung „Kundendokumente lesen/schreiben“. Jede Version wird vor Freigabe auf Schadsoftware geprüft.</p>
        {hasPermission('customer_documents:write')&&<form className="customer-inline-form" onSubmit={uploadDocument}><label>Titel<input required value={documentTitle} onChange={event=>setDocumentTitle(event.target.value)}/></label><label>Kategorie<select value={documentCategory} onChange={event=>setDocumentCategory(event.target.value)}><option value="contract">Vertrag</option><option value="service">Leistung / Leistungsnachweis</option><option value="insurance">Versicherung</option><option value="security_plan">Sicherheitskonzept</option><option value="correspondence">Korrespondenz</option><option value="other">Sonstiges</option></select></label><label>Objektbezug (optional)<select value={documentSite} onChange={event=>setDocumentSite(event.target.value)}><option value="">Kein bestimmtes Objekt</option>{profile.sites.map(site=><option key={site.id} value={site.id}>{site.site_number||'–'} · {site.site_name}</option>)}</select></label><label>Datei<input required type="file" onChange={(event:ChangeEvent<HTMLInputElement>)=>setFile(event.target.files?.[0]??null)}/></label><button type="submit">Sicher hochladen</button></form>}
        {profile.documents.length?profile.documents.map(document=><article className="customer-document-card" key={document.id}><strong>{document.title}</strong><span>{document.customer_document_category} · {new Date(document.created_at).toLocaleDateString('de-DE')}</span><ul>{document.versions.map(version=><li key={version.id}>Version {version.version_no} · {version.lifecycle_state} · {version.size_bytes} Bytes {version.lifecycle_state==='available'&&hasPermission('customer_documents:read')&&<button type="button" onClick={()=>void download(document,version)}>Herunterladen</button>}</li>)}</ul>{hasPermission('customer_documents:write')&&<div className="customer-version-form"><input aria-label={`Neue Version für ${document.title}`} type="file" onChange={(event:ChangeEvent<HTMLInputElement>)=>setVersionFiles({...versionFiles,[document.id]:event.target.files?.[0]??null})}/><button type="button" disabled={!versionFiles[document.id]} onClick={()=>void uploadDocumentVersion(document)}>Neue Version hochladen</button></div>}</article>):<p className="employee-empty">{hasPermission('customer_documents:read')?'Keine Kundendokumente abgelegt.':'Keine Berechtigung zum Anzeigen von Kundendokumenten.'}</p>}
      </>}
      {active==='aufgaben'&&<>
        {hasPermission('customers:write')&&<form className="customer-inline-form" onSubmit={createTask}><label>Aufgabe / Wiedervorlage<input required value={taskTitle} onChange={event=>setTaskTitle(event.target.value)}/></label><label>Fällig am<input type="datetime-local" value={taskDue} onChange={event=>setTaskDue(event.target.value)}/></label>{employees.length>0&&<label>Verantwortlich<select value={taskAssignee} onChange={event=>setTaskAssignee(event.target.value)}><option value="">Nicht zugewiesen</option>{employees.map(employee=><option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></label>}<button>Aufgabe anlegen</button></form>}
        {profile.tasks.length?profile.tasks.map(task=><article className="customer-task-card" key={task.id}><div><strong>{task.title}</strong><p>{task.description||''}</p><small>{task.due_at?new Date(task.due_at).toLocaleString('de-DE'):'Ohne Frist'} · {task.status}{task.assigned_employee_name?` · ${task.assigned_employee_name}`:''}</small></div>{task.status==='open'&&hasPermission('customers:write')&&<button type="button" onClick={()=>void setTaskStatus(task,'completed')}>Erledigt</button>}</article>):<p className="employee-empty">Keine offenen Aufgaben oder Wiedervorlagen.</p>}
      </>}
      {active==='verlauf'&&<article className="customer-history"><h3>Aktivitäten und Änderungen</h3>{profile.history.length?profile.history.map(event=><div key={event.id}><strong>{event.event_type.split('.').join(' · ')}</strong><p>{event.actor_email||'System'} · {new Date(event.created_at).toLocaleString('de-DE')}</p><small>{Object.entries(event.details||{}).map(([key,value])=>`${key}: ${String(value)}`).join(' · ')}</small></div>):<p className="employee-empty">Noch keine Aktivitäten.</p>}</article>}
    </div>
  </section>;
}

