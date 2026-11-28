import {ChangeEvent,FormEvent,useEffect,useState} from 'react';
import {Link,useNavigate,useParams,useSearchParams} from 'react-router-dom';
import {api,csrf,hasPermission} from '../lib/api';
import {berlinDateTimeToIso,berlinToday,formatCurrency,formatDate,formatDateTime,formatNumber,isoToBerlinDateTimeLocal} from '../lib/format';
import {priorityLabel,riskLabel,statusLabel} from '../lib/status';
import {auditEventLabel,commonText,historyDetailText} from '../lib/text';
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
type Task={id:string;title:string;description:string|null;due_at:string|null;status:string;priority:string;assigned_employee_id:string|null;assigned_employee_name:string|null};
type Document={id:string;title:string;description:string|null;customer_document_category:string;document_status:string;created_at:string;versions:{id:string;version_no:number;size_bytes:number;lifecycle_state:string}[]};
type Reminder={id:string;code:string;label:string;severity:'critical'|'warning';customer_id:string;customer_name:string;contract_id:string;contract_number:string;due_date:string|null;url:string};
type SectionKey='contacts'|'sites'|'contracts'|'documents'|'tasks'|'history';
type Profile={customer:Customer;contacts:Contact[];sites:Site[];contracts:Contract[];documents:Document[];tasks:Task[];history:{id:string;event_type:string;details:Record<string,string>;created_at:string;actor_email:string|null}[];operations:{assigned_employees:number;upcoming_shifts:number;open_incidents:number};reminders:Reminder[];visible_sections:Record<SectionKey,boolean>};
type TaskEdit={id:string;title:string;description:string;due_at:string;assigned_employee_id:string;priority:string;status:string};
type ContactForm={first_name:string;last_name:string;job_title:string;department:string;email:string;phone:string;mobile_phone:string;preferred_contact_method:string;notes:string;status:string;is_primary:boolean;is_decision_maker:boolean;is_security_contact:boolean;is_billing_contact:boolean;is_emergency_contact:boolean;site_ids:string[]};
const emptyContact:ContactForm={first_name:'',last_name:'',job_title:'',department:'',email:'',phone:'',mobile_phone:'',preferred_contact_method:'email',notes:'',status:'active',is_primary:false,is_decision_maker:false,is_security_contact:false,is_billing_contact:false,is_emergency_contact:false,site_ids:[]};
const tabs=[['uebersicht','Übersicht'],['stammdaten','Stammdaten'],['ansprechpartner','Ansprechpartner'],['objekte','Objekte & Einsätze'],['vertraege','Verträge & Leistungen'],['dokumente','Dokumente'],['aufgaben','Aufgaben'],['verlauf','Verlauf']] as const;
const sectionLabels:Record<SectionKey,string>={contacts:'Ansprechpartner',sites:'Objekte',contracts:'Verträge',documents:'Dokumente',tasks:'Aufgaben',history:'Verlauf'};
const emptyContract={contract_number:'',contract_type:'Objektschutz',scope:'',starts_on:berlinToday(),ends_on:'',renewal_type:'manual',notice_period_days:'',next_termination_date:'',status:'draft',total_value:'',monthly_value:'',billing_model:'fixed',sla:'',internal_notes:''};

function fileToBase64(file:File){
  return file.arrayBuffer().then(buffer=>{
    let binary='';const bytes=new Uint8Array(buffer);
    for(let index=0;index<bytes.length;index+=0x8000)binary+=String.fromCharCode(...bytes.subarray(index,index+0x8000));
    return btoa(binary);
  });
}

