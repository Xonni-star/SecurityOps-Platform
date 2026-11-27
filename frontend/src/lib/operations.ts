import {ApiError} from './api';

export type Loose=Record<string,unknown>;

export function isLoose(value:unknown):value is Loose{
  return value!==null&&typeof value==='object'&&!Array.isArray(value);
}

/** Liest Listen aus unterschiedlichen Backend-Envelope-Formen robust aus. */
export function asArray(value:unknown,keys:string[]=[]):Loose[]{
  if(Array.isArray(value))return value.filter(isLoose);
  if(!isLoose(value))return [];
  for(const key of keys){
    if(Array.isArray(value[key]))return (value[key] as unknown[]).filter(isLoose);
  }
  return [];
}

export function isObject(value:unknown):value is Loose{
  return value!==null&&typeof value==='object'&&!Array.isArray(value);
}

export function field(row:Loose|null|undefined,keys:string[]):unknown{
  if(!row)return undefined;
  for(const key of keys){
    if(row[key]!==undefined&&row[key]!==null)return row[key];
  }
  return undefined;
}

export function text(value:unknown,fallback='–'):string{
  if(value===null||value===undefined||value==='')return fallback;
  if(typeof value==='string')return value;
  if(typeof value==='number'||typeof value==='boolean')return String(value);
  return fallback;
}

export function display(row:Loose|null|undefined,keys:string[],fallback='–'):string{
  return text(field(row,keys),fallback);
}

export function numberOrNull(value:unknown):number|null{
  if(typeof value==='number'&&Number.isFinite(value))return value;
  if(typeof value==='string'&&value.trim()!==''&&Number.isFinite(Number(value)))return Number(value);
  return null;
}

export function errorText(cause:unknown):string{
  if(cause instanceof Error&&cause.message)return cause.message;
  if(typeof cause==='string'&&cause)return cause;
  return 'Die Anfrage konnte nicht abgeschlossen werden. Bitte versuchen Sie es erneut.';
}

export function isForbidden(cause:unknown):boolean{
  return cause instanceof ApiError&&cause.status===403;
}

export function isSourceOpen(cause:unknown):boolean{
  return cause instanceof ApiError&&(cause.reasonCode==='source_open'||cause.status===409&&/ursache/i.test(cause.message));
}

export function isClosureBlocked(cause:unknown):boolean{
  return cause instanceof ApiError&&(cause.reasonCode==='closure_conditions'||cause.status===409&&/abschlussbedingungen/i.test(cause.message));
}

export function isUuid(value:unknown):boolean{
  return uuidPattern.test(String(value??''));
}

export function query(params:Record<string,string|number|boolean|null|undefined>):string{
  const search=new URLSearchParams();
  for(const [key,value] of Object.entries(params)){
    if(value===null||value===undefined||value==='')continue;
    search.set(key,String(value));
  }
  return search.toString();
}

export type PageResult<T>={
  rows:T[];
  total:number;
  pages:number;
};

/** GET mit Pagination-Headers; die Antwort darf Array oder Envelope sein. */
export async function pagedGet<T extends Loose>(path:string,envelopeKeys:string[]=[]):Promise<PageResult<T>>{
  const response=await fetch(`/api/v1${path}`,{credentials:'include'});
  if(!response.ok){
    let message='Die Liste konnte nicht geladen werden.';
    try{
      const payload=await response.json() as Loose;
      if(typeof payload.error==='string'&&payload.error)message=payload.error;
    }catch{/* Fallback-Nachricht verwenden */}
    throw new ApiError(message,response.status);
  }
  const payload=await response.json() as unknown;
  const rows=asArray(payload,envelopeKeys) as T[];
  const total=Number(response.headers.get('X-Total-Count')??(Array.isArray(payload)?payload.length:0))||0;
  const pages=Number(response.headers.get('X-Page-Count')??Math.max(1,Math.ceil(total/Math.max(1,rows.length))))||1;
  return {rows,total,pages:Math.max(1,pages)};
}

export type ControlAlert={
  priority:string;code:string;title:string;description:string;recommendation:string;
  site_id:string|null;site_name:string|null;employee_id:string|null;employee_name:string|null;
  shift_id:string|null;period:string|null;detected_at:string|null;link:string;source_key:string;
};

export type ControlKpi={key:string;label:string;value:number|string;link:string;definition:string};

