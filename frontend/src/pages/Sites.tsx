import {ChangeEvent,FormEvent,useEffect,useRef,useState} from 'react';
import {useNavigate,useParams} from 'react-router-dom';
import {api,csrf,hasPermission} from '../lib/api';
import {uuid} from '../lib/uuid';

type Site={id:string;name:string;site_number?:string|null;status:string;security_classification:string;address?:string|null;alias?:string|null;site_type?:string|null;description?:string|null;object_manager_employee_id?:string|null;operations_manager_employee_id?:string|null;updated_at?:string};
type SiteOverview=Site&{customer_names:string[]|null;object_manager_name:string|null;operations_manager_name:string|null;assigned_employee_count:number|null;active_contract_count:number|null;expiring_contract_count:number|null;open_hazard_count:number;overdue_measure_count:number;available_document_count:number|null;last_activity:string|null};
type OverviewMetrics={total_sites:number;active_sites:number;preparation_sites:number;restricted_sites:number;critical_sites:number;open_hazards:number|null;overdue_measures:number|null;expiring_contracts:number|null;sites_without_available_documents:number|null};
type SiteOverviewResponse={sites:SiteOverview[];metrics:OverviewMetrics};
type SiteColumn='site_number'|'name'|'site_type'|'customer_names'|'address'|'object_manager_name'|'operations_manager_name'|'security_classification'|'status'|'assigned_employee_count'|'active_contract_count'|'open_hazard_count'|'last_activity';
type Customer={id:string;name:string;customer_number?:string|null};
type Employee={id:string;name:string};
type StaffingAssignment={id:string;employee_id:string;employee_name:string;assignment_type:string;role:string|null;starts_on:string;ends_on:string|null;primary_assignment:boolean;notes:string|null};
type ScheduledShift={id:string;period_id:string;period_name:string;period_status:string;period_starts_at:string;period_ends_at:string;role_code:string;starts_at:string;ends_at:string;assigned_count:number;assignments:{id:string;employee_id:string;employee_name:string}[]};
type PatrolRoute={id:string;name:string;expected_start:string|null;expected_end:string|null;points:{control_point_id:string;name:string;sequence:number;expected_offset_seconds:number|null}[];assignments:{id:string;starts_at:string;ends_at:string|null;employee_name:string|null}[]};
type PatrolScan={id:string;scanned_at:string;deviation:string;route_id:string;route_name:string;control_point_id:string;control_point_name:string;employee_name:string|null};
type KeyRecord={id:string;key_code:string;label:string;key_type:string;status:string;holder_user_id:string|null;holder_employee_id:string|null;issued_at:string|null;returned_at:string|null;lost_at:string|null;deactivated_at:string|null};
type KeyMovement={id:string;key_id:string;key_label:string;movement_type:string;from_status:string|null;to_status:string;created_at:string;employee_name:string|null};
type KeyBundle={id:string;name:string;status:string;item_count:number;issued_count:number};
type DmsVersion={id:string;version_no:number;size_bytes:number;content_type:string;lifecycle_state:string;created_at:string;retention_until:string|null};
type SiteDocument={id:string;title:string;description:string|null;document_status:string;created_at:string;deleted_at:string|null;versions:DmsVersion[]};
type SiteAlarm={id:string;type:string;description:string;severity:string;status:string;triggered_at:string;acknowledged_at:string|null;resolved_at:string|null;priority_name:string|null};
type SiteIncident={id:string;alarm_id:string|null;description:string;status:string;created_at:string;updated_at:string;priority_name:string|null;employee_name:string|null;assigned_count:number;assignees:{id:string;name:string}[]};
type CustomerTask={id:string;customer_id:string;customer_name:string;title:string;description:string|null;status:string;due_at:string|null;assigned_employee_name:string|null;created_at:string;completed_at:string|null};
type MaintenanceEntry={id:string;created_at:string;revision_no:number;content:string;status:string;priority_name:string};
type WatchbookCategory={id:string;code:string;name:string};
type WatchbookPriority={code:string;name:string};
type InstructionAcknowledgement={employee_id:string;employee_name:string;acknowledged_at:string};
type EmployeeQualification={id:string;employee_id:string;employee_name:string;code:string;qualification_name:string|null;valid_from:string|null;valid_until:string|null;status:string;computed_status:string};
type HandoverSummary={id:string;shift_id:string|null;title:string;status:string;created_at:string;participant_count:number;confirmation_count:number};
type ObjectLocation={id:string;parent_id:string|null;name:string;code:string|null;location_type:string;security_level:string;description:string|null;hazard_notes:string|null;access_rules:string|null;responsible_employee_id:string|null;responsible_employee_name:string|null;sort_order:number};
type HazardMeasure={id:string;hazard_id:string;title:string;description:string|null;responsible_employee_id:string|null;responsible_employee_name:string|null;due_on:string|null;status:'open'|'in_progress'|'completed'|'cancelled';completed_at:string|null};
type ObjectHazard={id:string;title:string;category:string;description:string;likelihood:number;impact:number;risk_score:number;protective_measures:string|null;responsible_employee_id:string|null;due_on:string|null;review_on:string|null;status:string;location_id:string|null;location_name:string|null;responsible_employee_name:string|null;measures:HazardMeasure[]};
type KeyAction={keyId:string;action:'issue'|'return'};
type Context={
  site:Site&{object_manager_name?:string|null;operations_manager_name?:string|null};
  customers:{customer_id:string;customer_name:string;relationship_type:string;relationship_status:string}[]|null;
  contracts:{id:string;contract_number:string;customer_name:string;status:string}[]|null;
  locations:ObjectLocation[];
  hazards:ObjectHazard[];
  instructions:{id:string;title:string;content:string;version:number;status:string;requires_acknowledgement:boolean;acknowledgement_count:number;acknowledgements:InstructionAcknowledgement[];location_name?:string|null;valid_from?:string|null;valid_until?:string|null;can_approve?:boolean}[];
  journal:{id:string;created_at:string;revision_no:number;content:string;status:string;category_name:string;priority_name:string}[]|null;
  staffing:StaffingAssignment[]|null;
  shifts:ScheduledShift[]|null;
  patrols:{routes:PatrolRoute[];recentScans:PatrolScan[]}|null;
  keys:{items:KeyRecord[];recentMovements:KeyMovement[]}|null;
  keyBundles:KeyBundle[]|null;
  documents:SiteDocument[]|null;
  alarms:SiteAlarm[]|null;
  incidents:SiteIncident[]|null;
  customerTasks:CustomerTask[]|null;
  maintenance:MaintenanceEntry[]|null;
  qualifications:EmployeeQualification[]|null;
  handovers:HandoverSummary[]|null;
};
const statuses:Record<string,string>={planning:'Planung',setup:'Einrichtung',active:'Aktiv',restricted:'Eingeschränkt',temporarily_closed:'Temporär geschlossen',decommissioned:'Stillgelegt',archived:'Archiviert'};
const classifications:Record<string,string>={unknown:'Offen',low:'Niedrig',medium:'Mittel',high:'Hoch',critical:'Kritisch'};
const hazardCategories:Record<string,string>={burglary:'Einbruch',theft:'Diebstahl',vandalism:'Vandalismus',fire:'Brand',robbery:'Raub',unauthorized_access:'Unbefugter Zutritt',sabotage:'Sabotage',conflict:'Konflikt',technical:'Technisch',environmental:'Umwelt',other:'Sonstige'};
const emptySite={name:'',site_number:'',address:'',status:'planning',security_classification:'unknown'};
const emptyLocation={name:'',location_type:'building',code:'',parent_id:'',responsible_employee_id:'',security_level:'unknown',description:'',hazard_notes:'',access_rules:'',sort_order:0};
const emptyHazard={title:'',category:'other',description:'',likelihood:1,impact:1,location_id:'',responsible_employee_id:'',due_on:'',review_on:'',status:'open',protective_measures:''};
const emptyMeasure={title:'',description:'',responsible_employee_id:'',due_on:'',status:'open' as const};
type SiteForm=typeof emptySite;
const tabs=[['uebersicht','Übersicht'],['stammdaten','Stammdaten'],['kunden','Kunden & Verträge'],['struktur','Gebäude & Bereiche'],['personal','Mitarbeiter & Verantwortlichkeiten'],['dienstplanung','Dienstplanung'],['gefaehrdungen','Gefährdungen & Sicherheit'],['anweisungen','Dienstanweisungen'],['kontrollgaenge','Kontrollgänge'],['schluessel','Schlüssel & Zutritt'],['technik','Ausstattung & Technik'],['dokumente','Dokumente'],['vorfaelle','Vorfälle & Berichte'],['aufgaben','Aufgaben & Maßnahmen'],['journal','Journal']] as const;
const sectionAliases:Record<string,string>={qualifikationen:'personal',einsaetze:'vorfaelle',berichte:'vorfaelle',uebergaben:'uebersicht'};
const siteColumns:{key:SiteColumn;label:string}[]=[
  {key:'site_number',label:'Objektnummer'},{key:'name',label:'Objekt'},{key:'site_type',label:'Objektart'},
  {key:'customer_names',label:'Kunde'},{key:'address',label:'Standort / Adresse'},
  {key:'object_manager_name',label:'Objektleitung'},{key:'operations_manager_name',label:'Einsatzleitung'},
  {key:'security_classification',label:'Sicherheitsstufe'},{key:'status',label:'Status'},
  {key:'assigned_employee_count',label:'Mitarbeiter'},{key:'active_contract_count',label:'Aktive Verträge'},
  {key:'open_hazard_count',label:'Offene Gefährdungen'},{key:'last_activity',label:'Letzte Aktivität'},
];

function toBase64(file:File){
  return file.arrayBuffer().then(bytes=>{
    let binary='';const values=new Uint8Array(bytes);
    for(let index=0;index<values.length;index+=0x8000)binary+=String.fromCharCode(...values.subarray(index,index+0x8000));
    return btoa(binary);
  });
}

