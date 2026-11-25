import {Router,type RequestHandler} from 'express';
import {z} from 'zod';
import {query} from '../db/pool.js';
import {requireAuth,requireCsrf,requirePermission} from '../middleware/auth.js';
import {recordAudit} from '../services/audit.js';
import {canAccessResource,effectivePermissionScope,normalizePermissionGrants} from '../types/authorization.js';

const uuid=z.string().uuid();
const nonempty=z.string().trim().min(1);
const relationshipSchema=z.object({
  customer_id:uuid,
  relationship_type:z.enum(['primary','branch','operational','billing','other']).default('operational'),
  starts_on:z.coerce.date().nullable().optional(),
  ends_on:z.coerce.date().nullable().optional(),
  notes:z.string().trim().max(4000).nullable().optional(),
}).strict();
const locationSchema=z.object({
  parent_id:uuid.nullable().optional(),
  code:z.string().trim().max(80).nullable().optional(),
  name:nonempty.max(160),
  location_type:z.enum(['building','area','zone']),
  description:z.string().trim().max(4000).nullable().optional(),
  security_level:z.enum(['unknown','low','medium','high','critical']).default('unknown'),
  hazard_notes:z.string().trim().max(4000).nullable().optional(),
  access_rules:z.string().trim().max(4000).nullable().optional(),
  responsible_employee_id:uuid.nullable().optional(),
  sort_order:z.number().int().min(0).max(100000).default(0),
}).strict();
const hazardSchema=z.object({
  location_id:uuid.nullable().optional(),
  title:nonempty.max(160),
  category:z.enum(['burglary','theft','vandalism','fire','robbery','unauthorized_access','sabotage','conflict','technical','environmental','other']),
  description:nonempty.max(10000),
  likelihood:z.number().int().min(1).max(5),
  impact:z.number().int().min(1).max(5),
  protective_measures:z.string().trim().max(10000).nullable().optional(),
  required_actions:z.string().trim().max(10000).nullable().optional(),
  responsible_employee_id:uuid.nullable().optional(),
  due_on:z.string().date().nullable().optional(),
  review_on:z.string().date().nullable().optional(),
  status:z.enum(['open','mitigated','accepted','closed']).default('open'),
}).strict().refine(value=>!value.due_on||!value.review_on||value.review_on>=value.due_on,{message:'review_on must be on or after due_on'});
const instructionSchema=z.object({
  location_id:uuid.nullable().optional(),
  title:nonempty.max(200),
  content:nonempty.max(20000),
  version:z.number().int().positive().default(1),
  status:z.enum(['draft','pending_approval','approved','archived']).default('draft'),
  requires_acknowledgement:z.boolean().default(false),
  valid_from:z.string().date().nullable().optional(),
  valid_until:z.string().date().nullable().optional(),
  supersedes_id:uuid.nullable().optional(),
}).strict().refine(value=>!value.valid_from||!value.valid_until||value.valid_until>=value.valid_from,{message:'valid_until must be on or after valid_from'});

export const objectManagementRouter=Router();

function requireSiteScope(permission:string):RequestHandler{
  return async(req,res,next)=>{
    try{
      const siteId=uuid.parse(String(req.params.id));
      const user=req.user!;
      const grants=normalizePermissionGrants(user.permissionGrants,user.permissions);
      const scope=effectivePermissionScope(grants,permission,{role:user.role,isSystemAdmin:user.isSystemAdmin===true});
      if(!scope)return res.status(403).json({error:'Insufficient permissions'});
      if(scope==='own'){
        const owner=await query('SELECT 1 FROM resource_owners WHERE tenant_id=$1 AND resource=$2 AND resource_id=$3 AND user_id=$4',[user.tenantId,'sites',siteId,user.id]);
        if(!owner.rowCount)return res.status(403).json({error:'Permission scope does not include this site'});
      }else if(!canAccessResource({userId:user.id,tenantId:user.tenantId,role:user.role,isSystemAdmin:user.isSystemAdmin===true,siteIds:user.siteIds??[],grants},scope,{tenantId:user.tenantId,siteId})){
        return res.status(403).json({error:'Permission scope does not include this site'});
      }
      next();
    }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Invalid site id'});next(error);}
  };
}

