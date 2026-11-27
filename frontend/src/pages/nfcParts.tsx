import {useState,type FormEvent,type ReactNode} from 'react';
import {ApiError} from '../lib/api';
import {formatDateTime,formatNumber} from '../lib/format';
import {statusLabel} from '../lib/status';
import {commonText} from '../lib/text';
import {Dialog} from './keyParts';

export type NfcDevice={
  id:string;identifier:string;device_type:string;manufacturer:string;status:string;
  employee_id:string|null;site_id:string|null;control_point_id:string|null;
  employee_name?:string|null;site_name?:string|null;control_point_name?:string|null;control_point_site_id?:string|null;
  model?:string|null;serial_number?:string|null;description?:string|null;
  notes:string;registered_at:string;updated_at:string;
  lost_at?:string|null;blocked_at?:string|null;replaced_at?:string|null;
  archived_at?:string|null;archived_reason?:string|null;recovered_at?:string|null;recovered_reason?:string|null;
  event_reason?:string|null;reported_by?:string|null;reported_by_email?:string|null;
  last_used_at?:string|null;
};

export type NfcOverview={
  total:number;active_tags:number;active_readers:number;blocked:number;lost:number;replaced:number;
  archived:number;recent_devices:number;unassigned:number;scans:number;scan_count:number;devices:number;
  days:number;from?:string;to?:string;recent:NfcDevice[];
};

export type NfcOptions={
  sites:{id:string;name:string}[];
  control_points:{id:string;site_id:string;name:string;site_name?:string}[];
  employees:{id:string;name:string}[];
  devices?:{id:string;identifier:string;device_type:string;manufacturer:string;status:string;
    employee_id?:string|null;site_id?:string|null;control_point_id?:string|null;
    employee_name?:string|null;site_name?:string|null;control_point_name?:string|null;
    archived_at?:string|null;replaced_at?:string|null}[];
};

export type NfcAssignmentKind='none'|'site'|'control_point'|'employee';

export type NfcForm={
  identifier:string;device_type:string;manufacturer:string;model:string;serial_number:string;description:string;notes:string;
  assignment_kind:NfcAssignmentKind;site_id:string;control_point_id:string;employee_id:string;
};

export type NfcAssignmentEvent={
  id:string;previous_assignment:Record<string,string|null>;assignment:Record<string,string|null>;
  actor_user_id?:string|null;actor_email?:string|null;reason?:string|null;assigned_at:string;
};

export type NfcReplacement={
  id:string;old_device_id:string;new_device_id:string;replaced_at:string;reason:string;notes?:string|null;
  old_assignment:Record<string,string|null>;new_assignment:Record<string,string|null>;
  actor_user_id?:string|null;actor_email?:string|null;
};

export type NfcScanRecord={
  id:string;nfc_uid?:string|null;nfc_device_id?:string|null;
  control_point_id?:string|null;control_point_name?:string|null;
  site_id?:string|null;site_name?:string|null;route_id?:string|null;route_name?:string|null;
  employee_id?:string|null;employee_name?:string|null;
  scanned_at?:string|null;server_received_at:string;effective_at?:string|null;
  deviation?:string|null;scan_authentication?:string|null;
  outcome:'accepted'|'rejected';rejection_reason?:string|null;rejection_code?:string|null;
  actor_email?:string|null;
};

export type NfcDocument={
  id:string;title:string;document_type?:string|null;document_number?:string|null;
  approval_status?:string|null;created_at:string;versions:{id:string;version_no:number;lifecycle_state?:string|null}[];
};

export type NfcHistoryEvent={
  id:string;event_type:string;entity_type?:string|null;details:Record<string,unknown>;
  actor_user_id?:string|null;actor_email?:string|null;created_at:string;
};

export type NfcFileData={
  device:NfcDevice;assignment_history:NfcAssignmentEvent[];replacements:NfcReplacement[];
  documents:NfcDocument[];history:NfcHistoryEvent[];
};

export const emptyNfcForm:()=>NfcForm=()=>({
  identifier:'',device_type:'tag',manufacturer:'',model:'',serial_number:'',description:'',notes:'',
  assignment_kind:'none',site_id:'',control_point_id:'',employee_id:'',
});

export function nfcFormFromDevice(device:NfcDevice):NfcForm{
  const assignment_kind:NfcAssignmentKind=device.control_point_id?'control_point':device.site_id?'site':device.employee_id?'employee':'none';
  return {
    identifier:device.identifier,device_type:device.device_type,manufacturer:device.manufacturer,
    model:device.model??'',serial_number:device.serial_number??'',description:device.description??'',notes:device.notes??'',
    assignment_kind,site_id:device.site_id??'',control_point_id:device.control_point_id??'',employee_id:device.employee_id??'',
  };
}

