import {Router} from 'express';
import {z} from 'zod';
import {query,withTransaction} from '../db/pool.js';
import {requireAuth,requireCsrf,requirePermission} from '../middleware/auth.js';
import {recordAudit} from '../services/audit.js';
import {classifyQualification,daysUntil,evidenceStatusOf} from '../services/qualification-status.js';
import {canAccessResource,effectivePermissionScope,normalizePermissionGrants} from '../types/authorization.js';

const uuid=z.string().uuid();
const nonempty=z.string().trim().min(1);
/** Field paths and messages only: never echo employee values back to the client or logs. */
type ValidationIssue=z.ZodError['issues'][number];
const validationMessage=(issue:ValidationIssue):string=>{
  switch(issue.code){
    case 'invalid_format':
      return issue.format==='email'?'Ungültige E-Mail-Adresse':issue.format==='date'?'Ungültiges Datum':'Ungültiges Format';
    case 'invalid_value':
      return 'Ungültiger Wert';
    case 'invalid_type':
      return `Ungültiger Wert: ${issue.expected} erwartet`;
    case 'too_small':
      return issue.origin==='string'&&issue.minimum===1?'Darf nicht leer sein':`Wert zu klein: mindestens ${issue.minimum} erwartet`;
    case 'too_big':
      return `Wert zu groß: höchstens ${issue.maximum} erwartet`;
    default:
      return 'Ungültiger Wert';
  }
};
const validationFields=(error:z.ZodError)=>Object.fromEntries(error.issues.map(issue=>issue.code==='unrecognized_keys'
  ?[issue.keys[0]??'_',`Feld ${issue.keys[0]} ist nicht erlaubt.`]
  :[issue.path.join('.')||'_',validationMessage(issue)]));

const profileSchema=z.object({
  name:nonempty.max(240),
  email:z.string().email(),
  title:z.string().trim().max(160).nullable().optional(),
  employee_number:z.string().trim().max(80).nullable().optional(),
  first_name:z.string().trim().max(120).nullable().optional(),
  last_name:z.string().trim().max(120).nullable().optional(),
  phone:z.string().trim().max(40).nullable().optional(),
  mobile:z.string().trim().max(40).nullable().optional(),
  address:z.string().trim().max(1000).nullable().optional(),
  date_of_birth:z.string().date().nullable().optional(),
  hire_date:z.string().date().nullable().optional(),
  termination_date:z.string().date().nullable().optional(),
  employment_status:z.enum(['active','probation','leave','terminated','archived']),
  employment_type:z.enum(['employee','temporary','contractor','intern','apprentice','freelancer']),
  department:z.string().trim().max(160).nullable().optional(),
  position:z.string().trim().max(160).nullable().optional(),
  work_location:z.string().trim().max(160).nullable().optional(),
  weekly_hours:z.number().min(0).max(168).nullable().optional(),
  user_id:uuid.nullable().optional(),
  reason:nonempty.max(500),
}).strict();

const contractSchema=z.object({
  contract_number:z.string().trim().max(80).nullable().optional(),
  contract_type:z.enum(['permanent','fixed_term','part_time','temporary','internship','freelance','apprenticeship']),
  status:z.enum(['draft','active','ended','cancelled']).default('active'),
  starts_on:z.string().date(),
  ends_on:z.string().date().nullable().optional(),
  weekly_hours:z.number().min(0).max(168).nullable().optional(),
  probation_ends_on:z.string().date().nullable().optional(),
  notice_period_days:z.number().int().min(0).nullable().optional(),
  cost_center:z.string().trim().max(160).nullable().optional(),
  notes:z.string().trim().max(2000).nullable().optional(),
  reason:nonempty.max(500),
}).strict();

const availabilitySchema=z.object({
  weekday:z.number().int().min(0).max(6),
  starts_time:z.string().regex(/^\d{2}:\d{2}$/),
  ends_time:z.string().regex(/^\d{2}:\d{2}$/),
  available:z.boolean().default(true),
  valid_from:z.string().date().nullable().optional(),
  valid_until:z.string().date().nullable().optional(),
  note:z.string().trim().max(1000).nullable().optional(),
  reason:nonempty.max(500),
}).strict();

const objectAssignmentSchema=z.object({
  site_id:uuid,
  assignment_type:z.enum(['operational','management','support','temporary','reserve']).default('operational'),
  role:z.string().trim().max(160).nullable().optional(),
  starts_on:z.string().date(),
  ends_on:z.string().date().nullable().optional(),
  primary_assignment:z.boolean().default(false),
  notes:z.string().trim().max(2000).nullable().optional(),
  reason:nonempty.max(500),
}).strict();

const absenceSchema=z.object({
  starts_at:z.string().datetime({offset:true}),
  ends_at:z.string().datetime({offset:true}),
  absence_type:z.enum(['vacation','sick','training','special_leave','compensatory','unavailable','other']).default('other'),
  status:z.enum(['requested','approved','rejected','cancelled']).default('approved'),
  reason:z.string().trim().max(2000).nullable().optional(),
  document_id:uuid.nullable().optional(),
  audit_reason:nonempty.max(500),
}).strict();

