import {Router,type Request} from 'express';
import {z} from 'zod';
import {query,withTransaction} from '../db/pool.js';
import {requireAuth,requireCsrf,requirePermission} from '../middleware/auth.js';
import {canAccessResource,canUsePermission,effectivePermissionScope,normalizePermissionGrants,type PermissionScope} from '../types/authorization.js';
import {runIdempotentMutation} from '../services/offline-sync.js';
import type {SyncMutationAction} from '../services/offline-sync.js';
import {recordAudit} from '../services/audit.js';
import {queueNotificationEvent} from '../services/notifications.js';
import {keyQrSecret} from '../config/env.js';
import {bundleStatus,buildKeyQrToken,canReturnKey,hashKeyQrToken,holderIsValid,transitionKeyStatus,validateBundleReturn,verifyKeyQrToken} from '../services/keys-domain.js';

const uuid=z.string().uuid();
const text=(max:number)=>z.string().trim().max(max).nullable().optional();
const keyStatuses=['available','issued','overdue','lost','blocked','deactivated'] as const;
const keyTypes=['physical','master','transponder','access_card','electronic','digital','other'] as const;
const returnConditions=['good','damaged','incomplete','nonfunctional','suspicious_change'] as const;
const lossStatuses=['reported','review','security_measure_required','replacement_required','closed'] as const;
const movementBody=z.object({client_mutation_id:uuid,reason:text(1000)}).strict();
const derivedStatusSql="CASE WHEN k.status='issued' AND k.due_at<now() THEN 'overdue' ELSE k.status END";
const openCriticalLossSql="EXISTS (SELECT 1 FROM key_loss_reports l WHERE l.tenant_id=k.tenant_id AND l.key_id=k.id AND l.status IN ('review','security_measure_required','replacement_required'))";
const criticalKeySql=`(k.status IN ('lost','blocked') OR (${derivedStatusSql})='overdue'
  OR (k.status='issued' AND k.holder_user_id IS NULL AND k.holder_employee_id IS NULL)
  OR ${openCriticalLossSql})`;
type Client=Parameters<Parameters<typeof withTransaction>[0]>[0];
type QueryLike={query:(text:string,values?:unknown[])=>Promise<{rows:any[]}>};
type Row=Record<string,any>;

function session(req:Request){if(!req.sessionDbId)throw Object.assign(new Error('Session-Identität fehlt.'),{status:401});return req.sessionDbId;}
function authorization(req:Request){
  const user=req.user!;
  return {userId:user.id,tenantId:user.tenantId,role:user.role,isSystemAdmin:user.isSystemAdmin===true,siteIds:user.siteIds??[],grants:normalizePermissionGrants(user.permissionGrants,user.permissions)};
}
function permissionScope(req:Request,code:string):PermissionScope|null{
  const context=authorization(req);
  return effectivePermissionScope(context.grants,code,{role:context.role,isSystemAdmin:context.isSystemAdmin});
}
function keyPermission(req:Request,code:string,siteId:string|null){
  const scope=permissionScope(req,code);
  if(!scope||!canAccessResource(authorization(req),scope,{tenantId:req.user!.tenantId,siteId})){
    throw Object.assign(new Error('Unzureichende Berechtigungen für diesen Schlüsselbereich'),{status:403});
  }
}
function keyPermissionAny(req:Request,codes:string[],siteId:string|null){
  for(const code of codes){
    try{keyPermission(req,code,siteId);return code;}catch{/* try the alias */}
  }
  throw Object.assign(new Error('Unzureichende Berechtigungen für diesen Schlüsselbereich'),{status:403});
}
function requireAnyPermission(...codes:string[]){
  return (req:Request,res:import('express').Response,next:import('express').NextFunction)=>{
    const context=authorization(req);
    return codes.some(code=>canUsePermission(context,code,['tenant','site','system']))?next():res.status(403).json({error:'Unzureichende Berechtigungen'});
  };
}
function operator(req:Request){return req.user!.role==='admin'||req.user!.role==='operator'||req.user!.isSystemAdmin===true;}
function notify(tenantId:string,eventType:string,eventKey:string,title:string,body:string,entityId:string){void Promise.resolve(queueNotificationEvent(tenantId,eventType,eventKey,title,body,'key',entityId)).catch(()=>undefined);}
function setPageHeaders(res:import('express').Response,total:number,page:number,pageSize:number){
  res.set('X-Total-Count',String(total));res.set('X-Page',String(page));res.set('X-Page-Size',String(pageSize));res.set('X-Page-Count',String(Math.max(1,Math.ceil(total/pageSize))));
}
function parseQuery<S extends z.ZodObject<z.ZodRawShape>>(req:Request,schema:S):z.infer<S>{
  const raw:Record<string,unknown>={};
  for(const key of Object.keys(schema.shape)){const value=req.query[key];if(typeof value==='string'&&value.trim()!=='')raw[key]=value;}
  return schema.parse(raw) as z.infer<S>;
}
function badRequest(res:import('express').Response){return res.status(400).json({error:'Ungültige Schlüsselanfrage'});}
async function documentForReceipt(client:Client,tenantId:string,siteId:string|null,documentId:string|null|undefined){
  if(!documentId)return null;
  const document=(await client.query('SELECT id,site_id FROM dms_documents WHERE tenant_id=$1 AND id=$2',[tenantId,documentId])).rows[0];
  if(!document||document.site_id!==siteId)throw Object.assign(new Error('Belegdokument muss zum selben Mandanten und Objekt gehören'),{status:409,code:'KEY_RECEIPT_SITE_MISMATCH'});
  return documentId;
}
async function holderForIssue(client:Client,tenantId:string,holderUserId:string|null|undefined,holderEmployeeId:string|null|undefined){
  if(!holderIsValid(holderUserId,holderEmployeeId))throw Object.assign(new Error('Genau ein gültiger Halter ist erforderlich'),{status:400});
  if(holderUserId&&!(await client.query('SELECT id FROM users WHERE tenant_id=$1 AND id=$2',[tenantId,holderUserId])).rowCount)throw Object.assign(new Error('Halterbenutzer nicht gefunden'),{status:404});
  if(holderEmployeeId&&!(await client.query('SELECT id FROM employees WHERE tenant_id=$1 AND id=$2',[tenantId,holderEmployeeId])).rowCount)throw Object.assign(new Error('Haltermitarbeiter nicht gefunden'),{status:404});
  return {holderUserId:holderUserId??null,holderEmployeeId:holderEmployeeId??null};
}

const sortFields=['key_code','label','key_type','status','site_name','holder_name','issued_at','due_at','last_movement_at','created_at'] as const;
const listQuerySchema=z.object({
  q:z.string().trim().max(200).optional(),status:z.enum(keyStatuses).optional(),key_type:z.enum(keyTypes).optional(),
  site_id:uuid.optional(),holder_user_id:uuid.optional(),holder_employee_id:uuid.optional(),bundle_id:uuid.optional(),
  location:z.string().trim().max(160).optional(),sort:z.enum(sortFields).default('key_code'),dir:z.enum(['asc','desc']).default('asc'),
  page:z.coerce.number().int().min(1).max(100000).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(10),
});
type KeyFilters=z.infer<typeof listQuerySchema>;
const pickerQuerySchema=listQuerySchema.extend({
  exclude_bundle_id:uuid.optional(),
  // Opaque offset cursor. Pages are bounded; the result set itself is not.
  cursor:z.string().regex(/^\d{1,9}$/).default('0'),
  pageSize:z.coerce.number().int().min(1).max(200).default(100),
});
const exportQuerySchema=listQuerySchema.extend({
  full:z.enum(['true','false']).default('false').transform(value=>value==='true'),
});
const exportDefaultLimit=10000;
const exportBatchSize=1000;
const orderExpressions:Record<typeof sortFields[number],string>={
  key_code:'lower(k.key_code)',label:'lower(k.label)',key_type:'k.key_type',status:derivedStatusSql,
  site_name:'lower(s.name)',holder_name:'lower(COALESCE(hu.email,he.name))',issued_at:'k.issued_at',
  due_at:'k.due_at',last_movement_at:'lm.created_at',created_at:'k.created_at',
};
function keyListQuery(req:Request,filters:KeyFilters,codes:string[],options:{limit?:number;offset?:number;ids?:string[];excludeBundleId?:string}={}){
  const tenantId=req.user!.tenantId;
  const values:unknown[]=[tenantId];
  const conditions=['k.tenant_id=$1'];
  const add=(fragment:string,value:unknown)=>{values.push(value);return fragment.replaceAll('$P',`$${values.length}`);};
  for(const code of codes){
    const scope=permissionScope(req,code);
    if(scope==='site'){values.push(req.user!.siteIds??[]);conditions.push(`k.site_id=ANY($${values.length}::uuid[])`);break;}
    if(scope)break;
  }
  if(filters.q){const escaped=filters.q.replace(/[\\%_]/g,'\\$&');conditions.push(add(`(k.key_code ILIKE $P ESCAPE '\\' OR k.label ILIKE $P ESCAPE '\\' OR k.serial_number ILIKE $P ESCAPE '\\' OR k.location ILIKE $P ESCAPE '\\' OR k.description ILIKE $P ESCAPE '\\')`,`%${escaped}%`));}
  if(filters.status)conditions.push(add(`(${derivedStatusSql})=$P`,filters.status));
  if(filters.key_type)conditions.push(add('k.key_type=$P',filters.key_type));
  if(filters.site_id)conditions.push(add('k.site_id=$P',filters.site_id));
  if(filters.holder_user_id)conditions.push(add('k.holder_user_id=$P',filters.holder_user_id));
  if(filters.holder_employee_id)conditions.push(add('k.holder_employee_id=$P',filters.holder_employee_id));
  if(filters.location)conditions.push(add("k.location ILIKE $P ESCAPE '\\'",`%${filters.location.replace(/[\\%_]/g,'\\$&')}%`));
  if(filters.bundle_id)conditions.push(add('EXISTS (SELECT 1 FROM key_bundle_items i WHERE i.tenant_id=k.tenant_id AND i.key_id=k.id AND i.bundle_id=$P)',filters.bundle_id));
  if(options.ids?.length)conditions.push(add('k.id=ANY($P::uuid[])',options.ids));
  if(options.excludeBundleId)conditions.push(add('NOT EXISTS (SELECT 1 FROM key_bundle_items i WHERE i.tenant_id=k.tenant_id AND i.key_id=k.id AND i.bundle_id=$P)',options.excludeBundleId));
  const limitIndex=values.length+1;const offsetIndex=values.length+2;
  values.push(options.limit??filters.pageSize,options.offset??(filters.page-1)*filters.pageSize);
  const direction=filters.dir.toUpperCase();
  const sql=`WITH latest_movement AS (
      SELECT DISTINCT ON (tenant_id,key_id) tenant_id,key_id,movement_type,created_at
      FROM key_movements WHERE tenant_id=$1 ORDER BY tenant_id,key_id,created_at DESC,id DESC
    )
    SELECT k.id,k.site_id,k.key_code,k.label,k.key_type,k.serial_number,k.manufacturer,k.location,k.building,k.area,
      k.access_point,k.description,k.remarks,k.responsible_employee_id,re.name responsible_name,
      ${derivedStatusSql} AS status,k.holder_user_id,k.holder_employee_id,
      COALESCE(hu.email,he.name) holder_name,he.employee_number holder_personnel_number,he.employment_status holder_status,
      k.due_at,k.issued_at,k.returned_at,k.lost_at,k.deactivated_at,k.created_at,k.updated_at,
      lm.created_at last_movement_at,lm.movement_type last_movement_type,
      (SELECT i.bundle_id FROM key_bundle_items i WHERE i.tenant_id=k.tenant_id AND i.key_id=k.id LIMIT 1) bundle_id,
      b.name bundle_name,s.name site_name,COUNT(*) OVER()::int total_count
    FROM keys k
    LEFT JOIN sites s ON s.tenant_id=k.tenant_id AND s.id=k.site_id
    LEFT JOIN users hu ON hu.tenant_id=k.tenant_id AND hu.id=k.holder_user_id
    LEFT JOIN employees he ON he.tenant_id=k.tenant_id AND he.id=k.holder_employee_id
    LEFT JOIN employees re ON re.tenant_id=k.tenant_id AND re.id=k.responsible_employee_id
    LEFT JOIN latest_movement lm ON lm.tenant_id=k.tenant_id AND lm.key_id=k.id
    LEFT JOIN key_bundle_items bi ON bi.tenant_id=k.tenant_id AND bi.key_id=k.id
    LEFT JOIN key_bundles b ON b.tenant_id=k.tenant_id AND b.id=bi.bundle_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY ${orderExpressions[filters.sort]} ${direction},k.id ${direction}
    LIMIT $${limitIndex} OFFSET $${offsetIndex}`;
  return {sql,values};
}

