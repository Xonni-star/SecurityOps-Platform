import {Router,Request} from 'express';
import {z} from 'zod';
import {query} from '../db/pool.js';
import {requireAuth,requirePermission} from '../middleware/auth.js';
import {recordAudit} from '../services/audit.js';
import {pdfReportLines} from '../services/pdf.js';
import {customerReportDayRange} from '../services/customer-report-domain.js';
import {canAccessResource,effectivePermissionScope,normalizePermissionGrants} from '../types/authorization.js';

const uuid=z.string().uuid();
const reportKind=z.enum(['control-walks','watchbook','alarms','incidents']);
type Row=Record<string,unknown>;

function scopeSite(req:Request,siteId:string|undefined,permission:string){
  const user=req.user!;
  const grants=normalizePermissionGrants(user.permissionGrants,user.permissions);
  const scope=effectivePermissionScope(grants,permission,{role:user.role,isSystemAdmin:user.isSystemAdmin===true});
  if(!scope)throw Object.assign(new Error('Unzureichende Berechtigungen'),{status:403});
  if(siteId&&user.siteIds?.length&&!user.siteIds.includes(siteId))throw Object.assign(new Error('Kein Zugriff auf Objekt'),{status:403});
  if(scope==='site'&&siteId&&!canAccessResource({userId:user.id,tenantId:user.tenantId,role:user.role,isSystemAdmin:user.isSystemAdmin===true,siteIds:user.siteIds??[],grants},scope,{tenantId:user.tenantId,siteId}))throw Object.assign(new Error('Kein Zugriff auf Objekt'),{status:403});
  return scope;
}

async function rowsFor(req:Request,kind:z.infer<typeof reportKind>,from:Date,to:Date,siteId?:string,siteIds?:string[]){
  const tenant=req.user!.tenantId;
  switch(kind){
    case 'control-walks':return (await query(`SELECT ps.id,ps.scanned_at,ps.deviation,r.name route_name,cp.name control_point_name,
      s.id site_id,s.name site_name,e.name employee_name FROM patrol_scans ps
      JOIN patrol_routes r ON r.tenant_id=ps.tenant_id AND r.id=ps.route_id
      JOIN control_points cp ON cp.tenant_id=ps.tenant_id AND cp.id=ps.control_point_id
      JOIN sites s ON s.tenant_id=ps.tenant_id AND s.id=r.site_id
      JOIN employees e ON e.tenant_id=ps.tenant_id AND e.id=ps.employee_id
      WHERE ps.tenant_id=$1 AND ps.scanned_at BETWEEN $2 AND $3 AND ($4::uuid IS NULL OR r.site_id=$4) AND ($5::uuid[] IS NULL OR r.site_id=ANY($5))
      ORDER BY ps.scanned_at DESC`,[tenant,from,to,siteId??null,siteIds??null])).rows;
    case 'watchbook':return (await query(`SELECT e.id,e.site_id,e.created_at,r.content,r.status,p.code priority_code,c.code category_code,u.email author_email
      FROM watchbook_entries e JOIN LATERAL (SELECT * FROM watchbook_revisions wr WHERE wr.tenant_id=e.tenant_id AND wr.entry_id=e.id ORDER BY wr.revision_no DESC LIMIT 1) r ON true
      JOIN watchbook_priorities p ON p.tenant_id=e.tenant_id AND p.id=r.priority_id
      JOIN watchbook_categories c ON c.tenant_id=e.tenant_id AND c.id=r.category_id
      JOIN users u ON u.tenant_id=e.tenant_id AND u.id=r.authored_by
      WHERE e.tenant_id=$1 AND e.created_at BETWEEN $2 AND $3 AND ($4::uuid IS NULL OR e.site_id=$4) AND ($5::uuid[] IS NULL OR e.site_id=ANY($5))
      ORDER BY e.created_at DESC`,[tenant,from,to,siteId??null,siteIds??null])).rows;
    case 'alarms':return (await query(`SELECT a.id,a.type,a.status,a.description,a.triggered_at,a.acknowledged_at,a.resolved_at,
      p.code priority_code,s.id site_id,s.name site_name FROM alarms a LEFT JOIN alarm_priorities p ON p.tenant_id=a.tenant_id AND p.id=a.priority_id
      LEFT JOIN sites s ON s.tenant_id=a.tenant_id AND s.id=a.site_id
      WHERE a.tenant_id=$1 AND a.triggered_at BETWEEN $2 AND $3 AND ($4::uuid IS NULL OR a.site_id=$4) AND ($5::uuid[] IS NULL OR a.site_id=ANY($5)) ORDER BY a.triggered_at DESC`,[tenant,from,to,siteId??null,siteIds??null])).rows;
    case 'incidents':return (await query(`SELECT i.id,i.status,i.description,i.created_at,i.updated_at,p.code priority_code,s.id site_id,s.name site_name
      FROM incidents i LEFT JOIN alarm_priorities p ON p.tenant_id=i.tenant_id AND p.id=i.priority_id
      LEFT JOIN sites s ON s.tenant_id=i.tenant_id AND s.id=i.site_id
      WHERE i.tenant_id=$1 AND i.created_at BETWEEN $2 AND $3 AND ($4::uuid IS NULL OR i.site_id=$4) AND ($5::uuid[] IS NULL OR i.site_id=ANY($5)) ORDER BY i.created_at DESC`,[tenant,from,to,siteId??null,siteIds??null])).rows;
  }
}

