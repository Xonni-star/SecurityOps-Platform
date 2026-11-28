import {Router,Request,Response,NextFunction} from 'express';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {query,withTransaction} from '../db/pool.js';
import {requireAuth,requireCsrf,requirePermission} from '../middleware/auth.js';
import {logger} from '../middleware/errors.js';
import {recordAudit} from '../services/audit.js';
import {BlobStorageAdapter,MalwareScannerAdapter,configuredDmsBackupContract,createDmsAdapters,sha256} from '../services/dms-providers.js';
import {canAccessResource,effectivePermissionScope,normalizePermissionGrants} from '../types/authorization.js';
import {runIdempotentMutation,setIdempotentMutationResponse} from '../services/offline-sync.js';
import {env} from '../config/env.js';
import {canDownloadDmsVersion,nextDmsVersion,retentionDue,scanLifecycle,validateDmsUpload} from '../services/dms-domain.js';
import {classifyDocument,documentStatusCounts,expiryBucket} from '../services/dms-document-status.js';

const uuid=z.string().uuid();
const allowedTypes=new Set(env.DMS_ALLOWED_CONTENT_TYPES.split(',').map(value=>value.trim()).filter(Boolean));
const adapters=createDmsAdapters();
export let dmsStorage:BlobStorageAdapter=adapters.storage;
export let dmsScanner:MalwareScannerAdapter=adapters.scanner;
export function configureDmsAdapters(storage:BlobStorageAdapter,scanner:MalwareScannerAdapter){dmsStorage=storage;dmsScanner=scanner;}

export async function dmsReadiness(){
  try{
    await Promise.all([dmsStorage.ready?.(),dmsScanner.ready?.()]);
    return {status:'ready' as const};
  }catch(error){
    // Nur Fehlerklasse und Nachricht, niemals Zugangsdaten oder Bucket-Inhalte.
    logger.error({event:'dms.readiness.failed',message:error instanceof Error?error.message:String(error)},'DMS readiness check failed');
    throw Object.assign(new Error('DMS-Speicher oder Virenscanner ist nicht bereit'),{status:503,expose:true});
  }
}

function scanFailureDetails(error:unknown){
  return error instanceof Error?error.message:String(error);
}

function session(req:Request){if(!req.sessionDbId)throw Object.assign(new Error('Session-Identität fehlt.'),{status:401});return req.sessionDbId;}
function customerDocumentPermission(req:Request,permission:'customer_documents:read'|'customer_documents:write'){
  const scope=effectivePermissionScope(normalizePermissionGrants(req.user!.permissionGrants,req.user!.permissions),permission,{role:req.user!.role,isSystemAdmin:req.user!.isSystemAdmin===true});
  return scope==='tenant'||scope==='system';
}
function siteAccess(req:Request,siteId:string|null,permission='dms:read'){
  const user=req.user!;
  const scope=effectivePermissionScope(normalizePermissionGrants(user.permissionGrants,user.permissions),permission,{role:user.role,isSystemAdmin:user.isSystemAdmin===true});
  if(!scope||!canAccessResource({userId:user.id,tenantId:user.tenantId,role:user.role,isSystemAdmin:user.isSystemAdmin===true,siteIds:user.siteIds??[],grants:normalizePermissionGrants(user.permissionGrants,user.permissions)},scope,{tenantId:user.tenantId,siteId}))throw Object.assign(new Error('Unzureichende Berechtigungen für diesen Dokumentbereich'),{status:403});
}
function decodeContent(value:unknown){
  if(typeof value!=='string'||!/^[A-Za-z0-9+/]*={0,2}$/.test(value)||value.length%4!==0)throw Object.assign(new Error('content_base64 muss gültiges Base64 sein'),{status:400});
  const content=Buffer.from(value,'base64');
  if(!content.length)throw Object.assign(new Error('Dokumentinhalt darf nicht leer sein'),{status:400});
  return content;
}
function safeFilename(title:string,versionNo:number,contentType:string){
  const extensions:Record<string,string>={
    'application/pdf':'pdf','image/jpeg':'jpg','image/png':'png','image/webp':'webp','text/plain':'txt',
  };
  const extension=extensions[contentType]??'bin';
  return `${title.replace(/[^a-zA-Z0-9._-]+/g,'_').slice(0,120)||'dokument'}-v${versionNo}.${extension}`;
}

// Download und Preview teilen sich exakt dieselben Zugriffs-, Freigabe- und
// Integritätsprüfungen. Ein Preview darf niemals eine ungeprüfte oder
// nicht freigegebene Version sichtbar machen.
async function loadDmsVersionForRead(req:Request,res:Response,documentId:string,versionId:string,action:'dms.document.downloaded'|'dms.document.previewed'){
  const row=(await query(`SELECT d.*,v.* FROM dms_documents d JOIN dms_versions v ON v.tenant_id=d.tenant_id AND v.document_id=d.id
    WHERE d.tenant_id=$1 AND d.id=$2 AND v.id=$3 AND d.document_status='active'`,[req.user!.tenantId,documentId,versionId])).rows[0];
  if(!row){res.status(404).json({error:'Dokumentversion nicht gefunden'});return null;}
  // Freigabe ist dokumentweit verbindlich: eine gescannte, aber nicht
  // freigegebene Version darf auch mit dms:read nicht gelesen werden.
  if(row.approval_status!=='approved'){res.status(409).json({error:'Dokument ist nicht freigegeben',state:row.approval_status});return null;}
  if(row.customer_id&&!customerDocumentPermission(req,'customer_documents:read')){res.status(403).json({error:'Unzureichende Berechtigungen für Kundendokumente'});return null;}
  siteAccess(req,row.site_id??null);
  if(!canDownloadDmsVersion(row.document_status,row.lifecycle_state)){res.status(409).json({error:'Dokumentversion ist nicht verfügbar',state:row.lifecycle_state});return null;}
  const blob=await dmsStorage.get(row.object_key);
  if(blob.content.byteLength!==Number(row.size_bytes)||sha256(blob.content)!==row.sha256){res.status(502).json({error:'Integritätsprüfung des Blobs fehlgeschlagen'});return null;}
  // Erfolgreiche Zugriffe auf vertrauliche Fassungen sind revisionspflichtig.
  await recordAudit(req.user!.tenantId,req.user!.id,action,'dms_version',row.id,{
    document_id:row.document_id,version_no:row.version_no,sha256:row.sha256,
    customer_id:row.customer_id??null,site_id:row.site_id??null,
  }).catch(()=>undefined);
  return {row,blob};
}
function dmsVersionIds(req:Request){return z.object({documentId:uuid,versionId:uuid}).safeParse(req.params);}