export const keysRouter=Router();
keysRouter.use((req,res,next)=>/^\/(?:keys|key-bundles)/.test(req.path)?requireAuth(req,res,()=>['POST','PATCH','PUT','DELETE'].includes(req.method)?requireCsrf(req,res,next):next()):next());

keysRouter.get('/keys',requirePermission('keys:read',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const filters=parseQuery(req,listQuerySchema);
    const {sql,values}=keyListQuery(req,filters,['keys:read']);
    const result=await query(sql,values);
    const total=result.rows[0]?.total_count??result.rows.length;
    setPageHeaders(res,total,filters.page,filters.pageSize);
    res.json(result.rows);
  }catch(error){if(error instanceof z.ZodError)return badRequest(res);next(error);}
});

// Server-side search for pickers. Every page applies tenant/RBAC filters in SQL;
// clients follow next_cursor until it is null instead of relying on a hard cap.
keysRouter.get('/keys/picker',requirePermission('keys:read',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const filters=parseQuery(req,pickerQuerySchema);
    const offset=Number(filters.cursor);
    const {sql,values}=keyListQuery(req,filters,['keys:read'],{limit:filters.pageSize,offset,excludeBundleId:filters.exclude_bundle_id});
    const result=await query(sql,values);
    const total=result.rows[0]?.total_count??result.rows.length;
    const nextOffset=offset+result.rows.length;
    const nextCursor=result.rows.length>0&&nextOffset<total?String(nextOffset):null;
    setPageHeaders(res,total,Math.floor(offset/filters.pageSize)+1,filters.pageSize);
    res.set('X-Cursor',String(offset));
    if(nextCursor)res.set('X-Next-Cursor',nextCursor);
    res.json({items:result.rows,total,page_size:filters.pageSize,next_cursor:nextCursor});
  }catch(error){if(error instanceof z.ZodError)return badRequest(res);next(error);}
});

keysRouter.get('/keys/dashboard',requirePermission('keys:read',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const scope=permissionScope(req,'keys:read');
    const siteIds=scope==='site'?(req.user!.siteIds??[]):[];
    const siteCondition=scope==='site'?' AND k.site_id=ANY($2::uuid[])':'';
    const values=scope==='site'?[req.user!.tenantId,siteIds]:[req.user!.tenantId];
    const [counts,movements,bundleCounts]=await Promise.all([
      query(`SELECT COUNT(*)::int total,
        COUNT(*) FILTER(WHERE k.status='available')::int available,
        COUNT(*) FILTER(WHERE k.status='issued')::int issued,
        COUNT(*) FILTER(WHERE (${derivedStatusSql})='overdue')::int overdue,
        COUNT(*) FILTER(WHERE k.status='lost')::int lost,
        COUNT(*) FILTER(WHERE k.status='blocked')::int blocked,
        COUNT(DISTINCT k.id) FILTER(WHERE ${criticalKeySql})::int critical_count,
        COUNT(*) FILTER(WHERE k.status='deactivated')::int deactivated,
        COUNT(*) FILTER(WHERE k.site_id IS NULL)::int without_site,
        COUNT(*) FILTER(WHERE k.holder_user_id IS NULL AND k.holder_employee_id IS NULL)::int without_holder,
        COUNT(*) FILTER(WHERE k.due_at>=now() AND k.due_at<now()+INTERVAL '24 hours')::int due_today,
        COUNT(*) FILTER(WHERE k.due_at>=now() AND k.due_at<now()+INTERVAL '7 days')::int due_7_days,
        COUNT(*) FILTER(WHERE k.due_at>=now() AND k.due_at<now()+INTERVAL '30 days')::int due_30_days
        FROM keys k WHERE k.tenant_id=$1${siteCondition}`,values),
      query(`SELECT m.id,m.key_id,m.movement_type,m.created_at,k.label key_label,k.key_code
        FROM key_movements m JOIN keys k ON k.tenant_id=m.tenant_id AND k.id=m.key_id
        WHERE m.tenant_id=$1${siteCondition} ORDER BY m.created_at DESC,m.id DESC LIMIT 8`,values),
      scope==='site'?query(`SELECT COUNT(*)::int partial_bundles FROM key_bundles b WHERE b.tenant_id=$1 AND b.site_id=ANY($2::uuid[]) AND b.status='partial'`,values)
        :query("SELECT COUNT(*)::int partial_bundles FROM key_bundles b WHERE b.tenant_id=$1 AND b.status='partial'",[req.user!.tenantId]),
    ]);
    res.json({...counts.rows[0],partial_bundles:bundleCounts.rows[0]?.partial_bundles??0,recent_movements:movements.rows});
  }catch(error){next(error);}
});

type ActionEntry={id:string;bucket:'A'|'B'|'C';code:string;label:string;key_id:string;key_code:string;site_id:string|null;site_name:string|null;subject_type:string;subject_id:string|null;due_at:string|null;url:string;target:string};
type ActionBuckets={A:ActionEntry[];B:ActionEntry[];C:ActionEntry[]};
// The database ranks and caps candidates per bucket; Node only maps the display rows.
const actionDisplayLimits={A:50,B:50,C:50} as const;
async function keyActions(req:Request):Promise<ActionBuckets&{totals:Record<'A'|'B'|'C',number>;generated_at:string}>{
  const tenantId=req.user!.tenantId;
  const scope=permissionScope(req,'keys:read');
  const keyScope=scope==='site'?' AND k.site_id=ANY($2::uuid[])':'';
  const bundleScope=scope==='site'?' AND b.site_id=ANY($2::uuid[])':'';
  const values=scope==='site'?[tenantId,req.user!.siteIds??[]]:[tenantId];
  // Candidates are derived in SQL from the live state instead of slicing the newest
  // keys/movements first. That keeps old but still open A/B cases visible and makes
  // ordering deterministic across pages and reloads.
  const candidates=(await query(`
    WITH candidates AS (
      SELECT 'A'::text bucket,5 severity,'critical_loss_report' code,
        'Verlustmeldung prüfen: '||k.label label,k.id key_id,k.key_code,k.site_id,s.name site_name,
        'loss_report' subject_type,l.id subject_id,NULL::timestamptz due_at,l.created_at sort_at,true history
      FROM key_loss_reports l JOIN keys k ON k.tenant_id=l.tenant_id AND k.id=l.key_id
      LEFT JOIN sites s ON s.tenant_id=k.tenant_id AND s.id=k.site_id
      WHERE l.tenant_id=$1${keyScope} AND l.status IN ('review','security_measure_required','replacement_required')
      UNION ALL
      SELECT 'A',10,'key_lost','Schlüssel verloren: '||k.label,k.id,k.key_code,k.site_id,s.name,
        'loss_report',NULL::uuid,NULL::timestamptz,k.created_at,false
      FROM keys k LEFT JOIN sites s ON s.tenant_id=k.tenant_id AND s.id=k.site_id
      WHERE k.tenant_id=$1${keyScope} AND k.status='lost'
      UNION ALL
      SELECT 'A',20,'return_overdue','Überfällige Rückgabe: '||k.label,k.id,k.key_code,k.site_id,s.name,
        'due',NULL::uuid,k.due_at,k.due_at,false
      FROM keys k LEFT JOIN sites s ON s.tenant_id=k.tenant_id AND s.id=k.site_id
      WHERE k.tenant_id=$1${keyScope} AND (${derivedStatusSql})='overdue'
      UNION ALL
      SELECT 'A',30,'missing_holder','Ausgegebener Schlüssel ohne Halter: '||k.label,k.id,k.key_code,k.site_id,s.name,
        'holder',NULL::uuid,NULL::timestamptz,k.issued_at,false
      FROM keys k LEFT JOIN sites s ON s.tenant_id=k.tenant_id AND s.id=k.site_id
      WHERE k.tenant_id=$1${keyScope} AND k.status='issued' AND k.holder_user_id IS NULL AND k.holder_employee_id IS NULL
      UNION ALL
      SELECT 'A',40,'untraceable_movement','Bewegung ohne Halter: '||k.label,k.id,k.key_code,k.site_id,s.name,
        'movement',m.id,NULL::timestamptz,m.created_at,true
      FROM key_movements m JOIN keys k ON k.tenant_id=m.tenant_id AND k.id=m.key_id
      LEFT JOIN sites s ON s.tenant_id=k.tenant_id AND s.id=k.site_id
      WHERE m.tenant_id=$1${keyScope} AND m.movement_type IN ('issued','lost')
        AND m.holder_user_id IS NULL AND m.holder_employee_id IS NULL
      UNION ALL
      SELECT 'B',10,'return_due_7','Rückgabe in 7 Tagen: '||k.label,k.id,k.key_code,k.site_id,s.name,
        'due',NULL::uuid,k.due_at,k.due_at,false
      FROM keys k LEFT JOIN sites s ON s.tenant_id=k.tenant_id AND s.id=k.site_id
      WHERE k.tenant_id=$1${keyScope} AND k.due_at>=now() AND k.due_at<now()+INTERVAL '7 days'
      UNION ALL
      SELECT 'B',20,'return_due_30','Rückgabe in 30 Tagen: '||k.label,k.id,k.key_code,k.site_id,s.name,
        'due',NULL::uuid,k.due_at,k.due_at,false
      FROM keys k LEFT JOIN sites s ON s.tenant_id=k.tenant_id AND s.id=k.site_id
      WHERE k.tenant_id=$1${keyScope} AND k.due_at>=now()+INTERVAL '7 days' AND k.due_at<now()+INTERVAL '30 days'
      UNION ALL
      SELECT 'B',30,'incomplete_master_data','Stammdaten unvollständig: '||k.label,k.id,k.key_code,k.site_id,s.name,
        'master_data',NULL::uuid,NULL::timestamptz,k.updated_at,false
      FROM keys k LEFT JOIN sites s ON s.tenant_id=k.tenant_id AND s.id=k.site_id
      WHERE k.tenant_id=$1${keyScope}
        AND (k.site_id IS NULL OR (k.location IS NULL AND k.building IS NULL AND k.area IS NULL))
      UNION ALL
      SELECT 'B',40,'partial_bundle_return','Teilweise zurückgegebenes Bündel: '||b.name,
        item.key_id,item.key_code,b.site_id,s.name,'bundle',b.id,NULL::timestamptz,b.updated_at,false
      FROM key_bundles b LEFT JOIN sites s ON s.tenant_id=b.tenant_id AND s.id=b.site_id
      CROSS JOIN LATERAL (
        SELECT i.key_id,k.key_code FROM key_bundle_items i JOIN keys k ON k.tenant_id=i.tenant_id AND k.id=i.key_id
        WHERE i.tenant_id=b.tenant_id AND i.bundle_id=b.id ORDER BY k.key_code LIMIT 1
      ) item
      WHERE b.tenant_id=$1${bundleScope} AND b.status='partial'
      UNION ALL
      SELECT 'B',50,'handover_confirmation','Übergabe bestätigen: '||k.label,k.id,k.key_code,k.site_id,s.name,
        'receipt',m.id,NULL::timestamptz,m.created_at,false
      FROM key_movements m JOIN keys k ON k.tenant_id=m.tenant_id AND k.id=m.key_id
      LEFT JOIN sites s ON s.tenant_id=k.tenant_id AND s.id=k.site_id
      WHERE m.tenant_id=$1${keyScope} AND m.movement_type='issued'
        AND NOT EXISTS (SELECT 1 FROM key_receipts r WHERE r.tenant_id=m.tenant_id AND r.key_id=m.key_id
          AND r.kind='issue' AND r.created_at BETWEEN m.created_at-INTERVAL '5 minutes' AND m.created_at+INTERVAL '5 minutes')
      UNION ALL
      SELECT 'C',10,'key_created','Neu angelegter Schlüssel: '||k.label,k.id,k.key_code,k.site_id,s.name,
        'key',NULL::uuid,NULL::timestamptz,k.created_at,false
      FROM keys k LEFT JOIN sites s ON s.tenant_id=k.tenant_id AND s.id=k.site_id
      WHERE k.tenant_id=$1${keyScope} AND k.created_at>=now()-INTERVAL '14 days'
      UNION ALL
      SELECT 'C',20,'recent_return','Kürzlich zurückgegeben: '||k.label,k.id,k.key_code,k.site_id,s.name,
        'movement',m.id,NULL::timestamptz,m.created_at,true
      FROM key_movements m JOIN keys k ON k.tenant_id=m.tenant_id AND k.id=m.key_id
      LEFT JOIN sites s ON s.tenant_id=k.tenant_id AND s.id=k.site_id
      WHERE m.tenant_id=$1${keyScope} AND m.movement_type='returned' AND m.created_at>=now()-INTERVAL '30 days'
      UNION ALL
      SELECT 'C',30,'stock_change','Bestandsänderung: '||k.label,k.id,k.key_code,k.site_id,s.name,
        'movement',m.id,NULL::timestamptz,m.created_at,true
      FROM key_movements m JOIN keys k ON k.tenant_id=m.tenant_id AND k.id=m.key_id
      LEFT JOIN sites s ON s.tenant_id=k.tenant_id AND s.id=k.site_id
      WHERE m.tenant_id=$1${keyScope} AND m.movement_type IN ('created','blocked','reactivated')
        AND m.created_at>=now()-INTERVAL '30 days'
    ),
    marked AS (
      SELECT c.*,(c.code||':'||coalesce(c.subject_id::text,c.key_id::text)) dedupe_key FROM candidates c
    ),
    deduped AS (
      SELECT DISTINCT ON (bucket,dedupe_key) bucket,severity,code,label,key_id,key_code,site_id,site_name,
        subject_type,subject_id,due_at,sort_at,history,dedupe_key
      FROM marked
      ORDER BY bucket,dedupe_key,severity,due_at ASC NULLS LAST,sort_at DESC,key_id,code,subject_id
    ),
    ranked AS (
      SELECT d.*,
        ROW_NUMBER() OVER (PARTITION BY bucket ORDER BY severity,due_at ASC NULLS LAST,sort_at DESC,key_id,code,subject_id) display_rank,
        COUNT(*) OVER (PARTITION BY bucket)::int bucket_total
      FROM deduped d
    )
    SELECT bucket,severity,code,label,key_id,key_code,site_id,site_name,subject_type,subject_id,due_at,sort_at,history,bucket_total
    FROM ranked WHERE display_rank<=$${values.length+1}
    ORDER BY bucket,display_rank
  `,[...values,Math.max(...Object.values(actionDisplayLimits))])).rows as Row[];
  const buckets:ActionBuckets={A:[],B:[],C:[]};
  const totals:Record<'A'|'B'|'C',number>={A:0,B:0,C:0};
  for(const row of candidates){
    const bucket=row.bucket as 'A'|'B'|'C';
    if(bucket!=='A'&&bucket!=='B'&&bucket!=='C')continue;
    const url=`/keys/${row.key_id}${row.history?'/historie':''}`;
    const entry:ActionEntry={id:`${row.code}:${row.subject_id??row.key_id}`,bucket,code:row.code,label:row.label,
      key_id:row.key_id,key_code:row.key_code,site_id:row.site_id??null,site_name:row.site_name??null,
      subject_type:row.subject_type,subject_id:row.subject_id??null,due_at:row.due_at??null,url,target:url};
    // bucket_total is computed before the display-rank filter, so totals stay complete.
    totals[bucket]=Math.max(totals[bucket],Number(row.bucket_total)||0);
    buckets[bucket].push(entry);
  }
  return {...buckets,totals,generated_at:new Date().toISOString()};
}

