import {Router,Request} from 'express';
import {z} from 'zod';
import {query,withTransaction} from '../db/pool.js';
import {requireAuth,requireCsrf,requirePermission} from '../middleware/auth.js';
import {runIdempotentMutation} from '../services/offline-sync.js';
import {canAccessResource,effectivePermissionScope,normalizePermissionGrants} from '../types/authorization.js';
import {canConfirmParticipant,canonicalEventHash,participantIdentityIsValid} from '../services/handover-domain.js';

const uuid=z.string().uuid();
const mutation=z.object({client_mutation_id:uuid}).strict();

function session(req:Request){
  if(!req.sessionDbId)throw Object.assign(new Error('Session-Identität fehlt.'),{status:401});
  return req.sessionDbId;
}

function scopeFor(req:Request,permission:string,siteId:string,ownerId?:string|null){
  const user=req.user!;
  const grants=normalizePermissionGrants(user.permissionGrants,user.permissions);
  const scope=effectivePermissionScope(grants,permission,{role:user.role,isSystemAdmin:user.isSystemAdmin===true});
  const allowed=scope&&canAccessResource({
    userId:user.id,tenantId:user.tenantId,role:user.role,isSystemAdmin:user.isSystemAdmin===true,
    siteIds:user.siteIds??[],grants,
  },scope,{tenantId:user.tenantId,siteId,ownerId});
  if(!allowed)throw Object.assign(new Error('Insufficient permissions for this handover scope'),{status:403});
  return scope;
}

function operator(req:Request){
  return req.user!.role==='admin'||req.user!.role==='operator'||req.user!.isSystemAdmin===true;
}

async function appendEvent(client:import('pg').PoolClient,input:{
  tenantId:string;handoverId:string;eventType:string;payload:Record<string,unknown>;actorUserId:string;sessionId:string;
}){
  const latest=(await client.query<{sequence_no:number;event_hash:string}>(
    'SELECT sequence_no,event_hash FROM handover_events WHERE tenant_id=$1 AND handover_id=$2 ORDER BY sequence_no DESC LIMIT 1 FOR UPDATE',
    [input.tenantId,input.handoverId],
  )).rows[0];
  const sequenceNo=(latest?.sequence_no??0)+1;
  const previousEventHash=latest?.event_hash??null;
  const eventHash=canonicalEventHash({
    handoverId:input.handoverId,sequenceNo,eventType:input.eventType,payload:input.payload,
    actorUserId:input.actorUserId,sessionId:input.sessionId,previousEventHash,
  });
  return (await client.query(
    `INSERT INTO handover_events(tenant_id,handover_id,sequence_no,event_type,payload,actor_user_id,session_id,device_id,previous_event_hash,event_hash)
     VALUES($1,$2,$3,$4,$5,$6,$7,(SELECT device_id FROM sessions WHERE tenant_id=$1 AND id=$7),$8,$9) RETURNING *`,
    [input.tenantId,input.handoverId,sequenceNo,input.eventType,input.payload,input.actorUserId,input.sessionId,previousEventHash,eventHash],
  )).rows[0];
}

async function handover(client:import('pg').PoolClient,tenantId:string,id:string){
  return (await client.query(
    'SELECT * FROM handover_records WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
    [tenantId,id],
  )).rows[0];
}

export const handoversRouter=Router();
handoversRouter.use((req,res,next)=>/^\/handover-protocols/.test(req.path)
  ?requireAuth(req,res,()=>['POST','PATCH','PUT','DELETE'].includes(req.method)?requireCsrf(req,res,next):next())
  :next());

handoversRouter.get('/handover-protocols',requirePermission('handover:read',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const user=req.user!;
    const grants=normalizePermissionGrants(user.permissionGrants,user.permissions);
    const scope=effectivePermissionScope(grants,'handover:read',{role:user.role,isSystemAdmin:user.isSystemAdmin===true});
    const siteFilter=scope==='site'?' AND h.site_id = ANY($2::uuid[])':'';
    const values=siteFilter?[user.tenantId,user.siteIds??[]]:[user.tenantId];
    const rows=(await query(`SELECT h.id,h.site_id,h.shift_id,h.title,h.status,h.created_by,h.created_at,
      (SELECT count(*) FROM handover_participants p WHERE p.tenant_id=h.tenant_id AND p.handover_id=h.id AND p.state='active') participant_count,
      (SELECT count(*) FROM handover_confirmations c WHERE c.tenant_id=h.tenant_id AND c.handover_id=h.id AND c.state='confirmed') confirmation_count
      FROM handover_records h WHERE h.tenant_id=$1${siteFilter} ORDER BY h.created_at DESC`,values)).rows;
    res.json(rows);
  }catch(error){next(error);}
});

