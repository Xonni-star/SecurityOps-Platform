import {Router} from 'express';
import {z} from 'zod';
import {query,withTransaction} from '../db/pool.js';
import {requireAuth,requireCsrf,requirePermission} from '../middleware/auth.js';
import {recordAudit} from '../services/audit.js';
import {canUsePermission,effectivePermissionScope,normalizePermissionGrants} from '../types/authorization.js';

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
  priority:z.enum(['low','normal','high','critical']).default('normal'),
}).strict();

const customerStatuses=['prospect','negotiating','active','paused','at_risk','terminated','archived'] as const;
const riskClasses=['unknown','low','medium','high','critical'] as const;
const customerPriorities=['low','normal','high','critical'] as const;
const contractStatuses=['draft','in_review','pending_approval','active','paused','termination_received','expiring','ended','archived'] as const;
const sortFields=['name','customer_number','customer_status','risk_classification','priority','city','active_sites','active_contracts','account_manager_name','next_contract_deadline','last_activity','open_tasks'] as const;
type ListFilters={q?:string;customer_status?:string;risk_classification?:string;priority?:string;account_manager_employee_id?:string;contract_status?:string;active?:'true'|'false';sort:typeof sortFields[number];dir:'asc'|'desc';page:number;pageSize:number};
const listQuerySchema=z.object({
  q:z.string().trim().max(200).optional(),
  customer_status:z.enum(customerStatuses).optional(),
  risk_classification:z.enum(riskClasses).optional(),
  priority:z.enum(customerPriorities).optional(),
  account_manager_employee_id:uuid.optional(),
  contract_status:z.enum(contractStatuses).optional(),
  active:z.enum(['true','false']).optional(),
  sort:z.enum(sortFields).default('name'),
  dir:z.enum(['asc','desc']).default('asc'),
  page:z.coerce.number().int().min(1).max(100000).default(1),
  pageSize:z.coerce.number().int().min(1).max(100).default(10),
});
const listQueryKeys=Object.keys(listQuerySchema.shape);
function parseListQuery(req:import('express').Request):ListFilters{
  const raw:Record<string,unknown>={};
  for(const key of listQueryKeys){const value=req.query[key];if(typeof value==='string'&&value.trim()!=='')raw[key]=value;}
  return listQuerySchema.parse(raw) as ListFilters;
}
function can(req:import('express').Request,code:string){
  const user=req.user;
  if(!user)return false;
  return canUsePermission({userId:user.id,tenantId:user.tenantId,role:user.role,isSystemAdmin:user.isSystemAdmin===true,siteIds:user.siteIds??[],grants:user.permissionGrants??[]},code);
}
const orderExpressions:Record<typeof sortFields[number],string>={
  name:'lower(c.name)',customer_number:'lower(c.customer_number)',customer_status:'c.customer_status',
  risk_classification:'c.risk_classification',priority:'c.priority',city:'lower(c.city)',
  active_sites:'active_sites',active_contracts:'active_contracts',account_manager_name:'lower(e.name)',
  next_contract_deadline:'next_contract_deadline NULLS LAST',last_activity:'last_activity NULLS LAST',open_tasks:'open_tasks',
};
function customerListQuery(tenantId:string,filters:ListFilters,options:{limit?:number;offset?:number;ids?:string[]}={}){
  const values:unknown[]=[tenantId];
  const conditions=['c.tenant_id=$1'];
  const add=(fragment:string,value:unknown)=>{values.push(value);return fragment.replaceAll('$P',`$${values.length}`);};
  if(filters.q){
    const escaped=filters.q.replace(/[\\%_]/g,'\\$&');
    conditions.push(add(`(c.name ILIKE $P ESCAPE '\\' OR c.customer_number ILIKE $P ESCAPE '\\' OR c.email ILIKE $P ESCAPE '\\' OR c.city ILIKE $P ESCAPE '\\' OR c.industry ILIKE $P ESCAPE '\\' OR e.name ILIKE $P ESCAPE '\\')`,`%${escaped}%`));
  }
  if(filters.customer_status)conditions.push(add('c.customer_status=$P',filters.customer_status));
  if(filters.risk_classification)conditions.push(add('c.risk_classification=$P',filters.risk_classification));
  if(filters.priority)conditions.push(add('c.priority=$P',filters.priority));
  if(filters.account_manager_employee_id)conditions.push(add('c.account_manager_employee_id=$P',filters.account_manager_employee_id));
  if(filters.active==='true')conditions.push("c.customer_status='active'");
  if(filters.active==='false')conditions.push("c.customer_status<>'active'");
  if(filters.contract_status)conditions.push(add('EXISTS (SELECT 1 FROM contracts co WHERE co.tenant_id=c.tenant_id AND co.customer_id=c.id AND co.status=$P)',filters.contract_status));
  if(options.ids?.length)conditions.push(add('c.id=ANY($P::uuid[])',options.ids));
  const limit=options.limit??filters.pageSize;
  const offset=options.offset??(filters.page-1)*filters.pageSize;
  const limitIndex=values.length+1;
  const offsetIndex=values.length+2;
  values.push(limit,offset);
  const direction=filters.dir.toUpperCase();
  const sql=`WITH link_metrics AS (
      SELECT customer_id,COUNT(*) FILTER(WHERE relationship_status='active')::int active_sites
      FROM customer_sites WHERE tenant_id=$1 GROUP BY customer_id
    ),contract_metrics AS (
      SELECT customer_id,
        COUNT(*) FILTER(WHERE status='active')::int active_contracts,
        COUNT(*) FILTER(WHERE status NOT IN ('ended','archived') AND ends_on BETWEEN CURRENT_DATE AND CURRENT_DATE+INTERVAL '90 days')::int expiring_contracts
      FROM contracts WHERE tenant_id=$1 GROUP BY customer_id
    ),contact_metrics AS (
      SELECT customer_id,COUNT(*) FILTER(WHERE status='active')::int active_contacts
      FROM customer_contacts WHERE tenant_id=$1 GROUP BY customer_id
    )
    SELECT c.*,COALESCE(lm.active_sites,0)::int active_sites,COALESCE(cm.active_contracts,0)::int active_contracts,
      COALESCE(cm.expiring_contracts,0)::int expiring_contracts,COALESCE(ctm.active_contacts,0)::int active_contacts,
      e.name AS account_manager_name,
      (SELECT min(co.ends_on) FROM contracts co WHERE co.tenant_id=c.tenant_id AND co.customer_id=c.id AND co.status NOT IN ('ended','archived')) next_contract_deadline,
      (SELECT max(h.created_at) FROM customer_history h WHERE h.tenant_id=c.tenant_id AND h.customer_id=c.id) last_activity,
      (SELECT count(*)::int FROM customer_tasks t WHERE t.tenant_id=c.tenant_id AND t.customer_id=c.id AND t.status='open') open_tasks,
      (SELECT count(*)::int FROM customer_tasks t WHERE t.tenant_id=c.tenant_id AND t.customer_id=c.id AND t.status='open' AND t.due_at<now()) overdue_tasks,
      COUNT(*) OVER()::int total_count
    FROM customers c
    LEFT JOIN employees e ON e.tenant_id=c.tenant_id AND e.id=c.account_manager_employee_id
    LEFT JOIN link_metrics lm ON lm.customer_id=c.id
    LEFT JOIN contract_metrics cm ON cm.customer_id=c.id
    LEFT JOIN contact_metrics ctm ON ctm.customer_id=c.id
    WHERE ${conditions.join(' AND ')}
    ORDER BY ${orderExpressions[filters.sort]} ${direction},c.id ${direction}
    LIMIT $${limitIndex} OFFSET $${offsetIndex}`;
  return {sql,values};
}
const dayStart=()=>{const date=new Date();date.setUTCHours(0,0,0,0);return date;};
const daysUntil=(date:string)=>Math.round((Date.parse(`${date}T00:00:00Z`)-dayStart().getTime())/86400000);
const dateAfter=(date:string,days:number)=>{const value=new Date(`${date}T00:00:00Z`);value.setUTCDate(value.getUTCDate()+days);return value.toISOString().slice(0,10);};

