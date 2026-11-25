import {ChangeEvent,FormEvent,useEffect,useRef,useState} from 'react';
import {Link,useNavigate,useParams,useSearchParams} from 'react-router-dom';
import {api,csrf,hasPermission} from '../lib/api';
import {uuid} from '../lib/uuid';

type Site={id:string;name:string;site_number?:string|null;status:string;security_classification:string;address?:string|null;alias?:string|null;site_type?:string|null;description?:string|null;street?:string|null;house_number?:string|null;postal_code?:string|null;city?:string|null;contact_person?:string|null;object_manager_employee_id?:string|null;operations_manager_employee_id?:string|null;required_staff_count?:number;updated_at?:string};
type SiteOverview=Site&{customer_names:string[]|null;object_manager_name:string|null;operations_manager_name:string|null;assigned_employee_count:number|null;active_contract_count:number|null;expiring_contract_count:number|null;contract_statuses:string[]|null;open_hazard_count:number;critical_hazard_count:number;overdue_measure_count:number;open_task_count:number|null;overdue_task_count:number|null;open_shift_count:number|null;undercovered_shift_count:number|null;understaffed:boolean;available_document_count:number|null;valid_document_count:number|null;unapproved_document_count:number|null;expired_document_count:number|null;expiring_7d_document_count:number|null;expiring_30d_document_count:number|null;review_due_document_count:number|null;missing_requirement_count:number|null;open_maintenance_count:number|null;overdue_maintenance_count:number|null;last_activity:string|null};
type OverviewMetrics={total_sites:number;active_sites:number;preparation_sites:number;restricted_sites:number;critical_sites:number;sites_with_critical_hazards:number;sites_with_open_tasks:number;sites_with_understaffing:number;open_hazards:number|null;overdue_measures:number|null;open_tasks:number|null;overdue_tasks:number|null;open_shifts:number|null;undercovered_shifts:number|null;expiring_contracts:number|null;sites_without_available_documents:number|null;valid_documents:number|null;expired_documents:number|null;documents_expiring_7d:number|null;documents_expiring_30d:number|null;documents_review_due:number|null;unapproved_documents:number|null;missing_required_documents:number|null;open_maintenance:number|null;overdue_maintenance:number|null};
type PriorityAction={id:string;site_id?:string|null;site_name?:string|null;entity_id?:string|null;employee_id?:string|null;severity:'critical'|'high'|'medium';priority?:'A'|'B'|'C';category:string;title:string;detail:string;due_on:string|null;tab:string;permission:string;target:string};
type SiteOverviewResponse={sites:SiteOverview[];metrics:OverviewMetrics;priorityActions?:PriorityAction[]};
type SiteColumn='site_number'|'name'|'site_type'|'customer_names'|'address'|'object_manager_name'|'operations_manager_name'|'security_classification'|'status'|'assigned_employee_count'|'active_contract_count'|'open_hazard_count'|'open_task_count'|'contract_statuses'|'understaffed'|'last_activity';
type Customer={id:string;name:string;customer_number?:string|null};
type Employee={id:string;name:string};
type StaffingAssignment={id:string;employee_id:string;employee_name:string;employee_number?:string|null;employment_status?:string|null;assignment_type:string;role:string|null;starts_on:string;ends_on:string|null;primary_assignment:boolean;notes:string|null};
type ScheduledShift={id:string;period_id:string;period_name:string;period_status:string;period_starts_at:string;period_ends_at:string;role_code:string;starts_at:string;ends_at:string;assigned_count:number;assignments:{id:string;employee_id:string;employee_name:string}[]};
type PatrolRoute={id:string;name:string;expected_start:string|null;expected_end:string|null;points:{control_point_id:string;name:string;sequence:number;expected_offset_seconds:number|null}[];assignments:{id:string;starts_at:string;ends_at:string|null;employee_name:string|null}[]};
type PatrolScan={id:string;scanned_at:string;deviation:string;route_id:string;route_name:string;control_point_id:string;control_point_name:string;employee_name:string|null};
type KeyRecord={id:string;key_code:string;label:string;key_type:string;status:string;holder_user_id:string|null;holder_employee_id:string|null;issued_at:string|null;returned_at:string|null;lost_at:string|null;deactivated_at:string|null};
type KeyMovement={id:string;key_id:string;key_label:string;movement_type:string;from_status:string|null;to_status:string;created_at:string;employee_name:string|null};
type KeyBundle={id:string;name:string;status:string;item_count:number;issued_count:number};
type DmsVersion={id:string;version_no:number;size_bytes:number;content_type:string;lifecycle_state:string;created_at:string;retention_until:string|null};
type DocumentStatus='gueltig'|'lauf_bald_ab'|'bald_pruefpflichtig'|'abgelaufen'|'fehlend'|'nicht_freigegeben'|'pruefung_ausstehend'|'noch_nicht_gueltig';
type ExpiryBucket='expired'|'within_7_days'|'within_8_30_days'|'within_31_60_days'|'beyond_60_days'|'no_expiry';
type SiteDocument={id:string;title:string;description:string|null;document_status:string;created_at:string;deleted_at:string|null;document_number:string|null;document_type:string|null;responsible_employee_id:string|null;valid_from:string|null;valid_until:string|null;review_on:string|null;reviewed_at?:string|null;approval_status:string;location_id:string|null;versions:DmsVersion[];computed_status?:DocumentStatus;status_label?:string;expiry_bucket?:ExpiryBucket;days_until_expiry?:number|null;review_state?:'none'|'pending'|'due_soon'|'overdue';is_approved?:boolean;is_currently_valid?:boolean;is_reviewed?:boolean};
type SiteAlarm={id:string;type:string;description:string;severity:string;status:string;triggered_at:string;acknowledged_at:string|null;resolved_at:string|null;priority_name:string|null};
type SiteIncident={id:string;alarm_id:string|null;description:string;status:string;created_at:string;updated_at:string;priority_name:string|null;employee_name:string|null;assigned_count:number;assignees:{id:string;name:string}[]};
type CustomerTask={id:string;customer_id:string;customer_name:string;title:string;description:string|null;status:string;due_at:string|null;assigned_employee_name:string|null;created_at:string;completed_at:string|null};
type MaintenanceEntry={id:string;created_at:string;revision_no:number;content:string;status:string;priority_name:string};
type WatchbookCategory={id:string;code:string;name:string};
type WatchbookPriority={code:string;name:string};
type InstructionAcknowledgement={employee_id:string;employee_name:string;acknowledged_at:string};
type QualificationIssue={code:string;label:string;detail:string;severity:'critical'|'high'|'medium'};
type EmployeeQualification={id:string;employee_id:string;employee_name:string;code:string;qualification_name:string|null;valid_from:string|null;valid_until:string|null;status:string;computed_status:string;days_until_expiry?:number|null;issue?:QualificationIssue|null;evidence_status?:string|null;evidence_label?:string|null;evidence_document_id?:string|null;evidence_document_title?:string|null;last_checked_at?:string|null;employee_url?:string|null};
type HandoverSummary={id:string;shift_id:string|null;title:string;status:string;created_at:string;participant_count:number;confirmation_count:number};
type DocumentRequirement={id:string;document_type:string;required:boolean;responsible_employee_id:string|null;responsible_employee_name:string|null;missing:boolean;requirement_status?:DocumentStatus;status_label?:string;matching_document_id?:string|null;is_approved?:boolean;is_currently_valid?:boolean;is_reviewed?:boolean;review_state?:'none'|'pending'|'due_soon'|'overdue';days_until_expiry?:number|null};
type MaintenanceOrder={id:string;site_id:string;device_id:string;device_name:string|null;asset_number:string|null;order_number:string;maintenance_type:string;description:string;priority_code:string;due_on:string|null;status:string;computed_status:'planned'|'open'|'in_progress'|'overdue'|'completed'|'cancelled';status_label:string;overdue:boolean;responsible_employee_id:string|null;responsible_employee_name:string|null;performed_work:string|null;result:string|null;remarks:string|null;next_maintenance_on:string|null;documents:{id:string;document_id:string;document_title?:string|null;document_status?:string|null;computed_status?:string|null}[];created_at:string};
type PersonnelSummary={assigned_employee_count:number;expiring_qualification_count:number;invalid_qualification_count:number;qualification_issue_count?:number;blocking_qualification_issue_count?:number;expiring_qualifications:EmployeeQualification[];invalid_qualifications?:EmployeeQualification[];qualification_issues?:EmployeeQualification[];pending_acknowledgement_count:number;missing_acknowledgements:{instruction_id:string;title:string;version:number;target?:string;missing_employee_ids:string[];missing_employees:{employee_id:string;employee_name:string;employee_url?:string}[]}[]};
type PersonnelChange={occurred_at:string;event_type:string;entity_id:string|null;employee_id:string|null;employee_name:string|null;actor_email:string|null;details:Record<string,unknown>};
type EligibilityLink={type:'employee'|'qualification'|'instruction'|'absence';id:string;label:string};
type EligibilityReason={code:string;message:string;link:EligibilityLink|null};
type ShiftEligibility={shift_id:string;site_id:string;required_qualification_codes:string[];employees:{employee_id:string;employee_name:string;status:'eligible'|'restricted'|'ineligible';reasons:EligibilityReason[];matched_qualification_codes:string[];missing_qualification_codes:string[]}[]};
type ChronicleLink={target:string;label:string;permission:string;entity_id?:string|null;entity_type?:string|null;record_available?:boolean;verification_type?:string|null;fallback_target?:string|null;evidence_id?:string|null;evidence_fallback_target?:string|null};
type ChronicleEvent={id:string;site_id:string;occurred_at:string;event_kind:string;entity_type:string;entity_id:string;category:string;summary:string;details:Record<string,unknown>;actor_user_id:string|null;actor_email:string|null;actor_employee_name:string|null;source_table:string;link?:ChronicleLink|null};
type ObjectDevice={id:string;name:string;status:string;site_id:string|null;last_seen_at:string|null;metadata:Record<string,unknown>;asset_number:string|null;category:string|null;manufacturer:string|null;model:string|null;serial_number:string|null;location_id:string|null;responsible_employee_id:string|null;operational_status:string;installed_on:string|null;commissioned_on:string|null;last_inspection_on:string|null;next_inspection_on:string|null;maintenance_interval_days:number|null;next_maintenance_on:string|null;last_maintenance_on:string|null;created_at:string;updated_at:string};
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
  assignmentHistory:StaffingAssignment[]|null;
  shifts:ScheduledShift[]|null;
  patrols:{routes:PatrolRoute[];recentScans:PatrolScan[]}|null;
  keys:{items:KeyRecord[];recentMovements:KeyMovement[]}|null;
  keyBundles:KeyBundle[]|null;
  documents:SiteDocument[]|null;
  documentStatusCounts?:Record<DocumentStatus,number>|null;
  documentWarningCounts?:Record<string,number>|null;
  documentRequirements:DocumentRequirement[]|null;
  alarms:SiteAlarm[]|null;
  incidents:SiteIncident[]|null;
  customerTasks:CustomerTask[]|null;
  maintenance:MaintenanceEntry[]|null;
  maintenanceOrders:MaintenanceOrder[]|null;
  maintenanceStatusCounts?:Record<string,number>|null;
  qualifications:EmployeeQualification[]|null;
  personnelSummary?:PersonnelSummary|null;
  recentPersonnelChanges?:PersonnelChange[]|null;
  handovers:HandoverSummary[]|null;
  devices:ObjectDevice[]|null;
  priorityActions?:PriorityAction[];
};
const statuses:Record<string,string>={planning:'Planung',setup:'Einrichtung',active:'Aktiv',restricted:'Eingeschränkt',temporarily_closed:'Temporär geschlossen',decommissioned:'Stillgelegt',archived:'Archiviert'};
const classifications:Record<string,string>={unknown:'Offen',low:'Niedrig',medium:'Mittel',high:'Hoch',critical:'Kritisch'};
const documentStatusLabels:Record<DocumentStatus,string>={gueltig:'Gültig',lauf_bald_ab:'Läuft bald ab',bald_pruefpflichtig:'Bald prüfpflichtig',abgelaufen:'Abgelaufen',fehlend:'Fehlt',nicht_freigegeben:'Nicht freigegeben',pruefung_ausstehend:'Prüfung ausstehend',noch_nicht_gueltig:'Noch nicht gültig'};
const reviewStateLabels:Record<'none'|'pending'|'due_soon'|'overdue',string>={none:'Keine Prüffrist',pending:'Prüfung ausstehend',due_soon:'Prüfung bald fällig',overdue:'Prüfung überfällig'};
const approvalLabels:Record<string,string>={approved:'Freigegeben',pending_approval:'Freigabe ausstehend',draft:'Entwurf',rejected:'Abgelehnt',archived:'Archiviert'};
const instructionStatusLabels:Record<string,string>={draft:'Entwurf',pending_approval:'Freigabe ausstehend',approved:'Freigegeben',returned_for_revision:'Zur Überarbeitung',archived:'Archiviert'};
const hazardStatusLabels:Record<string,string>={open:'Offen',mitigated:'Gemindert',accepted:'Akzeptiert',closed:'Geschlossen'};
const measureStatusLabels:Record<string,string>={open:'Offen',in_progress:'In Bearbeitung',completed:'Abgeschlossen',cancelled:'Abgebrochen'};
const maintenanceTypeLabels:Record<string,string>={inspection:'Prüfung',preventive:'Vorbeugend',corrective:'Korrigierend',repair:'Reparatur',other:'Sonstige'};
const priorityLabels:Record<string,string>={critical:'Kritisch',high:'Hoch',medium:'Mittel',low:'Niedrig'};
const eligibilityLabels:Record<'eligible'|'restricted'|'ineligible',string>={eligible:'Einsatzfähig',restricted:'Eingeschränkt einsatzfähig',ineligible:'Nicht einsatzfähig'};
const hazardCategories:Record<string,string>={burglary:'Einbruch',theft:'Diebstahl',vandalism:'Vandalismus',fire:'Brand',robbery:'Raub',unauthorized_access:'Unbefugter Zutritt',sabotage:'Sabotage',conflict:'Konflikt',technical:'Technisch',environmental:'Umwelt',other:'Sonstige'};
const emptySite={name:'',site_number:'',address:'',status:'planning',security_classification:'unknown',required_staff_count:0};
const emptyLocation={name:'',location_type:'building',code:'',parent_id:'',responsible_employee_id:'',security_level:'unknown',description:'',hazard_notes:'',access_rules:'',sort_order:0};
const emptyHazard={title:'',category:'other',description:'',likelihood:1,impact:1,location_id:'',responsible_employee_id:'',due_on:'',review_on:'',status:'open',protective_measures:''};
const emptyMeasure={title:'',description:'',responsible_employee_id:'',due_on:'',status:'open' as const};
type SiteForm=typeof emptySite;
const tabs=[['uebersicht','Übersicht'],['stammdaten','Stammdaten'],['kunden','Kunden & Verträge'],['struktur','Gebäude & Bereiche'],['personal','Mitarbeiter & Verantwortlichkeiten'],['dienstplanung','Dienstplanung'],['gefaehrdungen','Gefährdungen & Sicherheit'],['anweisungen','Dienstanweisungen'],['kontrollgaenge','Kontrollgänge'],['schluessel','Schlüssel & Zutritt'],['technik','Ausstattung & Technik'],['dokumente','Dokumente'],['vorfaelle','Vorfälle & Berichte'],['aufgaben','Aufgaben & Maßnahmen'],['journal','Journal']] as const;
const tabGroups=[
  {label:'Organisation',keys:['stammdaten','kunden','personal','dienstplanung']},
  {label:'Sicherheit',keys:['struktur','gefaehrdungen','anweisungen','kontrollgaenge','schluessel']},
  {label:'Betrieb',keys:['technik','dokumente','vorfaelle','aufgaben','journal']},
] as const;
const sectionAliases:Record<string,string>={qualifikationen:'personal',einsaetze:'vorfaelle',berichte:'vorfaelle',uebergaben:'uebersicht'};
const siteColumns:{key:SiteColumn;label:string}[]=[
  {key:'site_number',label:'Objektnummer'},{key:'name',label:'Objekt'},{key:'site_type',label:'Objektart'},
  {key:'customer_names',label:'Kunde'},{key:'address',label:'Standort / Adresse'},
  {key:'object_manager_name',label:'Objektleitung'},{key:'operations_manager_name',label:'Einsatzleitung'},
  {key:'security_classification',label:'Sicherheitsstufe'},{key:'status',label:'Status'},
  {key:'assigned_employee_count',label:'Mitarbeiter'},{key:'active_contract_count',label:'Aktive Verträge'},
  {key:'open_hazard_count',label:'Offene Gefährdungen'},{key:'open_task_count',label:'Offene Aufgaben'},
  {key:'contract_statuses',label:'Vertragsstatus'},{key:'understaffed',label:'Personalunterdeckung'},
  {key:'last_activity',label:'Letzte Aktivität'},
];

