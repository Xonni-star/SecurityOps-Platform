import {Router,Request} from 'express';
import {z} from 'zod';
import {query,withTransaction} from '../db/pool.js';
import {requireAuth,requireCsrf,requirePermission} from '../middleware/auth.js';
import {canAccessResource,effectivePermissionScope,normalizePermissionGrants} from '../types/authorization.js';
import {runIdempotentMutation} from '../services/offline-sync.js';
import type {SyncMutationAction} from '../services/offline-sync.js';
import {bundleStatus,canReturnKey,holderIsValid,transitionKeyStatus} from '../services/keys-domain.js';

const uuid=z.string().uuid();
const movementBody=z.object({client_mutation_id:uuid,reason:z.string().trim().max(1000).nullable().optional()}).strict();
const holderBody=z.object({holder_user_id:uuid.nullable().optional(),holder_employee_id:uuid.nullable().optional(),client_mutation_id:uuid,reason:z.string().trim().max(1000).nullable().optional()}).strict();

function session(req:Request){if(!req.sessionDbId)throw Object.assign(new Error('Session-Identität fehlt.'),{status:401});return req.sessionDbId;}
function keyPermission(req:Request,code:string,siteId:string|null){
  const user=req.user!;
  const grants=normalizePermissionGrants(user.permissionGrants,user.permissions);
  const scope=effectivePermissionScope(grants,code,{role:user.role,isSystemAdmin:user.isSystemAdmin===true});
  if(!scope||!canAccessResource({userId:user.id,tenantId:user.tenantId,role:user.role,isSystemAdmin:user.isSystemAdmin===true,siteIds:user.siteIds??[],grants},scope,{tenantId:user.tenantId,siteId})){
    throw Object.assign(new Error('Insufficient permissions for this key scope'),{status:403});
  }
}
function operator(req:Request){return req.user!.role==='admin'||req.user!.role==='operator'||req.user!.isSystemAdmin===true;}