const dmsApprovalStatuses=['draft','pending_approval','approved','rejected','archived'] as const;
const dmsScanStatuses=['quarantined','scanning','available','rejected','deleted','missing'] as const;
const dmsValidityFilters=['valid','expiring','expired','not_yet_valid','undefined'] as const;
const dmsSortFields=['created_at','updated_at','title','document_number','valid_until','review_on'] as const;
const booleanParam=z.enum(['true','false']).transform(value=>value==='true');
const dmsListQuery=z.object({
  q:z.string().trim().max(200).optional(),
  site_id:uuid.optional(),customer_id:uuid.optional(),employee_id:uuid.optional(),
  responsible_employee_id:uuid.optional(),device_id:uuid.optional(),nfc_device_id:uuid.optional(),
  document_type:z.string().trim().max(160).optional(),document_number:z.string().trim().max(100).optional(),
  approval_status:z.enum(dmsApprovalStatuses).optional(),scan_status:z.enum(dmsScanStatuses).optional(),
  validity:z.enum(dmsValidityFilters).optional(),
  created_from:z.string().date().optional(),created_to:z.string().date().optional(),
  expiry_from:z.string().date().optional(),expiry_to:z.string().date().optional(),
  sort:z.enum(dmsSortFields).optional(),order:z.enum(['asc','desc']).optional(),
  page:z.coerce.number().int().min(1).max(100000).optional(),
  page_size:z.coerce.number().int().min(1).max(100).optional(),
  include_deleted:booleanParam.optional(),
}).strict();

function hasTenantOrSystem(req:Request,permission:string){
  const scope=effectivePermissionScope(
    normalizePermissionGrants(req.user!.permissionGrants,req.user!.permissions),
    permission,{role:req.user!.role,isSystemAdmin:req.user!.isSystemAdmin===true},
  );
  return scope==='tenant'||scope==='system';
}

function matchesValidity(row:Record<string,unknown>,validity:(typeof dmsValidityFilters)[number]):boolean{
  const days=row.days_until_expiry;
  switch(validity){
    case 'valid':return row.computed_status==='gueltig';
    case 'expiring':return typeof days==='number'&&days>=0&&days<=30;
    case 'expired':return row.computed_status==='abgelaufen'||(typeof days==='number'&&days<0);
    case 'not_yet_valid':return row.computed_status==='noch_nicht_gueltig';
    case 'undefined':return days===null||days===undefined;
    default:return true;
  }
}

/** Einzige, autorisierte Dokumentabfrage für Liste, Kennzahlen und Freigaben.
 *  Alle Filter werden serverseitig validiert; Mandanten-, Objekt- und
 *  Kundengrenzen gelten unabhängig von der UI. */
async function loadDmsDocuments(req:Request,rawQuery:unknown){
  const parsed=dmsListQuery.safeParse(rawQuery);
  if(!parsed.success)throw Object.assign(new Error('Ungültige Dokumentfilter'),{status:400,expose:true});
  const filters=parsed.data;
  const user=req.user!;
  const scope=effectivePermissionScope(
    normalizePermissionGrants(user.permissionGrants,user.permissions),
    'dms:read',{role:user.role,isSystemAdmin:user.isSystemAdmin===true},
  );
  const values:unknown[]=[user.tenantId];
  const where=['d.tenant_id=$1'];
  const param=(value:unknown)=>{values.push(value);return `$${values.length}`;};
  if(scope==='site')where.push(`d.site_id = ANY(${param(user.siteIds??[])}::uuid[])`);
  if(!customerDocumentPermission(req,'customer_documents:read'))where.push('d.customer_id IS NULL');
  if(!(filters.include_deleted===true&&hasTenantOrSystem(req,'dms:delete')))where.push("d.document_status='active'");

  for(const [key,column] of [
    ['site_id','site_id'],['customer_id','customer_id'],['employee_id','employee_id'],
    ['responsible_employee_id','responsible_employee_id'],['device_id','device_id'],['nfc_device_id','nfc_device_id'],
  ] as const){
    const value=filters[key];
    if(value)where.push(`d.${column}=${param(value)}`);
  }
  if(filters.document_type)where.push(`d.document_type=${param(filters.document_type)}`);
  if(filters.document_number)where.push(`d.document_number=${param(filters.document_number)}`);
  if(filters.approval_status)where.push(`d.approval_status=${param(filters.approval_status)}`);
  if(filters.scan_status){
    if(filters.scan_status==='missing')where.push('NOT EXISTS (SELECT 1 FROM dms_versions sv WHERE sv.tenant_id=d.tenant_id AND sv.document_id=d.id)');
    else where.push(`(SELECT sv.lifecycle_state FROM dms_versions sv WHERE sv.tenant_id=d.tenant_id AND sv.document_id=d.id ORDER BY sv.version_no DESC LIMIT 1)=${param(filters.scan_status)}`);
  }
  if(filters.created_from)where.push(`d.created_at::date>=${param(filters.created_from)}`);
  if(filters.created_to)where.push(`d.created_at::date<=${param(filters.created_to)}`);
  if(filters.expiry_from)where.push(`d.valid_until>=${param(filters.expiry_from)}`);
  if(filters.expiry_to)where.push(`d.valid_until<=${param(filters.expiry_to)}`);
  if(filters.q){
    const needle=`%${filters.q}%`;
    const p=param(needle);
    where.push(`(d.title ILIKE ${p} OR COALESCE(d.document_number,'') ILIKE ${p} OR COALESCE(d.description,'') ILIKE ${p}
      OR COALESCE(d.document_type,'') ILIKE ${p}
      OR EXISTS (SELECT 1 FROM dms_versions sv WHERE sv.tenant_id=d.tenant_id AND sv.document_id=d.id AND sv.content_type ILIKE ${p})
      OR COALESCE((SELECT s.name FROM sites s WHERE s.tenant_id=d.tenant_id AND s.id=d.site_id),'') ILIKE ${p}
      OR COALESCE((SELECT c.name FROM customers c WHERE c.tenant_id=d.tenant_id AND c.id=d.customer_id),'') ILIKE ${p}
      OR COALESCE((SELECT e.name FROM employees e WHERE e.tenant_id=d.tenant_id AND e.id=d.employee_id),'') ILIKE ${p})`);
  }

  const sortColumn={
    created_at:'d.created_at',updated_at:'d.updated_at',title:'d.title',
    document_number:'d.document_number',valid_until:'d.valid_until',review_on:'d.review_on',
  }[filters.sort??'created_at'];
  const direction=filters.order==='asc'?'ASC':'DESC';
  const rows=(await query(`SELECT d.*,
    COALESCE(json_agg(json_build_object(
      'id',v.id,'version_no',v.version_no,'size_bytes',v.size_bytes,'content_type',v.content_type,
      'sha256',v.sha256,'lifecycle_state',v.lifecycle_state,'rejection_reason',v.rejection_reason,
      'created_at',v.created_at,'scanned_at',v.scanned_at,'uploaded_by',v.uploaded_by,
      'retention_until',v.retention_until,'deleted_at',v.deleted_at
    ) ORDER BY v.version_no DESC) FILTER (WHERE v.id IS NOT NULL),'[]') versions,
    (SELECT s.name FROM sites s WHERE s.tenant_id=d.tenant_id AND s.id=d.site_id) site_name,
    (SELECT c.name FROM customers c WHERE c.tenant_id=d.tenant_id AND c.id=d.customer_id) customer_name,
    (SELECT e.name FROM employees e WHERE e.tenant_id=d.tenant_id AND e.id=d.employee_id) employee_name,
    (SELECT e.name FROM employees e WHERE e.tenant_id=d.tenant_id AND e.id=d.responsible_employee_id) responsible_employee_name,
    (SELECT e.email FROM users e WHERE e.id=d.created_by) created_by_email
    FROM dms_documents d LEFT JOIN dms_versions v ON v.tenant_id=d.tenant_id AND v.document_id=d.id
    WHERE ${where.join(' AND ')}
    GROUP BY d.id ORDER BY ${sortColumn} ${direction} NULLS LAST, d.id DESC`,values)).rows;

  const classified=rows.map((row:Record<string,unknown>)=>{
    const versions=(row.versions as Array<Record<string,unknown>>)??[];
    return {...row,...classifyDocument(row),current_version:versions[0]??null,scan_status:versions[0]?.lifecycle_state??'missing'};
  });
  const filtered=filters.validity?classified.filter(row=>matchesValidity(row,filters.validity!)):classified;
  const page=filters.page??1;
  const pageSize=filters.page_size??25;
  return {rows:filtered,filtered,total:filtered.length,page,page_size:pageSize,pages:Math.max(1,Math.ceil(filtered.length/pageSize)),filters};
}

