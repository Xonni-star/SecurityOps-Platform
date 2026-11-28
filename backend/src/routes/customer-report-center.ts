/**
 * Kundenberichtswesen: Entwurf, Prüfung, Freigabe und schreibgeschütztes
 * Kundenportal. Die Routen liegen vor den bestehenden `/:kind`-Routen, damit
 * bestehende Exporte unverändert erreichbar bleiben.
 */
import {Router,Request} from 'express';
import {z} from 'zod';
import {query} from '../db/pool.js';
import {requireAuth,requireCsrf,requirePermission} from '../middleware/auth.js';
import {recordAudit} from '../services/audit.js';
import {pdfReportLines} from '../services/pdf.js';
import {xlsxWorkbook} from '../services/xlsx.js';
import {canAccessResource,effectivePermissionScope,normalizePermissionGrants,type PermissionScope} from '../types/authorization.js';
import {
  CUSTOMER_REPORT_KINDS,MAX_CUSTOMER_REPORT_ROWS,customerReportCsvLines,
  customerReportDayRange,customerReportFilterResponse,customerReportFingerprint,
  customerReportKindLabel,customerReportMetricLabel,customerReportRows,
  customerReportTextLines,isCustomerReportKind,
  type CustomerReportFilters,type CustomerReportKind,type CustomerReportRow,
} from '../services/customer-report-domain.js';

const uuid=z.string().uuid();
const scopes:PermissionScope[]=['tenant','site','system'];
const filterSchema=z.object({
  from:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  site_id:uuid.optional(),customer_id:uuid.optional(),q:z.string().trim().max(100).optional(),
  sort:z.string().trim().max(40).optional(),order:z.enum(['asc','desc']).optional(),
  page:z.coerce.number().int().min(1).max(1000).optional(),
  page_size:z.coerce.number().int().min(1).max(MAX_CUSTOMER_REPORT_ROWS).optional(),
});
const createSchema=z.object({
  title:z.string().trim().min(3).max(160),
  kind:z.string().refine(isCustomerReportKind,'Unbekannte Nachweisart'),
  customer_id:uuid,filters:filterSchema,
}).strict();
const reasonSchema=z.object({reason:z.string().trim().min(3).max(500)}).strict();

type Row=Record<string,unknown>;
type ReleaseRow=Row&{
  id:string;tenant_id:string;customer_id:string;title:string;kind:string;status:string;
  filters:CustomerReportFilters|string;allowed_site_ids:string[]|string;rows:CustomerReportRow[]|string;
  row_count:number;fingerprint:string;created_by:string;created_at:string;previewed_at:string;
  approved_by:string|null;approved_at:string|null;rejected_reason?:string|null;
  revoked_reason?:string|null;customer_name?:string;
};
function fail(message:string,status:number):never{
  throw Object.assign(new Error(message),{status});
}