type ContractReminder={id:string;code:string;label:string;severity:'critical'|'warning';customer_id:string;customer_name:string;contract_id:string;contract_number:string;due_date:string|null;url:string};
async function contractReminders(tenantId:string,customerId?:string){
  const rows=(await query(
    `SELECT co.id,co.contract_number,co.ends_on,co.next_termination_date,co.notice_period_days,co.renewal_type,co.status,
       c.id AS customer_id,c.name AS customer_name
     FROM contracts co JOIN customers c ON c.tenant_id=co.tenant_id AND c.id=co.customer_id
     WHERE co.tenant_id=$1 AND co.status NOT IN ('ended','archived')${customerId?' AND co.customer_id=$2':''}
     ORDER BY co.ends_on NULLS LAST`,
    customerId?[tenantId,customerId]:[tenantId],
  )).rows;
  const reminders:ContractReminder[]=[];
  for(const row of rows){
    const base={customer_id:row.customer_id,customer_name:row.customer_name,contract_id:row.id,contract_number:row.contract_number,url:`/customers/${row.customer_id}/vertraege?contract=${row.id}`};
    const add=(code:string,label:string,due_date:string|null,severity:'critical'|'warning')=>{
      const reminder={...base,id:`${row.id}:${code}`,code,label,due_date,severity};
      if(!reminders.some(item=>item.id===reminder.id))reminders.push(reminder);
    };
    if(row.status==='termination_received')add('termination_received','Kündigung eingegangen',row.next_termination_date??row.ends_on??null,'critical');
    if(!row.ends_on)continue;
    const remaining=daysUntil(row.ends_on);
    if(remaining>=0&&remaining<=90){
      const code=remaining<=30?'30_days':remaining<=60?'60_days':'90_days';
      add(code,`Vertragsende in ${remaining} Tag${remaining===1?'':'en'}`,row.ends_on,remaining<=14?'critical':'warning');
      if(row.renewal_type!=='none')add('renewal_due','Verlängerung steht an',row.ends_on,remaining<=14?'critical':'warning');
    }
    if(row.notice_period_days!==null&&row.notice_period_days!==undefined){
      const deadline=row.next_termination_date??dateAfter(row.ends_on,-Number(row.notice_period_days));
      if(remaining>=0&&daysUntil(deadline)<=0)add('notice_reached',`Kündigungsfrist erreicht (${row.notice_period_days} Tage)`,deadline,'critical');
    }
  }
  return reminders.sort((left,right)=>Number(right.severity==='critical')-Number(left.severity==='critical')||String(left.due_date??'9999').localeCompare(String(right.due_date??'9999')));
}

