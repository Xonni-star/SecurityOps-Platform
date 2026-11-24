import {Router} from 'express';
import {z} from 'zod';
import {query,withTransaction} from '../db/pool.js';
import {requireAuth,requireCsrf,requirePermission} from '../middleware/auth.js';
import {recordAudit} from '../services/audit.js';
import {effectivePermissionScope,normalizePermissionGrants} from '../types/authorization.js';

const uuid=z.string().uuid();
const nonempty=z.string().trim().min(1);
const nullableText=(max:number)=>z.string().trim().max(max).nullable().optional();
const customerSchema=z.object({
  name:nonempty.max(240),
  email:z.string().email().nullable().optional(),
  customer_number:nullableText(80),
  legal_form:nullableText(120),
  industry:nullableText(160),
  customer_status:z.enum(['prospect','negotiating','active','paused','at_risk','terminated','archived']).default('active'),
  priority:z.enum(['low','normal','high','critical']).default('normal'),
  risk_classification:z.enum(['unknown','low','medium','high','critical']).default('unknown'),
  started_on:z.string().date().nullable().optional(),
  ended_on:z.string().date().nullable().optional(),
  account_manager_employee_id:uuid.nullable().optional(),
  internal_notes:nullableText(8000),
  phone:nullableText(40),
  website:z.string().url().max(500).nullable().optional(),
  billing_email:z.string().email().nullable().optional(),
  address_line1:nullableText(240),
  address_line2:nullableText(240),
  postal_code:nullableText(20),
  city:nullableText(160),
  region:nullableText(120),
  country_code:z.string().regex(/^[A-Z]{2}$/).default('DE'),
  billing_address:nullableText(1000),
  communication_preferences:nullableText(1000),
}).strict().refine(value=>!value.started_on||!value.ended_on||value.ended_on>=value.started_on,{message:'Invalid customer dates'});

const contactSchema=z.object({
  first_name:nullableText(120),
  last_name:nullableText(120),
  job_title:nullableText(160),
  department:nullableText(160),
  email:z.string().email().nullable().optional(),
  phone:nullableText(40),
  mobile_phone:nullableText(40),
  preferred_contact_method:z.enum(['email','phone','mobile','mail']).nullable().optional(),
  notes:nullableText(2000),
  status:z.enum(['active','inactive','archived']).default('active'),
  is_primary:z.boolean().default(false),
  is_decision_maker:z.boolean().default(false),
  is_security_contact:z.boolean().default(false),
  is_billing_contact:z.boolean().default(false),
  is_emergency_contact:z.boolean().default(false),
  site_ids:z.array(uuid).max(100).default([]),
}).strict().refine(value=>Boolean(value.first_name||value.last_name||value.email||value.phone||value.mobile_phone),{message:'At least one contact detail is required'});

const relationshipSchema=z.object({
  site_id:uuid,
  relationship_type:z.enum(['primary','branch','operational','billing','other']).default('operational'),
  starts_on:z.string().date().nullable().optional(),
  ends_on:z.string().date().nullable().optional(),
  is_primary:z.boolean().default(false),
  notes:nullableText(4000),
}).strict().refine(value=>!value.starts_on||!value.ends_on||value.ends_on>=value.starts_on,{message:'Invalid relationship dates'});

const contractSchema=z.object({
  contract_number:nonempty.max(80),
  contract_type:nonempty.max(120),
  scope:nullableText(4000),
  starts_on:z.string().date(),
  ends_on:z.string().date().nullable().optional(),
  renewal_type:z.enum(['manual','automatic','none']).default('manual'),
  notice_period_days:z.number().int().min(0).max(3650).nullable().optional(),
  next_termination_date:z.string().date().nullable().optional(),
  status:z.enum(['draft','in_review','pending_approval','active','paused','termination_received','expiring','ended','archived']).default('draft'),
  total_value:z.number().min(0).nullable().optional(),
  monthly_value:z.number().min(0).nullable().optional(),
  billing_model:z.enum(['fixed','hourly','usage_based','mixed']).nullable().optional(),
  sla:nullableText(4000),
  account_manager_employee_id:uuid.nullable().optional(),
  internal_notes:nullableText(8000),
}).strict().refine(value=>!value.ends_on||value.ends_on>=value.starts_on,{message:'Invalid contract dates'});

const taskSchema=z.object({
  title:nonempty.max(240),
  description:nullableText(4000),
  due_at:z.string().datetime({offset:true}).nullable().optional(),
  assigned_employee_id:uuid.nullable().optional(),
}).strict();

export const customersRouter=Router();
customersRouter.use('/customers',requireAuth);

