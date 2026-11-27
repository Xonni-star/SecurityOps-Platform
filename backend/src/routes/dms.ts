import {Router,Request} from 'express';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {query,withTransaction} from '../db/pool.js';
import {requireAuth,requireCsrf,requirePermission} from '../middleware/auth.js';
import {logger} from '../middleware/errors.js';
import {recordAudit} from '../services/audit.js';
import {BlobStorageAdapter,MalwareScannerAdapter,configuredDmsBackupContract,createDmsAdapters,sha256} from '../services/dms-providers.js';
import {canAccessResource,effectivePermissionScope,normalizePermissionGrants} from '../types/authorization.js';
import {runIdempotentMutation} from '../services/offline-sync.js';
import {env} from '../config/env.js';
import {canDownloadDmsVersion,nextDmsVersion,retentionDue,scanLifecycle,validateDmsUpload} from '../services/dms-domain.js';
import {classifyDocument} from '../services/dms-document-status.js';

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
  const extension=contentType==='application/pdf'?'.pdf':contentType.startsWith('image/')?`.${contentType.slice(6)}`:'.bin';
  return `${title.replace(/[^a-zA-Z0-9._-]+/g,'_').slice(0,120)||'document'}-v${versionNo}${extension}`;
}

export const dmsRouter=Router();
dmsRouter.use((req,res,next)=>/^\/dms/.test(req.path)?requireAuth(req,res,()=>['POST','PATCH','PUT','DELETE'].includes(req.method)?requireCsrf(req,res,next):next()):next());