handoversRouter.post('/handover-protocols',requirePermission('handover:write',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const body=z.object({
      site_id:uuid,shift_id:uuid.nullable().optional(),title:z.string().trim().min(1).max(200),
      ...mutation.shape,
    }).strict().parse(req.body);
    scopeFor(req,'handover:write',body.site_id);
    const result=await withTransaction(client=>runIdempotentMutation(client,{
      tenantId:req.user!.tenantId,userId:req.user!.id,mutationId:body.client_mutation_id,action:'handover.create',payload:req.body,
    },async tx=>{
      const created=(await tx.query(
        `INSERT INTO handover_records(tenant_id,site_id,shift_id,title,created_by,created_session_id,created_device_id,client_mutation_id)
         VALUES($1,$2,$3,$4,$5,$6,(SELECT device_id FROM sessions WHERE tenant_id=$1 AND id=$6),$7) RETURNING *`,
        [req.user!.tenantId,body.site_id,body.shift_id??null,body.title,req.user!.id,session(req),body.client_mutation_id],
      )).rows[0];
      await appendEvent(tx,{tenantId:req.user!.tenantId,handoverId:created.id,eventType:'created',payload:{title:created.title,site_id:created.site_id},actorUserId:req.user!.id,sessionId:session(req)});
      return created;
    }));
    res.status(result.replayed?200:201).json(result.response);
  }catch(error){next(error);}
});

handoversRouter.get('/handover-protocols/:id',requirePermission('handover:read',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const row=(await query('SELECT * FROM handover_records WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,String(req.params.id)])).rows[0];
    if(!row)return res.status(404).json({error:'Handover not found'});
    scopeFor(req,'handover:read',row.site_id,row.created_by);
    const [participants,confirmations,events]=(await Promise.all([
      query('SELECT * FROM handover_participants WHERE tenant_id=$1 AND handover_id=$2 ORDER BY created_at',[req.user!.tenantId,row.id]),
      query(`SELECT DISTINCT ON (participant_id) * FROM handover_confirmations WHERE tenant_id=$1 AND handover_id=$2 ORDER BY participant_id,confirmed_at DESC`,[req.user!.tenantId,row.id]),
      query('SELECT * FROM handover_events WHERE tenant_id=$1 AND handover_id=$2 ORDER BY sequence_no',[req.user!.tenantId,row.id]),
    ]));
    res.json({...row,participants:participants.rows,confirmations:confirmations.rows,events:events.rows});
  }catch(error){next(error);}
});

handoversRouter.post('/handover-protocols/:id/participants',requirePermission('handover:write',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const body=z.object({
      participant_role:z.enum(['outgoing','incoming','witness']),
      user_id:uuid.nullable().optional(),employee_id:uuid.nullable().optional(),...mutation.shape,
    }).strict().parse(req.body);
    const result=await withTransaction(client=>runIdempotentMutation(client,{
      tenantId:req.user!.tenantId,userId:req.user!.id,mutationId:body.client_mutation_id,action:'handover.participant',payload:{...req.body,handover_id:String(req.params.id)},
    },async tx=>{
      const record=await handover(tx,req.user!.tenantId,String(req.params.id));
      if(!record)throw Object.assign(new Error('Handover not found'),{status:404});
      scopeFor(req,'handover:write',record.site_id);
      if(!participantIdentityIsValid({userId:body.user_id,employeeId:body.employee_id}))throw Object.assign(new Error('Exactly one participant identity is required'),{status:400});
      const participant=(await tx.query(
        `INSERT INTO handover_participants(tenant_id,handover_id,participant_role,user_id,employee_id,assigned_by,assigned_session_id,assigned_device_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,(SELECT device_id FROM sessions WHERE tenant_id=$1 AND id=$7)) RETURNING *`,
        [req.user!.tenantId,record.id,body.participant_role,body.user_id??null,body.employee_id??null,req.user!.id,session(req)],
      )).rows[0];
      await appendEvent(tx,{tenantId:req.user!.tenantId,handoverId:record.id,eventType:'participant_assigned',payload:{participant_id:participant.id,participant_role:participant.participant_role},actorUserId:req.user!.id,sessionId:session(req)});
      return participant;
    }));
    res.status(result.replayed?200:201).json(result.response);
  }catch(error){next(error);}
});