async function addHistory(tenantId:string,customerId:string,actorId:string,eventType:string,subjectId?:string,details:Record<string,unknown>={}){
  await query(
    'INSERT INTO customer_history(tenant_id,customer_id,actor_user_id,event_type,subject_id,details) VALUES($1,$2,$3,$4,$5,$6)',
    [tenantId,customerId,actorId,eventType,subjectId??null,details],
  );
}
function invalid(res:import('express').Response){return res.status(400).json({error:'Invalid customer request'});}

customersRouter.get('/customers/dashboard',requirePermission('customers:read'),async(req,res,next)=>{
  try{
    const tenantId=req.user!.tenantId;
    const [customers,sites,contracts,expiring]=await Promise.all([
      query(`SELECT COUNT(*)::int total,
        COUNT(*) FILTER(WHERE customer_status='active')::int active,
        COUNT(*) FILTER(WHERE customer_status IN ('prospect','negotiating'))::int pipeline,
        COUNT(*) FILTER(WHERE customer_status='at_risk')::int at_risk,
        COUNT(*) FILTER(WHERE customer_status='archived')::int archived
        FROM customers WHERE tenant_id=$1`,[tenantId]),
      query(`SELECT COUNT(DISTINCT cs.customer_id)::int customers,
        COUNT(*) FILTER(WHERE cs.relationship_status='active')::int active_links
        FROM customer_sites cs WHERE cs.tenant_id=$1`,[tenantId]),
      query(`SELECT COUNT(*)::int total,COUNT(*) FILTER(WHERE status='active')::int active
        FROM contracts WHERE tenant_id=$1`,[tenantId]),
      query(`SELECT COUNT(*)::int count FROM contracts
        WHERE tenant_id=$1 AND status NOT IN ('ended','archived')
        AND ends_on BETWEEN CURRENT_DATE AND CURRENT_DATE+INTERVAL '90 days'`,[tenantId]),
    ]);
    res.json({...customers.rows[0],linked_customers:sites.rows[0].customers,active_object_links:sites.rows[0].active_links,contracts:contracts.rows[0],contracts_expiring_90_days:expiring.rows[0].count});
  }catch(error){next(error);}
});

customersRouter.get('/customers',requirePermission('customers:read'),async(req,res,next)=>{
  try{
    const rows=(await query(
      `SELECT c.*,
        (SELECT COUNT(*)::int FROM customer_sites cs WHERE cs.tenant_id=c.tenant_id AND cs.customer_id=c.id AND cs.relationship_status='active') AS active_sites,
        (SELECT COUNT(*)::int FROM contracts co WHERE co.tenant_id=c.tenant_id AND co.customer_id=c.id AND co.status='active') AS active_contracts,
        (SELECT COUNT(*)::int FROM customer_contacts cc WHERE cc.tenant_id=c.tenant_id AND cc.customer_id=c.id AND cc.status='active') AS active_contacts,
        (SELECT COUNT(*)::int FROM contracts co WHERE co.tenant_id=c.tenant_id AND co.customer_id=c.id AND co.status NOT IN ('ended','archived') AND co.ends_on BETWEEN CURRENT_DATE AND CURRENT_DATE+INTERVAL '90 days') AS expiring_contracts,
        e.name AS account_manager_name
       FROM customers c LEFT JOIN employees e ON e.tenant_id=c.tenant_id AND e.id=c.account_manager_employee_id
       WHERE c.tenant_id=$1 ORDER BY lower(c.name),c.id`,
      [req.user!.tenantId],
    )).rows;
    res.json(rows);
  }catch(error){next(error);}
});

customersRouter.post('/customers',requireCsrf,requirePermission('customers:write'),async(req,res,next)=>{
  try{
    const parsed=customerSchema.safeParse(req.body);
    if(!parsed.success)return invalid(res);
    const body=parsed.data;
    const tenantId=req.user!.tenantId;
    if(body.account_manager_employee_id&&!((await query('SELECT id FROM employees WHERE tenant_id=$1 AND id=$2',[tenantId,body.account_manager_employee_id])).rows[0]))return res.status(400).json({error:'Account manager not found'});
    const row=(await query(
      `INSERT INTO customers(tenant_id,name,email,customer_number,legal_form,industry,customer_status,priority,risk_classification,started_on,ended_on,account_manager_employee_id,internal_notes,phone,website,billing_email,address_line1,address_line2,postal_code,city,region,country_code,billing_address,communication_preferences)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING *`,
      [tenantId,body.name,body.email??null,body.customer_number??null,body.legal_form??null,body.industry??null,body.customer_status,body.priority,body.risk_classification,body.started_on??null,body.ended_on??null,body.account_manager_employee_id??null,body.internal_notes??null,body.phone??null,body.website??null,body.billing_email??null,body.address_line1??null,body.address_line2??null,body.postal_code??null,body.city??null,body.region??null,body.country_code,body.billing_address??null,body.communication_preferences??null],
    )).rows[0];
    if(body.email){
      await query(`INSERT INTO customer_contacts(tenant_id,customer_id,email,is_primary)
        VALUES($1,$2,$3,true) ON CONFLICT DO NOTHING`,[tenantId,row.id,body.email]);
    }
    await addHistory(tenantId,row.id,req.user!.id,'customer.created',row.id,{customer_number:row.customer_number});
    await recordAudit(tenantId,req.user!.id,'customer.created','customer',row.id,{customer_number:row.customer_number});
    res.status(201).json(row);
  }catch(error){next(error);}
});

