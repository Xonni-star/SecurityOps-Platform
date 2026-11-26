import {FormEvent,ReactNode,useEffect,useState} from 'react';
import {api,storedUser} from '../lib/api';
import {uuid} from '../lib/uuid';

export type KeyRow={
  id:string;key_code:string;label:string;key_type:string;status:string;
  site_id:string|null;site_name:string|null;location:string|null;building:string|null;area:string|null;access_point:string|null;
  holder_user_id:string|null;holder_employee_id:string|null;holder_name:string|null;holder_personnel_number:string|null;holder_status:string|null;
  due_at:string|null;issued_at:string|null;returned_at:string|null;lost_at:string|null;deactivated_at:string|null;
  last_movement_at:string|null;last_movement_type:string|null;bundle_id:string|null;bundle_name:string|null;
  responsible_employee_id:string|null;responsible_name:string|null;created_at:string|null;
  display_status?:string|null;serial_number?:string|null;manufacturer?:string|null;description?:string|null;remarks?:string|null;
};
export type BundleRow={id:string;name:string;description?:string|null;site_id:string|null;site_name?:string|null;status:string;holder_user_id?:string|null;holder_employee_id?:string|null;holder_name?:string|null;item_count:number;issued_count:number;last_movement_at?:string|null;metrics?:Record<string,number>};
export type BundleDetail=BundleRow&{items:KeyRow[];history?:RecordedMovement[]};
export type Dashboard={total:number;available:number;issued:number;overdue:number;lost:number;blocked:number;deactivated:number;without_site:number;without_holder:number;partial_bundles:number;due_today:number;due_7_days:number;due_30_days:number;recent_movements:RecordedMovement[]};
export type ActionEntry={id:string;bucket:'A'|'B'|'C';code:string;label:string;key_id?:string|null;key_code?:string|null;site_id?:string|null;site_name?:string|null;subject_type:string;subject_id:string|null;due_at:string|null;url?:string|null;target?:string|null};
export type ActionList={A:ActionEntry[];B:ActionEntry[];C:ActionEntry[];generated_at:string};
export type EmployeeOption={id:string;name?:string|null;first_name?:string|null;last_name?:string|null;employee_number?:string|null;personnel_number?:string|null;department?:string|null;position?:string|null;email?:string|null;status?:string|null;employment_status?:string|null};
export type SiteOption={id:string;name:string;site_number?:string|null;site_status?:string|null;address?:string|null};
export type HolderInfo={holder_user_id?:string|null;holder_employee_id?:string|null;holder_name?:string|null;holder_personnel_number?:string|null;holder_status?:string|null;user_id?:string|null;employee_id?:string|null;name?:string|null;personnel_number?:string|null;status?:string|null};
export type HolderOption={value:string;label:string;kind:'employee'|'user'};
export type RecordedMovement={id:string;key_id?:string|null;key_code?:string|null;key_label?:string|null;movement_type:string;from_status?:string|null;to_status?:string|null;previous_status?:string|null;new_status?:string|null;actor_name?:string|null;holder_name?:string|null;holder_user_name?:string|null;holder_employee_name?:string|null;site_name?:string|null;reason?:string|null;incident_id?:string|null;receipt_id?:string|null;reference?:string|null;created_at:string};
export type LossReport={id:string;status?:string|null;lost_at?:string|null;reported_at?:string|null;reporter_name?:string|null;description?:string|null;risk_assessment?:string|null;immediate_measures?:string|null;follow_up?:string|null;notes?:string|null;incident_id?:string|null};
export type DocumentOption={id:string;title:string;site_id:string|null};
export type IncidentOption={id:string;description:string;status?:string|null;priority_name?:string|null};
export type PriorityOption={id:string;name?:string|null;code?:string|null;rank?:number|null};
export type InventoryCheck={id:string;checked_at?:string|null;checker_name?:string|null;site_name?:string|null;notes?:string|null;items?:InventoryItem[];results?:InventoryItem[]};
export type InventoryItem={key_id:string;expected_present:boolean;found?:boolean|null;actual_condition?:string|null};
export type KeyProfile={key:KeyRow;holder:HolderInfo|null;site:SiteOption|null;bundle:BundleRow|null;recent_movements:RecordedMovement[];loss_reports:LossReport[];inventory_checks:InventoryCheck[];reminder_state?:Record<string,unknown>|null;visible_sections?:string[]|Record<string,boolean>|null};