function csv(rows:Row[]){
  const headers=rows.length?Object.keys(rows[0]):['result'];
  return [headers.join(','),...rows.map(row=>headers.map(key=>`"${String(row[key]??'').replaceAll('"','""')}"`).join(','))].join('\n');
}
function pdf(kind:string,rows:Row[]){
  return pdfReportLines([
    `SecurityOps Kunden-Nachweise – ${kind}`,
    'DIN-77200-Dokumentationsprofil; keine rechtliche oder Zertifizierungsaussage.',
    `Nachweise: ${rows.length}`,
    '',
    ...rows.map(row=>Object.entries(row).map(([key,value])=>`${key}: ${String(value??'')}`).join(' | ')),
  ]);
}
/** Das Kundenportal liefert ausschließlich freigegebene Schnappschüsse. */
async function releasedPortalRows(req:Request,kind:string,from:Date,to:Date,customerId?:string,siteId?:string){
  const range=customerReportDayRange({from:from.toISOString().slice(0,10),to:to.toISOString().slice(0,10)});
  const result=await query<{id:string;rows:Row[]}>(
    `SELECT id,rows FROM customer_report_releases WHERE tenant_id=$1 AND status='approved' AND kind=$2
     AND ($3::uuid IS NULL OR customer_id=$3)
     AND (filters->>'from' IS NULL OR filters->>'from' <= $4)
     AND (filters->>'to' IS NULL OR filters->>'to' >= $5)
     AND ($6::uuid IS NULL OR filters->>'site_id'=$6::text OR filters->>'site_id' IS NULL)
     ORDER BY approved_at DESC LIMIT 1`,
    [req.user!.tenantId,kind,customerId??null,range.toDay,range.fromDay,siteId??null]);
  const release=result.rows[0];
  if(!release)throw Object.assign(new Error('Für diesen Zeitraum liegt kein freigegebener Kundenbericht vor'),{status:404});
  return {id:release.id,rows:(Array.isArray(release.rows)?release.rows:[]).filter(row=>!siteId||row.site_id===siteId)};
}

export const customerReportsRouter=Router();
customerReportsRouter.use((req,res,next)=>/^\/(customer-reports|customer-portal)/.test(req.path)?requireAuth(req,res,next):next());

async function reportRequest(req:Request,res:any,next:any,portal=false){
  try{
    const kind=reportKind.parse(req.params.kind);
    const from=typeof req.query.from==='string'?new Date(req.query.from):new Date(Date.now()-30*86400000);
    const to=typeof req.query.to==='string'?new Date(req.query.to):new Date();
    const siteId=typeof req.query.site_id==='string'?uuid.parse(req.query.site_id):undefined;
    const customerId=typeof req.query.customer_id==='string'?uuid.parse(req.query.customer_id):undefined;
    if(Number.isNaN(from.valueOf())||Number.isNaN(to.valueOf())||from>to)throw Object.assign(new Error('Ungültiger Zeitraum'),{status:400});
    const permission=portal?'customer_portal:read':'customer_reports:export';
    const scope=scopeSite(req,siteId,permission);
    let siteIds:string[]|undefined;
    if(customerId){
      if(!((await query('SELECT id FROM customers WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,customerId])).rows[0]))throw Object.assign(new Error('Kunde nicht gefunden'),{status:404});
      const links=(await query(`SELECT site_id FROM customer_sites WHERE tenant_id=$1 AND customer_id=$2 AND relationship_status='active'`,[req.user!.tenantId,customerId])).rows as {site_id:string}[];
      siteIds=links.map(link=>link.site_id);
      if(siteId&&!siteIds.includes(siteId))throw Object.assign(new Error('Objekt ist nicht mit diesem Kunden verknüpft'),{status:400});
    }
    if(scope==='site'){
      const permitted=new Set(req.user!.siteIds??[]);
      siteIds=siteIds?siteIds.filter(id=>permitted.has(id)):(req.user!.siteIds??[]);
      if(siteId&&!permitted.has(siteId))throw Object.assign(new Error('Kein Zugriff auf Objekt'),{status:403});
      if(customerId&&siteIds.length===0)throw Object.assign(new Error('Keine zugänglichen Kundenstandorte'),{status:403});
    }
    const released=portal?await releasedPortalRows(req,kind,from,to,customerId,siteId):null;
    const rows=released?released.rows:await rowsFor(req,kind,from,to,siteId,siteIds);
    await recordAudit(req.user!.tenantId,req.user!.id,portal?'customer.portal.viewed':'customer.report.exported',portal?'customer_portal':'customer_report',released?.id,{kind,release_id:released?.id??null,site_id:siteId??null,customer_id:customerId??null,from:from.toISOString(),to:to.toISOString(),count:rows.length,format:portal?'json':req.query.format==='pdf'?'pdf':'csv',documentation_profile:'DIN-77200'});
    if(portal)return res.json({kind,documentation_profile:'DIN-77200-Dokumentationsprofil; keine rechtliche oder Zertifizierungsaussage.',from,to,rows});
    if(req.query.format==='pdf')return res.type('application/pdf').set('content-disposition',`attachment; filename="${kind}-nachweise.pdf"`).send(pdf(kind,rows));
    return res.type('text/csv').set('content-disposition',`attachment; filename="${kind}-nachweise.csv"`).send(csv(rows));
  }catch(error){next(error);}
}

customerReportsRouter.get('/customer-reports/:kind',requirePermission('customer_reports:export',{allowedScopes:['tenant','site','system']}),(req,res,next)=>reportRequest(req,res,next));
customerReportsRouter.get('/customer-portal/:kind',requirePermission('customer_portal:read',{allowedScopes:['tenant','site','system']}),(req,res,next)=>reportRequest(req,res,next,true));