customersRouter.get('/customers/:id/profile',requirePermission('customers:read'),requirePermission('customer_contacts:read'),requirePermission('contracts:read'),async(req,res,next)=>{
  try{
    const customerId=uuid.parse(String(req.params.id));
    const tenantId=req.user!.tenantId;
    const customer=(await query(
      `SELECT c.*,e.name AS account_manager_name
       FROM customers c LEFT JOIN employees e ON e.tenant_id=c.tenant_id AND e.id=c.account_manager_employee_id
       WHERE c.tenant_id=$1 AND c.id=$2`,
      [tenantId,customerId],
    )).rows[0];
    if(!customer)return res.status(404).json({error:'Customer not found'});
    const customerDocumentReadScope=effectivePermissionScope(
      normalizePermissionGrants(req.user!.permissionGrants,req.user!.permissions),
      'customer_documents:read',
      {role:req.user!.role,isSystemAdmin:req.user!.isSystemAdmin===true},
    );
    const [contacts,sites,contracts,documents,tasks,history,operations]=await Promise.all([
      query(`SELECT cc.*,
        COALESCE((SELECT json_agg(json_build_object('id',s.id,'name',s.name,'site_number',s.site_number) ORDER BY s.name)
          FROM customer_contact_sites ccs JOIN sites s ON s.tenant_id=ccs.tenant_id AND s.id=ccs.site_id
          WHERE ccs.tenant_id=cc.tenant_id AND ccs.contact_id=cc.id),'[]'::json) sites
        FROM customer_contacts cc WHERE cc.tenant_id=$1 AND cc.customer_id=$2
        ORDER BY cc.is_primary DESC,cc.status,cc.last_name,cc.first_name`,[tenantId,customerId]),
      query(`SELECT cs.*,s.id AS site_id,s.name AS site_name,s.site_number,s.address,s.status AS site_status,s.security_classification,
        (SELECT COUNT(*)::int FROM employee_object_assignments oa WHERE oa.tenant_id=cs.tenant_id AND oa.site_id=cs.site_id AND (oa.ends_on IS NULL OR oa.ends_on>=CURRENT_DATE)) assigned_employees,
        (SELECT COUNT(*)::int FROM schedule_shifts sh WHERE sh.tenant_id=cs.tenant_id AND sh.site_id=cs.site_id AND sh.ends_at>=now()) upcoming_shifts,
        (SELECT COUNT(*)::int FROM incidents i WHERE i.tenant_id=cs.tenant_id AND i.site_id=cs.site_id AND i.status<>'completed') open_incidents
        FROM customer_sites cs JOIN sites s ON s.tenant_id=cs.tenant_id AND s.id=cs.site_id
        WHERE cs.tenant_id=$1 AND cs.customer_id=$2 ORDER BY cs.is_primary DESC,s.name`,[tenantId,customerId]),
      query(`SELECT co.*,
        COALESCE((SELECT json_agg(json_build_object('id',s.id,'name',s.name,'site_number',s.site_number) ORDER BY s.name)
          FROM contract_sites cts JOIN sites s ON s.tenant_id=cts.tenant_id AND s.id=cts.site_id
          WHERE cts.tenant_id=co.tenant_id AND cts.contract_id=co.id),'[]'::json) sites,
        COALESCE((SELECT json_agg(json_build_object('id',sv.id,'name',sv.name,'quantity',cse.quantity,'unit',cse.unit,'unit_price',cse.unit_price) ORDER BY sv.name)
          FROM contract_services cse JOIN services sv ON sv.tenant_id=cse.tenant_id AND sv.id=cse.service_id
          WHERE cse.tenant_id=co.tenant_id AND cse.contract_id=co.id),'[]'::json) services
        FROM contracts co WHERE co.tenant_id=$1 AND co.customer_id=$2 ORDER BY co.starts_on DESC,co.contract_number`,[tenantId,customerId]),
      customerDocumentReadScope==='tenant'||customerDocumentReadScope==='system'?query(`SELECT d.id,d.title,d.description,d.customer_document_category,d.document_status,d.created_at,
        COALESCE(json_agg(json_build_object('id',v.id,'version_no',v.version_no,'size_bytes',v.size_bytes,'content_type',v.content_type,'lifecycle_state',v.lifecycle_state,'created_at',v.created_at) ORDER BY v.version_no DESC) FILTER(WHERE v.id IS NOT NULL),'[]') versions
        FROM dms_documents d LEFT JOIN dms_versions v ON v.tenant_id=d.tenant_id AND v.document_id=d.id
        WHERE d.tenant_id=$1 AND d.customer_id=$2 AND d.document_status='active' GROUP BY d.id ORDER BY d.created_at DESC`,[tenantId,customerId]):Promise.resolve({rows:[]}),
      query(`SELECT t.*,e.name AS assigned_employee_name FROM customer_tasks t
        LEFT JOIN employees e ON e.tenant_id=t.tenant_id AND e.id=t.assigned_employee_id
        WHERE t.tenant_id=$1 AND t.customer_id=$2 ORDER BY t.status,t.due_at NULLS LAST,t.created_at DESC`,[tenantId,customerId]),
      query(`SELECT h.id,h.event_type,h.subject_id,h.details,h.created_at,u.email AS actor_email
        FROM customer_history h LEFT JOIN users u ON u.tenant_id=h.tenant_id AND u.id=h.actor_user_id
        WHERE h.tenant_id=$1 AND h.customer_id=$2 ORDER BY h.created_at DESC LIMIT 100`,[tenantId,customerId]),
      query(`SELECT COUNT(DISTINCT oa.employee_id)::int assigned_employees,
        COUNT(DISTINCT sh.id)::int upcoming_shifts,
        COUNT(DISTINCT i.id) FILTER(WHERE i.status<>'completed')::int open_incidents
        FROM customer_sites cs
        LEFT JOIN employee_object_assignments oa ON oa.tenant_id=cs.tenant_id AND oa.site_id=cs.site_id AND (oa.ends_on IS NULL OR oa.ends_on>=CURRENT_DATE)
        LEFT JOIN schedule_shifts sh ON sh.tenant_id=cs.tenant_id AND sh.site_id=cs.site_id AND sh.ends_at>=now()
        LEFT JOIN incidents i ON i.tenant_id=cs.tenant_id AND i.site_id=cs.site_id
        WHERE cs.tenant_id=$1 AND cs.customer_id=$2`,[tenantId,customerId]),
    ]);
    res.json({customer,contacts:contacts.rows,sites:sites.rows,contracts:contracts.rows,documents:documents.rows,tasks:tasks.rows,history:history.rows,operations:operations.rows[0]});
  }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Invalid customer id'});next(error);}
});