export const statusLabels:Record<string,string>={available:'Verfügbar',issued:'Ausgegeben',overdue:'Überfällig',lost:'Verloren',blocked:'Gesperrt',deactivated:'Deaktiviert',partial:'Teilweise ausgegeben'};
export const keyTypeLabels:Record<string,string>={physical:'Physisch',master:'Hauptschlüssel',transponder:'Transponder',access_card:'Zutrittskarte',electronic:'Elektronisch',digital:'Digital',other:'Sonstiges'};
export const conditionLabels:Record<string,string>={good:'Gut',damaged:'Beschädigt',incomplete:'Unvollständig',nonfunctional:'Funktionslos',suspicious_change:'Verdächtige Veränderung'};
export const movementLabels:Record<string,string>={created:'Angelegt',issued:'Ausgegeben',returned:'Zurückgegeben',reported_lost:'Verlust gemeldet',lost:'Verloren',blocked:'Gesperrt',reactivated:'Reaktiviert',updated:'Geändert',inventory_check:'Bestandskontrolle',bundle_issued:'Bund ausgegeben',bundle_returned:'Bund zurückgegeben'};
export const lossStatusLabels:Record<string,string>={reported:'Gemeldet',review:'In Prüfung',security_measure_required:'Sicherheitsmaßnahme erforderlich',replacement_required:'Ersatz erforderlich',closed:'Abgeschlossen'};

export const displayDate=(value:string|null|undefined)=>value?new Date(value.length<=10?`${value}T00:00:00`:value).toLocaleDateString('de-DE'):'–';
export const displayDateTime=(value:string|null|undefined)=>value?new Date(value).toLocaleString('de-DE'):'–';
export const toDateTimeLocal=(value:string)=>{
  const date=new Date(value);
  if(Number.isNaN(date.getTime()))return '';
  return new Date(date.getTime()-date.getTimezoneOffset()*60_000).toISOString().slice(0,16);
};
export const toIso=(value:string)=>value?new Date(value).toISOString():'';
export const withMutation=(body:Record<string,unknown>)=>({...body,client_mutation_id:uuid()});
export const siteLabel=(site:{id?:string;name?:string|null;site_number?:string|null}|null|undefined)=>site?[site.site_number,site.name].filter(Boolean).join(' · ')||'–':'–';
export const employeeStatus=(employee:EmployeeOption)=>employee.employment_status??employee.status??null;
export const employeeLabel=(employee:EmployeeOption)=>{
  const name=[employee.first_name,employee.last_name].filter(Boolean).join(' ')||employee.name||employee.email||'Mitarbeiter';
  const number=employee.employee_number??employee.personnel_number;
  const status=employeeStatus(employee);
  return `${name}${number?` (${number})`:''}${employee.department?` · ${employee.department}`:''}${status&&status!=='active'?` · ${status}`:''}`;
};
export const holderName=(holder:HolderInfo|null|undefined)=>holder?.holder_name??holder?.name??holder?.holder_personnel_number??holder?.personnel_number??'–';
export const holderUserId=(holder:HolderInfo|null|undefined)=>holder?.holder_user_id??holder?.user_id??null;
export const holderEmployeeId=(holder:HolderInfo|null|undefined)=>holder?.holder_employee_id??holder?.employee_id??null;

export function selfUser(){
  try{
    return typeof storedUser==='function'?storedUser():null;
  }catch{return null;}
}

export function holderOptions(employees:EmployeeOption[],current?:HolderInfo|null):HolderOption[]{
  const options:HolderOption[]=[];
  const self=selfUser();
  if(self?.id)options.push({value:`user:${self.id}`,label:`Mich selbst${self.email?` (${self.email})`:''}`,kind:'user'});
  const currentEmployee=holderEmployeeId(current);
  for(const employee of employees??[]){
    const isCurrent=!!currentEmployee&&employee.id===currentEmployee;
    const status=employeeStatus(employee);
    const allowed=isCurrent||!status||status==='active'||status==='probation';
    if(!allowed)continue;
    options.push({value:employee.id,label:employeeLabel(employee),kind:'employee'});
  }
  const currentUser=holderUserId(current);
  if(currentUser&&!options.some(option=>option.value===`user:${currentUser}`)){
    options.push({value:`user:${currentUser}`,label:`${holderName(current)} (Benutzerkonto)`,kind:'user'});
  }
  if(currentEmployee&&!options.some(option=>option.value===currentEmployee)){
    options.push({value:currentEmployee,label:`${holderName(current)} (ehemaliger Halter)`,kind:'employee'});
  }
  return options;
}

export function holderBody(value:string){
  if(value.startsWith('user:'))return {holder_user_id:value.slice(5)||null,holder_employee_id:null};
  return {holder_user_id:null,holder_employee_id:value||null};
}
export function lastHolderBody(value:string){
  const holder=holderBody(value);
  return {last_holder_user_id:holder.holder_user_id,last_holder_employee_id:holder.holder_employee_id};
}

export function StatusBadge({status}:{status:string}){
  return <span className={`key-status key-status-${status}`}>{statusLabels[status]||status}</span>;
}