export function nfcPayloadFromForm(form:NfcForm):Record<string,unknown>{
  const payload:Record<string,unknown>={
    identifier:form.identifier.trim(),
    device_type:form.device_type,
    manufacturer:form.manufacturer.trim(),
    model:form.model.trim(),
    serial_number:form.serial_number.trim(),
    description:form.description.trim(),
    notes:form.notes.trim(),
    employee_id:null,site_id:null,control_point_id:null,
  };
  if(form.assignment_kind==='site')payload.site_id=form.site_id;
  if(form.assignment_kind==='control_point')payload.control_point_id=form.control_point_id;
  if(form.assignment_kind==='employee')payload.employee_id=form.employee_id;
  return payload;
}

export function validateNfcForm(form:NfcForm,validateAssignment=true):string{
  if(!form.identifier.trim())return 'Bitte eine NFC-Kennung angeben.';
  if(form.identifier.trim().length>200)return 'Die NFC-Kennung ist zu lang.';
  if(!['tag','reader'].includes(form.device_type))return 'Bitte einen gültigen Gerätetyp auswählen.';
  if(!form.manufacturer.trim())return 'Bitte einen Hersteller angeben.';
  if(form.model.length>200)return 'Das Modell ist zu lang (maximal 200 Zeichen).';
  if(form.serial_number.length>200)return 'Die Seriennummer ist zu lang (maximal 200 Zeichen).';
  if(form.description.length>2000)return 'Die Beschreibung ist zu lang (maximal 2000 Zeichen).';
  if(form.notes.length>2000)return 'Die Notizen sind zu lang (maximal 2000 Zeichen).';
  if(validateAssignment&&form.assignment_kind==='site'&&!form.site_id)return 'Bitte ein Objekt auswählen.';
  if(validateAssignment&&form.assignment_kind==='control_point'){
    if(form.device_type!=='tag')return 'Nur NFC-Tags können einem Kontrollpunkt zugeordnet werden.';
    if(!form.control_point_id)return 'Bitte einen Kontrollpunkt auswählen.';
  }
  if(validateAssignment&&form.assignment_kind==='employee'&&!form.employee_id)return 'Bitte einen Mitarbeiter auswählen.';
  return '';
}

export function nfcMessage(cause:unknown):string{
  const error=cause as ApiError|Error;
  if(error instanceof ApiError&&error.fields?.identifier)return 'Diese NFC-Kennung ist bereits vergeben.';
  return error.message||commonText.requestFailed;
}

export function nfcStatusClass(status:string):string{
  return `object-status ${status==='active'?'active':status==='blocked'||status==='lost'?'restricted':status==='replaced'?'archived':''}`.trim();
}

export function nfcStatusLabel(status:string|null|undefined):string{
  return status?statusLabel(status,'nfc'):commonText.notAvailable;
}

export function nfcTypeLabel(type:string):string{
  return statusLabel(type,'nfcDeviceType');
}

export function nfcStatusText(device:NfcDevice):string{
  return `${nfcStatusLabel(device.status)}${device.archived_at?' · Archiviert':''}`;
}

// Dieselbe fachliche Logik wie in den Backend-Workflows: nur aktive, nicht
// archivierte und nicht ersetzte Geräte dürfen regulär zugeordnet werden.
export function nfcIsAssignable(device:{status:string;archived_at?:string|null;replaced_at?:string|null}):boolean{
  return device.status==='active'&&!device.archived_at&&!device.replaced_at;
}

export function nfcCanReplace(device:{status:string;archived_at?:string|null;replaced_at?:string|null}):boolean{
  return ['lost','blocked'].includes(device.status)&&!device.archived_at&&!device.replaced_at;
}

export function nfcCanRecover(device:{status:string;archived_at?:string|null;replaced_at?:string|null}):boolean{
  return !device.replaced_at&&device.status!=='replaced'&&(device.status==='lost'||Boolean(device.archived_at));
}

export function nfcCanBlock(device:{status:string;archived_at?:string|null;replaced_at?:string|null}):boolean{
  return device.status==='active'&&!device.archived_at&&!device.replaced_at;
}

export function nfcCanReactivate(device:{status:string;archived_at?:string|null;replaced_at?:string|null}):boolean{
  return device.status==='blocked'&&!device.archived_at&&!device.replaced_at;
}

export function nfcMasterDataPayloadFromForm(form:NfcForm):Record<string,unknown>{
  const {employee_id:_employee,site_id:_site,control_point_id:_point,...payload}=nfcPayloadFromForm(form);
  return payload;
}

