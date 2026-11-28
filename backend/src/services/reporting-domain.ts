import type {AuthUser} from '../types/models.js';
import {effectivePermissionScope,normalizePermissionGrants} from '../types/authorization.js';

/**
 * Zentrale Domäne des Reporting-Zentrums.
 *
 * Alle Module lesen live aus den vorhandenen Fachtabellen des einzigen
 * PostgreSQL-Pools. Es gibt bewusst keinen Reporting-Store, keine Views und
 * keine zweite Datenbank: Mandantentrennung, RLS und Audit bleiben damit in
 * einer Transaktionsdomäne. Die Module A–M sind aus den realen Betriebsdomänen
 * des Systems abgeleitet und hier einmal zentral definiert.
 */
export interface ReportingModule {
  key:string;
  slug:string;
  title:string;
  description:string;
  source:string;
  filters:string[];
}

export const REPORTING_MODULES:ReportingModule[]=[
  {key:'A',slug:'schedule',title:'Schicht- und Dienstplanung',description:'Dienste, Schichten und Besetzungen',source:'schedule_shifts',filters:['from','to','site','employee','search']},
  {key:'B',slug:'qualifications',title:'Qualifikationen',description:'Nachweise, Gültigkeit und Abläufe',source:'employee_qualifications',filters:['from','to','employee','search']},
  {key:'C',slug:'documents',title:'Dokumentenmanagement',description:'Dokumente und Freigabestatus',source:'dms_documents',filters:['from','to','site','customer','employee','search']},
  {key:'D',slug:'retention',title:'Aufbewahrung und Fristen',description:'Dokumentfristen und Überfälligkeiten',source:'dms_documents',filters:['from','to','site','customer','employee','search']},
  {key:'E',slug:'keys',title:'Schlüssel und Ausgabe',description:'Bestand, Ausgabe und Rückgabe',source:'keys',filters:['from','to','site','search']},
  {key:'F',slug:'handover',title:'Übergaben',description:'Schichtübergaben und Bestätigungen',source:'handover_records',filters:['from','to','site','search']},
  {key:'G',slug:'maintenance',title:'Instandhaltung',description:'Aufträge, Fristen und Ergebnisse',source:'maintenance_orders',filters:['from','to','site','customer','employee','search']},
  {key:'H',slug:'incidents',title:'Einsätze und Vorfälle',description:'Vorfallverlauf und Einsatzstatus',source:'incidents',filters:['from','to','site','customer','employee','search']},
  {key:'I',slug:'alarms',title:'Alarm- und Leitstellenlage',description:'Alarme, Prioritäten und Bearbeitung',source:'alarms',filters:['from','to','site','customer','search']},
  {key:'J',slug:'customers',title:'Kunden und Objekte',description:'Aktive Kunden-Objekt-Beziehungen',source:'customer_sites',filters:['from','to','site','customer','search']},
  {key:'K',slug:'worktime',title:'Arbeitszeit',description:'Erfasste Arbeitszeiten und Importe',source:'work_time_entries',filters:['from','to','employee','search']},
  {key:'L',slug:'measures',title:'Operationelle Maßnahmen',description:'Maßnahmen aus allen Fachbereichen',source:'operations_measures',filters:['from','to','site','customer','employee','search']},
  {key:'M',slug:'audit',title:'Audit und Exporte',description:'Nachvollziehbare Änderungs- und Exportereignisse',source:'audit_events',filters:['from','to','search']},
];

export type ReportingModuleSlug=typeof REPORTING_MODULES[number]['slug'];
export type ReportingFormat='csv'|'pdf'|'xlsx';
export type ReportingSort='occurred_at'|'label'|'status';

export interface ReportingFilters {
  from:string;
  to:string;
  siteId:string|null;
  customerId:string|null;
  employeeId:string|null;
  search:string|null;
  page:number;
  pageSize:number;
  sort:ReportingSort;
  order:'asc'|'desc';
}

const DATE_PATTERN=/^\d{4}-\d{2}-\d{2}$/;
const UUID_PATTERN=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PAGE_SIZE=500;