function userScope(req:Request,permission:string){
  const user=req.user!;
  const grants=normalizePermissionGrants(user.permissionGrants,user.permissions);
  const scope=effectivePermissionScope(grants,permission,{role:user.role,isSystemAdmin:user.isSystemAdmin===true});
  if(!scope)throw fail('Unzureichende Berechtigungen',403);
  return scope;
}
async function customerSites(req:Request,customerId:string,siteId:string|undefined,permission:string){
  const scope=userScope(req,permission);
  if(siteId&&(req.user!.siteIds??[]).length&&!(req.user!.siteIds??[]).includes(siteId))throw fail('Kein Zugriff auf Objekt',403);
  if(!((await query('SELECT id FROM customers WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,customerId])).rows[0]))
    throw fail('Kunde nicht gefunden',404);
  const links=(await query(
    `SELECT site_id FROM customer_sites WHERE tenant_id=$1 AND customer_id=$2 AND relationship_status='active'`,
    [req.user!.tenantId,customerId])).rows as {site_id:string}[];
  let siteIds=links.map(link=>link.site_id);
  if(siteId){
    if(!siteIds.includes(siteId))throw fail('Objekt ist nicht mit diesem Kunden verknüpft',400);
    siteIds=[siteId];
  }
  if(scope==='site'){
    const permitted=new Set(req.user!.siteIds??[]);
    siteIds=siteIds.filter(id=>permitted.has(id));
    if(siteId&&!canAccessResource({userId:req.user!.id,tenantId:req.user!.tenantId,role:req.user!.role,
      isSystemAdmin:req.user!.isSystemAdmin===true,siteIds:req.user!.siteIds??[],
      grants:normalizePermissionGrants(req.user!.permissionGrants,req.user!.permissions)},scope,
      {tenantId:req.user!.tenantId,siteId}))throw fail('Kein Zugriff auf Objekt',403);
    if(!siteIds.length)throw fail('Keine zugänglichen Kundenstandorte',403);
  }
  return {scope,siteIds};
}
async function releaseFor(req:Request,id:string,permission:string,portal=false){
  const scope=userScope(req,permission);
  const result=await query(
    `SELECT r.*,c.name AS customer_name FROM customer_report_releases r
     JOIN customers c ON c.tenant_id=r.tenant_id AND c.id=r.customer_id
     WHERE r.tenant_id=$1 AND r.id=$2`,[req.user!.tenantId,id]);
  const release=result.rows[0] as ReleaseRow|undefined;
  if(!release)throw fail('Kundenbericht nicht gefunden',404);
  if(portal){
    if(release.status!=='approved')throw fail('Freigegebener Kundenbericht nicht gefunden',404);
    const links=(await query(
      `SELECT site_id FROM customer_sites WHERE tenant_id=$1 AND customer_id=$2 AND relationship_status='active'`,
      [req.user!.tenantId,release.customer_id])).rows as {site_id:string}[];
    const allowed=new Set(links.map(link=>link.site_id));
    const sites=parseSites(release.allowed_site_ids);
    if(!sites.some(site=>allowed.has(site)))throw fail('Kein Zugriff auf diesen Kundenbericht',403);
    if(scope==='site'&&!sites.some(site=>(req.user!.siteIds??[]).includes(site)))
      throw fail('Kein Zugriff auf diesen Kundenbericht',403);
  }else if(scope==='site'){
    if(!parseSites(release.allowed_site_ids).some(site=>(req.user!.siteIds??[]).includes(site)))
      throw fail('Kein Zugriff auf diesen Kundenbericht',403);
  }else if(scope==='own'&&release.created_by!==req.user!.id)
    throw fail('Kein Zugriff auf diesen Kundenbericht',403);
  return release;
}
function parseSites(value:ReleaseRow['allowed_site_ids']):string[]{
  if(Array.isArray(value))return value;
  try{const parsed=JSON.parse(String(value));return Array.isArray(parsed)?parsed.map(String):[];}catch{return [];}
}
function parseRows(value:ReleaseRow['rows']):CustomerReportRow[]{
  if(Array.isArray(value))return value as CustomerReportRow[];
  try{const parsed=JSON.parse(String(value));return Array.isArray(parsed)?parsed as CustomerReportRow[]:[];}catch{return [];}
}
function parseFilters(value:ReleaseRow['filters']):CustomerReportFilters{
  if(value&&typeof value==='object')return value as CustomerReportFilters;
  try{return JSON.parse(String(value)) as CustomerReportFilters;}catch{return {};}
}
function publicRelease(release:ReleaseRow){
  const filters=parseFilters(release.filters);
  return {
    id:release.id,title:release.title,kind:release.kind,kind_label:customerReportKindLabel(release.kind),
    status:release.status,customer_id:release.customer_id,customer_name:release.customer_name??null,
    row_count:Number(release.row_count),fingerprint:release.fingerprint,
    from:filters.from??customerReportDayRange(filters).fromDay,
    to:filters.to??customerReportDayRange(filters).toDay,
    site_id:filters.site_id??null,documentation_profile:'DIN 77200 – Dokumentationsprofil, keine Zertifizierung',
    created_by:release.created_by,created_at:release.created_at,previewed_at:release.previewed_at,
    approved_by:release.approved_by??null,approved_at:release.approved_at??null,
    rejected_reason:release.rejected_reason??null,revoked_reason:release.revoked_reason??null,
    filters,
  };
}
async function snapshot(req:Request,release:ReleaseRow){
  const filters=parseFilters(release.filters);
  const kind=release.kind as CustomerReportKind;
  const result=await customerReportRows(req.user!.tenantId,kind,
    {...filters,sort:'occurred_at',order:'desc',page:1,page_size:MAX_CUSTOMER_REPORT_ROWS},
    parseSites(release.allowed_site_ids));
  return {...result,fingerprint:customerReportFingerprint(kind,filters,result.rows)};
}
async function assertCurrentDataBasis(req:Request,release:ReleaseRow){
  const current=await snapshot(req,release);
  if(current.fingerprint!==release.fingerprint||current.total>MAX_CUSTOMER_REPORT_ROWS)
    throw fail('Die Datenbasis hat sich seit dem Entwurf geändert. Bitte einen neuen Entwurf erstellen.',409);
  return current;
}
function exportRows(release:ReleaseRow,format:'csv'|'pdf'|'xlsx'){
  const filters=parseFilters(release.filters);
  const rows=parseRows(release.rows);
  if(format==='xlsx')return {format,body:xlsxWorkbook([
    ['Referenz','Zeitpunkt (Europe/Berlin)','Objekt','Kategorie','Bezeichnung','Status','Kennzahl'],
    ...rows.map(row=>[row.id,row.occurred_at,row.site_name,row.category,row.label,row.status,row.metric]),
  ]),type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',ext:'xlsx'};
  if(format==='pdf')return {format,
    body:pdfReportLines(customerReportTextLines(release.title,release.kind,filters,rows)),
    type:'application/pdf',ext:'pdf'};
  return {format:'csv',body:`\uFEFF${customerReportCsvLines(rows).join('\r\n')}\r\n`,
    type:'text/csv; charset=utf-8',ext:'csv'};
}

export const customerReportCenterRouter=Router();
customerReportCenterRouter.use((req,res,next)=>/^\/(customer-reports|customer-portal)/.test(req.path)
  ?requireAuth(req,res,()=>['POST','PATCH','PUT','DELETE'].includes(req.method)?requireCsrf(req,res,next):next())
  :next());

customerReportCenterRouter.get('/customer-reports/kinds',
  requirePermission('customer_reports:read',{allowedScopes:scopes}),
  (_req,res)=>res.json({timezone:'Europe/Berlin',kinds:CUSTOMER_REPORT_KINDS}));

customerReportCenterRouter.get('/customer-reports/preview/:kind',
  requirePermission('customer_reports:read',{allowedScopes:scopes}),async(req,res,next)=>{
  try{
    const kind=String(req.params.kind);
    if(!isCustomerReportKind(kind))throw fail('Unbekannte Nachweisart',400);
    const filters=filterSchema.parse(req.query) as CustomerReportFilters;
    const {siteIds}=filters.customer_id
      ?await customerSites(req,filters.customer_id,filters.site_id,'customer_reports:read')
      :{siteIds:filters.site_id?[filters.site_id]:undefined};
    if(filters.site_id&&(req.user!.siteIds??[]).length&&!(req.user!.siteIds??[]).includes(filters.site_id))
      throw fail('Kein Zugriff auf Objekt',403);
    const result=await customerReportRows(req.user!.tenantId,kind,filters,siteIds);
    res.json({kind,kind_label:customerReportKindLabel(kind),metric_label:customerReportMetricLabel(kind),
      rows:result.rows,filter:customerReportFilterResponse(filters,customerReportDayRange(filters),
        result.page,result.page_size,result.total),documentation_profile:'DIN 77200'});
  }catch(error){next(error);}
});

customerReportCenterRouter.post('/customer-reports/releases',
  requirePermission('customer_reports:write',{allowedScopes:scopes}),async(req,res,next)=>{
  try{
    const body=createSchema.parse(req.body);
    const kind=body.kind as CustomerReportKind;
    const {siteIds}=await customerSites(req,body.customer_id,body.filters.site_id,'customer_reports:write');
    if(!siteIds.length)throw fail('Für diesen Kunden sind keine zugänglichen Objekte vorhanden',403);
    const filters={...body.filters,customer_id:body.customer_id};
    const result=await customerReportRows(req.user!.tenantId,kind,
      {...filters,sort:'occurred_at',order:'desc',page:1,page_size:MAX_CUSTOMER_REPORT_ROWS},siteIds);
    const fingerprint=customerReportFingerprint(kind,filters,result.rows);
    const inserted=await query(
      `INSERT INTO customer_report_releases(tenant_id,customer_id,title,kind,status,filters,
       allowed_site_ids,rows,row_count,fingerprint,created_by,previewed_at)
       VALUES($1,$2,$3,$4,'draft',$5,$6,$7,$8,$9,$10,now()) RETURNING id,created_at,status`,
      [req.user!.tenantId,body.customer_id,body.title,kind,JSON.stringify(filters),siteIds,
        JSON.stringify(result.rows),result.rows.length,fingerprint,req.user!.id]);
    await recordAudit(req.user!.tenantId,req.user!.id,'customer_report.created','customer_report',
      inserted.rows[0].id,{kind,title:body.title,customer_id:body.customer_id,row_count:result.rows.length,
        fingerprint,site_count:siteIds.length});
    res.status(201).json({id:inserted.rows[0].id,status:inserted.rows[0].status,
      created_at:inserted.rows[0].created_at,row_count:result.rows.length,fingerprint});
  }catch(error){next(error);}
});

customerReportCenterRouter.get('/customer-reports/releases',
  requirePermission('customer_reports:read',{allowedScopes:scopes}),async(req,res,next)=>{
  try{
    const scope=userScope(req,'customer_reports:read');
    const result=await query(
      `SELECT r.*,c.name AS customer_name FROM customer_report_releases r
       JOIN customers c ON c.tenant_id=r.tenant_id AND c.id=r.customer_id
       WHERE r.tenant_id=$1 ORDER BY r.updated_at DESC LIMIT 500`,[req.user!.tenantId]);
    const rows=(result.rows as ReleaseRow[]).filter(release=>scope!=='site'||
      parseSites(release.allowed_site_ids).some(site=>(req.user!.siteIds??[]).includes(site)));
    res.json({releases:rows.map(publicRelease)});
  }catch(error){next(error);}
});

customerReportCenterRouter.get('/customer-reports/releases/:id',
  requirePermission('customer_reports:read',{allowedScopes:scopes}),async(req,res,next)=>{
  try{
    const release=await releaseFor(req,String(req.params.id),'customer_reports:read');
    const current=await snapshot(req,release);
    res.json({...publicRelease(release),allowed_site_ids:parseSites(release.allowed_site_ids),
      rows:parseRows(release.rows),current_row_count:current.total,
      data_basis_current:current.fingerprint===release.fingerprint});
  }catch(error){next(error);}
});

customerReportCenterRouter.post('/customer-reports/releases/:id/submit',
  requirePermission('customer_reports:write',{allowedScopes:scopes}),async(req,res,next)=>{
  try{
    const release=await releaseFor(req,String(req.params.id),'customer_reports:write');
    if(release.status!=='draft'&&release.status!=='rejected')throw fail('Nur Entwürfe können eingereicht werden',409);
    await assertCurrentDataBasis(req,release);
    const updated=await query(
      `UPDATE customer_report_releases SET status='in_review',submitted_at=now(),reviewed_at=NULL,
       rejected_reason=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status IN ('draft','rejected')
       RETURNING id,status`,[req.user!.tenantId,release.id]);
    if(!updated.rows[0])throw fail('Der Entwurf wurde zwischenzeitlich geändert',409);
    await recordAudit(req.user!.tenantId,req.user!.id,'customer_report.submitted','customer_report',release.id,
      {fingerprint:release.fingerprint,row_count:Number(release.row_count)});
    res.json(updated.rows[0]);
  }catch(error){next(error);}
});

customerReportCenterRouter.post('/customer-reports/releases/:id/approve',
  requirePermission('customer_reports:approve',{allowedScopes:scopes}),async(req,res,next)=>{
  try{
    const release=await releaseFor(req,String(req.params.id),'customer_reports:approve');
    if(release.status!=='in_review')throw fail('Nur geprüfte Berichte können freigegeben werden',409);
    if(release.created_by===req.user!.id)throw fail('Die eigene Freigabe ist nicht zulässig',403);
    if(!release.fingerprint||parseRows(release.rows).length!==Number(release.row_count))
      throw fail('Keine nachvollziehbare Datenbasis vorhanden',409);
    await assertCurrentDataBasis(req,release);
    const updated=await query(
      `UPDATE customer_report_releases SET status='approved',reviewed_at=now(),approved_at=now(),
       approved_by=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status='in_review'
       RETURNING id,status,approved_at`,[req.user!.tenantId,release.id,req.user!.id]);
    if(!updated.rows[0])throw fail('Der Bericht wurde zwischenzeitlich geändert',409);
    await recordAudit(req.user!.tenantId,req.user!.id,'customer_report.approved','customer_report',release.id,
      {fingerprint:release.fingerprint,row_count:Number(release.row_count),created_by:release.created_by,
        kind:release.kind,customer_id:release.customer_id});
    res.json(updated.rows[0]);
  }catch(error){next(error);}
});

customerReportCenterRouter.post('/customer-reports/releases/:id/reject',
  requirePermission('customer_reports:approve',{allowedScopes:scopes}),async(req,res,next)=>{
  try{
    const {reason}=reasonSchema.parse(req.body);
    const release=await releaseFor(req,String(req.params.id),'customer_reports:approve');
    if(release.status!=='in_review')throw fail('Nur geprüfte Berichte können zurückgegeben werden',409);
    const updated=await query(
      `UPDATE customer_report_releases SET status='rejected',reviewed_at=now(),rejected_reason=$3,
       updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status='in_review' RETURNING id,status`,
      [req.user!.tenantId,release.id,reason]);
    if(!updated.rows[0])throw fail('Der Bericht wurde zwischenzeitlich geändert',409);
    await recordAudit(req.user!.tenantId,req.user!.id,'customer_report.rejected','customer_report',release.id,{reason});
    res.json(updated.rows[0]);
  }catch(error){next(error);}
});

customerReportCenterRouter.post('/customer-reports/releases/:id/revoke',
  requirePermission('customer_reports:approve',{allowedScopes:scopes}),async(req,res,next)=>{
  try{
    const {reason}=reasonSchema.parse(req.body);
    const release=await releaseFor(req,String(req.params.id),'customer_reports:approve');
    if(release.status!=='approved')throw fail('Nur freigegebene Berichte können widerrufen werden',409);
    const updated=await query(
      `UPDATE customer_report_releases SET status='revoked',revoked_at=now(),revoked_reason=$3,
       updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status='approved' RETURNING id,status`,
      [req.user!.tenantId,release.id,reason]);
    if(!updated.rows[0])throw fail('Der Bericht wurde zwischenzeitlich geändert',409);
    await recordAudit(req.user!.tenantId,req.user!.id,'customer_report.revoked','customer_report',release.id,{reason});
    res.json(updated.rows[0]);
  }catch(error){next(error);}
});

customerReportCenterRouter.get('/customer-reports/releases/:id/export',
  requirePermission('customer_reports:export',{allowedScopes:scopes}),async(req,res,next)=>{
  try{
    const release=await releaseFor(req,String(req.params.id),'customer_reports:export');
    if(release.status!=='approved')throw fail('Nur freigegebene Berichte dürfen exportiert werden',409);
    const format=req.query.format==='pdf'||req.query.format==='xlsx'?req.query.format:'csv';
    const {body,type,ext}=exportRows(release,format);
    const stamp=new Date().toISOString().slice(0,10);
    await recordAudit(req.user!.tenantId,req.user!.id,'customer_report.exported','customer_report',release.id,
      {format,row_count:Number(release.row_count),fingerprint:release.fingerprint,
        customer_id:release.customer_id,kind:release.kind,documentation_profile:'DIN-77200'});
    res.type(type)
      .set('content-disposition',`attachment; filename="kundenbericht-${stamp}.${ext}"`)
      .set('x-report-row-count',String(parseRows(release.rows).length))
      .set('x-report-truncated','false')
      .send(body);
  }catch(error){next(error);}
});

customerReportCenterRouter.get('/customer-portal/releases',
  requirePermission('customer_portal:read',{allowedScopes:scopes}),async(req,res,next)=>{
  try{
    const scope=userScope(req,'customer_portal:read');
    const result=await query(
      `SELECT r.*,c.name AS customer_name FROM customer_report_releases r
       JOIN customers c ON c.tenant_id=r.tenant_id AND c.id=r.customer_id
       WHERE r.tenant_id=$1 AND r.status='approved' ORDER BY r.approved_at DESC LIMIT 500`,
      [req.user!.tenantId]);
    const rows=(result.rows as ReleaseRow[]).filter(release=>{
      const sites=parseSites(release.allowed_site_ids);
      if(scope==='site'&&!sites.some(site=>(req.user!.siteIds??[]).includes(site)))return false;
      const requested=typeof req.query.customer_id==='string'?req.query.customer_id:null;
      return !requested||release.customer_id===requested;
    });
    res.json({releases:rows.map(publicRelease),read_only:true,export_allowed:false,
      note:'Schreibgeschützte Ansicht freigegebener eigener Daten. Exporte sind hier nicht verfügbar.'});
  }catch(error){next(error);}
});

customerReportCenterRouter.get('/customer-portal/releases/:id',
  requirePermission('customer_portal:read',{allowedScopes:scopes}),async(req,res,next)=>{
  try{
    const release=await releaseFor(req,String(req.params.id),'customer_portal:read',true);
    await recordAudit(req.user!.tenantId,req.user!.id,'customer.portal.released_viewed','customer_portal',
      release.id,{kind:release.kind,customer_id:release.customer_id,row_count:Number(release.row_count)});
    res.json({...publicRelease(release),rows:parseRows(release.rows),read_only:true,export_allowed:false});
  }catch(error){next(error);}
});