/**
 * Auswahlfeld mit integrierter Suche. Die gefilterten Optionen stammen
 * ausschließlich aus den vom Mandanten geladenen echten Datensätzen.
 */
export function NfcSearchSelect({label,value,options,onChange,placeholder,required=false}:{
  label:string;value:string;options:{id:string;label:string}[];onChange:(value:string)=>void;
  placeholder?:string;required?:boolean;
}){
  const [query,setQuery]=useState('');
  const needle=query.trim().toLocaleLowerCase('de');
  const matches=options.filter(option=>option.label.toLocaleLowerCase('de').includes(needle));
  const visible=matches.some(option=>option.id===value)?matches:[...matches,...options.filter(option=>option.id===value)];
  return <>
    <label>{label} suchen
      <input aria-label={`${label} suchen`} placeholder={placeholder??`${label} suchen`} value={query}
        onChange={event=>setQuery(event.target.value)}/>
    </label>
    <label>{label}
      <select aria-label={label} value={value} required={required} onChange={event=>onChange(event.target.value)}>
        <option value="">Bitte auswählen</option>
        {visible.map(option=><option key={option.id} value={option.id}>{option.label}</option>)}
      </select>
    </label>
  </>;
}

export function nfcAssignmentLabel(device:{control_point_name?:string|null;site_name?:string|null;employee_name?:string|null}):string{
  if(device.control_point_name)return `${device.control_point_name} · ${device.site_name??commonText.notAvailable}`;
  if(device.site_name)return device.site_name;
  if(device.employee_name)return device.employee_name;
  return commonText.notAssigned;
}

export function nfcAssignmentDetail(assignment:Record<string,string|null>|undefined,options:NfcOptions|null):string{
  if(!assignment)return commonText.notAssigned;
  if(assignment.control_point_id){
    const point=options?.control_points.find(item=>item.id===assignment.control_point_id);
    return point?`${point.name} · ${point.site_name??commonText.notAvailable}`:'Kontrollpunkt';
  }
  if(assignment.site_id)return options?.sites.find(item=>item.id===assignment.site_id)?.name??'Objekt';
  if(assignment.employee_id)return options?.employees.find(item=>item.id===assignment.employee_id)?.name??'Mitarbeiter';
  return commonText.notAssigned;
}

export type NfcReplaceCandidate=NonNullable<NfcOptions['devices']>[number];

function hasReplacementAssignment(device:NfcReplaceCandidate|undefined):boolean{
  return !!device&&!!(device.employee_id||device.site_id||device.control_point_id);
}

/**
 * Der komplette fachliche Zustand eines Austauschs. Bestätigungen sind Teil
 * dieses Zustands und werden gemeinsam mit der Zusammenfassung gesnapshottet.
 */
export type NfcReplaceForm={
  identifier:string;device_type:string;manufacturer:string;model:string;serial_number:string;description:string;
  mode:'new'|'existing';existing_device_id:string;
  reason:string;notes:string;copy_assignment:boolean;
  acknowledge_existing:boolean;acknowledge_restricted:boolean;
};

export type NfcReplaceSummary={
  oldDevice:string;replacement:string;takeover:string;reason:string;notes:string;
  oldConsequence:string;replacementConsequence:string;
};

export const emptyNfcReplaceForm=(device?:NfcDevice):NfcReplaceForm=>({
  identifier:'',device_type:device?.device_type??'tag',manufacturer:device?.manufacturer??'',
  model:'',serial_number:'',description:'',
  mode:'new',existing_device_id:'',reason:'',notes:'',copy_assignment:false,
  acknowledge_existing:false,acknowledge_restricted:false,
});

export function nfcReplaceRestricted(candidate:NfcReplaceCandidate|undefined):boolean{
  return !!candidate&&['lost','blocked'].includes(candidate.status);
}

/**
 * Ein Change geht immer über diese Funktion. Gerätewechsel und Moduswechsel
 * verwerfen die Einzelbestätigungen, weil sie sich auf ein anderes Gerät
 * bezogen haben. Die Übernahmeentscheidung betrifft die Bestätigung der
 * bestehenden Zuordnung. Jede Änderung macht außerdem den bestätigten
 * Snapshot ungültig (siehe nfcReplaceSnapshot).
 */
export function updateNfcReplaceForm(current:NfcReplaceForm,patch:Partial<NfcReplaceForm>):NfcReplaceForm{
  const next={...current,...patch};
  if('mode' in patch||'existing_device_id' in patch||'copy_assignment' in patch){
    next.acknowledge_existing=false;
  }
  if('mode' in patch||'existing_device_id' in patch){
    next.acknowledge_restricted=false;
  }
  return next;
}