export function CustomerDetail(){
  const navigate=useNavigate();
  const [searchParams,setSearchParams]=useSearchParams();
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
  const [taskDescription,setTaskDescription]=useState('');
  const [taskDue,setTaskDue]=useState('');
  const [taskAssignee,setTaskAssignee]=useState('');
  const [taskPriority,setTaskPriority]=useState('normal');
  const [editingTask,setEditingTask]=useState<TaskEdit|null>(null);
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
    if(contactForm.is_primary)setProfile(current=>current?{...current,contacts:current.contacts.map(item=>item.id===editingContact?item:{...item,is_primary:false})}:current);
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
  const promoteContact=async(contact:Contact)=>{
    if(!customerId)return;
    setProfile(current=>current?{...current,contacts:current.contacts.map(item=>({...item,is_primary:item.id===contact.id}))}:current);
    try{
      await api(`/customers/${customerId}/contacts/${contact.id}`,{method:'PATCH',body:JSON.stringify({is_primary:true})});
      await load();
    }catch(cause){setError((cause as Error).message);await load();}
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
  const taskBody=(values:{title:string;description:string;due_at:string;assigned_employee_id:string;priority:string;status?:string})=>JSON.stringify({
    title:values.title,description:values.description||null,due_at:values.due_at?berlinDateTimeToIso(values.due_at):null,
    assigned_employee_id:values.assigned_employee_id||null,priority:values.priority,...(values.status?{status:values.status}:{}),
  });
  const createTask=async(event:FormEvent)=>{
    event.preventDefault();if(!customerId)return;
    try{
      await api(`/customers/${customerId}/tasks`,{method:'POST',body:taskBody({title:taskTitle,description:taskDescription,due_at:taskDue,assigned_employee_id:taskAssignee,priority:taskPriority})});
      setTaskTitle('');setTaskDescription('');setTaskDue('');setTaskAssignee('');setTaskPriority('normal');await load();
    }catch(e){setError((e as Error).message);}
  };
  const saveTask=async(event:FormEvent)=>{
    event.preventDefault();if(!customerId||!editingTask)return;
    try{await api(`/customers/${customerId}/tasks/${editingTask.id}`,{method:'PATCH',body:taskBody(editingTask)});setEditingTask(null);await load();}
    catch(e){setError((e as Error).message);}
  };
  const startTaskEdit=(task:Task)=>setEditingTask({
    id:task.id,title:task.title,description:task.description??'',due_at:isoToBerlinDateTimeLocal(task.due_at),
    assigned_employee_id:task.assigned_employee_id??'',priority:task.priority??'normal',status:task.status,
  });
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
      if(!response.ok)throw new Error((await response.json()).error||'Der Download konnte nicht abgeschlossen werden.');
      const url=URL.createObjectURL(await response.blob()),link=window.document.createElement('a');
      link.href=url;link.download=`${document.title}-v${version.version_no}`;link.click();URL.revokeObjectURL(url);
    }catch(e){setError((e as Error).message);}
  };
  if(loading&&!profile)return <section className="employee-detail-page customer-detail-page"><button className="employee-back" onClick={()=>navigate('/customers')}>Zurück zur Kundenübersicht</button><p>Kundenakte wird geladen …</p></section>;
  if(!profile)return <section className="employee-detail-page customer-detail-page"><button className="employee-back" onClick={()=>navigate('/customers')}>Zurück zur Kundenübersicht</button>{error&&<p role="alert" className="error">{error}</p>}<p>Kundenakte konnte nicht geladen werden.</p></section>;

  const customer=profile.customer;
  const profileForm=(field:keyof Customer,value:string)=>setForm(current=>current?({...current,[field]:value||null} as Customer):current);
  const selectContactSites=(event:ChangeEvent<HTMLSelectElement>)=>setContactForm({...contactForm,site_ids:Array.from(event.target.selectedOptions,item=>item.value)});
  const renderSimpleTable=(title:string,headers:string[],rows:string[][])=><article className="employee-detail-table"><h3>{title}</h3><table><thead><tr>{headers.map(header=><th key={header}>{header}</th>)}</tr></thead><tbody>{rows.map((row,index)=><tr key={index}>{row.map((value,column)=><td key={column}>{value||'–'}</td>)}</tr>)}</tbody></table>{rows.length===0&&<p className="employee-empty">Keine Daten erfasst.</p>}</article>;
  const visible=profile.visible_sections??{contacts:true,sites:true,contracts:true,documents:true,tasks:true,history:true};
  const canSee=(section:SectionKey)=>visible[section]!==false;
  const sectionDenied=(section:SectionKey)=><p className="employee-empty" role="status">{`Keine Berechtigung für ${sectionLabels[section]}.`}</p>;
  const displayDate=(value:string|null)=>formatDate(value);
  const renderReminders=(limit?:number)=>{
    const reminders=limit?profile.reminders.slice(0,limit):profile.reminders;
    return <article className="customer-reminder-list customer-cockpit-panel"><h3>Vertragsfristen & Erinnerungen</h3>
      <ul>{reminders.length?reminders.map(reminder=><li key={reminder.id} className={reminder.severity}>
        <span className="customer-reminder-severity">{reminder.severity==='critical'?'Kritisch':'Warnung'}</span>
        <Link to={reminder.url}><strong>{reminder.label}</strong></Link>
        <small>{reminder.contract_number} · Fällig {displayDate(reminder.due_date)}</small>
      </li>):<li className="employee-empty">Keine aktuellen Erinnerungen.</li>}</ul>
    </article>;
  };

  return <section className="employee-detail-page customer-detail-page">
    {error&&<p role="alert" className="error">{error}</p>}
    <div className="employee-detail-header">
      <button type="button" className="employee-back" onClick={()=>navigate('/customers')}>Zur Kundenübersicht</button>
      <div className="employee-detail-title"><div className="employee-avatar">{customer.name.slice(0,2).toUpperCase()}</div><div><h1>{customer.name}</h1><p>{customer.customer_number||'Keine Kundennummer'} · {customer.legal_form||customer.industry||'Unternehmensprofil'}</p></div><span className={`employee-status ${customer.customer_status}`}>{statusLabel(customer.customer_status,'customer')}</span></div>
      {hasPermission('customers:write')&&<button type="button" onClick={()=>navigate(`/customers/${customer.id}/stammdaten`)}>Stammdaten bearbeiten</button>}
    </div>
    {searchParams.get('site')&&<section className="object-record-focus" aria-label="Geöffnetes Objekt"><div><span className="object-record-focus-label">Verknüpftes Objekt</span>{profile.sites.find(site=>site.site_id===searchParams.get('site')||site.id===searchParams.get('site'))?<><h3>{profile.sites.find(site=>site.site_id===searchParams.get('site')||site.id===searchParams.get('site'))!.site_name}</h3><p>{profile.sites.find(site=>site.site_id===searchParams.get('site')||site.id===searchParams.get('site'))!.site_number||'Ohne Objektnummer'} · {statusLabel(profile.sites.find(site=>site.site_id===searchParams.get('site')||site.id===searchParams.get('site'))!.site_status,'site')}</p></>:<h3>Verknüpftes Objekt nicht mehr verfügbar</h3>}</div><button type="button" onClick={()=>{const next=new URLSearchParams(searchParams);next.delete('site');setSearchParams(next,{replace:true});}}>Fokus schließen</button></section>}
    <nav className="employee-tabs" aria-label="Kundenbereiche">{tabs.map(([key,label])=><button type="button" key={key} className={active===key?'active':''} onClick={()=>navigate(`/customers/${customer.id}/${key}`)}>{label}</button>)}</nav>
    <div className="employee-detail-content">
      {active==='uebersicht'&&<>
        {(hasPermission('customer_reports:read')||hasPermission('customer_reports:write')||hasPermission('customer_reports:approve')||hasPermission('customer_reports:export')||hasPermission('customer_portal:read'))&&<p><button type="button" onClick={()=>navigate(`/customer-reports?customer_id=${customer.id}`)}>Kundenberichte & Nachweise öffnen</button></p>}
        <div className="employee-detail-kpis">
          {canSee('sites')&&<article><strong>{formatNumber(profile.sites.length)}</strong><span>Objekte</span></article>}
          {canSee('contracts')&&<article><strong>{formatNumber(profile.contracts.filter(item=>item.status==='active').length)}</strong><span>Aktive Verträge</span></article>}
          {canSee('contacts')&&<article><strong>{formatNumber(profile.contacts.filter(item=>item.status==='active').length)}</strong><span>Ansprechpartner</span></article>}
          <article><strong>{formatNumber(profile.operations.assigned_employees)}</strong><span>Zugeordnetes Personal</span></article>
          <article><strong>{formatNumber(profile.operations.upcoming_shifts)}</strong><span>Kommende Schichten</span></article>
          <article><strong>{formatNumber(profile.operations.open_incidents)}</strong><span>Offene Einsätze</span></article>
          {canSee('tasks')&&<article><strong>{formatNumber(profile.tasks.filter(task=>task.status==='open').length)}</strong><span>Offene Aufgaben</span></article>}
          {canSee('tasks')&&<article><strong>{formatNumber(profile.tasks.filter(task=>task.status==='open'&&task.due_at&&Date.parse(task.due_at)<Date.now()).length)}</strong><span>Überfällige Aufgaben</span></article>}
        </div>
        {canSee('contracts')&&renderReminders(5)}
        <div className="employee-detail-grid">
          <article><h3>Unternehmen</h3><dl><dt>Status</dt><dd>{statusLabel(customer.customer_status,'customer')}</dd><dt>Branche</dt><dd>{customer.industry||'–'}</dd><dt>Priorität</dt><dd>{priorityLabel(customer.priority)}</dd><dt>Risikoklassifizierung</dt><dd>{riskLabel(customer.risk_classification)}</dd></dl></article>
          <article><h3>Kontakt & Anschrift</h3><p>{customer.email||customer.billing_email||'Keine E-Mail erfasst'}<br/>{customer.phone||'Kein Telefon erfasst'}</p><p>{[customer.address_line1,customer.address_line2,[customer.postal_code,customer.city].filter(Boolean).join(' '),customer.region,customer.country_code].filter(Boolean).join(', ')||'Keine Anschrift erfasst'}</p></article>
          <article><h3>Hauptansprechpartner</h3>{!canSee('contacts')?sectionDenied('contacts'):profile.contacts.find(item=>item.is_primary&&item.status==='active')?(()=>{const contact=profile.contacts.find(item=>item.is_primary&&item.status==='active')!;return <p><strong>{[contact.first_name,contact.last_name].filter(Boolean).join(' ')}</strong><br/>{contact.job_title||''}<br/>{contact.email||contact.phone||contact.mobile_phone||'Keine Kontaktdaten'}</p>;})():<p>Kein Hauptansprechpartner festgelegt.</p>}</article>
          <article><h3>Vertragsfristen</h3>{!canSee('contracts')?sectionDenied('contracts'):profile.contracts.filter(item=>item.ends_on&&item.status!=='ended'&&item.status!=='archived').length?profile.contracts.filter(item=>item.ends_on&&item.status!=='ended'&&item.status!=='archived').slice(0,4).map(contract=><p key={contract.id}><strong>{contract.contract_number}</strong><br/><small>Endet {formatDate(contract.ends_on)} · {statusLabel(contract.renewal_type,'customer')} Verlängerung</small></p>):<p>Keine auslaufenden Vertragsdaten.</p>}</article>
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
      {active==='stammdaten'&&!hasPermission('customers:write')&&<>
        <p className="employee-empty">Keine Schreibberechtigung für Kundenstammdaten.</p>
        <article className="employee-detail-table"><h3>Unternehmen</h3><dl>
          <dt>Kundennummer</dt><dd>{customer.customer_number||'–'}</dd>
          <dt>Status</dt><dd>{statusLabel(customer.customer_status,'customer')}</dd>
          <dt>Priorität</dt><dd>{priorityLabel(customer.priority)}</dd>
          <dt>Risikoklassifizierung</dt><dd>{riskLabel(customer.risk_classification)}</dd>
          <dt>Betreuer</dt><dd>{customer.account_manager_name||'–'}</dd>
          <dt>Branche</dt><dd>{customer.industry||'–'}</dd>
          <dt>Kontakt</dt><dd>{customer.email||customer.phone||'–'}</dd>
          <dt>Anschrift</dt><dd>{[customer.address_line1,customer.address_line2,[customer.postal_code,customer.city].filter(Boolean).join(' '),customer.region,customer.country_code].filter(Boolean).join(', ')||'–'}</dd>
          <dt>Interne Notizen</dt><dd>{customer.internal_notes||'–'}</dd>
        </dl></article>
      </>}
      {active==='ansprechpartner'&&(!canSee('contacts')?sectionDenied('contacts'):<>
        <article className="customer-contact-list"><h3>Ansprechpartner</h3>{profile.contacts.length?profile.contacts.map(contact=><div className="customer-contact-card" key={contact.id}><div><strong>{[contact.first_name,contact.last_name].filter(Boolean).join(' ')||contact.email||'Kontakt'}</strong>{contact.is_primary&&<span className="customer-primary">Hauptansprechpartner</span>}<p>{contact.job_title||contact.department||'Funktion nicht erfasst'} · {statusLabel(contact.status)}</p><p>{contact.email||'–'} · {contact.phone||contact.mobile_phone||'–'}</p><small>Rollen: {[contact.is_primary&&'Hauptansprechpartner',contact.is_decision_maker&&'Entscheider',contact.is_security_contact&&'Sicherheitskontakt',contact.is_billing_contact&&'Rechnungskontakt',contact.is_emergency_contact&&'Notfallkontakt'].filter(Boolean).join(' · ')||'Keine Zusatzrolle'}{contact.sites.length?` · Objekte: ${contact.sites.map(site=>site.site_number||site.name).join(', ')}`:''}</small></div>{hasPermission('customer_contacts:write')&&<div className="customer-contact-actions">{!contact.is_primary&&<button type="button" onClick={()=>void promoteContact(contact)}>Als Hauptansprechpartner setzen</button>}<button type="button" onClick={()=>editContact(contact)}>Bearbeiten</button></div>}</div>):<p className="employee-empty">Keine Ansprechpartner hinterlegt.</p>}</article>
        {hasPermission('customer_contacts:write')&&<form className="employee-detail-form customer-form" onSubmit={saveContact}><h3>{editingContact?'Ansprechpartner bearbeiten':'Ansprechpartner hinzufügen'}</h3><div className="form-grid">
          <label>Vorname<input value={contactForm.first_name} onChange={event=>setContactForm({...contactForm,first_name:event.target.value})}/></label><label>Nachname<input value={contactForm.last_name} onChange={event=>setContactForm({...contactForm,last_name:event.target.value})}/></label>
          <label>Funktion<input value={contactForm.job_title} onChange={event=>setContactForm({...contactForm,job_title:event.target.value})}/></label><label>Abteilung<input value={contactForm.department} onChange={event=>setContactForm({...contactForm,department:event.target.value})}/></label>
          <label>E-Mail<input type="email" value={contactForm.email} onChange={event=>setContactForm({...contactForm,email:event.target.value})}/></label><label>Telefon<input value={contactForm.phone} onChange={event=>setContactForm({...contactForm,phone:event.target.value})}/></label>
          <label>Mobil<input value={contactForm.mobile_phone} onChange={event=>setContactForm({...contactForm,mobile_phone:event.target.value})}/></label><label>Bevorzugter Kontakt<select value={contactForm.preferred_contact_method} onChange={event=>setContactForm({...contactForm,preferred_contact_method:event.target.value})}><option value="">Nicht festgelegt</option><option value="email">E-Mail</option><option value="phone">Telefon</option><option value="mobile">Mobil</option><option value="mail">Post</option></select></label>
          <label>Status<select value={contactForm.status} onChange={event=>setContactForm({...contactForm,status:event.target.value})}><option value="active">Aktiv</option><option value="inactive">Inaktiv</option><option value="archived">Archiviert</option></select></label><label>Objektzuordnung<select multiple value={contactForm.site_ids} onChange={selectContactSites}>{profile.sites.map(site=><option key={site.site_id} value={site.site_id}>{site.site_number||'–'} · {site.site_name}</option>)}</select></label>
          <label className="span-2">Notiz<textarea value={contactForm.notes} onChange={event=>setContactForm({...contactForm,notes:event.target.value})}/></label>
          <div className="customer-checkboxes"><label><input type="checkbox" checked={contactForm.is_primary} onChange={event=>setContactForm({...contactForm,is_primary:event.target.checked})}/> Hauptansprechpartner</label><label><input type="checkbox" checked={contactForm.is_security_contact} onChange={event=>setContactForm({...contactForm,is_security_contact:event.target.checked})}/> Sicherheitskontakt</label><label><input type="checkbox" checked={contactForm.is_billing_contact} onChange={event=>setContactForm({...contactForm,is_billing_contact:event.target.checked})}/> Rechnungskontakt</label><label><input type="checkbox" checked={contactForm.is_emergency_contact} onChange={event=>setContactForm({...contactForm,is_emergency_contact:event.target.checked})}/> Notfallkontakt</label><label><input type="checkbox" checked={contactForm.is_decision_maker} onChange={event=>setContactForm({...contactForm,is_decision_maker:event.target.checked})}/> Entscheider</label></div>
        </div><div><button type="submit">Speichern</button> {editingContact&&<button type="button" onClick={()=>{setEditingContact('');setContactForm(emptyContact);}}>Abbrechen</button>}</div></form>}
      </>)}
      {active==='objekte'&&(!canSee('sites')?sectionDenied('sites'):<>
        {hasPermission('customers:write')&&hasPermission('sites:read')&&<form className="customer-inline-form" onSubmit={linkSite}><label>Vorhandenes Objekt verknüpfen<select required value={siteId} onChange={event=>setSiteId(event.target.value)}><option value="">Objekt auswählen</option>{sites.filter(site=>!profile.sites.some(link=>link.site_id===site.id)).map(site=><option key={site.id} value={site.id}>{site.site_number||'–'} · {site.name}</option>)}</select></label><button type="submit">Objekt zuordnen</button></form>}
        <div className="customer-object-grid">{profile.sites.map(site=><article key={site.site_id} className={searchParams.get('site')===site.site_id||searchParams.get('site')===site.id?'object-record-highlight':''}><h3>{site.site_number||'Objekt'} · {site.site_name}</h3><p>{site.address||'Keine Anschrift'} · {statusLabel(site.site_status,'site')} · Sicherheitsstufe {riskLabel(site.security_classification)}</p><dl><dt>Personal zugeordnet</dt><dd>{formatNumber(site.assigned_employees)}</dd><dt>Kommende Schichten</dt><dd>{formatNumber(site.upcoming_shifts)}</dd><dt>Offene Einsätze</dt><dd>{formatNumber(site.open_incidents)}</dd><dt>Beziehung</dt><dd>{statusLabel(site.relationship_type,'customer')} · {statusLabel(site.relationship_status)}</dd></dl>{site.relationship_status==='active'&&hasPermission('customers:write')&&<button type="button" onClick={()=>void setSiteRelationshipStatus(site,'inactive')}>Beziehung beenden</button>}</article>)}</div>
        {profile.sites.length===0&&<p className="employee-empty">Noch keine Objekte mit diesem Kunden verknüpft.</p>}
      </>)}
      {active==='vertraege'&&(!canSee('contracts')?sectionDenied('contracts'):<>
        {canSee('contracts')&&renderReminders()}
        {hasPermission('contracts:write')&&<form className="employee-detail-form customer-form" onSubmit={createContract}><h3>Vertrag anlegen</h3><div className="form-grid">
          <label>Vertragsnummer<input required value={contractForm.contract_number} onChange={event=>setContractForm({...contractForm,contract_number:event.target.value})}/></label><label>Vertragsart<input required value={contractForm.contract_type} onChange={event=>setContractForm({...contractForm,contract_type:event.target.value})}/></label>
          <label>Status<select value={contractForm.status} onChange={event=>setContractForm({...contractForm,status:event.target.value})}><option value="draft">Entwurf</option><option value="in_review">In Prüfung</option><option value="pending_approval">Freigabe ausstehend</option><option value="active">Aktiv</option></select></label><label>Abrechnungsmodell<select value={contractForm.billing_model} onChange={event=>setContractForm({...contractForm,billing_model:event.target.value})}><option value="fixed">Pauschale</option><option value="hourly">Stundenbasiert</option><option value="usage_based">Nutzungsbasiert</option><option value="mixed">Gemischt</option></select></label>
          <label>Beginn<input required type="date" value={contractForm.starts_on} onChange={event=>setContractForm({...contractForm,starts_on:event.target.value})}/></label><label>Ende<input type="date" value={contractForm.ends_on} onChange={event=>setContractForm({...contractForm,ends_on:event.target.value})}/></label>
          <label>Verlängerung<select value={contractForm.renewal_type} onChange={event=>setContractForm({...contractForm,renewal_type:event.target.value})}><option value="manual">Manuell</option><option value="automatic">Automatisch</option><option value="none">Keine</option></select></label><label>Kündigungsfrist (Tage)<input type="number" min="0" value={contractForm.notice_period_days} onChange={event=>setContractForm({...contractForm,notice_period_days:event.target.value})}/></label>
          <label>Nächster Kündigungstermin<input type="date" value={contractForm.next_termination_date} onChange={event=>setContractForm({...contractForm,next_termination_date:event.target.value})}/></label><label>Vertragswert (€)<input type="number" min="0" step="0.01" value={contractForm.total_value} onChange={event=>setContractForm({...contractForm,total_value:event.target.value})}/></label>
          <label>Monatswert (€)<input type="number" min="0" step="0.01" value={contractForm.monthly_value} onChange={event=>setContractForm({...contractForm,monthly_value:event.target.value})}/></label><label>Leistungsumfang<input value={contractForm.scope} onChange={event=>setContractForm({...contractForm,scope:event.target.value})}/></label>
          <label className="span-2">SLA / Reaktionszeit<textarea value={contractForm.sla} onChange={event=>setContractForm({...contractForm,sla:event.target.value})}/></label><label className="span-2">Interne Vertragsnotiz<textarea value={contractForm.internal_notes} onChange={event=>setContractForm({...contractForm,internal_notes:event.target.value})}/></label>
        </div><button type="submit">Vertrag speichern</button></form>}
        {profile.contracts.map(contract=><article className="customer-contract-card" key={contract.id}><header><div><h3>{contract.contract_number} · {contract.contract_type}</h3><p>{statusLabel(contract.status)} · {formatDate(contract.starts_on)} bis {contract.ends_on?formatDate(contract.ends_on):'unbefristet'} · {contract.renewal_type==='automatic'?'automatische Verlängerung':contract.renewal_type==='none'?'keine Verlängerung':'manuelle Verlängerung'}</p></div>{hasPermission('contracts:write')&&<select aria-label={`Status ${contract.contract_number}`} value={contract.status} onChange={event=>void updateContract(contract,{status:event.target.value})}><option value="draft">Entwurf</option><option value="in_review">In Prüfung</option><option value="pending_approval">Freigabe ausstehend</option><option value="active">Aktiv</option><option value="paused">Pausiert</option><option value="termination_received">Kündigung eingegangen</option><option value="expiring">Läuft aus</option><option value="ended">Beendet</option><option value="archived">Archiviert</option></select>}</header>
          <p>Kündigungsfrist: {formatNumber(contract.notice_period_days)} Tage · nächster Kündigungstermin: {formatDate(contract.next_termination_date)} · Vertragswert: {formatCurrency(contract.total_value)} · Monatswert: {formatCurrency(contract.monthly_value)}</p>
          <p>Leistungsumfang: {contract.scope||'Nicht angegeben'} · SLA: {contract.sla||'Nicht angegeben'}</p>
          <div className="customer-contract-links"><div><strong>Objekte</strong><ul>{contract.sites.map(site=><li key={site.id}>{site.site_number||'–'} · {site.name}</li>)}</ul>{hasPermission('contracts:write')&&profile.sites.length>0&&<div className="customer-small-form"><select value={contractSite[contract.id]||''} onChange={event=>setContractSite({...contractSite,[contract.id]:event.target.value})}><option value="">Objekt verknüpfen</option>{profile.sites.filter(site=>!contract.sites.some(link=>link.id===site.site_id)).map(site=><option key={site.site_id} value={site.site_id}>{site.site_number||'–'} · {site.site_name}</option>)}</select><button type="button" onClick={()=>void addContractSite(contract)}>Zuordnen</button></div>}</div><div><strong>Sicherheitsleistungen</strong><ul>{contract.services.map(service=><li key={service.id}>{service.name} · {formatNumber(service.quantity)} {service.unit||''} · {formatCurrency(service.unit_price)}</li>)}</ul>{hasPermission('contracts:write')&&services.length>0&&<div className="customer-small-form"><select value={serviceForms[contract.id]?.service_id||''} onChange={event=>setServiceForms({...serviceForms,[contract.id]:{service_id:event.target.value,quantity:'1',unit_price:''}})}><option value="">Leistung verknüpfen</option>{services.map(service=><option key={service.id} value={service.id}>{service.name}{service.service_code?` · ${service.service_code}`:''}</option>)}</select><input aria-label="Leistungsmenge" type="number" min="0.001" step="0.001" value={serviceForms[contract.id]?.quantity||'1'} onChange={event=>setServiceForms({...serviceForms,[contract.id]:{service_id:serviceForms[contract.id]?.service_id||'',quantity:event.target.value,unit_price:serviceForms[contract.id]?.unit_price||''}})}/><button type="button" onClick={()=>void addContractService(contract)}>Zuordnen</button></div>}</div></div>
        </article>)}
        {profile.contracts.length===0&&<p className="employee-empty">Keine Kundenverträge hinterlegt.</p>}
        {hasPermission('contracts:write')&&<form className="customer-inline-form" onSubmit={createService}><h3>Leistungskatalog ergänzen</h3><label>Leistung<input required value={newService.name} onChange={event=>setNewService({...newService,name:event.target.value})}/></label><label>Code<input value={newService.service_code} onChange={event=>setNewService({...newService,service_code:event.target.value})}/></label><label>Einheit<input placeholder="z. B. Stunde" value={newService.unit} onChange={event=>setNewService({...newService,unit:event.target.value})}/></label><label>Preis (€)<input type="number" min="0" step="0.01" value={newService.default_unit_price} onChange={event=>setNewService({...newService,default_unit_price:event.target.value})}/></label><button>Leistung anlegen</button></form>}
        {!hasPermission('contracts:write')&&renderSimpleTable('Leistungskatalog',['Code','Leistung','Einheit','Preis'],services.map(service=>[service.service_code||'',service.name,service.unit||'',service.default_unit_price===null?'':formatCurrency(service.default_unit_price)]))}
      </>)}
      {active==='dokumente'&&(!canSee('documents')?sectionDenied('documents'):<>
        <p className="customer-security-note">Kundendokumente sind vertraulich und benötigen zusätzlich zur DMS-Berechtigung die Berechtigung „Kundendokumente lesen/schreiben“. Jede Fassung wird vor Freigabe auf Schadsoftware geprüft.</p>
        {hasPermission('customer_documents:write')&&<form className="customer-inline-form" onSubmit={uploadDocument}><label>Titel<input required value={documentTitle} onChange={event=>setDocumentTitle(event.target.value)}/></label><label>Kategorie<select value={documentCategory} onChange={event=>setDocumentCategory(event.target.value)}><option value="contract">Vertrag</option><option value="service">Leistung / Leistungsnachweis</option><option value="insurance">Versicherung</option><option value="security_plan">Sicherheitskonzept</option><option value="correspondence">Korrespondenz</option><option value="other">Sonstiges</option></select></label><label>Objektbezug (optional)<select value={documentSite} onChange={event=>setDocumentSite(event.target.value)}><option value="">Kein bestimmtes Objekt</option>{profile.sites.map(site=><option key={site.site_id} value={site.site_id}>{site.site_number||'–'} · {site.site_name}</option>)}</select></label><label>Datei<input required type="file" onChange={(event:ChangeEvent<HTMLInputElement>)=>setFile(event.target.files?.[0]??null)}/></label><button type="submit">Sicher hochladen</button></form>}
        {profile.documents.length?profile.documents.map(document=><article className="customer-document-card" key={document.id}><strong>{document.title}</strong><span>{statusLabel(document.customer_document_category,'documentCategory')} · {formatDate(document.created_at)}</span><ul>{document.versions.map(version=><li key={version.id}>Fassung {formatNumber(version.version_no)} · {statusLabel(version.lifecycle_state,'document')} · {formatNumber(version.size_bytes)} Byte {version.lifecycle_state==='available'&&hasPermission('customer_documents:read')&&<button type="button" onClick={()=>void download(document,version)}>{commonText.download}</button>}</li>)}</ul>{hasPermission('customer_documents:write')&&<div className="customer-version-form"><input aria-label={`Neue Fassung für ${document.title}`} type="file" onChange={(event:ChangeEvent<HTMLInputElement>)=>setVersionFiles({...versionFiles,[document.id]:event.target.files?.[0]??null})}/><button type="button" disabled={!versionFiles[document.id]} onClick={()=>void uploadDocumentVersion(document)}>Neue Fassung hochladen</button></div>}</article>):<p className="employee-empty">{hasPermission('customer_documents:read')?'Keine Kundendokumente abgelegt.':'Keine Berechtigung zum Anzeigen von Kundendokumenten.'}</p>}
      </>)}
      {active==='aufgaben'&&(!canSee('tasks')?sectionDenied('tasks'):<>
        {hasPermission('customer_tasks:write')&&<form className="customer-inline-form" onSubmit={createTask}><label>Aufgabe / Wiedervorlage<input required value={taskTitle} onChange={event=>setTaskTitle(event.target.value)}/></label><label>Beschreibung<input value={taskDescription} onChange={event=>setTaskDescription(event.target.value)}/></label><label>Fällig am<input type="datetime-local" value={taskDue} onChange={event=>setTaskDue(event.target.value)}/></label><label>Priorität<select value={taskPriority} onChange={event=>setTaskPriority(event.target.value)}><option value="low">Niedrig</option><option value="normal">Normal</option><option value="high">Hoch</option><option value="critical">Kritisch</option></select></label>{employees.length>0&&<label>Verantwortlich<select value={taskAssignee} onChange={event=>setTaskAssignee(event.target.value)}><option value="">Nicht zugewiesen</option>{employees.map(employee=><option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></label>}<button>Aufgabe anlegen</button></form>}
        {profile.tasks.length?profile.tasks.map(task=><article className="customer-task-card" key={task.id}><div><strong>{task.title}</strong><p>{task.description||''}</p><small>{task.due_at?formatDateTime(task.due_at):'Ohne Frist'} · {statusLabel(task.status,'task')} · Priorität: {priorityLabel(task.priority)}{task.assigned_employee_name?` · ${task.assigned_employee_name}`:''}</small></div>
          {hasPermission('customer_tasks:write')&&<div className="customer-task-actions">{task.status==='open'&&<button type="button" onClick={()=>void setTaskStatus(task,'completed')}>Erledigt</button>}<button type="button" onClick={()=>startTaskEdit(task)}>Bearbeiten</button></div>}
          {editingTask?.id===task.id&&<form className="customer-inline-form customer-task-edit" onSubmit={saveTask}>
            <label>Titel<input required value={editingTask.title} onChange={event=>setEditingTask({...editingTask,title:event.target.value})}/></label>
            <label>Beschreibung<input value={editingTask.description} onChange={event=>setEditingTask({...editingTask,description:event.target.value})}/></label>
            <label>Fällig am<input type="datetime-local" value={editingTask.due_at} onChange={event=>setEditingTask({...editingTask,due_at:event.target.value})}/></label>
            <label>Priorität<select value={editingTask.priority} onChange={event=>setEditingTask({...editingTask,priority:event.target.value})}><option value="low">Niedrig</option><option value="normal">Normal</option><option value="high">Hoch</option><option value="critical">Kritisch</option></select></label>
            <label>Status<select value={editingTask.status} onChange={event=>setEditingTask({...editingTask,status:event.target.value})}><option value="open">Offen</option><option value="completed">Erledigt</option><option value="cancelled">Abgebrochen</option></select></label>
            {employees.length>0&&<label>Verantwortlich<select value={editingTask.assigned_employee_id} onChange={event=>setEditingTask({...editingTask,assigned_employee_id:event.target.value})}><option value="">Nicht zugewiesen</option>{employees.map(employee=><option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></label>}
            <button type="submit">Aufgabe speichern</button><button type="button" onClick={()=>setEditingTask(null)}>Abbrechen</button>
          </form>}
        </article>):<p className="employee-empty">Keine offenen Aufgaben oder Wiedervorlagen.</p>}
      </>)}
      {active==='verlauf'&&(!canSee('history')?sectionDenied('history'):<article className="customer-history"><h3>Aktivitäten und Änderungen</h3>{profile.history.length?profile.history.map(event=><div key={event.id}><strong>{auditEventLabel(event.event_type)}</strong><p>{event.actor_email||'Automatisch erfasst'} · {formatDateTime(event.created_at)}</p><small>{Object.entries(event.details||{}).map(([key,value])=>historyDetailText(key,value)).join(' · ')}</small></div>):<p className="employee-empty">Noch keine Aktivitäten.</p>}</article>)}
    </div>
  </section>;
}