type ActionEntry={id:string;bucket:'A'|'B'|'C';code:string;label:string;customer_id:string;customer_name:string;subject_type:string;subject_id:string|null;due_at:string|null};
async function customerActions(tenantId:string){
  const [customers,contracts,tasks,incidents]=await Promise.all([
    query(`SELECT c.id,c.name,c.customer_status,c.risk_classification,c.created_at,
        (SELECT max(h.created_at) FROM customer_history h WHERE h.tenant_id=c.tenant_id AND h.customer_id=c.id) last_activity,
        (SELECT count(*)::int FROM customer_tasks t WHERE t.tenant_id=c.tenant_id AND t.customer_id=c.id AND t.status='open') open_tasks,
        (SELECT count(*)::int FROM contracts co WHERE co.tenant_id=c.tenant_id AND co.customer_id=c.id AND co.status='active') active_contracts,
        (SELECT count(*)::int FROM customer_sites cs WHERE cs.tenant_id=c.tenant_id AND cs.customer_id=c.id AND cs.relationship_status='active') active_sites,
        (SELECT count(*)::int FROM contracts co WHERE co.tenant_id=c.tenant_id AND co.customer_id=c.id AND co.status NOT IN ('ended','archived') AND (co.ends_on IS NULL OR co.notice_period_days IS NULL)) incomplete_contracts,
        (SELECT count(*)::int FROM customer_contacts cc WHERE cc.tenant_id=c.tenant_id AND cc.customer_id=c.id AND cc.status='active' AND cc.is_primary) primary_contacts,
        (SELECT count(*)::int FROM customer_contacts cc WHERE cc.tenant_id=c.tenant_id AND cc.customer_id=c.id AND cc.status='active' AND cc.is_decision_maker) decision_contacts,
        (SELECT count(*)::int FROM customer_contacts cc WHERE cc.tenant_id=c.tenant_id AND cc.customer_id=c.id AND cc.status='active' AND cc.is_security_contact) security_contacts,
        (SELECT count(*)::int FROM customer_contacts cc WHERE cc.tenant_id=c.tenant_id AND cc.customer_id=c.id AND cc.status='active' AND cc.is_billing_contact) billing_contacts,
        (SELECT count(*)::int FROM customer_contacts cc WHERE cc.tenant_id=c.tenant_id AND cc.customer_id=c.id AND cc.status='active' AND cc.is_emergency_contact) emergency_contacts
      FROM customers c WHERE c.tenant_id=$1 AND c.customer_status<>'archived'`,[tenantId]),
    query(`SELECT co.id,co.contract_number,co.ends_on,c.id AS customer_id,c.name AS customer_name
      FROM contracts co JOIN customers c ON c.tenant_id=co.tenant_id AND c.id=co.customer_id
      WHERE co.tenant_id=$1 AND co.status NOT IN ('ended','archived')
        AND co.ends_on BETWEEN CURRENT_DATE AND CURRENT_DATE+INTERVAL '90 days'`,[tenantId]),
    query(`SELECT t.id,t.title,t.due_at,c.id AS customer_id,c.name AS customer_name
      FROM customer_tasks t JOIN customers c ON c.tenant_id=t.tenant_id AND c.id=t.customer_id
      WHERE t.tenant_id=$1 AND t.status='open' ORDER BY t.due_at NULLS LAST`,[tenantId]),
    query(`SELECT i.id,i.description,s.id AS site_id,s.name AS site_name,c.id AS customer_id,c.name AS customer_name
      FROM incidents i
      JOIN customer_sites cs ON cs.tenant_id=i.tenant_id AND cs.site_id=i.site_id AND cs.relationship_status='active'
      JOIN sites s ON s.tenant_id=i.tenant_id AND s.id=i.site_id
      JOIN customers c ON c.tenant_id=cs.tenant_id AND c.id=cs.customer_id
      JOIN alarm_priorities ap ON ap.tenant_id=i.tenant_id AND ap.id=i.priority_id
      WHERE i.tenant_id=$1 AND i.status<>'completed' AND ap.code='critical'`,[tenantId]),
  ]);
  const entries:ActionEntry[]=[];
  const push=(bucket:'A'|'B'|'C',code:string,label:string,customer_id:string,customer_name:string,subject_type:string,subject_id:string|null=null,due_at:string|null=null)=>{
    const entry={id:`${code}:${subject_id??customer_id}`,bucket,code,label,customer_id,customer_name,subject_type,subject_id,due_at};
    if(!entries.some(item=>item.id===entry.id))entries.push(entry);
  };
  for(const row of customers.rows){
    const createdDays=daysUntil(String(row.created_at).slice(0,10));
    const inactiveDays=row.last_activity?Math.abs(daysUntil(String(row.last_activity).slice(0,10))):null;
    if(row.risk_classification==='critical'||row.customer_status==='at_risk')push('A','risk_critical','Kritisches Risiko / gefährdeter Kunde',row.id,row.name,'customer');
    if(row.active_contracts>0&&row.primary_contacts===0)push('A','missing_primary_contact','Aktiver Vertrag ohne primären Ansprechpartner',row.id,row.name,'contacts');
    if(row.active_contracts>0&&row.security_contacts===0)push('A','missing_security_contact','Aktiver Vertrag ohne Sicherheitskontakt',row.id,row.name,'contacts');
    if(row.customer_status==='paused')push('B','paused_customer','Kundenstatus pausiert',row.id,row.name,'stammdaten');
    if(row.incomplete_contracts>0)push('B','missing_contract_info','Vertragsinformationen unvollständig',row.id,row.name,'contracts');
    if(row.active_contracts>0&&row.decision_contacts===0)push('B','missing_decision_contact','Kein Entscheider für aktive Verträge',row.id,row.name,'contacts');
    if(row.active_contracts>0&&row.billing_contacts===0)push('B','missing_billing_contact','Kein Rechnungskontakt für aktive Verträge',row.id,row.name,'contacts');
    if(row.active_sites>0&&row.emergency_contacts===0)push('B','missing_emergency_contact','Kein Notfallkontakt für verknüpfte Objekte',row.id,row.name,'contacts');
    if(!row.email||!row.phone||!row.city||!row.address_line1||!row.account_manager_employee_id)push('B','incomplete_master_data','Stammdaten unvollständig',row.id,row.name,'stammdaten');
    if(row.customer_status==='active')push('C','active_customer','Aktiver Kunde',row.id,row.name,'customer');
    if(row.customer_status==='prospect'||row.customer_status==='negotiating')push('C','prospect','Interessent / Vertriebspipeline',row.id,row.name,'customer');
    if(createdDays>=-30&&createdDays<=0)push('C','new_customer','Neu angelegter Kunde',row.id,row.name,'customer');
    if(inactiveDays!==null&&inactiveDays>90)push('C','no_recent_activity','Keine aktuelle Aktivität',row.id,row.name,'verlauf');
  }
  for(const row of contracts.rows){
    const remaining=daysUntil(row.ends_on);
    if(remaining<=14)push('A','contract_expiring',`Vertragsfrist ${row.contract_number} in ${remaining} Tag${remaining===1?'':'en'}`,row.customer_id,row.customer_name,'contract',row.id,String(row.ends_on));
    else push('B',remaining<=30?'contract_expiry_30':remaining<=60?'contract_expiry_60':'contract_expiry_90',`Vertragsfrist ${row.contract_number} in ${remaining} Tagen`,row.customer_id,row.customer_name,'contract',row.id,String(row.ends_on));
  }
  for(const row of tasks.rows){
    const overdue=row.due_at&&Date.parse(row.due_at)<Date.now();
    if(overdue)push('A','task_overdue',`Überfällige Aufgabe: ${row.title}`,row.customer_id,row.customer_name,'task',row.id,String(row.due_at));
    else push('B','follow_up_open',`Offene Wiedervorlage: ${row.title}`,row.customer_id,row.customer_name,'task',row.id,row.due_at?String(row.due_at):null);
  }
  for(const row of incidents.rows)push('A','critical_incident',`Kritischer offener Vorgang: ${row.description}`,row.customer_id,row.customer_name,'site',row.site_id);
  const limits={A:20,B:30,C:30};
  return {A:entries.filter(item=>item.bucket==='A').slice(0,limits.A),B:entries.filter(item=>item.bucket==='B').slice(0,limits.B),C:entries.filter(item=>item.bucket==='C').slice(0,limits.C),generated_at:new Date().toISOString()};
}
const csvCell=(value:unknown)=>`"${String(value??'').split('"').join('""')}"`;

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
    const [customers,sites,contracts,expiring,tasks,reminders]=await Promise.all([
      query(`SELECT COUNT(*)::int total,
        COUNT(*) FILTER(WHERE customer_status='active')::int active,
        COUNT(*) FILTER(WHERE customer_status IN ('prospect','negotiating'))::int pipeline,
        COUNT(*) FILTER(WHERE customer_status='at_risk')::int at_risk,
        COUNT(*) FILTER(WHERE customer_status='archived')::int archived,
        COUNT(*) FILTER(WHERE customer_status='paused')::int paused,
        COUNT(*) FILTER(WHERE created_at>=now()-INTERVAL '30 days')::int new_30d,
        COUNT(*) FILTER(WHERE customer_status='active' AND (email IS NULL OR phone IS NULL OR city IS NULL OR address_line1 IS NULL OR account_manager_employee_id IS NULL))::int incomplete_master_data
        FROM customers WHERE tenant_id=$1`,[tenantId]),
      query(`SELECT COUNT(DISTINCT cs.customer_id)::int customers,
        COUNT(*) FILTER(WHERE cs.relationship_status='active')::int active_links
        FROM customer_sites cs WHERE cs.tenant_id=$1`,[tenantId]),
      query(`SELECT COUNT(*)::int total,COUNT(*) FILTER(WHERE status='active')::int active,
        COUNT(*) FILTER(WHERE status NOT IN ('ended','archived') AND ends_on IS NOT NULL)::int with_deadline
        FROM contracts WHERE tenant_id=$1`,[tenantId]),
      query(`SELECT COUNT(*)::int count FROM contracts
        WHERE tenant_id=$1 AND status NOT IN ('ended','archived')
        AND ends_on BETWEEN CURRENT_DATE AND CURRENT_DATE+INTERVAL '90 days'`,[tenantId]),
      query(`SELECT COUNT(*) FILTER(WHERE status='open')::int open_tasks,
        COUNT(*) FILTER(WHERE status='open' AND due_at<now())::int overdue_tasks
        FROM customer_tasks WHERE tenant_id=$1`,[tenantId]),
      contractReminders(tenantId),
    ]);
    res.json({...customers.rows[0],linked_customers:sites.rows[0]?.customers??0,active_object_links:sites.rows[0]?.active_links??0,
      contracts:contracts.rows[0]??{total:0,active:0,with_deadline:0},contracts_expiring_90_days:expiring.rows[0]?.count??0,
      open_tasks:tasks.rows[0]?.open_tasks??0,overdue_tasks:tasks.rows[0]?.overdue_tasks??0,
      reminders:reminders.slice(0,50)});
  }catch(error){next(error);}
});

