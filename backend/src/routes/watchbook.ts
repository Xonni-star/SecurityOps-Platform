import {Router,Request} from 'express';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {query,withTransaction} from '../db/pool.js';
import {requireAuth,requireCsrf,requirePermission} from '../middleware/auth.js';
import {recordAudit} from '../services/audit.js';
import {mergeCorrection} from '../services/watchbook.js';
import {parseSyncConflictStrategy,runIdempotentMutation} from '../services/offline-sync.js';
import {computeRevisionIntegrity,hashChain,verifyHash,verifyRevisionIntegrity} from '../services/watchbook-integrity.js';

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
  await run('SELECT pg_advisory_xact_lock(hashtext($1))',[req.user!.tenantId]);
  const previousEntry=(await run('SELECT entry_hash FROM watchbook_entries WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE',[req.user!.tenantId])).rows[0]?.entry_hash??null;
  const entryCreatedAt=new Date().toISOString();
  const entryIntegrity=hashChain({site_id:body.site_id??null,created_by:req.user!.id,created_session_id:req.sessionDbId,created_at:entryCreatedAt},previousEntry);
  const entry=(await run(`INSERT INTO watchbook_entries(tenant_id,site_id,created_by,created_session_id,client_entry_id,created_at,previous_entry_hash,entry_content_hash,entry_hash,entry_hmac)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,tenant_id,site_id,created_by,created_at,client_entry_id,entry_hash`,
    [req.user!.tenantId,body.site_id??null,req.user!.id,req.sessionDbId,body.client_entry_id??null,entryCreatedAt,previousEntry,entryIntegrity.contentHash,entryIntegrity.chainHash,entryIntegrity.integrityHmac])).rows[0];
  const revisionId=randomUUID();const revisionCreatedAt=new Date().toISOString();
  const revisionIntegrity=hashChain({entry_id:entry.id,revision_no:1,category_id:category.id,priority_id:priority.id,content:body.content,status:body.status??'open',authored_by:req.user!.id,authored_session_id:req.sessionDbId,created_at:revisionCreatedAt},entry.entry_hash);
  const canonicalRevision=computeRevisionIntegrity({tenant_id:req.user!.tenantId,entry_id:entry.id,revision_id:revisionId,revision_no:1,created_at:revisionCreatedAt,canonical_payload:{category_id:category.id,priority_id:priority.id,content:body.content,status:body.status??'open',authored_by:req.user!.id,authored_session_id:req.sessionDbId},previous_revision_hash:null});
  const revision=(await run(`INSERT INTO watchbook_revisions(id,tenant_id,entry_id,revision_no,category_id,priority_id,content,status,authored_by,authored_session_id,authored_device_id,created_at,previous_hash,content_hash,chain_hash,integrity_hmac,canonical_payload_hash,previous_revision_hash,revision_hash,hash_algorithm_version,hmac_version)
    VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,$9,(SELECT device_id FROM sessions WHERE id=$9),$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
    RETURNING *`,[revisionId,req.user!.tenantId,entry.id,category.id,priority.id,body.content,body.status??'open',req.user!.id,req.sessionDbId,revisionCreatedAt,entry.entry_hash,revisionIntegrity.contentHash,revisionIntegrity.chainHash,revisionIntegrity.integrityHmac,canonicalRevision.canonicalPayloadHash,null,canonicalRevision.revisionHash,'sha256-v1',canonicalRevision.hmacVersion])).rows[0];
  await audit('watchbook.entry.created',entry.id,{revision_id:revision.id,revision_no:1});
  return {entry,revision};
}