async function movement(req:Request,keyId:string,movementType:'issued'|'returned'|'lost'|'deactivated',body:z.infer<typeof movementBody>|z.infer<typeof holderBody>){
  return withTransaction(client=>runIdempotentMutation(client,{tenantId:req.user!.tenantId,userId:req.user!.id,mutationId:body.client_mutation_id,action:`keys.${movementType}` as SyncMutationAction,payload:req.body},async tx=>{
    const key=(await tx.query('SELECT * FROM keys WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[req.user!.tenantId,keyId])).rows[0];
    if(!key)throw Object.assign(new Error('Key not found'),{status:404});
    if((await tx.query('SELECT 1 FROM key_bundle_items WHERE tenant_id=$1 AND key_id=$2',[req.user!.tenantId,keyId])).rowCount)throw Object.assign(new Error('Bundled keys must be managed through their bundle'),{status:409,code:'KEY_BUNDLE_MANAGED'});
    keyPermission(req,movementType==='issued'?'keys:issue':movementType==='returned'?'keys:return':'keys:manage',key.site_id);
    if(movementType==='returned'&&!canReturnKey({actorUserId:req.user!.id,holderUserId:key.holder_user_id,operator:operator(req)}))throw Object.assign(new Error('Only the valid holder or an operator may return this key'),{status:403});
    const next=transitionKeyStatus(key.status,movementType);
    let holderUserId:null|string=null;let holderEmployeeId:null|string=null;
    if(movementType==='issued'){
      const holder=body as z.infer<typeof holderBody>;
      if(!holderIsValid(holder.holder_user_id,holder.holder_employee_id))throw Object.assign(new Error('Exactly one valid holder is required'),{status:400});
      if(holder.holder_user_id && !(await tx.query('SELECT id FROM users WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,holder.holder_user_id])).rowCount)throw Object.assign(new Error('Holder user not found'),{status:404});
      if(holder.holder_employee_id && !(await tx.query('SELECT id FROM employees WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,holder.holder_employee_id])).rowCount)throw Object.assign(new Error('Holder employee not found'),{status:404});
      holderUserId=holder.holder_user_id??null;holderEmployeeId=holder.holder_employee_id??null;
    }
    const updated=(await tx.query(`UPDATE keys SET status=$3,holder_user_id=$4,holder_employee_id=$5,
      issued_at=CASE WHEN $3='issued' THEN now() ELSE issued_at END,
      issued_by=CASE WHEN $3='issued' THEN $6 ELSE issued_by END,
      returned_at=CASE WHEN $3='available' THEN now() ELSE returned_at END,
      returned_by=CASE WHEN $3='available' THEN $6 ELSE returned_by END,
      lost_at=CASE WHEN $3='lost' THEN now() ELSE lost_at END,
      deactivated_at=CASE WHEN $3='deactivated' THEN now() ELSE deactivated_at END,
      updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *`,
      [req.user!.tenantId,keyId,next,holderUserId,holderEmployeeId,req.user!.id])).rows[0];
    const movementHolderUserId=movementType==='issued'?holderUserId:key.holder_user_id??null;
    const movementHolderEmployeeId=movementType==='issued'?holderEmployeeId:key.holder_employee_id??null;
    const movement=(await tx.query(`INSERT INTO key_movements(tenant_id,key_id,movement_type,from_status,to_status,holder_user_id,holder_employee_id,actor_user_id,session_id,device_id,reason)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,(SELECT device_id FROM sessions WHERE tenant_id=$1 AND id=$9),$10) RETURNING *`,
      [req.user!.tenantId,keyId,movementType,key.status,next,movementHolderUserId,movementHolderEmployeeId,req.user!.id,session(req),body.reason??null])).rows[0];
    await tx.query('INSERT INTO audit_events(tenant_id,actor_user_id,event_type,entity_type,entity_id,details) VALUES($1,$2,$3,$4,$5,$6)',
      [req.user!.tenantId,req.user!.id,`keys.${movementType}`,'key',keyId,{from_status:key.status,to_status:next,movement_id:movement.id}]);
    return {key:updated,movement};
  }));
}

export const keysRouter=Router();
keysRouter.use((req,res,next)=>/^\/(?:keys|key-bundles)/.test(req.path)?requireAuth(req,res,()=>['POST','PATCH','PUT','DELETE'].includes(req.method)?requireCsrf(req,res,next):next()):next());

keysRouter.get('/keys',requirePermission('keys:read',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const scope=effectivePermissionScope(normalizePermissionGrants(req.user!.permissionGrants,req.user!.permissions),'keys:read',{role:req.user!.role,isSystemAdmin:req.user!.isSystemAdmin===true});
    const siteFilter=scope==='site'?' AND k.site_id = ANY($2::uuid[])':'';
    const values=siteFilter?[req.user!.tenantId,req.user!.siteIds??[]]:[req.user!.tenantId];
    res.json((await query(`SELECT k.id,k.site_id,k.key_code,k.label,k.key_type,k.status,k.holder_user_id,k.holder_employee_id,k.issued_at,k.returned_at,k.lost_at,k.deactivated_at,k.created_at,k.updated_at
      FROM keys k WHERE k.tenant_id=$1${siteFilter} ORDER BY k.label`,values)).rows);
  }catch(error){next(error);}
});

const bundleBody=z.object({name:z.string().trim().min(1).max(160),site_id:uuid.nullable().optional(),client_mutation_id:uuid}).strict();
const bundleItemBody=z.object({key_id:uuid,client_mutation_id:uuid}).strict();
const bundleHolderBody=holderBody;
const bundleReturnBody=z.object({key_ids:z.array(uuid).min(1),client_mutation_id:uuid,reason:z.string().trim().max(1000).nullable().optional()}).strict();

async function bundlePermission(req:Request,code:string,siteId:string|null){keyPermission(req,code,siteId);}

keysRouter.get('/key-bundles',requirePermission('keys:bundle_read',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const scope=effectivePermissionScope(normalizePermissionGrants(req.user!.permissionGrants,req.user!.permissions),'keys:bundle_read',{role:req.user!.role,isSystemAdmin:req.user!.isSystemAdmin===true});
    const siteFilter=scope==='site'?' AND b.site_id = ANY($2::uuid[])':'';
    const values=siteFilter?[req.user!.tenantId,req.user!.siteIds??[]]:[req.user!.tenantId];
    res.json((await query(`SELECT b.id,b.site_id,b.name,b.status,b.holder_user_id,b.holder_employee_id,b.created_at,b.updated_at,
      COUNT(i.key_id)::int item_count,COUNT(i.key_id) FILTER (WHERE k.status='issued')::int issued_count
      FROM key_bundles b LEFT JOIN key_bundle_items i ON i.tenant_id=b.tenant_id AND i.bundle_id=b.id
      LEFT JOIN keys k ON k.tenant_id=i.tenant_id AND k.id=i.key_id
      WHERE b.tenant_id=$1${siteFilter} GROUP BY b.id ORDER BY b.name`,values)).rows);
  }catch(error){next(error);}
});

keysRouter.post('/key-bundles',requirePermission('keys:bundle_write',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const body=bundleBody.parse(req.body);bundlePermission(req,'keys:bundle_write',body.site_id??null);
    const result=await withTransaction(client=>runIdempotentMutation(client,{tenantId:req.user!.tenantId,userId:req.user!.id,mutationId:body.client_mutation_id,action:'keys.bundle.create',payload:req.body},async tx=>{
      const row=(await tx.query(`INSERT INTO key_bundles(tenant_id,site_id,name,created_by,created_session_id) VALUES($1,$2,$3,$4,$5) RETURNING *`,
        [req.user!.tenantId,body.site_id??null,body.name,req.user!.id,session(req)])).rows[0];
      await tx.query(`INSERT INTO key_bundle_movements(tenant_id,bundle_id,movement_type,to_status,actor_user_id,session_id) VALUES($1,$2,'created','available',$3,$4)`,
        [req.user!.tenantId,row.id,req.user!.id,session(req)]);
      await tx.query('INSERT INTO audit_events(tenant_id,actor_user_id,event_type,entity_type,entity_id,details) VALUES($1,$2,$3,$4,$5,$6)',
        [req.user!.tenantId,req.user!.id,'keys.bundle.created','key_bundle',row.id,{site_id:row.site_id}]);
      return row;
    }));
    res.status(result.replayed?200:201).json(result.response);
  }catch(error){next(error);}
});

keysRouter.get('/key-bundles/:id',requirePermission('keys:bundle_read',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const bundle=(await query('SELECT * FROM key_bundles WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,String(req.params.id)])).rows[0];
    if(!bundle)return res.status(404).json({error:'Key bundle not found'});
    bundlePermission(req,'keys:bundle_read',bundle.site_id);
    const items=(await query(`SELECT k.id,k.site_id,k.key_code,k.label,k.key_type,k.status,k.holder_user_id,k.holder_employee_id
      FROM key_bundle_items i JOIN keys k ON k.tenant_id=i.tenant_id AND k.id=i.key_id
      WHERE i.tenant_id=$1 AND i.bundle_id=$2 ORDER BY k.label`,[req.user!.tenantId,bundle.id])).rows;
    res.json({...bundle,items});
  }catch(error){next(error);}
});

keysRouter.post('/key-bundles/:id/items',requirePermission('keys:bundle_write',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const body=bundleItemBody.parse(req.body);
    const result=await withTransaction(client=>runIdempotentMutation(client,{tenantId:req.user!.tenantId,userId:req.user!.id,mutationId:body.client_mutation_id,action:'keys.bundle.item',payload:req.body},async tx=>{
      const bundle=(await tx.query('SELECT * FROM key_bundles WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[req.user!.tenantId,String(req.params.id)])).rows[0];
      if(!bundle)return Object.assign(new Error('Key bundle not found'),{status:404});
      bundlePermission(req,'keys:bundle_write',bundle.site_id);
      if(bundle.status!=='available')throw Object.assign(new Error('Only available bundles can be changed'),{status:409});
      const key=(await tx.query('SELECT * FROM keys WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[req.user!.tenantId,body.key_id])).rows[0];
      if(!key)throw Object.assign(new Error('Key not found'),{status:404});
      if(key.status!=='available')throw Object.assign(new Error('Only available keys can be added'),{status:409});
      if(bundle.site_id&&key.site_id!==bundle.site_id)throw Object.assign(new Error('Key and bundle must use the same site'),{status:400});
      await tx.query('INSERT INTO key_bundle_items(tenant_id,bundle_id,key_id,added_by) VALUES($1,$2,$3,$4)',[req.user!.tenantId,bundle.id,key.id,req.user!.id]);
      const movement=(await tx.query(`INSERT INTO key_bundle_movements(tenant_id,bundle_id,movement_type,from_status,to_status,actor_user_id,session_id,reason)
        VALUES($1,$2,'item_added',$3,$3,$4,$5,$6) RETURNING *`,[req.user!.tenantId,bundle.id,bundle.status,req.user!.id,session(req),`key_id=${key.id}`])).rows[0];
      await tx.query('INSERT INTO audit_events(tenant_id,actor_user_id,event_type,entity_type,entity_id,details) VALUES($1,$2,$3,$4,$5,$6)',
        [req.user!.tenantId,req.user!.id,'keys.bundle.item_added','key_bundle',bundle.id,{key_id:key.id,movement_id:movement.id}]);
      return {bundle,movement};
    }));
    res.status(result.replayed?200:201).json(result.response);
  }catch(error){next(error);}
});

async function bundleMovement(req:Request,bundleId:string,type:'issue'|'return',body:z.infer<typeof bundleHolderBody>|z.infer<typeof bundleReturnBody>){
  return withTransaction(client=>runIdempotentMutation(client,{tenantId:req.user!.tenantId,userId:req.user!.id,mutationId:body.client_mutation_id,action:`keys.bundle.${type}` as SyncMutationAction,payload:req.body},async tx=>{
    const bundle=(await tx.query('SELECT * FROM key_bundles WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[req.user!.tenantId,bundleId])).rows[0];
    if(!bundle)throw Object.assign(new Error('Key bundle not found'),{status:404});
    bundlePermission(req,type==='issue'?'keys:bundle_issue':'keys:bundle_return',bundle.site_id);
    if(type==='return'&&!canReturnKey({actorUserId:req.user!.id,holderUserId:bundle.holder_user_id,operator:operator(req)}))throw Object.assign(new Error('Only the valid bundle holder or an operator may return it'),{status:403});
    const items=(await tx.query(`SELECT k.* FROM key_bundle_items i JOIN keys k ON k.tenant_id=i.tenant_id AND k.id=i.key_id
      WHERE i.tenant_id=$1 AND i.bundle_id=$2 ORDER BY k.id FOR UPDATE`,[req.user!.tenantId,bundle.id])).rows;
    if(!items.length)throw Object.assign(new Error('A key bundle must contain at least one key'),{status:409});
    let selected=items;
    let holderUserId:null|string=null;let holderEmployeeId:null|string=null;
    if(type==='issue'){
      const holder=body as z.infer<typeof bundleHolderBody>;
      if(bundle.status!=='available')throw Object.assign(new Error('Only available bundles can be issued'),{status:409});
      if(!holderIsValid(holder.holder_user_id,holder.holder_employee_id))throw Object.assign(new Error('Exactly one valid holder is required'),{status:400});
      for(const item of items)if(item.status!=='available')throw Object.assign(new Error('Every key in the bundle must be available'),{status:409});
      holderUserId=holder.holder_user_id??null;holderEmployeeId=holder.holder_employee_id??null;
    }else{
      const requested=new Set((body as z.infer<typeof bundleReturnBody>).key_ids);
      selected=items.filter(item=>requested.has(item.id));
      if(selected.length!==requested.size)throw Object.assign(new Error('Every returned key must belong to this bundle'),{status:400});
      if(selected.some(item=>item.status!=='issued'))throw Object.assign(new Error('Only issued bundle keys can be returned'),{status:409});
      if(bundle.status==='available')throw Object.assign(new Error('Bundle is not issued'),{status:409});
    }
    for(const item of selected){
      const next=type==='issue'?'issued':'available';
      await tx.query(`UPDATE keys SET status=$3,holder_user_id=$4,holder_employee_id=$5,
        issued_at=CASE WHEN $3='issued' THEN now() ELSE issued_at END,
        issued_by=CASE WHEN $3='issued' THEN $6 ELSE issued_by END,
        returned_at=CASE WHEN $3='available' THEN now() ELSE returned_at END,
        returned_by=CASE WHEN $3='available' THEN $6 ELSE returned_by END,
        updated_at=now() WHERE tenant_id=$1 AND id=$2`,
        [req.user!.tenantId,item.id,next,holderUserId,holderEmployeeId,req.user!.id]);
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
    await tx.query('INSERT INTO audit_events(tenant_id,actor_user_id,event_type,entity_type,entity_id,details) VALUES($1,$2,$3,$4,$5,$6)',
      [req.user!.tenantId,req.user!.id,`keys.bundle.${type}`,'key_bundle',bundle.id,{movement_id:movement.id,key_ids:selected.map(item=>item.id),to_status:nextStatus}]);
    return {bundle:updated,movement};
  }));
}

keysRouter.post('/key-bundles/:id/issue',requirePermission('keys:bundle_issue',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{const body=bundleHolderBody.parse(req.body);const result=await bundleMovement(req,String(req.params.id),'issue',body);res.status(result.replayed?200:201).json(result.response);}catch(error){next(error);}
});
keysRouter.post('/key-bundles/:id/return',requirePermission('keys:bundle_return',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{const body=bundleReturnBody.parse(req.body);const result=await bundleMovement(req,String(req.params.id),'return',body);res.status(200).json(result.response);}catch(error){next(error);}
});

keysRouter.post('/keys',requirePermission('keys:write',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const body=z.object({key_code:z.string().trim().min(1).max(120),label:z.string().trim().min(1).max(160),key_type:z.enum(['physical','digital','master']).default('physical'),site_id:uuid.nullable().optional(),client_mutation_id:uuid}).strict().parse(req.body);
    keyPermission(req,'keys:write',body.site_id??null);
    const result=await withTransaction(client=>runIdempotentMutation(client,{tenantId:req.user!.tenantId,userId:req.user!.id,mutationId:body.client_mutation_id,action:'keys.create',payload:req.body},async tx=>{
      const row=(await tx.query(`INSERT INTO keys(tenant_id,site_id,key_code,label,key_type,created_by,created_session_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [req.user!.tenantId,body.site_id??null,body.key_code,body.label,body.key_type,req.user!.id,session(req)])).rows[0];
      await tx.query(`INSERT INTO key_movements(tenant_id,key_id,movement_type,to_status,actor_user_id,session_id,device_id) VALUES($1,$2,'created','available',$3,$4,(SELECT device_id FROM sessions WHERE tenant_id=$1 AND id=$4))`,
        [req.user!.tenantId,row.id,req.user!.id,session(req)]);
      await tx.query('INSERT INTO audit_events(tenant_id,actor_user_id,event_type,entity_type,entity_id,details) VALUES($1,$2,$3,$4,$5,$6)',
        [req.user!.tenantId,req.user!.id,'keys.created','key',row.id,{site_id:row.site_id,key_type:row.key_type}]);
      return row;
    }));
    res.status(result.replayed?200:201).json(result.response);
  }catch(error){next(error);}
});

keysRouter.get('/keys/:id/history',requirePermission('keys:read',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const key=(await query('SELECT site_id FROM keys WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,String(req.params.id)])).rows[0];
    if(!key)return res.status(404).json({error:'Key not found'});
    keyPermission(req,'keys:read',key.site_id);
    res.json((await query('SELECT id,movement_type,from_status,to_status,holder_user_id,holder_employee_id,actor_user_id,reason,created_at FROM key_movements WHERE tenant_id=$1 AND key_id=$2 ORDER BY created_at',[req.user!.tenantId,String(req.params.id)])).rows);
  }catch(error){next(error);}
});

keysRouter.post('/keys/:id/issue',requirePermission('keys:issue',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{const body=holderBody.parse(req.body);const result=await movement(req,String(req.params.id),'issued',body);res.status(result.replayed?200:201).json(result.response);}catch(error){next(error);}
});
keysRouter.post('/keys/:id/return',requirePermission('keys:return',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{const body=movementBody.parse(req.body);const result=await movement(req,String(req.params.id),'returned',body);res.status(result.replayed?200:200).json(result.response);}catch(error){next(error);}
});
keysRouter.post('/keys/:id/lost',requirePermission('keys:manage',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{const body=movementBody.parse(req.body);const result=await movement(req,String(req.params.id),'lost',body);res.status(result.replayed?200:200).json(result.response);}catch(error){next(error);}
});
keysRouter.post('/keys/:id/deactivate',requirePermission('keys:manage',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{const body=movementBody.parse(req.body);const result=await movement(req,String(req.params.id),'deactivated',body);res.status(result.replayed?200:200).json(result.response);}catch(error){next(error);}
});
