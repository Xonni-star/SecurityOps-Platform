/**
 * Zentraler Vertrag für kundenfähige Nachweisberichte.
 *
 * Alle Auswertungen lesen ausschließlich aus den bestehenden Fachtabellen. Es
 * gibt keine Reporting-Tabellen, keine Materialized Views und keine
 * Beispieldaten oder Mock-Werte. Die Projektion enthält bewusst keine Freitexte,
 * Mitarbeiterdaten, internen Notizen oder Bewertungen: genau diese Felder
 * dürfen in Kundenberichten und Kundenportal nicht auftauchen.
 */
import {createHash} from 'node:crypto';
import {query} from '../db/pool.js';

export const CUSTOMER_REPORT_KINDS=[
  {slug:'control-walks',label:'Kontrollgänge',description:'Regelgerecht erfasste Kontrollgänge je Objekt und Kontrollpunkt.',metricLabel:'Kontrollgänge'},
  {slug:'watchbook',label:'Wachbuch',description:'Geschlossene und offene Wachbucheinträge ohne Freitext und Autordaten.',metricLabel:'Einträge'},
  {slug:'alarms',label:'Alarme',description:'Ausgelöste Alarme mit Priorität und Bearbeitungsstand.',metricLabel:'Alarme'},
  {slug:'incidents',label:'Einsätze',description:'Einsätze mit Priorität und Einsatzstatus ohne Einsatzbeschreibung.',metricLabel:'Einsätze'},
] as const;

export type CustomerReportKind=typeof CUSTOMER_REPORT_KINDS[number]['slug'];
export type CustomerReportRow={
  id:string;
  occurred_at:string;
  site_id:string|null;
  site_name:string|null;
  category:string;
  label:string;
  status:string;
  metric:number;
};
export type CustomerReportFilters={
  from?:string;
  to?:string;
  site_id?:string;
  customer_id?:string;
  q?:string;
  sort?:string;
  order?:'asc'|'desc';
  page?:number;
  page_size?:number;
};

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY=/^\d{4}-\d{2}-\d{2}$/;
const SORTS:Record<string,string>={
  occurred_at:'occurred_at',site_name:'site_name',category:'category',label:'label',status:'status',
};
export const MAX_CUSTOMER_REPORT_ROWS=5000;

export function isCustomerReportKind(value:string):value is CustomerReportKind{
  return CUSTOMER_REPORT_KINDS.some(kind=>kind.slug===value);
}
export function customerReportKindLabel(kind:string):string{
  return CUSTOMER_REPORT_KINDS.find(item=>item.slug===kind)?.label??kind;
}
export function customerReportMetricLabel(kind:string):string{
  return CUSTOMER_REPORT_KINDS.find(item=>item.slug===kind)?.metricLabel??'Nachweise';
}

/** Kalendertagsgrenzen in Europe/Berlin, inklusive Sommer-/Winterzeit. */
function berlinOffsetMinutes(instant:Date):number{
  const parts=new Intl.DateTimeFormat('en-US',{
    timeZone:'Europe/Berlin',year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false,
  }).formatToParts(instant).reduce<Record<string,string>>((result,part)=>{
    if(part.type!=='literal')result[part.type]=part.value;
    return result;
  },{});
  const asUtc=Date.UTC(Number(parts.year),Number(parts.month)-1,Number(parts.day),
    Number(parts.hour)%24,Number(parts.minute),Number(parts.second));
  return Math.round((asUtc-instant.getTime())/60_000);
}
function berlinBoundary(day:string,endOfDay:boolean):Date{
  const [year,month,date]=day.split('-').map(Number);
  const naive=Date.UTC(year,month-1,date,endOfDay?23:0,endOfDay?59:0,endOfDay?59:0);
  return new Date(naive-berlinOffsetMinutes(new Date(naive))*60_000);
}
function berlinDay(instant:Date):string{
  return new Intl.DateTimeFormat('en-CA',{
    timeZone:'Europe/Berlin',year:'numeric',month:'2-digit',day:'2-digit',
  }).format(instant);
}
export function customerReportDayRange(filters:CustomerReportFilters,now=new Date()){
  const today=berlinDay(now);
  const previous=new Date(now.getTime()-30*86_400_000);
  const fromDay=filters.from??berlinDay(previous);
  const toDay=filters.to??today;
  return {from:berlinBoundary(fromDay,false),to:berlinBoundary(toDay,true),fromDay,toDay};
}

