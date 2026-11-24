import {Router,Request} from 'express';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {query,withTransaction} from '../db/pool.js';
import {requireAuth,requireCsrf,requirePermission} from '../middleware/auth.js';
import {recordAudit} from '../services/audit.js';
import {BlobStorageAdapter,MalwareScannerAdapter,configuredDmsBackupContract,createDmsAdapters,sha256} from '../services/dms-providers.js';
import {canAccessResource,effectivePermissionScope,normalizePermissionGrants} from '../types/authorization.js';
import {runIdempotentMutation} from '../services/offline-sync.js';
import {env} from '../config/env.js';
import {canDownloadDmsVersion,nextDmsVersion,retentionDue,scanLifecycle,validateDmsUpload} from '../services/dms-domain.js';

const uuid=z.string().uuid();
const allowedTypes=new Set(env.DMS_ALLOWED_CONTENT_TYPES.split(',').map(value=>value.trim()).filter(Boolean));
const adapters=createDmsAdapters();
export let dmsStorage:BlobStorageAdapter=adapters.storage;
export let dmsScanner:MalwareScannerAdapter=adapters.scanner;
export function configureDmsAdapters(storage:BlobStorageAdapter,scanner:MalwareScannerAdapter){dmsStorage=storage;dmsScanner=scanner;}

function session(req:Request){if(!req.sessionDbId)throw Object.assign(new Error('Session-Identität fehlt.'),{status:401});return req.sessionDbId;}
function siteAccess(req:Request,siteId:string|null,permission='dms:read'){
  const user=req.user!;
  const scope=effectivePermissionScope(normalizePermissionGrants(user.permissionGrants,user.permissions),permission,{role:user.role,isSystemAdmin:user.isSystemAdmin===true});
  if(!scope||!canAccessResource({userId:user.id,tenantId:user.tenantId,role:user.role,isSystemAdmin:user.isSystemAdmin===true,siteIds:user.siteIds??[],grants:normalizePermissionGrants(user.permissionGrants,user.permissions)},scope,{tenantId:user.tenantId,siteId}))throw Object.assign(new Error('Insufficient permissions for this document scope'),{status:403});
}
function decodeContent(value:unknown){
  if(typeof value!=='string'||!/^[A-Za-z0-9+/]*={0,2}$/.test(value)||value.length%4!==0)throw Object.assign(new Error('content_base64 must be valid base64'),{status:400});
  const content=Buffer.from(value,'base64');
  if(!content.length)throw Object.assign(new Error('Document content must not be empty'),{status:400});
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
    const values=siteFilter?[req.user!.tenantId,req.user!.siteIds??[]]:[req.user!.tenantId];
    const rows=(await query(`SELECT d.id,d.site_id,d.employee_id,d.employee_document_category,d.title,d.description,d.document_status,d.created_at,d.deleted_at,
      COALESCE(json_agg(json_build_object('id',v.id,'version_no',v.version_no,'size_bytes',v.size_bytes,'content_type',v.content_type,'sha256',v.sha256,'lifecycle_state',v.lifecycle_state,'created_at',v.created_at,'retention_until',v.retention_until) ORDER BY v.version_no DESC) FILTER (WHERE v.id IS NOT NULL),'[]') versions
      FROM dms_documents d LEFT JOIN dms_versions v ON v.tenant_id=d.tenant_id AND v.document_id=d.id
      WHERE d.tenant_id=$1${siteFilter} GROUP BY d.id ORDER BY d.created_at DESC`,values)).rows;
    res.json(rows);
  }catch(error){next(error);}
});