customersRouter.get('/customers',requirePermission('customers:read'),async(req,res,next)=>{
  try{
    const filters=parseListQuery(req);
    const {sql,values}=customerListQuery(req.user!.tenantId,filters);
    const result=await query(sql,values);
    const total=result.rows[0]?.total_count??result.rows.length;
    res.set('X-Total-Count',String(total));
    res.set('X-Page',String(filters.page));
    res.set('X-Page-Size',String(filters.pageSize));
    res.set('X-Page-Count',String(Math.max(1,Math.ceil(total/filters.pageSize))));
    res.json(result.rows);
  }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Invalid customer filters'});next(error);}
});

customersRouter.get('/customers/action-list',requirePermission('customers:read'),async(req,res,next)=>{
  try{res.json(await customerActions(req.user!.tenantId));}
  catch(error){next(error);}
});

customersRouter.get('/customers/export',requirePermission('customers:export'),async(req,res,next)=>{
  try{
    const filters=parseListQuery(req);
    const rawIds=typeof req.query.ids==='string'?req.query.ids.split(',').filter(Boolean):[];
    const ids=z.array(uuid).max(100).parse(rawIds);
    const {sql,values}=customerListQuery(req.user!.tenantId,{...filters,page:1},{limit:ids.length?ids.length:10000,offset:0,ids});
    const rows=(await query(sql,values)).rows;
    const columns:[string,(row:Record<string,unknown>)=>unknown][]=[
      ['Kundennummer',row=>row.customer_number],['Firmenname',row=>row.name],['Kundenstatus',row=>row.customer_status],
      ['Priorität',row=>row.priority],['Risikoklasse',row=>row.risk_classification],['Kundenbetreuer',row=>row.account_manager_name],
      ['Aktive Objekte',row=>row.active_sites],['Aktive Verträge',row=>row.active_contracts],['Nächste Vertragsfrist',row=>row.next_contract_deadline],
      ['Letzte Aktivität',row=>row.last_activity],['Offene Aufgaben',row=>row.open_tasks],['E-Mail',row=>row.email],['Ort',row=>row.city],
    ];
    const csv=[columns.map(([label])=>csvCell(label)).join(';'),...rows.map(row=>columns.map(([,get])=>csvCell(get(row))).join(';'))].join('\r\n');
    await recordAudit(req.user!.tenantId,req.user!.id,'customers.exported','customer',undefined,{count:rows.length,filters:{q:filters.q,status:filters.customer_status,risk:filters.risk_classification,manager:filters.account_manager_employee_id,contract_status:filters.contract_status,selected:ids.length>0}});
    res.set('Content-Disposition','attachment; filename="kunden.csv"');
    res.status(200).type('text/csv; charset=utf-8').send(`\ufeff${csv}`);
  }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Invalid export request'});next(error);}
});