/** Zusammenfassung ausschließlich aus dem aktuellen Formular- und Gerätezustand. */
export function nfcReplaceSummary(form:NfcReplaceForm,oldDevice:NfcDevice,
  candidate:NfcReplaceCandidate|undefined):NfcReplaceSummary{
  const oldDeviceLabel=[oldDevice.identifier,nfcStatusText(oldDevice),nfcAssignmentLabel(oldDevice)].join(' · ');
  const replacement=form.mode==='new'
    ?[form.identifier.trim()||'Noch keine Kennung',commonText.notAssigned,'Neu nach Austausch aktiv',
      nfcTypeLabel(form.device_type),form.manufacturer.trim()||'Noch kein Hersteller',
      form.model.trim()?`Modell ${form.model.trim()}`:'',form.serial_number.trim()?`SN ${form.serial_number.trim()}`:''].filter(Boolean).join(' · ')
    :candidate
      ?[candidate.identifier,nfcAssignmentLabel(candidate),nfcStatusLabel(candidate.status),
        nfcTypeLabel(candidate.device_type),candidate.manufacturer].join(' · ')
      :'Noch kein Ersatzgerät ausgewählt';
  const takeover=form.copy_assignment
    ?'Die bisherige Zuordnung wird auf das Ersatzgerät übernommen.'
    :'Die bisherige Zuordnung wird nicht übernommen und nur in der Historie dokumentiert.';
  const takesOver=form.copy_assignment&&!!(oldDevice.employee_id||oldDevice.site_id||oldDevice.control_point_id);
  return {
    oldDevice:oldDeviceLabel,
    replacement,
    takeover,
    reason:form.reason.trim()||'Noch nicht angegeben',
    notes:form.notes.trim()||'Keine',
    oldConsequence:'Das alte Gerät wird als ersetzt markiert, verliert seine Zuordnung und bleibt in Historie, Scans und Dokumenten vollständig erhalten.',
    replacementConsequence:takesOver
      ?'Das Ersatzgerät wird aktiv und übernimmt die Zuordnung des alten Geräts; seine bisherige Zuordnung bleibt in der Historie dokumentiert.'
      :'Das Ersatzgerät wird aktiv, ohne die Zuordnung des alten Geräts zu übernehmen; dessen Zuordnung bleibt nur in der Historie.'
        +(nfcReplaceRestricted(candidate)?' Sein gesperrter oder verlorener Status wird dabei aufgehoben.':''),
  };
}

/** Unveränderlicher, exakt vergleichbarer Snapshot des bestätigten Vorgangs. */
export function nfcReplaceSnapshot(form:NfcReplaceForm,summary:NfcReplaceSummary):string{
  return JSON.stringify({form:{
    identifier:form.identifier.trim(),device_type:form.device_type,manufacturer:form.manufacturer.trim(),
    model:form.model.trim(),serial_number:form.serial_number.trim(),description:form.description.trim(),
    mode:form.mode,existing_device_id:form.existing_device_id,reason:form.reason.trim(),notes:form.notes.trim(),
    copy_assignment:form.copy_assignment,acknowledge_existing:form.acknowledge_existing,
    acknowledge_restricted:form.acknowledge_restricted,
  },summary});
}

export function nfcReplaceIsConfirmed(form:NfcReplaceForm,summary:NfcReplaceSummary,snapshot:string|null):boolean{
  return !!snapshot&&snapshot===nfcReplaceSnapshot(form,summary);
}

export function validateNfcReplace(form:NfcReplaceForm,candidate:NfcReplaceCandidate|undefined):string{
  if(form.reason.trim().length<3)return commonText.reasonRequired;
  if(form.mode==='new'){
    if(!form.identifier.trim()||!form.manufacturer.trim())return 'Bitte Kennung und Hersteller des Ersatzgeräts angeben.';
    if(!['tag','reader'].includes(form.device_type))return 'Bitte einen gültigen Gerätetyp auswählen.';
    if(form.model.length>200)return 'Das Modell ist zu lang (maximal 200 Zeichen).';
    if(form.serial_number.length>200)return 'Die Seriennummer ist zu lang (maximal 200 Zeichen).';
    if(form.description.length>2000)return 'Die Beschreibung ist zu lang (maximal 2000 Zeichen).';
  }else{
    if(!form.existing_device_id)return 'Bitte ein vorhandenes Ersatzgerät auswählen.';
    if(!candidate)return 'Das ausgewählte Ersatzgerät ist nicht mehr verfügbar. Bitte erneut prüfen.';
    if(['replaced','archived'].includes(candidate.status)||candidate.replaced_at||candidate.archived_at){
      return 'Das ausgewählte Ersatzgerät ist nicht mehr verfügbar. Bitte erneut prüfen.';
    }
    if(hasReplacementAssignment(candidate)&&!form.acknowledge_existing)return 'Bitte die bestehende Zuordnung des Ersatzgeräts bestätigen.';
    if(nfcReplaceRestricted(candidate)&&!form.acknowledge_restricted)return 'Bitte Status, Kennung und Zuordnung des Ersatzgeräts freigeben.';
  }
  return '';
}