keysRouter.get('/keys/action-list',requirePermission('keys:read',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{res.json(await keyActions(req));}catch(error){next(error);}
});

// Spreadsheet applications execute cells starting with these characters as
// formulas. Prefixing them with an apostrophe keeps the visible value intact
// while preventing CSV injection.
const csvCell=(value:unknown)=>{
  const text=String(value??'');
  const safe=/^[=+\-@\t\r]/.test(text)?`'${text}`:text;
  return `"${safe.split('"').join('""')}"`;
};
keysRouter.get('/keys/export',requirePermission('keys:export',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  let exportQueried=false;
  let exportAborted=false;
  let exportCount=0;
  let exportTotal=0;
  let exportTruncated=false;
  // A client disconnect can fire after all bytes were handed to the kernel, so
  // res.writableFinished alone is not enough to distinguish abort from success.
  const onClientClose=()=>{if(req.aborted||!req.complete||!res.writableFinished)exportAborted=true;};
  const detachClientClose=()=>{res.off('close',onClientClose);req.off('aborted',onClientClose);};
  req.once('aborted',onClientClose);
  res.on('close',onClientClose);
  try{
    const filters=parseQuery(req,exportQuerySchema);
    const rawIds=typeof req.query.ids==='string'?req.query.ids.split(',').filter(Boolean):[];
    const ids=z.array(uuid).max(100).parse(rawIds);
    const columns:[string,(row:Row)=>unknown][]=[
      ['Schlüsselnummer',row=>row.key_code],['Bezeichnung',row=>row.label],['Schlüsseltyp',row=>row.key_type],
      ['Status',row=>row.status],['Objekt',row=>row.site_name],['Standort',row=>row.location],['Gebäude',row=>row.building],
      ['Bereich',row=>row.area],['Zugangspunkt',row=>row.access_point],['Seriennummer',row=>row.serial_number],
      ['Hersteller',row=>row.manufacturer],['Halter',row=>row.holder_name],['Personalnummer',row=>row.holder_personnel_number],
      ['Verantwortlich',row=>row.responsible_name],['Fällig am',row=>row.due_at],['Ausgegeben am',row=>row.issued_at],
      ['Zurückgegeben am',row=>row.returned_at],['Bündel',row=>row.bundle_name],['Letzte Bewegung',row=>row.last_movement_at],
      ['Angelegt am',row=>row.created_at],
    ];
    // The default export is still capped; full=true streams every matching row.
    const cap=ids.length?ids.length:(filters.full?Number.MAX_SAFE_INTEGER:exportDefaultLimit);
    const fetchBatch=async(offset:number,limit:number):Promise<Row[]>=>{
      const {sql,values}=keyListQuery(req,{...filters,page:1},['keys:export'],
        ids.length?{limit,offset,ids}:{limit,offset});
      exportQueried=true;
      const result=await query(sql,values);
      exportTotal=result.rows[0]?.total_count??result.rows.length;
      return result.rows as Row[];
    };
    const writeChunk=(chunk:string)=>new Promise<void>((resolve,reject)=>{
      if(res.destroyed||exportAborted){exportAborted=true;return resolve();}
      if(res.write(chunk))return resolve();
      let settled=false;
      const cleanup=()=>{res.off('drain',onDrain);res.off('close',onClose);res.off('error',onError);};
      const onDrain=()=>{if(settled)return;settled=true;cleanup();resolve();};
      const onClose=()=>{if(settled)return;settled=true;cleanup();if(req.aborted||!req.complete||!res.writableFinished)exportAborted=true;resolve();};
      const onError=(error:Error)=>{if(settled)return;settled=true;cleanup();reject(error);};
      res.once('drain',onDrain);res.once('close',onClose);res.once('error',onError);
    });
    const firstBatch=await fetchBatch(0,Math.min(exportBatchSize,cap));
    exportTruncated=exportTotal>cap;
    const planned=Math.min(cap,exportTotal);
    res.set('Content-Disposition','attachment; filename="schluessel.csv"');
    res.set('X-Key-Export-Count',String(planned));
    res.set('X-Key-Export-Total',String(exportTotal));
    res.set('X-Key-Export-Truncated',String(exportTruncated));
    res.status(200).type('text/csv; charset=utf-8');
    const notice=exportTruncated?csvCell(`# Hinweis: Export auf ${planned} von ${exportTotal} Treffern begrenzt. Für den vollständigen Export full=true verwenden.`):'';
    const headerLines=[...(notice?[notice]:[]),columns.map(([label])=>csvCell(label)).join(';')].join('\r\n');
    await writeChunk(`\ufeff${headerLines}\r\n`);
    let batch=firstBatch;
    for(let offset=0;offset<cap&&!exportAborted;offset+=exportBatchSize){
      if(offset>0)batch=await fetchBatch(offset,Math.min(exportBatchSize,cap-offset));
      if(!batch.length)break;
      // One bounded batch at a time: no full CSV string or complete row array in memory.
      await writeChunk(`${batch.map(row=>columns.map(([,get])=>csvCell(get(row))).join(';')).join('\r\n')}\r\n`);
      exportCount+=batch.length;
      if(offset+batch.length>=exportTotal)break;
      if(batch.length<Math.min(exportBatchSize,cap-offset))break;
    }
    await recordAudit(req.user!.tenantId,req.user!.id,'keys.exported','key',undefined,
      {count:exportCount,total:exportTotal,selected:ids.length>0,truncated:exportTruncated,full:filters.full,aborted:exportAborted});
    detachClientClose();
    if(!res.destroyed)res.end();
  }catch(error){
    detachClientClose();
    if(error instanceof z.ZodError)return badRequest(res);
    if(exportQueried){
      try{await recordAudit(req.user!.tenantId,req.user!.id,'keys.exported','key',undefined,
        {count:exportCount,total:exportTotal,selected:false,truncated:exportTruncated,full:false,error:true});}catch{}
    }
    // Headers may already be on the wire: close the response cleanly instead of
    // throwing after a partial stream.
    if(res.headersSent||exportAborted){if(!res.destroyed)res.end();return;}
    next(error);
  }
});

