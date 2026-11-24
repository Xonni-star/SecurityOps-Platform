import {Router} from 'express';
import {z} from 'zod';
import {query,withTransaction} from '../db/pool.js';
import {requireAuth,requireCsrf,requirePermission} from '../middleware/auth.js';
import {recordAudit} from '../services/audit.js';

const uuid=z.string().uuid();
const nonempty=z.string().trim().min(1);

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

employeesRouter.get('/employees/dashboard',requirePermission('employees:read'),async(req,res,next)=>{
  try{
    const tenant=req.user!.tenantId;
    const [employees,expiring,expired,shifts,absences,sick,assignments,contracts,missingQualifications,missingDocuments,withoutObject]=await Promise.all([
      query<{total:number;active:number;inactive:number;on_leave:number;sick:number;terminated:number}>(
        `SELECT COUNT(*)::int total,
          COUNT(*) FILTER(WHERE employment_status IN ('active','probation'))::int active,
          COUNT(*) FILTER(WHERE employment_status IN ('terminated','archived'))::int inactive,
          COUNT(*) FILTER(WHERE employment_status='leave')::int on_leave,
          COUNT(*) FILTER(WHERE employment_status='leave')::int sick,
          COUNT(*) FILTER(WHERE employment_status='terminated')::int terminated
         FROM employees WHERE tenant_id=$1`,[tenant]),
      query<{count:number}>(
        `SELECT COUNT(*)::int count FROM employee_qualifications
         WHERE tenant_id=$1 AND status='valid' AND valid_until IS NOT NULL
           AND valid_until BETWEEN CURRENT_DATE AND CURRENT_DATE+INTERVAL '90 days'`,[tenant]),
      query<{count:number}>(
        `SELECT COUNT(*)::int count FROM employee_qualifications
         WHERE tenant_id=$1 AND (status IN ('expired','revoked','invalid') OR valid_until<CURRENT_DATE)`,[tenant]),
      query<{count:number}>(
        `SELECT COUNT(DISTINCT a.employee_id)::int count FROM schedule_assignments a
         JOIN schedule_shifts s ON s.tenant_id=a.tenant_id AND s.id=a.shift_id
         WHERE a.tenant_id=$1 AND a.status='assigned' AND s.starts_at<=now() AND s.ends_at>=now()`,[tenant]),
      query<{count:number}>(
        `SELECT COUNT(*)::int count FROM employee_absences
         WHERE tenant_id=$1 AND starts_at<=now() AND ends_at>=now()`,[tenant]),
      query<{count:number}>(
        `SELECT COUNT(*)::int count FROM employee_absences
         WHERE tenant_id=$1 AND starts_at<=now() AND ends_at>=now() AND lower(COALESCE(reason,'')) LIKE '%krank%'`,[tenant]),
      query<{count:number}>(
        `SELECT COUNT(DISTINCT employee_id)::int count FROM employee_object_assignments
         WHERE tenant_id=$1 AND (ends_on IS NULL OR ends_on >= CURRENT_DATE)`,[tenant]),
      query<{count:number}>(
        `SELECT COUNT(*)::int count FROM employee_contracts
         WHERE tenant_id=$1 AND status='active'`,[tenant]),
      query<{count:number}>(
        `SELECT COUNT(*)::int count FROM qualification_catalog c
         JOIN employees e ON e.tenant_id=c.tenant_id
         WHERE c.tenant_id=$1 AND c.required=true AND c.active=true
           AND NOT EXISTS (
             SELECT 1 FROM employee_qualifications q
             WHERE q.tenant_id=c.tenant_id AND q.employee_id=e.id AND q.code=c.code
               AND q.status='valid' AND (q.valid_until IS NULL OR q.valid_until>=CURRENT_DATE)
           )`,[tenant]),
      query<{count:number}>(
        `SELECT COUNT(*)::int count FROM employees e
         WHERE e.tenant_id=$1 AND NOT EXISTS (
           SELECT 1 FROM dms_documents d
           WHERE d.tenant_id=e.tenant_id AND d.employee_id=e.id
         )`,[tenant]),
      query<{count:number}>(
        `SELECT COUNT(*)::int count FROM employees e
         WHERE e.tenant_id=$1 AND e.employment_status IN ('active','probation','leave')
           AND NOT EXISTS (
             SELECT 1 FROM employee_object_assignments oa
             WHERE oa.tenant_id=e.tenant_id AND oa.employee_id=e.id
               AND (oa.ends_on IS NULL OR oa.ends_on>=CURRENT_DATE)
           )`,[tenant]),
    ]);
    res.json({
      employees:employees.rows[0],
      qualifications_expiring_90_days:expiring.rows[0].count,
      qualifications_expired:expired.rows[0].count,
      upcoming_shift_assignments:shifts.rows[0].count,
      open_absences:absences.rows[0].count,
      sick_employees:sick.rows[0].count,
      active_object_assignments:assignments.rows[0].count,
      active_contracts:contracts.rows[0].count,
      missing_required_qualifications:missingQualifications.rows[0].count,
      missing_documents:missingDocuments.rows[0].count,
      employees_without_object:withoutObject.rows[0].count,
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
    if(!employee)return res.status(404).json({error:'Employee not found'});
    const [contracts,qualifications,absences,objectAssignments,workTime]=await Promise.all([
      query('SELECT * FROM employee_contracts WHERE tenant_id=$1 AND employee_id=$2 ORDER BY starts_on DESC',[req.user!.tenantId,id]),
      query(`SELECT q.*,c.name AS catalog_name,c.category
             FROM employee_qualifications q LEFT JOIN qualification_catalog c ON c.tenant_id=q.tenant_id AND c.code=q.code
             WHERE q.tenant_id=$1 AND q.employee_id=$2 ORDER BY q.valid_until NULLS LAST`,[req.user!.tenantId,id]),
      query('SELECT * FROM employee_absences WHERE tenant_id=$1 AND employee_id=$2 ORDER BY starts_at DESC',[req.user!.tenantId,id]),
      query(`SELECT oa.*,s.name AS site_name
             FROM employee_object_assignments oa JOIN sites s ON s.tenant_id=oa.tenant_id AND s.id=oa.site_id
             WHERE oa.tenant_id=$1 AND oa.employee_id=$2 ORDER BY oa.starts_on DESC,oa.primary_assignment DESC`,[req.user!.tenantId,id]),
      query(`SELECT id,provider,external_id,started_at,ended_at,minutes,status,created_at,updated_at
             FROM work_time_entries WHERE tenant_id=$1 AND employee_id=$2
             ORDER BY started_at DESC LIMIT 100`,[req.user!.tenantId,id]),
    ]);
    res.json({
      employee,
      contracts:contracts.rows,
      qualifications:qualifications.rows,
      absences:absences.rows,
      object_assignments:objectAssignments.rows,
      work_time:workTime.rows,
    });
  }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Invalid employee id'});next(error);}
});

employeesRouter.patch('/employees/:id/profile',requireCsrf,requirePermission('employees:write'),async(req,res,next)=>{
  try{
    const id=uuid.parse(String(req.params.id));
    const body=profileSchema.parse(req.body);
    await withTransaction(async client=>{
      const current=(await client.query('SELECT id,name,email FROM employees WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,id])).rows[0];
      if(!current)throw Object.assign(new Error('Employee not found'),{status:404});
      if(body.user_id){
        const account=(await client.query('SELECT id FROM users WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,body.user_id])).rows[0];
        if(!account)throw Object.assign(new Error('Account not found in tenant'),{status:400});
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
      await recordAudit(req.user!.tenantId,req.user!.id,'employee.profile.updated','employee',id,{reason:body.reason});
      return row;
    });
    const updated=(await query('SELECT * FROM employees WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,id])).rows[0];
    res.json(updated);
  }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Invalid employee profile'});next(error);}
});

employeesRouter.post('/employees/:id/contracts',requireCsrf,requirePermission('employees:write'),async(req,res,next)=>{
  try{
    const employeeId=uuid.parse(String(req.params.id));
    const body=contractSchema.parse(req.body);
    if(body.ends_on&&body.ends_on<body.starts_on)return res.status(400).json({error:'Contract end date must be on or after start date'});
    const employee=(await query('SELECT id FROM employees WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,employeeId])).rows[0];
    if(!employee)return res.status(404).json({error:'Employee not found'});
    const row=(await query(`INSERT INTO employee_contracts
      (tenant_id,employee_id,contract_number,contract_type,status,starts_on,ends_on,weekly_hours,probation_ends_on,notice_period_days,cost_center,notes)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [req.user!.tenantId,employeeId,body.contract_number??null,body.contract_type,body.status,body.starts_on,body.ends_on??null,
       body.weekly_hours??null,body.probation_ends_on??null,body.notice_period_days??null,body.cost_center??null,body.notes??null])).rows[0];
    await query('INSERT INTO employee_history(tenant_id,employee_id,event_type,actor_user_id,details) VALUES($1,$2,$3,$4,$5)',
      [req.user!.tenantId,employeeId,'contract.created',req.user!.id,{reason:body.reason,contract_id:row.id}]);
    await recordAudit(req.user!.tenantId,req.user!.id,'employee.contract.created','employee_contract',row.id,{reason:body.reason,employee_id:employeeId});
    res.status(201).json(row);
  }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Invalid contract'});next(error);}
});

employeesRouter.post('/employees/:id/availability',requireCsrf,requirePermission('employees:write'),async(req,res,next)=>{
  try{
    const employeeId=uuid.parse(String(req.params.id));
    const body=availabilitySchema.parse(req.body);
    if(body.ends_time<=body.starts_time)return res.status(400).json({error:'Availability end time must be after start time'});
    const employee=(await query('SELECT id FROM employees WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,employeeId])).rows[0];
    if(!employee)return res.status(404).json({error:'Employee not found'});
    const row=(await query(`INSERT INTO employee_availability
      (tenant_id,employee_id,weekday,starts_time,ends_time,available,valid_from,valid_until,note)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.user!.tenantId,employeeId,body.weekday,body.starts_time,body.ends_time,body.available,
       body.valid_from??null,body.valid_until??null,body.note??null])).rows[0];
    await query('INSERT INTO employee_history(tenant_id,employee_id,event_type,actor_user_id,details) VALUES($1,$2,$3,$4,$5)',
      [req.user!.tenantId,employeeId,'availability.created',req.user!.id,{reason:body.reason,weekday:body.weekday}]);
    await recordAudit(req.user!.tenantId,req.user!.id,'employee.availability.created','employee_availability',row.id,{reason:body.reason,employee_id:employeeId});
    res.status(201).json(row);
  }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Invalid availability'});next(error);}
});

employeesRouter.post('/employees/:id/object-assignments',requireCsrf,requirePermission('employees:write'),async(req,res,next)=>{
  try{
    const employeeId=uuid.parse(String(req.params.id));
    const body=objectAssignmentSchema.parse(req.body);
    if(body.ends_on&&body.ends_on<body.starts_on)return res.status(400).json({error:'Assignment end date must be on or after start date'});
    const employee=(await query('SELECT id FROM employees WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,employeeId])).rows[0];
    const site=(await query('SELECT id FROM sites WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,body.site_id])).rows[0];
    if(!employee)return res.status(404).json({error:'Employee not found'});
    if(!site)return res.status(404).json({error:'Site not found'});
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
  }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Invalid object assignment'});next(error);}
});

employeesRouter.get('/employees/:id/absences',requirePermission('employees:read'),async(req,res,next)=>{
  try{
    const employeeId=uuid.parse(String(req.params.id));
    const employee=(await query('SELECT id FROM employees WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,employeeId])).rows[0];
    if(!employee)return res.status(404).json({error:'Employee not found'});
    const rows=(await query(
      `SELECT id,employee_id,starts_at,ends_at,absence_type,status,reason,document_id,created_by,created_at,updated_at
       FROM employee_absences
       WHERE tenant_id=$1 AND employee_id=$2
       ORDER BY starts_at DESC`,
      [req.user!.tenantId,employeeId],
    )).rows;
    res.json(rows);
  }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Invalid employee id'});next(error);}
});

employeesRouter.post('/employees/:id/absences',requireCsrf,requirePermission('employees:write'),async(req,res,next)=>{
  try{
    const employeeId=uuid.parse(String(req.params.id));
    const body=absenceSchema.parse(req.body);
    if(new Date(body.ends_at)<=new Date(body.starts_at))return res.status(400).json({error:'Absence end time must be after start time'});
    const employee=(await query('SELECT id FROM employees WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,employeeId])).rows[0];
    if(!employee)return res.status(404).json({error:'Employee not found'});
    if(body.document_id){
      const document=(await query('SELECT id FROM dms_documents WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,body.document_id])).rows[0];
      if(!document)return res.status(404).json({error:'Document not found'});
    }
    if(body.status==='approved'||body.status==='requested'){
      const overlap=(await query(
        `SELECT id FROM employee_absences
         WHERE tenant_id=$1 AND employee_id=$2 AND status IN ('requested','approved')
           AND starts_at<$4 AND $3<ends_at LIMIT 1`,
        [req.user!.tenantId,employeeId,body.starts_at,body.ends_at],
      )).rows[0];
      if(overlap)return res.status(409).json({error:'Absence overlaps an existing absence'});
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
  }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Invalid absence'});next(error);}
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
    if(!current)return res.status(404).json({error:'Absence not found'});
    const startsAt=body.starts_at??current.starts_at;
    const endsAt=body.ends_at??current.ends_at;
    if(new Date(endsAt)<=new Date(startsAt))return res.status(400).json({error:'Absence end time must be after start time'});
    if(body.document_id){
      const document=(await query('SELECT id FROM dms_documents WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,body.document_id])).rows[0];
      if(!document)return res.status(404).json({error:'Document not found'});
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
  }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Invalid absence'});next(error);}
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
    if(!row)return res.status(404).json({error:'Absence not found'});
    await query(
      `INSERT INTO employee_history(tenant_id,employee_id,event_type,actor_user_id,details)
       VALUES($1,$2,'absence.cancelled',$3,$4)`,
      [req.user!.tenantId,employeeId,req.user!.id,{absence_id:absenceId}],
    );
    await recordAudit(req.user!.tenantId,req.user!.id,'employee.absence.cancelled','employee_absence',absenceId,{
      reason:body.audit_reason,employee_id:employeeId,
    });
    res.status(204).send();
  }catch(error){if(error instanceof z.ZodError)return res.status(400).json({error:'Invalid absence cancellation'});next(error);}
});