export function isReportingModuleSlug(value:unknown):value is ReportingModuleSlug{
  return typeof value==='string'&&REPORTING_MODULES.some(module=>module.slug===value);
}

export function reportingModule(slug:string):ReportingModule{
  const module=REPORTING_MODULES.find(entry=>entry.slug===slug);
  if(!module)throw Object.assign(new Error('Unbekanntes Reporting-Modul'),{status:400});
  return module;
}

function berlinToday(){
  return new Intl.DateTimeFormat('en-CA',{
    timeZone:'Europe/Berlin',year:'numeric',month:'2-digit',day:'2-digit',
  }).format(new Date());
}

function shiftDate(value:string,days:number){
  const date=new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate()+days);
  return date.toISOString().slice(0,10);
}

function validDate(value:unknown):value is string{
  if(typeof value!=='string'||!DATE_PATTERN.test(value))return false;
  const date=new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf())&&date.toISOString().slice(0,10)===value;
}

function berlinOffsetMs(value:Date){
  const parts=new Intl.DateTimeFormat('en-US',{
    timeZone:'Europe/Berlin',year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',
  }).formatToParts(value);
  const part=(type:string)=>Number(parts.find(entry=>entry.type===type)?.value);
  const localAsUtc=Date.UTC(part('year'),part('month')-1,part('day'),part('hour'),part('minute'),part('second'));
  return localAsUtc-value.valueOf();
}

function berlinMidnight(value:string){
  const naive=new Date(`${value}T00:00:00.000Z`).valueOf();
  let offset=berlinOffsetMs(new Date(naive));
  let result=naive-offset;
  offset=berlinOffsetMs(new Date(result));
  result=naive-offset;
  return new Date(result);
}

/** Berliner Kalendertagsgrenzen als echte UTC-Zeitstempel (inkl. Sommerzeit). */
export function reportingDayRange(query:Record<string,unknown>={}){
  const today=berlinToday();
  const from=query.from===undefined?shiftDate(today,-30):query.from;
  const to=query.to===undefined?today:query.to;
  if(!validDate(from)||!validDate(to)||from>to)throw Object.assign(new Error('Ungültiger Zeitraum'),{status:400});
  return {from:berlinMidnight(from),to:new Date(berlinMidnight(shiftDate(to,1)).valueOf()-1),from_day:from,to_day:to};
}

function optionalUuid(value:unknown,name:string):string|null{
  if(value===undefined||value===null||value==='')return null;
  if(typeof value!=='string'||!UUID_PATTERN.test(value))throw Object.assign(new Error(`Ungültiger Filter ${name}`),{status:400});
  return value;
}

function integer(value:unknown,fallback:number,min:number,max:number,name:string){
  if(value===undefined||value==='')return fallback;
  const parsed=typeof value==='number'?value:Number(value);
  if(!Number.isInteger(parsed)||parsed<min||parsed>max)throw Object.assign(new Error(`Ungültiger Filter ${name}`),{status:400});
  return parsed;
}

/** Externe Filterverträge verwenden durchgehend snake_case. */
export function reportingFilterResponse(filters:ReportingFilters){
  const {siteId,customerId,employeeId,search,pageSize,...rest}=filters;
  return {...rest,site_id:siteId,customer_id:customerId,employee_id:employeeId,q:search,page_size:pageSize};
}

export function parseReportingFilters(query:Record<string,unknown>):ReportingFilters{
  const today=berlinToday();
  const from=query.from===undefined?shiftDate(today,-30):query.from;
  const to=query.to===undefined?today:query.to;
  if(!validDate(from)||!validDate(to)||from>to)throw Object.assign(new Error('Ungültiger Zeitraum'),{status:400});
  const sort=query.sort===undefined?'occurred_at':String(query.sort);
  if(!['occurred_at','label','status'].includes(sort))throw Object.assign(new Error('Ungültige Sortierung'),{status:400});
  const order=query.order===undefined?'desc':String(query.order);
  if(order!=='asc'&&order!=='desc')throw Object.assign(new Error('Ungültige Sortierrichtung'),{status:400});
  const search=typeof query.q==='string'&&query.q.trim()?query.q.trim().slice(0,160):null;
  return {
    from,to,
    siteId:optionalUuid(query.site_id,'site_id'),
    customerId:optionalUuid(query.customer_id,'customer_id'),
    employeeId:optionalUuid(query.employee_id,'employee_id'),
    search,
    page:integer(query.page,1,1,100000,'page'),
    pageSize:integer(query.page_size,25,1,MAX_PAGE_SIZE,'page_size'),
    sort:sort as ReportingSort,
    order:order as 'asc'|'desc',
  };
}