export const employeesRouter=Router();
employeesRouter.use('/employees',requireAuth);

/** Einheitlicher Berliner Kalendertag für alle Gültigkeitsvergleiche. */
const berlinDate=`(now() AT TIME ZONE 'Europe/Berlin')::date`;
// Zentrale Gültigkeitsregeln für die kompakten Mitarbeiteransichten. Die
// vollständige Klassifikation liegt in services/qualification-status.ts.
const qualificationProblem=`q.status IN ('expired','revoked','invalid') OR q.revoked_at IS NOT NULL OR (q.valid_until IS NOT NULL AND q.valid_until<${berlinDate}) OR (q.valid_from IS NOT NULL AND q.valid_from>${berlinDate})`;
const qualificationCurrentlyValid=`q.status='valid' AND q.revoked_at IS NULL AND (q.valid_from IS NULL OR q.valid_from<=${berlinDate}) AND (q.valid_until IS NULL OR q.valid_until>=${berlinDate})`;

employeesRouter.get('/employees/overview',requirePermission('employees:read'),async(req,res,next)=>{
  try{
    const rows=(await query(
      `SELECT e.*,
        COALESCE((
          SELECT s.name
          FROM employee_object_assignments oa
          JOIN sites s ON s.tenant_id=oa.tenant_id AND s.id=oa.site_id
          WHERE oa.tenant_id=e.tenant_id AND oa.employee_id=e.id
            AND oa.starts_on<=${berlinDate} AND (oa.ends_on IS NULL OR oa.ends_on>=${berlinDate})
          ORDER BY oa.primary_assignment DESC,oa.starts_on DESC LIMIT 1
        ),'') AS current_object,
        CASE
          WHEN EXISTS (
            SELECT 1 FROM employee_qualifications q
            WHERE q.tenant_id=e.tenant_id AND q.employee_id=e.id AND (${qualificationProblem})
          ) THEN 'abgelaufen'
          WHEN EXISTS (
            SELECT 1 FROM employee_qualifications q
            WHERE q.tenant_id=e.tenant_id AND q.employee_id=e.id
              AND ${qualificationCurrentlyValid} AND q.valid_until IS NOT NULL
              AND q.valid_until BETWEEN ${berlinDate} AND ${berlinDate}+INTERVAL '90 days'
          ) THEN 'läuft bald ab'
          WHEN EXISTS (
            SELECT 1 FROM employee_qualifications q
            WHERE q.tenant_id=e.tenant_id AND q.employee_id=e.id AND ${qualificationCurrentlyValid}
          ) THEN 'gültig'
          ELSE 'keine Daten'
        END AS qualification_status
       FROM employees e
       WHERE e.tenant_id=$1
       ORDER BY e.name`,
      [req.user!.tenantId],
    )).rows;
    res.json(rows);
  }catch(error){next(error);}
});