customersRouter.patch('/customers/:id',requireCsrf,requirePermission('customers:write'),async(req,res,next)=>{
  try{
    const customerId=uuid.parse(String(req.params.id));
    const parsed=customerSchema.partial().safeParse(req.body);
    if(!parsed.success||!Object.keys(parsed.data).length)return invalid(res);
    const body=parsed.data;
    const tenantId=req.user!.tenantId;
    if(body.account_manager_employee_id&&!((await query('SELECT id FROM employees WHERE tenant_id=$1 AND id=$2',[tenantId,body.account_manager_employee_id])).rows[0]))return res.status(400).json({error:'Account manager not found'});
    const allowed=Object.keys(body);
    const values=allowed.map(key=>(body as Record<string,unknown>)[key]);
    const row=(await query(`UPDATE customers SET ${allowed.map((key,index)=>`${key}=$${index+1}`).join(',')},updated_at=now()
      WHERE tenant_id=$${allowed.length+1} AND id=$${allowed.length+2} RETURNING *`,[...values,tenantId,customerId])).rows[0];
    if(!row)return res.status(404).json({error:'Customer not found'});
    await addHistory(tenantId,customerId,req.user!.id,'customer.updated',customerId,{fields:allowed});
    await recordAudit(tenantId,req.user!.id,'customer.updated','customer',customerId,{fields:allowed});
    res.json(row);
  }catch(error){if(error instanceof z.ZodError)return invalid(res);next(error);}
});