function dmsStats(rows:Array<Record<string,unknown>>){
  const counts=documentStatusCounts(rows);
  const by=(key:string,value:unknown)=>rows.filter(row=>row[key]===value).length;
  return {
    total:rows.length,
    approved:by('approval_status','approved'),
    draft:by('approval_status','draft'),
    pending_approval:by('approval_status','pending_approval'),
    returned:by('approval_status','rejected'),
    archived:by('approval_status','archived'),
    expired:counts.abgelaufen,
    expiring_30d:rows.filter(row=>{const days=row.days_until_expiry;return typeof days==='number'&&days>=0&&days<=30;}).length,
    missing_file:rows.filter(row=>row.has_available_version!==true).length,
    scan_pending:rows.filter(row=>row.scan_status==='scanning'||row.scan_status==='quarantined').length,
    quarantined:rows.filter(row=>row.scan_status==='quarantined').length,
    review_due:rows.filter(row=>row.review_state==='overdue'||row.review_state==='due_soon').length,
  };
}

function dmsFilterOptions(rows:Array<Record<string,unknown>>){
  const unique=(key:string)=>Array.from(new Set(rows.map(row=>row[key]).filter((item):item is string=>typeof item==='string'&&item.length>0))).sort((a,b)=>a.localeCompare(b,'de-DE'));
  const named=(idKey:string,nameKey:string)=>{
    const seen=new Map<string,{id:string;name:string}>();
    for(const row of rows){
      const id=row[idKey];const name=row[nameKey];
      if(typeof id==='string'&&typeof name==='string'&&name.length>0&&!seen.has(id))seen.set(id,{id,name});
    }
    return Array.from(seen.values()).sort((a,b)=>a.name.localeCompare(b.name,'de-DE'));
  };
  return {
    sites:named('site_id','site_name'),customers:named('customer_id','customer_name'),
    employees:named('employee_id','employee_name'),responsible_employees:named('responsible_employee_id','responsible_employee_name'),
    types:unique('document_type'),document_numbers:unique('document_number'),
  };
}

async function dmsDocumentForAction(req:Request,documentId:string,permission:'dms:write'|'dms:delete'){
  const document=(await query('SELECT * FROM dms_documents WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,documentId])).rows[0];
  if(!document)throw Object.assign(new Error('Dokument nicht gefunden'),{status:404,expose:true});
  if(document.document_status!=='active')throw Object.assign(new Error('Dokument ist gelöscht'),{status:409,expose:true});
  siteAccess(req,document.site_id??null,permission==='dms:delete'?'dms:write':permission);
  if(document.customer_id&&!customerDocumentPermission(req,permission==='dms:delete'?'customer_documents:write':'customer_documents:write')){
    throw Object.assign(new Error('Unzureichende Berechtigungen für Kundendokumente'),{status:403,expose:true});
  }
  return document;
}

export const dmsRouter=Router();
dmsRouter.use((req,res,next)=>/^\/dms/.test(req.path)?requireAuth(req,res,()=>['POST','PATCH','PUT','DELETE'].includes(req.method)?requireCsrf(req,res,next):next()):next());

dmsRouter.get('/dms/documents',requirePermission('dms:read',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const result=await loadDmsDocuments(req,req.query);
    // Bestehende Aufrufer erhalten weiterhin ein Array; neue Filter und
    // abgeleitete Statusfelder sind additiv.
    res.json(result.rows);
  }catch(error){next(error);}
});

dmsRouter.get('/dms/documents/query',requirePermission('dms:read',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const result=await loadDmsDocuments(req,req.query);
    const start=(result.page-1)*result.page_size;
    res.json({
      rows:result.filtered.slice(start,start+result.page_size),
      total:result.total,page:result.page,pages:result.pages,page_size:result.page_size,
      stats:dmsStats(result.rows),filter_options:dmsFilterOptions(result.rows),filters:result.filters,
    });
  }catch(error){next(error);}
});

dmsRouter.get('/dms/overview',requirePermission('dms:read',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const result=await loadDmsDocuments(req,req.query);
    res.json({
      stats:dmsStats(result.rows),
      filter_options:dmsFilterOptions(result.rows),
      approvals:result.rows.filter((row:Record<string,unknown>)=>row.approval_status==='pending_approval').map((row:Record<string,unknown>)=>({
        id:row.id,title:row.title,document_type:row.document_type??null,
        created_by_email:row.created_by_email??null,site_name:row.site_name??null,
        customer_name:row.customer_name??null,created_at:row.created_at,
        current_version:row.current_version??null,scan_status:row.scan_status,
      })),
    });
  }catch(error){next(error);}
});