export function Sites(){
  const navigate=useNavigate();
  const {siteId,section}=useParams<{siteId?:string;section?:string}>();
  const resolvedSection=sectionAliases[section??'']??section;
  const active=tabs.some(([key])=>key===resolvedSection)?resolvedSection:'uebersicht';
  const [sites,setSites]=useState<SiteOverview[]>([]);
  const [metrics,setMetrics]=useState<OverviewMetrics|null>(null);
  const [customers,setCustomers]=useState<Customer[]>([]);
  const [employees,setEmployees]=useState<Employee[]>([]);
  const [selected,setSelected]=useState<Context|null>(null);
  const [error,setError]=useState('');
  const [search,setSearch]=useState('');
  const [statusFilter,setStatusFilter]=useState('all');
  const [securityFilter,setSecurityFilter]=useState('all');
  const [customerFilter,setCustomerFilter]=useState('all');
  const [managerFilter,setManagerFilter]=useState('all');
  const [siteTypeFilter,setSiteTypeFilter]=useState('all');
  const [visibleColumns,setVisibleColumns]=useState<SiteColumn[]>(siteColumns.map(column=>column.key));
  const [sortKey,setSortKey]=useState<SiteColumn>('name');
  const [descending,setDescending]=useState(false);
  const [page,setPage]=useState(1);
  const [listLoading,setListLoading]=useState(true);
  const [detailLoading,setDetailLoading]=useState(false);
  const [editing,setEditing]=useState<Site|null>(null);
  const [form,setForm]=useState<SiteForm>(emptySite);
  const [formOpen,setFormOpen]=useState(false);
  const [customerId,setCustomerId]=useState('');
  const [contractCustomer,setContractCustomer]=useState('');
  const [contractId,setContractId]=useState('');
  const [availableContracts,setAvailableContracts]=useState<{id:string;contract_number:string;sites:{id:string}[]}[]>([]);
  const [locationForm,setLocationForm]=useState(emptyLocation);
  const [editingLocation,setEditingLocation]=useState<string|null>(null);
  const [hazardForm,setHazardForm]=useState(emptyHazard);
  const [editingHazard,setEditingHazard]=useState<string|null>(null);
  const [measureHazardId,setMeasureHazardId]=useState<string|null>(null);
  const [editingMeasureId,setEditingMeasureId]=useState<string|null>(null);
  const [measureForm,setMeasureForm]=useState<{title:string;description:string;responsible_employee_id:string;due_on:string;status:HazardMeasure['status']}>(emptyMeasure);
  const [instructionForm,setInstructionForm]=useState({title:'',content:'',status:'draft',version:1,requires_acknowledgement:false,location_id:'',valid_from:'',valid_until:''});
  const [supersedesId,setSupersedesId]=useState('');
  const [ackEmployee,setAckEmployee]=useState('');
  const [documentTitle,setDocumentTitle]=useState('');
  const [documentFile,setDocumentFile]=useState<File|null>(null);
  const documentInput=useRef<HTMLInputElement>(null);
  const [taskCustomerId,setTaskCustomerId]=useState('');
  const [taskTitle,setTaskTitle]=useState('');
  const [taskDue,setTaskDue]=useState('');
  const [taskAssignee,setTaskAssignee]=useState('');
  const [maintenanceCategoryId,setMaintenanceCategoryId]=useState('');
  const [maintenancePriorities,setMaintenancePriorities]=useState<WatchbookPriority[]>([]);
  const [maintenancePriorityCode,setMaintenancePriorityCode]=useState('');
  const [maintenanceContent,setMaintenanceContent]=useState('');
  const [maintenanceClientEntryId,setMaintenanceClientEntryId]=useState(uuid());
  const [maintenanceOptionsLoaded,setMaintenanceOptionsLoaded]=useState(false);
  const [shiftAssignmentRequests,setShiftAssignmentRequests]=useState<Record<string,{employee_id:string;client_mutation_id:string}>>({});
  const [assignmentForm,setAssignmentForm]=useState({employee_id:'',assignment_type:'operational',role:'',starts_on:'',ends_on:'',notes:'',reason:''});
  const [keyAction,setKeyAction]=useState<KeyAction|null>(null);
  const [keyHolderEmployeeId,setKeyHolderEmployeeId]=useState('');
  const [keyActionReason,setKeyActionReason]=useState('');
  const [details,setDetails]=useState({alias:'',site_type:'',description:'',object_manager_employee_id:'',operations_manager_employee_id:''});
  const writable=hasPermission('sites:write');

  async function load(){
    setListLoading(true);
    try{
      const response=await api<SiteOverviewResponse>('/sites/overview-dashboard');
      setSites(response?.sites??[]);setMetrics(response?.metrics??null);setError('');
    }catch(e){setError((e as Error).message);}
    finally{setListLoading(false);}
  }
  useEffect(()=>{if(!siteId){setSelected(null);void load();return;}void open(siteId);},[siteId]);
  async function open(id:string){
    setDetailLoading(true);
    try{
      setSelected(null);
      const [context,customerRows,employeeRows]=await Promise.all([
        api<Context>(`/sites/${id}/object-context`),
        writable&&hasPermission('customers:write')?api<Customer[]>('/customers'):Promise.resolve([]),
        hasPermission('employees:read')?api<Employee[]>('/employees'):Promise.resolve([]),
      ]);
      if(context){
        setSelected(context);
        const site=context.site;
        setForm({name:site.name,site_number:site.site_number??'',address:site.address??'',status:site.status,security_classification:site.security_classification});
        setDetails({alias:site.alias??'',site_type:site.site_type??'',description:site.description??'',object_manager_employee_id:site.object_manager_employee_id??'',operations_manager_employee_id:site.operations_manager_employee_id??''});
      }
      setCustomers(customerRows??[]);setEmployees(employeeRows??[]);setError('');
    }catch(e){setError((e as Error).message);}
    finally{setDetailLoading(false);}
  }
  async function refreshContext(){
    if(!selected)return;
    const context=await api<Context>(`/sites/${selected.site.id}/object-context`);
    if(context)setSelected(context);
  }
  async function saveDetails(event:FormEvent){
    event.preventDefault();if(!selected)return;
    try{
      await api(`/sites/${selected.site.id}`,{method:'PATCH',body:JSON.stringify({name:form.name,site_number:form.site_number.trim()||null,address:form.address.trim()||null,status:form.status,security_classification:form.security_classification,description:details.description,alias:details.alias.trim()||null,site_type:details.site_type.trim()||null,object_manager_employee_id:details.object_manager_employee_id||null,operations_manager_employee_id:details.operations_manager_employee_id||null})});
      await refreshContext();setError('');
    }catch(e){setError((e as Error).message);}
  }
  async function archiveLink(id:string){
    if(!selected||!window.confirm('Kundenverknüpfung archivieren?'))return;
    try{await api(`/sites/${selected.site.id}/customer-links/${id}`,{method:'DELETE'});await refreshContext();setError('');}
    catch(e){setError((e as Error).message);}
  }
  async function chooseContractCustomer(id:string){
    setContractCustomer(id);setContractId('');setAvailableContracts([]);
    if(!id)return;
    try{
      const profile=await api<{contracts:typeof availableContracts}>(`/customers/${id}/profile`);
      setAvailableContracts(profile?.contracts??[]);setError('');
    }catch(e){setError((e as Error).message);}
  }
  async function linkContract(event:FormEvent){
    event.preventDefault();if(!selected||!contractCustomer||!contractId)return;
    try{await api(`/customers/${contractCustomer}/contracts/${contractId}/sites`,{method:'POST',body:JSON.stringify({site_id:selected.site.id})});setContractId('');await refreshContext();await chooseContractCustomer(contractCustomer);}
    catch(e){setError((e as Error).message);}
  }
  async function acknowledge(instructionId:string){
    if(!selected||!ackEmployee)return;
    try{await api(`/sites/${selected.site.id}/instructions/${instructionId}/acknowledgements`,{method:'POST',body:JSON.stringify({employee_id:ackEmployee})});await refreshContext();setError('');}
    catch(e){setError((e as Error).message);}
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
    try{
      const body={...locationForm,code:locationForm.code.trim()||null,parent_id:locationForm.parent_id||null,responsible_employee_id:locationForm.responsible_employee_id||null,description:locationForm.description.trim()||null,hazard_notes:locationForm.hazard_notes.trim()||null,access_rules:locationForm.access_rules.trim()||null};
      await api(editingLocation?`/sites/${selected.site.id}/locations/${editingLocation}`:`/sites/${selected.site.id}/locations`,{method:editingLocation?'PATCH':'POST',body:JSON.stringify(body)});
      setLocationForm(emptyLocation);setEditingLocation(null);await refreshContext();setError('');
    }
    catch(e){setError((e as Error).message);}
  }
  async function createHazard(event:FormEvent){
    event.preventDefault();if(!selected)return;
    try{
      const body={...hazardForm,location_id:hazardForm.location_id||null,responsible_employee_id:hazardForm.responsible_employee_id||null,due_on:hazardForm.due_on||null,review_on:hazardForm.review_on||null};
      await api(editingHazard?`/sites/${selected.site.id}/hazards/${editingHazard}`:`/sites/${selected.site.id}/hazards`,{method:editingHazard?'PATCH':'POST',body:JSON.stringify(body)});
      setHazardForm(emptyHazard);setEditingHazard(null);await refreshContext();setError('');
    }
    catch(e){setError((e as Error).message);}
  }
  async function saveHazardMeasure(event:FormEvent){
    event.preventDefault();if(!selected||!measureHazardId)return;
    try{
      const body={...measureForm,description:measureForm.description.trim()||null,responsible_employee_id:measureForm.responsible_employee_id||null,due_on:measureForm.due_on||null};
      const path=`/sites/${selected.site.id}/hazards/${measureHazardId}/measures`;
      await api(editingMeasureId?`${path}/${editingMeasureId}`:path,{method:editingMeasureId?'PATCH':'POST',body:JSON.stringify(body)});
      setMeasureForm(emptyMeasure);setMeasureHazardId(null);setEditingMeasureId(null);await refreshContext();setError('');
    }catch(e){setError((e as Error).message);}
  }
  function editHazardMeasure(hazard:ObjectHazard,measure?:HazardMeasure){
    setMeasureHazardId(hazard.id);setEditingMeasureId(measure?.id??null);
    setMeasureForm(measure?{title:measure.title,description:measure.description??'',responsible_employee_id:measure.responsible_employee_id??'',due_on:measure.due_on??'',status:measure.status}:emptyMeasure);
  }
  function editLocation(location:ObjectLocation){
    setEditingLocation(location.id);
    setLocationForm({name:location.name,location_type:location.location_type,code:location.code??'',parent_id:location.parent_id??'',responsible_employee_id:location.responsible_employee_id??'',security_level:location.security_level,description:location.description??'',hazard_notes:location.hazard_notes??'',access_rules:location.access_rules??'',sort_order:location.sort_order});
  }
  function editHazard(hazard:ObjectHazard){
    setEditingHazard(hazard.id);
    setHazardForm({title:hazard.title,category:hazard.category,description:hazard.description,likelihood:hazard.likelihood,impact:hazard.impact,location_id:hazard.location_id??'',responsible_employee_id:hazard.responsible_employee_id??'',due_on:hazard.due_on??'',review_on:hazard.review_on??'',status:hazard.status,protective_measures:hazard.protective_measures??''});
  }
  async function createInstruction(event:FormEvent){
    event.preventDefault();if(!selected)return;
    try{await api(`/sites/${selected.site.id}/instructions`,{method:'POST',body:JSON.stringify({...instructionForm,location_id:instructionForm.location_id||null,valid_from:instructionForm.valid_from||null,valid_until:instructionForm.valid_until||null,supersedes_id:supersedesId||null})});setInstructionForm({title:'',content:'',status:'draft',version:1,requires_acknowledgement:false,location_id:'',valid_from:'',valid_until:''});setSupersedesId('');await refreshContext();setError('');}
    catch(e){setError((e as Error).message);}
  }
  async function approveInstruction(instructionId:string){
    if(!selected)return;
    try{await api(`/sites/${selected.site.id}/instructions/${instructionId}/approve`,{method:'POST'});await refreshContext();setError('');}
    catch(e){setError((e as Error).message);}
  }
  async function returnInstructionForRevision(instructionId:string){
    if(!selected)return;
    const reason=window.prompt('Grund für die Rückgabe zur Überarbeitung');
    if(!reason?.trim())return;
    try{await api(`/sites/${selected.site.id}/instructions/${instructionId}/return-for-revision`,{method:'POST',body:JSON.stringify({reason:reason.trim()})});await refreshContext();setError('');}
    catch(e){setError((e as Error).message);}
  }
  async function uploadSiteDocument(event:FormEvent){
    event.preventDefault();if(!selected||!documentFile)return;
    try{
      await api('/dms/documents',{method:'POST',body:JSON.stringify({title:documentTitle,site_id:selected.site.id,content_type:documentFile.type||'application/octet-stream',content_base64:await toBase64(documentFile),client_mutation_id:uuid()})});
      setDocumentTitle('');setDocumentFile(null);if(documentInput.current)documentInput.current.value='';await refreshContext();setError('');
    }catch(e){setError((e as Error).message);}
  }
  async function downloadDocument(document:SiteDocument,version:DmsVersion){
    try{
      const response=await fetch(`/api/v1/dms/documents/${document.id}/versions/${version.id}/download`,{credentials:'include',headers:{'x-csrf-token':csrf()}});
      if(!response.ok)throw new Error((await response.json()).error||'Download fehlgeschlagen');
      const url=URL.createObjectURL(await response.blob()),link=window.document.createElement('a');
      link.href=url;link.download=`${document.title}-v${version.version_no}`;link.click();URL.revokeObjectURL(url);
      setError('');
    }catch(e){setError((e as Error).message);}
  }
  async function createCustomerTask(event:FormEvent){
    event.preventDefault();if(!taskCustomerId)return;
    try{
      await api(`/customers/${taskCustomerId}/tasks`,{method:'POST',body:JSON.stringify({title:taskTitle,due_at:taskDue?new Date(taskDue).toISOString():null,assigned_employee_id:taskAssignee||null})});
      setTaskTitle('');setTaskDue('');setTaskAssignee('');await refreshContext();setError('');
    }catch(e){setError((e as Error).message);}
  }
  async function completeCustomerTask(task:CustomerTask){
    try{await api(`/customers/${task.customer_id}/tasks/${task.id}`,{method:'PATCH',body:JSON.stringify({status:'completed'})});await refreshContext();setError('');}
    catch(e){setError((e as Error).message);}
  }
  async function createMaintenanceEntry(event:FormEvent){
    event.preventDefault();if(!selected||!maintenanceCategoryId||!maintenancePriorityCode)return;
    try{
      await api('/watchbook/entries',{method:'POST',body:JSON.stringify({site_id:selected.site.id,category_id:maintenanceCategoryId,priority_code:maintenancePriorityCode,content:maintenanceContent,client_entry_id:maintenanceClientEntryId})});
      await refreshContext();setMaintenanceContent('');setMaintenanceClientEntryId(uuid());setError('');
    }catch(e){setError((e as Error).message);}
  }
  async function createStaffingAssignment(event:FormEvent){
    event.preventDefault();if(!selected||!assignmentForm.employee_id)return;
    try{
      const {employee_id,...assignment}=assignmentForm;
      await api(`/employees/${employee_id}/object-assignments`,{method:'POST',body:JSON.stringify({...assignment,site_id:selected.site.id,role:assignment.role.trim()||null,ends_on:assignment.ends_on||null,notes:assignment.notes.trim()||null})});
      setAssignmentForm({employee_id:'',assignment_type:'operational',role:'',starts_on:'',ends_on:'',notes:'',reason:''});
      await refreshContext();setError('');
    }catch(e){setError((e as Error).message);}
  }
  async function assignShiftEmployee(event:FormEvent,shift:ScheduledShift){
    event.preventDefault();if(!selected)return;
    const assignment=shiftAssignmentRequests[shift.id];
    if(!assignment)return;
    try{
      await api(`/scheduling/shifts/${shift.id}/assignments`,{method:'POST',body:JSON.stringify(assignment)});
      await refreshContext();
      setShiftAssignmentRequests(current=>{const next={...current};delete next[shift.id];return next;});
      setError('');
    }catch(e){setError((e as Error).message);}
  }
  async function saveKeyAction(event:FormEvent){
    event.preventDefault();if(!selected||!keyAction)return;
    try{
      const body={client_mutation_id:uuid(),reason:keyActionReason.trim()||null};
      if(keyAction.action==='issue'){
        if(!keyHolderEmployeeId)throw new Error('Bitte eine zugeordnete Mitarbeiterin oder einen zugeordneten Mitarbeiter auswählen.');
        await api(`/keys/${keyAction.keyId}/issue`,{method:'POST',body:JSON.stringify({...body,holder_user_id:null,holder_employee_id:keyHolderEmployeeId})});
      }else await api(`/keys/${keyAction.keyId}/return`,{method:'POST',body:JSON.stringify(body)});
      setKeyAction(null);setKeyHolderEmployeeId('');setKeyActionReason('');await refreshContext();setError('');
    }catch(e){setError((e as Error).message);}
  }
  const columnValue=(site:SiteOverview,key:SiteColumn):string|number|null=>{
    switch(key){
      case 'customer_names':return site.customer_names?.join(', ')??null;
      case 'security_classification':return classifications[site.security_classification]??site.security_classification;
      case 'status':return statuses[site.status]??site.status;
      case 'last_activity':return site.last_activity;
      case 'site_number':return site.site_number??null;
      case 'name':return site.name;
      case 'site_type':return site.site_type??null;
      case 'address':return site.address??null;
      case 'object_manager_name':return site.object_manager_name;
      case 'operations_manager_name':return site.operations_manager_name;
      case 'assigned_employee_count':return site.assigned_employee_count;
      case 'active_contract_count':return site.active_contract_count;
      case 'open_hazard_count':return site.open_hazard_count;
    }
  };
  const displayValue=(site:SiteOverview,key:SiteColumn)=>{
    const value=columnValue(site,key);
    return key==='last_activity'&&typeof value==='string'?new Date(value).toLocaleString('de-DE'):value??'–';
  };
  const filtered=sites.filter(site=>{
    const searchable=[site.name,site.site_number,site.site_type,site.address,site.customer_names?.join(' '),site.object_manager_name,site.operations_manager_name,statuses[site.status],classifications[site.security_classification]].filter(Boolean).join(' ').toLocaleLowerCase();
    return (statusFilter==='all'||site.status===statusFilter)
      &&(securityFilter==='all'||site.security_classification===securityFilter)
      &&(siteTypeFilter==='all'||site.site_type===siteTypeFilter)
      &&(customerFilter==='all'||site.customer_names?.includes(customerFilter))
      &&(managerFilter==='all'||site.object_manager_employee_id===managerFilter||site.operations_manager_employee_id===managerFilter)
      &&searchable.includes(search.toLocaleLowerCase());
  });
  const sorted=[...filtered].sort((a,b)=>{
    const left=columnValue(a,sortKey),right=columnValue(b,sortKey);
    const comparison=typeof left==='number'&&typeof right==='number'?left-right:String(left??'').localeCompare(String(right??''),'de',{numeric:true});
    return comparison*(descending?-1:1);
  });
  const pages=Math.max(1,Math.ceil(sorted.length/10));
  const currentPage=Math.min(page,pages);
  const changeSort=(key:SiteColumn)=>{if(key===sortKey)setDescending(!descending);else{setSortKey(key);setDescending(false);}setPage(1);};
  const toggleColumn=(key:SiteColumn,checked:boolean)=>setVisibleColumns(current=>checked?[...current,key]:current.length>1?current.filter(column=>column!==key):current);
  const customerOptions=Array.from(new Set(sites.flatMap(site=>site.customer_names??[]))).sort((a,b)=>a.localeCompare(b,'de'));
  const managerOptions=Array.from(new Map<string,string>(sites.flatMap(site=>{
    const managers:[string,string][]=[];
    if(site.object_manager_employee_id&&site.object_manager_name)managers.push([site.object_manager_employee_id,site.object_manager_name]);
    if(site.operations_manager_employee_id&&site.operations_manager_name)managers.push([site.operations_manager_employee_id,site.operations_manager_name]);
    return managers;
  })).entries());
  const siteTypeOptions=Array.from(new Set(sites.map(site=>site.site_type).filter((value):value is string=>!!value))).sort((a,b)=>a.localeCompare(b,'de'));
  function exportCsv(){
    const escape=(value:string|number|null)=>`"${String(value??'').replace(/"/g,'""')}"`;
    const rows=[siteColumns.map(column=>escape(column.label)),...sorted.map(site=>siteColumns.map(column=>escape(columnValue(site,column.key))))];
    const blob=new Blob([`\uFEFF${rows.map(row=>row.join(';')).join('\r\n')}`],{type:'text/csv;charset=utf-8'});
    const url=URL.createObjectURL(blob),link=window.document.createElement('a');
    link.href=url;link.download='objektuebersicht.csv';link.click();URL.revokeObjectURL(url);
  }
  const selectedCustomers=selected?.customers??[];
  const selectedContracts=selected?.contracts??[];
  const locationPath=(location:ObjectLocation,visited=new Set<string>()):string=>{
    if(visited.has(location.id))return location.name;
    const next=new Set(visited);next.add(location.id);
    const parent=selected?.locations.find(candidate=>candidate.id===location.parent_id);
    return parent?`${locationPath(parent,next)} / ${location.name}`:location.name;
  };
  const assignableEmployees=employees.filter(employee=>!selected?.staffing?.some(assignment=>assignment.employee_id===employee.id));
  const siteAssignedEmployees=employees.filter(employee=>selected?.staffing?.some(assignment=>assignment.employee_id===employee.id));
  const availableShiftEmployees=(shift:ScheduledShift)=>siteAssignedEmployees.filter(employee=>!shift.assignments.some(assignment=>assignment.employee_id===employee.id));
  const selectedSiteId=selected?.site.id;
  const maintenanceReadable=selected?.maintenance!==null&&selected?.maintenance!==undefined;
  const locationParentType=locationForm.location_type==='area'?'building':locationForm.location_type==='zone'?'area':null;
  useEffect(()=>{
    if(!selectedSiteId)return;
    setMaintenanceClientEntryId(uuid());
  },[selectedSiteId]);
  useEffect(()=>{
    if(active!=='technik'||!selectedSiteId||!maintenanceReadable||!hasPermission('watchbook:read')||!hasPermission('watchbook:write'))return;
    let current=true;
    setMaintenanceOptionsLoaded(false);
    Promise.all([api<WatchbookCategory[]>('/watchbook/categories'),api<WatchbookPriority[]>('/watchbook/priorities')]).then(([categories,priorities])=>{
      const maintenanceCategory=categories?.find(category=>category.code==='maintenance');
      if(!maintenanceCategory||!priorities?.length)throw new Error('Wartungskategorie oder Prioritäten sind im Wachbuch nicht konfiguriert.');
      if(current){
        setMaintenanceCategoryId(maintenanceCategory.id);
        setMaintenancePriorities(priorities);
        setMaintenancePriorityCode(priorities[0].code);
        setMaintenanceOptionsLoaded(true);
      }
    }).catch(error=>{
      if(current){setError((error as Error).message);setMaintenanceOptionsLoaded(true);}
    });
    return ()=>{current=false;};
  },[active,selectedSiteId,maintenanceReadable]);

  const activityItems=[
    ...(selected?.journal??[]).map(entry=>({id:`journal-${entry.id}`,created_at:entry.created_at,title:entry.category_name,detail:`${entry.priority_name} · ${entry.status}`})),
    ...(selected?.incidents??[]).map(incident=>({id:`incident-${incident.id}`,created_at:incident.created_at,title:'Einsatz',detail:`${incident.status} · ${incident.description}`})),
    ...(selected?.alarms??[]).map(alarm=>({id:`alarm-${alarm.id}`,created_at:alarm.triggered_at,title:'Alarm',detail:`${alarm.priority_name??alarm.severity} · ${alarm.description}`})),
    ...(selected?.handovers??[]).map(handover=>({id:`handover-${handover.id}`,created_at:handover.created_at,title:'Übergabe',detail:`${handover.title} · ${handover.confirmation_count}/${handover.participant_count} Bestätigungen`})),
  ].sort((a,b)=>b.created_at.localeCompare(a.created_at)).slice(0,8);
  const now=new Date();
  const today=now.toISOString().slice(0,10);
  const isInstructionActive=(instruction:Context['instructions'][number])=>instruction.status==='approved'&&(!instruction.valid_from||instruction.valid_from<=today)&&(!instruction.valid_until||instruction.valid_until>=today);
  const currentStaff=selected?.staffing?.filter(assignment=>!assignment.ends_on||assignment.ends_on>=now.toISOString().slice(0,10))??[];
  const currentShifts=selected?.shifts?.filter(shift=>shift.starts_at<=now.toISOString()&&shift.ends_at>=now.toISOString())??[];
  const criticalHazards=selected?.hazards.filter(hazard=>hazard.status==='open'&&hazard.risk_score>=15)??[];
  const expiredInstructions=selected?.instructions.filter(instruction=>instruction.status==='approved'&&instruction.valid_until&&instruction.valid_until<today)??[];
  const overdueMeasures=selected?.hazards.flatMap(hazard=>hazard.measures).filter(measure=>['open','in_progress'].includes(measure.status)&&measure.due_on&&measure.due_on<today)??[];
  return <section className="object-management">
    {error&&<p role="alert" className="error">{error}</p>}
    {siteId?(selected?<article className="object-detail-page">
      <button type="button" className="object-back" onClick={()=>navigate('/sites')}>Zur Objektübersicht</button>
      <header className="object-detail-header">
        <div><p className="object-eyebrow">Digitale Objektakte · {selected.site.site_number||'Ohne Objektnummer'}</p><h2>{selected.site.name}</h2>
          <p>{selected.site.address||'Keine Adresse'} · {selected.site.alias?`${selected.site.alias} · `:''}{selected.site.site_type||'Objektart nicht festgelegt'}</p>
          <p>Objektleitung: {selected.site.object_manager_name||'–'} · Einsatzleitung: {selected.site.operations_manager_name||'–'}</p>
          <div className="object-header-meta"><span className={`object-status ${selected.site.status}`}>{statuses[selected.site.status]??selected.site.status}</span><span>{classifications[selected.site.security_classification]??selected.site.security_classification}</span><span>Aktualisiert {selected.site.updated_at?new Date(selected.site.updated_at).toLocaleString('de-DE'):'nicht verfügbar'}</span></div>
        </div>
        <div className="object-actions"><button type="button" onClick={()=>navigate(`/sites/${siteId}/stammdaten`)}>Objekt bearbeiten</button><button type="button" onClick={()=>navigate(`/sites/${siteId}/personal`)}>Mitarbeiter zuweisen</button><button type="button" onClick={()=>navigate(`/sites/${siteId}/aufgaben`)}>Aufgabe erstellen</button><button type="button" onClick={()=>navigate(`/sites/${siteId}/dokumente`)}>Dokument hinzufügen</button><button type="button" onClick={()=>navigate(`/sites/${siteId}/vorfaelle`)}>Vorfall erfassen</button></div>
      </header>
      <nav className="object-tabs" aria-label="Objektbereiche">{tabs.map(([key,label])=><button type="button" key={key} className={active===key?'active':''} aria-current={active===key?'page':undefined} onClick={()=>navigate(`/sites/${siteId}/${key}`)}>{label}</button>)}</nav>
      {active==='uebersicht'&&<div className="object-detail-content">
        <div className="object-alerts" aria-label="Operative Hinweise">
          {criticalHazards.length>0&&<p role="status">Kritische Gefährdungen: {criticalHazards.length}</p>}
          {overdueMeasures.length>0&&<p role="status">Überfällige Maßnahmen: {overdueMeasures.length}</p>}
          {expiredInstructions.length>0&&<p role="status">Abgelaufene Dienstanweisungen: {expiredInstructions.length}</p>}
          {selected.instructions.some(instruction=>isInstructionActive(instruction)&&instruction.requires_acknowledgement&&instruction.acknowledgement_count<currentStaff.length)&&<p role="status">Ausstehende Dienstanweisungs-Kenntnisnahmen vorhanden.</p>}
        </div>
        <div className="object-summary-grid">
          <article><h3>Objektstatus</h3><strong>{statuses[selected.site.status]??selected.site.status}</strong><p>{classifications[selected.site.security_classification]??selected.site.security_classification}</p></article>
          <article><h3>Verantwortliche</h3><p>Objektleitung: {selected.site.object_manager_name||'–'}</p><p>Einsatzleitung: {selected.site.operations_manager_name||'–'}</p></article>
          <article><h3>Kunde & Verträge</h3>{selected.customers==null?<p>Keine Berechtigung für Kundenbeziehungen.</p>:<p>{selectedCustomers.map(customer=>customer.customer_name).join(', ')||'Keine aktive Kundenbeziehung'}</p>}{selected.contracts==null?<p>Verträge nicht freigegeben.</p>:<p>{selectedContracts.length} aktive Vertragsverknüpfungen</p>}</article>
          <article><h3>Besetzung</h3><p>{selected.staffing==null?'Keine Berechtigung':`${currentStaff.length} zugeordnete Mitarbeitende`}</p><p>{selected.shifts==null?'Dienstplanung nicht freigegeben':`${currentShifts.length} aktuell besetzte Schichten`}</p></article>
          <article><h3>Sicherheitslage</h3><p>{selected.hazards.filter(hazard=>hazard.status==='open').length} offene Gefährdungen</p><p>{overdueMeasures.length} überfällige Maßnahmen</p></article>
          <article><h3>Dienstanweisungen</h3><p>{selected.instructions.filter(isInstructionActive).length} aktuell gültig</p><p>{expiredInstructions.length} abgelaufen</p><p>{selected.instructions.filter(instruction=>instruction.requires_acknowledgement).reduce((total,instruction)=>total+instruction.acknowledgement_count,0)} Kenntnisnahmen erfasst</p></article>
          <article><h3>Dokumente</h3>{selected.documents==null?<p>Keine Berechtigung für DMS-Dokumente.</p>:<p>{selected.documents.length} aktive DMS-Dokumente</p>}<p>Fachliche Ablaufdaten sind im DMS nicht hinterlegt.</p></article>
          <article><h3>Vorfälle & Alarme</h3><p>{selected.incidents==null?'Einsätze nicht freigegeben':`${selected.incidents.length} Einsätze`}</p><p>{selected.alarms==null?'Alarme nicht freigegeben':`${selected.alarms.length} Alarme`}</p></article>
          <article><h3>Anstehende Schichten</h3>{selected.shifts==null?<p>Keine Berechtigung für die Dienstplanung.</p>:<p>{selected.shifts.filter(shift=>shift.starts_at>now.toISOString()).slice(0,2).map(shift=>`${shift.role_code} · ${new Date(shift.starts_at).toLocaleString('de-DE')}`).join(' / ')||'Keine zukünftigen Schichten'}</p>}</article>
        </div>
        <section className="object-activity"><h3>Aktivitätschronik</h3>{activityItems.length? <ol>{activityItems.map(item=><li key={item.id}><time>{new Date(item.created_at).toLocaleString('de-DE')}</time><strong>{item.title}</strong><span>{item.detail}</span></li>)}</ol>:<p>Keine freigegebenen Journal-, Einsatz-, Alarm- oder Übergabeereignisse vorhanden.</p>}{hasPermission('handover:read')&&<button type="button" onClick={()=>navigate('/handovers')}>Übergaben öffnen</button>}</section>
      </div>}
      {active==='stammdaten'&&<div className="object-detail-content">
        {writable?<form className="object-detail-form" onSubmit={saveDetails}><div className="form-grid">
          <label>Objektname<input required value={form.name} onChange={e=>setForm({...form,name:e.target.value})}/></label>
          <label>Objektnummer<input value={form.site_number} onChange={e=>setForm({...form,site_number:e.target.value})}/></label>
          <label>Adresse<input value={form.address} onChange={e=>setForm({...form,address:e.target.value})}/></label>
          <label>Alias<input value={details.alias} onChange={e=>setDetails({...details,alias:e.target.value})}/></label>
          <label>Objektart<input value={details.site_type} onChange={e=>setDetails({...details,site_type:e.target.value})}/></label>
          <label>Status<select value={form.status} onChange={e=>setForm({...form,status:e.target.value})}>{Object.entries(statuses).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
          <label>Sicherheitsklassifizierung<select value={form.security_classification} onChange={e=>setForm({...form,security_classification:e.target.value})}>{Object.entries(classifications).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
          {hasPermission('employees:read')&&<><label>Objektleitung<select value={details.object_manager_employee_id} onChange={e=>setDetails({...details,object_manager_employee_id:e.target.value})}><option value="">Nicht zugewiesen</option>{employees.map(employee=><option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></label><label>Einsatzleitung<select value={details.operations_manager_employee_id} onChange={e=>setDetails({...details,operations_manager_employee_id:e.target.value})}><option value="">Nicht zugewiesen</option>{employees.map(employee=><option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></label></>}
          <label>Beschreibung<textarea value={details.description} onChange={e=>setDetails({...details,description:e.target.value})}/></label>
        </div><button>Stammdaten speichern</button></form>:<p>Keine Schreibberechtigung für Stammdaten.</p>}
      </div>}
      {active==='kunden'&&<div className="object-detail-content">
      <h3>Kundenbeziehungen</h3>
      {selected.customers===null?<p>Keine Berechtigung für Kundenbeziehungen.</p>:<ul>{selectedCustomers.map(customer=><li key={customer.customer_id}>{customer.customer_name} ({customer.relationship_type}, {customer.relationship_status}) {writable&&hasPermission('customers:write')&&customer.relationship_status!=='archived'&&<button type="button" onClick={()=>void archiveLink(customer.customer_id)}>Verknüpfung archivieren</button>}</li>)}</ul>}
      {selected.customers!==null&&writable&&hasPermission('customers:write')&&<form onSubmit={linkCustomer}><select aria-label="Kunde verknüpfen" value={customerId} onChange={e=>setCustomerId(e.target.value)} required><option value="">Kunde verknüpfen …</option>{customers.filter(customer=>!selectedCustomers.some(link=>link.customer_id===customer.id&&link.relationship_status!=='archived')).map(customer=><option key={customer.id} value={customer.id}>{customer.name}{customer.customer_number?` · ${customer.customer_number}`:''}</option>)}</select><button>Verknüpfen</button></form>}
      <h3>Verträge</h3>{selected.contracts===null?<p>Keine Berechtigung für Verträge.</p>:<ul>{selectedContracts.map(contract=><li key={contract.id}>{contract.contract_number} · {contract.customer_name} · {contract.status}</li>)}</ul>}
      {selected.customers!==null&&hasPermission('contracts:write')&&hasPermission('customer_contacts:read')&&<form onSubmit={linkContract}><label>Kunde<select value={contractCustomer} onChange={e=>void chooseContractCustomer(e.target.value)} required><option value="">Kunde auswählen</option>{selectedCustomers.filter(customer=>customer.relationship_status==='active').map(customer=><option key={customer.customer_id} value={customer.customer_id}>{customer.customer_name}</option>)}</select></label><label>Vertrag<select value={contractId} onChange={e=>setContractId(e.target.value)} required><option value="">Vertrag auswählen</option>{availableContracts.filter(contract=>!contract.sites.some(site=>site.id===siteId)).map(contract=><option key={contract.id} value={contract.id}>{contract.contract_number}</option>)}</select></label><button>Vertrag verknüpfen</button></form>}
      </div>}
      {active==='struktur'&&<div className="object-detail-content">
      <h3>Gebäude, Bereiche und Zonen</h3>
      {writable&&<form onSubmit={createLocation}>
        <label>Bezeichnung<input value={locationForm.name} onChange={e=>setLocationForm({...locationForm,name:e.target.value})} required/></label>
        <label>Code<input value={locationForm.code} onChange={e=>setLocationForm({...locationForm,code:e.target.value})}/></label>
        <label>Strukturtyp<select aria-label="Strukturtyp" value={locationForm.location_type} onChange={e=>setLocationForm({...locationForm,location_type:e.target.value,parent_id:''})}><option value="building">Gebäude</option><option value="area">Bereich</option><option value="zone">Zone</option></select></label>
        <label>Übergeordnete Struktur<select aria-label="Übergeordnete Struktur" required={locationForm.location_type!=='building'} value={locationForm.parent_id} onChange={e=>setLocationForm({...locationForm,parent_id:e.target.value})}><option value="">{locationForm.location_type==='building'?'Keine übergeordnete Struktur':'Übergeordnete Struktur auswählen'}</option>{selected.locations.filter(location=>location.id!==editingLocation&&location.location_type===locationParentType).map(location=><option key={location.id} value={location.id}>{locationPath(location)}</option>)}</select></label>
        <label>Sicherheitsstufe<select aria-label="Sicherheitsstufe" value={locationForm.security_level} onChange={e=>setLocationForm({...locationForm,security_level:e.target.value})}>{Object.entries(classifications).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
        {hasPermission('employees:read')&&<label>Verantwortliche Person<select aria-label="Verantwortliche Person" value={locationForm.responsible_employee_id} onChange={e=>setLocationForm({...locationForm,responsible_employee_id:e.target.value})}><option value="">Keine verantwortliche Person</option>{siteAssignedEmployees.map(employee=><option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></label>}
        <label>Beschreibung<textarea value={locationForm.description} onChange={e=>setLocationForm({...locationForm,description:e.target.value})}/></label>
        <label>Gefahrenhinweise<textarea value={locationForm.hazard_notes} onChange={e=>setLocationForm({...locationForm,hazard_notes:e.target.value})}/></label>
        <label>Zutrittsregeln<textarea value={locationForm.access_rules} onChange={e=>setLocationForm({...locationForm,access_rules:e.target.value})}/></label>
        <label>Sortierung<input type="number" min="0" max="100000" value={locationForm.sort_order} onChange={e=>setLocationForm({...locationForm,sort_order:Number(e.target.value)})}/></label>
        <button>{editingLocation?'Struktur speichern':'Struktur anlegen'}</button>
        {editingLocation&&<button type="button" onClick={()=>{setEditingLocation(null);setLocationForm(emptyLocation);}}>Abbrechen</button>}
      </form>}
      <ul>{selected.locations.map(location=><li key={location.id}>{location.code||'–'} · {locationPath(location)} ({location.location_type}, Sicherheitsstufe {location.security_level}) · Verantwortlich: {location.responsible_employee_name||'–'}{writable&&<button type="button" onClick={()=>editLocation(location)}>Bearbeiten</button>}</li>)}</ul>
      </div>}
      {active==='gefaehrdungen'&&<div className="object-detail-content">
      <h3>Gefährdungen</h3>
      {writable&&<form onSubmit={createHazard}>
        {editingHazard&&<h4>Gefährdung bearbeiten</h4>}
        <label>Titel<input placeholder="Gefährdung" value={hazardForm.title} onChange={e=>setHazardForm({...hazardForm,title:e.target.value})} required/></label>
        <label>Beschreibung<textarea placeholder="Beschreibung" value={hazardForm.description} onChange={e=>setHazardForm({...hazardForm,description:e.target.value})} required/></label>
        <label>Kategorie<select aria-label="Gefährdungskategorie" value={hazardForm.category} onChange={e=>setHazardForm({...hazardForm,category:e.target.value})}>{Object.entries(hazardCategories).map(([category,label])=><option key={category} value={category}>{label}</option>)}</select></label>
        <label>Status<select aria-label="Gefährdungsstatus" value={hazardForm.status} onChange={e=>setHazardForm({...hazardForm,status:e.target.value})}><option value="open">Offen</option><option value="mitigated">Gemindert</option><option value="accepted">Akzeptiert</option><option value="closed">Geschlossen</option></select></label>
        <label>Bereich<select aria-label="Gefährdungsbereich" value={hazardForm.location_id} onChange={e=>setHazardForm({...hazardForm,location_id:e.target.value})}><option value="">Gesamtes Objekt</option>{selected.locations.map(location=><option key={location.id} value={location.id}>{location.name}</option>)}</select></label>
        <label>Eintritt<input type="number" min="1" max="5" value={hazardForm.likelihood} onChange={e=>setHazardForm({...hazardForm,likelihood:Number(e.target.value)})}/></label>
        <label>Auswirkung<input type="number" min="1" max="5" value={hazardForm.impact} onChange={e=>setHazardForm({...hazardForm,impact:Number(e.target.value)})}/></label>
        {hasPermission('employees:read')&&<label>Verantwortlich<select aria-label="Gefährdungsverantwortliche Person" value={hazardForm.responsible_employee_id} onChange={e=>setHazardForm({...hazardForm,responsible_employee_id:e.target.value})}><option value="">Nicht zugewiesen</option>{siteAssignedEmployees.map(employee=><option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></label>}
        <label>Fällig am<input type="date" value={hazardForm.due_on} onChange={e=>setHazardForm({...hazardForm,due_on:e.target.value})}/></label>
        <label>Überprüfung am<input type="date" value={hazardForm.review_on} onChange={e=>setHazardForm({...hazardForm,review_on:e.target.value})}/></label>
        <label>Schutzmaßnahmen<textarea value={hazardForm.protective_measures} onChange={e=>setHazardForm({...hazardForm,protective_measures:e.target.value})}/></label>
        <button>{editingHazard?'Gefährdung speichern':'Gefährdung erfassen'}</button>
        {editingHazard&&<button type="button" onClick={()=>{setEditingHazard(null);setHazardForm(emptyHazard);}}>Abbrechen</button>}
      </form>}
      <table className="object-risk-matrix" aria-label="Risikomatrix"><caption>Erfasste Gefährdungen nach Eintritt und Auswirkung</caption><thead><tr><th scope="col">Eintritt / Auswirkung</th>{[1,2,3,4,5].map(impact=><th scope="col" key={impact}>{impact}</th>)}</tr></thead><tbody>{[5,4,3,2,1].map(likelihood=><tr key={likelihood}><th scope="row">{likelihood}</th>{[1,2,3,4,5].map(impact=>{const riskScore=likelihood*impact,count=selected.hazards.filter(hazard=>hazard.risk_score===riskScore).length;return <td className={riskScore>=15?'critical-risk':riskScore>=8?'high-risk':riskScore>=4?'medium-risk':'low-risk'} key={impact} aria-label={`${likelihood} mal ${impact}: ${count} Gefährdungen`}>{count}</td>;})}</tr>)}</tbody></table>
      <ul>{selected.hazards.map(hazard=><li key={hazard.id}>
        <strong>{hazard.title}</strong> · Risiko {hazard.risk_score} · {hazard.status}{hazard.location_name?` · ${hazard.location_name}`:''} · Verantwortlich: {hazard.responsible_employee_name||'–'}
        {hazard.protective_measures&&<p>Bestehende Schutzmaßnahmen: {hazard.protective_measures}</p>}
        {writable&&<button type="button" onClick={()=>editHazard(hazard)}>Gefährdung bearbeiten</button>}
        {writable&&<button type="button" onClick={()=>editHazardMeasure(hazard)}>Maßnahme hinzufügen</button>}
        <ul aria-label={`Maßnahmen ${hazard.title}`}>
          {hazard.measures.map(measure=><li key={measure.id}>
            {measure.title} · {measure.status}{measure.due_on?` · Fällig am ${measure.due_on}`:''}{measure.responsible_employee_name?` · Verantwortlich: ${measure.responsible_employee_name}`:''}
            {measure.description&&<p>{measure.description}</p>}
            {measure.completed_at&&<p>Abgeschlossen am {new Date(measure.completed_at).toLocaleString('de-DE')}</p>}
            {writable&&<button type="button" onClick={()=>editHazardMeasure(hazard,measure)}>Maßnahme bearbeiten</button>}
          </li>)}
          {hazard.measures.length===0&&<li>Keine Maßnahmen erfasst.</li>}
        </ul>
        {measureHazardId===hazard.id&&writable&&<form onSubmit={saveHazardMeasure}>
          <label>Maßnahmentitel<input value={measureForm.title} onChange={event=>setMeasureForm({...measureForm,title:event.target.value})} required/></label>
          <label>Maßnahmenbeschreibung<textarea value={measureForm.description} onChange={event=>setMeasureForm({...measureForm,description:event.target.value})}/></label>
          {hasPermission('employees:read')&&<label>Maßnahmenverantwortliche Person<select aria-label="Maßnahmenverantwortliche Person" value={measureForm.responsible_employee_id} onChange={event=>setMeasureForm({...measureForm,responsible_employee_id:event.target.value})}><option value="">Nicht zugewiesen</option>{siteAssignedEmployees.map(employee=><option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></label>}
          <label>Maßnahme fällig am<input type="date" value={measureForm.due_on} onChange={event=>setMeasureForm({...measureForm,due_on:event.target.value})}/></label>
          <label>Maßnahmenstatus<select aria-label="Maßnahmenstatus" value={measureForm.status} onChange={event=>setMeasureForm({...measureForm,status:event.target.value as HazardMeasure['status']})}><option value="open">Offen</option><option value="in_progress">In Bearbeitung</option><option value="completed">Abgeschlossen</option><option value="cancelled">Abgebrochen</option></select></label>
          <button>{editingMeasureId?'Maßnahme speichern':'Maßnahme erfassen'}</button>
          <button type="button" onClick={()=>{setMeasureForm(emptyMeasure);setMeasureHazardId(null);setEditingMeasureId(null);}}>Abbrechen</button>
        </form>}
      </li>)}</ul>
      </div>}
      {active==='anweisungen'&&<div className="object-detail-content">
      <h3>Dienstanweisungen</h3>
      {writable&&<form onSubmit={createInstruction}><label>Titel<input placeholder="Titel" value={instructionForm.title} onChange={e=>setInstructionForm({...instructionForm,title:e.target.value})} required/></label><label>Inhalt<textarea placeholder="Inhalt" value={instructionForm.content} onChange={e=>setInstructionForm({...instructionForm,content:e.target.value})} required/></label><label>Geltungsbereich<select aria-label="Anweisungsbereich" value={instructionForm.location_id} onChange={e=>setInstructionForm({...instructionForm,location_id:e.target.value})}><option value="">Gesamtes Objekt</option>{selected.locations.map(location=><option key={location.id} value={location.id}>{location.name}</option>)}</select></label><label>Version<input type="number" min="1" value={instructionForm.version} onChange={e=>setInstructionForm({...instructionForm,version:Number(e.target.value)})}/></label><label>Gültig ab<input type="date" value={instructionForm.valid_from} onChange={e=>setInstructionForm({...instructionForm,valid_from:e.target.value})}/></label><label>Gültig bis<input type="date" value={instructionForm.valid_until} onChange={e=>setInstructionForm({...instructionForm,valid_until:e.target.value})}/></label><select aria-label="Anweisungsstatus" value={instructionForm.status} onChange={e=>setInstructionForm({...instructionForm,status:e.target.value})}><option value="draft">Entwurf</option><option value="pending_approval">Freigabe ausstehend</option></select><label><input type="checkbox" checked={instructionForm.requires_acknowledgement} onChange={e=>setInstructionForm({...instructionForm,requires_acknowledgement:e.target.checked})}/> Kenntnisnahme erforderlich</label><button>Anweisung speichern</button></form>}
      {writable&&hasPermission('employees:read')&&selected.staffing!==null&&<label>Mitarbeiter für Kenntnisnahme<select aria-label="Mitarbeiter für Kenntnisnahme" value={ackEmployee} onChange={e=>setAckEmployee(e.target.value)}><option value="">Mitarbeiter auswählen</option>{siteAssignedEmployees.map(employee=><option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></label>}
      <ul>{selected.instructions.map(instruction=><li key={instruction.id}><strong>{instruction.title} v{instruction.version}</strong> · {instruction.status} · {instruction.location_name||'Gesamtes Objekt'} · Kenntnisnahmen: {instruction.acknowledgement_count}<p>{instruction.content}</p>
        {instruction.status==='pending_approval'&&instruction.can_approve&&<><button type="button" onClick={()=>void approveInstruction(instruction.id)}>Freigabe erteilen</button><button type="button" onClick={()=>void returnInstructionForRevision(instruction.id)}>Zur Überarbeitung zurückgeben</button></>}
        {instruction.requires_acknowledgement&&hasPermission('employees:read')&&selected.staffing!==null&&<ul aria-label={`Kenntnisnahmestatus ${instruction.title} v${instruction.version}`}>
        {instruction.acknowledgements.map(acknowledgement=><li key={acknowledgement.employee_id}>{acknowledgement.employee_name}: Bestätigt am {new Date(acknowledgement.acknowledged_at).toLocaleString('de-DE')}</li>)}
        {siteAssignedEmployees.filter(employee=>!instruction.acknowledgements.some(acknowledgement=>acknowledgement.employee_id===employee.id)).map(employee=><li key={employee.id}>{employee.name}: Ausstehend</li>)}
      </ul>}{writable&&<button type="button" onClick={()=>{setSupersedesId(instruction.id);setInstructionForm({title:instruction.title,content:instruction.content,status:'draft',version:instruction.version+1,requires_acknowledgement:instruction.requires_acknowledgement,location_id:'',valid_from:'',valid_until:''});}}>Neue Version vorbereiten</button>}{writable&&hasPermission('employees:read')&&selected.staffing!==null&&isInstructionActive(instruction)&&<button type="button" disabled={!ackEmployee} onClick={()=>void acknowledge(instruction.id)}>Kenntnisnahme erfassen</button>}</li>)}</ul>
      {supersedesId&&<p>Neue Version: {instructionForm.version}</p>}
      </div>}
      {active==='personal'&&<div className="object-detail-content">
      <h3>Personalzuordnungen</h3>
      {selected.staffing===null?<p>Keine Berechtigung für Personalzuordnungen.</p>:selected.staffing.length===0?<p>Keine aktuellen oder zukünftigen Personalzuordnungen vorhanden.</p>:<ul>{selected.staffing.map(assignment=><li key={assignment.id}><strong>{assignment.employee_name}</strong>{assignment.primary_assignment?' · Hauptzuordnung':''} · {assignment.assignment_type}{assignment.role?` · ${assignment.role}`:''} · {new Date(`${assignment.starts_on}T00:00:00Z`).toLocaleDateString('de-DE',{timeZone:'UTC'})}{assignment.ends_on?` – ${new Date(`${assignment.ends_on}T00:00:00Z`).toLocaleDateString('de-DE',{timeZone:'UTC'})}`:' – offen'}</li>)}</ul>}
      {writable&&hasPermission('employees:read')&&hasPermission('employees:write')&&assignableEmployees.length>0&&<form onSubmit={createStaffingAssignment}>
        <h4>Personal dem Objekt zuordnen</h4>
        <label>Mitarbeiter<select required value={assignmentForm.employee_id} onChange={event=>setAssignmentForm({...assignmentForm,employee_id:event.target.value})}><option value="">Mitarbeiter auswählen</option>{assignableEmployees.map(employee=><option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></label>
        <label>Zuordnungstyp<select value={assignmentForm.assignment_type} onChange={event=>setAssignmentForm({...assignmentForm,assignment_type:event.target.value})}><option value="operational">Operativ</option><option value="management">Leitung</option><option value="support">Unterstützung</option><option value="temporary">Befristet</option><option value="reserve">Reserve</option></select></label>
        <label>Rolle<input value={assignmentForm.role} onChange={event=>setAssignmentForm({...assignmentForm,role:event.target.value})}/></label>
        <label>Beginn<input type="date" required value={assignmentForm.starts_on} onChange={event=>setAssignmentForm({...assignmentForm,starts_on:event.target.value})}/></label>
        <label>Ende<input type="date" value={assignmentForm.ends_on} onChange={event=>setAssignmentForm({...assignmentForm,ends_on:event.target.value})}/></label>
        <label>Notizen<textarea value={assignmentForm.notes} onChange={event=>setAssignmentForm({...assignmentForm,notes:event.target.value})}/></label>
        <label>Begründung für Audit<input required value={assignmentForm.reason} onChange={event=>setAssignmentForm({...assignmentForm,reason:event.target.value})}/></label>
        <button>Personalzuordnung anlegen</button>
      </form>}
      {writable&&hasPermission('employees:read')&&hasPermission('employees:write')&&assignableEmployees.length===0&&<p>Keine zusätzlichen Mitarbeitenden innerhalb des verfügbaren Berechtigungsumfangs auswählbar.</p>}
      </div>}
      {active==='dienstplanung'&&<div className="object-detail-content"><h3>Dienstplanung und Schichten</h3>
      {selected.shifts===null?<p>Keine Berechtigung für die Dienstplanung.</p>:selected.shifts.length===0?<p>Keine laufenden oder zukünftigen Schichten geplant.</p>:<ul>{selected.shifts.map(shift=><li key={shift.id}><strong>{shift.role_code}</strong> · {shift.period_name} ({shift.period_status}) · {new Date(shift.starts_at).toLocaleString('de-DE')} – {new Date(shift.ends_at).toLocaleString('de-DE')} · {shift.assignments.length?shift.assignments.map(assignment=>assignment.employee_name).join(', '):shift.assigned_count?`${shift.assigned_count} zugewiesen`:'Noch nicht zugewiesen'}
        {selected.staffing!==null&&hasPermission('scheduling:write')&&hasPermission('employees:read')&&availableShiftEmployees(shift).length>0&&<form onSubmit={event=>void assignShiftEmployee(event,shift)}>
          <label>Mitarbeiter für {shift.role_code}<select aria-label={`Mitarbeiter für ${shift.role_code}`} required value={shiftAssignmentRequests[shift.id]?.employee_id??''} onChange={event=>setShiftAssignmentRequests(current=>({...current,[shift.id]:{employee_id:event.target.value,client_mutation_id:current[shift.id]?.employee_id===event.target.value?current[shift.id].client_mutation_id:uuid()}}))}><option value="">Mitarbeiter auswählen</option>{availableShiftEmployees(shift).map(employee=><option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></label>
          <button disabled={!shiftAssignmentRequests[shift.id]?.employee_id}>Schicht besetzen</button>
        </form>}
      </li>)}</ul>}
      </div>}
      {active==='personal'&&<div className="object-detail-content">
      <h3>Qualifikationen der zugeordneten Mitarbeitenden</h3>
      {selected.qualifications==null?<p>Keine Berechtigung für Personal- und Qualifikationsdaten.</p>:selected.qualifications.length===0?<p>Keine Qualifikationen für aktuell zugeordnete Mitarbeitende vorhanden.</p>:<ul>{selected.qualifications.map(qualification=><li key={qualification.id}><strong>{qualification.employee_name}</strong> · {qualification.qualification_name??qualification.code} · {qualification.computed_status==='valid'?'Gültig':qualification.computed_status==='expiring'?'Läuft bald ab':qualification.computed_status==='expired'?'Abgelaufen':qualification.computed_status==='revoked'?'Widerrufen':'Ungültig'}{qualification.valid_from?` · ab ${new Date(`${qualification.valid_from}T00:00:00Z`).toLocaleDateString('de-DE',{timeZone:'UTC'})}`:''}{qualification.valid_until?` · bis ${new Date(`${qualification.valid_until}T00:00:00Z`).toLocaleDateString('de-DE',{timeZone:'UTC'})}`:' · ohne Ablaufdatum'}</li>)}</ul>}
      {hasPermission('qualifications:read')&&<button type="button" onClick={()=>navigate('/employees')}>Personalverwaltung öffnen</button>}
      </div>}
      {active==='kontrollgaenge'&&<div className="object-detail-content">
      <h3>Kontrollgangpläne und Abdeckung</h3>
      {selected.patrols===null?<p>Keine Berechtigung für Kontrollgänge.</p>:selected.patrols.routes.length===0?<p>Keine Kontrollgangpläne für dieses Objekt vorhanden.</p>:<ul>{selected.patrols.routes.map(route=><li key={route.id}>
        <strong>{route.name}</strong>{route.expected_start||route.expected_end?` · Geplant ${route.expected_start??'–'}–${route.expected_end??'–'}`:''}
        <p>Kontrollpunkte: {route.points.length?route.points.map(point=>`${point.sequence}. ${point.name}`).join(', '):'Keine Kontrollpunkte konfiguriert'}</p>
        <p>{route.assignments.length?`Zuweisungen: ${route.assignments.map(assignment=>`${assignment.employee_name??'Mitarbeiter zugewiesen'} (${new Date(assignment.starts_at).toLocaleString('de-DE')}${assignment.ends_at?` – ${new Date(assignment.ends_at).toLocaleString('de-DE')}`:' – offen'})`).join('; ')}`:'Keine aktuelle oder zukünftige Personalzuweisung'}</p>
      </li>)}</ul>}
      <h3>Letzte Kontrollpunktaktivitäten</h3>
      {selected.patrols===null?<p>Keine Berechtigung für Kontrollgänge.</p>:selected.patrols.recentScans.length===0?<p>Keine erfassten Kontrollpunktaktivitäten vorhanden.</p>:<ul>{selected.patrols.recentScans.map(scan=><li key={scan.id}>
        <strong>{scan.route_name}</strong> · {scan.control_point_name} · {new Date(scan.scanned_at).toLocaleString('de-DE')}{scan.employee_name?` · ${scan.employee_name}`:''} · {scan.deviation==='none'?'Ohne Abweichung':`Abweichung: ${scan.deviation}`}
      </li>)}</ul>}
      </div>}
      {active==='schluessel'&&<div className="object-detail-content">
      <h3>Schlüsselbestand</h3>
      {selected.keys===null?<p>Keine Berechtigung für Schlüssel.</p>:selected.keys.items.length===0?<p>Keine Schlüssel für dieses Objekt erfasst.</p>:<ul>{selected.keys.items.map(key=><li key={key.id}><strong>{key.label}</strong> · {key.key_code} · {key.key_type} · {key.status==='available'?'Verfügbar':key.status==='issued'?'Ausgegeben':key.status==='lost'?'Verloren':'Deaktiviert'}{key.status==='issued'?(key.holder_employee_id?' · an Mitarbeitende ausgegeben':' · an Benutzer ausgegeben'):''}
        {key.status==='available'&&hasPermission('keys:issue')&&hasPermission('employees:read')&&siteAssignedEmployees.length>0&&<button type="button" onClick={()=>{setKeyAction({keyId:key.id,action:'issue'});setKeyHolderEmployeeId('');setKeyActionReason('');}}>Ausgabe vorbereiten</button>}
        {key.status==='issued'&&hasPermission('keys:return')&&<button type="button" onClick={()=>{setKeyAction({keyId:key.id,action:'return'});setKeyActionReason('');}}>Rückgabe erfassen</button>}
        {keyAction?.keyId===key.id&&<form onSubmit={saveKeyAction}>
          <label>Grund<input required value={keyActionReason} onChange={event=>setKeyActionReason(event.target.value)}/></label>
          {keyAction.action==='issue'&&<label>Schlüsselhalter<select required value={keyHolderEmployeeId} onChange={event=>setKeyHolderEmployeeId(event.target.value)}><option value="">Mitarbeitende auswählen</option>{siteAssignedEmployees.map(employee=><option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></label>}
          <button>{keyAction.action==='issue'?'Schlüssel ausgeben':'Rückgabe bestätigen'}</button>
          <button type="button" onClick={()=>setKeyAction(null)}>Abbrechen</button>
        </form>}
      </li>)}</ul>}
      <h3>Schlüsselbunde</h3>
      {selected.keyBundles===null?<p>Keine Berechtigung für Schlüsselbunde.</p>:selected.keyBundles.length===0?<p>Keine Schlüsselbunde für dieses Objekt vorhanden.</p>:<ul>{selected.keyBundles.map(bundle=><li key={bundle.id}><strong>{bundle.name}</strong> · {bundle.status} · {bundle.item_count} Schlüssel ({bundle.issued_count} ausgegeben)</li>)}</ul>}
      <h3>Letzte Schlüsselbewegungen</h3>
      {selected.keys===null?<p>Keine Berechtigung für die Schlüsselhistorie.</p>:selected.keys.recentMovements.length===0?<p>Keine Schlüsselbewegungen erfasst.</p>:<ul>{selected.keys.recentMovements.map(movement=><li key={movement.id}><strong>{movement.key_label}</strong> · {movement.movement_type} · {movement.from_status??'–'} → {movement.to_status} · {new Date(movement.created_at).toLocaleString('de-DE')}{movement.employee_name?` · ${movement.employee_name}`:''}</li>)}</ul>}
      </div>}
      {active==='dokumente'&&<div className="object-detail-content">
      <h3>Objektdokumente</h3>
      {selected.documents===null?<p>Keine Berechtigung für DMS-Dokumente.</p>:selected.documents.length===0?<p>Keine DMS-Dokumente für dieses Objekt vorhanden.</p>:<ul>{selected.documents.map(document=><li key={document.id}><strong>{document.title}</strong> · {document.document_status}{document.description&&<p>{document.description}</p>}<ul>{document.versions.map(version=><li key={version.id}>Version {version.version_no} · {version.lifecycle_state} · {version.size_bytes} Bytes {version.lifecycle_state==='available'&&<button type="button" onClick={()=>void downloadDocument(document,version)}>Herunterladen</button>}</li>)}</ul></li>)}</ul>}
      {selected.documents!==null&&hasPermission('dms:write')&&<form onSubmit={uploadSiteDocument}><label>Dokumenttitel<input required value={documentTitle} onChange={event=>setDocumentTitle(event.target.value)}/></label><label>Datei<input ref={documentInput} required type="file" onChange={(event:ChangeEvent<HTMLInputElement>)=>setDocumentFile(event.target.files?.[0]??null)}/></label><button>Dokument hochladen und prüfen</button></form>}
      </div>}
      {active==='vorfaelle'&&<div className="object-detail-content">
      <h3>Alarme am Objekt</h3>
      {selected.alarms===null?<p>Keine Berechtigung für Alarme.</p>:selected.alarms.length===0?<p>Keine site- oder gerätebezogenen Alarme für dieses Objekt vorhanden.</p>:<ul>{selected.alarms.map(alarm=><li key={alarm.id}><strong>{alarm.priority_name??alarm.severity}</strong> · {alarm.type} · {alarm.status} · {new Date(alarm.triggered_at).toLocaleString('de-DE')}<p>{alarm.description}</p></li>)}</ul>}
      {hasPermission('alarms:read')&&<button type="button" onClick={()=>navigate('/alarms')}>Alarmverwaltung öffnen</button>}
      <h3>Einsätze</h3>
      {selected.incidents===null?<p>Keine Berechtigung für Einsätze.</p>:selected.incidents.length===0?<p>Keine Einsätze für dieses Objekt vorhanden.</p>:<ul>{selected.incidents.map(incident=><li key={incident.id}><strong>{incident.priority_name??'Einsatz'}</strong> · {incident.status} · {new Date(incident.created_at).toLocaleString('de-DE')} · {incident.assignees.length?incident.assignees.map(assignee=>assignee.name).join(', '):incident.assigned_count?`${incident.assigned_count} zugewiesen`:'Keine Zuweisung'}<p>{incident.description}</p></li>)}</ul>}
      {hasPermission('incidents:read')&&<button type="button" onClick={()=>navigate('/incidents')}>Einsatzverwaltung öffnen</button>}
      <h3>Objektbezogene Berichte und Nachweise</h3>
      {(hasPermission('customer_reports:export')||hasPermission('customer_portal:read'))?<><p>Die bestehende Berichtsfunktion kann Kontrollgänge, Wachbuch, Alarme oder Einsätze für dieses Objekt auswerten.</p><a href={`/customer-reports?site_id=${encodeURIComponent(selected.site.id)}`}>Berichte für dieses Objekt öffnen</a></>:<p>Keine Berechtigung für objektbezogene Berichte.</p>}
      </div>}
      {active==='aufgaben'&&<div className="object-detail-content">
      <h3>Kundenaufgaben und Wiedervorlagen</h3>
      {selected.customerTasks===null?<p>Keine Berechtigung für Kundenaufgaben.</p>:selected.customerTasks.length===0?<p>Keine Kundenaufgaben für aktive Objektbeziehungen vorhanden.</p>:<ul>{selected.customerTasks.map(task=><li key={task.id}><strong>{task.title}</strong> · {task.customer_name} · {task.status} · {task.due_at?new Date(task.due_at).toLocaleString('de-DE'):'Ohne Frist'}{task.assigned_employee_name?` · ${task.assigned_employee_name}`:''}{task.description&&<p>{task.description}</p>}{task.status==='open'&&hasPermission('customers:write')&&<button type="button" onClick={()=>void completeCustomerTask(task)}>Als erledigt markieren</button>}</li>)}</ul>}
      {selected.customers!==null&&hasPermission('customers:write')&&<form onSubmit={createCustomerTask}><label>Kunde<select required value={taskCustomerId} onChange={event=>setTaskCustomerId(event.target.value)}><option value="">Kunde auswählen</option>{selectedCustomers.filter(customer=>customer.relationship_status==='active').map(customer=><option key={customer.customer_id} value={customer.customer_id}>{customer.customer_name}</option>)}</select></label><label>Aufgabe / Wiedervorlage<input required value={taskTitle} onChange={event=>setTaskTitle(event.target.value)}/></label><label>Fällig am<input type="datetime-local" value={taskDue} onChange={event=>setTaskDue(event.target.value)}/></label>{hasPermission('employees:read')&&<label>Verantwortlich<select value={taskAssignee} onChange={event=>setTaskAssignee(event.target.value)}><option value="">Nicht zugewiesen</option>{employees.map(employee=><option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></label>}<button>Aufgabe anlegen</button></form>}
      </div>}
      {active==='technik'&&<div className="object-detail-content">
      <h3>Technik und Instandhaltung</h3>
      {selected.maintenance===null?<p>Keine Berechtigung für Wartungseinträge im Wachbuch.</p>:selected.maintenance.length===0?<p>Keine Technik- oder Instandhaltungseinträge vorhanden.</p>:<ul>{selected.maintenance.map(entry=><li key={entry.id}><strong>{entry.priority_name}</strong> · {entry.status} · Version {entry.revision_no} · {new Date(entry.created_at).toLocaleString('de-DE')}<p>{entry.content}</p></li>)}</ul>}
      {maintenanceReadable&&hasPermission('watchbook:read')&&hasPermission('watchbook:write')&&<form onSubmit={createMaintenanceEntry}>
        <h4>Technik-/Instandhaltungseintrag erfassen</h4>
        <label>Priorität<select required value={maintenancePriorityCode} onChange={event=>setMaintenancePriorityCode(event.target.value)} disabled={!maintenanceOptionsLoaded}>{maintenancePriorities.map(priority=><option key={priority.code} value={priority.code}>{priority.name}</option>)}</select></label>
        <label>Eintrag<textarea required maxLength={10000} value={maintenanceContent} onChange={event=>setMaintenanceContent(event.target.value)}/></label>
        <button disabled={!maintenanceOptionsLoaded||!maintenanceCategoryId||!maintenancePriorityCode}>Im Wachbuch erfassen</button>
      </form>}
      </div>}
      {active==='journal'&&<div className="object-detail-content">
      <h3>Objektjournal</h3>{selected.journal===null?<p>Keine Berechtigung für das Wachbuch.</p>:<ul>{selected.journal.map(entry=><li key={entry.id}><strong>{entry.category_name}</strong> · {entry.priority_name} · {entry.status} · Version {entry.revision_no} · {new Date(entry.created_at).toLocaleString('de-DE')}<p>{entry.content}</p></li>)}</ul>}
      </div>}
    </article>:detailLoading?<p role="status">Objektakte wird geladen …</p>:null):<>
      <div className="object-page-actions">{writable&&<button type="button" onClick={()=>startEdit()}>+ Objekt anlegen</button>}</div>
      {listLoading?<p role="status">Objekte werden geladen …</p>:<div className="object-metrics" aria-label="Objektkennzahlen">
        <article><strong>{metrics?.total_sites??'–'}</strong><span>Objekte gesamt</span></article>
        <article><strong>{metrics?.active_sites??'–'}</strong><span>Aktiv</span></article>
        <article><strong>{metrics?.preparation_sites??'–'}</strong><span>In Vorbereitung</span></article>
        <article><strong>{metrics?.restricted_sites??'–'}</strong><span>Eingeschränkt</span></article>
        <article><strong>{metrics?.critical_sites??'–'}</strong><span>Kritisch</span></article>
        <article><strong>{metrics?.open_hazards??'–'}</strong><span>Offene Gefährdungen</span></article>
        <article><strong>{metrics?.overdue_measures??'–'}</strong><span>Überfällige Maßnahmen</span></article>
        <article><strong>{metrics?.expiring_contracts??'–'}</strong><span>Auslaufende Verträge · 30 Tage</span></article>
        <article><strong>{metrics?.sites_without_available_documents??'–'}</strong><span>Ohne verfügbare DMS-Version</span></article>
      </div>}
      {formOpen&&writable&&<form onSubmit={save} className="object-create-form">
        <label>Objektname<input required value={form.name} onChange={e=>setForm({...form,name:e.target.value})}/></label>
        <label>Objektnummer<input value={form.site_number} onChange={e=>setForm({...form,site_number:e.target.value})}/></label>
        <label>Adresse<input value={form.address} onChange={e=>setForm({...form,address:e.target.value})}/></label>
        <label>Status<select value={form.status} onChange={e=>setForm({...form,status:e.target.value})}>{Object.entries(statuses).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
        <label>Sicherheitsklassifizierung<select value={form.security_classification} onChange={e=>setForm({...form,security_classification:e.target.value})}>{Object.entries(classifications).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
        <button>Speichern</button><button type="button" onClick={()=>setFormOpen(false)}>Abbrechen</button>
      </form>}
      <div className="object-overview">
        <div className="object-filterbar">
          <input aria-label="Objekte suchen" placeholder="Name, Nummer, Kunde, Adresse oder Leitung suchen" value={search} onChange={e=>{setSearch(e.target.value);setPage(1);}}/>
          <select aria-label="Status" value={statusFilter} onChange={e=>{setStatusFilter(e.target.value);setPage(1);}}><option value="all">Status: Alle</option>{Object.entries(statuses).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select>
          <select aria-label="Sicherheitsstufe filtern" value={securityFilter} onChange={e=>{setSecurityFilter(e.target.value);setPage(1);}}><option value="all">Sicherheitsstufe: Alle</option>{Object.entries(classifications).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select>
          <select aria-label="Kunde filtern" value={customerFilter} onChange={e=>{setCustomerFilter(e.target.value);setPage(1);}}><option value="all">Kunde: Alle</option>{customerOptions.map(customer=><option key={customer} value={customer}>{customer}</option>)}</select>
          <select aria-label="Objektleitung filtern" value={managerFilter} onChange={e=>{setManagerFilter(e.target.value);setPage(1);}}><option value="all">Objektleitung: Alle</option>{managerOptions.map(([id,name])=><option key={id} value={id}>{name}</option>)}</select>
          <select aria-label="Objektart filtern" value={siteTypeFilter} onChange={e=>{setSiteTypeFilter(e.target.value);setPage(1);}}><option value="all">Objektart: Alle</option>{siteTypeOptions.map(siteType=><option key={siteType} value={siteType}>{siteType}</option>)}</select>
          <details className="object-column-picker"><summary>Spalten</summary><fieldset><legend>Sichtbare Tabellenspalten</legend>{siteColumns.map(column=><label key={column.key}><input type="checkbox" checked={visibleColumns.includes(column.key)} onChange={event=>toggleColumn(column.key,event.target.checked)}/>{column.label}</label>)}</fieldset></details>
          <button type="button" onClick={exportCsv} disabled={listLoading||sites.length===0}>CSV exportieren</button>
        </div>
        {listLoading?<p role="status">Objekte werden geladen …</p>:sites.length===0?<p className="object-empty" role="status">Für Ihren Berechtigungsumfang sind keine Objekte verfügbar.</p>:<div className="object-table"><table aria-label="Objektübersicht"><thead><tr>{siteColumns.filter(column=>visibleColumns.includes(column.key)).map(column=><th key={column.key} aria-sort={sortKey===column.key?(descending?'descending':'ascending'):'none'}><button type="button" onClick={()=>changeSort(column.key)}>{column.label}</button></th>)}<th>Aktion</th></tr></thead><tbody>
          {sorted.slice((currentPage-1)*10,currentPage*10).map(site=><tr key={site.id}>{siteColumns.filter(column=>visibleColumns.includes(column.key)).map(column=><td key={column.key}>{column.key==='name'?<button className="object-name-link" type="button" onClick={()=>navigate(`/sites/${site.id}`)}>{site.name}</button>:displayValue(site,column.key)}</td>)}<td>{writable&&<><button type="button" onClick={()=>startEdit(site)}>Bearbeiten</button>{['planning','setup','decommissioned'].includes(site.status)&&<button type="button" onClick={()=>void archive(site)}>Archivieren</button>}</>}</td></tr>)}
        </tbody></table>{filtered.length===0&&<p className="object-empty">Keine Objekte entsprechen den aktiven Filtern.</p>}
        {filtered.length>0&&<div className="object-pagination"><span>{filtered.length} Objekte · Seite {currentPage} von {pages}</span><button type="button" disabled={currentPage===1} onClick={()=>setPage(value=>Math.max(1,value-1))}>Zurück</button><button type="button" disabled={currentPage===pages} onClick={()=>setPage(value=>Math.min(pages,value+1))}>Weiter</button></div>}</div>}
      </div>
    </>}
  </section>;
}
