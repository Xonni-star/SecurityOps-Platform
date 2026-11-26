import {Router} from 'express';
import {z} from 'zod';
import {query} from '../db/pool.js';
import {requireAuth,requireCsrf,requirePermission} from '../middleware/auth.js';
import {recordAudit} from '../services/audit.js';

const subscription=z.object({
  endpoint:z.string().url(),
  keys:z.object({p256dh:z.string().min(1),auth:z.string().min(1)}).strict()
}).strict();
export const phase8Router=Router();
phase8Router.use((req,res,next)=>/^\/push-subscriptions/.test(req.path)?requireAuth(req,res,()=>requireCsrf(req,res,next)):next());
phase8Router.post('/push-subscriptions',requirePermission('push_subscriptions:write'),async(req,res,next)=>{
  try{
    const body=subscription.parse(req.body);
    const result=await query(`INSERT INTO push_subscriptions(tenant_id,user_id,endpoint,subscription)
      VALUES($1,$2,$3,$4)
      ON CONFLICT(user_id,endpoint) DO UPDATE SET subscription=EXCLUDED.subscription,updated_at=now()
      RETURNING id,endpoint,created_at,updated_at`,[req.user!.tenantId,req.user!.id,body.endpoint,body]);
    await recordAudit(req.user!.tenantId,req.user!.id,'push_subscription.registered','push_subscription',result.rows[0].id,{endpoint:body.endpoint});
    res.status(201).json(result.rows[0]);
  }catch(error){next(error);}
});
phase8Router.delete('/push-subscriptions',requirePermission('push_subscriptions:write'),async(req,res,next)=>{
  try{
    const endpoint=z.string().url().parse(req.body?.endpoint);
    const result=await query('DELETE FROM push_subscriptions WHERE tenant_id=$1 AND user_id=$2 AND endpoint=$3 RETURNING id',[req.user!.tenantId,req.user!.id,endpoint]);
    if(!result.rowCount)return res.status(404).json({error:'Abonnement nicht gefunden'});
    await recordAudit(req.user!.tenantId,req.user!.id,'push_subscription.deleted','push_subscription',result.rows[0].id,{});
    res.status(204).end();
  }catch(error){next(error);}
});