/**
 * Einziger Payload-Bauer für beide Dialoghost-Seiten. Die Bestätigung wird
 * zusätzlich an die konkrete Ersatzgeräte-ID gebunden, damit das Backend
 * eine für ein anderes Gerät erteilte Bestätigung erkennen und ablehnen kann.
 */
export function nfcReplacePayload(form:NfcReplaceForm,candidate:NfcReplaceCandidate|undefined):Record<string,unknown>{
  const payload:Record<string,unknown>={
    reason:form.reason.trim(),notes:form.notes.trim(),copy_assignment:form.copy_assignment,
  };
  if(form.mode==='existing'){
    payload.new_device_id=form.existing_device_id;
    payload.acknowledged_device_id=form.existing_device_id;
    if(hasReplacementAssignment(candidate)&&form.acknowledge_existing)payload.acknowledge_existing_assignment=true;
    if(nfcReplaceRestricted(candidate)&&form.acknowledge_restricted)payload.acknowledge_restricted=true;
  }else{
    payload.identifier=form.identifier.trim();
    payload.device_type=form.device_type;
    payload.manufacturer=form.manufacturer.trim();
    if(form.model.trim())payload.model=form.model.trim();
    if(form.serial_number.trim())payload.serial_number=form.serial_number.trim();
    if(form.description.trim())payload.description=form.description.trim();
  }
  return payload;
}

export function nfcScanOutcome(scan:NfcScanRecord):string{
  if(scan.outcome==='rejected'){
    const reason=scan.rejection_reason??scan.rejection_code;
    return `Abgelehnt${reason?` · ${reason}`:''}`;
  }
  if(scan.deviation&&scan.deviation!=='none')return `Erfolgreich · Abweichung: ${statusLabel(scan.deviation,'general')}`;
  return 'Erfolgreich';
}

export function nfcScanAuthenticationLabel(value:string|null|undefined):string{
  return statusLabel(value??'','scanAuthentication')??commonText.notAvailable;
}

export function NfcDialog({title,onClose,children,wide=false}:{title:string;onClose:()=>void;children:ReactNode;wide?:boolean}){
  return <Dialog title={title} onClose={onClose} wide={wide}>{children}</Dialog>;
}

export function NfcAssignmentFields({value,onChange,options}:{
  value:NfcForm;onChange:(next:NfcForm)=>void;options:NfcOptions;
}){
  const points=options.control_points;
  const selectedPoint=points.find(point=>point.id===value.control_point_id);
  return <div className="object-form-grid">
    <label>Zuordnung
      <select aria-label="Zuordnung" value={value.assignment_kind} onChange={event=>onChange({...value,assignment_kind:event.target.value as NfcAssignmentKind})}>
        <option value="none">{commonText.notAssigned}</option>
        <option value="site">Objekt</option>
        {value.device_type==='tag'&&<option value="control_point">Kontrollpunkt</option>}
        <option value="employee">Mitarbeiter</option>
      </select>
    </label>
    {value.assignment_kind==='site'&&<NfcSearchSelect label="Objekt" value={value.site_id}
      options={options.sites.map(site=>({id:site.id,label:site.name}))}
      onChange={site_id=>onChange({...value,site_id})}/>}
    {value.assignment_kind==='control_point'&&<>
      <NfcSearchSelect label="Kontrollpunkt" value={value.control_point_id}
        options={value.device_type==='tag'?points.map(point=>({
          id:point.id,label:point.site_name?`${point.site_name} · ${point.name}`:point.name,
        })):[]}
        placeholder="Kontrollpunkt suchen"
        onChange={control_point_id=>onChange({...value,control_point_id})}/>
      {selectedPoint&&<small>Gehört zu Objekt: {selectedPoint.site_name??commonText.notAvailable}</small>}
      {value.device_type!=='tag'&&<small>Kontrollpunkte sind nur für NFC-Tags verfügbar.</small>}
    </>}
    {value.assignment_kind==='employee'&&<NfcSearchSelect label="Mitarbeiter" value={value.employee_id}
      options={options.employees.map(employee=>({id:employee.id,label:employee.name}))}
      onChange={employee_id=>onChange({...value,employee_id})}/>}
  </div>;
}