handoversRouter.post('/handover-protocols/:id/participants/:participantId/revoke',requirePermission('handover:revoke',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const body=z.object({reason:z.string().trim().min(1).max(2000),...mutation.shape}).strict().parse(req.body);
    const result=await withTransaction(client=>runIdempotentMutation(client,{
      tenantId:req.user!.tenantId,userId:req.user!.id,mutationId:body.client_mutation_id,action:'handover.revoke',payload:{...req.body,handover_id:String(req.params.id),participant_id:String(req.params.participantId)},
    },async tx=>{
      const record=await handover(tx,req.user!.tenantId,String(req.params.id));
      if(!record)throw Object.assign(new Error('Handover not found'),{status:404});
      scopeFor(req,'handover:revoke',record.site_id);
      const participant=(await tx.query('SELECT * FROM handover_participants WHERE tenant_id=$1 AND handover_id=$2 AND id=$3',[req.user!.tenantId,record.id,String(req.params.participantId)])).rows[0];
      if(!participant)throw Object.assign(new Error('Participant not found'),{status:404});
      if(participant.state==='revoked')throw Object.assign(new Error('Participant already revoked'),{status:409});
      await tx.query('UPDATE handover_participants SET state=\'revoked\' WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,participant.id]);
      await appendEvent(tx,{tenantId:req.user!.tenantId,handoverId:record.id,eventType:'participant_revoked',payload:{participant_id:participant.id,reason:body.reason},actorUserId:req.user!.id,sessionId:session(req)});
      await tx.query(`UPDATE handover_records SET status='open' WHERE tenant_id=$1 AND id=$2 AND status='confirmed'`,[req.user!.tenantId,record.id]);
      return {...participant,state:'revoked'};
    }));
    res.status(result.replayed?200:201).json(result.response);
  }catch(error){next(error);}
});

handoversRouter.post('/handover-protocols/:id/confirmations',requirePermission('handover:confirm',{allowedScopes:['own','tenant','system']}),async(req,res,next)=>{
  try{
    const body=z.object({participant_id:uuid,note:z.string().trim().max(2000).nullable().optional(),...mutation.shape}).strict().parse(req.body);
    const result=await withTransaction(client=>runIdempotentMutation(client,{
      tenantId:req.user!.tenantId,userId:req.user!.id,mutationId:body.client_mutation_id,action:'handover.confirm',payload:{...req.body,handover_id:String(req.params.id)},
    },async tx=>{
      const record=await handover(tx,req.user!.tenantId,String(req.params.id));
      if(!record)throw Object.assign(new Error('Handover not found'),{status:404});
      const participant=(await tx.query('SELECT * FROM handover_participants WHERE tenant_id=$1 AND handover_id=$2 AND id=$3',[req.user!.tenantId,record.id,body.participant_id])).rows[0];
      if(!participant||participant.state==='revoked')throw Object.assign(new Error('Active participant not found'),{status:404});
      const grants=normalizePermissionGrants(req.user!.permissionGrants,req.user!.permissions);
      const confirmationScope=effectivePermissionScope(grants,'handover:confirm',{role:req.user!.role,isSystemAdmin:req.user!.isSystemAdmin===true});
      if(confirmationScope==='own'&&!canConfirmParticipant({actorUserId:req.user!.id,participantUserId:participant.user_id,participantEmployeeId:participant.employee_id,operator:operator(req)}))throw Object.assign(new Error('Only the bound participant may confirm'),{status:403});
      const previous=(await tx.query('SELECT * FROM handover_confirmations WHERE tenant_id=$1 AND participant_id=$2 ORDER BY confirmed_at DESC LIMIT 1 FOR SHARE',[req.user!.tenantId,participant.id])).rows[0];
      const confirmation=(await tx.query(
        `INSERT INTO handover_confirmations(tenant_id,handover_id,participant_id,state,note,session_id,device_id,supersedes_confirmation_id)
         VALUES($1,$2,$3,'confirmed',$4,$5,(SELECT device_id FROM sessions WHERE tenant_id=$1 AND id=$5),$6) RETURNING *`,
        [req.user!.tenantId,record.id,participant.id,body.note??null,session(req),previous?.id??null],
      )).rows[0];
      await appendEvent(tx,{tenantId:req.user!.tenantId,handoverId:record.id,eventType:'confirmation_recorded',payload:{participant_id:participant.id,confirmation_id:confirmation.id},actorUserId:req.user!.id,sessionId:session(req)});
      const active=(await tx.query(`SELECT p.id FROM handover_participants p WHERE p.tenant_id=$1 AND p.handover_id=$2 AND p.state='active'`,[req.user!.tenantId,record.id])).rows;
      const confirmed=(await tx.query(`SELECT DISTINCT ON (participant_id) participant_id,state FROM handover_confirmations WHERE tenant_id=$1 AND handover_id=$2 ORDER BY participant_id,confirmed_at DESC`,[req.user!.tenantId,record.id])).rows;
      if(active.length>0&&active.every(item=>confirmed.some(value=>value.participant_id===item.id&&value.state==='confirmed'))){
        await tx.query(`UPDATE handover_records SET status='confirmed' WHERE tenant_id=$1 AND id=$2 AND status='open'`,[req.user!.tenantId,record.id]);
      }
      return confirmation;
    }));
    res.status(result.replayed?200:201).json(result.response);
  }catch(error){next(error);}
});