function toBase64(file:File){
  return file.arrayBuffer().then(bytes=>{
    let binary='';const values=new Uint8Array(bytes);
    for(let index=0;index<values.length;index+=0x8000)binary+=String.fromCharCode(...values.subarray(index,index+0x8000));
    return btoa(binary);
  });
}

function formatDue(due:string|null|undefined){
  if(!due)return null;
  const date=new Date(`${String(due).slice(0,10)}T00:00:00Z`);
  return Number.isNaN(date.getTime())?String(due):date.toLocaleDateString('de-DE',{timeZone:'UTC'});
}
function qualificationReason(qualification:EmployeeQualification){
  if(qualification.issue)return `${qualification.issue.label}: ${qualification.issue.detail}`;
  if(qualification.computed_status==='expired'||qualification.computed_status==='revoked'||qualification.computed_status==='invalid')return qualification.computed_status==='expired'?'Abgelaufen':qualification.computed_status==='revoked'?'Widerrufen':'Ungültig';
  if(qualification.computed_status==='expiring')return qualification.days_until_expiry!=null?`Läuft bald ab: noch ${qualification.days_until_expiry} Tage`:'Läuft bald ab';
  return 'Keine offene Qualifikationswarnung';
}
function qualificationEvidence(qualification:EmployeeQualification){
  if(qualification.evidence_label)return qualification.evidence_label;
  if(qualification.evidence_status==='missing')return 'Kein Nachweis verknüpft';
  if(qualification.evidence_document_title)return `Nachweis: ${qualification.evidence_document_title}`;
  return 'Nachweisstatus nicht verfügbar';
}
function priorityOf(action:PriorityAction):'A'|'B'|'C'{
  return action.priority??(action.severity==='critical'?'A':action.severity==='high'?'B':'C');
}
const priorityGroups=[['A','Sofort handeln'],['B','Zeitnah bearbeiten'],['C','Objektinformationen']] as const;

function PriorityActionList({actions,title,showSite=false}:{actions:PriorityAction[];title:string;showSite?:boolean}){
  const visible=actions.filter(action=>hasPermission(action.permission));
  return <section className="object-priority-actions" aria-label={title}>
    <h3>{title}</h3>
    <div className="object-priority-levels">{priorityGroups.map(([level,label])=>{
      const group=visible.filter(action=>priorityOf(action)===level);
      return <div key={level} className={`object-priority-level object-priority-level-${level}`} data-priority={level}>
        <h4>{level} – {label}</h4>
        {group.length===0?<p className="object-priority-empty">Keine Einträge.</p>:<ol>{group.map(action=><li key={action.id} className={`object-priority-${action.severity}`}>
          <Link to={action.target}>{action.title}</Link>
          <span className="object-action-meta">{action.category} · {priorityLabels[action.severity]??action.severity}{showSite&&action.site_name?` · ${action.site_name}`:''}{action.due_on?` · fällig ${formatDue(action.due_on)}`:''}</span>
          <span className="object-action-detail">{action.detail}</span>
        </li>)}</ol>}
      </div>;
    })}</div>
  </section>;
}

type FocusRecord={param:string;label:string;id:string;title:string;meta:string[];description?:string|null};
const focusParams=['maintenance_order','device','document','requirement','location','hazard','measure','instruction','assignment','key','key_bundle','period','shift','shift_assignment','entry','alarm','incident','handover','task','employee'] as const;

function findFocusRecord(context:Context,params:URLSearchParams,section:string):FocusRecord|undefined|null{
  const specs:Array<{param:string;tab:string;label:string;find:(id:string)=>any;describe:(item:any,id:string)=>Omit<FocusRecord,'param'|'label'|'id'>}>=[
    {param:'maintenance_order',tab:'technik',label:'Wartungsauftrag',find:id=>context.maintenanceOrders?.find(item=>item.id===id),describe:item=>({title:item.order_number??'Wartungsauftrag',meta:[item.status_label??item.status,item.device_name??'Kein Gerät',item.due_on?`fällig ${formatDue(item.due_on)}`:'Kein Fälligkeitsdatum',item.responsible_employee_name??'Keine verantwortliche Person'],description:item.description})},
    {param:'device',tab:'technik',label:'Gerät',find:id=>context.devices?.find(item=>item.id===id),describe:item=>({title:item.name??'Gerät',meta:[item.asset_number??'Keine Inventarnummer',item.category??'Ohne Kategorie',item.operational_status??item.status,item.location_id??'Kein Bereich'],description:item.metadata?JSON.stringify(item.metadata):null})},
    {param:'document',tab:'dokumente',label:'Dokument',find:id=>context.documents?.find(item=>item.id===id),describe:item=>({title:item.title??'Dokument',meta:[item.status_label??item.computed_status??item.document_status,item.approval_status,item.document_type??'Ohne Typ',item.valid_until?`gültig bis ${formatDue(item.valid_until)}`:'Ohne Ablaufdatum',`${item.versions?.length??0} Version(en)`],description:item.description})},
    {param:'requirement',tab:'dokumente',label:'Pflichtdokument',find:id=>context.documentRequirements?.find(item=>item.id===id),describe:item=>({title:item.document_type??'Pflichtdokument',meta:[item.required?'Pflicht':'Optional',item.status_label??(item.missing?'Fehlt oder nicht gültig':'Erfüllt'),item.responsible_employee_name??'Keine verantwortliche Person']})},
    {param:'location',tab:'struktur',label:'Bereich',find:id=>context.locations.find(item=>item.id===id),describe:item=>({title:item.name??'Bereich',meta:[item.code??'Ohne Code',item.location_type,item.security_level,item.responsible_employee_name??'Keine verantwortliche Person'],description:item.description})},
    {param:'hazard',tab:'gefaehrdungen',label:'Gefährdung',find:id=>context.hazards.find(item=>item.id===id),describe:item=>({title:item.title??'Gefährdung',meta:[hazardCategories[item.category]??item.category,`Risikoscore ${item.risk_score}`,hazardStatusLabels[item.status]??item.status,item.location_name??'Kein Bereich',item.due_on?`fällig ${formatDue(item.due_on)}`:'Kein Fälligkeitsdatum'],description:item.description})},
    {param:'measure',tab:'gefaehrdungen',label:'Maßnahme',find:id=>context.hazards.flatMap(hazard=>hazard.measures??[]).find(item=>item.id===id),describe:(item,_id)=>({title:item.title??'Maßnahme',meta:[measureStatusLabels[item.status as keyof typeof measureStatusLabels]??item.status,item.responsible_employee_name??'Keine verantwortliche Person',item.due_on?`fällig ${formatDue(item.due_on)}`:'Kein Fälligkeitsdatum'],description:item.description})},
    {param:'instruction',tab:'anweisungen',label:'Dienstanweisung',find:id=>context.instructions.find(item=>item.id===id),describe:item=>({title:item.title??'Dienstanweisung',meta:[instructionStatusLabels[item.status]??item.status,`Version ${item.version}`,`${item.acknowledgement_count} Kenntnisnahmen`,item.valid_until?`gültig bis ${formatDue(item.valid_until)}`:'Ohne Ablaufdatum']})},
    {param:'assignment',tab:'personal',label:'Personalzuordnung',find:id=>(context.staffing??[]).find(item=>item.id===id)??(context.assignmentHistory??[]).find(item=>item.id===id),describe:item=>({title:item.employee_name??'Mitarbeiter',meta:[item.role??'Ohne Funktion',item.assignment_type,item.starts_on?`ab ${formatDue(item.starts_on)}`:'Ohne Beginn',item.ends_on?`bis ${formatDue(item.ends_on)}`:'offen'],description:item.notes})},
    {param:'employee',tab:'personal',label:'Mitarbeiterprofil',find:id=>(context.staffing??[]).find(item=>item.employee_id===id)??(context.assignmentHistory??[]).find(item=>item.employee_id===id),describe:(item,id)=>({title:item.employee_name??'Mitarbeiter',meta:[id,item.role??'Ohne Funktion',item.assignment_type]})},
    {param:'key',tab:'schluessel',label:'Schlüssel',find:id=>context.keys?.items.find(item=>item.id===id),describe:item=>({title:item.label??item.key_code??'Schlüssel',meta:[item.key_code,item.key_type,item.status,item.holder_employee_id??'Kein Inhaber']})},
    {param:'key_bundle',tab:'schluessel',label:'Schlüsselbund',find:id=>context.keyBundles?.find(item=>item.id===id),describe:item=>({title:item.name??'Schlüsselbund',meta:[item.status,`${item.item_count} Schlüssel`,`${item.issued_count} ausgegeben`]})},
    {param:'period',tab:'dienstplanung',label:'Dienstplan',find:id=>context.shifts?.find(item=>item.period_id===id),describe:(item,id)=>({title:item.period_name??'Dienstplan',meta:[id,item.period_status,item.role_code,`${formatDue(item.starts_at)} – ${formatDue(item.ends_at)}`]})},
    {param:'shift',tab:'dienstplanung',label:'Schicht',find:id=>context.shifts?.find(item=>item.id===id),describe:item=>({title:item.role_code??'Schicht',meta:[item.period_name,item.period_status,`${formatDue(item.starts_at)} – ${formatDue(item.ends_at)}`,`${item.assigned_count} zugewiesen`]})},
    {param:'shift_assignment',tab:'dienstplanung',label:'Schichtzuweisung',find:id=>context.shifts?.flatMap(item=>item.assignments??[]).find(item=>item.id===id),describe:item=>({title:item.employee_name??'Schichtzuweisung',meta:[item.employee_id,item.id]})},
    {param:'entry',tab:'journal',label:'Wachbucheintrag',find:id=>context.journal?.find(item=>item.id===id),describe:item=>({title:item.category_name??'Wachbucheintrag',meta:[item.priority_name??'Ohne Priorität',item.status,`Version ${item.revision_no}`,new Date(item.created_at).toLocaleString('de-DE')],description:item.content})},
    {param:'alarm',tab:'vorfaelle',label:'Alarm',find:id=>context.alarms?.find(item=>item.id===id),describe:item=>({title:item.type??'Alarm',meta:[item.severity,item.status,item.priority_name??'Ohne Priorität',new Date(item.triggered_at).toLocaleString('de-DE')],description:item.description})},
    {param:'incident',tab:'vorfaelle',label:'Vorfall',find:id=>context.incidents?.find(item=>item.id===id),describe:item=>({title:item.description??'Vorfall',meta:[item.status,item.priority_name??'Ohne Priorität',`${item.assignees?.length??0} zugewiesen`,item.employee_name??'Kein Erstatter']})},
    {param:'handover',tab:'uebersicht',label:'Übergabe',find:id=>context.handovers?.find(item=>item.id===id),describe:item=>({title:item.title??'Übergabe',meta:[item.status,`${item.confirmation_count}/${item.participant_count} Bestätigungen`,new Date(item.created_at).toLocaleString('de-DE')]})},
    {param:'task',tab:'aufgaben',label:'Aufgabe',find:id=>context.customerTasks?.find(item=>item.id===id),describe:item=>({title:item.title??'Aufgabe',meta:[item.status,item.customer_name??'Kein Kunde',item.due_at?`fällig ${formatDue(item.due_at)}`:'Kein Fälligkeitsdatum',item.assigned_employee_name??'Nicht zugewiesen'],description:item.description})},
  ];
  for(const spec of specs){
    const id=params.get(spec.param);
    if(!id)continue;
    if(spec.tab!==section)return undefined;
    const item=spec.find(id);
    if(!item)return null;
    return {param:spec.param,label:spec.label,id,...spec.describe(item,id)};
  }
  return undefined;
}

function ObjectRecordFocus({focus,onClose}:{focus:FocusRecord;onClose:()=>void}){
  return <section className="object-record-focus" aria-label="Geöffneter Datensatz">
    <div><span className="object-record-focus-label">{focus.label}</span><h3>{focus.title}</h3><p>{focus.meta.join(' · ')}</p>{focus.description&&<p className="object-record-focus-description">{focus.description}</p>}</div>
    <button type="button" onClick={onClose}>Fokus schließen</button>
  </section>;
}