employeesRouter.get('/employees/dashboard',requirePermission('employees:read'),async(req,res,next)=>{
  try{
    const tenant=req.user!.tenantId;
    const [employees,expiring,expired,shifts,openAbsences,vacationAbsences,sickAbsences,assignments,contracts,missingQualifications,missingDocuments,expiringRows,missingDocumentRows,pendingTasks,withoutObject]=await Promise.all([
      query<{total:number;active:number;inactive:number;on_leave:number;sick:number;terminated:number}>(
        `SELECT COUNT(*)::int total,
          COUNT(*) FILTER(WHERE employment_status IN ('active','probation'))::int active,
          COUNT(*) FILTER(WHERE employment_status IN ('terminated','archived'))::int inactive,
          COUNT(*) FILTER(WHERE employment_status='leave')::int on_leave,
          COUNT(*) FILTER(WHERE employment_status='leave')::int sick,
          COUNT(*) FILTER(WHERE employment_status='terminated')::int terminated
         FROM employees WHERE tenant_id=$1`,[tenant]),
      query<{count:number}>(
        `SELECT COUNT(*)::int count FROM employee_qualifications q
         WHERE q.tenant_id=$1 AND q.status='valid' AND q.revoked_at IS NULL
           AND (q.valid_from IS NULL OR q.valid_from<=${berlinDate})
           AND q.valid_until IS NOT NULL
           AND q.valid_until BETWEEN ${berlinDate} AND ${berlinDate}+INTERVAL '90 days'`,[tenant]),
      query<{count:number}>(
        `SELECT COUNT(*)::int count FROM employee_qualifications q
         WHERE q.tenant_id=$1 AND (${qualificationProblem})`,[tenant]),
      query<{count:number}>(
        `SELECT COUNT(DISTINCT a.employee_id)::int count FROM schedule_assignments a
         JOIN schedule_shifts s ON s.tenant_id=a.tenant_id AND s.id=a.shift_id
         WHERE a.tenant_id=$1 AND a.status='assigned' AND s.starts_at<=now() AND s.ends_at>=now()`,[tenant]),
      query<{count:number}>(
        `SELECT COUNT(*)::int count FROM employee_absences
         WHERE tenant_id=$1 AND status IN ('requested','approved') AND ends_at>=now()`,[tenant]),
      query<{count:number}>(
        `SELECT COUNT(*)::int count FROM employee_absences
         WHERE tenant_id=$1 AND status='approved' AND absence_type='vacation' AND starts_at<=now() AND ends_at>=now()`,[tenant]),
      query<{count:number}>(
        `SELECT COUNT(*)::int count FROM employee_absences
         WHERE tenant_id=$1 AND status='approved' AND absence_type='sick' AND starts_at<=now() AND ends_at>=now()`,[tenant]),
      query<{count:number}>(
        `SELECT COUNT(DISTINCT employee_id)::int count FROM employee_object_assignments
         WHERE tenant_id=$1 AND starts_on<=${berlinDate} AND (ends_on IS NULL OR ends_on >= ${berlinDate})`,[tenant]),
      query<{count:number}>(
        `SELECT COUNT(*)::int count FROM employee_contracts
         WHERE tenant_id=$1 AND status='active'`,[tenant]),
      query<{count:number}>(
        `SELECT COUNT(*)::int count FROM qualification_catalog c
         JOIN employees e ON e.tenant_id=c.tenant_id
         WHERE c.tenant_id=$1 AND c.required=true AND c.active=true
           AND e.employment_status IN ('active','probation')
           AND NOT EXISTS (
             SELECT 1 FROM employee_qualifications q
             LEFT JOIN dms_documents d ON d.tenant_id=q.tenant_id AND d.id=q.document_id
             LEFT JOIN LATERAL (
               SELECT v.lifecycle_state FROM dms_versions v
               WHERE v.tenant_id=d.tenant_id AND v.document_id=d.id AND v.lifecycle_state='available'
                ORDER BY v.version_no DESC LIMIT 1
             ) dv ON TRUE
             WHERE q.tenant_id=c.tenant_id AND q.employee_id=e.id
               AND (c.id=q.catalog_id OR (q.catalog_id IS NULL AND c.code=q.code))
               AND ${qualificationCurrentlyValid}
               AND (
                 (c.required_document_type IS NULL AND COALESCE(jsonb_array_length(c.required_documents),0)=0)
                 OR (d.document_status='active' AND d.approval_status='approved' AND dv.lifecycle_state='available'
                   AND (d.valid_from IS NULL OR d.valid_from<=${berlinDate})
                   AND (d.valid_until IS NULL OR d.valid_until>=${berlinDate}))
               )
           )`,[tenant]),
      query<{count:number}>(
        `SELECT COUNT(*)::int count FROM employees e
         WHERE e.tenant_id=$1 AND NOT EXISTS (
           SELECT 1 FROM dms_documents d
           WHERE d.tenant_id=e.tenant_id AND d.employee_id=e.id
         )`,[tenant]),
      query<{employee:string;code:string;valid_until:string}>(
        `SELECT e.name employee,q.code,COALESCE(q.valid_until::text,'') valid_until
         FROM employee_qualifications q JOIN employees e ON e.tenant_id=q.tenant_id AND e.id=q.employee_id
         WHERE q.tenant_id=$1 AND ${qualificationCurrentlyValid} AND q.valid_until IS NOT NULL
         AND q.valid_until BETWEEN ${berlinDate} AND ${berlinDate}+INTERVAL '90 days'
         ORDER BY q.valid_until,e.name LIMIT 10`,
        [tenant],
      ),
      query<{employee:string;title:string}>(
        `SELECT e.name employee,d.title
         FROM employees e LEFT JOIN dms_documents d ON d.tenant_id=e.tenant_id AND d.employee_id=e.id
         WHERE e.tenant_id=$1 AND d.id IS NULL
         ORDER BY e.name LIMIT 10`,
        [tenant],
      ),
      query<{employee:string;task:string;due:string}>(
        `SELECT e.name employee,
          CASE WHEN ea.status='requested' THEN 'Abwesenheit genehmigen'
             WHEN ea.absence_type='sick' THEN 'Krankmeldung prüfen'
             ELSE 'Unterweisung oder Personalaufgabe' END task,
          COALESCE(ea.starts_at::text,'') due
         FROM employee_absences ea JOIN employees e ON e.tenant_id=ea.tenant_id AND e.id=ea.employee_id
         WHERE ea.tenant_id=$1 AND ea.status='requested'
         ORDER BY ea.starts_at LIMIT 10`,
        [tenant],
      ),
      query<{count:number}>(
        `SELECT COUNT(*)::int count FROM employees e
         WHERE e.tenant_id=$1 AND e.employment_status IN ('active','probation','leave')
           AND NOT EXISTS (
             SELECT 1 FROM employee_object_assignments oa
             WHERE oa.tenant_id=e.tenant_id AND oa.employee_id=e.id
               AND oa.starts_on<=${berlinDate} AND (oa.ends_on IS NULL OR oa.ends_on>=${berlinDate})
           )`,[tenant]),
    ]);
    res.json({
      employees:{
        ...employees.rows[0],
        on_leave:vacationAbsences.rows[0].count,
        sick:sickAbsences.rows[0].count,
      },
      qualifications_expiring_90_days:expiring.rows[0].count,
      qualifications_expired:expired.rows[0].count,
      upcoming_shift_assignments:shifts.rows[0].count,
      open_absences:openAbsences.rows[0].count,
      sick_employees:sickAbsences.rows[0].count,
      active_object_assignments:assignments.rows[0].count,
      active_contracts:contracts.rows[0].count,
      missing_required_qualifications:missingQualifications.rows[0].count,
      missing_documents:missingDocuments.rows[0].count,
      employees_without_object:withoutObject.rows[0].count,
      expiring_qualifications:expiringRows.rows,
      missing_document_employees:missingDocumentRows.rows,
      pending_tasks:pendingTasks.rows,
    });
  }catch(error){next(error);}
});

