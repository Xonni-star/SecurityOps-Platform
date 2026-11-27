import {Router} from 'express';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {query,withTransaction} from '../db/pool.js';
import {requireAuth,requireCsrf,requirePermission} from '../middleware/auth.js';
import {recordAudit} from '../services/audit.js';
import {createSitePermissionReader} from '../services/site-permissions.js';
import {classifyQualification,daysUntil,evidenceStatusOf,qualificationLocalDate} from '../services/qualification-status.js';

type Row=Record<string,unknown>;
const uuid=z.string().uuid();
const nonempty=z.string().trim().min(1).max(500);
const date=z.string().date();
const catalogCode=z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{1,79}$/);
const categories=[
  'Gesetzliche Qualifikationen',
  'Erste Hilfe und medizinische Qualifikationen',
  'Brandschutz',
  'Arbeitsschutz',
  'Sicherheit und Spezialausbildungen',
  'Objektspezifische Qualifikationen',
  'Interne Schulungen',
  'Sonstige Qualifikationen',
] as const;
const categorySchema=z.enum(categories).nullable().optional();

const read=requirePermission('qualifications:read');
const siteRead=requirePermission('qualifications:read',{allowedScopes:['tenant','site','own','system']});
const write=requirePermission('qualifications:write');
const siteWrite=requirePermission('qualifications:write',{allowedScopes:['tenant','site','system']});
const catalogWrite=requirePermission('qualifications:catalog:write');
const revoke=requirePermission('qualifications:revoke');
const documentRead=requirePermission('qualifications:documents:read',{allowedScopes:['tenant','site','own','system']});
const documentDownload=requirePermission('qualifications:documents:download',{allowedScopes:['tenant','site','own','system']});
const remindersWrite=requirePermission('qualifications:reminders:write');
const exportPermission=requirePermission('qualifications:export');

export const qualificationsRouter=Router();
qualificationsRouter.use((req,res,next)=>{
  if(!/^\/(qualifications|employees\/[^/]+\/qualifications|sites\/[^/]+\/qualification-requirements)/.test(req.path))return next();
  return requireAuth(req,res,()=>['POST','PUT','PATCH','DELETE'].includes(req.method)?requireCsrf(req,res,next):next());
});