const BASE_SQL:Record<CustomerReportKind,string>={
  'control-walks':`SELECT ps.id::text AS id,ps.scanned_at AS occurred_at,s.id AS site_id,s.name AS site_name,
      'Kontrollgang' AS category,cp.name AS label,
      CASE ps.deviation WHEN 'none' THEN 'Regelgerecht' WHEN 'late' THEN 'Verspätet'
        WHEN 'skipped' THEN 'Ausgelassen' ELSE 'Reihenfolge abweichend' END AS status,1::integer AS metric
    FROM patrol_scans ps
    JOIN patrol_routes r ON r.tenant_id=ps.tenant_id AND r.id=ps.route_id
    JOIN control_points cp ON cp.tenant_id=ps.tenant_id AND cp.id=ps.control_point_id
    JOIN sites s ON s.tenant_id=ps.tenant_id AND s.id=r.site_id
    WHERE ps.tenant_id=$1 AND ps.scanned_at BETWEEN $2 AND $3
      AND ($4::uuid IS NULL OR r.site_id=$4) AND ($5::uuid[] IS NULL OR r.site_id=ANY($5))`,
  watchbook:`SELECT e.id::text AS id,e.created_at AS occurred_at,s.id AS site_id,s.name AS site_name,
      c.name AS category,p.name AS label,
      CASE r.status WHEN 'closed' THEN 'Geschlossen' ELSE 'Offen' END AS status,1::integer AS metric
    FROM watchbook_entries e
    JOIN LATERAL (SELECT wr.* FROM watchbook_revisions wr WHERE wr.tenant_id=e.tenant_id
      AND wr.entry_id=e.id ORDER BY wr.revision_no DESC LIMIT 1) r ON true
    JOIN watchbook_priorities p ON p.tenant_id=e.tenant_id AND p.id=r.priority_id
    JOIN watchbook_categories c ON c.tenant_id=e.tenant_id AND c.id=r.category_id
    LEFT JOIN sites s ON s.tenant_id=e.tenant_id AND s.id=e.site_id
    WHERE e.tenant_id=$1 AND e.created_at BETWEEN $2 AND $3
      AND ($4::uuid IS NULL OR e.site_id=$4) AND ($5::uuid[] IS NULL OR e.site_id=ANY($5))`,
  alarms:`SELECT a.id::text AS id,a.triggered_at AS occurred_at,s.id AS site_id,s.name AS site_name,
      'Alarm' AS category,COALESCE(p.name,p.code,'Alarm') AS label,
      CASE a.status WHEN 'open' THEN 'Offen' WHEN 'acknowledged' THEN 'Bestätigt'
        WHEN 'resolved' THEN 'Gelöst' ELSE a.status END AS status,1::integer AS metric
    FROM alarms a
    LEFT JOIN alarm_priorities p ON p.tenant_id=a.tenant_id AND p.id=a.priority_id
    LEFT JOIN sites s ON s.tenant_id=a.tenant_id AND s.id=a.site_id
    WHERE a.tenant_id=$1 AND a.triggered_at BETWEEN $2 AND $3
      AND ($4::uuid IS NULL OR a.site_id=$4) AND ($5::uuid[] IS NULL OR a.site_id=ANY($5))`,
  incidents:`SELECT i.id::text AS id,i.created_at AS occurred_at,s.id AS site_id,s.name AS site_name,
      'Einsatz' AS category,COALESCE(p.name,p.code,'Einsatz') AS label,
      CASE i.status WHEN 'initiated' THEN 'Eingeleitet' WHEN 'en_route' THEN 'Anfahrt'
        WHEN 'on_site' THEN 'Vor Ort' WHEN 'completed' THEN 'Abgeschlossen' ELSE i.status END AS status,
      1::integer AS metric
    FROM incidents i
    LEFT JOIN alarm_priorities p ON p.tenant_id=i.tenant_id AND p.id=i.priority_id
    LEFT JOIN sites s ON s.tenant_id=i.tenant_id AND s.id=i.site_id
    WHERE i.tenant_id=$1 AND i.created_at BETWEEN $2 AND $3
      AND ($4::uuid IS NULL OR i.site_id=$4) AND ($5::uuid[] IS NULL OR i.site_id=ANY($5))`,
};

function filterValues(tenantId:string,kind:CustomerReportKind,filters:CustomerReportFilters,allowedSiteIds?:string[]){
  const range=customerReportDayRange(filters);
  if(filters.from&&!DAY.test(filters.from))throw Object.assign(new Error('Ungültiger Beginn'),{status:400});
  if(filters.to&&!DAY.test(filters.to))throw Object.assign(new Error('Ungültiges Ende'),{status:400});
  if(range.from>range.to)throw Object.assign(new Error('Ungültiger Zeitraum'),{status:400});
  if(filters.site_id&&!UUID.test(filters.site_id))throw Object.assign(new Error('Ungültiges Objekt'),{status:400});
  const siteIds=allowedSiteIds??(filters.site_id?[filters.site_id]:undefined);
  const q=filters.q?.trim().slice(0,100);
  const pattern=q?q.replace(/[\\%_]/g,'\\$&'):null;
  return {base:[tenantId,range.from,range.to,filters.site_id??null,siteIds??null],pattern,range};
}
function sortClause(filters:CustomerReportFilters){
  const column=SORTS[filters.sort??'occurred_at']??'occurred_at';
  const direction=filters.order==='asc'?'ASC':'DESC';
  return `basis.${column} ${direction},basis.id DESC`;
}

