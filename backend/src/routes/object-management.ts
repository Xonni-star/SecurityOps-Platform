import {Router} from 'express';
import {z} from 'zod';
import {query} from '../db/pool.js';
import {requireAuth,requireCsrf,requirePermission} from '../middleware/auth.js';
import {recordAudit} from '../services/audit.js';

const uuid=z.string().uuid();
const relationshipSchema=z.object({
  customer_id:uuid,
  relationship_type:z.enum(['primary','branch','operational','billing','other']).default('operational'),
  starts_on:z.coerce.date().nullable().optional(),
  ends_on:z.coerce.date().nullable().optional(),
  notes:z.string().trim().max(4000).nullable().optional(),
}).strict();

export const objectManagementRouter=Router();

objectManagementRouter.get(
  '/sites/:id/object-context',
  requireAuth,
  requirePermission('sites:read',{allowedScopes:['tenant','site','own','system']}),
  requirePermission('customers:read',{allowedScopes:['tenant','site','own','system']}),
  requirePermission('contracts:read',{allowedScopes:['tenant','site','own','system']}),
  async(req,res,next)=>{
    try{
      const id=uuid.parse(String(req.params.id));
      const site=(await query(
        `SELECT s.*,om.name AS object_manager_name,op.name AS operations_manager_name
         FROM sites s
         LEFT JOIN employees om ON om.tenant_id=s.tenant_id AND om.id=s.object_manager_employee_id
         LEFT JOIN employees op ON op.tenant_id=s.tenant_id AND op.id=s.operations_manager_employee_id
         WHERE s.tenant_id=$1 AND s.id=$2`,
        [req.user!.tenantId,id],
      )).rows[0];
      if(!site)return res.status(404).json({error:'Not found'});
      const customers=(await query(
        `SELECT cs.*,c.name AS customer_name,c.customer_number
         FROM customer_sites cs JOIN customers c ON c.tenant_id=cs.tenant_id AND c.id=cs.customer_id
         WHERE cs.tenant_id=$1 AND cs.site_id=$2
         ORDER BY cs.is_primary DESC,c.name`,
        [req.user!.tenantId,id],
      )).rows;
      const contracts=(await query(
        `SELECT con.id,con.contract_number,con.contract_type,con.status,con.customer_id,c.name AS customer_name
         FROM contract_sites cts
         JOIN contracts con ON con.tenant_id=cts.tenant_id AND con.id=cts.contract_id
         JOIN customers c ON c.tenant_id=cts.tenant_id AND c.id=cts.customer_id
         WHERE cts.tenant_id=$1 AND cts.site_id=$2
         ORDER BY con.starts_on DESC,con.contract_number`,
        [req.user!.tenantId,id],
      )).rows;
      res.json({site,customers,contracts});
    }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Invalid site id'});next(error);}
  },
);

objectManagementRouter.post(
  '/sites/:id/customer-links',
  requireAuth,
  requireCsrf,
  requirePermission('sites:write',{allowedScopes:['tenant','site','system']}),
  requirePermission('customers:write',{allowedScopes:['tenant','site','system']}),
  async(req,res,next)=>{
    try{
      const siteId=uuid.parse(String(req.params.id));
      const body=relationshipSchema.parse(req.body);
      const tenantId=req.user!.tenantId;
      const site=(await query('SELECT id FROM sites WHERE tenant_id=$1 AND id=$2',[tenantId,siteId])).rows[0];
      const customer=(await query('SELECT id FROM customers WHERE tenant_id=$1 AND id=$2',[tenantId,body.customer_id])).rows[0];
      if(!site||!customer)return res.status(404).json({error:'Site or customer not found'});
      if(body.ends_on&&body.starts_on&&body.ends_on<body.starts_on)return res.status(400).json({error:'Invalid relationship dates'});
      const link=(await query(
        `INSERT INTO customer_sites(tenant_id,customer_id,site_id,relationship_type,starts_on,ends_on,notes)
         VALUES($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (tenant_id,customer_id,site_id) DO UPDATE SET
           relationship_type=EXCLUDED.relationship_type,starts_on=EXCLUDED.starts_on,
           ends_on=EXCLUDED.ends_on,notes=EXCLUDED.notes,relationship_status='active',updated_at=now()
         RETURNING *`,
        [tenantId,body.customer_id,siteId,body.relationship_type,body.starts_on??null,body.ends_on??null,body.notes??null],
      )).rows[0];
      await recordAudit(tenantId,req.user!.id,'site.customer_linked','customer_sites',link.id,{site_id:siteId,customer_id:body.customer_id});
      res.status(201).json(link);
    }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Invalid customer relationship'});next(error);}
  },
);

objectManagementRouter.delete(
  '/sites/:id/customer-links/:customerId',
  requireAuth,
  requireCsrf,
  requirePermission('sites:write',{allowedScopes:['tenant','site','system']}),
  requirePermission('customers:write',{allowedScopes:['tenant','site','system']}),
  async(req,res,next)=>{
    try{
      const siteId=uuid.parse(String(req.params.id));
      const customerId=uuid.parse(String(req.params.customerId));
      const result=await query(
        `UPDATE customer_sites SET relationship_status='archived',updated_at=now()
         WHERE tenant_id=$1 AND site_id=$2 AND customer_id=$3 AND relationship_status<>'archived'
         RETURNING id`,
        [req.user!.tenantId,siteId,customerId],
      );
      if(!result.rowCount)return res.status(404).json({error:'Relationship not found'});
      await recordAudit(req.user!.tenantId,req.user!.id,'site.customer_link_archived','customer_sites',result.rows[0].id,{site_id:siteId,customer_id:customerId});
      res.status(204).send();
    }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Invalid relationship id'});next(error);}
  },
);