export function EmployeePicker({label,value,onChange,employees,current,required=false}:{label:string;value:string;onChange:(value:string)=>void;employees:EmployeeOption[];current?:HolderInfo|null;required?:boolean}){
  const options=holderOptions(employees,current);
  return <label>{label}<select aria-label={label} value={value} required={required} onChange={event=>onChange(event.target.value)}>
    <option value="">{required?'Bitte auswählen':'Keine Zuweisung'}</option>
    {options.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}
  </select></label>;
}

export function SitePicker({label,value,onChange,sites,required=false}:{label:string;value:string;onChange:(value:string)=>void;sites:SiteOption[];required?:boolean}){
  return <label>{label}<select aria-label={label} value={value} required={required} onChange={event=>onChange(event.target.value)}>
    <option value="">{required?'Bitte auswählen':'Kein Objekt'}</option>
    {sites.map(site=><option key={site.id} value={site.id}>{siteLabel(site)}</option>)}
  </select></label>;
}

export function KeyPicker({label,value,onChange,keys,required=false}:{label:string;value:string;onChange:(value:string)=>void;keys:KeyRow[];required?:boolean}){
  return <label>{label}<select aria-label={label} value={value} required={required} onChange={event=>onChange(event.target.value)}>
    <option value="">{required?'Bitte auswählen':'Schlüssel auswählen'}</option>
    {keys.map(key=><option key={key.id} value={key.id}>{`${key.key_code} · ${key.label}`}</option>)}
  </select></label>;
}

export function BundlePicker({label,value,onChange,bundles,required=false}:{label:string;value:string;onChange:(value:string)=>void;bundles:BundleRow[];required?:boolean}){
  return <label>{label}<select aria-label={label} value={value} required={required} onChange={event=>onChange(event.target.value)}>
    <option value="">{required?'Bitte auswählen':'Kein Bund'}</option>
    {bundles.map(bundle=><option key={bundle.id} value={bundle.id}>{bundle.name}</option>)}
  </select></label>;
}

export function Dialog({title,onClose,children,wide=false}:{title:string;onClose:()=>void;children:ReactNode;wide?:boolean}){
  return <div className="key-dialog-backdrop"><section className={wide?'key-dialog wide':'key-dialog'} role="dialog" aria-modal="true" aria-label={title}>
    <header><h2>{title}</h2><button type="button" aria-label="Dialog schließen" onClick={onClose}>×</button></header>
    <div className="key-dialog-body">{children}</div>
  </section></div>;
}

export function ActionContext({item}:{item:KeyRow|BundleRow}){
  const site='site_name' in item?item.site_name:null;
  const holder=item.holder_name;
  return <p className="key-dialog-context"><span>Objekt: <strong>{site||'Kein Objekt zugeordnet'}</strong></span><span>Aktueller Halter: <strong>{holder||'Kein Halter'}</strong></span></p>;
}

async function send(path:string,method:'POST'|'PATCH'|'DELETE',body:Record<string,unknown>,onDone:()=>void,setError:(message:string)=>void){
  try{
    await api(path,{method,body:JSON.stringify(withMutation(body))});
    setError('');onDone();
  }catch(cause){setError((cause as Error).message);}
}