customersRouter.post('/customers/bulk',requireCsrf,requirePermission('customers:write'),async(req,res,next)=>{
  try{
    const parsed=z.object({
      ids:z.array(uuid).min(1).max(100),
      action:z.enum(['archive','set_status','set_manager']),
      value:z.string().max(80).optional(),
    }).strict().safeParse(req.body);
    if(!parsed.success)return invalid(res);
    const {ids,action,value}=parsed.data;
    const unique=[...new Set(ids)];
    if(action==='set_status'&&(!value||!customerStatuses.includes(value as typeof customerStatuses[number])))return invalid(res);
    if(action==='set_manager'&&value&&!uuid.safeParse(value).success)return invalid(res);
    const tenantId=req.user!.tenantId;
    const result=await withTransaction(async client=>{
      const found=(await client.query('SELECT id FROM customers WHERE tenant_id=$1 AND id=ANY($2::uuid[])',[tenantId,unique])).rows;
      if(found.length!==unique.length)return {updated:0,foreign:true};
      const column=action==='set_manager'?'account_manager_employee_id':'customer_status';
      const updateValue=action==='archive'?'archived':value!;
      const updated=(await client.query(`UPDATE customers SET ${column}=$1,updated_at=now()
        WHERE tenant_id=$2 AND id=ANY($3::uuid[]) RETURNING id`,[updateValue||null,tenantId,unique])).rowCount??0;
      for(const id of unique){
        await client.query('INSERT INTO customer_history(tenant_id,customer_id,actor_user_id,event_type,subject_id,details) VALUES($1,$2,$3,$4,$5,$6)',[tenantId,id,req.user!.id,'customer.updated',id,{fields:[column],bulk:true}]);
        await recordAudit(tenantId,req.user!.id,'customer.bulk_updated','customer',id,{action,value,ids:unique.length},client);
      }
      return {updated,foreign:false};
    });
    if(result.foreign)return res.status(404).json({error:'One or more customers are not accessible'});
    res.json(result);
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

customersRouter.get('/customers/:id/profile',requirePermission('customers:read'),async(req,res,next)=>{
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
    const [contacts,sites,contracts,documents,tasks,history,operations,reminders]=await Promise.all([
      can(req,'customer_contacts:read')?query(`SELECT cc.*,
        COALESCE((SELECT json_agg(json_build_object('id',s.id,'name',s.name,'site_number',s.site_number) ORDER BY s.name)
          FROM customer_contact_sites ccs JOIN sites s ON s.tenant_id=ccs.tenant_id AND s.id=ccs.site_id
          WHERE ccs.tenant_id=cc.tenant_id AND ccs.contact_id=cc.id),'[]'::json) sites
        FROM customer_contacts cc WHERE cc.tenant_id=$1 AND cc.customer_id=$2
        ORDER BY cc.is_primary DESC,cc.status,cc.last_name,cc.first_name`,[tenantId,customerId]):Promise.resolve({rows:[]}),
      can(req,'sites:read')?query(`SELECT cs.*,s.id AS site_id,s.name AS site_name,s.site_number,s.address,s.status AS site_status,s.security_classification,
        (SELECT COUNT(*)::int FROM employee_object_assignments oa WHERE oa.tenant_id=cs.tenant_id AND oa.site_id=cs.site_id AND (oa.ends_on IS NULL OR oa.ends_on>=CURRENT_DATE)) assigned_employees,
        (SELECT COUNT(*)::int FROM schedule_shifts sh WHERE sh.tenant_id=cs.tenant_id AND sh.site_id=cs.site_id AND sh.ends_at>=now()) upcoming_shifts,
        (SELECT COUNT(*)::int FROM incidents i WHERE i.tenant_id=cs.tenant_id AND i.site_id=cs.site_id AND i.status<>'completed') open_incidents
        FROM customer_sites cs JOIN sites s ON s.tenant_id=cs.tenant_id AND s.id=cs.site_id
        WHERE cs.tenant_id=$1 AND cs.customer_id=$2 ORDER BY cs.is_primary DESC,s.name`,[tenantId,customerId]):Promise.resolve({rows:[]}),
      can(req,'contracts:read')?query(`SELECT co.*,
        COALESCE((SELECT json_agg(json_build_object('id',s.id,'name',s.name,'site_number',s.site_number) ORDER BY s.name)
          FROM contract_sites cts JOIN sites s ON s.tenant_id=cts.tenant_id AND s.id=cts.site_id
          WHERE cts.tenant_id=co.tenant_id AND cts.contract_id=co.id),'[]'::json) sites,
        COALESCE((SELECT json_agg(json_build_object('id',sv.id,'name',sv.name,'quantity',cse.quantity,'unit',cse.unit,'unit_price',cse.unit_price) ORDER BY sv.name)
          FROM contract_services cse JOIN services sv ON sv.tenant_id=cse.tenant_id AND sv.id=cse.service_id
          WHERE cse.tenant_id=co.tenant_id AND cse.contract_id=co.id),'[]'::json) services
        FROM contracts co WHERE co.tenant_id=$1 AND co.customer_id=$2 ORDER BY co.starts_on DESC,co.contract_number`,[tenantId,customerId]):Promise.resolve({rows:[]}),
      customerDocumentReadScope==='tenant'||customerDocumentReadScope==='system'?query(`SELECT d.id,d.title,d.description,d.customer_document_category,d.document_status,d.created_at,
        COALESCE(json_agg(json_build_object('id',v.id,'version_no',v.version_no,'size_bytes',v.size_bytes,'content_type',v.content_type,'lifecycle_state',v.lifecycle_state,'created_at',v.created_at) ORDER BY v.version_no DESC) FILTER(WHERE v.id IS NOT NULL),'[]') versions
        FROM dms_documents d LEFT JOIN dms_versions v ON v.tenant_id=d.tenant_id AND v.document_id=d.id
        WHERE d.tenant_id=$1 AND d.customer_id=$2 AND d.document_status='active' GROUP BY d.id ORDER BY d.created_at DESC`,[tenantId,customerId]):Promise.resolve({rows:[]}),
      can(req,'customer_tasks:read')?query(`SELECT t.*,e.name AS assigned_employee_name FROM customer_tasks t
        LEFT JOIN employees e ON e.tenant_id=t.tenant_id AND e.id=t.assigned_employee_id
        WHERE t.tenant_id=$1 AND t.customer_id=$2 ORDER BY t.status,t.due_at NULLS LAST,t.created_at DESC`,[tenantId,customerId]):Promise.resolve({rows:[]}),
      can(req,'audit:read')?query(`SELECT h.id,h.event_type,h.subject_id,h.details,h.created_at,u.email AS actor_email
        FROM customer_history h LEFT JOIN users u ON u.tenant_id=h.tenant_id AND u.id=h.actor_user_id
        WHERE h.tenant_id=$1 AND h.customer_id=$2 ORDER BY h.created_at DESC LIMIT 100`,[tenantId,customerId]):Promise.resolve({rows:[]}),
      query(`SELECT COUNT(DISTINCT oa.employee_id)::int assigned_employees,
        COUNT(DISTINCT sh.id)::int upcoming_shifts,
        COUNT(DISTINCT i.id) FILTER(WHERE i.status<>'completed')::int open_incidents
        FROM customer_sites cs
        LEFT JOIN employee_object_assignments oa ON oa.tenant_id=cs.tenant_id AND oa.site_id=cs.site_id AND (oa.ends_on IS NULL OR oa.ends_on>=CURRENT_DATE)
        LEFT JOIN schedule_shifts sh ON sh.tenant_id=cs.tenant_id AND sh.site_id=cs.site_id AND sh.ends_at>=now()
        LEFT JOIN incidents i ON i.tenant_id=cs.tenant_id AND i.site_id=cs.site_id
        WHERE cs.tenant_id=$1 AND cs.customer_id=$2`,[tenantId,customerId]),
      can(req,'contracts:read')?contractReminders(tenantId,customerId):Promise.resolve([]),
    ]);
    res.json({customer,contacts:contacts.rows,sites:sites.rows,contracts:contracts.rows,documents:documents.rows,tasks:tasks.rows,
      history:history.rows,operations:operations.rows[0],reminders,
      visible_sections:{contacts:can(req,'customer_contacts:read'),sites:can(req,'sites:read'),contracts:can(req,'contracts:read'),
        documents:customerDocumentReadScope==='tenant'||customerDocumentReadScope==='system',tasks:can(req,'customer_tasks:read'),history:can(req,'audit:read')}});
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

customersRouter.get('/services',requireAuth,requirePermission('contracts:read'),async(req,res,next)=>{
  try{
    const rows=(await query('SELECT * FROM services WHERE tenant_id=$1 AND status<>\'archived\' ORDER BY name',[req.user!.tenantId])).rows;
    res.json(rows);
  }catch(error){next(error);}
});

customersRouter.post('/services',requireAuth,requireCsrf,requirePermission('contracts:write'),async(req,res,next)=>{
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

customersRouter.post('/customers/:id/tasks',requireCsrf,requirePermission('customer_tasks:write'),async(req,res,next)=>{
  try{
    const customerId=uuid.parse(String(req.params.id));
    const parsed=taskSchema.safeParse(req.body);
    if(!parsed.success)return invalid(res);
    const body=parsed.data,tenantId=req.user!.tenantId;
    if(!((await query('SELECT id FROM customers WHERE tenant_id=$1 AND id=$2',[tenantId,customerId])).rows[0]))return res.status(404).json({error:'Customer not found'});
    if(body.assigned_employee_id&&!((await query('SELECT id FROM employees WHERE tenant_id=$1 AND id=$2',[tenantId,body.assigned_employee_id])).rows[0]))return res.status(400).json({error:'Assigned employee not found'});
    const task=(await query(`INSERT INTO customer_tasks(tenant_id,customer_id,title,description,due_at,assigned_employee_id,created_by,priority)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [tenantId,customerId,body.title,body.description??null,body.due_at??null,body.assigned_employee_id??null,req.user!.id,body.priority])).rows[0];
    await addHistory(tenantId,customerId,req.user!.id,'task.created',task.id,{title:task.title,due_at:task.due_at});
    await recordAudit(tenantId,req.user!.id,'customer.task.created','customer_task',task.id,{customer_id:customerId});
    res.status(201).json(task);
  }catch(error){if(error instanceof z.ZodError)return invalid(res);next(error);}
});

customersRouter.patch('/customers/:id/tasks/:taskId',requireCsrf,requirePermission('customer_tasks:write'),async(req,res,next)=>{
  try{
    const customerId=uuid.parse(String(req.params.id)),taskId=uuid.parse(String(req.params.taskId));
    const parsed=taskSchema.partial().extend({status:z.enum(['open','completed','cancelled']).optional()}).safeParse(req.body);
    if(!parsed.success||!Object.keys(parsed.data).length)return invalid(res);
    const body=parsed.data,tenantId=req.user!.tenantId;
    const fields=Object.keys(body).filter(key=>key!=='status');
    if(body.assigned_employee_id&&!((await query('SELECT id FROM employees WHERE tenant_id=$1 AND id=$2',[tenantId,body.assigned_employee_id])).rows[0]))return res.status(400).json({error:'Assigned employee not found'});
    const assignments=['title','description','due_at','assigned_employee_id','priority'].filter(key=>fields.includes(key));
    const values=assignments.map(key=>(body as Record<string,unknown>)[key]);
    const statusIndex=values.length+1;
    const tenantIndex=values.length+2,customerIndex=values.length+3,taskIndex=values.length+4;
    values.push(body.status??null,tenantId,customerId,taskId);
    const updates=assignments.map((key,index)=>`${key}=$${index+1}`);
    updates.push(`status=COALESCE($${statusIndex},status)`);
    updates.push(`completed_at=CASE WHEN $${statusIndex}='completed' THEN now() WHEN $${statusIndex} IS NULL THEN completed_at ELSE NULL END`);
    updates.push('updated_at=now()');
    const task=(await query(`UPDATE customer_tasks SET ${updates.join(',')}
      WHERE tenant_id=$${tenantIndex} AND customer_id=$${customerIndex} AND id=$${taskIndex} RETURNING *`,values)).rows[0];
    if(!task)return res.status(404).json({error:'Task not found'});
    await addHistory(tenantId,customerId,req.user!.id,body.status?'task.status_changed':'task.updated',taskId,{...body});
    await recordAudit(tenantId,req.user!.id,'customer.task.updated','customer_task',taskId,{customer_id:customerId,...body});
    res.json(task);
  }catch(error){if(error instanceof z.ZodError)return invalid(res);next(error);}
});
