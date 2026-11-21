import {Router,Request} from 'express';
import {z} from 'zod';
import {query,withTransaction} from '../db/pool.js';
import {requireAuth,requireCsrf,requirePermission} from '../middleware/auth.js';
import {canAccessResource,effectivePermissionScope,normalizePermissionGrants} from '../types/authorization.js';
import {runIdempotentMutation} from '../services/offline-sync.js';
import type {SyncMutationAction} from '../services/offline-sync.js';
import {canReturnKey,holderIsValid,transitionKeyStatus,validateBundleReturn} from '../services/keys-domain.js';

const uuid=z.string().uuid();
const movementBody=z.object({client_mutation_id:uuid,reason:z.string().trim().max(1000).nullable().optional()}).strict();
const holderBody=z.object({holder_user_id:uuid.nullable().optional(),holder_employee_id:uuid.nullable().optional(),client_mutation_id:uuid,reason:z.string().trim().max(1000).nullable().optional()}).strict();
const bundleBody=z.object({label:z.string().trim().min(1).max(160),key_ids:z.array(uuid).min(1).refine(ids=>new Set(ids).size===ids.length,'Bundle keys must be unique'),client_mutation_id:uuid}).strict();
const bundleReturnBody=z.object({key_ids:z.array(uuid).min(1).refine(ids=>new Set(ids).size===ids.length,'Bundle keys must be unique'),client_mutation_id:uuid,reason:z.string().trim().max(1000).nullable().optional()}).strict();

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
keysRouter.use((req,res,next)=>/^\/keys/.test(req.path)?requireAuth(req,res,()=>['POST','PATCH','PUT','DELETE'].includes(req.method)?requireCsrf(req,res,next):next()):next());

keysRouter.get('/keys',requirePermission('keys:read',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const scope=effectivePermissionScope(normalizePermissionGrants(req.user!.permissionGrants,req.user!.permissions),'keys:read',{role:req.user!.role,isSystemAdmin:req.user!.isSystemAdmin===true});
    const siteFilter=scope==='site'?' AND k.site_id = ANY($2::uuid[])':'';
    const values=siteFilter?[req.user!.tenantId,req.user!.siteIds??[]]:[req.user!.tenantId];
    res.json((await query(`SELECT k.id,k.site_id,k.key_code,k.label,k.key_type,k.status,k.holder_user_id,k.holder_employee_id,k.issued_at,k.returned_at,k.lost_at,k.deactivated_at,k.created_at,k.updated_at
      FROM keys k WHERE k.tenant_id=$1${siteFilter} ORDER BY k.label`,values)).rows);
  }catch(error){next(error);}
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

keysRouter.post('/keys/bundles',requirePermission('keys:write',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const body=bundleBody.parse(req.body);
    const result=await withTransaction(client=>runIdempotentMutation(client,{tenantId:req.user!.tenantId,userId:req.user!.id,mutationId:body.client_mutation_id,action:'keys.bundle_create',payload:req.body},async tx=>{
      const keys=(await tx.query('SELECT id,site_id,status FROM keys WHERE tenant_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE',[req.user!.tenantId,body.key_ids])).rows as Array<{id:string;site_id:string|null;status:string}>;
      if(keys.length!==body.key_ids.length)throw Object.assign(new Error('Every bundle key must exist in the tenant'),{status:404});
      const siteId=keys[0]?.site_id??null;
      if(keys.some(key=>key.site_id!==siteId))throw Object.assign(new Error('All bundle keys must belong to one site'),{status:400});
      if(keys.some(key=>!['available','issued'].includes(key.status)))throw Object.assign(new Error('Only available or issued keys may be bundled'),{status:409});
      keyPermission(req,'keys:write',siteId);
      const bundle=(await tx.query(`INSERT INTO key_bundles(tenant_id,site_id,label,created_by,created_session_id) VALUES($1,$2,$3,$4,$5) RETURNING *`,
        [req.user!.tenantId,siteId,body.label,req.user!.id,session(req)])).rows[0];
      for(const [index,key] of keys.entries()){
        await tx.query('INSERT INTO key_bundle_members(tenant_id,bundle_id,key_id,position) VALUES($1,$2,$3,$4)',
          [req.user!.tenantId,bundle.id,key.id,index+1]);
      }
      await tx.query('INSERT INTO audit_events(tenant_id,actor_user_id,event_type,entity_type,entity_id,details) VALUES($1,$2,$3,$4,$5,$6)',
        [req.user!.tenantId,req.user!.id,'keys.bundle_created','key_bundle',bundle.id,{site_id:siteId,key_ids:keys.map(key=>key.id)}]);
      return {...bundle,key_ids:keys.map(key=>key.id)};
    }));
    res.status(result.replayed?200:201).json(result.response);
  }catch(error){next(error);}
});