dmsRouter.get('/dms/documents',requirePermission('dms:read',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const scope=effectivePermissionScope(normalizePermissionGrants(req.user!.permissionGrants,req.user!.permissions),'dms:read',{role:req.user!.role,isSystemAdmin:req.user!.isSystemAdmin===true});
    const siteFilter=scope==='site'?' AND d.site_id = ANY($2::uuid[])':'';
    const customerFilter=customerDocumentPermission(req,'customer_documents:read')?'':' AND d.customer_id IS NULL';
    const values:unknown[]=siteFilter?[req.user!.tenantId,req.user!.siteIds??[]]:[req.user!.tenantId];
    const deviceFilter=typeof req.query.device_id==='string'&&uuid.safeParse(req.query.device_id).success?` AND d.device_id=$${values.length+1}`:'';
    if(deviceFilter)values.push(req.query.device_id);
    const nfcDeviceFilter=typeof req.query.nfc_device_id==='string'&&uuid.safeParse(req.query.nfc_device_id).success?` AND d.nfc_device_id=$${values.length+1}`:'';
    if(nfcDeviceFilter)values.push(req.query.nfc_device_id);
    const rows=(await query(`SELECT d.id,d.site_id,d.device_id,d.nfc_device_id,d.employee_id,d.employee_document_category,d.title,d.description,d.document_status,d.created_at,d.deleted_at,
      d.document_number,d.document_type,d.responsible_employee_id,d.valid_from,d.valid_until,d.review_on,d.approval_status,d.location_id,
      COALESCE(json_agg(json_build_object('id',v.id,'version_no',v.version_no,'size_bytes',v.size_bytes,'content_type',v.content_type,'sha256',v.sha256,'lifecycle_state',v.lifecycle_state,'created_at',v.created_at,'retention_until',v.retention_until) ORDER BY v.version_no DESC) FILTER (WHERE v.id IS NOT NULL),'[]') versions
      FROM dms_documents d LEFT JOIN dms_versions v ON v.tenant_id=d.tenant_id AND v.document_id=d.id
      WHERE d.tenant_id=$1${siteFilter}${customerFilter}${deviceFilter}${nfcDeviceFilter} GROUP BY d.id ORDER BY d.created_at DESC`,values)).rows;
    res.json(rows.map(row=>({...row,...classifyDocument(row)})));
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
    try{
      const result=await withTransaction(client=>runIdempotentMutation<{document:Record<string,unknown>;version:Record<string,unknown>}>(client,{tenantId:req.user!.tenantId,userId:req.user!.id,mutationId:body.client_mutation_id,action:'dms.document',payload:req.body},async tx=>{
        const document=(await tx.query(`INSERT INTO dms_documents(id,tenant_id,site_id,employee_id,employee_document_category,customer_id,customer_document_category,title,description,document_number,document_type,responsible_employee_id,location_id,valid_from,valid_until,review_on,approval_status,created_by,created_session_id,device_id,nfc_device_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING *`,
          [documentId,req.user!.tenantId,documentSiteId,body.employee_id??null,body.employee_document_category??null,body.customer_id??null,body.customer_document_category??null,body.title,body.description??null,body.document_number??null,body.document_type??null,body.responsible_employee_id??null,body.location_id??null,body.valid_from??null,body.valid_until??null,body.review_on??null,'draft',req.user!.id,session(req),body.device_id??null,body.nfc_device_id??null])).rows[0];
        const version=(await tx.query(`INSERT INTO dms_versions(id,tenant_id,document_id,version_no,object_key,size_bytes,content_type,sha256,lifecycle_state,uploaded_by,uploaded_session_id,uploaded_device_id,retention_until)
          VALUES($1,$2,$3,1,$4,$5,$6,$7,'quarantined',$8,$9,(SELECT device_id FROM sessions WHERE id=$9),$10) RETURNING *`,
          [versionId,req.user!.tenantId,documentId,objectKey,content.byteLength,body.content_type,sha256(content),req.user!.id,session(req),body.retention_until??null])).rows[0];
        return {document,version};
      }));
      if(result.replayed){await dmsStorage.delete(objectKey).catch(()=>undefined);return res.status(200).json(result.response);}
      await query(`UPDATE dms_versions SET lifecycle_state='scanning' WHERE tenant_id=$1 AND id=$2`,[req.user!.tenantId,versionId]);
      let scan;
      try{scan=await dmsScanner.scan(content);}catch(error){
        await query(`UPDATE dms_versions SET lifecycle_state='rejected',rejection_reason=$3,scanned_at=now() WHERE tenant_id=$1 AND id=$2`,[req.user!.tenantId,versionId,'scan_provider_error']);
        await recordAudit(req.user!.tenantId,req.user!.id,'dms.scan.provider_error','dms_version',versionId,
          {document_id:documentId,host:env.CLAMAV_HOST,port:env.CLAMAV_PORT,reason:scanFailureDetails(error)}).catch(()=>undefined);
        logger.error({event:'dms.scan.provider_error',version_id:versionId,host:env.CLAMAV_HOST,port:env.CLAMAV_PORT,message:scanFailureDetails(error)},'DMS malware scan provider failed');
        throw Object.assign(new Error('Virenscan-Anbieter ist nicht erreichbar. Das Dokument wurde nicht freigegeben.'),{status:502,expose:true,cause:error});
      }
      const lifecycle=scanLifecycle(scan);
      if(lifecycle.state==='rejected'){
        await query(`UPDATE dms_versions SET lifecycle_state='rejected',rejection_reason=$3,scanned_at=now() WHERE tenant_id=$1 AND id=$2`,[req.user!.tenantId,versionId,lifecycle.rejectionReason]);
        await dmsStorage.delete(objectKey);
        await recordAudit(req.user!.tenantId,req.user!.id,'dms.scan.rejected','dms_version',versionId,
          {document_id:documentId,signature:scan.signature??null,sha256:sha256(content)}).catch(()=>undefined);
        return res.status(422).json({error:'Dokument durch Virenscan abgelehnt',state:'rejected',signature:scan.signature});
      }
      const available=(await query(`UPDATE dms_versions SET lifecycle_state='available',scanned_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *`,[req.user!.tenantId,versionId])).rows[0];
      await recordAudit(req.user!.tenantId,req.user!.id,'dms.document.uploaded','dms_document',documentId,{version_id:versionId,sha256:available.sha256,size_bytes:available.size_bytes,customer_id:body.customer_id??null});
      return res.status(201).json({...result.response,version:available});
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
      WHERE tenant_id=$1 AND id=$2 RETURNING *`,[req.user!.tenantId,documentId])).rows[0];
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
    if(document.created_by===req.user!.id&&req.user!.isSystemAdmin!==true)return res.status(403).json({error:'Hochladende dürfen eigene Dokumente nicht freigeben'});
    if(document.document_status!=='active'||!['draft','pending_approval','rejected'].includes(document.approval_status))return res.status(409).json({error:'Dokument befindet sich nicht in einem freigabefähigen Status'});
    const latest=(await query(`SELECT * FROM dms_versions WHERE tenant_id=$1 AND document_id=$2 ORDER BY version_no DESC LIMIT 1`,[req.user!.tenantId,documentId])).rows[0];
    if(latest?.lifecycle_state!=='available')return res.status(409).json({error:'Für die Freigabe ist keine freigegebene Dokumentversion verfügbar'});
    const row=(await query(`UPDATE dms_documents SET approval_status='approved',approved_by=$3,approved_at=now(),reviewed_at=now(),rejection_reason=NULL,updated_at=now()
      WHERE tenant_id=$1 AND id=$2 AND approval_status<>'approved' RETURNING *`,[req.user!.tenantId,documentId,req.user!.id])).rows[0];
    if(!row)return res.status(409).json({error:'Dokument befindet sich nicht in einem freigabefähigen Status'});
    await recordAudit(req.user!.tenantId,req.user!.id,'dms.document.approved','dms_document',documentId,{previous_status:document.approval_status,feedback:body.feedback??null});
    const classifiable={...row,versions:[latest]};
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
    if(document.created_by===req.user!.id&&req.user!.isSystemAdmin!==true)return res.status(403).json({error:'Hochladende dürfen über eigene Dokumente nicht entscheiden'});
    if(document.document_status!=='active'||!['pending_approval','approved'].includes(document.approval_status))return res.status(409).json({error:'Dokument kann nicht zur Überarbeitung zurückgegeben werden'});
    const row=(await query(`UPDATE dms_documents SET approval_status='rejected',approval_feedback=$3,rejection_reason=$3,reviewed_at=now(),approved_by=NULL,approved_at=NULL,updated_at=now()
      WHERE tenant_id=$1 AND id=$2 RETURNING *`,[req.user!.tenantId,documentId,body.reason])).rows[0];
    await recordAudit(req.user!.tenantId,req.user!.id,'dms.document.returned_for_revision','dms_document',documentId,{previous_status:document.approval_status,reason:body.reason});
    res.json({...row,...classifyDocument(row)});
  }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Ungültiger Überarbeitungsantrag'});next(error);}
});

dmsRouter.post('/dms/documents/:documentId/versions',requirePermission('dms:write',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const document=(await query('SELECT * FROM dms_documents WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,req.params.documentId])).rows[0];
    if(!document)return res.status(404).json({error:'Dokument nicht gefunden'});
    if(document.customer_id&&!customerDocumentPermission(req,'customer_documents:write'))return res.status(403).json({error:'Unzureichende Berechtigungen für Kundendokumente'});
    siteAccess(req,document.site_id??null,'dms:write');
    const body=z.object({content_base64:z.string(),content_type:z.string().trim().min(1).max(160),retention_until:z.string().datetime({offset:true}).nullable().optional(),client_mutation_id:uuid}).strict().parse(req.body);
    const content=decodeContent(body.content_base64);validateDmsUpload(content,body.content_type,env.DMS_MAX_BYTES,allowedTypes);
    const versionId=randomUUID();const objectKey=`${req.user!.tenantId}/${document.id}/${versionId}`;await dmsStorage.put(objectKey,content,body.content_type);
    try{
      await withTransaction(async tx=>{
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${req.user!.tenantId}:${document.id}`]);
        const current=(await tx.query<{current:number|null}>('SELECT MAX(version_no) AS current FROM dms_versions WHERE tenant_id=$1 AND document_id=$2',[req.user!.tenantId,document.id])).rows[0]?.current;
        return (await tx.query(`INSERT INTO dms_versions(id,tenant_id,document_id,version_no,object_key,size_bytes,content_type,sha256,lifecycle_state,uploaded_by,uploaded_session_id,uploaded_device_id,retention_until)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,'quarantined',$9,$10,(SELECT device_id FROM sessions WHERE id=$10),$11) RETURNING *`,
          [versionId,req.user!.tenantId,document.id,nextDmsVersion(current??undefined),objectKey,content.byteLength,body.content_type,sha256(content),req.user!.id,session(req),body.retention_until??null])).rows[0];
      });
      await query(`UPDATE dms_versions SET lifecycle_state='scanning' WHERE tenant_id=$1 AND id=$2`,[req.user!.tenantId,versionId]);
      let scan;
      try{scan=await dmsScanner.scan(content);}catch(error){
        await query(`UPDATE dms_versions SET lifecycle_state='rejected',rejection_reason='scan_provider_error',scanned_at=now() WHERE tenant_id=$1 AND id=$2`,[req.user!.tenantId,versionId]);
        await recordAudit(req.user!.tenantId,req.user!.id,'dms.scan.provider_error','dms_version',versionId,
          {document_id:document.id,host:env.CLAMAV_HOST,port:env.CLAMAV_PORT,reason:scanFailureDetails(error)}).catch(()=>undefined);
        logger.error({event:'dms.scan.provider_error',version_id:versionId,host:env.CLAMAV_HOST,port:env.CLAMAV_PORT,message:scanFailureDetails(error)},'DMS malware scan provider failed');
        throw Object.assign(new Error('Virenscan-Anbieter ist nicht erreichbar. Das Dokument wurde nicht freigegeben.'),{status:502,expose:true,cause:error});
      }
      const lifecycle=scanLifecycle(scan);
      if(lifecycle.state==='rejected'){
        await query(`UPDATE dms_versions SET lifecycle_state='rejected',rejection_reason=$3,scanned_at=now() WHERE tenant_id=$1 AND id=$2`,[req.user!.tenantId,versionId,lifecycle.rejectionReason]);
        await dmsStorage.delete(objectKey);
        await recordAudit(req.user!.tenantId,req.user!.id,'dms.scan.rejected','dms_version',versionId,
          {document_id:document.id,signature:scan.signature??null,sha256:sha256(content)}).catch(()=>undefined);
        return res.status(422).json({error:'Dokument durch Virenscan abgelehnt',state:'rejected',signature:scan.signature});
      }
      const available=(await query(`UPDATE dms_versions SET lifecycle_state='available',scanned_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *`,[req.user!.tenantId,versionId])).rows[0];
      await recordAudit(req.user!.tenantId,req.user!.id,'dms.version.uploaded','dms_version',versionId,{document_id:document.id,version_no:available.version_no});
      return res.status(201).json(available);
    }catch(error){await dmsStorage.delete(objectKey).catch(()=>undefined);throw error;}
  }catch(error){next(error);}
});