export function NfcFormFields({value,onChange,options,showAssignment=true}:{
  value:NfcForm;onChange:(next:NfcForm)=>void;options:NfcOptions;showAssignment?:boolean;
}){
  return <>
    <div className="object-form-grid">
      <label title="Eindeutige NFC-Kennung des Geräts">NFC-Kennung *
        <input required maxLength={200} value={value.identifier} placeholder="z. B. NFC-0042"
          onChange={event=>onChange({...value,identifier:event.target.value})}/>
      </label>
      <label title="NFC-Tag für Kontrollpunkte oder Lesegerät als Hardware">Gerätetyp *
        <select value={value.device_type} onChange={event=>onChange({...value,device_type:event.target.value,
          ...(event.target.value==='reader'&&value.assignment_kind==='control_point'?{assignment_kind:'none' as NfcAssignmentKind}:{})})}>
          <option value="tag">NFC-Tag</option>
          <option value="reader">Lesegerät</option>
        </select>
      </label>
      <label title="Hersteller des NFC-Geräts">Hersteller *
        <input required maxLength={200} value={value.manufacturer} placeholder="Herstellername"
          onChange={event=>onChange({...value,manufacturer:event.target.value})}/>
      </label>
      <label title="Modellbezeichnung des Geräts">Modell
        <input maxLength={200} value={value.model} placeholder="z. B. MIFARE Classic 1K"
          onChange={event=>onChange({...value,model:event.target.value})}/>
      </label>
      <label title="Seriennummer des Geräts">Seriennummer
        <input maxLength={200} value={value.serial_number} placeholder="Seriennummer"
          onChange={event=>onChange({...value,serial_number:event.target.value})}/>
      </label>
      <label title="Fachliche Beschreibung des Geräts">Beschreibung
        <input maxLength={2000} value={value.description} placeholder="Kurzbeschreibung"
          onChange={event=>onChange({...value,description:event.target.value})}/>
      </label>
    </div>
    {showAssignment&&<NfcAssignmentFields value={value} onChange={onChange} options={options}/>}
    <label title="Interne Hinweise zum Gerät">Interne Notizen
      <textarea rows={3} maxLength={2000} value={value.notes}
        onChange={event=>onChange({...value,notes:event.target.value})}/>
    </label>
  </>;
}

export function NfcReasonDialog({title,description,reason,onReason,date,onDate,dateLabel,error,busy,confirmLabel='Bestätigen',onConfirm,onClose}:{
  title:string;description:string;reason:string;onReason:(value:string)=>void;
  date?:string;onDate?:(value:string)=>void;dateLabel?:string;error:string;busy:boolean;
  confirmLabel?:string;onConfirm:()=>void;onClose:()=>void;
}){
  const submit=(event:FormEvent)=>{event.preventDefault();onConfirm();};
  return <NfcDialog title={title} onClose={onClose}>
    <form className="object-inline-form" onSubmit={submit}>
      <p>{description}</p>
      {date!==undefined&&<label>{dateLabel??'Verlustdatum *'}
        <input type="date" required value={date} onChange={event=>onDate?.(event.target.value)}/>
      </label>}
      <label>Begründung *
        <input required minLength={3} maxLength={2000} value={reason} onChange={event=>onReason(event.target.value)}
          placeholder="Grund der Änderung"/>
      </label>
      {error&&<p className="object-warning" role="alert">{error}</p>}
      <div className="object-actions">
        <button type="submit" disabled={busy}>{busy?'Wird gespeichert …':confirmLabel}</button>
        <button type="button" onClick={onClose}>{commonText.cancel}</button>
      </div>
    </form>
  </NfcDialog>;
}

export function NfcRecoverDialog({identifier,assignment,identifierConfirmation,onIdentifierConfirmation,
  reason,onReason,foundAt,onFoundAt,error,busy,onConfirm,onClose}:{
  identifier:string;assignment:string;identifierConfirmation:string;onIdentifierConfirmation:(value:string)=>void;
  reason:string;onReason:(value:string)=>void;foundAt:string;onFoundAt:(value:string)=>void;
  error:string;busy:boolean;onConfirm:(confirmed:boolean)=>void;onClose:()=>void;
}){
  const [confirmed,setConfirmed]=useState(false);
  const submit=(event:FormEvent)=>{event.preventDefault();onConfirm(confirmed);};
  return <NfcDialog title="NFC-Gerät wieder in Betrieb nehmen" onClose={onClose}>
    <form className="object-inline-form" onSubmit={submit}>
      <p>{identifier} wird nach dem Wiederauffinden zunächst gesperrt. Die Freigabe erfolgt anschließend in einem separaten, begründeten Schritt.</p>
      <label>Wiederauffindungsdatum *
        <input type="date" required value={foundAt} onChange={event=>onFoundAt(event.target.value)}/>
      </label>
      <p>Aktuelle Zuordnung: {assignment}</p>
      <label>Bestätigte NFC-Kennung *
        <input required maxLength={200} value={identifierConfirmation} placeholder={identifier}
          onChange={event=>onIdentifierConfirmation(event.target.value)}/>
      </label>
      <label className="object-check"><input type="checkbox" required checked={confirmed}
        onChange={event=>setConfirmed(event.target.checked)}/> Identität und Zuordnung wurden geprüft.</label>
      <label>Begründung *
        <input required minLength={3} maxLength={2000} value={reason} placeholder="Grund der Änderung"
          onChange={event=>onReason(event.target.value)}/>
      </label>
      {error&&<p className="object-warning" role="alert">{error}</p>}
      <div className="object-actions">
        <button type="submit" disabled={busy}>{busy?'Wird gespeichert …':'Wieder in Betrieb nehmen'}</button>
        <button type="button" onClick={onClose}>{commonText.cancel}</button>
      </div>
    </form>
  </NfcDialog>;
}