objectManagementRouter.get(
  '/sites/:id/object-context',
  requireAuth,
  requirePermission('sites:read',{allowedScopes:['tenant','site','own','system']}),
  requirePermission('customers:read'),
  requirePermission('contracts:read'),
  requireSiteScope('sites:read'),
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
      const locations=(await query(
        `SELECT l.*,e.name AS responsible_employee_name
         FROM object_locations l
         LEFT JOIN employees e ON e.tenant_id=l.tenant_id AND e.id=l.responsible_employee_id
         WHERE l.tenant_id=$1 AND l.site_id=$2 ORDER BY l.parent_id NULLS FIRST,l.sort_order,l.name`,
        [req.user!.tenantId,id],
      )).rows;
      const hazards=(await query(
        `SELECT h.*,l.name AS location_name,e.name AS responsible_employee_name
         FROM object_hazards h
         LEFT JOIN object_locations l ON l.tenant_id=h.tenant_id AND l.id=h.location_id
         LEFT JOIN employees e ON e.tenant_id=h.tenant_id AND e.id=h.responsible_employee_id
         WHERE h.tenant_id=$1 AND h.site_id=$2 ORDER BY h.status,h.risk_score DESC,h.title`,
        [req.user!.tenantId,id],
      )).rows;
      const instructions=(await query(
        `SELECT i.*,l.name AS location_name,u.email AS created_by_email,
          (SELECT count(*)::int FROM instruction_acknowledgements a WHERE a.tenant_id=i.tenant_id AND a.instruction_id=i.id AND a.acknowledged_version=i.version) AS acknowledgement_count
         FROM site_instructions i
         LEFT JOIN object_locations l ON l.tenant_id=i.tenant_id AND l.id=i.location_id
         JOIN users u ON u.tenant_id=i.tenant_id AND u.id=i.created_by
         WHERE i.tenant_id=$1 AND i.site_id=$2 AND i.status<>'archived'
         ORDER BY i.title,i.version DESC`,
        [req.user!.tenantId,id],
      )).rows;
      const user=req.user!;
      const grants=normalizePermissionGrants(user.permissionGrants,user.permissions);
      const watchbookScope=effectivePermissionScope(grants,'watchbook:read',{role:user.role,isSystemAdmin:user.isSystemAdmin===true});
      const canReadWatchbook=watchbookScope&&canAccessResource({userId:user.id,tenantId:user.tenantId,role:user.role,isSystemAdmin:user.isSystemAdmin===true,siteIds:user.siteIds??[],grants},watchbookScope,{tenantId:user.tenantId,siteId:id});
      const journal=canReadWatchbook?(await query(
        `SELECT id,site_id,created_by,created_at,client_entry_id
         FROM watchbook_entries WHERE tenant_id=$1 AND site_id=$2 ORDER BY created_at DESC LIMIT 20`,
        [user.tenantId,id],
      )).rows:null;
      res.json({site,customers,contracts,locations,hazards,instructions,journal});
    }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Invalid site id'});next(error);}
  },
);