customersRouter.post('/customers/:id/contacts',requireCsrf,requirePermission('customer_contacts:write'),async(req,res,next)=>{
  try{
    const customerId=uuid.parse(String(req.params.id));
    const parsed=contactSchema.safeParse(req.body);
    if(!parsed.success)return invalid(res);
    const body=parsed.data,tenantId=req.user!.tenantId;
    if(!((await query('SELECT id FROM customers WHERE tenant_id=$1 AND id=$2',[tenantId,customerId])).rows[0]))return res.status(404).json({error:'Customer not found'});
    if(body.site_ids.length){
      const sites=(await query('SELECT site_id FROM customer_sites WHERE tenant_id=$1 AND customer_id=$2 AND site_id=ANY($3::uuid[])',[tenantId,customerId,body.site_ids])).rows;
      if(sites.length!==new Set(body.site_ids).size)return res.status(400).json({error:'Contact sites must already belong to the customer'});
    }
    const contact=await withTransaction(async client=>{
      if(body.is_primary)await client.query('UPDATE customer_contacts SET is_primary=false,updated_at=now() WHERE tenant_id=$1 AND customer_id=$2',[tenantId,customerId]);
      const created=(await client.query(`INSERT INTO customer_contacts(tenant_id,customer_id,first_name,last_name,job_title,department,email,phone,mobile_phone,preferred_contact_method,notes,status,is_primary,is_decision_maker,is_security_contact,is_billing_contact,is_emergency_contact)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
        [tenantId,customerId,body.first_name??null,body.last_name??null,body.job_title??null,body.department??null,body.email??null,body.phone??null,body.mobile_phone??null,body.preferred_contact_method??null,body.notes??null,body.status,body.is_primary,body.is_decision_maker,body.is_security_contact,body.is_billing_contact,body.is_emergency_contact])).rows[0];
      for(const siteId of body.site_ids)await client.query('INSERT INTO customer_contact_sites(tenant_id,customer_id,contact_id,site_id) VALUES($1,$2,$3,$4)',[tenantId,customerId,created.id,siteId]);
      return created;
    });
    await addHistory(tenantId,customerId,req.user!.id,'contact.created',contact.id,{is_primary:body.is_primary});
    await recordAudit(tenantId,req.user!.id,'customer.contact.created','customer_contact',contact.id,{customer_id:customerId});
    res.status(201).json(contact);
  }catch(error){if(error instanceof z.ZodError)return invalid(res);next(error);}
});

customersRouter.patch('/customers/:id/contacts/:contactId',requireCsrf,requirePermission('customer_contacts:write'),async(req,res,next)=>{
  try{
    const customerId=uuid.parse(String(req.params.id)),contactId=uuid.parse(String(req.params.contactId));
    const parsed=contactSchema.partial().safeParse(req.body);
    if(!parsed.success||!Object.keys(parsed.data).length)return invalid(res);
    const body=parsed.data,tenantId=req.user!.tenantId;
    const existing=(await query('SELECT id FROM customer_contacts WHERE tenant_id=$1 AND customer_id=$2 AND id=$3',[tenantId,customerId,contactId])).rows[0];
    if(!existing)return res.status(404).json({error:'Contact not found'});
    if(body.site_ids){
      const sites=(await query('SELECT site_id FROM customer_sites WHERE tenant_id=$1 AND customer_id=$2 AND site_id=ANY($3::uuid[])',[tenantId,customerId,body.site_ids])).rows;
      if(sites.length!==new Set(body.site_ids).size)return res.status(400).json({error:'Contact sites must already belong to the customer'});
    }
    const values={...body};delete values.site_ids;
    const fields=Object.keys(values);
    const contact=await withTransaction(async client=>{
      if(body.is_primary)await client.query('UPDATE customer_contacts SET is_primary=false,updated_at=now() WHERE tenant_id=$1 AND customer_id=$2 AND id<>$3',[tenantId,customerId,contactId]);
      const updated=fields.length?(await client.query(`UPDATE customer_contacts SET ${fields.map((field,index)=>`${field}=$${index+1}`).join(',')},updated_at=now()
        WHERE tenant_id=$${fields.length+1} AND customer_id=$${fields.length+2} AND id=$${fields.length+3} RETURNING *`,
        [...fields.map(field=>(values as Record<string,unknown>)[field]),tenantId,customerId,contactId])).rows[0]:existing;
      if(body.site_ids){
        await client.query('DELETE FROM customer_contact_sites WHERE tenant_id=$1 AND customer_id=$2 AND contact_id=$3',[tenantId,customerId,contactId]);
        for(const siteId of body.site_ids)await client.query('INSERT INTO customer_contact_sites(tenant_id,customer_id,contact_id,site_id) VALUES($1,$2,$3,$4)',[tenantId,customerId,contactId,siteId]);
      }
      return updated;
    });
    await addHistory(tenantId,customerId,req.user!.id,'contact.updated',contactId,{fields});
    await recordAudit(tenantId,req.user!.id,'customer.contact.updated','customer_contact',contactId,{customer_id:customerId,fields});
    res.json(contact);
  }catch(error){if(error instanceof z.ZodError)return invalid(res);next(error);}
});

customersRouter.patch('/customers/:id/sites/:siteId',requireCsrf,requirePermission('customers:write'),async(req,res,next)=>{
  try{
    const customerId=uuid.parse(String(req.params.id)),siteId=uuid.parse(String(req.params.siteId));
    const parsed=z.object({relationship_status:z.enum(['active','inactive','archived']),is_primary:z.boolean().optional()}).strict().safeParse(req.body);
    if(!parsed.success)return invalid(res);
    const {relationship_status,is_primary}=parsed.data,tenantId=req.user!.tenantId;
    if(is_primary)await query('UPDATE customer_sites SET is_primary=false,updated_at=now() WHERE tenant_id=$1 AND customer_id=$2',[tenantId,customerId]);
    const link=(await query(`UPDATE customer_sites SET relationship_status=$1,is_primary=COALESCE($2,is_primary),updated_at=now()
      WHERE tenant_id=$3 AND customer_id=$4 AND site_id=$5 RETURNING *`,
      [relationship_status,is_primary??null,tenantId,customerId,siteId])).rows[0];
    if(!link)return res.status(404).json({error:'Customer object relationship not found'});
    await addHistory(tenantId,customerId,req.user!.id,'site.relationship_updated',siteId,{relationship_status});
    await recordAudit(tenantId,req.user!.id,'customer.site.relationship_updated','customer_site',link.id,{customer_id:customerId,site_id:siteId,relationship_status});
    res.json(link);
  }catch(error){if(error instanceof z.ZodError)return invalid(res);next(error);}
});

customersRouter.post('/customers/:id/sites',requireCsrf,requirePermission('customers:write'),requirePermission('sites:read'),async(req,res,next)=>{
  try{
    const customerId=uuid.parse(String(req.params.id));
    const parsed=relationshipSchema.safeParse(req.body);
    if(!parsed.success)return invalid(res);
    const body=parsed.data,tenantId=req.user!.tenantId;
    const existing=(await query('SELECT id FROM customers WHERE tenant_id=$1 AND id=$2',[tenantId,customerId])).rows[0];
    const site=(await query('SELECT id FROM sites WHERE tenant_id=$1 AND id=$2',[tenantId,body.site_id])).rows[0];
    if(!existing||!site)return res.status(404).json({error:'Customer or site not found'});
    if(body.is_primary)await query('UPDATE customer_sites SET is_primary=false,updated_at=now() WHERE tenant_id=$1 AND customer_id=$2',[tenantId,customerId]);
    const link=(await query(`INSERT INTO customer_sites(tenant_id,customer_id,site_id,relationship_type,relationship_status,is_primary,starts_on,ends_on,notes)
      VALUES($1,$2,$3,$4,'active',$5,$6,$7,$8) ON CONFLICT(tenant_id,customer_id,site_id) DO UPDATE
      SET relationship_type=EXCLUDED.relationship_type,relationship_status='active',is_primary=EXCLUDED.is_primary,starts_on=EXCLUDED.starts_on,ends_on=EXCLUDED.ends_on,notes=EXCLUDED.notes,updated_at=now() RETURNING *`,
      [tenantId,customerId,body.site_id,body.relationship_type,body.is_primary,body.starts_on??null,body.ends_on??null,body.notes??null])).rows[0];
    await addHistory(tenantId,customerId,req.user!.id,'site.linked',body.site_id,{relationship_type:body.relationship_type});
    await recordAudit(tenantId,req.user!.id,'customer.site.linked','customer_site',link.id,{customer_id:customerId,site_id:body.site_id});
    res.status(201).json(link);
  }catch(error){if(error instanceof z.ZodError)return invalid(res);next(error);}
});

customersRouter.post('/customers/:id/contracts',requireCsrf,requirePermission('contracts:write'),async(req,res,next)=>{
  try{
    const customerId=uuid.parse(String(req.params.id));
    const parsed=contractSchema.safeParse(req.body);
    if(!parsed.success)return invalid(res);
    const body=parsed.data,tenantId=req.user!.tenantId;
    const customer=(await query('SELECT id FROM customers WHERE tenant_id=$1 AND id=$2',[tenantId,customerId])).rows[0];
    if(!customer)return res.status(404).json({error:'Customer not found'});
    if(body.account_manager_employee_id&&!((await query('SELECT id FROM employees WHERE tenant_id=$1 AND id=$2',[tenantId,body.account_manager_employee_id])).rows[0]))return res.status(400).json({error:'Account manager not found'});
    const contract=(await query(`INSERT INTO contracts(tenant_id,customer_id,contract_number,contract_type,scope,starts_on,ends_on,renewal_type,notice_period_days,next_termination_date,status,total_value,monthly_value,billing_model,sla,account_manager_employee_id,internal_notes)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [tenantId,customerId,body.contract_number,body.contract_type,body.scope??null,body.starts_on,body.ends_on??null,body.renewal_type,body.notice_period_days??null,body.next_termination_date??null,body.status,body.total_value??null,body.monthly_value??null,body.billing_model??null,body.sla??null,body.account_manager_employee_id??null,body.internal_notes??null])).rows[0];
    await addHistory(tenantId,customerId,req.user!.id,'contract.created',contract.id,{contract_number:contract.contract_number,status:contract.status});
    await recordAudit(tenantId,req.user!.id,'customer.contract.created','contract',contract.id,{customer_id:customerId,contract_number:contract.contract_number});
    res.status(201).json(contract);
  }catch(error){if(error instanceof z.ZodError)return invalid(res);next(error);}
});

customersRouter.patch('/customers/:id/contracts/:contractId',requireCsrf,requirePermission('contracts:write'),async(req,res,next)=>{
  try{
    const customerId=uuid.parse(String(req.params.id)),contractId=uuid.parse(String(req.params.contractId));
    const parsed=contractSchema.partial().safeParse(req.body);
    if(!parsed.success||!Object.keys(parsed.data).length)return invalid(res);
    const body=parsed.data,tenantId=req.user!.tenantId,fields=Object.keys(body);
    if(body.account_manager_employee_id&&!((await query('SELECT id FROM employees WHERE tenant_id=$1 AND id=$2',[tenantId,body.account_manager_employee_id])).rows[0]))return res.status(400).json({error:'Account manager not found'});
    const contract=(await query(`UPDATE contracts SET ${fields.map((field,index)=>`${field}=$${index+1}`).join(',')},updated_at=now()
      WHERE tenant_id=$${fields.length+1} AND customer_id=$${fields.length+2} AND id=$${fields.length+3} RETURNING *`,
      [...fields.map(field=>(body as Record<string,unknown>)[field]),tenantId,customerId,contractId])).rows[0];
    if(!contract)return res.status(404).json({error:'Contract not found'});
    await addHistory(tenantId,customerId,req.user!.id,'contract.updated',contractId,{fields,status:contract.status});
    await recordAudit(tenantId,req.user!.id,'customer.contract.updated','contract',contractId,{customer_id:customerId,fields});
    res.json(contract);
  }catch(error){if(error instanceof z.ZodError)return invalid(res);next(error);}
});

customersRouter.post('/customers/:id/contracts/:contractId/sites',requireCsrf,requirePermission('contracts:write'),async(req,res,next)=>{
  try{
    const customerId=uuid.parse(String(req.params.id)),contractId=uuid.parse(String(req.params.contractId));
    const parsed=z.object({site_id:uuid}).strict().safeParse(req.body);
    if(!parsed.success)return invalid(res);
    const tenantId=req.user!.tenantId,siteId=parsed.data.site_id;
    const link=(await query(`INSERT INTO contract_sites(tenant_id,customer_id,contract_id,site_id)
      SELECT $1,$2,co.id,cs.site_id FROM contracts co JOIN customer_sites cs ON cs.tenant_id=co.tenant_id AND cs.customer_id=co.customer_id AND cs.site_id=$4
      WHERE co.tenant_id=$1 AND co.customer_id=$2 AND co.id=$3
      ON CONFLICT(tenant_id,contract_id,site_id) DO NOTHING RETURNING *`,[tenantId,customerId,contractId,siteId])).rows[0];
    if(!link)return res.status(400).json({error:'Contract and site must belong to this customer'});
    await addHistory(tenantId,customerId,req.user!.id,'contract.site.linked',contractId,{site_id:siteId});
    await recordAudit(tenantId,req.user!.id,'customer.contract.site.linked','contract',contractId,{customer_id:customerId,site_id:siteId});
    res.status(201).json(link);
  }catch(error){if(error instanceof z.ZodError)return invalid(res);next(error);}
});

customersRouter.post('/customers/:id/contracts/:contractId/services',requireCsrf,requirePermission('contracts:write'),async(req,res,next)=>{
  try{
    const customerId=uuid.parse(String(req.params.id)),contractId=uuid.parse(String(req.params.contractId));
    const parsed=z.object({service_id:uuid,quantity:z.number().positive().max(100000),unit:nullableText(40),unit_price:z.number().min(0).nullable().optional(),starts_on:z.string().date().nullable().optional(),ends_on:z.string().date().nullable().optional(),notes:nullableText(2000)}).strict().safeParse(req.body);
    if(!parsed.success)return invalid(res);
    const body=parsed.data,tenantId=req.user!.tenantId;
    const contract=(await query('SELECT id FROM contracts WHERE tenant_id=$1 AND customer_id=$2 AND id=$3',[tenantId,customerId,contractId])).rows[0];
    const service=(await query('SELECT id FROM services WHERE tenant_id=$1 AND id=$2 AND status<>\'archived\'',[tenantId,body.service_id])).rows[0];
    if(!contract||!service)return res.status(404).json({error:'Contract or service not found'});
    const row=(await query(`INSERT INTO contract_services(tenant_id,contract_id,service_id,quantity,unit,unit_price,starts_on,ends_on,notes)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(tenant_id,contract_id,service_id) DO UPDATE
      SET quantity=EXCLUDED.quantity,unit=EXCLUDED.unit,unit_price=EXCLUDED.unit_price,starts_on=EXCLUDED.starts_on,ends_on=EXCLUDED.ends_on,notes=EXCLUDED.notes,updated_at=now() RETURNING *`,
      [tenantId,contractId,body.service_id,body.quantity,body.unit??null,body.unit_price??null,body.starts_on??null,body.ends_on??null,body.notes??null])).rows[0];
    await addHistory(tenantId,customerId,req.user!.id,'contract.service.updated',contractId,{service_id:body.service_id,quantity:body.quantity});
    await recordAudit(tenantId,req.user!.id,'customer.contract.service.updated','contract',contractId,{customer_id:customerId,service_id:body.service_id});
    res.status(200).json(row);
  }catch(error){if(error instanceof z.ZodError)return invalid(res);next(error);}
});

customersRouter.get('/services',requirePermission('contracts:read'),async(req,res,next)=>{
  try{
    const rows=(await query('SELECT * FROM services WHERE tenant_id=$1 AND status<>\'archived\' ORDER BY name',[req.user!.tenantId])).rows;
    res.json(rows);
  }catch(error){next(error);}
});

customersRouter.post('/services',requireCsrf,requirePermission('contracts:write'),async(req,res,next)=>{
  try{
    const parsed=z.object({service_code:nullableText(80),name:nonempty.max(240),description:nullableText(4000),status:z.enum(['active','inactive','archived']).default('active'),unit:nullableText(40),default_unit_price:z.number().min(0).nullable().optional()}).strict().safeParse(req.body);
    if(!parsed.success)return invalid(res);
    const body=parsed.data;
    const row=(await query(`INSERT INTO services(tenant_id,service_code,name,description,status,unit,default_unit_price)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[req.user!.tenantId,body.service_code??null,body.name,body.description??null,body.status,body.unit??null,body.default_unit_price??null])).rows[0];
    await recordAudit(req.user!.tenantId,req.user!.id,'customer.service.created','service',row.id,{service_code:row.service_code});
    res.status(201).json(row);
  }catch(error){if(error instanceof z.ZodError)return invalid(res);next(error);}
});

customersRouter.post('/customers/:id/tasks',requireCsrf,requirePermission('customers:write'),async(req,res,next)=>{
  try{
    const customerId=uuid.parse(String(req.params.id));
    const parsed=taskSchema.safeParse(req.body);
    if(!parsed.success)return invalid(res);
    const body=parsed.data,tenantId=req.user!.tenantId;
    if(!((await query('SELECT id FROM customers WHERE tenant_id=$1 AND id=$2',[tenantId,customerId])).rows[0]))return res.status(404).json({error:'Customer not found'});
    if(body.assigned_employee_id&&!((await query('SELECT id FROM employees WHERE tenant_id=$1 AND id=$2',[tenantId,body.assigned_employee_id])).rows[0]))return res.status(400).json({error:'Assigned employee not found'});
    const task=(await query(`INSERT INTO customer_tasks(tenant_id,customer_id,title,description,due_at,assigned_employee_id,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [tenantId,customerId,body.title,body.description??null,body.due_at??null,body.assigned_employee_id??null,req.user!.id])).rows[0];
    await addHistory(tenantId,customerId,req.user!.id,'task.created',task.id,{title:task.title,due_at:task.due_at});
    await recordAudit(tenantId,req.user!.id,'customer.task.created','customer_task',task.id,{customer_id:customerId});
    res.status(201).json(task);
  }catch(error){if(error instanceof z.ZodError)return invalid(res);next(error);}
});

customersRouter.patch('/customers/:id/tasks/:taskId',requireCsrf,requirePermission('customers:write'),async(req,res,next)=>{
  try{
    const customerId=uuid.parse(String(req.params.id)),taskId=uuid.parse(String(req.params.taskId));
    const parsed=z.object({status:z.enum(['open','completed','cancelled'])}).strict().safeParse(req.body);
    if(!parsed.success)return invalid(res);
    const tenantId=req.user!.tenantId,status=parsed.data.status;
    const task=(await query(`UPDATE customer_tasks SET status=$1,completed_at=CASE WHEN $1='completed' THEN now() ELSE NULL END,updated_at=now()
      WHERE tenant_id=$2 AND customer_id=$3 AND id=$4 RETURNING *`,[status,tenantId,customerId,taskId])).rows[0];
    if(!task)return res.status(404).json({error:'Task not found'});
    await addHistory(tenantId,customerId,req.user!.id,'task.status_changed',taskId,{status});
    await recordAudit(tenantId,req.user!.id,'customer.task.updated','customer_task',taskId,{customer_id:customerId,status});
    res.json(task);
  }catch(error){if(error instanceof z.ZodError)return invalid(res);next(error);}
});