export function CreateKeyDialog({sites,employees,onClose,onDone}:{sites:SiteOption[];employees:EmployeeOption[];onClose:()=>void;onDone:()=>void}){
  const [form,setForm]=useState({key_code:'',label:'',key_type:'physical',site_id:'',responsible_employee_id:'',serial_number:'',manufacturer:'',location:'',building:'',area:'',access_point:'',description:'',remarks:''});
  const [error,setError]=useState('');
  const update=(field:keyof typeof form,value:string)=>setForm(current=>({...current,[field]:value}));
  const submit=(event:FormEvent)=>{
    event.preventDefault();
    if(!form.key_code.trim()||!form.label.trim())return;
    void send('/keys','POST',{
      key_code:form.key_code.trim(),label:form.label.trim(),key_type:form.key_type,
      site_id:form.site_id||null,responsible_employee_id:form.responsible_employee_id||null,
      serial_number:form.serial_number||null,manufacturer:form.manufacturer||null,location:form.location||null,
      building:form.building||null,area:form.area||null,access_point:form.access_point||null,
      description:form.description||null,remarks:form.remarks||null,
    },onDone,setError);
  };
  return <Dialog title="Schlüssel anlegen" onClose={onClose} wide><form className="key-dialog-form" onSubmit={submit}>
    {error&&<p role="alert" className="error">{error}</p>}
    <label>Kennziffer<input required maxLength={80} value={form.key_code} onChange={event=>update('key_code',event.target.value)}/></label>
    <label>Bezeichnung<input required maxLength={240} value={form.label} onChange={event=>update('label',event.target.value)}/></label>
    <label>Schlüsseltyp<select value={form.key_type} onChange={event=>update('key_type',event.target.value)}>{Object.entries(keyTypeLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
    <SitePicker label="Objekt" value={form.site_id} onChange={value=>update('site_id',value)} sites={sites}/>
    <EmployeePicker label="Verantwortliche Person" value={form.responsible_employee_id} onChange={value=>update('responsible_employee_id',value)} employees={employees}/>
    <label>Seriennummer<input value={form.serial_number} onChange={event=>update('serial_number',event.target.value)}/></label>
    <label>Hersteller<input value={form.manufacturer} onChange={event=>update('manufacturer',event.target.value)}/></label>
    <label>Standort / Ort<input value={form.location} onChange={event=>update('location',event.target.value)}/></label>
    <label>Gebäude<input value={form.building} onChange={event=>update('building',event.target.value)}/></label>
    <label>Bereich<input value={form.area} onChange={event=>update('area',event.target.value)}/></label>
    <label>Zugangspunkt<input value={form.access_point} onChange={event=>update('access_point',event.target.value)}/></label>
    <label className="span-2">Beschreibung<textarea value={form.description} onChange={event=>update('description',event.target.value)}/></label>
    <label className="span-2">Bemerkungen<textarea value={form.remarks} onChange={event=>update('remarks',event.target.value)}/></label>
    <div className="key-dialog-actions"><button type="button" onClick={onClose}>Abbrechen</button><button type="submit" disabled={!form.key_code.trim()||!form.label.trim()}>Schlüssel anlegen</button></div>
  </form></Dialog>;
}

export function IssueDialog({item,employees,documents=[],onClose,onDone}:{item:KeyRow;employees:EmployeeOption[];documents?:DocumentOption[];onClose:()=>void;onDone:()=>void}){
  const [holder,setHolder]=useState('');const [dueAt,setDueAt]=useState('');const [reason,setReason]=useState('');const [notes,setNotes]=useState('');const [confirmation,setConfirmation]=useState('');const [receiptDocumentId,setReceiptDocumentId]=useState('');const [error,setError]=useState('');
  const valid=!!holder&&!!dueAt&&!!reason.trim()&&!!confirmation.trim();
  const receiptDocuments=documents.filter(document=>document.site_id===(item.site_id??null));
  const submit=(event:FormEvent)=>{
    event.preventDefault();if(!valid)return;
    void send(`/keys/${item.id}/issue`,'POST',{
      ...holderBody(holder),due_at:toIso(dueAt),reason:reason.trim(),handover_notes:notes||null,
      confirmation_name:confirmation.trim(),receipt_document_id:receiptDocumentId||null,
    },onDone,setError);
  };
  return <Dialog title={`Schlüssel ausgeben · ${item.key_code}`} onClose={onClose}><form className="key-dialog-form" onSubmit={submit}>
    <ActionContext item={item}/>
    {error&&<p role="alert" className="error">{error}</p>}
    <EmployeePicker label="Schlüsselhalter" value={holder} onChange={setHolder} employees={employees} current={item} required/>
    <label>Fällig am<input required type="datetime-local" value={dueAt} onChange={event=>setDueAt(event.target.value)}/></label>
    <label className="span-2">Grund<textarea required value={reason} onChange={event=>setReason(event.target.value)}/></label>
    <label className="span-2">Übergabenotizen<textarea value={notes} onChange={event=>setNotes(event.target.value)}/></label>
    <label className="span-2">Bestätigungsname<input required value={confirmation} onChange={event=>setConfirmation(event.target.value)}/></label>
    <label>Übergabeprotokoll (DMS)<select aria-label="Übergabeprotokoll (DMS)" value={receiptDocumentId} onChange={event=>setReceiptDocumentId(event.target.value)}>
      <option value="">Kein Beleg</option>
      {receiptDocuments.map(document=><option key={document.id} value={document.id}>{document.title}</option>)}
    </select></label>
    <div className="key-dialog-actions"><button type="button" onClick={onClose}>Abbrechen</button><button type="submit" disabled={!valid}>Schlüssel ausgeben</button></div>
  </form></Dialog>;
}

export function ReturnDialog({item,documents=[],onClose,onDone}:{item:KeyRow;documents?:DocumentOption[];onClose:()=>void;onDone:()=>void}){
  const [condition,setCondition]=useState('good');const [notes,setNotes]=useState('');const [reason,setReason]=useState('');const [receiptDocumentId,setReceiptDocumentId]=useState('');const [error,setError]=useState('');
  const valid=!!reason.trim();
  const receiptDocuments=documents.filter(document=>document.site_id===(item.site_id??null));
  const submit=(event:FormEvent)=>{
    event.preventDefault();if(!valid)return;
    void send(`/keys/${item.id}/return`,'POST',{condition,notes:notes||null,reason:reason.trim(),receipt_document_id:receiptDocumentId||null},onDone,setError);
  };
  return <Dialog title={`Rückgabe erfassen · ${item.key_code}`} onClose={onClose}><form className="key-dialog-form" onSubmit={submit}>
    <ActionContext item={item}/>
    {error&&<p role="alert" className="error">{error}</p>}
    <label>Zustand<select value={condition} onChange={event=>setCondition(event.target.value)}>{Object.entries(conditionLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
    <label className="span-2">Grund<textarea required value={reason} onChange={event=>setReason(event.target.value)}/></label>
    <label className="span-2">Notizen<textarea value={notes} onChange={event=>setNotes(event.target.value)}/></label>
    <label>Rückgabebeleg (DMS)<select aria-label="Rückgabebeleg (DMS)" value={receiptDocumentId} onChange={event=>setReceiptDocumentId(event.target.value)}>
      <option value="">Kein Beleg</option>
      {receiptDocuments.map(document=><option key={document.id} value={document.id}>{document.title}</option>)}
    </select></label>
    <div className="key-dialog-actions"><button type="button" onClick={onClose}>Abbrechen</button><button type="submit" disabled={!valid}>Rückgabe bestätigen</button></div>
  </form></Dialog>;
}

export function LossDialog({item,employees,sites,incidents=[],priorities=[],onClose,onDone}:{item:KeyRow;employees:EmployeeOption[];sites:SiteOption[];incidents?:IncidentOption[];priorities?:PriorityOption[];onClose:()=>void;onDone:()=>void}){
  const [lastHolder,setLastHolder]=useState(item.holder_employee_id?item.holder_employee_id:item.holder_user_id?`user:${item.holder_user_id}`:'');
  const [siteId,setSiteId]=useState(item.site_id||'');
  const [lostAt,setLostAt]=useState(toDateTimeLocal(new Date().toISOString()));
  const [reportedAt,setReportedAt]=useState(toDateTimeLocal(new Date().toISOString()));
  const [reporter,setReporter]=useState('');const [description,setDescription]=useState('');const [risk,setRisk]=useState('');
  const [measures,setMeasures]=useState('');const [followUp,setFollowUp]=useState('');const [status,setStatus]=useState('reported');
  const [incidentMode,setIncidentMode]=useState<'none'|'existing'|'new'>('none');const [incidentId,setIncidentId]=useState('');const [priorityId,setPriorityId]=useState('');
  const [error,setError]=useState('');
  const incidentValid=incidentMode==='none'||(incidentMode==='existing'&&!!incidentId)||(incidentMode==='new'&&!!priorityId);
  const valid=!!lostAt&&!!reportedAt&&!!reporter.trim()&&!!description.trim()&&incidentValid;
  const submit=(event:FormEvent)=>{
    event.preventDefault();if(!valid)return;
    void send(`/keys/${item.id}/report-loss`,'POST',{
      ...lastHolderBody(lastHolder),site_id:siteId||null,lost_at:toIso(lostAt),reported_at:toIso(reportedAt),
      reporter_name:reporter.trim(),description:description.trim(),risk_assessment:risk||null,
      immediate_measures:measures||null,follow_up:followUp||null,status,
      incident_id:incidentMode==='existing'?incidentId:null,
      create_incident:incidentMode==='new',
      incident_priority_id:incidentMode==='new'?priorityId:null,
    },onDone,setError);
  };
  return <Dialog title={`Verlust melden · ${item.key_code}`} onClose={onClose} wide><form className="key-dialog-form" onSubmit={submit}>
    <ActionContext item={item}/>
    {error&&<p role="alert" className="error">{error}</p>}
    <EmployeePicker label="Letzter Halter" value={lastHolder} onChange={setLastHolder} employees={employees} current={item}/>
    <SitePicker label="Objekt" value={siteId} onChange={setSiteId} sites={sites}/>
    <label>Verlustzeitpunkt<input required type="datetime-local" value={lostAt} onChange={event=>setLostAt(event.target.value)}/></label>
    <label>Gemeldet am<input required type="datetime-local" value={reportedAt} onChange={event=>setReportedAt(event.target.value)}/></label>
    <label>Melder<input required value={reporter} onChange={event=>setReporter(event.target.value)}/></label>
    <label>Status<select value={status} onChange={event=>setStatus(event.target.value)}>{Object.entries(lossStatusLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
    <label>Vorfallverknüpfung<select aria-label="Vorfallverknüpfung" value={incidentMode} onChange={event=>{setIncidentMode(event.target.value as 'none'|'existing'|'new');setIncidentId('');setPriorityId('');}}>
      <option value="none">Keine Verknüpfung</option>
      {incidents.length>0&&<option value="existing">Bestehenden Vorfall verknüpfen</option>}
      {priorities.length>0&&<option value="new">Neuen Vorfall anlegen</option>}
    </select></label>
    {incidentMode==='existing'&&<label>Bestehender Vorfall<select aria-label="Bestehender Vorfall" required value={incidentId} onChange={event=>setIncidentId(event.target.value)}>
      <option value="">Bitte auswählen</option>
      {incidents.map(incident=><option key={incident.id} value={incident.id}>{incident.description}{incident.priority_name?` · ${incident.priority_name}`:''}</option>)}
    </select></label>}
    {incidentMode==='new'&&<label>Vorfallpriorität<select aria-label="Vorfallpriorität" required value={priorityId} onChange={event=>setPriorityId(event.target.value)}>
      <option value="">Bitte auswählen</option>
      {priorities.map(priority=><option key={priority.id} value={priority.id}>{priority.name??priority.code??'Priorität'}</option>)}
    </select></label>}
    <label className="span-2">Beschreibung<textarea required value={description} onChange={event=>setDescription(event.target.value)}/></label>
    <label className="span-2">Risikobewertung<textarea value={risk} onChange={event=>setRisk(event.target.value)}/></label>
    <label className="span-2">Sofortmaßnahmen<textarea value={measures} onChange={event=>setMeasures(event.target.value)}/></label>
    <label className="span-2">Folge Maßnahmen<textarea value={followUp} onChange={event=>setFollowUp(event.target.value)}/></label>
    <div className="key-dialog-actions"><button type="button" onClick={onClose}>Abbrechen</button><button type="submit" disabled={!valid}>Verlust melden</button></div>
  </form></Dialog>;
}

export function BlockDialog({item,action,onClose,onDone}:{item:KeyRow;action:'block'|'reactivate';onClose:()=>void;onDone:()=>void}){
  const [reason,setReason]=useState('');const [measures,setMeasures]=useState('');const [error,setError]=useState('');
  const valid=!!reason.trim();
  const submit=(event:FormEvent)=>{
    event.preventDefault();if(!valid)return;
    if(!window.confirm(`${action==='block'?'Sperre':'Reaktivierung'} für ${item.key_code} wirklich ausführen?`))return;
    void send(`/keys/${item.id}/${action}`,'POST',{reason:reason.trim(),immediate_measures:measures||null},onDone,setError);
  };
  return <Dialog title={action==='block'?`Schlüssel sperren · ${item.key_code}`:`Schlüssel reaktivieren · ${item.key_code}`} onClose={onClose}><form className="key-dialog-form" onSubmit={submit}>
    <ActionContext item={item}/>
    {error&&<p role="alert" className="error">{error}</p>}
    <label className="span-2">Grund<textarea required value={reason} onChange={event=>setReason(event.target.value)}/></label>
    {action==='block'&&<label className="span-2">Sofortmaßnahmen<textarea value={measures} onChange={event=>setMeasures(event.target.value)}/></label>}
    <div className="key-dialog-actions"><button type="button" onClick={onClose}>Abbrechen</button><button type="submit" disabled={!valid}>{action==='block'?'Sperre bestätigen':'Reaktivierung bestätigen'}</button></div>
  </form></Dialog>;
}

export function QrCodeView({keyId,label}:{keyId:string;label:string}){
  const [qr,setQr]=useState('');const [expires,setExpires]=useState('');const [error,setError]=useState('');
  useEffect(()=>{
    let cancelled=false;
    void (async()=>{
      try{
        const data=await api<{token:string;url:string;expires_at:string|null}>(`/keys/${keyId}/qr`);
        if(!data?.url)throw new Error('QR-Code konnte nicht geladen werden.');
        const source=await import('qrcode').then(({toDataURL})=>toDataURL(data.url,{width:220,margin:1,errorCorrectionLevel:'M'}));
        if(!cancelled){setQr(source);setExpires(data.expires_at??'');setError('');}
      }catch(cause){if(!cancelled)setError((cause as Error).message);}
    })();
    return ()=>{cancelled=true;};
  },[keyId]);
  return <div className="key-qr-panel">
    {qr?<img src={qr} alt={`QR-Code für ${label}`}/>:<p role="status" className="employee-empty">{error||'QR-Code wird geladen …'}</p>}
    <p className="key-qr-meta">Gültig bis {displayDateTime(expires)} · Der Token wird nicht angezeigt.</p>
    <button type="button" onClick={()=>window.print()}>Etikett drucken</button>
  </div>;
}

export function QrDialog({item,onClose}:{item:KeyRow;onClose:()=>void}){
  return <Dialog title={`QR-Code & Etikett · ${item.key_code}`} onClose={onClose}><div className="key-dialog-form">
    <QrCodeView keyId={item.id} label={`${item.key_code} ${item.label}`}/>
    <div className="key-dialog-actions"><button type="button" onClick={onClose}>Schließen</button></div>
  </div></Dialog>;
}

export function InventoryDialog({keys,sites,bundles,onClose,onDone}:{keys:KeyRow[];sites:SiteOption[];bundles:BundleRow[];onClose:()=>void;onDone:()=>void}){
  const [siteId,setSiteId]=useState('');const [bundleId,setBundleId]=useState('');const [checkedAt,setCheckedAt]=useState(toDateTimeLocal(new Date().toISOString()));
  const [checker,setChecker]=useState('');const [notes,setNotes]=useState('');const [error,setError]=useState('');
  const [results,setResults]=useState<Record<string,{expected_present:boolean;actual_condition:string}>>(()=>Object.fromEntries(keys.map(key=>[key.id,{expected_present:true,actual_condition:'good'}])));
  const scopedKeys=bundleId?keys.filter(key=>key.bundle_id===bundleId):siteId?keys.filter(key=>key.site_id===siteId):keys;
  const valid=!!checkedAt&&!!checker.trim()&&scopedKeys.length>0;
  const submit=(event:FormEvent)=>{
    event.preventDefault();if(!valid)return;
    void send('/keys/inventory-checks','POST',{
      site_id:siteId||null,bundle_id:bundleId||null,checked_at:toIso(checkedAt),checker_name:checker.trim(),
      results:scopedKeys.map(key=>{
        const entry=results[key.id];
        return {key_id:key.id,expected_present:entry?.expected_present??false,actual_condition:entry?.expected_present?entry.actual_condition??null:null};
      }),
      notes:notes||null,
    },onDone,setError);
  };
  return <Dialog title="Bestandskontrolle erfassen" onClose={onClose} wide><form className="key-dialog-form" onSubmit={submit}>
    {error&&<p role="alert" className="error">{error}</p>}
    <SitePicker label="Objekt" value={siteId} onChange={setSiteId} sites={sites}/>
    <BundlePicker label="Schlüsselbund" value={bundleId} onChange={setBundleId} bundles={bundles}/>
    <label>Prüfzeitpunkt<input required type="datetime-local" value={checkedAt} onChange={event=>setCheckedAt(event.target.value)}/></label>
    <label>Prüfer<input required value={checker} onChange={event=>setChecker(event.target.value)}/></label>
    <div className="span-2 key-inventory-results">{scopedKeys.length?scopedKeys.map(key=><div key={key.id} className="key-inventory-row">
      <label><input type="checkbox" checked={results[key.id]?.expected_present??false} onChange={event=>setResults(current=>({...current,[key.id]:{expected_present:event.target.checked,actual_condition:current[key.id]?.actual_condition??'good'}}))}/> {`${key.key_code} · ${key.label}`} erwartet</label>
      <label>Zustand<select aria-label={`Zustand ${key.key_code}`} value={results[key.id]?.actual_condition??'good'} onChange={event=>setResults(current=>({...current,[key.id]:{expected_present:current[key.id]?.expected_present??false,actual_condition:event.target.value}}))}>{Object.entries(conditionLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
    </div>):<p className="employee-empty">Keine Schlüssel für diese Auswahl vorhanden.</p>}</div>
    <label className="span-2">Notizen<textarea value={notes} onChange={event=>setNotes(event.target.value)}/></label>
    <div className="key-dialog-actions"><button type="button" onClick={onClose}>Abbrechen</button><button type="submit" disabled={!valid}>Bestandskontrolle speichern</button></div>
  </form></Dialog>;
}

export function BundleCreateDialog({sites,onClose,onDone}:{sites:SiteOption[];onClose:()=>void;onDone:()=>void}){
  const [name,setName]=useState('');const [siteId,setSiteId]=useState('');const [error,setError]=useState('');
  const valid=!!name.trim();
  const submit=(event:FormEvent)=>{
    event.preventDefault();if(!valid)return;
    void send('/key-bundles','POST',{name:name.trim(),site_id:siteId||null},onDone,setError);
  };
  return <Dialog title="Schlüsselbund anlegen" onClose={onClose}><form className="key-dialog-form" onSubmit={submit}>
    {error&&<p role="alert" className="error">{error}</p>}
    <label className="span-2">Name<input required value={name} onChange={event=>setName(event.target.value)}/></label>
    <SitePicker label="Objekt" value={siteId} onChange={setSiteId} sites={sites}/>
    <div className="key-dialog-actions"><button type="button" onClick={onClose}>Abbrechen</button><button type="submit" disabled={!valid}>Bund anlegen</button></div>
  </form></Dialog>;
}

export function BundleIssueDialog({bundle,employees,onClose,onDone}:{bundle:BundleRow;employees:EmployeeOption[];onClose:()=>void;onDone:()=>void}){
  const [holder,setHolder]=useState('');const [dueAt,setDueAt]=useState('');const [reason,setReason]=useState('');const [error,setError]=useState('');
  const valid=!!holder&&!!dueAt&&!!reason.trim();
  const submit=(event:FormEvent)=>{
    event.preventDefault();if(!valid)return;
    void send(`/key-bundles/${bundle.id}/issue`,'POST',{
      ...holderBody(holder),due_at:toIso(dueAt),reason:reason.trim(),
    },onDone,setError);
  };
  return <Dialog title={`Bund ausgeben · ${bundle.name}`} onClose={onClose}><form className="key-dialog-form" onSubmit={submit}>
    <ActionContext item={bundle}/>
    {error&&<p role="alert" className="error">{error}</p>}
    <EmployeePicker label="Schlüsselhalter" value={holder} onChange={setHolder} employees={employees} required/>
    <label>Fällig am<input required type="datetime-local" value={dueAt} onChange={event=>setDueAt(event.target.value)}/></label>
    <label className="span-2">Grund<textarea required value={reason} onChange={event=>setReason(event.target.value)}/></label>
    <div className="key-dialog-actions"><button type="button" onClick={onClose}>Abbrechen</button><button type="submit" disabled={!valid}>Bund ausgeben</button></div>
  </form></Dialog>;
}

export function BundleReturnDialog({bundle,items,partial,onClose,onDone}:{bundle:BundleRow;items:KeyRow[];partial:boolean;onClose:()=>void;onDone:()=>void}){
  const issued=items.filter(item=>item.status==='issued');
  const [selected,setSelected]=useState<string[]>(partial?[]:issued.map(item=>item.id));
  const [reason,setReason]=useState('');const [error,setError]=useState('');
  const valid=selected.length>0&&!!reason.trim();
  const submit=(event:FormEvent)=>{
    event.preventDefault();if(!valid)return;
    if(!partial&&!window.confirm(`Alle ${selected.length} Schlüssel aus ${bundle.name} zurückgeben?`))return;
    void send(`/key-bundles/${bundle.id}/return`,'POST',{key_ids:selected,reason:reason.trim()},onDone,setError);
  };
  return <Dialog title={partial?'Teilweise Rückgabe':'Bund vollständig zurückgeben'} onClose={onClose} wide><form className="key-dialog-form" onSubmit={submit}>
    <ActionContext item={bundle}/>
    {error&&<p role="alert" className="error">{error}</p>}
    <div className="span-2 bundle-member-list">{issued.length?issued.map(item=><label key={item.id}><input type="checkbox" checked={selected.includes(item.id)} onChange={()=>setSelected(current=>current.includes(item.id)?current.filter(id=>id!==item.id):[...current,item.id])}/> {`${item.key_code} · ${item.label}`}</label>):<p className="employee-empty">Keine ausgegebenen Schlüssel im Bund.</p>}</div>
    <label className="span-2">Grund<textarea required value={reason} onChange={event=>setReason(event.target.value)}/></label>
    <div className="key-dialog-actions"><button type="button" onClick={onClose}>Abbrechen</button><button type="submit" disabled={!valid}>{partial?'Ausgewählte Schlüssel zurückgeben':'Alle Schlüssel zurückgeben'}</button></div>
  </form></Dialog>;
}

export function BundleDeactivateDialog({bundle,onClose,onDone}:{bundle:BundleRow;onClose:()=>void;onDone:()=>void}){
  const [reason,setReason]=useState('');const [error,setError]=useState('');
  const valid=!!reason.trim();
  const submit=(event:FormEvent)=>{
    event.preventDefault();if(!valid)return;
    if(!window.confirm(`Schlüsselbund ${bundle.name} deaktivieren?`))return;
    void send(`/key-bundles/${bundle.id}/deactivate`,'POST',{reason:reason.trim()},onDone,setError);
  };
  return <Dialog title={`Bund deaktivieren · ${bundle.name}`} onClose={onClose}><form className="key-dialog-form" onSubmit={submit}>
    <ActionContext item={bundle}/>
    {error&&<p role="alert" className="error">{error}</p>}
    <label className="span-2">Grund<textarea required value={reason} onChange={event=>setReason(event.target.value)}/></label>
    <div className="key-dialog-actions"><button type="button" onClick={onClose}>Abbrechen</button><button type="submit" disabled={!valid}>Deaktivierung bestätigen</button></div>
  </form></Dialog>;
}
