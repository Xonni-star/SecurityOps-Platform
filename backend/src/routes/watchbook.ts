import {Router,Request} from 'express';
import {z} from 'zod';
import {query,withTransaction} from '../db/pool.js';
import {requireAuth,requireCsrf,requirePermission} from '../middleware/auth.js';
import {recordAudit} from '../services/audit.js';
import {mergeCorrection} from '../services/watchbook.js';
import {parseSyncConflictStrategy,runIdempotentMutation} from '../services/offline-sync.js';

const uuid=z.string().uuid();
const nonempty=z.string().trim().min(1);
const priorityCode=z.enum(['critical','high','medium','low']);
const revisionInput=z.object({
  category_id:uuid,
  priority_code:priorityCode,
  content:nonempty.max(10000),
  status:z.enum(['open','closed']).optional(),
}).strict();
type CreateEntryBody=z.infer<typeof revisionInput>&{site_id?:string|null;client_entry_id?:string};

export const watchbookRouter=Router();
watchbookRouter.use((req,res,next)=>/^\/watchbook/.test(req.path)
  ?requireAuth(req,res,()=>['POST','PATCH','PUT','DELETE'].includes(req.method)?requireCsrf(req,res,next):next())
  :next());

watchbookRouter.get('/watchbook/categories',requirePermission('watchbook:read'),async(req,res,next)=>{
  try{res.json((await query('SELECT id,code,name,created_at FROM watchbook_categories WHERE tenant_id=$1 ORDER BY name',[req.user!.tenantId])).rows);}
  catch(error){next(error);}
});
watchbookRouter.post('/watchbook/categories',requirePermission('watchbook_categories:write'),async(req,res,next)=>{
  try{
    const body=z.object({code:nonempty.max(64).regex(/^[a-z0-9_-]+$/),name:nonempty.max(120)}).strict().parse(req.body);
    const row=(await query('INSERT INTO watchbook_categories(tenant_id,code,name) VALUES($1,$2,$3) RETURNING id,code,name,created_at',[req.user!.tenantId,body.code,body.name])).rows[0];
    await recordAudit(req.user!.tenantId,req.user!.id,'watchbook.category.created','watchbook_category',row.id,{code:body.code});
    res.status(201).json(row);
  }catch(error){next(error);}
});
watchbookRouter.get('/watchbook/priorities',requirePermission('watchbook:read'),async(req,res,next)=>{
  try{res.json((await query('SELECT id,code,name,rank,color,created_at FROM watchbook_priorities WHERE tenant_id=$1 ORDER BY rank',[req.user!.tenantId])).rows);}
  catch(error){next(error);}
});
watchbookRouter.post('/watchbook/priorities',requirePermission('watchbook_priorities:write'),async(req,res,next)=>{
  try{
    const body=z.object({code:priorityCode,name:nonempty.max(120),rank:z.number().int().positive(),color:z.string().regex(/^#[0-9a-f]{6}$/i)}).strict().parse(req.body);
    const row=(await query('INSERT INTO watchbook_priorities(tenant_id,code,name,rank,color) VALUES($1,$2,$3,$4,$5) RETURNING id,code,name,rank,color,created_at',[req.user!.tenantId,body.code,body.name,body.rank,body.color])).rows[0];
    await recordAudit(req.user!.tenantId,req.user!.id,'watchbook.priority.created','watchbook_priority',row.id,{code:body.code});
    res.status(201).json(row);
  }catch(error){next(error);}
});

async function createEntry(req:Express.Request,body:CreateEntryBody,client?:import('pg').PoolClient){
  const run=client?client.query.bind(client):query;
  const audit=(eventType:string,entityId:string,details:Record<string,unknown>)=>client
    ?client.query('INSERT INTO audit_events(tenant_id,actor_user_id,event_type,entity_type,entity_id,details) VALUES($1,$2,$3,$4,$5,$6)',[req.user!.tenantId,req.user!.id,eventType,'watchbook_entry',entityId,details]).then(()=>undefined)
    :recordAudit(req.user!.tenantId,req.user!.id,eventType,'watchbook_entry',entityId,details);
  const category=(await run('SELECT id FROM watchbook_categories WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,body.category_id])).rows[0];
  const priority=(await run('SELECT id FROM watchbook_priorities WHERE tenant_id=$1 AND code=$2',[req.user!.tenantId,body.priority_code])).rows[0];
  if(!category||!priority)throw Object.assign(new Error('Kategorie oder Priorität nicht gefunden.'),{status:404});
  if(!req.sessionDbId)throw Object.assign(new Error('Session-Identität fehlt.'),{status:401});
  const entry=(await run(`INSERT INTO watchbook_entries(tenant_id,site_id,created_by,created_session_id,client_entry_id)
    VALUES($1,$2,$3,$4,$5) RETURNING id,tenant_id,site_id,created_by,created_at,client_entry_id`,
    [req.user!.tenantId,body.site_id??null,req.user!.id,req.sessionDbId,body.client_entry_id??null])).rows[0];
  const revision=(await run(`INSERT INTO watchbook_revisions(tenant_id,entry_id,revision_no,category_id,priority_id,content,status,authored_by,authored_session_id,authored_device_id)
    VALUES($1,$2,1,$3,$4,$5,$6,$7,$8,(SELECT device_id FROM sessions WHERE id=$8))
    RETURNING *`,[req.user!.tenantId,entry.id,category.id,priority.id,body.content,body.status??'open',req.user!.id,req.sessionDbId])).rows[0];
  await audit('watchbook.entry.created',entry.id,{revision_id:revision.id,revision_no:1});
  return {entry,revision};
}

watchbookRouter.get('/watchbook/entries',requirePermission('watchbook:read'),async(req,res,next)=>{
  try{
    const rows=(await query(`SELECT e.id,e.site_id,e.created_by,e.created_at,e.client_entry_id,
      r.id revision_id,r.revision_no,r.content,r.status,r.created_at revision_created_at,
      c.id category_id,c.code category_code,c.name category_name,
      p.id priority_id,p.code priority_code,p.name priority_name,p.rank priority_rank,
      u.email author_email
      FROM watchbook_entries e
      JOIN LATERAL (SELECT * FROM watchbook_revisions r0 WHERE r0.tenant_id=e.tenant_id AND r0.entry_id=e.id ORDER BY r0.revision_no DESC LIMIT 1) r ON true
      JOIN watchbook_categories c ON c.id=r.category_id
      JOIN watchbook_priorities p ON p.id=r.priority_id
      JOIN users u ON u.id=r.authored_by
      WHERE e.tenant_id=$1 ORDER BY e.created_at DESC`,[req.user!.tenantId])).rows;
    res.json(rows);
  }catch(error){next(error);}
});
watchbookRouter.get('/watchbook/entries/:id/history',requirePermission('watchbook:read'),async(req,res,next)=>{
  try{res.json((await query(`SELECT r.*,c.code category_code,c.name category_name,p.code priority_code,p.name priority_name,u.email author_email
    FROM watchbook_revisions r JOIN watchbook_categories c ON c.id=r.category_id JOIN watchbook_priorities p ON p.id=r.priority_id
    JOIN users u ON u.id=r.authored_by WHERE r.tenant_id=$1 AND r.entry_id=$2 ORDER BY r.revision_no`,[req.user!.tenantId,req.params.id])).rows);}
  catch(error){next(error);}
});
watchbookRouter.post('/watchbook/entries',requirePermission('watchbook:write'),async(req,res,next)=>{
  try{
    const body=revisionInput.extend({site_id:uuid.nullable().optional(),client_entry_id:uuid.optional(),conflict_strategy:z.enum(['USE_LOCAL','USE_SERVER','RECORD_AS_EXCEPTION']).optional()}).strict().parse(req.body);
    const mutationId=req.get('Idempotency-Key')??body.client_entry_id;
    if(req.get('Idempotency-Key')&&body.client_entry_id&&req.get('Idempotency-Key')!==body.client_entry_id)return res.status(400).json({error:'Idempotency-Key und client_entry_id müssen übereinstimmen.'});
    if(!mutationId)return res.status(400).json({error:'client_entry_id oder Idempotency-Key ist erforderlich.'});
    const result=await withTransaction(client=>runIdempotentMutation(client,{tenantId:req.user!.tenantId,userId:req.user!.id,mutationId:uuid.parse(mutationId),action:'watchbook.entry',payload:req.body,conflictStrategy:parseSyncConflictStrategy(body.conflict_strategy)},tx=>createEntry(req,body,tx)));
    res.status(result.replayed?200:201).json(result.response);
  }catch(error){next(error);}
});
watchbookRouter.post('/watchbook/entries/:id/corrections',requirePermission('watchbook:correct'),async(req,res,next)=>{
  try{
    const body=z.object({category_id:uuid.optional(),priority_code:priorityCode.optional(),content:nonempty.max(10000).optional(),status:z.enum(['open','closed']).optional(),reason:nonempty.max(2000)}).strict().parse(req.body);
    const result=await withTransaction(async client=>{
      const current=(await client.query(`SELECT r.* FROM watchbook_revisions r WHERE r.tenant_id=$1 AND r.entry_id=$2 ORDER BY r.revision_no DESC LIMIT 1 FOR SHARE`,[req.user!.tenantId,req.params.id])).rows[0];
      if(!current)throw Object.assign(new Error('Wachbucheintrag nicht gefunden.'),{status:404});
      const categoryId=body.category_id??current.category_id;
      const priorityId=body.priority_code?(await client.query('SELECT id FROM watchbook_priorities WHERE tenant_id=$1 AND code=$2',[req.user!.tenantId,body.priority_code])).rows[0]?.id:current.priority_id;
      if(!priorityId||(body.category_id&&(await client.query('SELECT id FROM watchbook_categories WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,body.category_id])).rowCount===0))throw Object.assign(new Error('Kategorie oder Priorität nicht gefunden.'),{status:404});
      const next=mergeCorrection({categoryId:current.category_id,priorityId:current.priority_id,content:current.content,status:current.status},{
        categoryId,priorityId,content:body.content,status:body.status,
      });
      if(!req.sessionDbId)throw Object.assign(new Error('Session-Identität fehlt.'),{status:401});
      const revision=(await client.query(`INSERT INTO watchbook_revisions(tenant_id,entry_id,revision_no,category_id,priority_id,content,status,correction_of_revision_id,authored_by,authored_session_id,authored_device_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,(SELECT device_id FROM sessions WHERE id=$10)) RETURNING *`,
        [req.user!.tenantId,String(req.params.id),current.revision_no+1,next.categoryId,next.priorityId,next.content,next.status,current.id,req.user!.id,req.sessionDbId])).rows[0];
      await client.query('INSERT INTO audit_events(tenant_id,actor_user_id,event_type,entity_type,entity_id,details) VALUES($1,$2,$3,$4,$5,$6)',[req.user!.tenantId,req.user!.id,'watchbook.entry.corrected','watchbook_entry',String(req.params.id),{revision_id:revision.id,revision_no:revision.revision_no,reason:body.reason}]);
      return revision;
    });
    res.status(201).json(result);
  }catch(error){next(error);}
});