export function Sites(){
  const navigate=useNavigate();
  const [searchParams,setSearchParams]=useSearchParams();
  const {siteId,section}=useParams<{siteId?:string;section?:string}>();
  const resolvedSection=sectionAliases[section??'']??section;
  const active=tabs.some(([key])=>key===resolvedSection)?resolvedSection:'uebersicht';
  const [sites,setSites]=useState<SiteOverview[]>([]);
  const [metrics,setMetrics]=useState<OverviewMetrics|null>(null);
  const [priorityActions,setPriorityActions]=useState<PriorityAction[]>([]);
  const [customers,setCustomers]=useState<Customer[]>([]);
  const [employees,setEmployees]=useState<Employee[]>([]);
  const [selected,setSelected]=useState<Context|null>(null);
  const [error,setError]=useState('');
  const [listError,setListError]=useState('');
  const [detailError,setDetailError]=useState('');
  const [chronicleError,setChronicleError]=useState('');
  const [search,setSearch]=useState('');
  const [statusFilter,setStatusFilter]=useState('all');
  const [securityFilter,setSecurityFilter]=useState('all');
  const [customerFilter,setCustomerFilter]=useState('all');
  const [managerFilter,setManagerFilter]=useState('all');
  const [siteTypeFilter,setSiteTypeFilter]=useState('all');
  const [criticalFilter,setCriticalFilter]=useState(false);
  const [understaffedFilter,setUnderstaffedFilter]=useState(false);
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
  const emptyDocumentMetadata={document_number:'',document_type:'',responsible_employee_id:'',location_id:'',valid_from:'',valid_until:'',review_on:''};
  const [uploadDocumentTitle,setUploadDocumentTitle]=useState('');
  const [uploadDocumentMetadata,setUploadDocumentMetadata]=useState(emptyDocumentMetadata);
  const [documentFile,setDocumentFile]=useState<File|null>(null);
  const [editingDocumentId,setEditingDocumentId]=useState<string|null>(null);
  const [editDocumentTitle,setEditDocumentTitle]=useState('');
  const [editDocumentMetadata,setEditDocumentMetadata]=useState(emptyDocumentMetadata);
  const [documentRequirementForm,setDocumentRequirementForm]=useState({document_type:'',responsible_employee_id:'',required:true});
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
  const [orderFormOpen,setOrderFormOpen]=useState(false);
  const [orderForm,setOrderForm]=useState({device_id:'',maintenance_type:'inspection',description:'',priority_code:'medium',due_on:'',responsible_employee_id:'',status:'planned'});
  const [completingOrderId,setCompletingOrderId]=useState<string|null>(null);
  const [completionForm,setCompletionForm]=useState({performed_work:'',result:'',remarks:''});
  const [cancellingOrderId,setCancellingOrderId]=useState<string|null>(null);
  const [cancellationReason,setCancellationReason]=useState('');
  const [eligibility,setEligibility]=useState<Record<string,ShiftEligibility|null>>({});
  const [eligibilityLoading,setEligibilityLoading]=useState(false);
  const [chronicle,setChronicle]=useState<{site_id:string;events:ChronicleEvent[]}|null>(null);
  const [chronicleCatalog,setChronicleCatalog]=useState<string[]>([]);
  const [chronicleFilter,setChronicleFilter]=useState({type:'',from:'',to:''});
  const [chronicleLoading,setChronicleLoading]=useState(false);
  const [shiftAssignmentRequests,setShiftAssignmentRequests]=useState<Record<string,{employee_id:string;client_mutation_id:string}>>({});
  const [assignmentForm,setAssignmentForm]=useState({employee_id:'',assignment_type:'operational',role:'',starts_on:'',ends_on:'',notes:'',reason:''});
  const [keyAction,setKeyAction]=useState<KeyAction|null>(null);
  const [keyHolderEmployeeId,setKeyHolderEmployeeId]=useState('');
  const [keyActionReason,setKeyActionReason]=useState('');
  const [editingDeviceId,setEditingDeviceId]=useState<string|null>(null);
  const [deviceFormOpen,setDeviceFormOpen]=useState(false);
  const emptyDeviceForm={name:'',asset_number:'',category:'',manufacturer:'',model:'',serial_number:'',location_id:'',responsible_employee_id:'',operational_status:'active',installed_on:'',commissioned_on:'',last_inspection_on:'',next_inspection_on:'',maintenance_interval_days:'' as number|'',next_maintenance_on:'',last_maintenance_on:''};
  const [deviceForm,setDeviceForm]=useState(emptyDeviceForm);
  const [details,setDetails]=useState({alias:'',site_type:'',description:'',street:'',house_number:'',postal_code:'',city:'',contact_person:'',object_manager_employee_id:'',operations_manager_employee_id:''});
  const writable=hasPermission('sites:write');

  async function load(){
    setListLoading(true);
    try{
      const response=await api<SiteOverviewResponse>('/sites/overview-dashboard');
      setSites(response?.sites??[]);setMetrics(response?.metrics??null);setPriorityActions(response?.priorityActions??[]);setListError('');
    }catch(e){setSites([]);setMetrics(null);setPriorityActions([]);setListError((e as Error).message);}
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
        setForm({name:site.name,site_number:site.site_number??'',address:site.address??'',status:site.status,security_classification:site.security_classification,required_staff_count:site.required_staff_count??0});
        setDetails({alias:site.alias??'',site_type:site.site_type??'',description:site.description??'',street:site.street??'',house_number:site.house_number??'',postal_code:site.postal_code??'',city:site.city??'',contact_person:site.contact_person??'',object_manager_employee_id:site.object_manager_employee_id??'',operations_manager_employee_id:site.operations_manager_employee_id??''});
      }
      setCustomers(customerRows??[]);setEmployees(employeeRows??[]);setDetailError('');
    }catch(e){setSelected(null);setDetailError((e as Error).message);}
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
      await api(`/sites/${selected.site.id}`,{method:'PATCH',body:JSON.stringify({name:form.name,site_number:form.site_number.trim()||null,address:form.address.trim()||null,status:form.status,security_classification:form.security_classification,required_staff_count:form.required_staff_count,description:details.description,alias:details.alias.trim()||null,site_type:details.site_type.trim()||null,street:details.street.trim()||null,house_number:details.house_number.trim()||null,postal_code:details.postal_code.trim()||null,city:details.city.trim()||null,contact_person:details.contact_person.trim()||null,object_manager_employee_id:details.object_manager_employee_id||null,operations_manager_employee_id:details.operations_manager_employee_id||null})});
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
    setForm(site?{name:site.name,site_number:site.site_number??'',address:site.address??'',status:site.status,security_classification:site.security_classification,required_staff_count:site.required_staff_count??0}:emptySite);
    setFormOpen(true);
  }
  async function save(event:FormEvent){
    event.preventDefault();
    try{
      const body={name:form.name,status:form.status,security_classification:form.security_classification,required_staff_count:form.required_staff_count,site_number:form.site_number.trim()||null,address:form.address.trim()||null};
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
      await api('/dms/documents',{method:'POST',body:JSON.stringify({title:uploadDocumentTitle,site_id:selected.site.id,document_number:uploadDocumentMetadata.document_number.trim()||null,document_type:uploadDocumentMetadata.document_type.trim()||null,responsible_employee_id:uploadDocumentMetadata.responsible_employee_id||null,location_id:uploadDocumentMetadata.location_id||null,valid_from:uploadDocumentMetadata.valid_from||null,valid_until:uploadDocumentMetadata.valid_until||null,review_on:uploadDocumentMetadata.review_on||null,content_type:documentFile.type||'application/octet-stream',content_base64:await toBase64(documentFile),client_mutation_id:uuid()})});
      setUploadDocumentTitle('');setDocumentFile(null);setUploadDocumentMetadata(emptyDocumentMetadata);if(documentInput.current)documentInput.current.value='';await refreshContext();setError('');
    }catch(e){setError((e as Error).message);}
  }
  function startDocumentEdit(document:SiteDocument){
    setEditingDocumentId(document.id);
    setEditDocumentTitle(document.title);
    setEditDocumentMetadata({document_number:document.document_number??'',document_type:document.document_type??'',responsible_employee_id:document.responsible_employee_id??'',location_id:document.location_id??'',valid_from:document.valid_from??'',valid_until:document.valid_until??'',review_on:document.review_on??''});
  }
  async function saveDocumentMetadata(event:FormEvent){
    event.preventDefault();if(!editingDocumentId)return;
    try{
      await api(`/dms/documents/${editingDocumentId}`,{method:'PATCH',body:JSON.stringify({title:editDocumentTitle,document_number:editDocumentMetadata.document_number.trim()||null,document_type:editDocumentMetadata.document_type.trim()||null,responsible_employee_id:editDocumentMetadata.responsible_employee_id||null,location_id:editDocumentMetadata.location_id||null,valid_from:editDocumentMetadata.valid_from||null,valid_until:editDocumentMetadata.valid_until||null,review_on:editDocumentMetadata.review_on||null})});
      setEditingDocumentId(null);setEditDocumentTitle('');setEditDocumentMetadata(emptyDocumentMetadata);await refreshContext();setError('');
    }catch(e){setError((e as Error).message);}
  }
  async function runDocumentWorkflow(document:SiteDocument,action:'request-review'|'approve'|'return-for-revision'){
    try{
      const reason=action==='return-for-revision'?window.prompt('Grund für die Rückgabe zur Überarbeitung'):null;
      if(action==='return-for-revision'&&!reason?.trim())return;
      await api(`/dms/documents/${document.id}/${action}`,{method:'POST',body:action==='return-for-revision'?JSON.stringify({reason:reason!.trim()}):undefined});
      await refreshContext();setError('');
    }catch(e){setError((e as Error).message);}
  }
  async function saveDocumentRequirement(event:FormEvent){
    event.preventDefault();if(!selected||!documentRequirementForm.document_type.trim())return;
    try{
      await api(`/sites/${selected.site.id}/document-requirements`,{method:'POST',body:JSON.stringify({document_type:documentRequirementForm.document_type.trim(),required:documentRequirementForm.required,responsible_employee_id:documentRequirementForm.responsible_employee_id||null})});
      setDocumentRequirementForm({document_type:'',responsible_employee_id:'',required:true});await refreshContext();setError('');
    }catch(e){setError((e as Error).message);}
  }
  async function removeDocumentRequirement(requirement:DocumentRequirement){
    if(!selected||!window.confirm(`Pflichtdokumenttyp „${requirement.document_type}“ entfernen?`))return;
    try{await api(`/sites/${selected.site.id}/document-requirements/${requirement.id}`,{method:'DELETE'});await refreshContext();setError('');}
    catch(e){setError((e as Error).message);}
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
  async function createMaintenanceOrder(event:FormEvent){
    event.preventDefault();if(!selected||!orderForm.device_id||!orderForm.description.trim())return;
    try{
      await api(`/sites/${selected.site.id}/maintenance-orders`,{method:'POST',body:JSON.stringify({device_id:orderForm.device_id,maintenance_type:orderForm.maintenance_type,description:orderForm.description.trim(),priority_code:orderForm.priority_code,due_on:orderForm.due_on||null,status:orderForm.status,responsible_employee_id:orderForm.responsible_employee_id||null})});
      setOrderForm({device_id:'',maintenance_type:'inspection',description:'',priority_code:'medium',due_on:'',responsible_employee_id:'',status:'planned'});setOrderFormOpen(false);await refreshContext();setError('');
    }catch(e){setError((e as Error).message);}
  }
  async function updateMaintenanceOrder(order:MaintenanceOrder,status:'planned'|'open'|'in_progress'){
    try{await api(`/maintenance-orders/${order.id}`,{method:'PATCH',body:JSON.stringify({status})});await refreshContext();setError('');}
    catch(e){setError((e as Error).message);}
  }
  async function completeMaintenanceOrder(event:FormEvent){
    event.preventDefault();if(!completingOrderId||!completionForm.performed_work.trim())return;
    try{
      await api(`/maintenance-orders/${completingOrderId}/complete`,{method:'POST',body:JSON.stringify({performed_work:completionForm.performed_work.trim(),result:completionForm.result.trim()||null,remarks:completionForm.remarks.trim()||null})});
      setCompletingOrderId(null);setCompletionForm({performed_work:'',result:'',remarks:''});await refreshContext();setError('');
    }catch(e){setError((e as Error).message);}
  }
  async function cancelMaintenanceOrder(event:FormEvent){
    event.preventDefault();if(!cancellingOrderId||!cancellationReason.trim())return;
    try{
      await api(`/maintenance-orders/${cancellingOrderId}/cancel`,{method:'POST',body:JSON.stringify({reason:cancellationReason.trim()})});
      setCancellingOrderId(null);setCancellationReason('');await refreshContext();setError('');
    }catch(e){setError((e as Error).message);}
  }
  async function linkMaintenanceDocument(order:MaintenanceOrder,documentId:string){
    if(!documentId)return;
    try{await api(`/maintenance-orders/${order.id}/documents`,{method:'POST',body:JSON.stringify({document_id:documentId})});await refreshContext();setError('');}
    catch(e){setError((e as Error).message);}
  }
  async function loadChronicle(siteId:string,filter:{type:string;from:string;to:string}=chronicleFilter){
    setChronicleLoading(true);
    try{
      const params=new URLSearchParams();
      if(filter.type)params.set('type',filter.type);
      if(filter.from)params.set('from',filter.from);
      if(filter.to)params.set('to',filter.to);
      params.set('limit','100');
      const query=params.toString();
      const response=await api<{site_id:string;events:ChronicleEvent[]}>(`/sites/${siteId}/chronicle${query?`?${query}`:''}`);
      const events=response?.events??[];
      setChronicle({site_id:response?.site_id??siteId,events});
      if(!filter.type&&!filter.from&&!filter.to)setChronicleCatalog(Array.from(new Set(events.map(event=>event.event_kind))).sort());
      setChronicleError('');
    }catch(e){setChronicle({site_id:siteId,events:[]});setChronicleError((e as Error).message);}
    finally{setChronicleLoading(false);}
  }
  function eligibilityHref(reason:EligibilityReason,employeeId:string){
    if(reason.link?.type==='employee'||reason.link?.type==='absence')return `/employees/${employeeId}`;
    if(reason.link?.type==='qualification')return `/employees/${employeeId}/qualifikationen`;
    if(reason.link?.type==='instruction')return `/sites/${selected?.site.id}/anweisungen`;
    return '/employees';
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
  async function removeStaffingAssignment(assignment:StaffingAssignment){
    if(!selected)return;
    const reason=window.prompt('Grund für das Beenden der Objektzuordnung');
    if(!reason?.trim())return;
    try{
      await api(`/employees/${assignment.employee_id}/object-assignments/${assignment.id}`,{method:'PATCH',body:JSON.stringify({ends_on:new Date().toISOString().slice(0,10),reason:reason.trim()})});
      await refreshContext();setError('');
    }catch(e){setError((e as Error).message);}
  }
  function startDeviceEdit(device?:ObjectDevice){
    setEditingDeviceId(device?.id??null);
    setDeviceFormOpen(true);
    setDeviceForm(device?{name:device.name,asset_number:device.asset_number??'',category:device.category??'',manufacturer:device.manufacturer??'',model:device.model??'',serial_number:device.serial_number??'',location_id:device.location_id??'',responsible_employee_id:device.responsible_employee_id??'',operational_status:device.operational_status,installed_on:device.installed_on??'',commissioned_on:device.commissioned_on??'',last_inspection_on:device.last_inspection_on??'',next_inspection_on:device.next_inspection_on??'',maintenance_interval_days:device.maintenance_interval_days??'',next_maintenance_on:device.next_maintenance_on??'',last_maintenance_on:device.last_maintenance_on??''}:emptyDeviceForm);
  }
  async function saveDevice(event:FormEvent){
    event.preventDefault();if(!selected)return;
    try{
      const body={name:deviceForm.name,status:'online',site_id:selected.site.id,asset_number:deviceForm.asset_number||null,category:deviceForm.category||null,manufacturer:deviceForm.manufacturer||null,model:deviceForm.model||null,serial_number:deviceForm.serial_number||null,location_id:deviceForm.location_id||null,responsible_employee_id:deviceForm.responsible_employee_id||null,operational_status:deviceForm.operational_status,installed_on:deviceForm.installed_on||null,commissioned_on:deviceForm.commissioned_on||null,last_inspection_on:deviceForm.last_inspection_on||null,next_inspection_on:deviceForm.next_inspection_on||null,maintenance_interval_days:deviceForm.maintenance_interval_days===''?null:deviceForm.maintenance_interval_days,next_maintenance_on:deviceForm.next_maintenance_on||null,last_maintenance_on:deviceForm.last_maintenance_on||null};
      if(deviceForm.maintenance_interval_days!==''&&deviceForm.maintenance_interval_days<1)throw new Error('Das Wartungsintervall muss mindestens 1 Tag betragen.');
      await api(editingDeviceId?`/devices/${editingDeviceId}`:'/devices',{method:editingDeviceId?'PATCH':'POST',body:JSON.stringify(body)});
      setEditingDeviceId(null);setDeviceFormOpen(false);setDeviceForm(emptyDeviceForm);await refreshContext();setError('');
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
      case 'open_task_count':return site.open_task_count;
      case 'contract_statuses':return site.contract_statuses?.join(', ')??null;
      case 'understaffed':return site.understaffed?'Unterbesetzt':'Abgedeckt';
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
      &&(!criticalFilter||site.critical_hazard_count>0)
      &&(!understaffedFilter||site.understaffed)
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
  const toggleColumn=(key:SiteColumn,checked:boolean)=>{
    // The object name is the only navigation into the detail view; it must
    // never be hideable, otherwise users can lose access to the object file.
    if(key==='name')return;
    setVisibleColumns(current=>checked?[...current,key]:current.length>1?current.filter(column=>column!==key):current);
  };
  const visibleSiteColumns=siteColumns.filter(column=>column.key==='name'||visibleColumns.includes(column.key));
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
    if(active!=='technik'||!selectedSiteId)return;
    const watchbookOptions=maintenanceReadable&&hasPermission('watchbook:read')&&hasPermission('watchbook:write');
    const orderOptions=hasPermission('devices:write');
    if(!watchbookOptions&&!orderOptions)return;
    let current=true;
    if(watchbookOptions)setMaintenanceOptionsLoaded(false);
    Promise.all([watchbookOptions?api<WatchbookCategory[]>('/watchbook/categories'):Promise.resolve([]),api<WatchbookPriority[]>('/watchbook/priorities')]).then(([categories,priorities])=>{
      if(!Array.isArray(priorities)||priorities.length===0)throw new Error('Prioritäten sind im Wachbuch nicht konfiguriert.');
      if(!current)return;
      setMaintenancePriorities(priorities);
      if(!maintenancePriorityCode)setMaintenancePriorityCode(priorities[0].code);
      if(watchbookOptions){
        const maintenanceCategory=(categories??[]).find(category=>category.code==='maintenance');
        if(!maintenanceCategory)throw new Error('Wartungskategorie ist im Wachbuch nicht konfiguriert.');
        setMaintenanceCategoryId(maintenanceCategory.id);
        setMaintenanceOptionsLoaded(true);
      }
    }).catch(error=>{
      if(current){setError((error as Error).message);if(watchbookOptions)setMaintenanceOptionsLoaded(true);}
    });
    return ()=>{current=false;};
  },[active,selectedSiteId,maintenanceReadable]);
  useEffect(()=>{
    setEligibility({});setChronicle(null);setChronicleCatalog([]);setChronicleFilter({type:'',from:'',to:''});
  },[selectedSiteId]);
  useEffect(()=>{
    if(!selectedSiteId||!['uebersicht','journal'].includes(active))return;
    void loadChronicle(selectedSiteId,{type:'',from:'',to:''});
  },[active,selectedSiteId]);
  useEffect(()=>{
    const shifts=selected?.shifts??[];
    if(active!=='dienstplanung'||!selected||shifts.length===0
      ||!hasPermission('scheduling:read')||!hasPermission('employees:read')||!hasPermission('qualifications:read'))return;
    let current=true;setEligibilityLoading(true);
    void Promise.all(shifts.map(async shift=>{
      try{
        const verdict=await api<ShiftEligibility>(`/sites/${selected.site.id}/shifts/${shift.id}/eligibility`);
        return [shift.id,verdict&&Array.isArray(verdict.employees)?verdict:null] as const;
      }catch{return [shift.id,null] as const;}
    })).then(entries=>{if(current)setEligibility(Object.fromEntries(entries));})
      .finally(()=>{if(current)setEligibilityLoading(false);});
    return ()=>{current=false;};
  },[active,selected?.site.id,selected?.shifts]);

  const now=new Date();
  const today=now.toISOString().slice(0,10);
  const isInstructionActive=(instruction:Context['instructions'][number])=>instruction.status==='approved'&&(!instruction.valid_from||instruction.valid_from<=today)&&(!instruction.valid_until||instruction.valid_until>=today);
  const currentStaff=selected?.staffing?.filter(assignment=>!assignment.ends_on||assignment.ends_on>=now.toISOString().slice(0,10))??[];
  const currentShifts=selected?.shifts?.filter(shift=>shift.starts_at<=now.toISOString()&&shift.ends_at>=now.toISOString())??[];
  const criticalHazards=selected?.hazards.filter(hazard=>hazard.status==='open'&&hazard.risk_score>=15)??[];
  const expiredInstructions=selected?.instructions.filter(instruction=>instruction.status==='approved'&&instruction.valid_until&&instruction.valid_until<today)??[];
  const overdueMeasures=selected?.hazards.flatMap(hazard=>hazard.measures).filter(measure=>['open','in_progress'].includes(measure.status)&&measure.due_on&&measure.due_on<today)??[];
  const documents=selected?.documents??[];
  const documentStatusCounts=selected?.documentStatusCounts??(Object.keys(documentStatusLabels) as DocumentStatus[]).reduce((counts,status)=>{
    counts[status]=documents.filter(document=>document.computed_status===status).length;
    return counts;
  },{} as Record<DocumentStatus,number>);
  const documentBucketCounts=(['expired','within_7_days','within_8_30_days','within_31_60_days','beyond_60_days','no_expiry'] as ExpiryBucket[]).reduce((counts,bucket)=>{
    counts[bucket]=selected?.documentWarningCounts?.[bucket]??documents.filter(document=>document.expiry_bucket===bucket).length;
    return counts;
  },{} as Record<ExpiryBucket,number>);
  const expiredDocuments=documents.filter(document=>document.computed_status==='abgelaufen');
  const expiring7Documents=documents.filter(document=>document.expiry_bucket==='within_7_days');
  const expiring30Documents=documents.filter(document=>document.expiry_bucket==='within_8_30_days');
  const expiring60Documents=documents.filter(document=>document.expiry_bucket==='within_31_60_days');
  const activeDevices=selected?.devices?.filter(device=>device.operational_status==='active')??[];
  const faultyDevices=selected?.devices?.filter(device=>device.operational_status==='fault'||device.operational_status==='offline')??[];
  const maintenanceOrders=selected?.maintenanceOrders??[];
  const overdueOrders=maintenanceOrders.filter(order=>order.computed_status==='overdue'||order.overdue);
  const openOrders=maintenanceOrders.filter(order=>['planned','open','in_progress','overdue'].includes(order.computed_status));
  const maintenanceStatusCounts=selected?.maintenanceStatusCounts??(['planned','open','in_progress','overdue','completed','cancelled'] as const).reduce((counts,status)=>{
    counts[status]=maintenanceOrders.filter(order=>order.computed_status===status).length;
    return counts;
  },{} as Record<string,number>);
  const upcomingDevices=selected?.devices?.filter(device=>device.next_maintenance_on&&device.next_maintenance_on>=today&&device.next_maintenance_on<=new Date(now.getTime()+30*86400000).toISOString().slice(0,10))??[];
  const personnelSummary=selected?.personnelSummary??null;
  const qualificationWarnings=personnelSummary?.qualification_issues??personnelSummary?.expiring_qualifications??selected?.qualifications?.filter(qualification=>qualification.issue&&qualification.issue.code!=='none')??[];
  const detailPriorityActions=selected?.priorityActions??[];
  const recentPersonnelChanges=selected?.recentPersonnelChanges??[];
  const chronicleEvents=chronicle?.events??[];
  const focus=selected?findFocusRecord(selected,searchParams,active):undefined;
  const recordFocusClass=(param:string,id:string|undefined)=>id&&searchParams.get(param)===id?'object-record-highlight':'';
  const clearRecordFocus=()=>{
    const next=new URLSearchParams(searchParams);
    for(const param of focusParams)next.delete(param);
    setSearchParams(next,{replace:true});
  };
  const serverActivityItems=chronicleEvents.slice(0,8).map(event=>({id:`chronicle-${event.id}`,created_at:event.occurred_at,title:event.category,detail:`${event.event_kind} · ${event.summary}`,link:event.link}));
  return <section className="object-management">
    {error&&<p role="alert" className="error">{error}</p>}
    {!siteId&&listError&&<p role="alert" className="error">Objektübersicht konnte nicht geladen werden: {listError}</p>}
    {siteId&&detailError&&<p role="alert" className="error">Objektakte konnte nicht geladen werden: {detailError}</p>}
    {siteId?(selected?<article className="object-detail-page">
      <button type="button" className="object-back" onClick={()=>navigate('/sites')}>Zur Objektübersicht</button>
      <header className="object-detail-header">
        <div><p className="object-eyebrow">Digitale Objektakte · {selected.site.site_number||'Ohne Objektnummer'}</p><h2>{selected.site.name}</h2>
          <p>{selected.site.address||'Keine Adresse'} · {selected.site.alias?`${selected.site.alias} · `:''}{selected.site.site_type||'Objektart nicht festgelegt'}</p>
          <p>Objektleitung: {selected.site.object_manager_name||'–'} · Einsatzleitung: {selected.site.operations_manager_name||'–'}</p>
          <div className="object-header-meta"><span className={`object-status ${selected.site.status}`}>{statuses[selected.site.status]??selected.site.status}</span><span>{classifications[selected.site.security_classification]??selected.site.security_classification}</span><span>Aktualisiert {selected.site.updated_at?new Date(selected.site.updated_at).toLocaleString('de-DE'):'nicht verfügbar'}</span></div>
        </div>
        <div className="object-actions">
          {writable&&<button type="button" onClick={()=>navigate(`/sites/${siteId}/stammdaten`)}>Objekt bearbeiten</button>}
          {writable&&hasPermission('employees:write')&&<button type="button" onClick={()=>navigate(`/sites/${siteId}/personal`)}>Mitarbeiter zuweisen</button>}
          {hasPermission('customers:write')&&<button type="button" onClick={()=>navigate(`/sites/${siteId}/aufgaben`)}>Aufgabe erstellen</button>}
          {hasPermission('dms:write')&&<button type="button" onClick={()=>navigate(`/sites/${siteId}/dokumente`)}>Dokument hinzufügen</button>}
          {hasPermission('incidents:write')&&<button type="button" onClick={()=>navigate('/incidents')}>Vorfall erfassen</button>}
        </div>
      </header>
      <nav className="object-tabs" aria-label="Objektbereiche">
        <button type="button" className={active==='uebersicht'?'active':''} aria-current={active==='uebersicht'?'page':undefined} onClick={()=>navigate(`/sites/${siteId}/uebersicht`)}>Übersicht</button>
        {tabGroups.map(group=><div className="object-tab-group" key={group.label}><span>{group.label}</span>{tabs.filter(([key])=>group.keys.includes(key as never)).map(([key,label])=><button type="button" key={key} className={active===key?'active':''} aria-current={active===key?'page':undefined} onClick={()=>navigate(`/sites/${siteId}/${key}`)}>{label}</button>)}</div>)}
      </nav>
      {focus!==undefined&&<ObjectRecordFocus focus={focus??{param:'record',label:'Datensatz',id:'unavailable',title:'Verknüpfter Datensatz nicht verfügbar',meta:['Der Datensatz wurde gelöscht oder ist für Ihren Berechtigungsumfang nicht freigegeben']}} onClose={clearRecordFocus}/>}
      {active==='uebersicht'&&<div className="object-detail-content">
        <PriorityActionList actions={detailPriorityActions} title="Nächste Schritte nach Dringlichkeit"/>
        <section className="object-info-metrics" aria-label="Objektinformationen">
          <h3>C – Objektinformationen</h3>
          <p>Kritische Gefährdungen: {criticalHazards.length} · Überfällige Maßnahmen: {overdueMeasures.length} · Abgelaufene Dienstanweisungen: {expiredInstructions.length}</p>
          <p>{documentStatusLabels.abgelaufen}: {documentStatusCounts.abgelaufen} · Dokumente ≤ 7 Tage: {documentBucketCounts.within_7_days} · Dokumente 8–30 Tage: {documentBucketCounts.within_8_30_days} · Dokumente 31–60 Tage: {documentBucketCounts.within_31_60_days}</p>
          <p>{documentStatusLabels.nicht_freigegeben}: {documentStatusCounts.nicht_freigegeben} · {documentStatusLabels.pruefung_ausstehend}: {documentStatusCounts.pruefung_ausstehend} · {documentStatusLabels.noch_nicht_gueltig}: {documentStatusCounts.noch_nicht_gueltig} · {documentStatusLabels.bald_pruefpflichtig}: {documentStatusCounts.bald_pruefpflichtig}</p>
          <p>Technische Störungen oder Offline-Anlagen: {faultyDevices.length} · Überfällige Wartungsaufträge: {overdueOrders.length} (in {openOrders.length} offenen Aufträgen enthalten)</p>
          <p>Bald ablaufende Qualifikationen: {personnelSummary?.expiring_qualification_count??0} · Abgelaufene oder ungültige Qualifikationen: {personnelSummary?.invalid_qualification_count??0} · Ausstehende Dienstanweisungs-Kenntnisnahmen: {personnelSummary?.pending_acknowledgement_count??0}</p>
        </section>
        <div className="object-summary-grid">
          {([
            ['stammdaten','Objektstatus',<><strong>{statuses[selected.site.status]??selected.site.status}</strong><p>{classifications[selected.site.security_classification]??selected.site.security_classification}</p></>],
            ['personal','Verantwortliche',<><p>Objektleitung: {selected.site.object_manager_name||'–'}</p><p>Einsatzleitung: {selected.site.operations_manager_name||'–'}</p></>],
            ['kunden','Kunde & Verträge',<>{selected.customers==null?<p>Keine Berechtigung für Kundenbeziehungen.</p>:<p>{selectedCustomers.map(customer=>customer.customer_name).join(', ')||'Keine aktive Kundenbeziehung'}</p>}{selected.contracts==null?<p>Verträge nicht freigegeben.</p>:<><p>{selectedContracts.length} Vertragsverknüpfungen</p><p>{selectedContracts.map(contract=>contract.status).filter((status,index,all)=>all.indexOf(status)===index).join(', ')||'Kein Vertragsstatus'}</p></>}</>],
            ['personal','Besetzung',<><p>{selected.staffing==null?'Keine Berechtigung':`${currentStaff.length} zugeordnete / Soll ${selected.site.required_staff_count??0}`}</p><p>{selected.shifts==null?'Dienstplanung nicht freigegeben':`${currentShifts.length} aktuell besetzte Schichten`}</p>{(selected.site.required_staff_count??0)>0&&currentStaff.length<(selected.site.required_staff_count??0)&&<p role="status">Unterbesetzung erkannt.</p>}</>],
            ['gefaehrdungen','Sicherheitslage',<><p>{selected.hazards.filter(hazard=>hazard.status==='open').length} offene Gefährdungen</p><p>{criticalHazards.length} kritisch</p><p>{overdueMeasures.length} überfällige Maßnahmen</p></>],
            ['aufgaben','Aufgaben & Maßnahmen',<><p>{selected.customerTasks==null?'Keine Berechtigung':`${selected.customerTasks.filter(task=>task.status==='open').length} offene Aufgaben`}</p><p>{selected.customerTasks==null?'':`${selected.customerTasks.filter(task=>task.status==='open'&&task.due_at&&new Date(task.due_at)<now).length} überfällig`}</p></>],
            ['anweisungen','Dienstanweisungen',<><p>{selected.instructions.filter(isInstructionActive).length} aktuell gültig</p><p>{expiredInstructions.length} abgelaufen</p><p>{selected.instructions.filter(instruction=>instruction.requires_acknowledgement).reduce((total,instruction)=>total+instruction.acknowledgement_count,0)} Kenntnisnahmen erfasst</p></>],
            ['technik','Technik & Wartung',<><p>{selected.devices==null?'Keine Berechtigung':`${selected.devices.length} Anlagen · ${activeDevices.length} aktiv`}</p><p>{selected.maintenanceOrders==null?'Wartungsaufträge nicht freigegeben':`${openOrders.length} offene Aufträge · ${overdueOrders.length} überfällig`}</p><p>{selected.maintenanceOrders==null?'':`Geplant ${maintenanceStatusCounts.planned??0} · offen ${maintenanceStatusCounts.open??0} · in Bearbeitung ${maintenanceStatusCounts.in_progress??0} · überfällig ${maintenanceStatusCounts.overdue??0} · abgeschlossen ${maintenanceStatusCounts.completed??0} · abgebrochen ${maintenanceStatusCounts.cancelled??0}`}</p><p>{faultyDevices.length} Störungen/Offline · {upcomingDevices.length} Prüfungen binnen 30 Tagen</p></>],
            ['dokumente','Dokumente',<>{selected.documents==null?<p>Keine Berechtigung für DMS-Dokumente.</p>:<p>{selected.documents.length} DMS-Dokumente</p>}<p>{documentStatusCounts.gueltig} gültig · {documentStatusCounts.abgelaufen} abgelaufen · {documentStatusCounts.nicht_freigegeben} nicht freigegeben</p><p>≤ 7 Tage: {documentBucketCounts.within_7_days} · 8–30: {documentBucketCounts.within_8_30_days} · 31–60: {documentBucketCounts.within_31_60_days} · über 60: {documentBucketCounts.beyond_60_days} · ohne Ablauf: {documentBucketCounts.no_expiry}</p>{selected.documentRequirements!=null&&<p>{selected.documentRequirements.filter(requirement=>requirement.missing).length} Pflichtdokumente fehlen</p>}</>],
            ['vorfaelle','Vorfälle & Alarme',<><p>{selected.incidents==null?'Einsätze nicht freigegeben':`${selected.incidents.length} Einsätze`}</p><p>{selected.alarms==null?'Alarme nicht freigegeben':`${selected.alarms.length} Alarme`}</p></>],
            ['dienstplanung','Anstehende Schichten',<>{selected.shifts==null?<p>Keine Berechtigung für die Dienstplanung.</p>:<p>{selected.shifts.filter(shift=>shift.starts_at>now.toISOString()).slice(0,2).map(shift=>`${shift.role_code} · ${new Date(shift.starts_at).toLocaleString('de-DE')}`).join(' / ')||'Keine zukünftigen Schichten'}</p>}</>],
            ['uebersicht','Übergaben',<>{selected.handovers==null?<p>Keine Berechtigung für Übergaben.</p>:selected.handovers.length===0?<p>Keine Übergaben erfasst.</p>:selected.handovers.slice(0,3).map(handover=><p key={handover.id} className={recordFocusClass('handover',handover.id)}>{handover.title} · {handover.confirmation_count}/{handover.participant_count} Bestätigungen</p>)}</>],
          ] as const).map(([section,title,content])=><article key={title} className="object-summary-card" role="button" tabIndex={0} onClick={()=>navigate(`/sites/${siteId}/${section}`)} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();navigate(`/sites/${siteId}/${section}`);}}} aria-label={`${title} öffnen`}><h3>{title}</h3>{content}</article>)}
        </div>
        {personnelSummary!==undefined&&<section className="object-personnel-overview">
          <h3>Personalüberblick</h3>
          {personnelSummary===null?<p>Keine Berechtigung für Personaldaten.</p>:<>
            <p>{personnelSummary.assigned_employee_count} zugeordnete Mitarbeitende · {personnelSummary.expiring_qualification_count} bald ablaufende · {personnelSummary.invalid_qualification_count} ungültige Qualifikationen</p>
            <h4>Konkrete Qualifikationswarnungen</h4>
            {qualificationWarnings.length===0?<p>Keine offenen Qualifikationswarnungen.</p>:<ul>{qualificationWarnings.map(qualification=><li key={`${qualification.employee_id}-${qualification.code}-${qualification.id}`} className={qualification.issue?.severity==='critical'||qualification.computed_status==='expired'||qualification.computed_status==='revoked'?'object-warning':''}>
              <strong>{qualification.employee_name}</strong> · {qualification.qualification_name??qualification.code} · {qualificationReason(qualification)}
              <span className="object-qualification-meta"> · {qualificationEvidence(qualification)}{qualification.last_checked_at?` · zuletzt geprüft ${new Date(qualification.last_checked_at).toLocaleDateString('de-DE')}`:''}</span>
              {hasPermission('qualifications:read')&&<Link to={qualification.employee_url??`/employees/${qualification.employee_id}/qualifikationen`}>Nachweis öffnen</Link>}
            </li>)}</ul>}
            <p className="object-scope-hint">Allgemeine Personalübersicht; die verbindliche Einsatzprüfung erfolgt schichtbezogen in der Dienstplanung.</p>
            <h4>Ausstehende Dienstanweisungs-Kenntnisnahmen</h4>
            {personnelSummary.missing_acknowledgements.length===0?<p>Keine ausstehenden Kenntnisnahmen.</p>:<ul>{personnelSummary.missing_acknowledgements.map(acknowledgement=><li key={acknowledgement.instruction_id}><strong>{acknowledgement.title}</strong> v{acknowledgement.version} · {acknowledgement.missing_employees.map(employee=>employee.employee_name).join(', ')}{hasPermission('watchbook:read')&&<Link to={acknowledgement.target??`/sites/${siteId}/anweisungen`}>Dienstanweisung öffnen</Link>}</li>)}</ul>}
            <h4>Letzte Personaländerungen</h4>
            {recentPersonnelChanges===null?<p>Keine Berechtigung für die Personalhistorie.</p>:recentPersonnelChanges.length===0?<p>Keine aktuellen Personaländerungen erfasst.</p>:<ul>{recentPersonnelChanges.map(change=><li key={`${change.event_type}-${change.entity_id??'unbekannt'}-${change.occurred_at}`}><time>{new Date(change.occurred_at).toLocaleString('de-DE')}</time> · {change.event_type} · {change.employee_name??change.employee_id??'Mitarbeiter nicht ermittelbar'}{change.actor_email?` · ${change.actor_email}`:''}</li>)}</ul>}
          </>}
        </section>}
        <section className="object-activity"><h3>Aktivitätschronik</h3>{chronicleLoading?<p role="status">Chronik wird geladen …</p>:chronicleError?<p role="alert" className="error">Chronik konnte nicht geladen werden: {chronicleError}</p>:serverActivityItems.length?<ol>{serverActivityItems.map(item=><li key={item.id}><time>{new Date(item.created_at).toLocaleString('de-DE')}</time><strong>{item.title}</strong><span>{item.detail}</span>{item.link&&hasPermission(item.link.permission)&&<>{item.link.record_available===false&&<span className="object-chronicle-unavailable" role="status">Datensatz nicht mehr verfügbar · </span>}<Link to={item.link.target}>{item.link.label}</Link></>}</li>)}</ol>:<p>Keine freigegebenen Ereignisse für dieses Objekt vorhanden.</p>}{hasPermission('handover:read')&&<button type="button" onClick={()=>navigate('/handovers')}>Übergaben öffnen</button>}</section>
      </div>}
      {active==='stammdaten'&&<div className="object-detail-content">
        {writable?<form className="object-detail-form" onSubmit={saveDetails}><div className="form-grid">
          <label>Objektname<input required value={form.name} onChange={e=>setForm({...form,name:e.target.value})}/></label>
          <label>Objektnummer<input value={form.site_number} onChange={e=>setForm({...form,site_number:e.target.value})}/></label>
          <label>Adresse<input value={form.address} onChange={e=>setForm({...form,address:e.target.value})}/></label>
          <label>Alias<input value={details.alias} onChange={e=>setDetails({...details,alias:e.target.value})}/></label>
          <label>Objektart<input value={details.site_type} onChange={e=>setDetails({...details,site_type:e.target.value})}/></label>
          <label>Straße<input value={details.street} onChange={e=>setDetails({...details,street:e.target.value})}/></label>
          <label>Hausnummer<input value={details.house_number} onChange={e=>setDetails({...details,house_number:e.target.value})}/></label>
          <label>Postleitzahl<input value={details.postal_code} onChange={e=>setDetails({...details,postal_code:e.target.value})}/></label>
          <label>Ort<input value={details.city} onChange={e=>setDetails({...details,city:e.target.value})}/></label>
          <label>Ansprechpartner<input value={details.contact_person} onChange={e=>setDetails({...details,contact_person:e.target.value})}/></label>
          <label>Status<select value={form.status} onChange={e=>setForm({...form,status:e.target.value})}>{Object.entries(statuses).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
          <label>Sicherheitsklassifizierung<select value={form.security_classification} onChange={e=>setForm({...form,security_classification:e.target.value})}>{Object.entries(classifications).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
          <label>Sollbesetzung<input type="number" min="0" max="100000" value={form.required_staff_count} onChange={e=>setForm({...form,required_staff_count:Number(e.target.value)})}/></label>
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
      <ul>{selected.locations.map(location=><li key={location.id} className={recordFocusClass('location',location.id)}>{location.code||'–'} · {locationPath(location)} ({location.location_type}, Sicherheitsstufe {location.security_level}) · Verantwortlich: {location.responsible_employee_name||'–'}{writable&&<button type="button" onClick={()=>editLocation(location)}>Bearbeiten</button>}</li>)}</ul>
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
      <ul>{selected.hazards.map(hazard=><li key={hazard.id} className={recordFocusClass('hazard',hazard.id)}>
        <strong>{hazard.title}</strong> · Risiko {hazard.risk_score} · {hazard.status}{hazard.location_name?` · ${hazard.location_name}`:''} · Verantwortlich: {hazard.responsible_employee_name||'–'}
        {hazard.protective_measures&&<p>Bestehende Schutzmaßnahmen: {hazard.protective_measures}</p>}
        {writable&&<button type="button" onClick={()=>editHazard(hazard)}>Gefährdung bearbeiten</button>}
        {writable&&<button type="button" onClick={()=>editHazardMeasure(hazard)}>Maßnahme hinzufügen</button>}
        <ul aria-label={`Maßnahmen ${hazard.title}`}>
          {hazard.measures.map(measure=><li key={measure.id} className={recordFocusClass('measure',measure.id)}>
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
      <ul>{selected.instructions.map(instruction=><li key={instruction.id} className={recordFocusClass('instruction',instruction.id)}><strong>{instruction.title} v{instruction.version}</strong> · {instruction.status} · {instruction.location_name||'Gesamtes Objekt'} · Kenntnisnahmen: {instruction.acknowledgement_count}<p>{instruction.content}</p>
        {instruction.status==='pending_approval'&&instruction.can_approve&&<><button type="button" onClick={()=>void approveInstruction(instruction.id)}>Freigabe erteilen</button><button type="button" onClick={()=>void returnInstructionForRevision(instruction.id)}>Zur Überarbeitung zurückgeben</button></>}
        {instruction.requires_acknowledgement&&hasPermission('employees:read')&&selected.staffing!==null&&<ul aria-label={`Kenntnisnahmestatus ${instruction.title} v${instruction.version}`}>
        {instruction.acknowledgements.map(acknowledgement=><li key={acknowledgement.employee_id}>{acknowledgement.employee_name}: Bestätigt am {new Date(acknowledgement.acknowledged_at).toLocaleString('de-DE')}</li>)}
        {siteAssignedEmployees.filter(employee=>!instruction.acknowledgements.some(acknowledgement=>acknowledgement.employee_id===employee.id)).map(employee=><li key={employee.id}>{employee.name}: Ausstehend</li>)}
      </ul>}{writable&&<button type="button" onClick={()=>{setSupersedesId(instruction.id);setInstructionForm({title:instruction.title,content:instruction.content,status:'draft',version:instruction.version+1,requires_acknowledgement:instruction.requires_acknowledgement,location_id:'',valid_from:'',valid_until:''});}}>Neue Version vorbereiten</button>}{writable&&hasPermission('employees:read')&&selected.staffing!==null&&isInstructionActive(instruction)&&<button type="button" disabled={!ackEmployee} onClick={()=>void acknowledge(instruction.id)}>Kenntnisnahme erfassen</button>}</li>)}</ul>
      {supersedesId&&<p>Neue Version: {instructionForm.version}</p>}
      </div>}
      {active==='personal'&&<div className="object-detail-content">
      <h3>Personalzuordnungen</h3>
      {selected.staffing===null?<p>Keine Berechtigung für Personalzuordnungen.</p>:selected.staffing.length===0?<p>Keine aktuellen oder zukünftigen Personalzuordnungen vorhanden.</p>:<ul>{selected.staffing.map(assignment=>
        <li key={assignment.id} className={recordFocusClass('assignment',assignment.id)}><strong>{assignment.employee_name}</strong>{assignment.employee_number?` · Personalnr. ${assignment.employee_number}`:''} · {assignment.employment_status??'Status unbekannt'}{assignment.primary_assignment?' · Hauptzuordnung':''} · {assignment.assignment_type}{assignment.role?` · ${assignment.role}`:''} · {new Date(`${assignment.starts_on}T00:00:00Z`).toLocaleDateString('de-DE',{timeZone:'UTC'})}{assignment.ends_on?` – ${new Date(`${assignment.ends_on}T00:00:00Z`).toLocaleDateString('de-DE',{timeZone:'UTC'})}`:' – offen'}{writable&&hasPermission('employees:write')&&!assignment.ends_on&&<button type="button" onClick={()=>void removeStaffingAssignment(assignment)}>Zuordnung beenden</button>}</li>
      )}</ul>}
      <p>Die verbindliche Einsatzfähigkeit wird dienst- und schichtbezogen aus Qualifikationen, Anweisungen, Abwesenheiten und Verfügbarkeiten im Backend geprüft (siehe Dienstplanung).</p>
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
      <h3>Qualifikationen</h3>
      {selected.qualifications==null?<p>Keine Berechtigung für Personal- und Qualifikationsdaten.</p>:selected.qualifications.length===0?<p>Keine Qualifikationen für zugeordnete Mitarbeitende vorhanden.</p>:<ul>{selected.qualifications.map(qualification=><li key={qualification.id} className={`${qualification.issue?.severity==='critical'||qualification.computed_status==='expired'||qualification.computed_status==='revoked'?'object-warning':''} ${recordFocusClass('employee',qualification.employee_id)}`.trim()}>
        <strong>{qualification.employee_name}</strong> · {qualification.qualification_name??qualification.code} · {qualificationReason(qualification)}
        {qualification.valid_until?` · bis ${new Date(`${qualification.valid_until}T00:00:00Z`).toLocaleDateString('de-DE',{timeZone:'UTC'})}`:' · ohne Ablaufdatum'}
        <span className="object-qualification-meta"> · {qualificationEvidence(qualification)}{qualification.last_checked_at?` · zuletzt geprüft ${new Date(qualification.last_checked_at).toLocaleDateString('de-DE')}`:''}</span>
        {hasPermission('qualifications:read')&&<Link to={qualification.employee_url??`/employees/${qualification.employee_id}/qualifikationen`}>Nachweis öffnen</Link>}
      </li>)}</ul>}
      <h3>Zuordnungshistorie</h3>
      {selected.assignmentHistory==null?<p>Keine Berechtigung für die Zuordnungshistorie.</p>:selected.assignmentHistory.length===0?<p>Keine Zuordnungshistorie vorhanden.</p>:<ul>{selected.assignmentHistory.map(assignment=><li key={assignment.id} className={recordFocusClass('assignment',assignment.id)}><strong>{assignment.employee_name}</strong>{assignment.employee_number?` · Personalnr. ${assignment.employee_number}`:''} · {assignment.assignment_type}{assignment.role?` · ${assignment.role}`:''} · {new Date(`${assignment.starts_on}T00:00:00Z`).toLocaleDateString('de-DE',{timeZone:'UTC'})}{assignment.ends_on?` – ${new Date(`${assignment.ends_on}T00:00:00Z`).toLocaleDateString('de-DE',{timeZone:'UTC'})}`:' – offen'}</li>)}</ul>}
      {hasPermission('qualifications:read')&&<button type="button" onClick={()=>navigate('/employees')}>Personalverwaltung öffnen</button>}
      </div>}
      {active==='dienstplanung'&&<div className="object-detail-content"><h3>Dienstplanung und Schichten</h3>
      {selected.shifts===null?<p>Keine Berechtigung für die Dienstplanung.</p>:selected.shifts.length===0?<p>Keine laufenden oder zukünftigen Schichten geplant.</p>:<ul>{selected.shifts.map(shift=><li key={shift.id} className={recordFocusClass('shift',shift.id)||recordFocusClass('period',shift.period_id)}><strong>{shift.role_code}</strong> · {shift.period_name} ({shift.period_status}) · {new Date(shift.starts_at).toLocaleString('de-DE')} – {new Date(shift.ends_at).toLocaleString('de-DE')} · {shift.assignments.length?shift.assignments.flatMap((assignment,index)=>[index>0?', ':null,<span key={assignment.id} className={recordFocusClass('shift_assignment',assignment.id)}>{assignment.employee_name}</span>]):shift.assigned_count?`${shift.assigned_count} zugewiesen`:'Noch nicht zugewiesen'}
        {selected.staffing!==null&&hasPermission('scheduling:write')&&hasPermission('employees:read')&&availableShiftEmployees(shift).length>0&&<form onSubmit={event=>void assignShiftEmployee(event,shift)}>
          <label>Mitarbeiter für {shift.role_code}<select aria-label={`Mitarbeiter für ${shift.role_code}`} required value={shiftAssignmentRequests[shift.id]?.employee_id??''} onChange={event=>setShiftAssignmentRequests(current=>({...current,[shift.id]:{employee_id:event.target.value,client_mutation_id:current[shift.id]?.employee_id===event.target.value?current[shift.id].client_mutation_id:uuid()}}))}><option value="">Mitarbeiter auswählen</option>{availableShiftEmployees(shift).map(employee=><option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></label>
          <button disabled={!shiftAssignmentRequests[shift.id]?.employee_id}>Schicht besetzen</button>
        </form>}
        <div className="object-shift-eligibility">
          <h4>Verbindliche Einsatzprüfung für diese Schicht</h4>
          {eligibilityLoading?<p role="status">Einsatzprüfung wird geladen …</p>:eligibility[shift.id]===undefined?<p>Einsatzprüfung nicht verfügbar.</p>:eligibility[shift.id]===null?<p>Keine Berechtigung für die serverseitige Einsatzprüfung.</p>:<>
            <p>Benötigte Qualifikationen: {eligibility[shift.id]!.required_qualification_codes.join(', ')||'Keine'}</p>
            {eligibility[shift.id]!.employees.length===0?<p>Keine dem Objekt zugeordneten Mitarbeitenden im Schichtzeitraum.</p>:<ul>{eligibility[shift.id]!.employees.map(employee=><li key={employee.employee_id}>
              <strong>{employee.employee_name}</strong> · <span className={`eligibility-${employee.status}`}>{eligibilityLabels[employee.status]}</span>
              {employee.reasons.length>0&&<ul>{employee.reasons.map((reason,index)=><li key={`${reason.code}-${index}`} className={`eligibility-reason-${employee.status}`}><span className="eligibility-reason-code">{reason.code}</span> · {reason.message}{reason.link&&<> · <Link to={eligibilityHref(reason,employee.employee_id)}>{reason.link.label?`Nachweis ${reason.link.label}`:'Nachweis öffnen'}</Link></>}</li>)}</ul>}
            </li>)}</ul>}
          </>}
        </div>
      </li>)}</ul>}
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
      {selected.keys===null?<p>Keine Berechtigung für Schlüssel.</p>:selected.keys.items.length===0?<p>Keine Schlüssel für dieses Objekt erfasst.</p>:<ul>{selected.keys.items.map(key=><li key={key.id} className={recordFocusClass('key',key.id)}><strong>{key.label}</strong> · {key.key_code} · {key.key_type} · {key.status==='available'?'Verfügbar':key.status==='issued'?'Ausgegeben':key.status==='lost'?'Verloren':'Deaktiviert'}{key.status==='issued'?(key.holder_employee_id?' · an Mitarbeitende ausgegeben':' · an Benutzer ausgegeben'):''}
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
      {selected.keyBundles===null?<p>Keine Berechtigung für Schlüsselbunde.</p>:selected.keyBundles.length===0?<p>Keine Schlüsselbunde für dieses Objekt vorhanden.</p>:<ul>{selected.keyBundles.map(bundle=><li key={bundle.id} className={recordFocusClass('key_bundle',bundle.id)}><strong>{bundle.name}</strong> · {bundle.status} · {bundle.item_count} Schlüssel ({bundle.issued_count} ausgegeben)</li>)}</ul>}
      <h3>Letzte Schlüsselbewegungen</h3>
      {selected.keys===null?<p>Keine Berechtigung für die Schlüsselhistorie.</p>:selected.keys.recentMovements.length===0?<p>Keine Schlüsselbewegungen erfasst.</p>:<ul>{selected.keys.recentMovements.map(movement=><li key={movement.id}><strong>{movement.key_label}</strong> · {movement.movement_type} · {movement.from_status??'–'} → {movement.to_status} · {new Date(movement.created_at).toLocaleString('de-DE')}{movement.employee_name?` · ${movement.employee_name}`:''}</li>)}</ul>}
      </div>}
      {active==='dokumente'&&<div className="object-detail-content">
      <h3>Objektdokumente</h3>
      {selected.documents==null?<p>Keine Berechtigung für DMS-Dokumente.</p>:selected.documents.length===0?<p>Keine DMS-Dokumente für dieses Objekt vorhanden.</p>:<ul>{selected.documents.map(document=>{
        const statusLabel=document.status_label??(document.computed_status?documentStatusLabels[document.computed_status]:document.document_status);
        return <li key={document.id} className={`${['abgelaufen','nicht_freigegeben','fehlend'].includes(document.computed_status??'')?'object-warning':''} ${recordFocusClass('document',document.id)}`.trim()}><strong>{document.title}</strong> · {statusLabel}{document.document_number?` · Nr. ${document.document_number}`:''}{document.document_type?` · ${document.document_type}`:''} · {document.approval_status}{document.valid_until?` · gültig bis ${new Date(`${document.valid_until}T00:00:00Z`).toLocaleDateString('de-DE',{timeZone:'UTC'})}`:''}{document.days_until_expiry!=null?` · ${document.days_until_expiry} Tage bis Ablauf`:''}{document.review_state?` · ${reviewStateLabels[document.review_state]}`:''}{document.reviewed_at?` · geprüft am ${formatDue(document.reviewed_at)}`:''}{document.description&&<p>{document.description}</p>}
          <button type="button" onClick={()=>startDocumentEdit(document)}>Metadaten bearbeiten</button>
          {writable&&hasPermission('dms:write')&&<>{['draft','rejected'].includes(document.approval_status)&&<button type="button" onClick={()=>void runDocumentWorkflow(document,'request-review')}>Freigabe anfordern</button>}{['draft','pending_approval','rejected'].includes(document.approval_status)&&<button type="button" onClick={()=>void runDocumentWorkflow(document,'approve')}>Freigabe erteilen</button>}{['pending_approval','approved'].includes(document.approval_status)&&<button type="button" onClick={()=>void runDocumentWorkflow(document,'return-for-revision')}>Zur Überarbeitung zurückgeben</button>}</>}
          <ul>{document.versions.map(version=><li key={version.id}>Version {version.version_no} · {version.lifecycle_state} · {version.size_bytes} Bytes {version.lifecycle_state==='available'&&<button type="button" onClick={()=>void downloadDocument(document,version)}>Herunterladen</button>}</li>)}</ul></li>;
      })}</ul>}
      <h3>Pflichtdokumente</h3>
      {selected.documentRequirements==null?<p>Keine Berechtigung für Dokumentanforderungen.</p>:selected.documentRequirements.length===0?<p>Keine Pflichtdokumenttypen hinterlegt.</p>:<ul>{selected.documentRequirements.map(requirement=><li key={requirement.id} className={`${requirement.missing?'object-warning':''} ${recordFocusClass('requirement',requirement.id)}`.trim()}><strong>{requirement.document_type}</strong> · {requirement.required?'Pflicht':'Optional'} · {requirement.status_label??(requirement.missing?'Fehlt oder nicht gültig/freigegeben':'Erfüllt')}{requirement.days_until_expiry!=null?` · noch ${requirement.days_until_expiry} Tage`:''}{requirement.review_state&&requirement.review_state!=='none'?` · ${reviewStateLabels[requirement.review_state]}`:''}{requirement.responsible_employee_name?` · Verantwortlich: ${requirement.responsible_employee_name}`:''}{writable&&hasPermission('dms:write')&&<button type="button" onClick={()=>void removeDocumentRequirement(requirement)}>Anforderung entfernen</button>}</li>)}</ul>}
      {selected.documentRequirements!==null&&writable&&hasPermission('dms:write')&&<form onSubmit={saveDocumentRequirement}>
        <label>Pflichtdokumenttyp<input required value={documentRequirementForm.document_type} onChange={event=>setDocumentRequirementForm({...documentRequirementForm,document_type:event.target.value})}/></label>
        {hasPermission('employees:read')&&<label>Verantwortlich<select value={documentRequirementForm.responsible_employee_id} onChange={event=>setDocumentRequirementForm({...documentRequirementForm,responsible_employee_id:event.target.value})}><option value="">Nicht zugewiesen</option>{siteAssignedEmployees.map(employee=><option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></label>}
        <label><input type="checkbox" checked={documentRequirementForm.required} onChange={event=>setDocumentRequirementForm({...documentRequirementForm,required:event.target.checked})}/> Pflichtdokument</label>
        <button>Anforderung speichern</button>
      </form>}
      {editingDocumentId&&<form className="object-inline-form" onSubmit={saveDocumentMetadata}>
        <h4>Dokumentenmetadaten bearbeiten</h4>
        <label>Dokumenttitel bearbeiten<input required value={editDocumentTitle} onChange={event=>setEditDocumentTitle(event.target.value)}/></label>
        <label>Dokumentnummer bearbeiten<input value={editDocumentMetadata.document_number} onChange={event=>setEditDocumentMetadata({...editDocumentMetadata,document_number:event.target.value})}/></label>
        <label>Dokumenttyp bearbeiten<input value={editDocumentMetadata.document_type} onChange={event=>setEditDocumentMetadata({...editDocumentMetadata,document_type:event.target.value})}/></label>
        <label>Gültig ab bearbeiten<input type="date" value={editDocumentMetadata.valid_from} onChange={event=>setEditDocumentMetadata({...editDocumentMetadata,valid_from:event.target.value})}/></label>
        <label>Gültig bis bearbeiten<input type="date" value={editDocumentMetadata.valid_until} onChange={event=>setEditDocumentMetadata({...editDocumentMetadata,valid_until:event.target.value})}/></label>
        <label>Wiedervorlage bearbeiten<input type="date" value={editDocumentMetadata.review_on} onChange={event=>setEditDocumentMetadata({...editDocumentMetadata,review_on:event.target.value})}/></label>
        <p>Freigaben erfolgen ausschließlich über den auditierten DMS-Freigabeworkflow.</p>
        <button>Metadaten speichern</button><button type="button" onClick={()=>setEditingDocumentId(null)}>Abbrechen</button>
      </form>}
      {selected.documents!=null&&hasPermission('dms:write')&&<form className="object-inline-form" onSubmit={uploadSiteDocument}>
        <h4>Neues Dokument hochladen</h4>
        <label>Dokumenttitel<input required value={uploadDocumentTitle} onChange={event=>setUploadDocumentTitle(event.target.value)}/></label>
        <label>Dokumentnummer<input value={uploadDocumentMetadata.document_number} onChange={event=>setUploadDocumentMetadata({...uploadDocumentMetadata,document_number:event.target.value})}/></label>
        <label>Dokumenttyp<input value={uploadDocumentMetadata.document_type} onChange={event=>setUploadDocumentMetadata({...uploadDocumentMetadata,document_type:event.target.value})}/></label>
        {hasPermission('employees:read')&&<label>Dokumentverantwortlich<select value={uploadDocumentMetadata.responsible_employee_id} onChange={event=>setUploadDocumentMetadata({...uploadDocumentMetadata,responsible_employee_id:event.target.value})}><option value="">Nicht zugewiesen</option>{siteAssignedEmployees.map(employee=><option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></label>}
        <label>Objektbereich<select value={uploadDocumentMetadata.location_id} onChange={event=>setUploadDocumentMetadata({...uploadDocumentMetadata,location_id:event.target.value})}><option value="">Gesamtes Objekt</option>{selected.locations.map(location=><option key={location.id} value={location.id}>{locationPath(location)}</option>)}</select></label>
        <label>Gültig ab<input type="date" value={uploadDocumentMetadata.valid_from} onChange={event=>setUploadDocumentMetadata({...uploadDocumentMetadata,valid_from:event.target.value})}/></label>
        <label>Gültig bis<input type="date" value={uploadDocumentMetadata.valid_until} onChange={event=>setUploadDocumentMetadata({...uploadDocumentMetadata,valid_until:event.target.value})}/></label>
        <label>Wiedervorlage<input type="date" value={uploadDocumentMetadata.review_on} onChange={event=>setUploadDocumentMetadata({...uploadDocumentMetadata,review_on:event.target.value})}/></label>
        <label>Datei<input ref={documentInput} required type="file" onChange={(event:ChangeEvent<HTMLInputElement>)=>setDocumentFile(event.target.files?.[0]??null)}/></label>
        <button>Dokument hochladen und prüfen</button>
      </form>}
      </div>}
      {active==='vorfaelle'&&<div className="object-detail-content">
      <h3>Alarme am Objekt</h3>
      {selected.alarms===null?<p>Keine Berechtigung für Alarme.</p>:selected.alarms.length===0?<p>Keine site- oder gerätebezogenen Alarme für dieses Objekt vorhanden.</p>:<ul>{selected.alarms.map(alarm=><li key={alarm.id} className={recordFocusClass('alarm',alarm.id)}><strong>{alarm.priority_name??alarm.severity}</strong> · {alarm.type} · {alarm.status} · {new Date(alarm.triggered_at).toLocaleString('de-DE')}<p>{alarm.description}</p></li>)}</ul>}
      {hasPermission('alarms:read')&&<button type="button" onClick={()=>navigate('/alarms')}>Alarmverwaltung öffnen</button>}
      <h3>Einsätze</h3>
      {selected.incidents===null?<p>Keine Berechtigung für Einsätze.</p>:selected.incidents.length===0?<p>Keine Einsätze für dieses Objekt vorhanden.</p>:<ul>{selected.incidents.map(incident=><li key={incident.id} className={recordFocusClass('incident',incident.id)}><strong>{incident.priority_name??'Einsatz'}</strong> · {incident.status} · {new Date(incident.created_at).toLocaleString('de-DE')} · {incident.assignees.length?incident.assignees.map(assignee=>assignee.name).join(', '):incident.assigned_count?`${incident.assigned_count} zugewiesen`:'Keine Zuweisung'}<p>{incident.description}</p></li>)}</ul>}
      {hasPermission('incidents:read')&&<button type="button" onClick={()=>navigate('/incidents')}>Einsatzverwaltung öffnen</button>}
      <h3>Objektbezogene Berichte und Nachweise</h3>
      {(hasPermission('customer_reports:export')||hasPermission('customer_portal:read'))?<><p>Die bestehende Berichtsfunktion kann Kontrollgänge, Wachbuch, Alarme oder Einsätze für dieses Objekt auswerten.</p><a href={`/customer-reports?site_id=${encodeURIComponent(selected.site.id)}`}>Berichte für dieses Objekt öffnen</a></>:<p>Keine Berechtigung für objektbezogene Berichte.</p>}
      </div>}
      {active==='aufgaben'&&<div className="object-detail-content">
      <h3>Kundenaufgaben und Wiedervorlagen</h3>
      {selected.customerTasks===null?<p>Keine Berechtigung für Kundenaufgaben.</p>:selected.customerTasks.length===0?<p>Keine Kundenaufgaben für aktive Objektbeziehungen vorhanden.</p>:<ul>{selected.customerTasks.map(task=><li key={task.id} className={recordFocusClass('task',task.id)}><strong>{task.title}</strong> · {task.customer_name} · {task.status} · {task.due_at?new Date(task.due_at).toLocaleString('de-DE'):'Ohne Frist'}{task.assigned_employee_name?` · ${task.assigned_employee_name}`:''}{task.description&&<p>{task.description}</p>}{task.status==='open'&&hasPermission('customers:write')&&<button type="button" onClick={()=>void completeCustomerTask(task)}>Als erledigt markieren</button>}</li>)}</ul>}
      {selected.customers!==null&&hasPermission('customers:write')&&<form onSubmit={createCustomerTask}><label>Kunde<select required value={taskCustomerId} onChange={event=>setTaskCustomerId(event.target.value)}><option value="">Kunde auswählen</option>{selectedCustomers.filter(customer=>customer.relationship_status==='active').map(customer=><option key={customer.customer_id} value={customer.customer_id}>{customer.customer_name}</option>)}</select></label><label>Aufgabe / Wiedervorlage<input required value={taskTitle} onChange={event=>setTaskTitle(event.target.value)}/></label><label>Fällig am<input type="datetime-local" value={taskDue} onChange={event=>setTaskDue(event.target.value)}/></label>{hasPermission('employees:read')&&<label>Verantwortlich<select value={taskAssignee} onChange={event=>setTaskAssignee(event.target.value)}><option value="">Nicht zugewiesen</option>{employees.map(employee=><option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></label>}<button>Aufgabe anlegen</button></form>}
      </div>}
      {active==='technik'&&<div className="object-detail-content">
      <h3>Technische Anlagen und Geräte</h3>
      {selected.devices==null?<p>Keine Berechtigung für den technischen Gerätebestand.</p>:selected.devices.length===0?<p>Keine technischen Anlagen für dieses Objekt erfasst.</p>:<ul>{selected.devices.map(device=><li key={device.id} className={recordFocusClass('device',device.id)}><strong>{device.name}</strong>{device.asset_number?` · Anlagen-Nr. ${device.asset_number}`:''}{device.category?` · ${device.category}`:''} · {device.operational_status==='active'?'Aktiv':device.operational_status==='maintenance'?'Wartung':device.operational_status==='fault'?'Störung':device.operational_status==='offline'?'Offline':'Stillgelegt'}{device.serial_number?` · SN ${device.serial_number}`:''}{device.next_maintenance_on?` · nächste Wartung ${new Date(`${device.next_maintenance_on}T00:00:00Z`).toLocaleDateString('de-DE',{timeZone:'UTC'})}`:''}{hasPermission('devices:write')&&<button type="button" onClick={()=>startDeviceEdit(device)}>Anlage bearbeiten</button>}</li>)}</ul>}
      {hasPermission('devices:write')&&<button type="button" onClick={()=>startDeviceEdit()}>Anlage erfassen</button>}
      {deviceFormOpen&&<form onSubmit={saveDevice}>
        <h4>{editingDeviceId?'Anlage bearbeiten':'Neue Anlage erfassen'}</h4>
        <label>Anlagenbezeichnung<input required value={deviceForm.name} onChange={event=>setDeviceForm({...deviceForm,name:event.target.value})}/></label>
        <label>Anlagennummer<input value={deviceForm.asset_number} onChange={event=>setDeviceForm({...deviceForm,asset_number:event.target.value})}/></label>
        <label>Kategorie<select value={deviceForm.category} onChange={event=>setDeviceForm({...deviceForm,category:event.target.value})}><option value="">Kategorie auswählen</option>{['Videoüberwachung','Zutrittskontrolle','Einbruchmeldeanlage','Brandmeldeanlage','Alarmierungssysteme','Funktechnik','Schranken und Tore','Sicherheitstechnik','Sonstige technische Anlagen'].map(category=><option key={category} value={category}>{category}</option>)}</select></label>
        <label>Hersteller<input value={deviceForm.manufacturer} onChange={event=>setDeviceForm({...deviceForm,manufacturer:event.target.value})}/></label>
        <label>Modell<input value={deviceForm.model} onChange={event=>setDeviceForm({...deviceForm,model:event.target.value})}/></label>
        <label>Seriennummer<input value={deviceForm.serial_number} onChange={event=>setDeviceForm({...deviceForm,serial_number:event.target.value})}/></label>
        <label>Standort<select value={deviceForm.location_id} onChange={event=>setDeviceForm({...deviceForm,location_id:event.target.value})}><option value="">Gesamtes Objekt</option>{selected.locations.map(location=><option key={location.id} value={location.id}>{locationPath(location)}</option>)}</select></label>
        {hasPermission('employees:read')&&<label>Verantwortlich<select value={deviceForm.responsible_employee_id} onChange={event=>setDeviceForm({...deviceForm,responsible_employee_id:event.target.value})}><option value="">Nicht zugewiesen</option>{siteAssignedEmployees.map(employee=><option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></label>}
        <label>Betriebsstatus<select value={deviceForm.operational_status} onChange={event=>setDeviceForm({...deviceForm,operational_status:event.target.value})}><option value="active">Aktiv</option><option value="maintenance">Wartung</option><option value="fault">Störung</option><option value="offline">Offline</option><option value="decommissioned">Stillgelegt</option></select></label>
        <label>Installiert am<input type="date" value={deviceForm.installed_on} onChange={event=>setDeviceForm({...deviceForm,installed_on:event.target.value})}/></label>
        <label>Inbetriebnahme<input type="date" value={deviceForm.commissioned_on} onChange={event=>setDeviceForm({...deviceForm,commissioned_on:event.target.value})}/></label>
        <label>Letzte Prüfung<input type="date" value={deviceForm.last_inspection_on} onChange={event=>setDeviceForm({...deviceForm,last_inspection_on:event.target.value})}/></label>
        <label>Nächste Prüfung<input type="date" value={deviceForm.next_inspection_on} onChange={event=>setDeviceForm({...deviceForm,next_inspection_on:event.target.value})}/></label>
        <label>Wartungsintervall (Tage)<input type="number" min="1" value={deviceForm.maintenance_interval_days} onChange={event=>setDeviceForm({...deviceForm,maintenance_interval_days:Number(event.target.value)})}/></label>
        <label>Nächste Wartung<input type="date" value={deviceForm.next_maintenance_on} onChange={event=>setDeviceForm({...deviceForm,next_maintenance_on:event.target.value})}/></label>
        <label>Letzte Wartung<input type="date" value={deviceForm.last_maintenance_on} onChange={event=>setDeviceForm({...deviceForm,last_maintenance_on:event.target.value})}/></label>
        <button>{editingDeviceId?'Anlage speichern':'Anlage anlegen'}</button><button type="button" onClick={()=>{setEditingDeviceId(null);setDeviceFormOpen(false);setDeviceForm({name:'',asset_number:'',category:'',manufacturer:'',model:'',serial_number:'',location_id:'',responsible_employee_id:'',operational_status:'active',installed_on:'',commissioned_on:'',last_inspection_on:'',next_inspection_on:'',maintenance_interval_days:0,next_maintenance_on:'',last_maintenance_on:''});}}>Abbrechen</button>
      </form>}
      <h3>Technik und Instandhaltung</h3>
      {selected.maintenance===null?<p>Keine Berechtigung für Wartungseinträge im Wachbuch.</p>:selected.maintenance.length===0?<p>Keine Technik- oder Instandhaltungseinträge vorhanden.</p>:<ul>{selected.maintenance.map(entry=><li key={entry.id}><strong>{entry.priority_name}</strong> · {entry.status} · Version {entry.revision_no} · {new Date(entry.created_at).toLocaleString('de-DE')}<p>{entry.content}</p></li>)}</ul>}
      {maintenanceReadable&&hasPermission('watchbook:read')&&hasPermission('watchbook:write')&&<form onSubmit={createMaintenanceEntry}>
        <h4>Technik-/Instandhaltungseintrag erfassen</h4>
        <label>Priorität<select required value={maintenancePriorityCode} onChange={event=>setMaintenancePriorityCode(event.target.value)} disabled={!maintenanceOptionsLoaded}>{maintenancePriorities.map(priority=><option key={priority.code} value={priority.code}>{priority.name}</option>)}</select></label>
        <label>Eintrag<textarea required maxLength={10000} value={maintenanceContent} onChange={event=>setMaintenanceContent(event.target.value)}/></label>
        <button disabled={!maintenanceOptionsLoaded||!maintenanceCategoryId||!maintenancePriorityCode}>Im Wachbuch erfassen</button>
      </form>}
      <h3>Wartungsaufträge</h3>
      {selected.maintenanceOrders===null?<p>Keine Berechtigung für Wartungsaufträge.</p>:<>
        {hasPermission('devices:write')&&<button type="button" onClick={()=>setOrderFormOpen(open=>!open)}>{orderFormOpen?'Auftragsformular schließen':'Wartungsauftrag erfassen'}</button>}
        {orderFormOpen&&hasPermission('devices:write')&&<form onSubmit={createMaintenanceOrder}>
          <h4>Neuen Wartungsauftrag anlegen</h4>
          <label>Anlage<select required value={orderForm.device_id} onChange={event=>setOrderForm({...orderForm,device_id:event.target.value})}><option value="">Anlage auswählen</option>{(selected.devices??[]).map(device=><option key={device.id} value={device.id}>{device.name}{device.asset_number?` · ${device.asset_number}`:''}</option>)}</select></label>
          <label>Art<select value={orderForm.maintenance_type} onChange={event=>setOrderForm({...orderForm,maintenance_type:event.target.value})}><option value="inspection">Prüfung</option><option value="preventive">Vorbeugend</option><option value="corrective">Korrigierend</option><option value="repair">Reparatur</option><option value="other">Sonstige</option></select></label>
          <label>Beschreibung<textarea required value={orderForm.description} onChange={event=>setOrderForm({...orderForm,description:event.target.value})}/></label>
          <label>Priorität<select value={orderForm.priority_code} onChange={event=>setOrderForm({...orderForm,priority_code:event.target.value})}>{maintenancePriorities.length?maintenancePriorities.map(priority=><option key={priority.code} value={priority.code}>{priority.name}</option>):<><option value="critical">Kritisch</option><option value="high">Hoch</option><option value="medium">Mittel</option><option value="low">Niedrig</option></>}</select></label>
          <label>Fällig am<input type="date" value={orderForm.due_on} onChange={event=>setOrderForm({...orderForm,due_on:event.target.value})}/></label>
          {hasPermission('employees:read')&&<label>Verantwortlich<select value={orderForm.responsible_employee_id} onChange={event=>setOrderForm({...orderForm,responsible_employee_id:event.target.value})}><option value="">Nicht zugewiesen</option>{siteAssignedEmployees.map(employee=><option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></label>}
          <label>Startstatus<select value={orderForm.status} onChange={event=>setOrderForm({...orderForm,status:event.target.value})}><option value="planned">Geplant</option><option value="open">Offen</option><option value="in_progress">In Bearbeitung</option></select></label>
          <button>Auftrag anlegen</button>
        </form>}
        {maintenanceOrders.length===0?<p>Keine Wartungsaufträge für dieses Objekt vorhanden.</p>:<ul>{maintenanceOrders.map(order=><li key={order.id} className={`${order.overdue?'object-warning':''} ${recordFocusClass('maintenance_order',order.id)}`.trim()}>
          <strong>{order.order_number}</strong> · {order.device_name??order.device_id}{order.asset_number?` · ${order.asset_number}`:''} · {order.status_label}{order.overdue?' · überfällig':''}{order.due_on?` · fällig am ${formatDue(order.due_on)}`:''}
          <p>{order.description}</p>
          {order.responsible_employee_name&&<p>Verantwortlich: {order.responsible_employee_name}</p>}
          {order.performed_work&&<p>Durchgeführt: {order.performed_work}{order.result?` · Ergebnis: ${order.result}`:''}</p>}
          {order.remarks&&<p>Bemerkungen: {order.remarks}</p>}
          {order.next_maintenance_on&&<p>Nächste Wartung: {order.next_maintenance_on}</p>}
          {hasPermission('devices:write')&&['planned','open','in_progress'].includes(order.status)&&<>
            {order.status!=='open'&&<button type="button" onClick={()=>void updateMaintenanceOrder(order,'open')}>Als offen markieren</button>}
            {order.status!=='in_progress'&&<button type="button" onClick={()=>void updateMaintenanceOrder(order,'in_progress')}>In Bearbeitung nehmen</button>}
            <button type="button" onClick={()=>{setCompletingOrderId(order.id);setCancellingOrderId(null);}}>Abschließen</button>
            <button type="button" onClick={()=>{setCancellingOrderId(order.id);setCompletingOrderId(null);}}>Abbrechen</button>
          </>}
          {completingOrderId===order.id&&<form onSubmit={completeMaintenanceOrder}>
            <h4>Auftrag abschließen</h4>
            <label>Durchgeführte Arbeit<textarea required value={completionForm.performed_work} onChange={event=>setCompletionForm({...completionForm,performed_work:event.target.value})}/></label>
            <label>Ergebnis<input value={completionForm.result} onChange={event=>setCompletionForm({...completionForm,result:event.target.value})}/></label>
            <label>Bemerkungen<textarea value={completionForm.remarks} onChange={event=>setCompletionForm({...completionForm,remarks:event.target.value})}/></label>
            <button>Abschluss erfassen</button><button type="button" onClick={()=>setCompletingOrderId(null)}>Abbrechen</button>
          </form>}
          {cancellingOrderId===order.id&&<form onSubmit={cancelMaintenanceOrder}>
            <label>Begründung<input required value={cancellationReason} onChange={event=>setCancellationReason(event.target.value)}/></label>
            <button>Abbruch erfassen</button><button type="button" onClick={()=>setCancellingOrderId(null)}>Abbrechen</button>
          </form>}
          {hasPermission('devices:write')&&(documents??[]).length>0&&<label>Nachweis verknüpfen<select aria-label={`Nachweis für ${order.order_number}`} value="" onChange={event=>void linkMaintenanceDocument(order,event.target.value)}><option value="">Dokument auswählen</option>{documents.map(document=><option key={document.id} value={document.id}>{document.title}</option>)}</select></label>}
          {order.documents.length>0&&<p>Verknüpfte Nachweise: {order.documents.map(link=>`${link.document_title??link.document_id}${link.document_status?` (${link.document_status})`:''}`).join(', ')}</p>}
        </li>)}</ul>}
      </>}
      </div>}
      {active==='journal'&&<div className="object-detail-content">
      <h3>Objektjournal</h3>{selected.journal===null?<p>Keine Berechtigung für das Wachbuch.</p>:<ul>{selected.journal.map(entry=><li key={entry.id} className={recordFocusClass('entry',entry.id)}><strong>{entry.category_name}</strong> · {entry.priority_name} · {entry.status} · Version {entry.revision_no} · {new Date(entry.created_at).toLocaleString('de-DE')}<p>{entry.content}</p></li>)}</ul>}
      <h3>Serverchronik mit Filtern</h3>
      <form onSubmit={event=>{event.preventDefault();if(selected)void loadChronicle(selected.site.id,chronicleFilter);}}>
        <label>Ereignistyp<select aria-label="Ereignistyp filtern" value={chronicleFilter.type} onChange={event=>setChronicleFilter({...chronicleFilter,type:event.target.value})}><option value="">Alle Typen</option>{chronicleCatalog.map(type=><option key={type} value={type}>{type}</option>)}</select></label>
        <label>Von<input aria-label="Chronik von" type="date" value={chronicleFilter.from} onChange={event=>setChronicleFilter({...chronicleFilter,from:event.target.value})}/></label>
        <label>Bis<input aria-label="Chronik bis" type="date" value={chronicleFilter.to} onChange={event=>setChronicleFilter({...chronicleFilter,to:event.target.value})}/></label>
        <button>Chronik filtern</button>
      </form>
      {chronicleLoading?<p role="status">Chronik wird geladen …</p>:chronicleEvents.length===0?<p>Keine Ereignisse für die gewählten Filter vorhanden.</p>:<ol>{chronicleEvents.map(event=><li key={event.id}><time>{new Date(event.occurred_at).toLocaleString('de-DE')}</time><strong>{event.category}</strong><span>{event.event_kind} · {event.summary}</span>{event.actor_email&&<span> · {event.actor_email}</span>}{event.link&&hasPermission(event.link.permission)?<>{event.link.record_available===false&&<span className="object-chronicle-unavailable" role="status">Datensatz nicht mehr verfügbar · </span>}<Link to={event.link.target} title={event.link.entity_id??undefined}>{event.link.label}</Link></>:<span className="object-chronicle-no-link">Kein direkter Datensatzlink</span>}</li>)}</ol>}
      </div>}
    </article>:detailLoading?<p role="status">Objektakte wird geladen …</p>:detailError?<p className="object-empty">Die Objektakte konnte nicht geladen werden. Bitte Berechtigung und Verbindung prüfen.</p>:null):<>
      <div className="object-page-actions">{writable&&<button type="button" onClick={()=>startEdit()}>+ Objekt anlegen</button>}</div>
      {listLoading?<p role="status">Objekte werden geladen …</p>:<div className="object-metrics" aria-label="Objektkennzahlen">
        <article><strong>{metrics?.total_sites??'–'}</strong><span>Objekte gesamt</span></article>
        <article><strong>{metrics?.active_sites??'–'}</strong><span>Aktiv</span></article>
        <article><strong>{metrics?.preparation_sites??'–'}</strong><span>In Vorbereitung</span></article>
        <article><strong>{metrics?.restricted_sites??'–'}</strong><span>Eingeschränkt</span></article>
        <article><strong>{metrics?.critical_sites??'–'}</strong><span>Kritisch</span></article>
        <article><strong>{metrics?.sites_with_critical_hazards??'–'}</strong><span>Mit kritischen Gefährdungen</span></article>
        <article><strong>{metrics?.sites_with_open_tasks??'–'}</strong><span>Mit offenen Aufgaben</span></article>
        <article><strong>{metrics?.sites_with_understaffing??'–'}</strong><span>Mit Personalunterdeckung</span></article>
        <article><strong>{metrics?.open_hazards??'–'}</strong><span>Offene Gefährdungen</span></article>
        <article><strong>{metrics?.overdue_measures??'–'}</strong><span>Überfällige Maßnahmen</span></article>
        <article><strong>{metrics?.expiring_contracts??'–'}</strong><span>Auslaufende Verträge · 30 Tage</span></article>
        <article><strong>{metrics?.sites_without_available_documents??'–'}</strong><span>Ohne verfügbare DMS-Version</span></article>
        <article><strong>{metrics?.valid_documents??'–'}</strong><span>Gültige Dokumente</span></article>
        <article><strong>{metrics?.expired_documents??'–'}</strong><span>Abgelaufene Dokumente</span></article>
        <article><strong>{metrics?.documents_expiring_7d??'–'}</strong><span>Dokumente ≤ 7 Tage</span></article>
        <article><strong>{metrics?.documents_expiring_30d??'–'}</strong><span>Dokumente 8–30 Tage</span></article>
        <article><strong>{metrics?.documents_review_due??'–'}</strong><span>Dokumente mit Prüffrist</span></article>
        <article><strong>{metrics?.unapproved_documents??'–'}</strong><span>Nicht freigegebene Dokumente</span></article>
        <article><strong>{metrics?.missing_required_documents??'–'}</strong><span>Fehlende Pflichtdokumente</span></article>
        <article><strong>{metrics?.open_maintenance??'–'}</strong><span>Offene Wartungsaufträge</span></article>
        <article><strong>{metrics?.overdue_maintenance??'–'}</strong><span>Überfällige Wartungsaufträge</span></article>
      </div>}
      <PriorityActionList actions={priorityActions} title="Dringende Aufgaben in allen Objekten" showSite/>
      {formOpen&&writable&&<form onSubmit={save} className="object-create-form">
        <label>Objektname<input required value={form.name} onChange={e=>setForm({...form,name:e.target.value})}/></label>
        <label>Objektnummer<input value={form.site_number} onChange={e=>setForm({...form,site_number:e.target.value})}/></label>
        <label>Adresse<input value={form.address} onChange={e=>setForm({...form,address:e.target.value})}/></label>
        <label>Status<select value={form.status} onChange={e=>setForm({...form,status:e.target.value})}>{Object.entries(statuses).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
        <label>Sicherheitsklassifizierung<select value={form.security_classification} onChange={e=>setForm({...form,security_classification:e.target.value})}>{Object.entries(classifications).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
        <label>Sollbesetzung<input type="number" min="0" max="100000" value={form.required_staff_count} onChange={e=>setForm({...form,required_staff_count:Number(e.target.value)})}/></label>
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
          <label><input type="checkbox" checked={criticalFilter} onChange={event=>{setCriticalFilter(event.target.checked);setPage(1);}}/> Kritische Gefährdungen</label>
          <label><input type="checkbox" checked={understaffedFilter} onChange={event=>{setUnderstaffedFilter(event.target.checked);setPage(1);}}/> Personalunterdeckung</label>
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