export function NfcReplaceDialog({identifier,onIdentifier,deviceType,onDeviceType,manufacturer,onManufacturer,
  model,onModel,serialNumber,onSerialNumber,description,onDescription,
  mode,onMode,existingDeviceId,onExistingDeviceId,devices,summary,
  reason,onReason,notes,onNotes,copyAssignment,onCopyAssignment,
  acknowledgeExisting,onAcknowledgeExisting,acknowledgeRestricted,onAcknowledgeRestricted,
  confirmed,onConfirmed,error,busy,onConfirm,onClose}:{
  identifier:string;onIdentifier:(value:string)=>void;deviceType:string;onDeviceType:(value:string)=>void;
  manufacturer:string;onManufacturer:(value:string)=>void;
  model:string;onModel:(value:string)=>void;serialNumber:string;onSerialNumber:(value:string)=>void;
  description:string;onDescription:(value:string)=>void;
  mode:'new'|'existing';onMode:(value:'new'|'existing')=>void;
  existingDeviceId:string;onExistingDeviceId:(value:string)=>void;
  devices:NonNullable<NfcOptions['devices']>;
  summary:NfcReplaceSummary;
  reason:string;onReason:(value:string)=>void;notes:string;onNotes:(value:string)=>void;
  copyAssignment:boolean;onCopyAssignment:(value:boolean)=>void;
  acknowledgeExisting:boolean;onAcknowledgeExisting:(value:boolean)=>void;
  acknowledgeRestricted:boolean;onAcknowledgeRestricted:(value:boolean)=>void;
  confirmed:boolean;onConfirmed:(value:boolean)=>void;
  error:string;busy:boolean;onConfirm:()=>void;onClose:()=>void;
}){
  const submit=(event:FormEvent)=>{event.preventDefault();onConfirm();};
  const candidate=devices?.find(device=>device.id===existingDeviceId);
  const restricted=nfcReplaceRestricted(candidate);
  return <NfcDialog title="Ersatzgerät festlegen" onClose={onClose} wide>
    <form className="object-inline-form" onSubmit={submit}>
      <p>Das bisherige Gerät wird als ersetzt markiert. Seine Historie bleibt vollständig erhalten.</p>
      <label>Ersatzgerät
        <select aria-label="Ersatzgerät-Art" value={mode} onChange={event=>onMode(event.target.value as 'new'|'existing')}>
          <option value="new">Neues Gerät registrieren</option>
          <option value="existing">Vorhandenes Gerät verwenden</option>
        </select>
      </label>
      {mode==='new'?<>
        <label>NFC-Kennung des Ersatzgeräts *
          <input required maxLength={200} value={identifier} onChange={event=>onIdentifier(event.target.value)}/>
        </label>
        <label>Gerätetyp *
          <select value={deviceType} onChange={event=>onDeviceType(event.target.value)}>
            <option value="tag">NFC-Tag</option>
            <option value="reader">Lesegerät</option>
          </select>
        </label>
        <label>Hersteller *
          <input required maxLength={200} value={manufacturer} onChange={event=>onManufacturer(event.target.value)}/>
        </label>
        <label>Modell
          <input maxLength={200} value={model} placeholder="z. B. MIFARE Classic 1K" onChange={event=>onModel(event.target.value)}/>
        </label>
        <label>Seriennummer
          <input maxLength={200} value={serialNumber} placeholder="Seriennummer" onChange={event=>onSerialNumber(event.target.value)}/>
        </label>
        <label>Beschreibung
          <input maxLength={2000} value={description} placeholder="Kurzbeschreibung" onChange={event=>onDescription(event.target.value)}/>
        </label>
      </>:<NfcSearchSelect label="Ersatzgerät" value={existingDeviceId} required
        options={devices.map(device=>({id:device.id,label:`${device.identifier} · ${device.manufacturer} · ${nfcTypeLabel(device.device_type)}`}))}
        onChange={onExistingDeviceId}/>}
      <label>Austauschgrund *
        <input required minLength={3} maxLength={2000} value={reason} onChange={event=>onReason(event.target.value)}/>
      </label>
      <label>Notizen <input maxLength={2000} value={notes} onChange={event=>onNotes(event.target.value)}/></label>
      <label className="object-check"><input type="checkbox" checked={copyAssignment} onChange={event=>onCopyAssignment(event.target.checked)}/> Zuordnung übernehmen</label>
      {mode==='existing'&&hasReplacementAssignment(candidate)&&<label className="object-check">
        <input type="checkbox" required checked={acknowledgeExisting}
          onChange={event=>onAcknowledgeExisting(event.target.checked)}/>
        Bestehende Zuordnung des Ersatzgeräts geprüft; über die Übernahme wurde entschieden.
      </label>}
      {restricted&&<label className="object-check">
        <input type="checkbox" required checked={acknowledgeRestricted}
          onChange={event=>onAcknowledgeRestricted(event.target.checked)}/>
        Gesperrten oder verlorenen Status, Kennung und Zuordnung des Ersatzgeräts ausdrücklich freigegeben.
      </label>}
      <div className="object-detail-content">
        <h4>Zusammenfassung vor dem Austausch</h4>
        <p><strong>Altes Gerät (Kennung · Status · bisherige Zuordnung):</strong> {summary.oldDevice}</p>
        <p><strong>Ersatzgerät (Kennung · Zuordnung · Status · Typ · Hersteller):</strong> {summary.replacement}</p>
        <p><strong>Übernahmeentscheidung:</strong> {summary.takeover}</p>
        <p><strong>Austauschgrund:</strong> {summary.reason}</p>
        <p><strong>Notizen:</strong> {summary.notes}</p>
        <p><strong>Folgen für das alte Gerät:</strong> {summary.oldConsequence}</p>
        <p><strong>Folgen für das Ersatzgerät:</strong> {summary.replacementConsequence}</p>
      </div>
      <label className="object-check"><input type="checkbox" required checked={confirmed}
        onChange={event=>onConfirmed(event.target.checked)}/>
        Ich habe die Zusammenfassung geprüft und bestätige den Austausch ausdrücklich.
      </label>
      {error&&<p className="object-warning" role="alert">{error}</p>}
      <div className="object-actions">
        <button type="submit" disabled={busy}>{busy?'Wird gespeichert …':'Austausch durchführen'}</button>
        <button type="button" onClick={onClose}>{commonText.cancel}</button>
      </div>
    </form>
  </NfcDialog>;
}