/** Site-Scope aus der bestehenden RBAC-Domäne – keine zweite Rechteprüfung. */
export function reportingSiteScope(user:AuthUser):string[]|null{
  const grants=normalizePermissionGrants(user.permissionGrants,user.permissions);
  const scope=effectivePermissionScope(grants,'reports:read',{
    role:user.role,isSystemAdmin:user.isSystemAdmin===true,
  });
  return scope==='site'?(user.siteIds??[]):null;
}

const berlinDay="(now() AT TIME ZONE 'Europe/Berlin')::date";

/** Normalisierte, aber ungefilterte Fachdaten je Modul. */
const MODULE_SQL:Record<ReportingModuleSlug,string>={
  schedule:`SELECT sh.id::text AS id,
    concat_ws(' · ',p.name,sh.role_code,e.name) AS label,
    p.status AS status,sh.site_id,NULL::uuid AS customer_id,sa.employee_id,
    sh.starts_at AS occurred_at,
    jsonb_build_object('Plan',p.name,'Ende',to_char(sh.ends_at AT TIME ZONE 'Europe/Berlin','YYYY-MM-DD HH24:MI')) AS details,
    round(EXTRACT(EPOCH FROM (sh.ends_at-sh.starts_at))/3600::numeric,2) AS metric,'Stunden' AS metric_label
    FROM schedule_shifts sh
    JOIN schedule_periods p ON p.tenant_id=sh.tenant_id AND p.id=sh.period_id
    LEFT JOIN schedule_assignments sa ON sa.tenant_id=sh.tenant_id AND sa.shift_id=sh.id AND sa.status='assigned'
    LEFT JOIN employees e ON e.tenant_id=sa.tenant_id AND e.id=sa.employee_id
    WHERE sh.tenant_id=$1`,
  qualifications:`SELECT q.id::text AS id,
    concat_ws(' · ',e.name,COALESCE(c.name,q.code)) AS label,
    CASE WHEN q.revoked_at IS NOT NULL OR q.status IN ('revoked','invalid') THEN 'ungueltig'
      WHEN q.valid_until IS NOT NULL AND q.valid_until<${berlinDay} THEN 'abgelaufen'
      WHEN q.status='valid' THEN 'gueltig' ELSE q.status END AS status,
    NULL::uuid AS site_id,NULL::uuid AS customer_id,q.employee_id,
    (COALESCE(q.issued_on,q.valid_from,${berlinDay})::timestamp AT TIME ZONE 'Europe/Berlin') AS occurred_at,
    jsonb_build_object('Code',q.code,'Gueltig bis',to_char(q.valid_until,'YYYY-MM-DD')) AS details,
    CASE WHEN q.valid_until IS NULL THEN NULL ELSE (q.valid_until-${berlinDay}) END AS metric,
    'Tage bis Ablauf' AS metric_label
    FROM employee_qualifications q
    JOIN employees e ON e.tenant_id=q.tenant_id AND e.id=q.employee_id
    LEFT JOIN qualification_catalog c ON c.tenant_id=q.tenant_id
      AND (c.id=q.catalog_id OR (q.catalog_id IS NULL AND c.code=q.code))
    WHERE q.tenant_id=$1`,
  documents:`SELECT d.id::text AS id,d.title AS label,d.approval_status AS status,
    d.site_id,NULL::uuid AS customer_id,d.responsible_employee_id AS employee_id,
    d.created_at AS occurred_at,
    jsonb_build_object('Dokumentart',d.document_type,'Version',v.version_no,'Groesse (KiB)',round(v.size_bytes/1024.0,2)) AS details,
    round(v.size_bytes/1024.0,2) AS metric,'KiB' AS metric_label
    FROM dms_documents d
    LEFT JOIN LATERAL (
      SELECT v.version_no,v.size_bytes FROM dms_versions v
      WHERE v.tenant_id=d.tenant_id AND v.document_id=d.id
        AND v.lifecycle_state='available' AND v.deleted_at IS NULL
      ORDER BY v.version_no DESC LIMIT 1
    ) v ON TRUE
    WHERE d.tenant_id=$1 AND d.document_status='active'`,
  retention:`SELECT d.id::text AS id,d.title AS label,
    CASE WHEN d.valid_until<${berlinDay} THEN 'ueberfaellig'
      WHEN d.valid_until<=${berlinDay}+30 THEN 'bald faellig' ELSE 'aktiv' END AS status,
    d.site_id,NULL::uuid AS customer_id,d.responsible_employee_id AS employee_id,
    (d.valid_until::timestamp AT TIME ZONE 'Europe/Berlin') AS occurred_at,
    jsonb_build_object('Gueltig ab',to_char(d.valid_from,'YYYY-MM-DD'),'Gueltig bis',to_char(d.valid_until,'YYYY-MM-DD')) AS details,
    (d.valid_until-${berlinDay}) AS metric,'Tage' AS metric_label
    FROM dms_documents d
    WHERE d.tenant_id=$1 AND d.document_status='active' AND d.valid_until IS NOT NULL`,
  keys:`SELECT k.id::text AS id,concat_ws(' · ',k.key_code,k.label) AS label,k.status,
    k.site_id,NULL::uuid AS customer_id,k.holder_employee_id AS employee_id,
    COALESCE(k.issued_at,k.created_at) AS occurred_at,
    jsonb_build_object('Typ',k.key_type,'Ausgabe',to_char(k.issued_at AT TIME ZONE 'Europe/Berlin','YYYY-MM-DD HH24:MI')) AS details,
    NULL::numeric AS metric,NULL::text AS metric_label
    FROM keys k WHERE k.tenant_id=$1`,
  handover:`SELECT h.id::text AS id,h.title AS label,h.status,h.site_id,
    NULL::uuid AS customer_id,NULL::uuid AS employee_id,h.created_at AS occurred_at,
    jsonb_build_object('Schicht',h.shift_id::text) AS details,
    NULL::numeric AS metric,NULL::text AS metric_label
    FROM handover_records h WHERE h.tenant_id=$1`,
  maintenance:`SELECT mo.id::text AS id,concat_ws(' · ',mo.order_number,mo.description) AS label,
    mo.status,mo.site_id,NULL::uuid AS customer_id,mo.responsible_employee_id AS employee_id,
    COALESCE(mo.completed_at,mo.due_on::timestamp AT TIME ZONE 'Europe/Berlin',mo.created_at) AS occurred_at,
    jsonb_build_object('Prioritaet',mo.priority_code,'Faellig',to_char(mo.due_on,'YYYY-MM-DD')) AS details,
    CASE WHEN mo.due_on IS NULL THEN NULL ELSE (mo.due_on-${berlinDay}) END AS metric,
    'Tage bis Frist' AS metric_label
    FROM maintenance_orders mo WHERE mo.tenant_id=$1`,
  incidents:`SELECT i.id::text AS id,i.description AS label,i.status,i.site_id,
    NULL::uuid AS customer_id,i.employee_id,i.created_at AS occurred_at,
    jsonb_build_object('Prioritaet',p.code,'Alarm',i.alarm_id::text) AS details,
    NULL::numeric AS metric,NULL::text AS metric_label
    FROM incidents i
    LEFT JOIN alarm_priorities p ON p.tenant_id=i.tenant_id AND p.id=i.priority_id
    WHERE i.tenant_id=$1`,
  alarms:`SELECT a.id::text AS id,COALESCE(a.description,a.type) AS label,a.status,
    a.site_id,NULL::uuid AS customer_id,a.employee_id,a.triggered_at AS occurred_at,
    jsonb_build_object('Schwere',a.severity,'Prioritaet',p.code,'Typ',a.type) AS details,
    NULL::numeric AS metric,NULL::text AS metric_label
    FROM alarms a
    LEFT JOIN alarm_priorities p ON p.tenant_id=a.tenant_id AND p.id=a.priority_id
    WHERE a.tenant_id=$1`,
  customers:`SELECT cs.id::text AS id,concat_ws(' · ',c.name,s.name) AS label,
    cs.relationship_status AS status,cs.site_id,cs.customer_id,NULL::uuid AS employee_id,
    COALESCE(cs.starts_on::timestamp AT TIME ZONE 'Europe/Berlin',cs.created_at) AS occurred_at,
    jsonb_build_object('Beziehung',cs.relationship_type,'Hauptobjekt',cs.is_primary) AS details,
    NULL::numeric AS metric,NULL::text AS metric_label
    FROM customer_sites cs
    JOIN customers c ON c.tenant_id=cs.tenant_id AND c.id=cs.customer_id
    JOIN sites s ON s.tenant_id=cs.tenant_id AND s.id=cs.site_id
    WHERE cs.tenant_id=$1`,
  worktime:`SELECT w.id::text AS id,concat_ws(' · ',w.provider,w.external_id) AS label,
    w.status,NULL::uuid AS site_id,NULL::uuid AS customer_id,w.employee_id,w.started_at AS occurred_at,
    jsonb_build_object('Anbieter',w.provider,'Ende',to_char(w.ended_at AT TIME ZONE 'Europe/Berlin','YYYY-MM-DD HH24:MI')) AS details,
    round(w.minutes/60.0::numeric,2) AS metric,'Stunden' AS metric_label
    FROM work_time_entries w WHERE w.tenant_id=$1 AND w.status<>'deleted'`,
  measures:`SELECT om.id::text AS id,om.title AS label,om.status,om.site_id,
    NULL::uuid AS customer_id,om.assigned_employee_id AS employee_id,om.created_at AS occurred_at,
    jsonb_build_object('Modul',om.module,'Prioritaet',om.priority,'Faellig',to_char(om.due_at AT TIME ZONE 'Europe/Berlin','YYYY-MM-DD HH24:MI')) AS details,
    NULL::numeric AS metric,NULL::text AS metric_label
    FROM operations_measures om WHERE om.tenant_id=$1`,
  audit:`SELECT ae.id::text AS id,ae.event_type AS label,'—' AS status,
    NULL::uuid AS site_id,NULL::uuid AS customer_id,NULL::uuid AS employee_id,
    ae.created_at AS occurred_at,ae.details AS details,
    NULL::numeric AS metric,NULL::text AS metric_label
    FROM audit_events ae WHERE ae.tenant_id=$1`,
};