keysRouter.post('/keys/bundles/:id/return',requirePermission('keys:return',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const body=bundleReturnBody.parse(req.body);
    const result=await withTransaction(client=>runIdempotentMutation(client,{tenantId:req.user!.tenantId,userId:req.user!.id,mutationId:body.client_mutation_id,action:'keys.bundle_return',payload:req.body},async tx=>{
      const bundle=(await tx.query('SELECT * FROM key_bundles WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[req.user!.tenantId,String(req.params.id)])).rows[0] as {id:string;site_id:string|null;status:string}|undefined;
      if(!bundle)throw Object.assign(new Error('Key bundle not found'),{status:404});
      if(bundle.status!=='active')throw Object.assign(new Error('Key bundle is not active'),{status:409});
      keyPermission(req,'keys:return',bundle.site_id);
      const keys=(await tx.query(`SELECT k.id,k.site_id,k.status,k.holder_user_id,k.holder_employee_id
        FROM key_bundle_members bm JOIN keys k ON k.tenant_id=bm.tenant_id AND k.id=bm.key_id
        WHERE bm.tenant_id=$1 AND bm.bundle_id=$2 AND k.id=ANY($3::uuid[])
        ORDER BY k.id FOR UPDATE OF k`,
        [req.user!.tenantId,bundle.id,body.key_ids])).rows as Array<{id:string;site_id:string|null;status:'available'|'issued'|'lost'|'deactivated';holder_user_id:string|null;holder_employee_id:string|null}>;
      const selected=validateBundleReturn(keys,body.key_ids,{actorUserId:req.user!.id,operator:operator(req)});
      const returned=[];
      for(const key of selected){
        keyPermission(req,'keys:return',key.site_id);
        const updated=(await tx.query(`UPDATE keys SET status='available',holder_user_id=NULL,holder_employee_id=NULL,returned_at=now(),returned_by=$3,updated_at=now()
          WHERE tenant_id=$1 AND id=$2 RETURNING *`,[req.user!.tenantId,key.id,req.user!.id])).rows[0];
        const movement=(await tx.query(`INSERT INTO key_movements(tenant_id,key_id,movement_type,from_status,to_status,holder_user_id,holder_employee_id,actor_user_id,session_id,device_id,reason)
          VALUES($1,$2,'returned','issued','available',$3,$4,$5,$6,(SELECT device_id FROM sessions WHERE tenant_id=$1 AND id=$6),$7) RETURNING *`,
          [req.user!.tenantId,key.id,key.holder_user_id,key.holder_employee_id,req.user!.id,session(req),body.reason??null])).rows[0];
        await tx.query('INSERT INTO audit_events(tenant_id,actor_user_id,event_type,entity_type,entity_id,details) VALUES($1,$2,$3,$4,$5,$6)',
          [req.user!.tenantId,req.user!.id,'keys.bundle_returned','key',key.id,{bundle_id:bundle.id,movement_id:movement.id}]);
        returned.push({key:updated,movement});
      }
      return {bundle_id:bundle.id,returned_key_ids:selected.map(key=>key.id),returned};
    }));
    res.status(200).json(result.response);
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