export type ControlShift=Loose&{
  id:string;site_id:string;site_name:string;customer_name:string|null;role_code:string;
  starts_at:string;ends_at:string;target:number;actual:number;status:string;
  qualification_status:string;reason_codes:string[];notes:string[];assignments:Loose[];conflicts:Loose[];
};

export type ControlCenter={
  generated_at:string;date:string;sections:Record<string,boolean>;
  operational_status:'kritisch'|'erhöht'|'stabil'|string;
  kpis:ControlKpi[];alerts:ControlAlert[];shifts:ControlShift[];
  shifts_total:number;page:number;page_size:number;
  employees:Loose[];sites:Loose[];qualifications:Loose[];documents:Loose[];
  document_requirements:Loose[];devices:Loose[];keys:Loose[];alarms:Loose[];hazards:Loose[];
  measures:Measure[];
  summary:Loose;
  filter_options:{sites:Loose[];customers:Loose[];employees:Loose[]};
};

export type Measure=Loose&{
  id:string;title:string;description?:string|null;module:string;priority:string;status:string;
  due_at?:string|null;site_id?:string|null;site_name?:string|null;incident_id?:string|null;
  assigned_employee_id?:string|null;assigned_employee_name?:string|null;
  source_type?:string|null;source_id?:string|null;source_key?:string|null;open_siblings?:number|null;
};

export type AlertMeasureSource={
  source_type?:'shift'|'site'|'qualification'|'document'|'nfc_device'|'key'|'alarm'|'conflict';
  source_id?:string;
  source_key:string;
  module:'leitstelle'|'einsatz'|'schicht'|'objekt'|'mitarbeiter'|'qualifikation'|'dokument'|'nfc'|'schluessel'|'kunde'|'system';
  priority:'critical'|'high'|'medium'|'low';
};

const uuidPattern=/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Bildet einen Leitstellen-Hinweis auf die erlaubten Maßnahmen-Quelltypen ab.
 *  Quellen, die das Backend nicht als Maßnahmenquelle kennt, bleiben ohne source_type,
 *  behalten aber einen stabilen source_key für die Idempotenz. */
export function alertMeasureSource(alert:ControlAlert):AlertMeasureSource{
  const key=alert.source_key||'';
  const idFromKey=uuidPattern.exec(key)?.[0];
  const shiftId=alert.shift_id??/\bshift=([0-9a-f-]{36})/i.exec(alert.link??'')?.[1];
  const source:AlertMeasureSource={
    source_key:key,
    module:'leitstelle',
    priority:['critical','high','medium','low'].includes(alert.priority)?alert.priority as AlertMeasureSource['priority']:'medium',
  };
  if(key.startsWith('shift:')){
    source.source_type='shift';source.source_id=shiftId;source.module='schicht';
  }else if(key.startsWith('site:')||key.startsWith('requirement:')||key.startsWith('hazard:')){
    source.source_type='site';source.source_id=alert.site_id??idFromKey;source.module='objekt';
  }else if(key.startsWith('qualification:')){
    source.source_type='qualification';source.source_id=idFromKey;source.module='qualifikation';
  }else if(key.startsWith('document:')){
    source.source_type='document';source.source_id=idFromKey;source.module='dokument';
  }else if(key.startsWith('nfc:')){
    source.source_type='nfc_device';source.source_id=idFromKey;source.module='nfc';
  }else if(key.startsWith('key:')){
    source.source_type='key';source.source_id=idFromKey;source.module='schluessel';
  }else if(key.startsWith('alarm:')){
    source.source_type='alarm';source.source_id=idFromKey;source.module='einsatz';
  }else if(key.startsWith('conflict:')){
    source.source_type='conflict';source.source_id=idFromKey;source.module='schicht';
  }else if(key.startsWith('absence:')){
    source.module='mitarbeiter';
  }else if(key.startsWith('measure:')){
    source.module='system';
  }
  return source;
}

export type Incident=Loose&{
  id:string;
};

export function rowId(row:Loose,index=0):string{
  return text(field(row,['id','incident_id','alarm_id','measure_id','key','code']),`zeile-${index}`);
}

export function matchesSearch(row:object,search:string):boolean{
  if(!search.trim())return true;
  const needle=search.trim().toLocaleLowerCase('de-DE');
  return Object.values(row as Loose).some(value=>text(value,'').toLocaleLowerCase('de-DE').includes(needle));
}