export interface ReportingRow {
  id:string;
  label:string;
  status:string;
  occurred_at:string;
  site_id:string|null;
  customer_id:string|null;
  employee_id:string|null;
  site_name:string|null;
  customer_name:string|null;
  employee_name:string|null;
  details:Record<string,unknown>;
  metric:number|string|null;
  metric_label:string|null;
  total?:number;
}

/**
 * Ein einziger SQL-Vertrag für alle 13 Module. Filter, Sortierung, Pagination
 * und Site-Scope werden ausschließlich hier angewandt.
 */
export function reportingQuery(slug:ReportingModuleSlug,tenantId:string,filters:ReportingFilters,siteScope:string[]|null,limit?:number){
  const inner=MODULE_SQL[slug];
  const rowLimit=limit??filters.pageSize;
  const offset=limit===undefined?(filters.page-1)*filters.pageSize:0;
  const text=`WITH normalized AS (${inner}),
  filtered AS (
    SELECT n.* FROM normalized n
    WHERE n.occurred_at >= ($2::date::timestamp AT TIME ZONE 'Europe/Berlin')
      AND n.occurred_at < (($3::date + 1)::timestamp AT TIME ZONE 'Europe/Berlin')
      AND ($4::uuid IS NULL OR n.site_id=$4::uuid)
      AND ($5::uuid IS NULL OR n.customer_id=$5::uuid)
      AND ($6::uuid IS NULL OR n.employee_id=$6::uuid)
      AND ($7::text IS NULL OR n.label ILIKE '%'||$7||'%'
        OR COALESCE(n.status,'') ILIKE '%'||$7||'%'
        OR n.details::text ILIKE '%'||$7||'%')
      AND ($10::uuid[] IS NULL OR n.site_id=ANY($10::uuid[]))
  )
  SELECT count(*) OVER()::integer AS total,
    f.id,f.label,f.status,f.site_id,f.customer_id,f.employee_id,f.occurred_at,
    s.name AS site_name,e.name AS employee_name,
    COALESCE(cs.name,dc.name) AS customer_name,
    f.details,f.metric,f.metric_label
  FROM filtered f
  LEFT JOIN sites s ON s.tenant_id=$1 AND s.id=f.site_id
  LEFT JOIN employees e ON e.tenant_id=$1 AND e.id=f.employee_id
  LEFT JOIN LATERAL (
    SELECT c.name FROM customer_sites rel
    JOIN customers c ON c.tenant_id=rel.tenant_id AND c.id=rel.customer_id
    WHERE rel.tenant_id=$1 AND rel.site_id=f.site_id AND rel.relationship_status='active'
    ORDER BY rel.is_primary DESC NULLS LAST,rel.created_at DESC LIMIT 1
  ) cs ON TRUE
  LEFT JOIN customers dc ON dc.tenant_id=$1 AND dc.id=f.customer_id
  ORDER BY f.${filters.sort} ${filters.order}, f.id ASC
  LIMIT $8 OFFSET $9`;
  const values=[
    tenantId,filters.from,filters.to,filters.siteId,filters.customerId,filters.employeeId,
    filters.search,rowLimit,offset,siteScope,
  ];
  return {text,values};
}