export async function customerReportRows(tenantId:string,kind:CustomerReportKind,filters:CustomerReportFilters,allowedSiteIds?:string[]){
  const {base,pattern}=filterValues(tenantId,kind,filters,allowedSiteIds);
  const page=Math.max(1,Math.floor(filters.page??1));
  const pageSize=Math.min(MAX_CUSTOMER_REPORT_ROWS,Math.max(1,Math.floor(filters.page_size??25)));
  const where=`($6::text IS NULL OR basis.label ILIKE $6 ESCAPE '\\' OR basis.category ILIKE $6 ESCAPE '\\' OR COALESCE(basis.site_name,'') ILIKE $6 ESCAPE '\\')`;
  const values=[...base,pattern?`%${pattern}%`:null,pageSize,(page-1)*pageSize];
  const result=await query<{id:string;occurred_at:Date;site_id:string|null;site_name:string|null;category:string;label:string;status:string;metric:number}>(
    `WITH basis AS (${BASE_SQL[kind]}) SELECT basis.* FROM basis WHERE ${where} ORDER BY ${sortClause(filters)} LIMIT $7 OFFSET $8`,values);
  const count=await query<{total:number}>(
    `WITH basis AS (${BASE_SQL[kind]}) SELECT count(*)::int AS total FROM basis WHERE ${where}`,[...base,pattern?`%${pattern}%`:null]);
  const rows:CustomerReportRow[]=result.rows.map(row=>({
    id:row.id,occurred_at:new Date(row.occurred_at).toISOString(),site_id:row.site_id??null,
    site_name:row.site_name??'Ohne Objektzuordnung',category:row.category,label:row.label,
    status:row.status,metric:Number(row.metric??1),
  }));
  return {rows,total:Number(count.rows[0]?.total??0),page,page_size:pageSize};
}

/** Deterministischer Fingerprint der freigegebenen Datenbasis. */
export function customerReportFingerprint(kind:string,filters:CustomerReportFilters,rows:CustomerReportRow[]){
  const canonical={kind,from:filters.from??null,to:filters.to??null,site_id:filters.site_id??null,
    customer_id:filters.customer_id??null,q:filters.q??null,rows};
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function customerReportFilterResponse(filters:CustomerReportFilters,range:{fromDay:string;toDay:string},page:number,pageSize:number,total:number){
  return {
    from:filters.from??range.fromDay,to:filters.to??range.toDay,
    site_id:filters.site_id??null,customer_id:filters.customer_id??null,q:filters.q??null,
    sort:filters.sort??'occurred_at',order:filters.order??'desc',page,page_size:pageSize,
    total,page_count:Math.max(1,Math.ceil(total/pageSize)),timezone:'Europe/Berlin',
  };
}

const berlinDateTime=new Intl.DateTimeFormat('de-DE',{
  timeZone:'Europe/Berlin',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:false,
});
const csvCell=(value:unknown)=>`"${String(value??'').replaceAll('"','""')}"`;
export function customerReportCsvLines(rows:CustomerReportRow[]):string[]{
  return [
    ['Referenz','Zeitpunkt (Europe/Berlin)','Objekt','Kategorie','Bezeichnung','Status','Kennzahl'].map(csvCell).join(';'),
    ...rows.map(row=>[row.id,berlinDateTime.format(new Date(row.occurred_at)),row.site_name,
      row.category,row.label,row.status,row.metric].map(csvCell).join(';')),
  ];
}
export function customerReportTextLines(title:string,kind:string,filters:CustomerReportFilters,rows:CustomerReportRow[]):string[]{
  const range=customerReportDayRange(filters);
  return [
    `SecurityOps – ${title}`,
    `Nachweisart: ${customerReportKindLabel(kind)}`,
    `Zeitraum: ${range.fromDay} bis ${range.toDay} (Europe/Berlin)`,
    `Nachweise: ${rows.length}`,
    'Dokumentationsprofil DIN 77200; keine Zertifizierungs- oder Rechtsaussage.',
    '',
    ...rows.map(row=>`${berlinDateTime.format(new Date(row.occurred_at))} | ${row.site_name} | ${row.category} | ${row.label} | ${row.status}`),
  ];
}