employeesRouter.get('/employees/:id/profile',requirePermission('employees:read'),async(req,res,next)=>{
  try{
    const id=uuid.parse(String(req.params.id));
    const employee=(await query(
      `SELECT e.*,u.email AS account_email,u.role AS account_role,u.is_system_admin AS account_is_system_admin
       FROM employees e LEFT JOIN users u ON u.tenant_id=e.tenant_id AND u.id=e.user_id
       WHERE e.tenant_id=$1 AND e.id=$2`,
      [req.user!.tenantId,id],
    )).rows[0];
    if(!employee)return res.status(404).json({error:'Mitarbeiter nicht gefunden'});
    const [contracts,qualifications,absences,objectAssignments,workTime,documents,availability]=await Promise.all([
      query('SELECT * FROM employee_contracts WHERE tenant_id=$1 AND employee_id=$2 ORDER BY starts_on DESC',[req.user!.tenantId,id]),
      query(`SELECT q.*,c.name AS catalog_name,c.category,c.active AS catalog_active,c.required_document_type,c.required_documents,
             d.title AS document_title,d.approval_status AS document_approval_status,
             d.valid_from AS document_valid_from,d.valid_until AS document_valid_until,
             dv.lifecycle_state AS document_lifecycle_state
             FROM employee_qualifications q
             LEFT JOIN qualification_catalog c ON c.tenant_id=q.tenant_id
               AND (c.id=q.catalog_id OR (q.catalog_id IS NULL AND c.code=q.code))
             LEFT JOIN dms_documents d ON d.tenant_id=q.tenant_id AND d.id=q.document_id
             LEFT JOIN LATERAL (
               SELECT v.lifecycle_state FROM dms_versions v
                WHERE v.tenant_id=d.tenant_id AND v.document_id=d.id AND v.lifecycle_state='available'
                ORDER BY v.version_no DESC LIMIT 1
             ) dv ON TRUE
             WHERE q.tenant_id=$1 AND q.employee_id=$2 ORDER BY q.valid_until NULLS LAST`,[req.user!.tenantId,id]),
      query('SELECT * FROM employee_absences WHERE tenant_id=$1 AND employee_id=$2 ORDER BY starts_at DESC',[req.user!.tenantId,id]),
      query(`SELECT oa.*,s.name AS site_name
             FROM employee_object_assignments oa JOIN sites s ON s.tenant_id=oa.tenant_id AND s.id=oa.site_id
             WHERE oa.tenant_id=$1 AND oa.employee_id=$2 ORDER BY oa.starts_on DESC,oa.primary_assignment DESC`,[req.user!.tenantId,id]),
      query(`SELECT id,provider,external_id,started_at,ended_at,minutes,status,created_at,updated_at
             FROM work_time_entries WHERE tenant_id=$1 AND employee_id=$2
             ORDER BY started_at DESC LIMIT 100`,[req.user!.tenantId,id]),
      query(`SELECT d.id,d.title,d.description,d.employee_document_category,d.document_status,d.created_at,
             COALESCE(json_agg(json_build_object('id',v.id,'version_no',v.version_no,'lifecycle_state',v.lifecycle_state,'created_at',v.created_at,'retention_until',v.retention_until) ORDER BY v.version_no DESC) FILTER (WHERE v.id IS NOT NULL),'[]') AS versions
             FROM dms_documents d
             LEFT JOIN dms_versions v ON v.tenant_id=d.tenant_id AND v.document_id=d.id
             WHERE d.tenant_id=$1 AND d.employee_id=$2
             GROUP BY d.id ORDER BY d.created_at DESC`,[req.user!.tenantId,id]),
      query('SELECT * FROM employee_availability WHERE tenant_id=$1 AND employee_id=$2 ORDER BY weekday,starts_time',[req.user!.tenantId,id]),
    ]);
    const enrichedQualifications=qualifications.rows.map(row=>{
      const requiredDocuments=Array.isArray(row.required_documents)?row.required_documents as unknown[]:[];
      const evidence=evidenceStatusOf({
        document_id:row.document_id,
        evidence_document_status:row.document_status??row.document_approval_status,
        evidence_approval_status:row.document_approval_status,
        evidence_lifecycle_state:row.document_lifecycle_state,
        evidence_valid_from:row.document_valid_from,
        evidence_valid_until:row.document_valid_until,
      });
      const classification=classifyQualification({
        storedStatus:row.status,
        revokedAt:row.revoked_at,
        catalogActive:row.catalog_active,
        validFrom:row.valid_from,
        validUntil:row.valid_until,
        evidenceStatus:evidence??undefined,
        requiresEvidence:Boolean(row.required_document_type)||requiredDocuments.length>0,
      });
      return {...row,computed_status:classification.status,status_label:classification.label,
        days_until_expiry:daysUntil(row.valid_until),document_status:evidence};
    });
    res.json({
      employee,
      contracts:contracts.rows,
      qualifications:enrichedQualifications,
      absences:absences.rows,
      object_assignments:objectAssignments.rows,
      work_time:workTime.rows,
      documents:documents.rows,
      availability:availability.rows,
    });
  }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Ungültige Mitarbeiter-ID'});next(error);}
});