export function safeReportFilename(slug:string,filters:ReportingFilters,extension:string){
  const cleaned=slug.replace(/[^a-z0-9-]/gi,'').slice(0,40)||'bericht';
  return `reporting-${cleaned}-${filters.from}-bis-${filters.to}.${extension}`;
}

export function reportHeaders(_rows:ReportingRow[]):string[]{
  return ['Zeitpunkt','Bezeichnung','Status','Objekt','Kunde','Mitarbeiter','Kennzahl','Einheit','Details'];
}

export function reportCsv(rows:ReportingRow[]):string{
  const header=reportHeaders(rows).join(';');
  const cell=(value:unknown)=>`"${String(value??'').replaceAll('"','""').replaceAll('\r',' ').replaceAll('\n',' ')}"`;
  const lines=rows.map(row=>[
    row.occurred_at,row.label,row.status,row.site_name??row.site_id??'',
    row.customer_name??row.customer_id??'',row.employee_name??row.employee_id??'',
    row.metric??'',row.metric_label??'',JSON.stringify(row.details??{}),
  ].map(cell).join(';'));
  return `\uFEFF${[header,...lines].join('\r\n')}\r\n`;
}

export function reportPdfLines(moduleTitle:string,filters:ReportingFilters,rows:ReportingRow[]):string[]{
  const scope=[
    `Zeitraum: ${filters.from} bis ${filters.to} (Europe/Berlin)`,
    `Objekt: ${filters.siteId??'alle'}`,
    `Kunde: ${filters.customerId??'alle'}`,
    `Mitarbeiter: ${filters.employeeId??'alle'}`,
    `Suche: ${filters.search??'—'}`,
  ].join(' | ');
  return [
    `Reporting-Zentrum · ${moduleTitle}`,
    scope,
    `Datensätze: ${rows.length}`,
    '',
    ...rows.flatMap((row,index)=>[
      `${index+1}. ${row.label} — ${row.status}`,
      `   Zeitpunkt: ${row.occurred_at} | Objekt: ${row.site_name??'—'} | Kunde: ${row.customer_name??'—'} | Mitarbeiter: ${row.employee_name??'—'}`,
      `   Kennzahl: ${row.metric??'—'} ${row.metric_label??''}`.trimEnd(),
    ]),
  ];
}

export function reportTitle(slug:ReportingModuleSlug){
  return reportingModule(slug).title;
}