dmsRouter.get('/dms/documents/:documentId/versions/:versionId/download',requirePermission('dms:read',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const row=(await query(`SELECT d.*,v.* FROM dms_documents d JOIN dms_versions v ON v.tenant_id=d.tenant_id AND v.document_id=d.id
      WHERE d.tenant_id=$1 AND d.id=$2 AND v.id=$3 AND d.document_status='active'`,[req.user!.tenantId,req.params.documentId,req.params.versionId])).rows[0];
    if(!row)return res.status(404).json({error:'Dokumentversion nicht gefunden'});
    if(row.customer_id&&!customerDocumentPermission(req,'customer_documents:read'))return res.status(403).json({error:'Unzureichende Berechtigungen für Kundendokumente'});
    siteAccess(req,row.site_id??null);
    if(!canDownloadDmsVersion(row.document_status,row.lifecycle_state))return res.status(409).json({error:'Dokumentversion ist nicht verfügbar',state:row.lifecycle_state});
    const blob=await dmsStorage.get(row.object_key);
    if(blob.content.byteLength!==Number(row.size_bytes)||sha256(blob.content)!==row.sha256)return res.status(502).json({error:'Integritätsprüfung des Blobs fehlgeschlagen'});
    res.setHeader('Content-Type',row.content_type);res.setHeader('Content-Length',String(blob.content.byteLength));res.setHeader('Content-Disposition',`attachment; filename="${safeFilename(row.title,row.version_no,row.content_type)}"`);
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