objectManagementRouter.post('/sites/:id/locations',requireAuth,requireCsrf,requirePermission('sites:write',{allowedScopes:['tenant','site','system']}),requireSiteScope('sites:write'),async(req,res,next)=>{
  try{
    const siteId=uuid.parse(String(req.params.id)); const body=locationSchema.parse(req.body); const tenantId=req.user!.tenantId;
    const site=(await query('SELECT id FROM sites WHERE tenant_id=$1 AND id=$2',[tenantId,siteId])).rows[0];
    if(!site)return res.status(404).json({error:'Site not found'});
    if(body.parent_id){
      const parent=(await query('SELECT id FROM object_locations WHERE tenant_id=$1 AND site_id=$2 AND id=$3',[tenantId,siteId,body.parent_id])).rows[0];
      if(!parent)return res.status(400).json({error:'Parent location not found in site'});
    }
    if(body.responsible_employee_id){
      const employee=(await query('SELECT id FROM employees WHERE tenant_id=$1 AND id=$2',[tenantId,body.responsible_employee_id])).rows[0];
      if(!employee)return res.status(400).json({error:'Responsible employee not found'});
    }
    const row=(await query(`INSERT INTO object_locations(tenant_id,site_id,parent_id,code,name,location_type,description,security_level,hazard_notes,access_rules,responsible_employee_id,sort_order)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [tenantId,siteId,body.parent_id??null,body.code??null,body.name,body.location_type,body.description??null,body.security_level,body.hazard_notes??null,body.access_rules??null,body.responsible_employee_id??null,body.sort_order])).rows[0];
    await recordAudit(tenantId,req.user!.id,'site.location.created','object_locations',row.id,{site_id:siteId,location_type:body.location_type});
    res.status(201).json(row);
  }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Invalid location'});next(error);}
});

objectManagementRouter.post('/sites/:id/hazards',requireAuth,requireCsrf,requirePermission('sites:write',{allowedScopes:['tenant','site','system']}),requireSiteScope('sites:write'),async(req,res,next)=>{
  try{
    const siteId=uuid.parse(String(req.params.id)); const body=hazardSchema.parse(req.body); const tenantId=req.user!.tenantId;
    const site=(await query('SELECT id FROM sites WHERE tenant_id=$1 AND id=$2',[tenantId,siteId])).rows[0];
    if(!site)return res.status(404).json({error:'Site not found'});
    if(body.location_id){
      const location=(await query('SELECT id FROM object_locations WHERE tenant_id=$1 AND site_id=$2 AND id=$3',[tenantId,siteId,body.location_id])).rows[0];
      if(!location)return res.status(400).json({error:'Location not found in site'});
    }
    if(body.responsible_employee_id){
      const employee=(await query('SELECT id FROM employees WHERE tenant_id=$1 AND id=$2',[tenantId,body.responsible_employee_id])).rows[0];
      if(!employee)return res.status(400).json({error:'Responsible employee not found'});
    }
    const row=(await query(`INSERT INTO object_hazards(tenant_id,site_id,location_id,title,category,description,likelihood,impact,protective_measures,required_actions,responsible_employee_id,due_on,review_on,status,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [tenantId,siteId,body.location_id??null,body.title,body.category,body.description,body.likelihood,body.impact,body.protective_measures??null,body.required_actions??null,body.responsible_employee_id??null,body.due_on??null,body.review_on??null,body.status,req.user!.id])).rows[0];
    await recordAudit(tenantId,req.user!.id,'site.hazard.created','object_hazards',row.id,{site_id:siteId,risk_score:body.likelihood*body.impact});
    res.status(201).json(row);
  }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Invalid hazard'});next(error);}
});

objectManagementRouter.post('/sites/:id/instructions',requireAuth,requireCsrf,requirePermission('sites:write',{allowedScopes:['tenant','site','system']}),requireSiteScope('sites:write'),async(req,res,next)=>{
  try{
    const siteId=uuid.parse(String(req.params.id)); const body=instructionSchema.parse(req.body); const tenantId=req.user!.tenantId;
    const site=(await query('SELECT id FROM sites WHERE tenant_id=$1 AND id=$2',[tenantId,siteId])).rows[0];
    if(!site)return res.status(404).json({error:'Site not found'});
    if(body.location_id){
      const location=(await query('SELECT id FROM object_locations WHERE tenant_id=$1 AND site_id=$2 AND id=$3',[tenantId,siteId,body.location_id])).rows[0];
      if(!location)return res.status(400).json({error:'Location not found in site'});
    }
    if(body.supersedes_id){
      const previous=(await query('SELECT id FROM site_instructions WHERE tenant_id=$1 AND site_id=$2 AND id=$3',[tenantId,siteId,body.supersedes_id])).rows[0];
      if(!previous)return res.status(400).json({error:'Superseded instruction not found in site'});
    }
    if(body.status==='approved'&&!req.user!.isSystemAdmin&&req.user!.role==='viewer')return res.status(403).json({error:'Only operators may approve instructions'});
    const row=(await query(`INSERT INTO site_instructions(tenant_id,site_id,location_id,title,content,version,status,requires_acknowledgement,valid_from,valid_until,created_by,approved_by,approved_at,supersedes_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,CASE WHEN $7='approved' THEN now() ELSE NULL END,$13) RETURNING *`,
      [tenantId,siteId,body.location_id??null,body.title,body.content,body.version,body.status,body.requires_acknowledgement,body.valid_from??null,body.valid_until??null,req.user!.id,body.status==='approved'?req.user!.id:null,body.supersedes_id??null])).rows[0];
    await recordAudit(tenantId,req.user!.id,'site.instruction.created','site_instructions',row.id,{site_id:siteId,version:body.version,status:body.status});
    res.status(201).json(row);
  }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Invalid instruction'});next(error);}
});

objectManagementRouter.post('/sites/:id/instructions/:instructionId/acknowledgements',requireAuth,requireCsrf,requirePermission('sites:write',{allowedScopes:['tenant','site','system']}),requireSiteScope('sites:write'),async(req,res,next)=>{
  try{
    const siteId=uuid.parse(String(req.params.id)); const instructionId=uuid.parse(String(req.params.instructionId));
    const body=z.object({employee_id:uuid}).strict().parse(req.body); const tenantId=req.user!.tenantId;
    const instruction=(await query('SELECT id,version,status FROM site_instructions WHERE tenant_id=$1 AND site_id=$2 AND id=$3',[tenantId,siteId,instructionId])).rows[0];
    const employee=(await query('SELECT id FROM employees WHERE tenant_id=$1 AND id=$2',[tenantId,body.employee_id])).rows[0];
    if(!instruction||!employee)return res.status(404).json({error:'Instruction or employee not found'});
    if(instruction.status!=='approved')return res.status(409).json({error:'Only approved instructions can be acknowledged'});
    const row=(await query(`INSERT INTO instruction_acknowledgements(tenant_id,instruction_id,employee_id,acknowledged_version)
      VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING *`,[tenantId,instructionId,body.employee_id,instruction.version])).rows[0];
    if(row)await recordAudit(tenantId,req.user!.id,'site.instruction.acknowledged','instruction_acknowledgements',instructionId,{site_id:siteId,employee_id:body.employee_id,version:instruction.version});
    res.status(row?201:200).json(row??{acknowledged:true,version:instruction.version});
  }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Invalid acknowledgement'});next(error);}
});

objectManagementRouter.post(
  '/sites/:id/customer-links',
  requireAuth,
  requireCsrf,
  requirePermission('sites:write',{allowedScopes:['tenant','site','system']}),
  requirePermission('customers:write'),
  requireSiteScope('sites:write'),
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
  requirePermission('customers:write'),
  requireSiteScope('sites:write'),
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