dmsRouter.post('/dms/documents',requirePermission('dms:write',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const body=z.object({
      title:z.string().trim().min(1).max(240),
      description:z.string().max(4000).nullable().optional(),
      site_id:uuid.nullable().optional(),
      device_id:uuid.nullable().optional(),
      nfc_device_id:uuid.nullable().optional(),
      employee_id:uuid.nullable().optional(),
      customer_id:uuid.nullable().optional(),
      employee_document_category:z.enum(['contract','qualification','training','instruction','personal','other']).nullable().optional(),
      customer_document_category:z.enum(['contract','service','insurance','security_plan','correspondence','other']).nullable().optional(),
      document_number:z.string().trim().max(100).nullable().optional(),
      document_type:z.string().trim().max(160).nullable().optional(),
      responsible_employee_id:uuid.nullable().optional(),
      location_id:uuid.nullable().optional(),
      valid_from:z.string().date().nullable().optional(),
      valid_until:z.string().date().nullable().optional(),
      review_on:z.string().date().nullable().optional(),
      content_base64:z.string(),
      content_type:z.string().trim().min(1).max(160),
      retention_until:z.string().datetime({offset:true}).nullable().optional(),
      client_mutation_id:uuid,
    }).strict().refine(value=>
      Boolean(value.customer_id)===Boolean(value.customer_document_category)
      && !(value.customer_id&&value.employee_id)
      && !(value.device_id&&value.nfc_device_id)
    ).refine(value=>!value.valid_from||!value.valid_until||value.valid_until>=value.valid_from).parse(req.body);
    let documentSiteId=body.site_id??null;
    if(body.device_id){
      const device=(await query('SELECT id,site_id FROM devices WHERE tenant_id=$1 AND id=$2 AND device_kind=\'operational\'',[req.user!.tenantId,body.device_id])).rows[0];
      if(!device)throw Object.assign(new Error('Gerät nicht gefunden'),{status:404});
      if(body.site_id&&device.site_id!==body.site_id)throw Object.assign(new Error('Objekt des Dokuments entspricht nicht dem Gerät'),{status:400});
      documentSiteId=device.site_id??null;
    }
    if(body.nfc_device_id){
      const device=(await query(`SELECT n.id,n.site_id,cp.site_id control_point_site_id FROM nfc_devices n
        LEFT JOIN control_points cp ON cp.tenant_id=n.tenant_id AND cp.id=n.control_point_id
        WHERE n.tenant_id=$1 AND n.id=$2`,[req.user!.tenantId,body.nfc_device_id])).rows[0];
      if(!device)throw Object.assign(new Error('NFC-Gerät nicht gefunden'),{status:404});
      const deviceSiteId=(device.site_id??device.control_point_site_id??null) as string|null;
      if(body.site_id&&deviceSiteId&&deviceSiteId!==body.site_id)throw Object.assign(new Error('Objekt des Dokuments entspricht nicht dem NFC-Gerät'),{status:400});
      documentSiteId=deviceSiteId??documentSiteId;
    }
    siteAccess(req,documentSiteId,'dms:write');
    if(body.customer_id){
      if(!customerDocumentPermission(req,'customer_documents:write'))throw Object.assign(new Error('Unzureichende Berechtigungen für Kundendokumente'),{status:403});
      const customer=(await query('SELECT id FROM customers WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,body.customer_id])).rows[0];
      if(!customer)throw Object.assign(new Error('Kunde nicht gefunden'),{status:404});
      if(documentSiteId&&!((await query('SELECT site_id FROM customer_sites WHERE tenant_id=$1 AND customer_id=$2 AND site_id=$3',[req.user!.tenantId,body.customer_id,documentSiteId])).rows[0]))throw Object.assign(new Error('Objekt des Dokuments muss zum Kunden gehören'),{status:400});
    }
    if(body.employee_id){
      const employee=(await query('SELECT id FROM employees WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,body.employee_id])).rows[0];
      if(!employee)throw Object.assign(new Error('Mitarbeiter nicht gefunden'),{status:404});
    }
    if(body.responsible_employee_id){
      const employee=(await query('SELECT id FROM employees WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,body.responsible_employee_id])).rows[0];
      if(!employee)throw Object.assign(new Error('Verantwortlicher Mitarbeiter nicht gefunden'),{status:404});
    }
    if(body.location_id){
      if(!documentSiteId)throw Object.assign(new Error('Für den Bereich ist ein Objekt erforderlich'),{status:400});
      const location=(await query('SELECT id FROM object_locations WHERE tenant_id=$1 AND site_id=$2 AND id=$3',[req.user!.tenantId,documentSiteId,body.location_id])).rows[0];
      if(!location)throw Object.assign(new Error('Objektbereich nicht gefunden'),{status:404});
    }
    const content=decodeContent(body.content_base64);
    const maxBytes=env.DMS_MAX_BYTES;
    validateDmsUpload(content,body.content_type,maxBytes,allowedTypes);
    const documentId=randomUUID();const versionId=randomUUID();const objectKey=`${req.user!.tenantId}/${documentId}/${versionId}`;
    await dmsStorage.put(objectKey,content,body.content_type);
    type UploadReceipt={document:Record<string,unknown>;version:Record<string,unknown>;state?:'rejected'|'scan_provider_error';error?:string;signature?:string|null};
    const receiptInput={tenantId:req.user!.tenantId,userId:req.user!.id,mutationId:body.client_mutation_id,action:'dms.document' as const,payload:req.body};
    try{
      const result=await withTransaction(client=>runIdempotentMutation<UploadReceipt>(client,receiptInput,async tx=>{
        const document=(await tx.query(`INSERT INTO dms_documents(id,tenant_id,site_id,employee_id,employee_document_category,customer_id,customer_document_category,title,description,document_number,document_type,responsible_employee_id,location_id,valid_from,valid_until,review_on,approval_status,created_by,created_session_id,device_id,nfc_device_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING *`,
          [documentId,req.user!.tenantId,documentSiteId,body.employee_id??null,body.employee_document_category??null,body.customer_id??null,body.customer_document_category??null,body.title,body.description??null,body.document_number??null,body.document_type??null,body.responsible_employee_id??null,body.location_id??null,body.valid_from??null,body.valid_until??null,body.review_on??null,'draft',req.user!.id,session(req),body.device_id??null,body.nfc_device_id??null])).rows[0];
        const version=(await tx.query(`INSERT INTO dms_versions(id,tenant_id,document_id,version_no,object_key,size_bytes,content_type,sha256,lifecycle_state,uploaded_by,uploaded_session_id,uploaded_device_id,retention_until)
          VALUES($1,$2,$3,1,$4,$5,$6,$7,'quarantined',$8,$9,(SELECT device_id FROM sessions WHERE id=$9),$10) RETURNING *`,
          [versionId,req.user!.tenantId,documentId,objectKey,content.byteLength,body.content_type,sha256(content),req.user!.id,session(req),body.retention_until??null])).rows[0];
        return {document,version};
      }));
      if(result.replayed){
        await dmsStorage.delete(objectKey).catch(()=>undefined);
        if(result.response.state==='scan_provider_error')return res.status(502).json(result.response);
        if(result.response.state==='rejected')return res.status(422).json(result.response);
        return res.status(200).json(result.response);
      }
      await query(`UPDATE dms_versions SET lifecycle_state='scanning' WHERE tenant_id=$1 AND id=$2`,[req.user!.tenantId,versionId]);
      let scan;
      try{scan=await dmsScanner.scan(content);}catch(error){
        const rejected=(await query(`UPDATE dms_versions SET lifecycle_state='rejected',rejection_reason=$3,scanned_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *`,[req.user!.tenantId,versionId,'scan_provider_error'])).rows[0];
        const failed:UploadReceipt={document:result.response.document,version:rejected,state:'scan_provider_error',error:'Virenscan-Anbieter ist nicht erreichbar. Das Dokument wurde nicht freigegeben.'};
        await withTransaction(tx=>setIdempotentMutationResponse(tx,receiptInput,failed)).catch(()=>undefined);
        await recordAudit(req.user!.tenantId,req.user!.id,'dms.scan.provider_error','dms_version',versionId,
          {document_id:documentId,host:env.CLAMAV_HOST,port:env.CLAMAV_PORT,reason:scanFailureDetails(error)}).catch(()=>undefined);
        logger.error({event:'dms.scan.provider_error',version_id:versionId,host:env.CLAMAV_HOST,port:env.CLAMAV_PORT,message:scanFailureDetails(error)},'DMS malware scan provider failed');
        throw Object.assign(new Error(failed.error),{status:502,expose:true,cause:error});
      }
      const lifecycle=scanLifecycle(scan);
      if(lifecycle.state==='rejected'){
        const rejected=(await query(`UPDATE dms_versions SET lifecycle_state='rejected',rejection_reason=$3,scanned_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *`,[req.user!.tenantId,versionId,lifecycle.rejectionReason])).rows[0];
        const failed:UploadReceipt={document:result.response.document,version:rejected,state:'rejected',error:'Dokument durch Virenscan abgelehnt',signature:scan.signature??null};
        await withTransaction(tx=>setIdempotentMutationResponse(tx,receiptInput,failed)).catch(()=>undefined);
        await dmsStorage.delete(objectKey);
        await recordAudit(req.user!.tenantId,req.user!.id,'dms.scan.rejected','dms_version',versionId,
          {document_id:documentId,signature:scan.signature??null,sha256:sha256(content)}).catch(()=>undefined);
        return res.status(422).json(failed);
      }
      const available=(await query(`UPDATE dms_versions SET lifecycle_state='available',scanned_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *`,[req.user!.tenantId,versionId])).rows[0];
      const finalResponse:UploadReceipt={...result.response,version:available};
      await withTransaction(tx=>setIdempotentMutationResponse(tx,receiptInput,finalResponse)).catch(()=>undefined);
      await recordAudit(req.user!.tenantId,req.user!.id,'dms.document.uploaded','dms_document',documentId,{version_id:versionId,sha256:available.sha256,size_bytes:available.size_bytes,customer_id:body.customer_id??null});
      return res.status(201).json(finalResponse);
    }catch(error){await dmsStorage.delete(objectKey).catch(()=>undefined);throw error;}
  }catch(error){next(error);}
});

dmsRouter.patch('/dms/documents/:documentId',requireCsrf,requirePermission('dms:write',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const documentId=uuid.parse(String(req.params.documentId));
    const body=z.object({
      title:z.string().trim().min(1).max(240).optional(),
      description:z.string().max(4000).nullable().optional(),
      document_number:z.string().trim().max(100).nullable().optional(),
      document_type:z.string().trim().max(160).nullable().optional(),
      responsible_employee_id:uuid.nullable().optional(),
      location_id:uuid.nullable().optional(),
      device_id:uuid.nullable().optional(),
      nfc_device_id:uuid.nullable().optional(),
      valid_from:z.string().date().nullable().optional(),
      valid_until:z.string().date().nullable().optional(),
      review_on:z.string().date().nullable().optional(),
    }).strict().refine(value=>Object.keys(value).length>0).refine(value=>!value.valid_from||!value.valid_until||value.valid_until>=value.valid_from).parse(req.body);
    const document=(await query('SELECT * FROM dms_documents WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,documentId])).rows[0];
    if(!document)return res.status(404).json({error:'Dokument nicht gefunden'});
    if(document.document_status!=='active')return res.status(409).json({error:'Gelöschte Dokumente können nicht bearbeitet werden'});
    siteAccess(req,document.site_id,'dms:write');
    if(document.customer_id&&!customerDocumentPermission(req,'customer_documents:write'))return res.status(403).json({error:'Unzureichende Berechtigungen für Kundendokumente'});
    if(body.responsible_employee_id){
      const employee=(await query('SELECT id FROM employees WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,body.responsible_employee_id])).rows[0];
      if(!employee)return res.status(400).json({error:'Verantwortlicher Mitarbeiter nicht gefunden'});
    }
    if(body.location_id){
      const location=(await query('SELECT id FROM object_locations WHERE tenant_id=$1 AND site_id=$2 AND id=$3',[req.user!.tenantId,document.site_id,body.location_id])).rows[0];
      if(!location)return res.status(400).json({error:'Objektbereich nicht gefunden'});
    }
    if(body.device_id){
      const device=(await query('SELECT id,site_id FROM devices WHERE tenant_id=$1 AND id=$2 AND device_kind=\'operational\'',[req.user!.tenantId,body.device_id])).rows[0];
      if(!device)return res.status(400).json({error:'Gerät nicht gefunden'});
      if(document.site_id&&device.site_id!==document.site_id)return res.status(400).json({error:'Gerät gehört zu einem anderen Objekt'});
    }
    if(body.nfc_device_id){
      const device=(await query(`SELECT n.id,n.site_id,cp.site_id control_point_site_id FROM nfc_devices n
        LEFT JOIN control_points cp ON cp.tenant_id=n.tenant_id AND cp.id=n.control_point_id
        WHERE n.tenant_id=$1 AND n.id=$2`,[req.user!.tenantId,body.nfc_device_id])).rows[0];
      if(!device)return res.status(400).json({error:'NFC-Gerät nicht gefunden'});
      const deviceSiteId=(device.site_id??device.control_point_site_id??null) as string|null;
      if(document.site_id&&deviceSiteId&&deviceSiteId!==document.site_id)return res.status(400).json({error:'NFC-Gerät gehört zu einem anderen Objekt'});
    }
    const columns:Record<string,string>={title:'title',description:'description',document_number:'document_number',document_type:'document_type',responsible_employee_id:'responsible_employee_id',location_id:'location_id',device_id:'device_id',nfc_device_id:'nfc_device_id',valid_from:'valid_from',valid_until:'valid_until',review_on:'review_on'};
    const entries=Object.entries(body);
    const assignments=entries.map(([key],index)=>`${columns[key]}=$${index+3}`).join(',');
    const row=(await query(
      `UPDATE dms_documents SET ${assignments},updated_at=now()
       WHERE tenant_id=$1 AND id=$2 RETURNING *`,
      [req.user!.tenantId,documentId,...entries.map(([,value])=>value)],
    )).rows[0];
    await recordAudit(req.user!.tenantId,req.user!.id,'dms.document.updated','dms_document',documentId,{changed_fields:Object.keys(body),nfc_device_id:body.nfc_device_id??document.nfc_device_id??null});
    res.json(row);
  }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Ungültige Dokumentmetadaten'});next(error);}
});

dmsRouter.post('/dms/documents/:documentId/request-review',requirePermission('dms:write',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const documentId=uuid.parse(String(req.params.documentId));
    const document=(await query('SELECT * FROM dms_documents WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,documentId])).rows[0];
    if(!document)return res.status(404).json({error:'Dokument nicht gefunden'});
    siteAccess(req,document.site_id??null,'dms:write');
    if(document.customer_id&&!customerDocumentPermission(req,'customer_documents:write'))return res.status(403).json({error:'Unzureichende Berechtigungen für Kundendokumente'});
    if(document.document_status!=='active'||!['draft','rejected'].includes(document.approval_status))return res.status(409).json({error:'Dokument kann nicht zur Prüfung eingereicht werden'});
    const row=(await query(`UPDATE dms_documents SET approval_status='pending_approval',reviewed_at=NULL,approval_feedback=NULL,updated_at=now()
      WHERE tenant_id=$1 AND id=$2 AND document_status='active' AND approval_status IN ('draft','rejected') RETURNING *`,[req.user!.tenantId,documentId])).rows[0];
    if(!row)return res.status(409).json({error:'Dokument wurde zwischenzeitlich geändert'});
    await recordAudit(req.user!.tenantId,req.user!.id,'dms.document.review_requested','dms_document',documentId,{previous_status:document.approval_status});
    res.json({...row,...classifyDocument(row)});
  }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Ungültige Dokument-ID'});next(error);}
});

dmsRouter.post('/dms/documents/:documentId/approve',requirePermission('dms:write',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const documentId=uuid.parse(String(req.params.documentId));
    const body=z.object({feedback:z.string().trim().max(2000).nullable().optional()}).strict().parse(req.body??{});
    const document=(await query('SELECT * FROM dms_documents WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,documentId])).rows[0];
    if(!document)return res.status(404).json({error:'Dokument nicht gefunden'});
    siteAccess(req,document.site_id??null,'dms:write');
    if(document.customer_id&&!customerDocumentPermission(req,'customer_documents:write'))return res.status(403).json({error:'Unzureichende Berechtigungen für Kundendokumente'});
    // Freigabe und Versions-Upload teilen sich dieselbe Sperre. Damit kann eine
    // parallele neue Version nicht unter dem alten Freigabestempel erscheinen.
    const approved=await withTransaction(async tx=>{
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${req.user!.tenantId}:${documentId}`]);
      const current=(await tx.query('SELECT * FROM dms_documents WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[req.user!.tenantId,documentId])).rows[0];
      if(!current)throw Object.assign(new Error('Dokument nicht gefunden'),{status:404,expose:true});
      if(current.created_by===req.user!.id&&req.user!.isSystemAdmin!==true)throw Object.assign(new Error('Hochladende dürfen eigene Dokumente nicht freigeben'),{status:403,expose:true});
      if(current.document_status!=='active'||!['draft','pending_approval','rejected'].includes(current.approval_status))throw Object.assign(new Error('Dokument befindet sich nicht in einem freigabefähigen Status'),{status:409,expose:true});
      const latest=(await tx.query(`SELECT * FROM dms_versions WHERE tenant_id=$1 AND document_id=$2 AND lifecycle_state='available' ORDER BY version_no DESC LIMIT 1`,[req.user!.tenantId,documentId])).rows[0];
      if(!latest||latest.lifecycle_state!=='available')throw Object.assign(new Error('Für die Freigabe ist keine freigegebene Dokumentversion verfügbar'),{status:409,expose:true});
      const row=(await tx.query(`UPDATE dms_documents SET approval_status='approved',approved_by=$3,approved_at=now(),reviewed_at=now(),rejection_reason=NULL,updated_at=now()
        WHERE tenant_id=$1 AND id=$2 AND approval_status<>'approved'
          AND NOT EXISTS (SELECT 1 FROM dms_versions v WHERE v.tenant_id=$1 AND v.document_id=$2 AND v.version_no>$4 AND v.lifecycle_state='available')
        RETURNING *`,[req.user!.tenantId,documentId,req.user!.id,latest.version_no])).rows[0];
      if(!row)throw Object.assign(new Error('Dokument wurde zwischenzeitlich geändert'),{status:409,expose:true});
      return {row,latest,previous:current.approval_status};
    });
    await recordAudit(req.user!.tenantId,req.user!.id,'dms.document.approved','dms_document',documentId,{previous_status:approved.previous,feedback:body.feedback??null,version_no:approved.latest.version_no});
    const classifiable={...approved.row,versions:[approved.latest]};
    res.json({...classifiable,...classifyDocument(classifiable)});
  }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Ungültiger Freigabeantrag'});next(error);}
});

dmsRouter.post('/dms/documents/:documentId/return-for-revision',requirePermission('dms:write',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const documentId=uuid.parse(String(req.params.documentId));
    const body=z.object({reason:z.string().trim().min(1).max(2000)}).strict().parse(req.body);
    const document=(await query('SELECT * FROM dms_documents WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,documentId])).rows[0];
    if(!document)return res.status(404).json({error:'Dokument nicht gefunden'});
    siteAccess(req,document.site_id??null,'dms:write');
    if(document.customer_id&&!customerDocumentPermission(req,'customer_documents:write'))return res.status(403).json({error:'Unzureichende Berechtigungen für Kundendokumente'});
    if(document.created_by===req.user!.id&&req.user!.isSystemAdmin!==true)return res.status(403).json({error:'Hochladende dürfen über eigene Dokumente nicht entscheiden'});
    if(document.document_status!=='active'||!['pending_approval','approved'].includes(document.approval_status))return res.status(409).json({error:'Dokument kann nicht zur Überarbeitung zurückgegeben werden'});
    const row=(await query(`UPDATE dms_documents SET approval_status='rejected',approval_feedback=$3,rejection_reason=$3,reviewed_at=now(),approved_by=NULL,approved_at=NULL,updated_at=now()
      WHERE tenant_id=$1 AND id=$2 AND document_status='active' AND approval_status IN ('pending_approval','approved') RETURNING *`,[req.user!.tenantId,documentId,body.reason])).rows[0];
    if(!row)return res.status(409).json({error:'Dokument wurde zwischenzeitlich geändert'});
    await recordAudit(req.user!.tenantId,req.user!.id,'dms.document.returned_for_revision','dms_document',documentId,{previous_status:document.approval_status,reason:body.reason});
    res.json({...row,...classifyDocument(row)});
  }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Ungültiger Überarbeitungsantrag'});next(error);}
});

dmsRouter.post('/dms/documents/:documentId/versions',requirePermission('dms:write',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const documentId=uuid.parse(String(req.params.documentId));
    const document=(await query('SELECT * FROM dms_documents WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,documentId])).rows[0];
    if(!document)return res.status(404).json({error:'Dokument nicht gefunden'});
    if(document.document_status!=='active')return res.status(409).json({error:'Gelöschte Dokumente können keine neue Version erhalten'});
    if(document.customer_id&&!customerDocumentPermission(req,'customer_documents:write'))return res.status(403).json({error:'Unzureichende Berechtigungen für Kundendokumente'});
    siteAccess(req,document.site_id??null,'dms:write');
    const body=z.object({content_base64:z.string(),content_type:z.string().trim().min(1).max(160),retention_until:z.string().datetime({offset:true}).nullable().optional(),client_mutation_id:uuid}).strict().parse(req.body);
    const content=decodeContent(body.content_base64);validateDmsUpload(content,body.content_type,env.DMS_MAX_BYTES,allowedTypes);
    const versionId=randomUUID();const objectKey=`${req.user!.tenantId}/${documentId}/${versionId}`;await dmsStorage.put(objectKey,content,body.content_type);
    type VersionReceipt=Record<string,unknown>&{state?:'rejected'|'scan_provider_error';error?:string;signature?:string|null};
    const receiptInput={tenantId:req.user!.tenantId,userId:req.user!.id,mutationId:body.client_mutation_id,action:'dms.document.version' as const,payload:req.body};
    try{
      const result=await withTransaction(client=>runIdempotentMutation<VersionReceipt>(client,receiptInput,async tx=>{
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${req.user!.tenantId}:${documentId}`]);
        const locked=(await tx.query('SELECT id,document_status,approval_status FROM dms_documents WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[req.user!.tenantId,documentId])).rows[0];
        if(!locked||locked.document_status!=='active')throw Object.assign(new Error('Dokument nicht verfügbar'),{status:409,expose:true});
        const current=(await tx.query<{current:number|null}>('SELECT MAX(version_no) AS current FROM dms_versions WHERE tenant_id=$1 AND document_id=$2',[req.user!.tenantId,documentId])).rows[0]?.current;
        const version=(await tx.query(`INSERT INTO dms_versions(id,tenant_id,document_id,version_no,object_key,size_bytes,content_type,sha256,lifecycle_state,uploaded_by,uploaded_session_id,uploaded_device_id,retention_until)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,'quarantined',$9,$10,(SELECT device_id FROM sessions WHERE id=$10),$11) RETURNING *`,
          [versionId,req.user!.tenantId,documentId,nextDmsVersion(current??undefined),objectKey,content.byteLength,body.content_type,sha256(content),req.user!.id,session(req),body.retention_until??null])).rows[0];
        // Neue Inhalte dürfen nicht unter dem alten Freigabestempel veröffentlicht
        // werden: die Freigabe wird mit dem Anlegen der Version in derselben
        // Transaktion entzogen und muss erneut durch den Workflow erfolgen.
        const invalidated=(await tx.query(`UPDATE dms_documents
          SET approval_status='pending_approval',approved_by=NULL,approved_at=NULL,reviewed_at=NULL,
              approval_feedback=NULL,rejection_reason=NULL,updated_at=now()
          WHERE tenant_id=$1 AND id=$2 AND approval_status='approved' RETURNING id`,
          [req.user!.tenantId,documentId])).rows[0];
        return {...version,approval_invalidated:Boolean(invalidated)};
      }));
      if(result.replayed){
        await dmsStorage.delete(objectKey).catch(()=>undefined);
        if(result.response.state==='scan_provider_error')return res.status(502).json(result.response);
        if(result.response.state==='rejected')return res.status(422).json(result.response);
        return res.status(200).json(result.response);
      }
      if(result.response.approval_invalidated===true)await recordAudit(req.user!.tenantId,req.user!.id,'dms.document.approval_invalidated','dms_document',documentId,
        {reason:'new_version_uploaded',version_id:versionId});
      await query(`UPDATE dms_versions SET lifecycle_state='scanning' WHERE tenant_id=$1 AND id=$2`,[req.user!.tenantId,versionId]);
      let scan;
      try{scan=await dmsScanner.scan(content);}catch(error){
        const rejected=(await query(`UPDATE dms_versions SET lifecycle_state='rejected',rejection_reason='scan_provider_error',scanned_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *`,[req.user!.tenantId,versionId])).rows[0];
        const failed:VersionReceipt={...rejected,state:'scan_provider_error',error:'Virenscan-Anbieter ist nicht erreichbar. Die neue Version wurde nicht freigegeben.'};
        await withTransaction(tx=>setIdempotentMutationResponse(tx,receiptInput,failed)).catch(()=>undefined);
        await recordAudit(req.user!.tenantId,req.user!.id,'dms.scan.provider_error','dms_version',versionId,
          {document_id:documentId,host:env.CLAMAV_HOST,port:env.CLAMAV_PORT,reason:scanFailureDetails(error)}).catch(()=>undefined);
        logger.error({event:'dms.scan.provider_error',version_id:versionId,host:env.CLAMAV_HOST,port:env.CLAMAV_PORT,message:scanFailureDetails(error)},'DMS malware scan provider failed');
        throw Object.assign(new Error(failed.error),{status:502,expose:true,cause:error});
      }
      const lifecycle=scanLifecycle(scan);
      if(lifecycle.state==='rejected'){
        const rejected=(await query(`UPDATE dms_versions SET lifecycle_state='rejected',rejection_reason=$3,scanned_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *`,[req.user!.tenantId,versionId,lifecycle.rejectionReason])).rows[0];
        const failed:VersionReceipt={...rejected,state:'rejected',error:'Dokument durch Virenscan abgelehnt',signature:scan.signature??null};
        await withTransaction(tx=>setIdempotentMutationResponse(tx,receiptInput,failed)).catch(()=>undefined);
        await dmsStorage.delete(objectKey);
        await recordAudit(req.user!.tenantId,req.user!.id,'dms.scan.rejected','dms_version',versionId,
          {document_id:documentId,signature:scan.signature??null,sha256:sha256(content)}).catch(()=>undefined);
        return res.status(422).json(failed);
      }
      const available=(await query(`UPDATE dms_versions SET lifecycle_state='available',scanned_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *`,[req.user!.tenantId,versionId])).rows[0];
      const finalResponse:VersionReceipt={...available,approval_invalidated:result.response.approval_invalidated===true};
      await withTransaction(tx=>setIdempotentMutationResponse(tx,receiptInput,finalResponse)).catch(()=>undefined);
      await recordAudit(req.user!.tenantId,req.user!.id,'dms.version.uploaded','dms_version',versionId,{document_id:documentId,version_no:available.version_no});
      return res.status(201).json(finalResponse);
    }catch(error){await dmsStorage.delete(objectKey).catch(()=>undefined);throw error;}
  }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Ungültiger Versions-Upload'});next(error);}
});

dmsRouter.get('/dms/documents/:documentId/history',requirePermission('dms:read',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const documentId=uuid.parse(String(req.params.documentId));
    await dmsDocumentForAction(req,documentId,'dms:write');
    const rows=(await query(`SELECT a.id,a.event_type,a.entity_type,a.entity_id,a.details,a.created_at,
      u.email actor_email
      FROM audit_events a LEFT JOIN users u ON u.id=a.actor_user_id
      WHERE a.tenant_id=$1 AND a.event_type LIKE 'dms.%'
        AND (a.entity_id=$2 OR a.details->>'document_id'=$2::text)
      ORDER BY a.created_at DESC LIMIT 200`,[req.user!.tenantId,documentId])).rows;
    res.json(rows);
  }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Ungültige Dokument-ID'});next(error);}
});

async function changeDocumentState(req:Request,res:Response,next:NextFunction,target:'archive'|'restore'|'delete'){
  try{
    const documentId=uuid.parse(String(req.params.documentId));
    const permission=target==='delete'?'dms:delete':'dms:write';
    if(!hasTenantOrSystem(req,permission))throw Object.assign(new Error('Unzureichende Berechtigungen'),{status:403,expose:true});
    await dmsDocumentForAction(req,documentId,permission);
    let reason:string|null=null;
    if(target==='delete'){
      const body=z.object({reason:z.string().trim().min(1).max(1000)}).strict().parse(req.body??{});
      reason=body.reason;
    }
    const update=target==='archive'
      ? `approval_status='archived',approved_by=NULL,approved_at=NULL,reviewed_at=NULL,approval_feedback=NULL`
      : target==='restore'
        ? `approval_status='draft',approved_by=NULL,approved_at=NULL,reviewed_at=NULL,approval_feedback=NULL,rejection_reason=NULL`
        : `document_status='deleted',deleted_at=now(),approval_status='draft',approved_by=NULL,approved_at=NULL,reviewed_at=NULL`;
    const guard=target==='archive'?"approval_status<>'archived'":target==='restore'?"approval_status='archived'":"document_status='active'";
    const row=(await query(`UPDATE dms_documents SET ${update},updated_at=now()
      WHERE tenant_id=$1 AND id=$2 AND document_status='active' AND ${guard} RETURNING *`,[req.user!.tenantId,documentId])).rows[0];
    if(!row)throw Object.assign(new Error('Dokument befindet sich nicht im erwarteten Zustand'),{status:409,expose:true});
    const event=target==='archive'?'dms.document.archived':target==='restore'?'dms.document.restored':'dms.document.deleted';
    await recordAudit(req.user!.tenantId,req.user!.id,event,'dms_document',documentId,{reason});
    res.json({...row,...classifyDocument({...row,versions:[]})});
  }catch(error){
    if(error instanceof z.ZodError)return res.status(400).json({error:'Ungültiger Antrag'});
    next(error);
  }
}

dmsRouter.post('/dms/documents/:documentId/archive',requirePermission('dms:write',{allowedScopes:['tenant','site','system']}),(req,res,next)=>void changeDocumentState(req,res,next,'archive'));
dmsRouter.post('/dms/documents/:documentId/restore',requirePermission('dms:write',{allowedScopes:['tenant','site','system']}),(req,res,next)=>void changeDocumentState(req,res,next,'restore'));
dmsRouter.delete('/dms/documents/:documentId',requirePermission('dms:delete'),(req,res,next)=>void changeDocumentState(req,res,next,'delete'));

dmsRouter.get('/dms/documents/:documentId/versions/:versionId/download',requirePermission('dms:read',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    // "latest" ist bewusst kein gültiger Versionsbezeichner: nur die
    // explizit freigegebene, geprüfte Version darf gelesen werden.
    const ids=dmsVersionIds(req);
    if(!ids.success)return res.status(400).json({error:'Ungültige Dokument- oder Versions-ID'});
    const loaded=await loadDmsVersionForRead(req,res,ids.data.documentId,ids.data.versionId,'dms.document.downloaded');
    if(!loaded)return;
    const {row,blob}=loaded;
    res.setHeader('Content-Type',row.content_type);res.setHeader('Content-Length',String(blob.content.byteLength));res.setHeader('Content-Disposition',`attachment; filename="${safeFilename(row.title,row.version_no,row.content_type)}"`);
    return res.send(blob.content);
  }catch(error){next(error);}
});

dmsRouter.get('/dms/documents/:documentId/versions/:versionId/preview',requirePermission('dms:read',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const ids=dmsVersionIds(req);
    if(!ids.success)return res.status(400).json({error:'Ungültige Dokument- oder Versions-ID'});
    const loaded=await loadDmsVersionForRead(req,res,ids.data.documentId,ids.data.versionId,'dms.document.previewed');
    if(!loaded)return;
    const {row,blob}=loaded;
    // Identische Prüfungen wie beim Download, nur mit inline-Disposition für
    // die Wiedergabe im Browser (u. a. Audio/Video). Kein latest-Alias.
    res.setHeader('Content-Type',row.content_type);res.setHeader('Content-Length',String(blob.content.byteLength));res.setHeader('Content-Disposition',`inline; filename="${safeFilename(row.title,row.version_no,row.content_type)}"`);
    return res.send(blob.content);
  }catch(error){next(error);}
});

dmsRouter.post('/dms/retention/apply',requirePermission('dms:delete'),async(req,res,next)=>{
  try{
    const rows=(await query(`SELECT id,object_key,retention_until FROM dms_versions WHERE tenant_id=$1 AND lifecycle_state='available' AND retention_until IS NOT NULL AND retention_until<=now()`,[req.user!.tenantId])).rows.filter(row=>retentionDue(row.retention_until));
    let deleted=0;
    for(const row of rows){await dmsStorage.delete(row.object_key);await query(`UPDATE dms_versions SET lifecycle_state='deleted',deleted_at=now() WHERE tenant_id=$1 AND id=$2`,[req.user!.tenantId,row.id]);deleted++;}
    await recordAudit(req.user!.tenantId,req.user!.id,'dms.retention.applied','dms_version',undefined,{deleted});
    res.json({deleted});
  }catch(error){next(error);}
});

dmsRouter.get('/dms/backup/status',requirePermission('dms:backup:read'),async(req,res,next)=>{
  try{
    const row=(await query('SELECT provider,contract_version,status,last_backup_at,last_restore_test_at,details FROM dms_blob_backup_status WHERE tenant_id=$1',[req.user!.tenantId])).rows[0];
    res.json(row?{...row,database_backup_independent:true}:configuredDmsBackupContract());
  }catch(error){next(error);}
});