employeesRouter.patch('/employees/:id/profile',requireCsrf,requirePermission('employees:write'),async(req,res,next)=>{
  try{
    const id=uuid.parse(String(req.params.id));
    const body=profileSchema.parse(req.body);
    if(body.hire_date&&body.termination_date&&body.termination_date<body.hire_date)
      return res.status(400).json({error:'Ungültiges Mitarbeiterprofil',fields:{termination_date:'Der Austritt darf nicht vor dem Eintritt liegen.'}});
    await withTransaction(async client=>{
      const current=(await client.query('SELECT id,name,email FROM employees WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,id])).rows[0];
      if(!current)throw Object.assign(new Error('Mitarbeiter nicht gefunden'),{status:404});
      if(body.user_id){
        const account=(await client.query('SELECT id FROM users WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,body.user_id])).rows[0];
        if(!account)throw Object.assign(new Error('Konto nicht im Mandanten gefunden'),{status:400});
      }
      const row=(await client.query(
        `UPDATE employees SET name=$1,email=$2,title=$3,employee_number=$4,first_name=$5,last_name=$6,
          phone=$7,mobile=$8,address=$9,date_of_birth=$10,hire_date=$11,termination_date=$12,
          employment_status=$13,employment_type=$14,department=$15,position=$16,work_location=$17,
          weekly_hours=$18,user_id=$19,updated_at=now()
         WHERE tenant_id=$20 AND id=$21 RETURNING *`,
        [body.name,body.email,body.title??null,body.employee_number??null,body.first_name??null,body.last_name??null,
         body.phone??null,body.mobile??null,body.address??null,body.date_of_birth??null,body.hire_date??null,body.termination_date??null,
         body.employment_status,body.employment_type,body.department??null,body.position??null,body.work_location??null,
         body.weekly_hours??null,body.user_id??null,req.user!.tenantId,id],
      )).rows[0];
      await client.query(
        `INSERT INTO employee_history(tenant_id,employee_id,event_type,actor_user_id,details)
         VALUES($1,$2,'profile.updated',$3,$4)`,
        [req.user!.tenantId,id,req.user!.id,{reason:body.reason}],
      );
      await recordAudit(req.user!.tenantId,req.user!.id,'employee.profile.updated','employee',id,{reason:body.reason},client);
      return row;
    });
    const updated=(await query('SELECT * FROM employees WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,id])).rows[0];
    res.json(updated);
  }catch(error){
    if(error instanceof z.ZodError)return res.status(400).json({error:'Ungültiges Mitarbeiterprofil',fields:validationFields(error)});
    const status=(error as Error&{status?:number}).status;
    if(status)return res.status(status).json({error:(error as Error).message});
    next(error);
  }
});

employeesRouter.post('/employees/:id/contracts',requireCsrf,requirePermission('employees:write'),async(req,res,next)=>{
  try{
    const employeeId=uuid.parse(String(req.params.id));
    const body=contractSchema.parse(req.body);
    if(body.ends_on&&body.ends_on<body.starts_on)return res.status(400).json({error:'Vertragsende muss am oder nach dem Vertragsbeginn liegen'});
    const employee=(await query('SELECT id FROM employees WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,employeeId])).rows[0];
    if(!employee)return res.status(404).json({error:'Mitarbeiter nicht gefunden'});
    const row=(await query(`INSERT INTO employee_contracts
      (tenant_id,employee_id,contract_number,contract_type,status,starts_on,ends_on,weekly_hours,probation_ends_on,notice_period_days,cost_center,notes)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [req.user!.tenantId,employeeId,body.contract_number??null,body.contract_type,body.status,body.starts_on,body.ends_on??null,
       body.weekly_hours??null,body.probation_ends_on??null,body.notice_period_days??null,body.cost_center??null,body.notes??null])).rows[0];
    await query('INSERT INTO employee_history(tenant_id,employee_id,event_type,actor_user_id,details) VALUES($1,$2,$3,$4,$5)',
      [req.user!.tenantId,employeeId,'contract.created',req.user!.id,{reason:body.reason,contract_id:row.id}]);
    await recordAudit(req.user!.tenantId,req.user!.id,'employee.contract.created','employee_contract',row.id,{reason:body.reason,employee_id:employeeId});
    res.status(201).json(row);
  }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Ungültiger Vertrag'});next(error);}
});

employeesRouter.post('/employees/:id/availability',requireCsrf,requirePermission('employees:write'),async(req,res,next)=>{
  try{
    const employeeId=uuid.parse(String(req.params.id));
    const body=availabilitySchema.parse(req.body);
    if(body.ends_time<=body.starts_time)return res.status(400).json({error:'Ende der Verfügbarkeit muss nach dem Beginn liegen'});
    const employee=(await query('SELECT id FROM employees WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,employeeId])).rows[0];
    if(!employee)return res.status(404).json({error:'Mitarbeiter nicht gefunden'});
    const row=(await query(`INSERT INTO employee_availability
      (tenant_id,employee_id,weekday,starts_time,ends_time,available,valid_from,valid_until,note)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.user!.tenantId,employeeId,body.weekday,body.starts_time,body.ends_time,body.available,
       body.valid_from??null,body.valid_until??null,body.note??null])).rows[0];
    await query('INSERT INTO employee_history(tenant_id,employee_id,event_type,actor_user_id,details) VALUES($1,$2,$3,$4,$5)',
      [req.user!.tenantId,employeeId,'availability.created',req.user!.id,{reason:body.reason,weekday:body.weekday}]);
    await recordAudit(req.user!.tenantId,req.user!.id,'employee.availability.created','employee_availability',row.id,{reason:body.reason,employee_id:employeeId});
    res.status(201).json(row);
  }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Ungültige Verfügbarkeit'});next(error);}
});

employeesRouter.post('/employees/:id/object-assignments',requireCsrf,requirePermission('employees:write',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const employeeId=uuid.parse(String(req.params.id));
    const body=objectAssignmentSchema.parse(req.body);
    if(body.ends_on&&body.ends_on<body.starts_on)return res.status(400).json({error:'Ende der Zuordnung muss am oder nach dem Beginn liegen'});
    const user=req.user!;
    const grants=normalizePermissionGrants(user.permissionGrants,user.permissions);
    const scope=effectivePermissionScope(grants,'employees:write',{role:user.role,isSystemAdmin:user.isSystemAdmin===true});
    if(!scope||!canAccessResource({userId:user.id,tenantId:user.tenantId,role:user.role,isSystemAdmin:user.isSystemAdmin===true,siteIds:user.siteIds??[],grants},scope,{tenantId:user.tenantId,siteId:body.site_id})){
      return res.status(403).json({error:'Kein Zugriff auf Objekt'});
    }
    if(scope==='site'&&body.primary_assignment)return res.status(403).json({error:'Die Hauptzuordnung erfordert Schreibzugriff auf Mitarbeitende im gesamten Mandanten'});
    const employee=(await query('SELECT id FROM employees WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,employeeId])).rows[0];
    const site=(await query('SELECT id FROM sites WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,body.site_id])).rows[0];
    if(!employee)return res.status(404).json({error:'Mitarbeiter nicht gefunden'});
    if(!site)return res.status(404).json({error:'Objekt nicht gefunden'});
    if(body.primary_assignment){
      await query(`UPDATE employee_object_assignments SET primary_assignment=false,updated_at=now()
                   WHERE tenant_id=$1 AND employee_id=$2 AND ends_on IS NULL`,
        [req.user!.tenantId,employeeId]);
    }
    const row=(await query(`INSERT INTO employee_object_assignments
      (tenant_id,employee_id,site_id,assignment_type,role,starts_on,ends_on,primary_assignment,notes)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.user!.tenantId,employeeId,body.site_id,body.assignment_type,body.role??null,body.starts_on,
       body.ends_on??null,body.primary_assignment,body.notes??null])).rows[0];
    await query('INSERT INTO employee_history(tenant_id,employee_id,event_type,actor_user_id,details) VALUES($1,$2,$3,$4,$5)',
      [req.user!.tenantId,employeeId,'object_assignment.created',req.user!.id,{reason:body.reason,site_id:body.site_id,assignment_type:body.assignment_type}]);
    await recordAudit(req.user!.tenantId,req.user!.id,'employee.object_assignment.created','employee_object_assignment',row.id,{reason:body.reason,employee_id:employeeId,site_id:body.site_id});
    res.status(201).json(row);
  }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Ungültige Objektzuordnung'});next(error);}
});

employeesRouter.patch('/employees/:id/object-assignments/:assignmentId',requireCsrf,requirePermission('employees:write',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const employeeId=uuid.parse(String(req.params.id));
    const assignmentId=uuid.parse(String(req.params.assignmentId));
    const body=z.object({ends_on:z.string().date(),reason:nonempty.max(500)}).strict().parse(req.body);
    const user=req.user!;
    const grants=normalizePermissionGrants(user.permissionGrants,user.permissions);
    const scope=effectivePermissionScope(grants,'employees:write',{role:user.role,isSystemAdmin:user.isSystemAdmin===true});
    if(!scope)return res.status(403).json({error:'Unzureichende Berechtigungen'});
    const assignment=(await query<{site_id:string;employee_id:string;starts_on:string}>(
      'SELECT site_id,employee_id,starts_on FROM employee_object_assignments WHERE tenant_id=$1 AND id=$2 AND employee_id=$3',
      [user.tenantId,assignmentId,employeeId],
    )).rows[0];
    if(!assignment)return res.status(404).json({error:'Objektzuordnung nicht gefunden'});
    if(body.ends_on<assignment.starts_on)return res.status(400).json({error:'Ende der Zuordnung muss am oder nach dem Beginn liegen'});
    if(!canAccessResource({userId:user.id,tenantId:user.tenantId,role:user.role,isSystemAdmin:user.isSystemAdmin===true,siteIds:user.siteIds??[],grants},scope,{tenantId:user.tenantId,siteId:assignment.site_id})){
      return res.status(403).json({error:'Kein Zugriff auf Objekt'});
    }
    const row=(await query(
      `UPDATE employee_object_assignments SET ends_on=$4,primary_assignment=false,updated_at=now()
       WHERE tenant_id=$1 AND id=$2 AND employee_id=$3 AND (ends_on IS NULL OR ends_on>=${berlinDate})
       RETURNING *`,
      [user.tenantId,assignmentId,employeeId,body.ends_on],
    )).rows[0];
    if(!row)return res.status(404).json({error:'Objektzuordnung nicht gefunden oder bereits beendet'});
    await query('INSERT INTO employee_history(tenant_id,employee_id,event_type,actor_user_id,details) VALUES($1,$2,$3,$4,$5)',
      [user.tenantId,employeeId,'object_assignment.ended',user.id,{reason:body.reason,assignment_id:assignmentId,site_id:assignment.site_id,ends_on:body.ends_on}]);
    await recordAudit(user.tenantId,user.id,'employee.object_assignment.ended','employee_object_assignment',assignmentId,{reason:body.reason,employee_id:employeeId,site_id:assignment.site_id,ends_on:body.ends_on});
    res.json(row);
  }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Ungültige Objektzuordnung'});next(error);}
});

employeesRouter.get('/employees/:id/absences',requirePermission('employees:read'),async(req,res,next)=>{
  try{
    const employeeId=uuid.parse(String(req.params.id));
    const employee=(await query('SELECT id FROM employees WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,employeeId])).rows[0];
    if(!employee)return res.status(404).json({error:'Mitarbeiter nicht gefunden'});
    const rows=(await query(
      `SELECT id,employee_id,starts_at,ends_at,absence_type,status,reason,document_id,created_by,created_at,updated_at
       FROM employee_absences
       WHERE tenant_id=$1 AND employee_id=$2
       ORDER BY starts_at DESC`,
      [req.user!.tenantId,employeeId],
    )).rows;
    res.json(rows);
  }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Ungültige Mitarbeiter-ID'});next(error);}
});

employeesRouter.post('/employees/:id/absences',requireCsrf,requirePermission('employees:write'),async(req,res,next)=>{
  try{
    const employeeId=uuid.parse(String(req.params.id));
    const body=absenceSchema.parse(req.body);
    if(new Date(body.ends_at)<=new Date(body.starts_at))return res.status(400).json({error:'Ende der Abwesenheit muss nach dem Beginn liegen'});
    const employee=(await query('SELECT id FROM employees WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,employeeId])).rows[0];
    if(!employee)return res.status(404).json({error:'Mitarbeiter nicht gefunden'});
    if(body.document_id){
      const document=(await query('SELECT id FROM dms_documents WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,body.document_id])).rows[0];
      if(!document)return res.status(404).json({error:'Dokument nicht gefunden'});
    }
    if(body.status==='approved'||body.status==='requested'){
      const overlap=(await query(
        `SELECT id FROM employee_absences
         WHERE tenant_id=$1 AND employee_id=$2 AND status IN ('requested','approved')
           AND starts_at<$4 AND $3<ends_at LIMIT 1`,
        [req.user!.tenantId,employeeId,body.starts_at,body.ends_at],
      )).rows[0];
      if(overlap)return res.status(409).json({error:'Abwesenheit überschneidet sich mit einer bestehenden Abwesenheit'});
    }
    const row=(await query(
      `INSERT INTO employee_absences
       (tenant_id,employee_id,starts_at,ends_at,absence_type,status,reason,document_id,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.user!.tenantId,employeeId,body.starts_at,body.ends_at,body.absence_type,body.status,
       body.reason??null,body.document_id??null,req.user!.id],
    )).rows[0];
    await query(
      `INSERT INTO employee_history(tenant_id,employee_id,event_type,actor_user_id,details)
       VALUES($1,$2,'absence.created',$3,$4)`,
      [req.user!.tenantId,employeeId,req.user!.id,{absence_id:row.id,absence_type:body.absence_type,status:body.status}],
    );
    await recordAudit(req.user!.tenantId,req.user!.id,'employee.absence.created','employee_absence',row.id,{
      reason:body.audit_reason,employee_id:employeeId,absence_type:body.absence_type,status:body.status,
    });
    res.status(201).json(row);
  }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Ungültige Abwesenheit'});next(error);}
});

employeesRouter.patch('/employees/:id/absences/:absenceId',requireCsrf,requirePermission('employees:write'),async(req,res,next)=>{
  try{
    const employeeId=uuid.parse(String(req.params.id));
    const absenceId=uuid.parse(String(req.params.absenceId));
    const body=absenceSchema.partial().extend({audit_reason:nonempty.max(500)}).strict().parse(req.body);
    const current=(await query(
      `SELECT * FROM employee_absences WHERE tenant_id=$1 AND employee_id=$2 AND id=$3`,
      [req.user!.tenantId,employeeId,absenceId],
    )).rows[0];
    if(!current)return res.status(404).json({error:'Abwesenheit nicht gefunden'});
    const startsAt=body.starts_at??current.starts_at;
    const endsAt=body.ends_at??current.ends_at;
    if(new Date(endsAt)<=new Date(startsAt))return res.status(400).json({error:'Ende der Abwesenheit muss nach dem Beginn liegen'});
    if(body.document_id){
      const document=(await query('SELECT id FROM dms_documents WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,body.document_id])).rows[0];
      if(!document)return res.status(404).json({error:'Dokument nicht gefunden'});
    }
    const row=(await query(
      `UPDATE employee_absences SET
         starts_at=$1,ends_at=$2,absence_type=$3,status=$4,reason=$5,document_id=$6,updated_at=now()
       WHERE tenant_id=$7 AND employee_id=$8 AND id=$9 RETURNING *`,
      [startsAt,endsAt,body.absence_type??current.absence_type,body.status??current.status,
       body.reason===undefined?current.reason:body.reason,body.document_id===undefined?current.document_id:body.document_id,
       req.user!.tenantId,employeeId,absenceId],
    )).rows[0];
    await query(
      `INSERT INTO employee_history(tenant_id,employee_id,event_type,actor_user_id,details)
       VALUES($1,$2,'absence.updated',$3,$4)`,
      [req.user!.tenantId,employeeId,req.user!.id,{absence_id:absenceId,status:row.status,absence_type:row.absence_type}],
    );
    await recordAudit(req.user!.tenantId,req.user!.id,'employee.absence.updated','employee_absence',absenceId,{
      reason:body.audit_reason,employee_id:employeeId,status:row.status,
    });
    res.json(row);
  }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Ungültige Abwesenheit'});next(error);}
});

employeesRouter.delete('/employees/:id/absences/:absenceId',requireCsrf,requirePermission('employees:write'),async(req,res,next)=>{
  try{
    const employeeId=uuid.parse(String(req.params.id));
    const absenceId=uuid.parse(String(req.params.absenceId));
    const body=z.object({audit_reason:nonempty.max(500)}).strict().parse(req.body);
    const row=(await query(
      `UPDATE employee_absences SET status='cancelled',updated_at=now()
       WHERE tenant_id=$1 AND employee_id=$2 AND id=$3 AND status<>'cancelled' RETURNING id`,
      [req.user!.tenantId,employeeId,absenceId],
    )).rows[0];
    if(!row)return res.status(404).json({error:'Abwesenheit nicht gefunden'});
    await query(
      `INSERT INTO employee_history(tenant_id,employee_id,event_type,actor_user_id,details)
       VALUES($1,$2,'absence.cancelled',$3,$4)`,
      [req.user!.tenantId,employeeId,req.user!.id,{absence_id:absenceId}],
    );
    await recordAudit(req.user!.tenantId,req.user!.id,'employee.absence.cancelled','employee_absence',absenceId,{
      reason:body.audit_reason,employee_id:employeeId,
    });
    res.status(204).send();
  }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Ungültiger Abbruch der Abwesenheit'});next(error);}
});