dmsRouter.post('/dms/documents',requirePermission('dms:write',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const body=z.object({
      title:z.string().trim().min(1).max(240),
      description:z.string().max(4000).nullable().optional(),
      site_id:uuid.nullable().optional(),
      employee_id:uuid.nullable().optional(),
      employee_document_category:z.enum(['contract','qualification','training','instruction','personal','other']).nullable().optional(),
      content_base64:z.string(),
      content_type:z.string().trim().min(1).max(160),
      retention_until:z.string().datetime({offset:true}).nullable().optional(),
      client_mutation_id:uuid,
    }).strict().parse(req.body);
    siteAccess(req,body.site_id??null,'dms:write');
    if(body.employee_id){
      const employee=(await query('SELECT id FROM employees WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,body.employee_id])).rows[0];
      if(!employee)throw Object.assign(new Error('Employee not found'),{status:404});
    }
    const content=decodeContent(body.content_base64);
    const maxBytes=env.DMS_MAX_BYTES;
    validateDmsUpload(content,body.content_type,maxBytes,allowedTypes);
    const documentId=randomUUID();const versionId=randomUUID();const objectKey=`${req.user!.tenantId}/${documentId}/${versionId}`;
    await dmsStorage.put(objectKey,content,body.content_type);
    try{
      const result=await withTransaction(client=>runIdempotentMutation<{document:Record<string,unknown>;version:Record<string,unknown>}>(client,{tenantId:req.user!.tenantId,userId:req.user!.id,mutationId:body.client_mutation_id,action:'dms.document',payload:req.body},async tx=>{
        const document=(await tx.query(`INSERT INTO dms_documents(id,tenant_id,site_id,employee_id,employee_document_category,title,description,created_by,created_session_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [documentId,req.user!.tenantId,body.site_id??null,body.employee_id??null,body.employee_document_category??null,body.title,body.description??null,req.user!.id,session(req)])).rows[0];
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
        throw Object.assign(new Error('Malware scan provider failed'),{status:502,cause:error});
      }
      const lifecycle=scanLifecycle(scan);
      if(lifecycle.state==='rejected'){
        await query(`UPDATE dms_versions SET lifecycle_state='rejected',rejection_reason=$3,scanned_at=now() WHERE tenant_id=$1 AND id=$2`,[req.user!.tenantId,versionId,lifecycle.rejectionReason]);
        await dmsStorage.delete(objectKey);
        return res.status(422).json({error:'Document rejected by malware scan',state:'rejected',signature:scan.signature});
      }
      const available=(await query(`UPDATE dms_versions SET lifecycle_state='available',scanned_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *`,[req.user!.tenantId,versionId])).rows[0];
      await recordAudit(req.user!.tenantId,req.user!.id,'dms.document.uploaded','dms_document',documentId,{version_id:versionId,sha256:available.sha256,size_bytes:available.size_bytes});
      return res.status(201).json({...result.response,version:available});
    }catch(error){await dmsStorage.delete(objectKey).catch(()=>undefined);throw error;}
  }catch(error){next(error);}
});

dmsRouter.post('/dms/documents/:documentId/versions',requirePermission('dms:write',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const document=(await query('SELECT * FROM dms_documents WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,req.params.documentId])).rows[0];
    if(!document)return res.status(404).json({error:'Document not found'});
    siteAccess(req,document.site_id??null,'dms:write');
    const body=z.object({content_base64:z.string(),content_type:z.string().trim().min(1).max(160),retention_until:z.string().datetime({offset:true}).nullable().optional(),client_mutation_id:uuid}).strict().parse(req.body);
    const content=decodeContent(body.content_base64);validateDmsUpload(content,body.content_type,env.DMS_MAX_BYTES,allowedTypes);
    const versionId=randomUUID();const objectKey=`${req.user!.tenantId}/${document.id}/${versionId}`;await dmsStorage.put(objectKey,content,body.content_type);
    try{
      const row=await withTransaction(async tx=>{
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
        throw Object.assign(new Error('Malware scan provider failed'),{status:502,cause:error});
      }
      const lifecycle=scanLifecycle(scan);
      if(lifecycle.state==='rejected'){await query(`UPDATE dms_versions SET lifecycle_state='rejected',rejection_reason=$3,scanned_at=now() WHERE tenant_id=$1 AND id=$2`,[req.user!.tenantId,versionId,lifecycle.rejectionReason]);await dmsStorage.delete(objectKey);return res.status(422).json({error:'Document rejected by malware scan',state:'rejected'});}
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
    if(!row)return res.status(404).json({error:'Document version not found'});
    siteAccess(req,row.site_id??null);
    if(!canDownloadDmsVersion(row.document_status,row.lifecycle_state))return res.status(409).json({error:'Document version is not available',state:row.lifecycle_state});
    const blob=await dmsStorage.get(row.object_key);
    if(blob.content.byteLength!==Number(row.size_bytes)||sha256(blob.content)!==row.sha256)return res.status(502).json({error:'Blob integrity check failed'});
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