function fail(status:number,message:string):never{throw Object.assign(new Error(message),{status});}
function asText(value:unknown):string|undefined{
  if(value===null||value===undefined)return undefined;
  if(Array.isArray(value))return value.length?String(value[0]):undefined;
  return String(value);
}
function pathParam(value:unknown):string{return asText(value)??'';}
function isConflict(error:unknown):boolean{return typeof error==='object'&&error!==null&&(error as {code?:string}).code==='23505';}
function asIso(value:unknown):string{
  if(!value)return '';
  if(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value.trim()))return value.trim();
  const date=value instanceof Date?value:new Date(String(value));
  return Number.isNaN(date.getTime())?String(value).slice(0,10):qualificationLocalDate(date);
}
function csvCell(value:unknown):string{
  const text=value===null||value===undefined?'':String(value);
  return /[;"\n]/.test(text)?`"${text.replace(/"/g,'""')}"`:text;
}

const catalogColumns='id,code,name,description,category,default_validity_days,required,required_document_type,required_documents,active,created_at,updated_at';

qualificationsRouter.get('/qualifications/categories',read,(_req,res)=>res.json(categories));

qualificationsRouter.get('/qualifications/catalog',read,async(req,res,next)=>{
  try{
    const q=String(req.query.q??'').trim();
    const category=String(req.query.category??'').trim();
    const active=String(req.query.active??'');
    const params:unknown[]=[req.user!.tenantId];
    const filters:string[]=[];
    if(q){params.push(`%${q.toLowerCase()}%`);filters.push(`(lower(code) LIKE $${params.length} OR lower(name) LIKE $${params.length})`);}
    if(category){params.push(category);filters.push(`category=$${params.length}`);}
    if(active==='true'||active==='false'){params.push(active==='true');filters.push(`active=$${params.length}`);}
    const rows=(await query(`SELECT ${catalogColumns} FROM qualification_catalog WHERE tenant_id=$1${filters.length?` AND ${filters.join(' AND ')}`:''} ORDER BY name,code`,params)).rows;
    res.json(rows);
  }catch(error){next(error);}
});

qualificationsRouter.get('/qualifications/catalog/:id',read,async(req,res,next)=>{
  try{
    const row=(await query(`SELECT ${catalogColumns} FROM qualification_catalog WHERE tenant_id=$1 AND id=$2`,[req.user!.tenantId,req.params.id])).rows[0];
    if(!row)return res.status(404).json({error:'Qualifikation nicht gefunden'});
    res.json(row);
  }catch(error){next(error);}
});

qualificationsRouter.post('/qualifications/catalog',catalogWrite,async(req,res,next)=>{
  try{
    const body=z.object({
      code:catalogCode,name:nonempty.max(160),description:z.string().trim().max(2000).nullable().optional(),
      category:categorySchema,default_validity_days:z.number().int().positive().nullable().optional(),
      required:z.boolean().default(false),required_document_type:z.string().trim().max(120).nullable().optional(),
      required_documents:z.array(z.string().trim().min(1).max(120)).max(16).default([]),
      active:z.boolean().default(true),reason:nonempty,
    }).strict().parse(req.body);
    const row=await withTransaction(async client=>{
      const created=(await client.query<Row>(`INSERT INTO qualification_catalog(tenant_id,code,name,description,category,default_validity_days,required,required_document_type,required_documents,active)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${catalogColumns}`,
        [req.user!.tenantId,body.code,body.name,body.description??null,body.category??null,body.default_validity_days??null,
          body.required,body.required_document_type??null,JSON.stringify(body.required_documents),body.active])).rows[0];
      await recordAudit(req.user!.tenantId,req.user!.id,'qualification.catalog.created','qualification_catalog',asText(created.id),{reason:body.reason,code:body.code,name:body.name},client);
      return created;
    });
    res.status(201).json(row);
  }catch(error){
    if(isConflict(error))return next(fail(409,'Eine Qualifikation mit diesem Code existiert bereits.'));
    next(error);
  }
});

qualificationsRouter.patch('/qualifications/catalog/:id',catalogWrite,async(req,res,next)=>{
  try{
    const body=z.object({
      name:nonempty.max(160).optional(),description:z.string().trim().max(2000).nullable().optional(),
      category:categorySchema,default_validity_days:z.number().int().positive().nullable().optional(),
      required:z.boolean().optional(),required_document_type:z.string().trim().max(120).nullable().optional(),
      required_documents:z.array(z.string().trim().min(1).max(120)).max(16).optional(),
      active:z.boolean().optional(),reason:nonempty,
    }).strict().parse(req.body);
    const row=await withTransaction(async client=>{
      const before=(await client.query<Row>('SELECT * FROM qualification_catalog WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[req.user!.tenantId,req.params.id])).rows[0];
      if(!before)fail(404,'Qualifikation nicht gefunden');
      const updated=(await client.query<Row>(`UPDATE qualification_catalog SET
        name=$3,description=$4,category=$5,default_validity_days=$6,required=$7,required_document_type=$8,
        required_documents=$9,active=$10,updated_at=now()
        WHERE tenant_id=$1 AND id=$2 RETURNING ${catalogColumns}`,
        [req.user!.tenantId,req.params.id,body.name??before.name,body.description===undefined?before.description:body.description,
          body.category===undefined?before.category:body.category,
          body.default_validity_days===undefined?before.default_validity_days:body.default_validity_days,
          body.required??before.required,body.required_document_type===undefined?before.required_document_type:body.required_document_type,
          JSON.stringify(body.required_documents??before.required_documents),body.active??before.active])).rows[0];
      await recordAudit(req.user!.tenantId,req.user!.id,'qualification.catalog.updated','qualification_catalog',asText(updated.id),{
        reason:body.reason,code:before.code,
        changed_fields:Object.keys(body).filter(key=>key!=='reason'),
        previous:{name:before.name,active:before.active,category:before.category,default_validity_days:before.default_validity_days},
        current:{name:updated.name,active:updated.active,category:updated.category,default_validity_days:updated.default_validity_days},
      },client);
      return updated;
    });
    res.json(row);
  }catch(error){next(error);}
});

// Einheitlicher Kalendertag (Europe/Berlin) für SQL- und JS-Klassifikation.
const todaySql="(now() AT TIME ZONE 'Europe/Berlin')::date";
const evidenceRequiredSql=`(c.required_document_type IS NOT NULL OR COALESCE(jsonb_array_length(c.required_documents),0)>0)`;
const statusSql=`CASE
  WHEN q.status='revoked' OR q.revoked_at IS NOT NULL THEN 'revoked'
  WHEN q.status='invalid' OR c.active=false THEN 'invalid'
  WHEN q.status='expired' OR q.valid_until<${todaySql} THEN 'expired'
  WHEN q.valid_from>${todaySql} THEN 'not_yet_valid'
  WHEN ${evidenceRequiredSql} AND q.document_id IS NULL THEN 'missing_evidence'
  WHEN ${evidenceRequiredSql} AND (d.approval_status IS DISTINCT FROM 'approved' OR dv.lifecycle_state IS DISTINCT FROM 'available') THEN 'awaiting_review'
  WHEN ${evidenceRequiredSql} AND (d.valid_from>${todaySql} OR d.valid_until<${todaySql}) THEN 'expired'
  WHEN q.valid_until<=${todaySql}+INTERVAL '90 days' THEN 'expiring'
  ELSE 'valid' END`;

const overviewFrom=`FROM employee_qualifications q
  JOIN employees e ON e.tenant_id=q.tenant_id AND e.id=q.employee_id
  LEFT JOIN qualification_catalog c ON c.tenant_id=q.tenant_id AND (
    (q.catalog_id IS NOT NULL AND c.id=q.catalog_id) OR (q.catalog_id IS NULL AND c.code=q.code))
  LEFT JOIN dms_documents d ON d.tenant_id=q.tenant_id AND d.id=q.document_id
  LEFT JOIN LATERAL (
    SELECT v.lifecycle_state FROM dms_versions v
     WHERE v.tenant_id=d.tenant_id AND v.document_id=d.id ORDER BY v.version_no DESC LIMIT 1
  ) dv ON TRUE
  LEFT JOIN LATERAL (
    SELECT s.name site_name,s.id site_id FROM employee_object_assignments oa
      JOIN sites s ON s.tenant_id=oa.tenant_id AND s.id=oa.site_id
     WHERE oa.tenant_id=q.tenant_id AND oa.employee_id=q.employee_id
       AND oa.starts_on<=${todaySql} AND (oa.ends_on IS NULL OR oa.ends_on>=${todaySql})
     ORDER BY oa.primary_assignment DESC,oa.starts_on DESC LIMIT 1
  ) site ON TRUE`;

function overviewFilters(req:{query:Record<string,unknown>},tenantId:string):{where:string;params:unknown[]}{
  const queryParams=req.query;
  const params:unknown[]=[tenantId];
  const filters:string[]=['q.tenant_id=$1'];
  const add=(value:string,sql:(index:number)=>string)=>{
    if(!value.trim())return;
    params.push(value.trim());
    filters.push(sql(params.length));
  };
  const search=String(queryParams.q??'').trim().toLowerCase();
  if(search){
    params.push(`%${search}%`);
    filters.push(`(lower(e.name) LIKE $${params.length} OR lower(COALESCE(e.employee_number,'')) LIKE $${params.length} OR lower(q.code) LIKE $${params.length} OR lower(COALESCE(c.name,'')) LIKE $${params.length})`);
  }
  add(String(queryParams.employee_id??''),index=>`q.employee_id=$${index}`);
  add(String(queryParams.site_id??''),index=>`EXISTS (SELECT 1 FROM employee_object_assignments oa WHERE oa.tenant_id=q.tenant_id AND oa.employee_id=q.employee_id AND oa.site_id=$${index} AND oa.starts_on<=${todaySql} AND (oa.ends_on IS NULL OR oa.ends_on>=${todaySql}))`);
  add(String(queryParams.catalog_id??''),index=>`c.id=$${index}`);
  add(String(queryParams.code??''),index=>`q.code=$${index}`);
  add(String(queryParams.category??''),index=>`c.category=$${index}`);
  add(String(queryParams.status??''),index=>`${statusSql}=$${index}`);
  if(String(queryParams.expires_from??'').trim()){
    params.push(String(queryParams.expires_from));
    filters.push(`q.valid_until>=$${params.length}`);
  }
  if(String(queryParams.expires_to??'').trim()){
    params.push(String(queryParams.expires_to));
    filters.push(`q.valid_until<=$${params.length}`);
  }
  if(String(queryParams.days??'').trim()){
    const days=Number(queryParams.days);
    if(Number.isInteger(days)&&days>=0){
      params.push(days);
      filters.push(`q.valid_until BETWEEN ${todaySql} AND ${todaySql} + ($${params.length}||' days')::interval`);
    }
  }
  if(String(queryParams.missing_evidence??'')==='true')filters.push('(q.document_id IS NULL OR d.approval_status IS DISTINCT FROM \'approved\')');
  return {where:filters.join(' AND '),params};
}

function overviewRow(row:Row):Row{
  const evidence=evidenceStatusOf({
    document_id:row.document_id as string|null,
    evidence_document_status:row.document_status as string|null,
    evidence_approval_status:row.document_approval_status as string|null,
    evidence_lifecycle_state:row.document_lifecycle_state as string|null,
    evidence_valid_from:row.document_valid_from as string|null,
    evidence_valid_until:row.document_valid_until as string|null,
  });
  const requiredDocuments=Array.isArray(row.required_documents)?row.required_documents as unknown[]:[];
  const evidenceRequired=Boolean(row.required_document_type)||requiredDocuments.length>0;
  const classification=classifyQualification({
    storedStatus:row.status as string,
    revokedAt:row.revoked_at,
    catalogActive:row.catalog_active as boolean|null|undefined,
    validFrom:row.valid_from as string|null,
    validUntil:row.valid_until as string|null,
    evidenceStatus:evidence??undefined,
    requiresEvidence:evidenceRequired,
  });
  const days=daysUntil(row.valid_until as string|null);
  return {
    ...row,
    employee_name:row.employee_name??'',
    personnel_number:row.personnel_number??'',
    qualification_name:row.qualification_name??row.code,
    category:row.category??'Sonstige Qualifikationen',
    document_status:evidence,
    computed_status:classification.status,
    status_label:classification.label,
    issue_code:classification.issue_code,
    days_until_expiry:days,
    remaining_validity:days===null?'Unbefristet':days<0?`Seit ${Math.abs(days)} Tagen abgelaufen`:`Noch ${days} Tage gültig`,
    document_title:row.document_title??null,
    document_approval_status:row.document_approval_status??null,
    site_name:row.site_name??null,
  };
}

const overviewSelect=`SELECT q.id,q.employee_id,e.name employee_name,e.employee_number AS personnel_number,q.code,c.name qualification_name,
  c.category,q.issued_on,q.valid_from,q.valid_until,q.status,q.revoked_at,q.document_id,q.notes,c.required,
  c.required_document_type,c.required_documents,c.default_validity_days,c.active catalog_active,d.title document_title,
  d.approval_status document_approval_status,d.valid_from document_valid_from,d.valid_until document_valid_until,
  dv.lifecycle_state document_lifecycle_state,site.site_name,site.site_id,q.created_at,q.updated_at`;

qualificationsRouter.get('/qualifications/overview',read,async(req,res,next)=>{
  try{
    const {where,params}=overviewFilters(req,req.user!.tenantId);
    const sortMap:Record<string,string>={employee:'e.name',personnel_number:'e.employee_number',qualification:'c.name',code:'q.code',
      category:'c.category',issued_on:'q.issued_on',valid_from:'q.valid_from',valid_until:'q.valid_until',status:statusSql,document:'d.title'};
    const sort=sortMap[String(req.query.sort??'valid_until')]??sortMap.valid_until;
    const dir=String(req.query.dir??'asc').toLowerCase()==='desc'?'DESC':'ASC';
    const page=Math.max(1,Number(req.query.page??1)||1);
    const pageSize=Math.min(100,Math.max(1,Number(req.query.pageSize??25)||25));
    const count=(await query<{count:number}>(`SELECT COUNT(*)::int count ${overviewFrom} WHERE ${where}`,params)).rows[0].count;
    const rows=(await query<Row>(`${overviewSelect} ${overviewFrom} WHERE ${where} ORDER BY ${sort} ${dir},q.id ASC LIMIT $${params.length+1} OFFSET $${params.length+2}`,
      [...params,pageSize,(page-1)*pageSize])).rows.map(overviewRow);
    res.setHeader('X-Total-Count',String(count));
    res.setHeader('X-Page-Count',String(Math.max(1,Math.ceil(count/pageSize))));
    res.json(rows);
  }catch(error){next(error);}
});

qualificationsRouter.get('/qualifications/export',exportPermission,async(req,res,next)=>{
  try{
    const {where,params}=overviewFilters(req,req.user!.tenantId);
    const rows=(await query<Row>(`${overviewSelect} ${overviewFrom} WHERE ${where} ORDER BY e.name,q.valid_until NULLS LAST`,params)).rows.map(overviewRow);
    const header=['Mitarbeiter','Personalnummer','Qualifikation','Kategorie','Ausstellungsdatum','Gültig ab','Gültig bis','Restlaufzeit','Status','Objekt','Dokument','Dokumentstatus'];
    const lines=[header.join(';'),...rows.map(row=>[
      row.employee_name,row.personnel_number,row.qualification_name,row.category,asIso(row.issued_on),asIso(row.valid_from),
      asIso(row.valid_until),row.remaining_validity,row.status_label,row.site_name,row.document_title,row.document_status,
    ].map(csvCell).join(';'))];
    await recordAudit(req.user!.tenantId,req.user!.id,'qualifications.exported','qualification',undefined,{reason:'CSV-Export',count:rows.length});
    res.type('text/csv; charset=utf-8').send(`\uFEFF${lines.join('\r\n')}`);
  }catch(error){next(error);}
});

qualificationsRouter.get('/qualifications/analytics',read,async(req,res,next)=>{
  try{
    const tenant=req.user!.tenantId;
    const [kpi,categories,soon30,soon90,missing,siteCoverage]=await Promise.all([
      query<Row>(`SELECT COUNT(*)::int total,
        COUNT(*) FILTER(WHERE ${statusSql}='valid')::int valid,
        COUNT(*) FILTER(WHERE ${statusSql}='expiring')::int expiring,
        COUNT(*) FILTER(WHERE ${statusSql}='expired')::int expired,
        COUNT(*) FILTER(WHERE ${statusSql} IN ('revoked','invalid'))::int invalid_revoked,
        COUNT(*) FILTER(WHERE q.document_id IS NULL OR d.approval_status IS DISTINCT FROM 'approved')::int missing_evidence
        ${overviewFrom} WHERE q.tenant_id=$1`,[tenant]),
      query<Row>(`SELECT COALESCE(category,'Sonstige Qualifikationen') category,COUNT(*)::int count
        FROM qualification_catalog WHERE tenant_id=$1 AND active=true GROUP BY 1 ORDER BY 1`,[tenant]),
      query<Row>(`${overviewSelect} ${overviewFrom} WHERE q.tenant_id=$1 AND q.valid_until BETWEEN ${todaySql} AND ${todaySql}+INTERVAL '30 days' ORDER BY q.valid_until LIMIT 50`,[tenant]),
      query<Row>(`${overviewSelect} ${overviewFrom} WHERE q.tenant_id=$1 AND q.valid_until BETWEEN ${todaySql} AND ${todaySql}+INTERVAL '90 days' ORDER BY q.valid_until LIMIT 50`,[tenant]),
      query<Row>(`SELECT e.id employee_id,e.name employee,c.code,c.name qualification_name
        FROM employees e JOIN qualification_catalog c ON c.tenant_id=e.tenant_id AND c.required=true AND c.active=true
        WHERE e.tenant_id=$1 AND NOT EXISTS (
          SELECT 1 FROM employee_qualifications q WHERE q.tenant_id=e.tenant_id AND q.employee_id=e.id AND q.code=c.code
            AND q.status='valid' AND q.revoked_at IS NULL AND (q.valid_until IS NULL OR q.valid_until>=${todaySql}))
        ORDER BY e.name,c.name LIMIT 100`,[tenant]),
      query<Row>(`SELECT s.id site_id,s.name site,c.name qualification_name,
          COUNT(DISTINCT e.id)::int qualified,
          (SELECT COUNT(*)::int FROM site_qualification_requirements r WHERE r.tenant_id=s.tenant_id AND r.site_id=s.id AND r.active=true AND r.required=true) requirement_count
        FROM sites s
        JOIN site_qualification_requirements r ON r.tenant_id=s.tenant_id AND r.site_id=s.id AND r.active=true AND r.required=true
        JOIN qualification_catalog c ON c.tenant_id=r.tenant_id AND c.id=r.catalog_id
        LEFT JOIN employee_object_assignments oa ON oa.tenant_id=s.tenant_id AND oa.site_id=s.id AND (oa.ends_on IS NULL OR oa.ends_on>=${todaySql})
        LEFT JOIN employees e ON e.tenant_id=oa.tenant_id AND e.id=oa.employee_id AND EXISTS (
          SELECT 1 FROM employee_qualifications q WHERE q.tenant_id=e.tenant_id AND q.employee_id=e.id AND q.code=c.code
            AND q.status='valid' AND q.revoked_at IS NULL AND (q.valid_until IS NULL OR q.valid_until>=${todaySql}))
        WHERE s.tenant_id=$1 GROUP BY s.id,s.name,c.name ORDER BY s.name,c.name LIMIT 100`,[tenant]),
    ]);
    res.json({
      kpi:kpi.rows[0],categories:categories.rows,
      expiring_30_days:soon30.rows.map(overviewRow),expiring_90_days:soon90.rows.map(overviewRow),
      missing_required:missing.rows,site_coverage:siteCoverage.rows,
    });
  }catch(error){next(error);}
});

qualificationsRouter.get('/qualifications/assignments/:id',read,async(req,res,next)=>{
  try{
    const rows=(await query<Row>(`${overviewSelect} ${overviewFrom} WHERE q.tenant_id=$1 AND q.id=$2`,[req.user!.tenantId,req.params.id])).rows;
    if(!rows.length)return res.status(404).json({error:'Qualifikation nicht gefunden'});
    const row=overviewRow(rows[0]);
    const history=(await query<Row>(`SELECT event_type,details,created_at,actor_user_id FROM audit_events
      WHERE tenant_id=$1 AND entity_type='employee_qualification' AND entity_id=$2 ORDER BY created_at DESC LIMIT 100`,[req.user!.tenantId,row.id])).rows;
    res.json({...row,history});
  }catch(error){next(error);}
});

async function currentSiteId(db:PoolClient,tenantId:string,employeeId:string):Promise<string|null>{
  const row=(await db.query<{site_id:string}>(`SELECT site_id FROM employee_object_assignments
    WHERE tenant_id=$1 AND employee_id=$2 AND starts_on<=${todaySql} AND (ends_on IS NULL OR ends_on>=${todaySql})
    ORDER BY primary_assignment DESC,starts_on DESC LIMIT 1`,[tenantId,employeeId])).rows[0];
  return row?.site_id??null;
}

async function assertDocument(db:PoolClient,tenantId:string,documentId:string|null|undefined,employeeId:string):Promise<void>{
  if(!documentId)return;
  const row=(await db.query<Row>(`SELECT id FROM dms_documents WHERE tenant_id=$1 AND id=$2 AND document_status='active'
    AND (employee_id IS NULL OR employee_id=$3)`,[tenantId,documentId,employeeId])).rows[0];
  if(!row)fail(400,'Das Nachweisdokument ist nicht vorhanden, nicht freigegeben oder gehört einem anderen Mitarbeiter.');
}

const assignmentBody=z.object({
  catalog_id:uuid.nullable().optional(),code:catalogCode.optional(),
  issued_on:date.nullable().optional(),valid_from:date.nullable().optional(),valid_until:date.nullable().optional(),
  document_id:uuid.nullable().optional(),issuing_authority:z.string().trim().max(200).nullable().optional(),
  notes:z.string().trim().max(2000).nullable().optional(),reason:nonempty,
}).strict().refine(value=>!value.valid_from||!value.valid_until||value.valid_until>=value.valid_from,
  {message:'Gültig bis darf nicht vor Gültig ab liegen',path:['valid_until']});

async function resolveCatalog(db:PoolClient,tenantId:string,body:z.infer<typeof assignmentBody>):Promise<{code:string;default_validity_days:number|null;required:boolean;required_document_type:string|null;id:string}>{
  const row=body.catalog_id
    ? (await db.query<Row>('SELECT id,code,default_validity_days,required,required_document_type FROM qualification_catalog WHERE tenant_id=$1 AND id=$2 AND active=true',[tenantId,body.catalog_id])).rows[0]
    : body.code
      ? (await db.query<Row>('SELECT id,code,default_validity_days,required,required_document_type FROM qualification_catalog WHERE tenant_id=$1 AND code=$2 AND active=true',[tenantId,body.code])).rows[0]
      : undefined;
  if(!row)fail(400,'Die Qualifikation ist im Katalog nicht vorhanden oder nicht aktiv.');
  return row as {code:string;default_validity_days:number|null;required:boolean;required_document_type:string|null;id:string};
}

function calculateValidUntil(body:z.infer<typeof assignmentBody>,catalog:{default_validity_days:number|null}):string|null{
  if(body.valid_until!==undefined)return body.valid_until;
  if(body.valid_from&&catalog.default_validity_days){
    const start=new Date(`${body.valid_from}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate()+catalog.default_validity_days);
    return start.toISOString().slice(0,10);
  }
  return body.valid_until??null;
}

qualificationsRouter.get('/employees/:employeeId/qualifications',read,async(req,res,next)=>{
  try{
    const rows=(await query<Row>(`${overviewSelect} ${overviewFrom} WHERE q.tenant_id=$1 AND q.employee_id=$2 ORDER BY q.valid_until NULLS LAST,c.name`,[req.user!.tenantId,req.params.employeeId])).rows.map(overviewRow);
    res.json(rows);
  }catch(error){next(error);}
});

qualificationsRouter.post('/employees/:employeeId/qualifications',write,async(req,res,next)=>{
  try{
    const body=assignmentBody.parse(req.body);
    const tenant=req.user!.tenantId;
    const employeeId=uuid.parse(String(req.params.employeeId));
    const row=await withTransaction(async client=>{
      const employee=(await client.query<Row>('SELECT id FROM employees WHERE tenant_id=$1 AND id=$2 FOR SHARE',[tenant,employeeId])).rows[0];
      if(!employee)fail(404,'Mitarbeiter nicht gefunden');
      const catalog=await resolveCatalog(client,tenant,body);
      if(body.code&&body.code!==catalog.code)fail(400,'Der angegebene Code passt nicht zum gewählten Katalogeintrag.');
      await assertDocument(client,tenant,body.document_id,employeeId);
      const validUntil=calculateValidUntil(body,catalog);
      const issuedOn=body.issued_on??body.valid_from??qualificationLocalDate();
      const existing=(await client.query<Row>('SELECT id,status,revoked_at,code FROM employee_qualifications WHERE tenant_id=$1 AND employee_id=$2 AND code=$3 FOR UPDATE',[tenant,employeeId,catalog.code])).rows[0];
      if(existing&&existing.revoked_at&&existing.status==='revoked')fail(409,'Die Qualifikation ist widerrufen. Bitte zuerst den Widerruf aufheben oder einen neuen Datensatz anlegen.');
      const created=(await client.query<Row>(`INSERT INTO employee_qualifications
        (tenant_id,employee_id,catalog_id,code,issued_on,valid_from,valid_until,document_id,issuing_authority,status,notes,change_reason,created_by,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'valid',$10,$11,$12,now())
        ON CONFLICT(tenant_id,employee_id,code) DO UPDATE SET
          catalog_id=EXCLUDED.catalog_id,issued_on=EXCLUDED.issued_on,valid_from=EXCLUDED.valid_from,valid_until=EXCLUDED.valid_until,
          document_id=EXCLUDED.document_id,issuing_authority=EXCLUDED.issuing_authority,notes=EXCLUDED.notes,
          change_reason=EXCLUDED.change_reason,revoked_at=NULL,status='valid',updated_at=now()
        RETURNING *`,
        [tenant,employeeId,catalog.id,catalog.code,issuedOn,body.valid_from??null,validUntil,body.document_id??null,
          body.issuing_authority??null,body.notes??null,body.reason,req.user!.id])).rows[0];
      const siteId=await currentSiteId(client,tenant,employeeId);
      await recordAudit(tenant,req.user!.id,existing?'qualification.employee.updated':'qualification.employee.created','employee_qualification',asText(created.id),{
        reason:body.reason,employee_id:employeeId,site_id:siteId,code:catalog.code,issued_on:issuedOn,
        valid_from:body.valid_from??null,valid_until:validUntil,document_id:body.document_id??null,
        previous:existing?{valid_from:existing.valid_from,valid_until:existing.valid_until}:null,
      },client);
      return created;
    });
    res.status(201).json(row);
  }catch(error){
    if(isConflict(error))return next(fail(409,'Diese Qualifikation ist bereits für den Mitarbeiter erfasst.'));
    next(error);
  }
});

qualificationsRouter.patch('/employees/:employeeId/qualifications/:id',write,async(req,res,next)=>{
  try{
    const body=assignmentBody.parse(req.body);
    const tenant=req.user!.tenantId;
    const employeeId=uuid.parse(String(req.params.employeeId));
    const row=await withTransaction(async client=>{
      const current=(await client.query<Row>('SELECT * FROM employee_qualifications WHERE tenant_id=$1 AND employee_id=$2 AND id=$3 FOR UPDATE',[tenant,employeeId,req.params.id])).rows[0];
      if(!current)fail(404,'Qualifikation nicht gefunden');
      if(current.status==='revoked'||current.revoked_at)fail(409,'Eine widerrufene Qualifikation kann nicht bearbeitet werden.');
      const catalog=await resolveCatalog(client,tenant,{...body,code:body.code??String(current.code)});
      if(body.code&&body.code!==catalog.code)fail(400,'Der angegebene Code passt nicht zum gewählten Katalogeintrag.');
      await assertDocument(client,tenant,body.document_id===undefined?current.document_id as string|null:body.document_id,employeeId);
      const validUntil=body.valid_until===undefined&&body.valid_from===undefined
        ?current.valid_until as string|null
        :calculateValidUntil({...body,valid_from:body.valid_from??current.valid_from as string|null},catalog);
      const updated=(await client.query<Row>(`UPDATE employee_qualifications SET
        catalog_id=$4,code=$12,issued_on=$5,valid_from=$6,valid_until=$7,document_id=$8,issuing_authority=$9,notes=$10,
        change_reason=$11,updated_at=now() WHERE tenant_id=$1 AND employee_id=$2 AND id=$3 RETURNING *`,
        [tenant,employeeId,req.params.id,catalog.id,body.issued_on??current.issued_on??current.valid_from,
          body.valid_from===undefined?current.valid_from:body.valid_from,validUntil,
          body.document_id===undefined?current.document_id:body.document_id,
          body.issuing_authority===undefined?current.issuing_authority:body.issuing_authority,
          body.notes===undefined?current.notes:body.notes,body.reason,catalog.code])).rows[0];
      await recordAudit(tenant,req.user!.id,'qualification.employee.updated','employee_qualification',asText(updated.id),{
        reason:body.reason,employee_id:employeeId,site_id:await currentSiteId(client,tenant,employeeId),code:catalog.code,
        document_id:updated.document_id,previous:{valid_from:current.valid_from,valid_until:current.valid_until,document_id:current.document_id},
        current:{valid_from:updated.valid_from,valid_until:updated.valid_until,document_id:updated.document_id},
      },client);
      return updated;
    });
    res.json(row);
  }catch(error){next(error);}
});

qualificationsRouter.post('/employees/:employeeId/qualifications/:id/revoke',revoke,async(req,res,next)=>{
  try{
    const body=z.object({reason:nonempty}).strict().parse(req.body);
    const tenant=req.user!.tenantId;
    const employeeId=uuid.parse(pathParam(req.params.employeeId));
    const qualificationId=pathParam(req.params.id);
    const row=await withTransaction(async client=>{
      const current=(await client.query<Row>('SELECT * FROM employee_qualifications WHERE tenant_id=$1 AND employee_id=$2 AND id=$3 FOR UPDATE',[tenant,employeeId,qualificationId])).rows[0];
      if(!current)fail(404,'Qualifikation nicht gefunden');
      if(current.status==='revoked')fail(409,'Die Qualifikation ist bereits widerrufen.');
      const updated=(await client.query<Row>(`UPDATE employee_qualifications SET status='revoked',revoked_at=now(),change_reason=$4,updated_at=now()
        WHERE tenant_id=$1 AND employee_id=$2 AND id=$3 RETURNING *`,[tenant,employeeId,qualificationId,body.reason])).rows[0];
      await recordAudit(tenant,req.user!.id,'qualification.employee.revoked','employee_qualification',asText(updated.id),{
        reason:body.reason,employee_id:employeeId,site_id:await currentSiteId(client,tenant,employeeId),
        code:current.code,previous:{status:current.status,revoked_at:current.revoked_at},current:{status:'revoked',revoked_at:updated.revoked_at},
      },client);
      return updated;
    });
    res.json(row);
  }catch(error){next(error);}
});

/** Entfernung ist revisionsfähig: der Datensatz bleibt als ungültig erhalten. */
qualificationsRouter.delete('/employees/:employeeId/qualifications/:id',write,async(req,res,next)=>{
  try{
    const body=z.object({reason:nonempty}).strict().parse(req.body);
    const tenant=req.user!.tenantId;
    const employeeId=uuid.parse(pathParam(req.params.employeeId));
    const qualificationId=pathParam(req.params.id);
    await withTransaction(async client=>{
      const current=(await client.query<Row>('SELECT * FROM employee_qualifications WHERE tenant_id=$1 AND employee_id=$2 AND id=$3 FOR UPDATE',[tenant,employeeId,qualificationId])).rows[0];
      if(!current)fail(404,'Qualifikation nicht gefunden');
      await client.query(`UPDATE employee_qualifications SET status='invalid',change_reason=$4,updated_at=now()
        WHERE tenant_id=$1 AND employee_id=$2 AND id=$3`,[tenant,employeeId,qualificationId,body.reason]);
      await recordAudit(tenant,req.user!.id,'qualification.employee.removed','employee_qualification',asText(current.id),{
        reason:body.reason,employee_id:employeeId,site_id:await currentSiteId(client,tenant,employeeId),
        code:current.code,previous:{status:current.status},current:{status:'invalid'},
      },client);
    });
    res.status(204).send();
  }catch(error){next(error);}
});

qualificationsRouter.get('/qualifications/reminders',read,async(req,res,next)=>{
  try{
    const row=(await query<Row>('SELECT reminder_days,updated_at FROM qualification_reminder_settings WHERE tenant_id=$1',[req.user!.tenantId])).rows[0]
      ??{reminder_days:[90,60,30,7],updated_at:null};
    res.json(row);
  }catch(error){next(error);}
});

qualificationsRouter.put('/qualifications/reminders',remindersWrite,async(req,res,next)=>{
  try{
    const body=z.object({
      reminder_days:z.array(z.number().int().min(1).max(3650)).min(1).max(8),reason:nonempty,
    }).strict().parse(req.body);
    const days=[...new Set(body.reminder_days)].sort((left,right)=>right-left);
    const row=await withTransaction(async client=>{
      const updated=(await client.query<Row>(`INSERT INTO qualification_reminder_settings(tenant_id,reminder_days,updated_by)
        VALUES($1,$2,$3) ON CONFLICT(tenant_id) DO UPDATE SET reminder_days=EXCLUDED.reminder_days,
        updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING reminder_days,updated_at`,
        [req.user!.tenantId,days,req.user!.id])).rows[0];
      await recordAudit(req.user!.tenantId,req.user!.id,'qualification.reminders.updated','qualification_reminder_settings',req.user!.tenantId,
        {reason:body.reason,reminder_days:days},client);
      return updated;
    });
    res.json(row);
  }catch(error){next(error);}
});

qualificationsRouter.get('/qualifications/reminders/history',read,async(req,res,next)=>{
  try{
    const rows=(await query<Row>(`SELECT s.qualification_id,s.days,s.due_date,s.event_key,s.channel,s.sent_at,
      s.event_type,s.title,s.body,s.employee_id,s.catalog_id,
      COALESCE(q.code,c.code) code,c.name qualification_name,e.name employee_name,
      d.status delivery_status,d.sent_at delivery_sent_at,d.last_error
      FROM qualification_reminder_state s
      LEFT JOIN employee_qualifications q ON q.tenant_id=s.tenant_id AND q.id=s.qualification_id
      LEFT JOIN employees e ON e.tenant_id=s.tenant_id AND e.id=s.employee_id
      LEFT JOIN qualification_catalog c ON c.tenant_id=s.tenant_id AND c.id=s.catalog_id
      LEFT JOIN notification_deliveries d ON d.tenant_id=s.tenant_id AND d.event_key=s.event_key
      WHERE s.tenant_id=$1 ORDER BY s.sent_at DESC LIMIT 200`,[req.user!.tenantId])).rows;
    res.json(rows);
  }catch(error){next(error);}
});

qualificationsRouter.get('/sites/:siteId/qualification-requirements',siteRead,async(req,res,next)=>{
  try{
    const siteId=uuid.parse(String(req.params.siteId));
    const canRead=createSitePermissionReader(req);
    if(!await canRead('qualifications:read',siteId))return res.status(403).json({error:'Kein Zugriff auf dieses Objekt'});
    const rows=(await query<Row>(`SELECT r.*,c.code,c.name qualification_name,c.category,c.active catalog_active
      FROM site_qualification_requirements r JOIN qualification_catalog c ON c.tenant_id=r.tenant_id AND c.id=r.catalog_id
      WHERE r.tenant_id=$1 AND r.site_id=$2 ORDER BY c.name`,[req.user!.tenantId,siteId])).rows;
    res.json(rows);
  }catch(error){next(error);}
});

const requirementBody=z.object({
  catalog_id:uuid,required:z.boolean().default(true),active:z.boolean().default(true),
  responsible_employee_id:uuid.nullable().optional(),notes:z.string().trim().max(2000).nullable().optional(),
  reason:nonempty,
}).strict();

qualificationsRouter.post('/sites/:siteId/qualification-requirements',siteWrite,documentRead,async(req,res,next)=>{
  try{
    const body=requirementBody.parse(req.body);
    const tenant=req.user!.tenantId;
    const siteId=uuid.parse(String(req.params.siteId));
    const canRead=createSitePermissionReader(req);
    if(!await canRead('qualifications:read',siteId))return res.status(403).json({error:'Kein Zugriff auf dieses Objekt'});
    const row=await withTransaction(async client=>{
      const catalog=(await client.query<Row>('SELECT id,code,name FROM qualification_catalog WHERE tenant_id=$1 AND id=$2 AND active=true',[tenant,body.catalog_id])).rows[0];
      if(!catalog)fail(400,'Die Qualifikation ist im Katalog nicht aktiv');
      const created=(await client.query<Row>(`INSERT INTO site_qualification_requirements
        (tenant_id,site_id,catalog_id,required,active,responsible_employee_id,notes,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [tenant,siteId,body.catalog_id,body.required,body.active,body.responsible_employee_id??null,body.notes??null,req.user!.id])).rows[0];
      await recordAudit(tenant,req.user!.id,'site.qualification_requirement.created','site_qualification_requirement',asText(created.id),
        {reason:body.reason,site_id:siteId,code:catalog.code,active:created.active},client);
      return created;
    });
    res.status(201).json(row);
  }catch(error){
    if(isConflict(error))return next(fail(409,'Diese Qualifikationsanforderung ist für das Objekt bereits erfasst.'));
    next(error);
  }
});

qualificationsRouter.patch('/sites/:siteId/qualification-requirements/:id',siteWrite,async(req,res,next)=>{
  try{
    const body=z.object({required:z.boolean().optional(),active:z.boolean().optional(),
      responsible_employee_id:uuid.nullable().optional(),notes:z.string().trim().max(2000).nullable().optional(),reason:nonempty}).strict().parse(req.body);
    const tenant=req.user!.tenantId;
    const siteId=uuid.parse(String(req.params.siteId));
    const canRead=createSitePermissionReader(req);
    if(!await canRead('qualifications:read',siteId))return res.status(403).json({error:'Kein Zugriff auf dieses Objekt'});
    const row=await withTransaction(async client=>{
      const current=(await client.query<Row>('SELECT * FROM site_qualification_requirements WHERE tenant_id=$1 AND site_id=$2 AND id=$3 FOR UPDATE',[tenant,siteId,req.params.id])).rows[0];
      if(!current)fail(404,'Qualifikationsanforderung nicht gefunden');
      const updated=(await client.query<Row>(`UPDATE site_qualification_requirements SET required=$4,active=$5,
        responsible_employee_id=$6,notes=$7,updated_at=now() WHERE tenant_id=$1 AND site_id=$2 AND id=$3 RETURNING *`,
        [tenant,siteId,req.params.id,body.required??current.required,body.active??current.active,
          body.responsible_employee_id===undefined?current.responsible_employee_id:body.responsible_employee_id,
          body.notes===undefined?current.notes:body.notes])).rows[0];
      await recordAudit(tenant,req.user!.id,'site.qualification_requirement.updated','site_qualification_requirement',asText(updated.id),
        {reason:body.reason,site_id:siteId,previous:{active:current.active,required:current.required},
          current:{active:updated.active,required:updated.required}},client);
      return updated;
    });
    res.json(row);
  }catch(error){next(error);}
});

qualificationsRouter.delete('/sites/:siteId/qualification-requirements/:id',siteWrite,async(req,res,next)=>{
  try{
    const body=z.object({reason:nonempty}).strict().parse(req.body);
    const tenant=req.user!.tenantId;
    const siteId=uuid.parse(String(req.params.siteId));
    const canRead=createSitePermissionReader(req);
    if(!await canRead('qualifications:read',siteId))return res.status(403).json({error:'Kein Zugriff auf dieses Objekt'});
    await withTransaction(async client=>{
      const current=(await client.query<Row>('SELECT id FROM site_qualification_requirements WHERE tenant_id=$1 AND site_id=$2 AND id=$3 FOR UPDATE',[tenant,siteId,req.params.id])).rows[0];
      if(!current)fail(404,'Qualifikationsanforderung nicht gefunden');
      await client.query('UPDATE site_qualification_requirements SET active=false,updated_at=now() WHERE tenant_id=$1 AND site_id=$2 AND id=$3',[tenant,siteId,req.params.id]);
      await recordAudit(tenant,req.user!.id,'site.qualification_requirement.deactivated','site_qualification_requirement',asText(current.id),
        {reason:body.reason,site_id:siteId,active:false},client);
    });
    res.status(204).send();
  }catch(error){next(error);}
});

/** Nachweis-Download nur mit eigener Berechtigung und dokumentierter DMS-Berechtigung. */
qualificationsRouter.get('/qualifications/assignments/:id/document',documentDownload,async(req,res,next)=>{
  try{
    const row=(await query<Row>(`SELECT q.document_id,d.title,d.approval_status FROM employee_qualifications q
      LEFT JOIN dms_documents d ON d.tenant_id=q.tenant_id AND d.id=q.document_id
      WHERE q.tenant_id=$1 AND q.id=$2`,[req.user!.tenantId,req.params.id])).rows[0];
    if(!row)return res.status(404).json({error:'Qualifikation nicht gefunden'});
    if(!row.document_id)return res.status(404).json({error:'Für diese Qualifikation ist kein Nachweis verknüpft'});
    if(row.approval_status!=='approved')return res.status(409).json({error:'Der Nachweis ist noch nicht freigegeben und kann nicht heruntergeladen werden.'});
    res.json({document_id:row.document_id,title:row.title,download_url:`/api/v1/dms/documents/${row.document_id}/versions/latest/download`});
  }catch(error){next(error);}
});