handoversRouter.post('/handover-protocols/:id/confirmations/:confirmationId/revoke',requirePermission('handover:confirm',{allowedScopes:['own','tenant','system']}),async(req,res,next)=>{
  try{
    const body=z.object({reason:z.string().trim().min(1).max(2000),...mutation.shape}).strict().parse(req.body);
    const result=await withTransaction(client=>runIdempotentMutation(client,{
      tenantId:req.user!.tenantId,userId:req.user!.id,mutationId:body.client_mutation_id,action:'handover.revoke',payload:{...req.body,handover_id:String(req.params.id),confirmation_id:String(req.params.confirmationId)},
    },async tx=>{
      const record=await handover(tx,req.user!.tenantId,String(req.params.id));
      if(!record)throw Object.assign(new Error('Handover not found'),{status:404});
      const existing=(await tx.query(`SELECT c.*,p.user_id,p.employee_id FROM handover_confirmations c JOIN handover_participants p ON p.tenant_id=c.tenant_id AND p.id=c.participant_id
        WHERE c.tenant_id=$1 AND c.handover_id=$2 AND c.id=$3`,[req.user!.tenantId,record.id,String(req.params.confirmationId)])).rows[0];
      if(!existing)throw Object.assign(new Error('Confirmation not found'),{status:404});
      const grants=normalizePermissionGrants(req.user!.permissionGrants,req.user!.permissions);
      const confirmationScope=effectivePermissionScope(grants,'handover:confirm',{role:req.user!.role,isSystemAdmin:req.user!.isSystemAdmin===true});
      if(confirmationScope==='own'&&!canConfirmParticipant({actorUserId:req.user!.id,participantUserId:existing.user_id,participantEmployeeId:existing.employee_id,operator:operator(req)}))throw Object.assign(new Error('Only the bound participant may revoke this confirmation'),{status:403});
      const revoked=(await tx.query(
        `INSERT INTO handover_confirmations(tenant_id,handover_id,participant_id,state,note,session_id,device_id,supersedes_confirmation_id)
         VALUES($1,$2,$3,'revoked',$4,$5,(SELECT device_id FROM sessions WHERE tenant_id=$1 AND id=$5),$6) RETURNING *`,
        [req.user!.tenantId,record.id,existing.participant_id,body.reason,session(req),existing.id],
      )).rows[0];
      await appendEvent(tx,{tenantId:req.user!.tenantId,handoverId:record.id,eventType:'confirmation_revoked',payload:{participant_id:existing.participant_id,confirmation_id:revoked.id,reason:body.reason},actorUserId:req.user!.id,sessionId:session(req)});
      await tx.query(`UPDATE handover_records SET status='open' WHERE tenant_id=$1 AND id=$2 AND status='confirmed'`,[req.user!.tenantId,record.id]);
      return revoked;
    }));
    res.status(result.replayed?200:201).json(result.response);
  }catch(error){next(error);}
});

handoversRouter.post('/handover-protocols/:id/corrections',requirePermission('handover:correct',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const body=z.object({reason:z.string().trim().min(1).max(2000),changes:z.record(z.string(),z.unknown()),...mutation.shape}).strict().parse(req.body);
    const result=await withTransaction(client=>runIdempotentMutation(client,{
      tenantId:req.user!.tenantId,userId:req.user!.id,mutationId:body.client_mutation_id,action:'handover.correct',payload:{...req.body,handover_id:String(req.params.id)},
    },async tx=>{
      const record=await handover(tx,req.user!.tenantId,String(req.params.id));
      if(!record)throw Object.assign(new Error('Handover not found'),{status:404});
      scopeFor(req,'handover:correct',record.site_id);
      const event=await appendEvent(tx,{tenantId:req.user!.tenantId,handoverId:record.id,eventType:'corrected',payload:{reason:body.reason,changes:body.changes},actorUserId:req.user!.id,sessionId:session(req)});
      return event;
    }));
    res.status(result.replayed?200:201).json(result.response);
  }catch(error){next(error);}
});