watchbookRouter.get('/watchbook/entries',requirePermission('watchbook:read'),async(req,res,next)=>{
  try{
    const rows=(await query(`SELECT e.id,e.site_id,e.created_by,e.created_at,e.client_entry_id,
      r.id revision_id,r.revision_no,r.content,r.status,r.created_at revision_created_at,r.chain_hash,
      c.id category_id,c.code category_code,c.name category_name,
      p.id priority_id,p.code priority_code,p.name priority_name,p.rank priority_rank,
      u.email author_email,
      (SELECT ae.details->>'reason' FROM audit_events ae WHERE ae.tenant_id=e.tenant_id AND ae.entity_type='watchbook_entry' AND ae.entity_id=e.id AND ae.event_type='watchbook.entry.corrected' ORDER BY ae.created_at DESC LIMIT 1) correction_reason,
      (SELECT ae.created_at FROM audit_events ae WHERE ae.tenant_id=e.tenant_id AND ae.entity_type='watchbook_entry' AND ae.entity_id=e.id AND ae.event_type='watchbook.entry.corrected' ORDER BY ae.created_at DESC LIMIT 1) corrected_at
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
watchbookRouter.get('/watchbook/integrity',requirePermission('watchbook:read'),async(req,res,next)=>{
  try{
    const entries=(await query(`SELECT * FROM watchbook_entries WHERE tenant_id=$1 ORDER BY created_at,id`,[req.user!.tenantId])).rows;
    const revisions=(await query(`SELECT * FROM watchbook_revisions WHERE tenant_id=$1 ORDER BY entry_id,revision_no`,[req.user!.tenantId])).rows;
    let previousEntry:string|null=null; const invalid:string[]=[];
    for(const entry of entries){
      const valid=verifyHash({site_id:entry.site_id,created_by:entry.created_by,created_session_id:entry.created_session_id,created_at:new Date(entry.created_at).toISOString()},entry.previous_entry_hash,entry.entry_content_hash,entry.entry_hash,entry.entry_hmac);
      if(!valid||entry.previous_entry_hash!==previousEntry)invalid.push(`entry:${entry.id}`); previousEntry=entry.entry_hash;
      let previous=entry.entry_hash;let previousRevision:string|null=null;let expectedRevisionNo=1;
      for(const revision of revisions.filter(item=>item.entry_id===entry.id)){
        const integrity=revision.revision_hash?verifyRevisionIntegrity({tenant_id:req.user!.tenantId,entry_id:revision.entry_id,revision_id:revision.id,revision_no:revision.revision_no,created_at:new Date(revision.created_at).toISOString(),canonical_payload:{category_id:revision.category_id,priority_id:revision.priority_id,content:revision.content,status:revision.status,authored_by:revision.authored_by,authored_session_id:revision.authored_session_id},previous_revision_hash:revision.previous_revision_hash??null},{canonical_payload_hash:revision.canonical_payload_hash,revision_hash:revision.revision_hash,hmac:revision.integrity_hmac,hmac_version:revision.hmac_version}):{valid:false,reason:'missing_hash',expected:null,actual:null};
        if(!integrity.valid||revision.revision_no!==expectedRevisionNo||revision.previous_revision_hash!==previousRevision)invalid.push(`revision:${revision.id}`);
        expectedRevisionNo++;previousRevision=revision.revision_hash??null;previous=revision.chain_hash;
      }
    }
    res.json({valid:invalid.length===0,checked_entries:entries.length,checked_revisions:revisions.length,invalid});
  }catch(error){next(error);}
});
watchbookRouter.get('/watchbook/entries/:id/integrity',requirePermission('watchbook:read'),async(req,res,next)=>{
  try{
    const rows=(await query(`SELECT * FROM watchbook_revisions WHERE tenant_id=$1 AND entry_id=$2 ORDER BY revision_no`,[req.user!.tenantId,req.params.id])).rows;
    let previous:null|string=null;let expectedRevisionNo=1;let firstFailure:Record<string,unknown>|null=null;
    for(const revision of rows){
      const result=revision.revision_hash?verifyRevisionIntegrity({tenant_id:req.user!.tenantId,entry_id:revision.entry_id,revision_id:revision.id,revision_no:revision.revision_no,created_at:new Date(revision.created_at).toISOString(),canonical_payload:{category_id:revision.category_id,priority_id:revision.priority_id,content:revision.content,status:revision.status,authored_by:revision.authored_by,authored_session_id:revision.authored_session_id},previous_revision_hash:revision.previous_revision_hash??null},{canonical_payload_hash:revision.canonical_payload_hash,revision_hash:revision.revision_hash,hmac:revision.integrity_hmac,hmac_version:revision.hmac_version}):{valid:false,reason:'missing_hash',expected:null,actual:null};
      if(!result.valid||revision.revision_no!==expectedRevisionNo||revision.previous_revision_hash!==previous){
        firstFailure??={revision_id:revision.id,revision_no:revision.revision_no,reason:result.reason??'order_or_predecessor_mismatch',expected_hash:result.expected?.revisionHash??null,actual_hash:result.actual??null};
      }
      expectedRevisionNo++;previous=revision.revision_hash??null;
    }
    res.json({valid:firstFailure===null,checked_revisions:rows.length,first_failure:firstFailure});
  }catch(error){next(error);}
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
      const createdAt=new Date().toISOString();const revisionId=randomUUID();
      const integrity=hashChain({entry_id:String(req.params.id),revision_no:current.revision_no+1,category_id:next.categoryId,priority_id:next.priorityId,content:next.content,status:next.status,authored_by:req.user!.id,authored_session_id:req.sessionDbId,created_at:createdAt},current.chain_hash);
      const canonicalRevision=computeRevisionIntegrity({tenant_id:req.user!.tenantId,entry_id:String(req.params.id),revision_id:revisionId,revision_no:current.revision_no+1,created_at:createdAt,canonical_payload:{category_id:next.categoryId,priority_id:next.priorityId,content:next.content,status:next.status,authored_by:req.user!.id,authored_session_id:req.sessionDbId},previous_revision_hash:current.revision_hash??null});
      const revision=(await client.query(`INSERT INTO watchbook_revisions(id,tenant_id,entry_id,revision_no,category_id,priority_id,content,status,correction_of_revision_id,authored_by,authored_session_id,authored_device_id,created_at,previous_hash,content_hash,chain_hash,integrity_hmac,canonical_payload_hash,previous_revision_hash,revision_hash,hash_algorithm_version,hmac_version)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,(SELECT device_id FROM sessions WHERE id=$11),$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING *`,
        [revisionId,req.user!.tenantId,String(req.params.id),current.revision_no+1,next.categoryId,next.priorityId,next.content,next.status,current.id,req.user!.id,req.sessionDbId,createdAt,current.chain_hash,integrity.contentHash,integrity.chainHash,integrity.integrityHmac,canonicalRevision.canonicalPayloadHash,current.revision_hash??null,canonicalRevision.revisionHash,'sha256-v1',canonicalRevision.hmacVersion])).rows[0];
      await client.query('INSERT INTO audit_events(tenant_id,actor_user_id,event_type,entity_type,entity_id,details) VALUES($1,$2,$3,$4,$5,$6)',[req.user!.tenantId,req.user!.id,'watchbook.entry.corrected','watchbook_entry',String(req.params.id),{revision_id:revision.id,revision_no:revision.revision_no,reason:body.reason}]);
      return revision;
    });
    res.status(201).json(result);
  }catch(error){next(error);}
});