const createBody=z.object({
  key_code:z.string().trim().min(1).max(120),label:z.string().trim().min(1).max(160),key_type:z.enum(keyTypes).default('physical'),
  site_id:uuid.nullable().optional(),serial_number:text(120),manufacturer:text(160),location:text(160),building:text(160),
  area:text(160),access_point:text(160),description:text(2000),remarks:text(2000),responsible_employee_id:uuid.nullable().optional(),
  client_mutation_id:uuid,
}).strict();
keysRouter.post('/keys',requireAnyPermission('keys:write','keys:create'),async(req,res,next)=>{
  try{
    const body=createBody.parse(req.body);
    keyPermissionAny(req,['keys:write','keys:create'],body.site_id??null);
    const result=await withTransaction(client=>runIdempotentMutation(client,{tenantId:req.user!.tenantId,userId:req.user!.id,mutationId:body.client_mutation_id,action:'keys.create',payload:req.body},async tx=>{
      if(body.responsible_employee_id&&!(await tx.query('SELECT id FROM employees WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,body.responsible_employee_id])).rowCount)throw Object.assign(new Error('Verantwortlicher Mitarbeiter nicht gefunden'),{status:404});
      const row=(await tx.query(`INSERT INTO keys(tenant_id,site_id,key_code,label,key_type,serial_number,manufacturer,location,building,area,access_point,description,remarks,responsible_employee_id,created_by,created_session_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
        [req.user!.tenantId,body.site_id??null,body.key_code,body.label,body.key_type,body.serial_number??null,body.manufacturer??null,body.location??null,
          body.building??null,body.area??null,body.access_point??null,body.description??null,body.remarks??null,body.responsible_employee_id??null,req.user!.id,session(req)])).rows[0];
      await tx.query("INSERT INTO key_movements(tenant_id,key_id,movement_type,to_status,actor_user_id,session_id,device_id) VALUES($1,$2,'created','available',$3,$4,(SELECT device_id FROM sessions WHERE tenant_id=$1 AND id=$4))",
        [req.user!.tenantId,row.id,req.user!.id,session(req)]);
      await recordAudit(req.user!.tenantId,req.user!.id,'keys.created','key',row.id,{site_id:row.site_id,key_type:row.key_type},tx);
      return row;
    }));
    res.status(result.replayed?200:201).json(result.response);
  }catch(error){if(error instanceof z.ZodError)return badRequest(res);next(error);}
});

const inventoryBody=z.object({
  site_id:uuid.nullable().optional(),bundle_id:uuid.nullable().optional(),checked_at:z.string().datetime({offset:true}),
  checker_name:z.string().trim().min(1).max(160),notes:text(2000),
  results:z.array(z.object({key_id:uuid,expected_present:z.boolean(),actual_condition:z.enum(returnConditions).nullable().optional()})).min(1).max(100),
  client_mutation_id:uuid,
}).strict();
keysRouter.post('/keys/inventory-checks',requirePermission('keys:inventory:write',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const body=inventoryBody.parse(req.body);
    if(body.site_id)keyPermission(req,'keys:inventory:write',body.site_id);
    if(body.bundle_id){
      const bundle=(await query('SELECT site_id FROM key_bundles WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,body.bundle_id])).rows[0] as Row|undefined;
      if(!bundle)return res.status(404).json({error:'Schlüsselbund nicht gefunden'});
      keyPermission(req,'keys:inventory:write',bundle.site_id??null);
    }
    const result=await withTransaction(client=>runIdempotentMutation(client,{tenantId:req.user!.tenantId,userId:req.user!.id,mutationId:body.client_mutation_id,action:'keys.inventory.check',payload:req.body},async tx=>{
      const keys=(await tx.query('SELECT id,site_id FROM keys WHERE tenant_id=$1 AND id=ANY($2::uuid[])',[req.user!.tenantId,body.results.map(item=>item.key_id)])).rows as Row[];
      if(keys.length!==new Set(body.results.map(item=>item.key_id)).size)throw Object.assign(new Error('Jeder geprüfte Schlüssel muss zum Mandanten gehören'),{status:404});
      if(body.site_id&&keys.some(key=>key.site_id!==body.site_id))throw Object.assign(new Error('Geprüfte Schlüssel müssen zum angegebenen Objekt gehören'),{status:400});
      if(body.bundle_id){
        const members=(await tx.query('SELECT key_id FROM key_bundle_items WHERE tenant_id=$1 AND bundle_id=$2',[req.user!.tenantId,body.bundle_id])).rows as Row[];
        const memberIds=new Set(members.map(row=>row.key_id));
        if(body.results.some(item=>!memberIds.has(item.key_id)))throw Object.assign(new Error('Geprüfte Schlüssel müssen zum angegebenen Schlüsselbund gehören'),{status:400});
      }
      const check=(await tx.query(`INSERT INTO key_inventory_checks(tenant_id,site_id,bundle_id,checked_at,checker_name,notes,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [req.user!.tenantId,body.site_id??null,body.bundle_id??null,body.checked_at,body.checker_name,body.notes??null,req.user!.id])).rows[0];
      for(const item of body.results){
        const found=item.actual_condition!==null&&item.actual_condition!==undefined;
        await tx.query(`INSERT INTO key_inventory_check_items(tenant_id,check_id,key_id,expected_present,found,actual_condition)
          VALUES($1,$2,$3,$4,$5,$6)`,[req.user!.tenantId,check.id,item.key_id,item.expected_present,found,item.actual_condition??null]);
      }
      const byKey=new Map(body.results.map(item=>[item.key_id,item]));
      const mismatches=keys.filter(key=>{
        const item=byKey.get(key.id)!;const found=item.actual_condition!==null&&item.actual_condition!==undefined;
        return item.expected_present!==found||found&&item.actual_condition!=='good';
      }).length;
      await recordAudit(req.user!.tenantId,req.user!.id,'keys.inventory.check','key_inventory_check',check.id,{site_id:check.site_id,bundle_id:check.bundle_id,count:body.results.length,mismatches},tx);
      return {check,items:body.results.map(item=>({...item,found:item.actual_condition!==null&&item.actual_condition!==undefined})),mismatches};
    }));
    res.status(result.replayed?200:201).json(result.response);
  }catch(error){if(error instanceof z.ZodError)return badRequest(res);next(error);}
});
keysRouter.get('/keys/inventory-checks',requirePermission('keys:inventory:read',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const inventoryQuery=z.object({site_id:uuid.optional(),bundle_id:uuid.optional(),page:z.coerce.number().int().min(1).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(10)});
    const filters=parseQuery(req,inventoryQuery);
    const scope=permissionScope(req,'keys:inventory:read');
    const values:unknown[]=[req.user!.tenantId];
    const conditions=['c.tenant_id=$1'];
    const add=(fragment:string,value:unknown)=>{values.push(value);return fragment.replaceAll('$P',`$${values.length}`);};
    if(scope==='site'){values.push(req.user!.siteIds??[]);conditions.push(`c.site_id=ANY($${values.length}::uuid[])`);}
    if(filters.site_id)conditions.push(add('c.site_id=$P',filters.site_id));
    if(filters.bundle_id)conditions.push(add('c.bundle_id=$P',filters.bundle_id));
    const result=await query(`SELECT c.*,COALESCE(json_agg(json_build_object('key_id',i.key_id,'expected_present',i.expected_present,'found',i.found,'actual_condition',i.actual_condition)) FILTER (WHERE i.key_id IS NOT NULL),'[]') items,COUNT(*) OVER()::int total_count
      FROM key_inventory_checks c LEFT JOIN key_inventory_check_items i ON i.tenant_id=c.tenant_id AND i.check_id=c.id
      WHERE ${conditions.join(' AND ')} GROUP BY c.id ORDER BY c.checked_at DESC LIMIT $${values.length+1} OFFSET $${values.length+2}`,
      [...values,filters.pageSize,(filters.page-1)*filters.pageSize]);
    setPageHeaders(res,result.rows[0]?.total_count??result.rows.length,filters.page,filters.pageSize);
    res.json(result.rows);
  }catch(error){if(error instanceof z.ZodError)return badRequest(res);next(error);}
});

async function readKey(client:QueryLike,req:Request,codes:string[]){
  const key=(await client.query('SELECT * FROM keys WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,String(req.params.id)])).rows[0] as Row|undefined;
  if(!key)throw Object.assign(new Error('Schlüssel nicht gefunden'),{status:404});
  keyPermissionAny(req,codes,key.site_id??null);
  return key;
}

keysRouter.get('/keys/:id',requirePermission('keys:read',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const key=await readKey({query},req,['keys:read']);
    const detail=(await query(`SELECT k.*,${derivedStatusSql} display_status,s.name site_name,
        COALESCE(hu.email,he.name) holder_name,he.employee_number holder_personnel_number,he.employment_status holder_status,
        b.id bundle_id,b.name bundle_name,re.name responsible_name
      FROM keys k LEFT JOIN sites s ON s.tenant_id=k.tenant_id AND s.id=k.site_id
      LEFT JOIN users hu ON hu.tenant_id=k.tenant_id AND hu.id=k.holder_user_id
      LEFT JOIN employees he ON he.tenant_id=k.tenant_id AND he.id=k.holder_employee_id
      LEFT JOIN employees re ON re.tenant_id=k.tenant_id AND re.id=k.responsible_employee_id
      LEFT JOIN key_bundle_items i ON i.tenant_id=k.tenant_id AND i.key_id=k.id
      LEFT JOIN key_bundles b ON b.tenant_id=k.tenant_id AND b.id=i.bundle_id
      WHERE k.tenant_id=$1 AND k.id=$2`,[req.user!.tenantId,key.id])).rows[0] as Row;
    const canHistory=permissionScope(req,'keys:view_history')!==null;
    const canQr=permissionScope(req,'keys:qr:read')!==null;
    const canInventory=permissionScope(req,'keys:inventory:read')!==null;
    const [recentMovements,lossReports,inventoryChecks,reminderState]=await Promise.all([
      canHistory?query(`SELECT m.id,m.movement_type,m.from_status,m.to_status,m.reason,m.created_at,a.email actor_name,
          COALESCE(hu.email,he.name) holder_name FROM key_movements m
        LEFT JOIN users a ON a.tenant_id=m.tenant_id AND a.id=m.actor_user_id
        LEFT JOIN users hu ON hu.tenant_id=m.tenant_id AND hu.id=m.holder_user_id
        LEFT JOIN employees he ON he.tenant_id=m.tenant_id AND he.id=m.holder_employee_id
        WHERE m.tenant_id=$1 AND m.key_id=$2 ORDER BY m.created_at DESC LIMIT 8`,[req.user!.tenantId,key.id]):Promise.resolve({rows:[]}),
      canHistory?query(`SELECT l.*,i.id incident_id FROM key_loss_reports l LEFT JOIN incidents i ON i.tenant_id=l.tenant_id AND i.id=l.incident_id
        WHERE l.tenant_id=$1 AND l.key_id=$2 ORDER BY l.created_at DESC`,[req.user!.tenantId,key.id]):Promise.resolve({rows:[]}),
      canInventory?query(`SELECT c.id,c.checked_at,c.checker_name,c.notes,
          COALESCE(json_agg(json_build_object('key_id',i.key_id,'expected_present',i.expected_present,'found',i.found,'actual_condition',i.actual_condition)) FILTER (WHERE i.key_id IS NOT NULL),'[]') items
        FROM key_inventory_checks c LEFT JOIN key_inventory_check_items i ON i.tenant_id=c.tenant_id AND i.check_id=c.id
        WHERE c.tenant_id=$1 AND EXISTS (SELECT 1 FROM key_inventory_check_items x WHERE x.tenant_id=c.tenant_id AND x.check_id=c.id AND x.key_id=$2)
        GROUP BY c.id ORDER BY c.checked_at DESC`,[req.user!.tenantId,key.id]):Promise.resolve({rows:[]}),
      canHistory?query('SELECT days,due_at,sent_at FROM key_reminder_state WHERE tenant_id=$1 AND key_id=$2 ORDER BY due_at,days',[req.user!.tenantId,key.id]):Promise.resolve({rows:[]}),
    ]);
    const visible_sections={master:true,history:canHistory,qr:canQr,loss_reports:canHistory,inventory:canInventory};
    res.json({key:detail,holder:{user_id:detail.holder_user_id,employee_id:detail.holder_employee_id,name:detail.holder_name??null,personnel_number:detail.holder_personnel_number??null,status:detail.holder_status??null},
      site:detail.site_id?{id:detail.site_id,name:detail.site_name}:null,bundle:detail.bundle_id?{id:detail.bundle_id,name:detail.bundle_name}:null,
      recent_movements:recentMovements.rows,loss_reports:lossReports.rows,inventory_checks:inventoryChecks.rows,reminder_state:reminderState.rows,visible_sections});
  }catch(error){if(error instanceof z.ZodError)return badRequest(res);next(error);}
});

const updateBody=z.object({
  label:z.string().trim().min(1).max(160).optional(),key_type:z.enum(keyTypes).optional(),site_id:uuid.nullable().optional(),
  serial_number:text(120),manufacturer:text(160),location:text(160),building:text(160),area:text(160),access_point:text(160),
  description:text(2000),remarks:text(2000),responsible_employee_id:uuid.nullable().optional(),
}).strict();
keysRouter.patch('/keys/:id',requirePermission('keys:update',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const body=updateBody.parse(req.body);
    const result=await withTransaction(async client=>{
      const key=(await client.query('SELECT * FROM keys WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[req.user!.tenantId,String(req.params.id)])).rows[0] as Row|undefined;
      if(!key)throw Object.assign(new Error('Schlüssel nicht gefunden'),{status:404});
      keyPermission(req,'keys:update',key.site_id??null);
      if(body.responsible_employee_id&&!(await client.query('SELECT id FROM employees WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,body.responsible_employee_id])).rowCount)throw Object.assign(new Error('Verantwortlicher Mitarbeiter nicht gefunden'),{status:404});
      const fields=['label','key_type','site_id','serial_number','manufacturer','location','building','area','access_point','description','remarks','responsible_employee_id'] as const;
      const changes=fields.filter(field=>body[field]!==undefined);
      if(!changes.length)return key;
      const values:unknown[]=[req.user!.tenantId,key.id];
      const assignments=changes.map(field=>`${field}=$${values.push(body[field]??null)}`);
      const updated=(await client.query(`UPDATE keys SET ${assignments.join(',')},updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *`,values)).rows[0];
      await recordAudit(req.user!.tenantId,req.user!.id,'keys.updated','key',key.id,{fields:changes},client);
      return updated;
    });
    res.json(result);
  }catch(error){if(error instanceof z.ZodError)return badRequest(res);next(error);}
});

const issueBody=z.object({
  holder_user_id:uuid.nullable().optional(),holder_employee_id:uuid.nullable().optional(),due_at:z.string().datetime({offset:true}),
  reason:text(1000),handover_notes:text(2000),confirmation_name:text(160),receipt_document_id:uuid.nullable().optional(),client_mutation_id:uuid,
}).strict();
keysRouter.post('/keys/:id/issue',requirePermission('keys:issue',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const body=issueBody.parse(req.body);
    const result=await withTransaction(client=>runIdempotentMutation(client,{tenantId:req.user!.tenantId,userId:req.user!.id,mutationId:body.client_mutation_id,action:'keys.issue',payload:req.body},async tx=>{
      const key=(await tx.query('SELECT * FROM keys WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[req.user!.tenantId,String(req.params.id)])).rows[0] as Row|undefined;
      if(!key)throw Object.assign(new Error('Schlüssel nicht gefunden'),{status:404});
      keyPermission(req,'keys:issue',key.site_id??null);
      if((await tx.query('SELECT 1 FROM key_bundle_items WHERE tenant_id=$1 AND key_id=$2',[req.user!.tenantId,key.id])).rowCount)throw Object.assign(new Error('Gebündelte Schlüssel müssen über ihren Schlüsselbund verwaltet werden'),{status:409,code:'KEY_BUNDLE_MANAGED'});
      if(key.status!=='available'||key.holder_user_id||key.holder_employee_id)throw Object.assign(new Error('Schlüssel ist nicht zur Ausgabe verfügbar'),{status:409,code:'KEY_ALREADY_ISSUED'});
      const holder=await holderForIssue(tx,req.user!.tenantId,body.holder_user_id,body.holder_employee_id);
      const documentId=await documentForReceipt(tx,req.user!.tenantId,key.site_id??null,body.receipt_document_id);
      const next=transitionKeyStatus(key.status,'issued');
      const updated=(await tx.query(`UPDATE keys SET status=$3,holder_user_id=$4,holder_employee_id=$5,due_at=$6,
        issued_at=now(),issued_by=$7,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *`,
        [req.user!.tenantId,key.id,next,holder.holderUserId,holder.holderEmployeeId,body.due_at,req.user!.id])).rows[0];
      const reason=[body.reason,body.handover_notes].filter(Boolean).join(' · ')||null;
      const movement=(await tx.query(`INSERT INTO key_movements(tenant_id,key_id,movement_type,from_status,to_status,holder_user_id,holder_employee_id,actor_user_id,session_id,device_id,reason)
        VALUES($1,$2,'issued',$3,$4,$5,$6,$7,$8,(SELECT device_id FROM sessions WHERE tenant_id=$1 AND id=$8),$9) RETURNING *`,
        [req.user!.tenantId,key.id,key.status,next,holder.holderUserId,holder.holderEmployeeId,req.user!.id,session(req),reason])).rows[0];
      const receipt=(await tx.query(`INSERT INTO key_receipts(tenant_id,key_id,kind,holder_user_id,holder_employee_id,due_at,reason,handover_notes,confirmation_name,receipt_document_id,actor_user_id)
        VALUES($1,$2,'issue',$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [req.user!.tenantId,key.id,holder.holderUserId,holder.holderEmployeeId,body.due_at,body.reason??null,body.handover_notes??null,body.confirmation_name??null,documentId,req.user!.id])).rows[0];
      await recordAudit(req.user!.tenantId,req.user!.id,'keys.issued','key',key.id,{from_status:key.status,to_status:next,movement_id:movement.id,receipt_id:receipt.id,due_at:body.due_at},tx);
      return {key:updated,movement,receipt};
    }));
    notify(req.user!.tenantId,'keys.issued',`key-issued:${String(req.params.id)}:${result.response.receipt.id}`,'Schlüssel ausgegeben',`Schlüssel ${result.response.key.key_code} wurde ausgegeben.`,String(req.params.id));
    res.status(result.replayed?200:201).json(result.response);
  }catch(error){if(error instanceof z.ZodError)return badRequest(res);next(error);}
});

const returnBody=z.object({
  condition:z.enum(returnConditions),reason:text(1000),notes:text(2000),receipt_document_id:uuid.nullable().optional(),client_mutation_id:uuid,
}).strict();
keysRouter.post('/keys/:id/return',requirePermission('keys:return',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const body=returnBody.parse(req.body);
    const result=await withTransaction(client=>runIdempotentMutation(client,{tenantId:req.user!.tenantId,userId:req.user!.id,mutationId:body.client_mutation_id,action:'keys.return',payload:req.body},async tx=>{
      const key=(await tx.query('SELECT * FROM keys WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[req.user!.tenantId,String(req.params.id)])).rows[0] as Row|undefined;
      if(!key)throw Object.assign(new Error('Schlüssel nicht gefunden'),{status:404});
      keyPermission(req,'keys:return',key.site_id??null);
      if(!canReturnKey({actorUserId:req.user!.id,holderUserId:key.holder_user_id,operator:operator(req)}))throw Object.assign(new Error('Nur der gültige Halter oder ein Operateur darf diesen Schlüssel zurückgeben'),{status:403});
      if(['blocked','deactivated','lost'].includes(key.status))throw Object.assign(new Error('Gesperrte, verlorene oder deaktivierte Schlüssel können nicht als verfügbar zurückgegeben werden'),{status:409,code:'KEY_INVALID_STATUS_TRANSITION'});
      const next=transitionKeyStatus(key.status,'returned');
      const documentId=await documentForReceipt(tx,req.user!.tenantId,key.site_id??null,body.receipt_document_id);
      const updated=(await tx.query(`UPDATE keys SET status=$3,holder_user_id=NULL,holder_employee_id=NULL,due_at=NULL,
        returned_at=now(),returned_by=$4,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *`,
        [req.user!.tenantId,key.id,next,req.user!.id])).rows[0];
      const reason=[body.reason,body.notes].filter(Boolean).join(' · ')||null;
      const movement=(await tx.query(`INSERT INTO key_movements(tenant_id,key_id,movement_type,from_status,to_status,holder_user_id,holder_employee_id,actor_user_id,session_id,device_id,reason)
        VALUES($1,$2,'returned',$3,$4,$5,$6,$7,$8,(SELECT device_id FROM sessions WHERE tenant_id=$1 AND id=$8),$9) RETURNING *`,
        [req.user!.tenantId,key.id,key.status,next,key.holder_user_id,key.holder_employee_id,req.user!.id,session(req),reason])).rows[0];
      const receipt=(await tx.query(`INSERT INTO key_receipts(tenant_id,key_id,kind,condition,reason,handover_notes,receipt_document_id,actor_user_id)
        VALUES($1,$2,'return',$3,$4,$5,$6,$7) RETURNING *`,
        [req.user!.tenantId,key.id,body.condition,body.reason??null,body.notes??null,documentId,req.user!.id])).rows[0];
      await recordAudit(req.user!.tenantId,req.user!.id,'keys.returned','key',key.id,{from_status:key.status,to_status:next,movement_id:movement.id,receipt_id:receipt.id,condition:body.condition},tx);
      return {key:updated,movement,receipt};
    }));
    notify(req.user!.tenantId,'keys.returned',`key-returned:${String(req.params.id)}:${result.response.receipt.id}`,'Schlüssel zurückgegeben',`Schlüssel ${result.response.key.key_code} wurde zurückgegeben.`,String(req.params.id));
    res.json(result.response);
  }catch(error){if(error instanceof z.ZodError)return badRequest(res);next(error);}
});

const lossReportBody=z.object({
  last_holder_user_id:uuid.nullable().optional(),last_holder_employee_id:uuid.nullable().optional(),site_id:uuid.nullable().optional(),
  lost_at:z.string().datetime({offset:true}),reported_at:z.string().datetime({offset:true}),reporter_name:z.string().trim().min(1).max(160),
  description:text(4000),risk_assessment:text(4000),immediate_measures:text(4000),follow_up:text(4000),
  status:z.enum(lossStatuses).default('reported'),incident_id:uuid.nullable().optional(),create_incident:z.boolean().default(false),
  incident_priority_id:uuid.nullable().optional(),client_mutation_id:uuid,
}).strict();
async function createIncident(tx:Client,req:Request,body:z.infer<typeof lossReportBody>,siteId:string|null){
  if(!body.incident_priority_id)throw Object.assign(new Error('Eine gültige Vorfallspriorität ist erforderlich'),{status:400});
  const priority=(await tx.query('SELECT id FROM alarm_priorities WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,body.incident_priority_id])).rows[0];
  if(!priority)throw Object.assign(new Error('Vorfallpriorität nicht gefunden'),{status:404});
  const description=`Schlüsselverlust: ${body.description??'Schlüsselverlust gemeldet'}`;
  const incident=(await tx.query(`INSERT INTO incidents(tenant_id,site_id,priority_id,description,created_by)
    VALUES($1,$2,$3,$4,$5) RETURNING *`,[req.user!.tenantId,siteId,body.incident_priority_id,description,req.user!.id])).rows[0];
  await tx.query('INSERT INTO incident_history(incident_id,tenant_id,to_status,changed_by) VALUES($1,$2,$3,$4)',[incident.id,req.user!.tenantId,'initiated',req.user!.id]);
  return incident.id as string;
}
keysRouter.post('/keys/:id/report-loss',requireAnyPermission('keys:report_loss','keys:manage'),async(req,res,next)=>{
  try{
    const body=lossReportBody.parse(req.body);
    const result=await withTransaction(client=>runIdempotentMutation(client,{tenantId:req.user!.tenantId,userId:req.user!.id,mutationId:body.client_mutation_id,action:'keys.loss.report',payload:req.body},async tx=>{
      const key=(await tx.query('SELECT * FROM keys WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[req.user!.tenantId,String(req.params.id)])).rows[0] as Row|undefined;
      if(!key)throw Object.assign(new Error('Schlüssel nicht gefunden'),{status:404});
      keyPermissionAny(req,['keys:report_loss','keys:manage'],key.site_id??null);
      if(body.last_holder_user_id&&!(await tx.query('SELECT id FROM users WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,body.last_holder_user_id])).rowCount)throw Object.assign(new Error('Letzter Halterbenutzer nicht gefunden'),{status:404});
      if(body.last_holder_employee_id&&!(await tx.query('SELECT id FROM employees WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,body.last_holder_employee_id])).rowCount)throw Object.assign(new Error('Letzter Haltermitarbeiter nicht gefunden'),{status:404});
      let incidentId:string|null=body.incident_id??null;
      if(incidentId&&!(await tx.query('SELECT id FROM incidents WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,incidentId])).rowCount)throw Object.assign(new Error('Vorfall nicht gefunden'),{status:404});
      if(body.create_incident)incidentId=await createIncident(tx,req,body,body.site_id??key.site_id??null);
      const technicalBlock=/technisch|technical|block|sperr/i.test(body.immediate_measures??'');
      const blockMovement=technicalBlock&&key.status!=='blocked'?await blockKeyInTransaction(tx,req,key,'Verlustmeldung: technische Sperrung'):null;
      const report=(await tx.query(`INSERT INTO key_loss_reports(tenant_id,key_id,last_holder_user_id,last_holder_employee_id,site_id,lost_at,reported_at,reporter_name,description,risk_assessment,immediate_measures,follow_up,status,incident_id,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [req.user!.tenantId,key.id,body.last_holder_user_id??null,body.last_holder_employee_id??null,body.site_id??key.site_id??null,
          body.lost_at,body.reported_at,body.reporter_name,body.description??null,body.risk_assessment??null,body.immediate_measures??null,
          body.follow_up??null,body.status,incidentId,req.user!.id])).rows[0];
      const current=(await tx.query('SELECT * FROM keys WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[req.user!.tenantId,key.id])).rows[0] as Row;
      const next=transitionKeyStatus(current.status,'lost');
      const updated=(await tx.query(`UPDATE keys SET status=$3,holder_user_id=NULL,holder_employee_id=NULL,due_at=NULL,lost_at=$4,updated_at=now()
        WHERE tenant_id=$1 AND id=$2 RETURNING *`,[req.user!.tenantId,key.id,next,body.lost_at])).rows[0];
      const movement=(await tx.query(`INSERT INTO key_movements(tenant_id,key_id,movement_type,from_status,to_status,holder_user_id,holder_employee_id,actor_user_id,session_id,device_id,reason)
        VALUES($1,$2,'lost',$3,$4,$5,$6,$7,$8,(SELECT device_id FROM sessions WHERE tenant_id=$1 AND id=$8),$9) RETURNING *`,
        [req.user!.tenantId,key.id,current.status,next,current.holder_user_id,current.holder_employee_id,req.user!.id,session(req),body.description??null])).rows[0];
      await recordAudit(req.user!.tenantId,req.user!.id,'keys.loss.reported','key',key.id,{from_status:current.status,to_status:next,report_id:report.id,movement_id:movement.id,incident_id:incidentId,block_movement_id:blockMovement?.id??null},tx);
      return {key:updated,report,movement,incident_id:incidentId};
    }));
    notify(req.user!.tenantId,'keys.lost',`key-lost:${String(req.params.id)}:${result.response.report.id}`,'Schlüsselverlust gemeldet',`Verlust von Schlüssel ${result.response.key.key_code} wurde gemeldet.`,String(req.params.id));
    res.status(result.replayed?200:201).json(result.response);
  }catch(error){if(error instanceof z.ZodError)return badRequest(res);next(error);}
});

const lossUpdateBody=z.object({
  status:z.enum(lossStatuses).optional(),immediate_measures:text(4000),follow_up:text(4000),notes:text(4000),risk_assessment:text(4000),
}).strict();
keysRouter.patch('/keys/:id/loss-reports/:reportId',requireAnyPermission('keys:report_loss','keys:manage'),async(req,res,next)=>{
  try{
    const body=lossUpdateBody.parse(req.body);
    const updated=await withTransaction(async client=>{
      const report=(await client.query('SELECT * FROM key_loss_reports WHERE tenant_id=$1 AND id=$2 AND key_id=$3 FOR UPDATE',[req.user!.tenantId,String(req.params.reportId),String(req.params.id)])).rows[0] as Row|undefined;
      if(!report)throw Object.assign(new Error('Verlustmeldung nicht gefunden'),{status:404});
      const key=(await client.query('SELECT site_id FROM keys WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,String(req.params.id)])).rows[0] as Row|undefined;
      keyPermissionAny(req,['keys:report_loss','keys:manage'],key?.site_id??null);
      const fields=['status','immediate_measures','follow_up','notes','risk_assessment'] as const;
      const changes=fields.filter(field=>body[field]!==undefined);
      if(!changes.length)return report;
      const values:unknown[]=[req.user!.tenantId,report.id,report.key_id];
      const assignments=changes.map(field=>`${field}=$${values.push(body[field]??null)}`);
      const row=(await client.query(`UPDATE key_loss_reports SET ${assignments.join(',')},updated_at=now() WHERE tenant_id=$1 AND id=$2 AND key_id=$3 RETURNING *`,values)).rows[0];
      await recordAudit(req.user!.tenantId,req.user!.id,'keys.loss.updated','key_loss_report',report.id,{key_id:report.key_id,fields:changes},client);
      return row;
    });
    res.json(updated);
  }catch(error){if(error instanceof z.ZodError)return badRequest(res);next(error);}
});

async function blockKeyInTransaction(tx:Client,req:Request,key:Row,reason:string|null){
  const next=transitionKeyStatus(key.status,'blocked');
  await tx.query('UPDATE keys SET status=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,key.id,next]);
  const movement=(await tx.query(`INSERT INTO key_movements(tenant_id,key_id,movement_type,from_status,to_status,holder_user_id,holder_employee_id,actor_user_id,session_id,device_id,reason)
    VALUES($1,$2,'blocked',$3,$4,$5,$6,$7,$8,(SELECT device_id FROM sessions WHERE tenant_id=$1 AND id=$8),$9) RETURNING *`,
    [req.user!.tenantId,key.id,key.status,next,key.holder_user_id,key.holder_employee_id,req.user!.id,session(req),reason])).rows[0];
  await recordAudit(req.user!.tenantId,req.user!.id,'keys.blocked','key',key.id,{from_status:key.status,to_status:next,movement_id:movement.id},tx);
  return movement;
}
const statusBody=z.object({reason:text(1000),immediate_measures:text(4000),client_mutation_id:uuid}).strict();
for(const [path,type] of [['block','blocked'],['reactivate','reactivated']] as const){
  keysRouter.post(`/keys/:id/${path}`,requirePermission('keys:manage',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
    try{
      const body=statusBody.parse(req.body);
      const syncAction:SyncMutationAction=type==='blocked'?'keys.block':'keys.reactivate';
      const result=await withTransaction(client=>runIdempotentMutation(client,{tenantId:req.user!.tenantId,userId:req.user!.id,mutationId:body.client_mutation_id,action:syncAction,payload:req.body},async tx=>{
        const key=(await tx.query('SELECT * FROM keys WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[req.user!.tenantId,String(req.params.id)])).rows[0] as Row|undefined;
        if(!key)throw Object.assign(new Error('Schlüssel nicht gefunden'),{status:404});
        keyPermission(req,'keys:manage',key.site_id??null);
        const reason=[body.reason,body.immediate_measures].filter(Boolean).join(' · ')||null;
        let movement:Row;
        let updated:Row;
        if(type==='blocked'){
          movement=await blockKeyInTransaction(tx,req,key,reason);
          updated=(await tx.query('SELECT * FROM keys WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,key.id])).rows[0];
        }else{
          const next=transitionKeyStatus(key.status,'reactivated');
          updated=(await tx.query(`UPDATE keys SET status=$3,holder_user_id=NULL,holder_employee_id=NULL,due_at=NULL,updated_at=now()
            WHERE tenant_id=$1 AND id=$2 RETURNING *`,[req.user!.tenantId,key.id,next])).rows[0];
          movement=(await tx.query(`INSERT INTO key_movements(tenant_id,key_id,movement_type,from_status,to_status,holder_user_id,holder_employee_id,actor_user_id,session_id,device_id,reason)
            VALUES($1,$2,'reactivated',$3,$4,$5,$6,$7,$8,(SELECT device_id FROM sessions WHERE tenant_id=$1 AND id=$8),$9) RETURNING *`,
            [req.user!.tenantId,key.id,key.status,next,key.holder_user_id,key.holder_employee_id,req.user!.id,session(req),reason])).rows[0];
          await recordAudit(req.user!.tenantId,req.user!.id,'keys.reactivated','key',key.id,{from_status:key.status,to_status:next,movement_id:movement.id},tx);
        }
        return {key:updated,movement};
      }));
      notify(req.user!.tenantId,`keys.${type}`,`key-${type}:${String(req.params.id)}:${result.response.movement.id}`,type==='blocked'?'Schlüssel gesperrt':'Schlüssel reaktiviert',`Schlüssel ${result.response.key.key_code} wurde ${type==='blocked'?'gesperrt':'reaktiviert'}.`,String(req.params.id));
      res.json(result.response);
    }catch(error){if(error instanceof z.ZodError)return badRequest(res);next(error);}
  });
}

const pageSchema=z.object({page:z.coerce.number().int().min(1).max(100000).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(10)});
keysRouter.get('/keys/:id/history',requirePermission('keys:view_history',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const key=await readKey({query},req,['keys:view_history','keys:read']);
    const {page,pageSize}=pageSchema.parse(parseQuery(req,pageSchema));
    const scope=permissionScope(req,'keys:view_history');
    const siteCondition=scope==='site'?' AND k.site_id=ANY($3::uuid[])':'';
    const values:unknown[]=scope==='site'?[req.user!.tenantId,key.id,(req.user!.siteIds??[])]:[req.user!.tenantId,key.id];
    const limitParameter=values.length+1;
    const offsetParameter=values.length+2;
    const result=await query(`SELECT m.id,m.movement_type,m.from_status,m.to_status,m.reason,m.created_at,
        a.email actor_name,hu.email holder_user_name,he.name holder_employee_name,s.name site_name,
        m.from_status previous_status,m.to_status new_status,
        (SELECT r.id FROM key_receipts r WHERE r.tenant_id=m.tenant_id AND r.key_id=m.key_id
          AND r.created_at BETWEEN m.created_at-INTERVAL '5 minutes' AND m.created_at+INTERVAL '5 minutes'
          ORDER BY r.created_at DESC LIMIT 1) receipt_id,
        (SELECT l.incident_id FROM key_loss_reports l WHERE l.tenant_id=m.tenant_id AND l.key_id=m.key_id
          AND l.lost_at BETWEEN m.created_at-INTERVAL '5 minutes' AND m.created_at+INTERVAL '5 minutes'
          AND l.incident_id IS NOT NULL ORDER BY l.lost_at DESC LIMIT 1) incident_id,
        COUNT(*) OVER()::int total_count
      FROM key_movements m JOIN keys k ON k.tenant_id=m.tenant_id AND k.id=m.key_id
      LEFT JOIN users a ON a.tenant_id=m.tenant_id AND a.id=m.actor_user_id
      LEFT JOIN users hu ON hu.tenant_id=m.tenant_id AND hu.id=m.holder_user_id
      LEFT JOIN employees he ON he.tenant_id=m.tenant_id AND he.id=m.holder_employee_id
      LEFT JOIN sites s ON s.tenant_id=k.tenant_id AND s.id=k.site_id
      WHERE m.tenant_id=$1 AND m.key_id=$2${siteCondition}
      ORDER BY m.created_at DESC,m.id DESC LIMIT $${limitParameter} OFFSET $${offsetParameter}`,
      [...values,pageSize,(page-1)*pageSize]);
    setPageHeaders(res,result.rows[0]?.total_count??result.rows.length,page,pageSize);
    res.json(result.rows);
  }catch(error){if(error instanceof z.ZodError)return badRequest(res);next(error);}
});

keysRouter.get('/keys/:id/qr',requirePermission('keys:qr:read',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const key=await readKey({query},req,['keys:qr:read']);
    const expiresAt=new Date(Date.now()+15*60*1000);
    const token=buildKeyQrToken(keyQrSecret,req.user!.tenantId,key.id,expiresAt);
    await withTransaction(async client=>{
      // Reissuing invalidates the previous reference of this key immediately.
      await client.query('DELETE FROM key_qr_tokens WHERE tenant_id=$1 AND key_id=$2',[req.user!.tenantId,key.id]);
      await client.query(`INSERT INTO key_qr_tokens(tenant_id,key_id,token_hash,expires_at,created_by)
        VALUES($1,$2,$3,$4,$5)`,
        [req.user!.tenantId,key.id,hashKeyQrToken(token),expiresAt,req.user!.id]);
      await recordAudit(req.user!.tenantId,req.user!.id,'keys.qr.issued','key',key.id,{expires_at:expiresAt.toISOString()},client);
    });
    res.json({token,url:`/keys/${key.id}/qr?ref=${encodeURIComponent(token)}`,expires_at:expiresAt.toISOString()});
  }catch(error){next(error);}
});

keysRouter.get('/keys/:id/qr/verify',requirePermission('keys:qr:read',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const key=await readKey({query},req,['keys:qr:read']);
    const token=typeof req.query.ref==='string'?req.query.ref:'';
    const verification=verifyKeyQrToken(keyQrSecret,token,{tenantId:req.user!.tenantId,keyId:key.id});
    const stored=verification.valid?(await query('SELECT id FROM key_qr_tokens WHERE tenant_id=$1 AND key_id=$2 AND token_hash=$3 AND expires_at>now()',
      [req.user!.tenantId,key.id,hashKeyQrToken(token)])).rows[0]:undefined;
    if(!verification.valid||!stored){
      const reason=verification.valid?'revoked':verification.reason;
      await recordAudit(req.user!.tenantId,req.user!.id,'keys.qr.verify_failed','key',key.id,{reason});
      return res.status(reason==='expired'?410:400).json({error:'Ungültiger QR-Verweis.',code:reason==='expired'?'KEY_QR_EXPIRED':'KEY_QR_INVALID'});
    }
    await recordAudit(req.user!.tenantId,req.user!.id,'keys.qr.verified','key',key.id,{expires_at:verification.expiresAt});
    res.json({valid:true,key_id:key.id,key_code:key.key_code,label:key.label,expires_at:verification.expiresAt});
  }catch(error){next(error);}
});

async function legacyMovement(req:Request,type:'lost'|'deactivated'){
  const syncAction:SyncMutationAction=type==='lost'?'keys.lost':'keys.deactivate';
  return withTransaction(client=>runIdempotentMutation(client,{tenantId:req.user!.tenantId,userId:req.user!.id,mutationId:(req.body.client_mutation_id as string),action:syncAction,payload:req.body},async tx=>{
    const key=(await tx.query('SELECT * FROM keys WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[req.user!.tenantId,String(req.params.id)])).rows[0] as Row|undefined;
    if(!key)throw Object.assign(new Error('Schlüssel nicht gefunden'),{status:404});
    keyPermission(req,'keys:manage',key.site_id??null);
    const next=transitionKeyStatus(key.status,type);
    const movement=(await tx.query(`INSERT INTO key_movements(tenant_id,key_id,movement_type,from_status,to_status,holder_user_id,holder_employee_id,actor_user_id,session_id,device_id,reason)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,(SELECT device_id FROM sessions WHERE tenant_id=$1 AND id=$9),$10) RETURNING *`,
      [req.user!.tenantId,key.id,type,key.status,next,key.holder_user_id,key.holder_employee_id,req.user!.id,session(req),(req.body.reason as string|undefined)??null])).rows[0];
    const updated=(await tx.query(`UPDATE keys SET status=$3,holder_user_id=NULL,holder_employee_id=NULL,due_at=NULL,
      ${type==='lost'?'lost_at':'deactivated_at'}=now(),updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *`,[req.user!.tenantId,key.id,next])).rows[0];
    await recordAudit(req.user!.tenantId,req.user!.id,`keys.${type==='lost'?'lost':'deactivated'}`,'key',key.id,{from_status:key.status,to_status:next,movement_id:movement.id},tx);
    return {key:updated,movement};
  }));
}
keysRouter.post('/keys/:id/lost',requirePermission('keys:manage',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{movementBody.parse(req.body);res.json((await legacyMovement(req,'lost')).response);}catch(error){if(error instanceof z.ZodError)return badRequest(res);next(error);}
});
keysRouter.post('/keys/:id/deactivate',requirePermission('keys:manage',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{movementBody.parse(req.body);res.json((await legacyMovement(req,'deactivated')).response);}catch(error){if(error instanceof z.ZodError)return badRequest(res);next(error);}
});

const bundleBody=z.object({name:z.string().trim().min(1).max(160),site_id:uuid.nullable().optional(),client_mutation_id:uuid}).strict();
const bundleItemBody=z.object({key_id:uuid,client_mutation_id:uuid}).strict();
const bundleHolderBody=z.object({holder_user_id:uuid.nullable().optional(),holder_employee_id:uuid.nullable().optional(),client_mutation_id:uuid,reason:text(1000),due_at:z.string().datetime({offset:true}).nullable().optional()}).strict();
const bundleReturnBody=z.object({key_ids:z.array(uuid).min(1),client_mutation_id:uuid,reason:text(1000)}).strict();
function bundlePermission(req:Request,code:string,siteId:string|null){keyPermission(req,code,siteId);}

keysRouter.get('/key-bundles',requirePermission('keys:bundle_read',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const filters=z.object({q:z.string().trim().max(200).optional(),status:z.enum(['available','issued','partial','deactivated']).optional(),
      site_id:uuid.optional(),holder:z.string().trim().max(160).optional(),sort:z.enum(['name','status','site_name','holder_name','item_count','created_at']).default('name'),
      dir:z.enum(['asc','desc']).default('asc'),page:z.coerce.number().int().min(1).max(100000).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(10)}).parse(parseQuery(req,z.object({q:z.string().trim().max(200).optional(),status:z.enum(['available','issued','partial','deactivated']).optional(),site_id:uuid.optional(),holder:z.string().trim().max(160).optional(),sort:z.enum(['name','status','site_name','holder_name','item_count','created_at']).default('name'),dir:z.enum(['asc','desc']).default('asc'),page:z.coerce.number().int().min(1).max(100000).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(10)})));
    const scope=permissionScope(req,'keys:bundle_read');
    const values:unknown[]=[req.user!.tenantId];const conditions=['b.tenant_id=$1'];
    if(scope==='site'){values.push(req.user!.siteIds??[]);conditions.push(`b.site_id=ANY($${values.length}::uuid[])`);}
    const add=(fragment:string,value:unknown)=>{values.push(value);return fragment.replaceAll('$P',`$${values.length}`);};
    if(filters.q){const escaped=filters.q.replace(/[\\%_]/g,'\\$&');conditions.push(add("b.name ILIKE $P ESCAPE '\\'",`%${escaped}%`));}
    if(filters.status)conditions.push(add('b.status=$P',filters.status));
    if(filters.site_id)conditions.push(add('b.site_id=$P',filters.site_id));
    if(filters.holder){const escaped=filters.holder.replace(/[\\%_]/g,'\\$&');conditions.push(add("(hu.email ILIKE $P ESCAPE '\\' OR he.name ILIKE $P ESCAPE '\\')",`%${escaped}%`));}
    const bundleOrder:Record<string,string>={name:'lower(b.name)',status:'b.status',site_name:'lower(s.name)',holder_name:'lower(COALESCE(hu.email,he.name))',item_count:'item_count',created_at:'b.created_at'};
    const order=`${bundleOrder[filters.sort]} ${filters.dir.toUpperCase()}`;
    const result=await query(`SELECT b.id,b.site_id,b.name,b.status,b.holder_user_id,b.holder_employee_id,b.created_at,b.updated_at,
        s.name site_name,COALESCE(hu.email,he.name) holder_name,
        COUNT(i.key_id)::int item_count,COUNT(i.key_id) FILTER (WHERE k.status='issued')::int issued_count,
        COUNT(i.key_id) FILTER (WHERE k.status='available')::int available_count,COUNT(*) OVER()::int total_count
      FROM key_bundles b LEFT JOIN sites s ON s.tenant_id=b.tenant_id AND s.id=b.site_id
      LEFT JOIN users hu ON hu.tenant_id=b.tenant_id AND hu.id=b.holder_user_id
      LEFT JOIN employees he ON he.tenant_id=b.tenant_id AND he.id=b.holder_employee_id
      LEFT JOIN key_bundle_items i ON i.tenant_id=b.tenant_id AND i.bundle_id=b.id
      LEFT JOIN keys k ON k.tenant_id=i.tenant_id AND k.id=i.key_id
      WHERE ${conditions.join(' AND ')} GROUP BY b.id,s.name,hu.email,he.name
      ORDER BY ${order},b.id LIMIT $${values.length+1} OFFSET $${values.length+2}`,
      [...values,filters.pageSize,(filters.page-1)*filters.pageSize]);
    setPageHeaders(res,result.rows[0]?.total_count??result.rows.length,filters.page,filters.pageSize);
    res.json(result.rows);
  }catch(error){if(error instanceof z.ZodError)return badRequest(res);next(error);}
});

keysRouter.post('/key-bundles',requirePermission('keys:bundle_write',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const body=bundleBody.parse(req.body);bundlePermission(req,'keys:bundle_write',body.site_id??null);
    const result=await withTransaction(client=>runIdempotentMutation(client,{tenantId:req.user!.tenantId,userId:req.user!.id,mutationId:body.client_mutation_id,action:'keys.bundle.create',payload:req.body},async tx=>{
      const row=(await tx.query('INSERT INTO key_bundles(tenant_id,site_id,name,created_by,created_session_id) VALUES($1,$2,$3,$4,$5) RETURNING *',
        [req.user!.tenantId,body.site_id??null,body.name,req.user!.id,session(req)])).rows[0];
      await tx.query("INSERT INTO key_bundle_movements(tenant_id,bundle_id,movement_type,to_status,actor_user_id,session_id) VALUES($1,$2,'created','available',$3,$4)",
        [req.user!.tenantId,row.id,req.user!.id,session(req)]);
      await recordAudit(req.user!.tenantId,req.user!.id,'keys.bundle.created','key_bundle',row.id,{site_id:row.site_id},tx);
      return row;
    }));
    res.status(result.replayed?200:201).json(result.response);
  }catch(error){if(error instanceof z.ZodError)return badRequest(res);next(error);}
});

async function loadBundle(client:QueryLike,req:Request){
  const bundle=(await client.query('SELECT * FROM key_bundles WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,String(req.params.id)])).rows[0] as Row|undefined;
  if(!bundle)throw Object.assign(new Error('Schlüsselbund nicht gefunden'),{status:404});
  bundlePermission(req,'keys:bundle_read',bundle.site_id??null);
  return bundle;
}

keysRouter.get('/key-bundles/:id',requirePermission('keys:bundle_read',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const bundle=await loadBundle({query},req);
    const [items,losses]=await Promise.all([
      query(`SELECT k.id,k.site_id,k.key_code,k.label,k.key_type,k.status,k.due_at,k.holder_user_id,k.holder_employee_id,
          ${derivedStatusSql} display_status,s.name site_name
        FROM key_bundle_items i JOIN keys k ON k.tenant_id=i.tenant_id AND k.id=i.key_id
        LEFT JOIN sites s ON s.tenant_id=k.tenant_id AND s.id=k.site_id
        WHERE i.tenant_id=$1 AND i.bundle_id=$2 ORDER BY k.label`,[req.user!.tenantId,bundle.id]),
      query(`SELECT l.id,l.status,l.description,l.immediate_measures,l.created_at,k.id key_id,k.label,
          COALESCE(hu.email,he.name) holder_name FROM key_loss_reports l
        JOIN keys k ON k.tenant_id=l.tenant_id AND k.id=l.key_id
        JOIN key_bundle_items i ON i.tenant_id=l.tenant_id AND i.key_id=l.key_id AND i.bundle_id=$2
        LEFT JOIN users hu ON hu.tenant_id=l.tenant_id AND hu.id=l.last_holder_user_id
        LEFT JOIN employees he ON he.tenant_id=l.tenant_id AND he.id=l.last_holder_employee_id
        WHERE l.tenant_id=$1 ORDER BY l.created_at DESC`,[req.user!.tenantId,bundle.id]),
    ]);
    const issued=items.rows.filter((item:Row)=>item.status==='issued').length;
    const metrics={item_count:items.rows.length,issued_count:issued,available_count:items.rows.filter((item:Row)=>item.status==='available').length,
      overdue_count:items.rows.filter((item:Row)=>item.display_status==='overdue').length,loss_count:losses.rows.length};
    const holder=(await query(`SELECT u.email user_name,e.name employee_name,e.employee_number FROM key_bundles b
      LEFT JOIN users u ON u.tenant_id=b.tenant_id AND u.id=b.holder_user_id
      LEFT JOIN employees e ON e.tenant_id=b.tenant_id AND e.id=b.holder_employee_id
      WHERE b.tenant_id=$1 AND b.id=$2`,[req.user!.tenantId,bundle.id])).rows[0] as Row|undefined;
    res.json({...bundle,items:items.rows,metrics,holder:holder?{user_name:holder.user_name??null,employee_name:holder.employee_name??null,personnel_number:holder.personnel_number??null}:null,loss_reports:losses.rows});
  }catch(error){next(error);}
});

keysRouter.get('/key-bundles/:id/history',requirePermission('keys:bundle_history_read',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const bundle=await loadBundle({query},req);
    const {page,pageSize}=pageSchema.parse(parseQuery(req,pageSchema));
    const result=await query(`SELECT m.id,m.movement_type,m.from_status,m.to_status,m.reason,m.created_at,m.returned_key_ids,
        a.email actor_name,hu.email holder_user_name,he.name holder_employee_name,COUNT(*) OVER()::int total_count
      FROM key_bundle_movements m LEFT JOIN users a ON a.tenant_id=m.tenant_id AND a.id=m.actor_user_id
      LEFT JOIN users hu ON hu.tenant_id=m.tenant_id AND hu.id=m.holder_user_id
      LEFT JOIN employees he ON he.tenant_id=m.tenant_id AND he.id=m.holder_employee_id
      WHERE m.tenant_id=$1 AND m.bundle_id=$2 ORDER BY m.created_at DESC,m.id DESC LIMIT $3 OFFSET $4`,
      [req.user!.tenantId,bundle.id,pageSize,(page-1)*pageSize]);
    setPageHeaders(res,result.rows[0]?.total_count??result.rows.length,page,pageSize);
    res.json(result.rows);
  }catch(error){if(error instanceof z.ZodError)return badRequest(res);next(error);}
});

keysRouter.post('/key-bundles/:id/items',requirePermission('keys:bundle_write',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const body=bundleItemBody.parse(req.body);
    const result=await withTransaction(client=>runIdempotentMutation(client,{tenantId:req.user!.tenantId,userId:req.user!.id,mutationId:body.client_mutation_id,action:'keys.bundle.item',payload:req.body},async tx=>{
      const bundle=(await tx.query('SELECT * FROM key_bundles WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[req.user!.tenantId,String(req.params.id)])).rows[0] as Row|undefined;
      if(!bundle)throw Object.assign(new Error('Schlüsselbund nicht gefunden'),{status:404});
      bundlePermission(req,'keys:bundle_write',bundle.site_id??null);
      if(bundle.status!=='available')throw Object.assign(new Error('Nur verfügbare Schlüsselbünde können geändert werden'),{status:409});
      const key=(await tx.query('SELECT * FROM keys WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[req.user!.tenantId,body.key_id])).rows[0] as Row|undefined;
      if(!key)throw Object.assign(new Error('Schlüssel nicht gefunden'),{status:404});
      if(key.status!=='available')throw Object.assign(new Error('Nur verfügbare Schlüssel können hinzugefügt werden'),{status:409});
      if(bundle.site_id&&key.site_id!==bundle.site_id)throw Object.assign(new Error('Schlüssel und Schlüsselbund müssen dasselbe Objekt verwenden'),{status:400});
      await tx.query('INSERT INTO key_bundle_items(tenant_id,bundle_id,key_id,added_by) VALUES($1,$2,$3,$4)',[req.user!.tenantId,bundle.id,key.id,req.user!.id]);
      const movement=(await tx.query(`INSERT INTO key_bundle_movements(tenant_id,bundle_id,movement_type,from_status,to_status,actor_user_id,session_id,reason)
        VALUES($1,$2,'item_added',$3,$3,$4,$5,$6) RETURNING *`,[req.user!.tenantId,bundle.id,bundle.status,req.user!.id,session(req),`key_id=${key.id}`])).rows[0];
      await recordAudit(req.user!.tenantId,req.user!.id,'keys.bundle.item_added','key_bundle',bundle.id,{key_id:key.id,movement_id:movement.id},tx);
      return {bundle,movement};
    }));
    res.status(result.replayed?200:201).json(result.response);
  }catch(error){if(error instanceof z.ZodError)return badRequest(res);next(error);}
});

keysRouter.delete('/key-bundles/:id/items/:keyId',requirePermission('keys:bundle_write',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const result=await withTransaction(async client=>{
      const bundle=(await client.query('SELECT * FROM key_bundles WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[req.user!.tenantId,String(req.params.id)])).rows[0] as Row|undefined;
      if(!bundle)throw Object.assign(new Error('Schlüsselbund nicht gefunden'),{status:404});
      bundlePermission(req,'keys:bundle_write',bundle.site_id??null);
      if(bundle.status!=='available')throw Object.assign(new Error('Nur verfügbare Schlüsselbünde können geändert werden'),{status:409});
      const key=(await client.query('SELECT id,status FROM keys WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,String(req.params.keyId)])).rows[0] as Row|undefined;
      if(!key||!(await client.query('SELECT 1 FROM key_bundle_items WHERE tenant_id=$1 AND bundle_id=$2 AND key_id=$3',[req.user!.tenantId,bundle.id,String(req.params.keyId)])).rowCount)throw Object.assign(new Error('Schlüssel im Schlüsselbund nicht gefunden'),{status:404});
      if(key.status!=='available')throw Object.assign(new Error('Nur verfügbare Schlüssel können entfernt werden'),{status:409});
      await client.query('DELETE FROM key_bundle_items WHERE tenant_id=$1 AND bundle_id=$2 AND key_id=$3',[req.user!.tenantId,bundle.id,key.id]);
      const movement=(await client.query(`INSERT INTO key_bundle_movements(tenant_id,bundle_id,movement_type,from_status,to_status,returned_key_ids,actor_user_id,session_id,reason)
        VALUES($1,$2,'item_removed',$3,$3,ARRAY[$4::uuid],$5,$6,$7) RETURNING *`,
        [req.user!.tenantId,bundle.id,bundle.status,key.id,req.user!.id,session(req),`key_id=${key.id}`])).rows[0];
      await recordAudit(req.user!.tenantId,req.user!.id,'keys.bundle.item_removed','key_bundle',bundle.id,{key_id:key.id,movement_id:movement.id},client);
      return {bundle,key_id:key.id,movement};
    });
    res.json(result);
  }catch(error){next(error);}
});

const bundleDeactivateBody=z.object({reason:text(1000),client_mutation_id:uuid}).strict();
keysRouter.post('/key-bundles/:id/deactivate',requirePermission('keys:bundle_deactivate',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const body=bundleDeactivateBody.parse(req.body);
    const result=await withTransaction(client=>runIdempotentMutation(client,{tenantId:req.user!.tenantId,userId:req.user!.id,mutationId:body.client_mutation_id,action:'keys.bundle.deactivate',payload:req.body},async tx=>{
      const bundle=(await tx.query('SELECT * FROM key_bundles WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[req.user!.tenantId,String(req.params.id)])).rows[0] as Row|undefined;
      if(!bundle)throw Object.assign(new Error('Schlüsselbund nicht gefunden'),{status:404});
      bundlePermission(req,'keys:bundle_deactivate',bundle.site_id??null);
      if(bundle.status==='deactivated')throw Object.assign(new Error('Der Schlüsselbund ist bereits deaktiviert'),{status:409});
      if(bundle.holder_user_id||bundle.holder_employee_id)throw Object.assign(new Error('Ein ausgegebener Schlüsselbund kann nicht deaktiviert werden'),{status:409});
      const updated=(await tx.query(`UPDATE key_bundles SET status='deactivated',holder_user_id=NULL,holder_employee_id=NULL,updated_at=now()
        WHERE tenant_id=$1 AND id=$2 RETURNING *`,[req.user!.tenantId,bundle.id])).rows[0];
      const movement=(await tx.query(`INSERT INTO key_bundle_movements(tenant_id,bundle_id,movement_type,from_status,to_status,actor_user_id,session_id,reason)
        VALUES($1,$2,'deactivated',$3,'deactivated',$4,$5,$6) RETURNING *`,[req.user!.tenantId,bundle.id,bundle.status,req.user!.id,session(req),body.reason??null])).rows[0];
      await recordAudit(req.user!.tenantId,req.user!.id,'keys.bundle.deactivated','key_bundle',bundle.id,{movement_id:movement.id},tx);
      return {bundle:updated,movement};
    }));
    res.json(result.response);
  }catch(error){if(error instanceof z.ZodError)return badRequest(res);next(error);}
});

async function bundleMovement(req:Request,bundleId:string,type:'issue'|'return',body:z.infer<typeof bundleHolderBody>|z.infer<typeof bundleReturnBody>){
  return withTransaction(client=>runIdempotentMutation(client,{tenantId:req.user!.tenantId,userId:req.user!.id,mutationId:body.client_mutation_id,action:`keys.bundle.${type}` as SyncMutationAction,payload:req.body},async tx=>{
    const bundle=(await tx.query('SELECT * FROM key_bundles WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[req.user!.tenantId,bundleId])).rows[0] as Row|undefined;
    if(!bundle)throw Object.assign(new Error('Schlüsselbund nicht gefunden'),{status:404});
    bundlePermission(req,type==='issue'?'keys:bundle_issue':'keys:bundle_return',bundle.site_id??null);
    if(type==='return'&&!canReturnKey({actorUserId:req.user!.id,holderUserId:bundle.holder_user_id,operator:operator(req)}))throw Object.assign(new Error('Nur der gültige Halter des Schlüsselbunds oder ein Operateur darf ihn zurückgeben'),{status:403});
    const items=(await tx.query(`SELECT k.* FROM key_bundle_items i JOIN keys k ON k.tenant_id=i.tenant_id AND k.id=i.key_id
      WHERE i.tenant_id=$1 AND i.bundle_id=$2 ORDER BY k.id FOR UPDATE`,[req.user!.tenantId,bundle.id])).rows as Row[];
    if(!items.length)throw Object.assign(new Error('Ein Schlüsselbund muss mindestens einen Schlüssel enthalten'),{status:409});
    let selected=items;
    let holderUserId:null|string=null;let holderEmployeeId:null|string=null;
    if(type==='issue'){
      const holder=body as z.infer<typeof bundleHolderBody>;
      if(bundle.status!=='available')throw Object.assign(new Error('Nur verfügbare Schlüsselbünde können ausgegeben werden'),{status:409});
      const holderIds=await holderForIssue(tx,req.user!.tenantId,holder.holder_user_id,holder.holder_employee_id);
      holderUserId=holderIds.holderUserId;holderEmployeeId=holderIds.holderEmployeeId;
      if(items.some(item=>item.status!=='available'))throw Object.assign(new Error('Jeder Schlüssel im Schlüsselbund muss verfügbar sein'),{status:409});
    }else{
      const requested=(body as z.infer<typeof bundleReturnBody>).key_ids;
      selected=validateBundleReturn(items as Parameters<typeof validateBundleReturn>[0],requested,{actorUserId:req.user!.id,operator:operator(req)});
      if(bundle.status==='available')throw Object.assign(new Error('Der Schlüsselbund ist nicht ausgegeben'),{status:409});
    }
    for(const item of selected){
      const next=type==='issue'?'issued':'available';
      await tx.query(`UPDATE keys SET status=$3,holder_user_id=$4,holder_employee_id=$5,due_at=$6,
        issued_at=CASE WHEN $3='issued' THEN now() ELSE issued_at END,
        issued_by=CASE WHEN $3='issued' THEN $7 ELSE issued_by END,
        returned_at=CASE WHEN $3='available' THEN now() ELSE returned_at END,
        returned_by=CASE WHEN $3='available' THEN $7 ELSE returned_by END,
        updated_at=now() WHERE tenant_id=$1 AND id=$2`,
        [req.user!.tenantId,item.id,next,holderUserId,holderEmployeeId,type==='issue'?(body as z.infer<typeof bundleHolderBody>).due_at??null:null,req.user!.id]);
      await tx.query(`INSERT INTO key_movements(tenant_id,key_id,movement_type,from_status,to_status,holder_user_id,holder_employee_id,actor_user_id,session_id,device_id,reason)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,(SELECT device_id FROM sessions WHERE tenant_id=$1 AND id=$9),$10)`,
        [req.user!.tenantId,item.id,type==='issue'?'issued':'returned',item.status,next,type==='issue'?holderUserId:item.holder_user_id??null,type==='issue'?holderEmployeeId:item.holder_employee_id??null,req.user!.id,session(req),body.reason??null]);
    }
    const issuedCount=items.filter(item=>type==='issue'||(item.status==='issued'&&!selected.some(selectedItem=>selectedItem.id===item.id))).length;
    const nextStatus=type==='issue'?'issued':bundleStatus(issuedCount,items.length);
    const movementType=type==='issue'?'issued':issuedCount?'partial_return':'returned';
    const updated=(await tx.query(`UPDATE key_bundles SET status=$3,holder_user_id=$4,holder_employee_id=$5,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *`,
      [req.user!.tenantId,bundle.id,nextStatus,type==='issue'?holderUserId:issuedCount?bundle.holder_user_id:null,type==='issue'?holderEmployeeId:issuedCount?bundle.holder_employee_id:null])).rows[0];
    const movement=(await tx.query(`INSERT INTO key_bundle_movements(tenant_id,bundle_id,movement_type,from_status,to_status,holder_user_id,holder_employee_id,returned_key_ids,actor_user_id,session_id,reason)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [req.user!.tenantId,bundle.id,movementType,bundle.status,nextStatus,updated.holder_user_id,updated.holder_employee_id,type==='return'?selected.map(item=>item.id):[],req.user!.id,session(req),body.reason??null])).rows[0];
    await recordAudit(req.user!.tenantId,req.user!.id,`keys.bundle.${type}`,'key_bundle',bundle.id,{movement_id:movement.id,key_ids:selected.map(item=>item.id),to_status:nextStatus},tx);
    return {bundle:updated,movement};
  }));
}

keysRouter.post('/key-bundles/:id/issue',requirePermission('keys:bundle_issue',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{const body=bundleHolderBody.parse(req.body);const result=await bundleMovement(req,String(req.params.id),'issue',body);res.status(result.replayed?200:201).json(result.response);}catch(error){if(error instanceof z.ZodError)return badRequest(res);next(error);}
});
keysRouter.post('/key-bundles/:id/return',requirePermission('keys:bundle_return',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{const body=bundleReturnBody.parse(req.body);const result=await bundleMovement(req,String(req.params.id),'return',body);res.json(result.response);}catch(error){if(error instanceof z.ZodError)return badRequest(res);next(error);}
});