export function NfcKpiCard({label,value,hint,onClick,active=false}:{
  label:string;value:number;hint?:string;onClick?:()=>void;active?:boolean;
}){
  const content=<><strong>{formatNumber(value)}</strong><span>{label}</span>{hint&&<small>{hint}</small>}</>;
  return onClick?(
    <article className={`object-summary-card${active?' active':''}`} role="button" tabIndex={0} aria-pressed={active}
      onClick={onClick} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();onClick();}}}>{content}</article>
  ):<article>{content}</article>;
}

export function NfcTimeline({device,options}:{device:NfcDevice;options:NfcOptions|null}){
  const entries=[
    {label:'Registrierung',value:formatDateTime(device.registered_at)},
    {label:'Letzte Aktualisierung',value:formatDateTime(device.updated_at)},
    ...(device.lost_at?[{label:'Verlust gemeldet',value:formatDateTime(device.lost_at)}]:[]),
    ...(device.blocked_at?[{label:'Gesperrt',value:formatDateTime(device.blocked_at)}]:[]),
    ...(device.replaced_at?[{label:'Ersetzt',value:formatDateTime(device.replaced_at)}]:[]),
    ...(device.recovered_at?[{label:'Wiedergefunden',value:formatDateTime(device.recovered_at)}]:[]),
    ...(device.archived_at?[{label:'Archiviert',value:formatDateTime(device.archived_at)}]:[]),
    {label:'Aktuelle Zuordnung',value:nfcAssignmentLabel(device)},
    ...(device.reported_by?[{label:'Letzte Änderung durch',value:device.reported_by_email??device.reported_by}]:[]),
    ...(device.event_reason?[{label:'Letzter Grund',value:device.event_reason}]:[]),
  ];
  void options;
  return <div className="object-activity">{entries.map(entry=><div key={entry.label}>
    <strong>{entry.label}</strong><span>{entry.value}</span>
  </div>)}</div>;
}
