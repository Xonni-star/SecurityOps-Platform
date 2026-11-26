import {Router,Request} from 'express';
import {z} from 'zod';
import {query,withTransaction} from '../db/pool.js';
import {requireAuth,requireCsrf,requirePermission} from '../middleware/auth.js';
import {runIdempotentMutation} from '../services/offline-sync.js';
import {canAccessResource,effectivePermissionScope,normalizePermissionGrants} from '../types/authorization.js';
import {detectShiftConflicts} from '../services/scheduling.js';

const uuid=z.string().uuid();
const isoDateTime=z.string().datetime({offset:true});
const windowInput=z.object({starts_at:isoDateTime,ends_at:isoDateTime}).refine(value=>new Date(value.ends_at)>new Date(value.starts_at),'ends_at muss nach starts_at liegen');
const parameters=z.record(z.string(),z.unknown());
const mutation=z.string().uuid();
const permission=(req:Request,code:string,siteId:string)=>{
  const user=req.user!;
  const scope=effectivePermissionScope(normalizePermissionGrants(user.permissionGrants,user.permissions),code,{role:user.role,isSystemAdmin:user.isSystemAdmin===true});
  if(!scope||!canAccessResource({userId:user.id,tenantId:user.tenantId,role:user.role,isSystemAdmin:user.isSystemAdmin===true,siteIds:user.siteIds??[],grants:normalizePermissionGrants(user.permissionGrants,user.permissions)},scope,{tenantId:user.tenantId,siteId})) {
    throw Object.assign(new Error('Kein Zugriff auf Objekt'),{status:403});
  }
};
const ensureSession=(req:Request)=>{
  if(!req.sessionDbId)throw Object.assign(new Error('Session-Identität fehlt.'),{status:401});
  return req.sessionDbId;
};
const addConflicts=async(client:import('pg').PoolClient,tenantId:string,periodId:string,shiftId:string|undefined,assignmentId:string|undefined,conflicts:{conflict_type:string;severity:string;details:Record<string,unknown>}[])=>{
  for(const conflict of conflicts)await client.query(
    `INSERT INTO schedule_conflicts(tenant_id,period_id,shift_id,assignment_id,conflict_type,severity,details)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,[tenantId,periodId,shiftId??null,assignmentId??null,conflict.conflict_type,conflict.severity,conflict.details],
  );
};

export const schedulingRouter=Router();
schedulingRouter.use((req,res,next)=>/^\/scheduling/.test(req.path)
  ?requireAuth(req,res,()=>['POST','PATCH','PUT','DELETE'].includes(req.method)?requireCsrf(req,res,next):next())
  :next());

schedulingRouter.get('/scheduling/rule-profiles',requirePermission('scheduling:read',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{res.json((await query(`SELECT id,name,version,parameters,created_by,created_at FROM schedule_rule_profiles WHERE tenant_id=$1 ORDER BY name,version DESC`,[req.user!.tenantId])).rows);}
  catch(error){next(error);}
});
schedulingRouter.post('/scheduling/rule-profiles',requirePermission('scheduling:rules:write'),async(req,res,next)=>{
  try{
    const body=z.object({name:z.string().trim().min(1).max(120),version:z.number().int().positive(),parameters,client_mutation_id:mutation.optional()}).strict().parse(req.body);
    const sessionId=ensureSession(req);
    const mutationId=mutation.parse(req.get('Idempotency-Key')??body.client_mutation_id);
    const result=await withTransaction(client=>runIdempotentMutation(client,{tenantId:req.user!.tenantId,userId:req.user!.id,mutationId,action:'scheduling.rule_profile',payload:{...body,client_mutation_id:mutationId}},async tx=>{
      const row=(await tx.query(`INSERT INTO schedule_rule_profiles(tenant_id,name,version,parameters,created_by,created_session_id)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,version,parameters,created_at`,[req.user!.tenantId,body.name,body.version,body.parameters,req.user!.id,sessionId])).rows[0];
      await tx.query('INSERT INTO audit_events(tenant_id,actor_user_id,event_type,entity_type,entity_id,details) VALUES($1,$2,$3,$4,$5,$6)',[req.user!.tenantId,req.user!.id,'scheduling.rule_profile.created','schedule_rule_profile',row.id,{version:body.version}]);
      return row;
    }));
    res.status(result.replayed?200:201).json(result.response);
  }catch(error){next(error);}
});

schedulingRouter.get('/scheduling/periods',requirePermission('scheduling:read',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const readScope=effectivePermissionScope(normalizePermissionGrants(req.user!.permissionGrants,req.user!.permissions),'scheduling:read',{role:req.user!.role,isSystemAdmin:req.user!.isSystemAdmin===true});
    const siteFilter=readScope==='site'?' AND p.site_id = ANY($2::uuid[])':'';
    const values=siteFilter?[req.user!.tenantId,req.user!.siteIds??[]]:[req.user!.tenantId];
    const rows=(await query(`SELECT p.*,s.name site_name,r.name rule_profile_name,r.version rule_profile_version
      FROM schedule_periods p JOIN sites s ON s.tenant_id=p.tenant_id AND s.id=p.site_id
      JOIN schedule_rule_profiles r ON r.tenant_id=p.tenant_id AND r.id=p.rule_profile_id
      WHERE p.tenant_id=$1${siteFilter} ORDER BY p.starts_at DESC`,values)).rows;
    res.json(rows);
  }catch(error){next(error);}
});
schedulingRouter.get('/scheduling/periods/:id',requirePermission('scheduling:read',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const period=(await query(`SELECT p.*,r.name rule_profile_name,r.version rule_profile_version,r.parameters
      FROM schedule_periods p JOIN schedule_rule_profiles r ON r.tenant_id=p.tenant_id AND r.id=p.rule_profile_id
      WHERE p.tenant_id=$1 AND p.id=$2`,[req.user!.tenantId,req.params.id])).rows[0];
    if(!period)return res.status(404).json({error:'Dienstplanzeitraum nicht gefunden'});
    permission(req,'scheduling:read',period.site_id);
    const shifts=(await query(`SELECT sh.*,COALESCE(json_agg(json_build_object('id',a.id,'employee_id',a.employee_id,'status',a.status)) FILTER (WHERE a.id IS NOT NULL),'[]') assignments
      FROM schedule_shifts sh LEFT JOIN schedule_assignments a ON a.tenant_id=sh.tenant_id AND a.shift_id=sh.id
      WHERE sh.tenant_id=$1 AND sh.period_id=$2 GROUP BY sh.id ORDER BY sh.starts_at`,[req.user!.tenantId,req.params.id])).rows;
    const conflicts=(await query(`SELECT * FROM schedule_conflicts WHERE tenant_id=$1 AND period_id=$2 ORDER BY detected_at DESC`,[req.user!.tenantId,req.params.id])).rows;
    res.json({...period,shifts,conflicts});
  }catch(error){next(error);}
});
schedulingRouter.post('/scheduling/periods',requirePermission('scheduling:write',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const body=z.object({site_id:uuid,rule_profile_id:uuid,name:z.string().trim().min(1).max(160),...windowInput.shape,status:z.enum(['draft','published','closed']).optional(),client_mutation_id:mutation}).strict().parse(req.body);
    permission(req,'scheduling:write',body.site_id);
    const sessionId=ensureSession(req);
    const result=await withTransaction(client=>runIdempotentMutation(client,{tenantId:req.user!.tenantId,userId:req.user!.id,mutationId:body.client_mutation_id,action:'scheduling.period',payload:req.body},async tx=>{
      const row=(await tx.query(`INSERT INTO schedule_periods(tenant_id,site_id,rule_profile_id,name,starts_at,ends_at,status,created_by,created_session_id,client_mutation_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[req.user!.tenantId,body.site_id,body.rule_profile_id,body.name,body.starts_at,body.ends_at,body.status??'draft',req.user!.id,sessionId,body.client_mutation_id])).rows[0];
      await tx.query('INSERT INTO audit_events(tenant_id,actor_user_id,event_type,entity_type,entity_id,details) VALUES($1,$2,$3,$4,$5,$6)',[req.user!.tenantId,req.user!.id,'scheduling.period.created','schedule_period',row.id,{}]);
      return row;
    }));
    res.status(result.replayed?200:201).json(result.response);
  }catch(error){next(error);}
});

schedulingRouter.post('/scheduling/periods/:periodId/shifts',requirePermission('scheduling:write',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const body=z.object({site_id:uuid,role_code:z.string().trim().min(1).max(80),...windowInput.shape,required_qualification_codes:z.array(z.string().trim().min(1).max(80)).max(32).optional(),notes:z.string().max(2000).nullable().optional(),client_mutation_id:mutation}).strict().parse(req.body);
    permission(req,'scheduling:write',body.site_id);
    const sessionId=ensureSession(req);
    const result=await withTransaction(client=>runIdempotentMutation(client,{tenantId:req.user!.tenantId,userId:req.user!.id,mutationId:body.client_mutation_id,action:'scheduling.shift',payload:req.body},async tx=>{
      const period=(await tx.query('SELECT id,site_id,rule_profile_id FROM schedule_periods WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,req.params.periodId])).rows[0];
      if(!period)throw Object.assign(new Error('Dienstplanzeitraum nicht gefunden'),{status:404});
      if(period.site_id!==body.site_id)throw Object.assign(new Error('Objekt der Schicht muss dem Objekt des Zeitraums entsprechen'),{status:400});
      const profile=(await tx.query('SELECT parameters FROM schedule_rule_profiles WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,period.rule_profile_id])).rows[0];
      const row=(await tx.query(`INSERT INTO schedule_shifts(tenant_id,period_id,site_id,role_code,starts_at,ends_at,required_qualification_codes,notes,created_by,created_session_id,client_mutation_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,[req.user!.tenantId,period.id,body.site_id,body.role_code,body.starts_at,body.ends_at,JSON.stringify(body.required_qualification_codes??[]),body.notes??null,req.user!.id,sessionId,body.client_mutation_id])).rows[0];
      const other=(await tx.query('SELECT starts_at,ends_at FROM schedule_shifts WHERE tenant_id=$1 AND period_id=$2 AND id<>$3',[req.user!.tenantId,period.id,row.id])).rows;
      const conflicts=detectShiftConflicts({startsAt:body.starts_at,endsAt:body.ends_at,requiredQualificationCodes:body.required_qualification_codes},other,[],[],profile?.parameters??{});
      await addConflicts(tx,req.user!.tenantId,period.id,row.id,undefined,conflicts);
      await tx.query('INSERT INTO audit_events(tenant_id,actor_user_id,event_type,entity_type,entity_id,details) VALUES($1,$2,$3,$4,$5,$6)',[req.user!.tenantId,req.user!.id,'scheduling.shift.created','schedule_shift',row.id,{conflict_count:conflicts.length}]);
      return {...row,conflicts};
    }));
    res.status(result.replayed?200:201).json(result.response);
  }catch(error){next(error);}
});

schedulingRouter.post('/scheduling/shifts/:shiftId/assignments',requirePermission('scheduling:write',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const body=z.object({employee_id:uuid,client_mutation_id:mutation}).strict().parse(req.body);
    const sessionId=ensureSession(req);
    const result=await withTransaction(client=>runIdempotentMutation(client,{tenantId:req.user!.tenantId,userId:req.user!.id,mutationId:body.client_mutation_id,action:'scheduling.assignment',payload:req.body},async tx=>{
      const shift=(await tx.query('SELECT sh.*,p.id period_id,p.rule_profile_id,p.site_id FROM schedule_shifts sh JOIN schedule_periods p ON p.tenant_id=sh.tenant_id AND p.id=sh.period_id WHERE sh.tenant_id=$1 AND sh.id=$2',[req.user!.tenantId,req.params.shiftId])).rows[0];
      if(!shift)throw Object.assign(new Error('Dienstplanschicht nicht gefunden'),{status:404});
      permission(req,'scheduling:write',shift.site_id);
      const employee=(await tx.query('SELECT id FROM employees WHERE tenant_id=$1 AND id=$2',[req.user!.tenantId,body.employee_id])).rows[0];
      if(!employee)throw Object.assign(new Error('Mitarbeiter nicht gefunden'),{status:404});
      const absence=(await tx.query(
        `SELECT id FROM employee_absences WHERE tenant_id=$1 AND employee_id=$2
         AND starts_at < $4 AND $3 < ends_at LIMIT 1`,
        [req.user!.tenantId,body.employee_id,shift.starts_at,shift.ends_at],
      )).rows[0];
      if(absence)throw Object.assign(new Error('Mitarbeiter ist während dieser Schicht abwesend'),{status:409});
      const overlapping=(await tx.query(
        `SELECT a.id FROM schedule_assignments a JOIN schedule_shifts s
         ON s.tenant_id=a.tenant_id AND s.id=a.shift_id
         WHERE a.tenant_id=$1 AND a.employee_id=$2 AND a.status='assigned'
           AND s.starts_at < $4 AND $3 < s.ends_at LIMIT 1`,
        [req.user!.tenantId,body.employee_id,shift.starts_at,shift.ends_at],
      )).rows[0];
      if(overlapping)throw Object.assign(new Error('Mitarbeiter ist bereits einer überschneidenden Schicht zugeordnet'),{status:409});
      const row=(await tx.query(`INSERT INTO schedule_assignments(tenant_id,shift_id,employee_id,created_by,created_session_id,client_mutation_id)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[req.user!.tenantId,shift.id,body.employee_id,req.user!.id,sessionId,body.client_mutation_id])).rows[0];
      const qualificationRows=(await tx.query<{code:string;valid_from:string|null;valid_until:string|null;status:string}>(
        'SELECT code,valid_from,valid_until,status FROM employee_qualifications WHERE tenant_id=$1 AND employee_id=$2',[req.user!.tenantId,body.employee_id],
      )).rows;
      const shiftStart=new Date(shift.starts_at).getTime();const shiftEnd=new Date(shift.ends_at).getTime();
      const quals=qualificationRows.filter(item=>item.status==='valid'
        &&(!item.valid_from||new Date(`${item.valid_from}T00:00:00Z`).getTime()<=shiftStart)
        &&(!item.valid_until||new Date(`${item.valid_until}T23:59:59.999Z`).getTime()>=shiftEnd)).map(item=>item.code);
      const absences=(await tx.query('SELECT starts_at,ends_at FROM employee_absences WHERE tenant_id=$1 AND employee_id=$2',[req.user!.tenantId,body.employee_id])).rows;
      const existing=(await tx.query(`SELECT sh.starts_at,sh.ends_at FROM schedule_assignments a JOIN schedule_shifts sh ON sh.tenant_id=a.tenant_id AND sh.id=a.shift_id
        WHERE a.tenant_id=$1 AND a.employee_id=$2 AND a.id<>$3 AND a.status='assigned'`,[req.user!.tenantId,body.employee_id,row.id])).rows;
      const profile=(await tx.query('SELECT r.parameters FROM schedule_rule_profiles r JOIN schedule_periods p ON p.tenant_id=r.tenant_id AND p.rule_profile_id=r.id WHERE p.tenant_id=$1 AND p.id=$2',[req.user!.tenantId,shift.period_id])).rows[0];
      const conflicts=detectShiftConflicts({startsAt:shift.starts_at,endsAt:shift.ends_at,requiredQualificationCodes:shift.required_qualification_codes??[]},existing,quals,absences,profile?.parameters??{});
      await addConflicts(tx,req.user!.tenantId,shift.period_id,shift.id,row.id,conflicts);
      await tx.query('INSERT INTO audit_events(tenant_id,actor_user_id,event_type,entity_type,entity_id,details) VALUES($1,$2,$3,$4,$5,$6)',[req.user!.tenantId,req.user!.id,'scheduling.assignment.created','schedule_assignment',row.id,{conflict_count:conflicts.length}]);
      return {...row,conflicts};
    }));
    res.status(result.replayed?200:201).json(result.response);
  }catch(error){next(error);}
});

schedulingRouter.get('/scheduling/conflicts',requirePermission('scheduling:read',{allowedScopes:['tenant','site','system']}),async(req,res,next)=>{
  try{
    const readScope=effectivePermissionScope(normalizePermissionGrants(req.user!.permissionGrants,req.user!.permissions),'scheduling:read',{role:req.user!.role,isSystemAdmin:req.user!.isSystemAdmin===true});
    const siteFilter=readScope==='site'?' AND p.site_id = ANY($2::uuid[])':'';
    const values=siteFilter?[req.user!.tenantId,req.user!.siteIds??[]]:[req.user!.tenantId];
    const rows=(await query(`SELECT c.*,p.name period_name,sh.role_code,e.name employee_name
      FROM schedule_conflicts c JOIN schedule_periods p ON p.tenant_id=c.tenant_id AND p.id=c.period_id
      LEFT JOIN schedule_shifts sh ON sh.tenant_id=c.tenant_id AND sh.id=c.shift_id
      LEFT JOIN schedule_assignments a ON a.tenant_id=c.tenant_id AND a.id=c.assignment_id
      LEFT JOIN employees e ON e.tenant_id=a.tenant_id AND e.id=a.employee_id
      WHERE c.tenant_id=$1 AND c.resolved_at IS NULL${siteFilter} ORDER BY c.detected_at DESC`,values)).rows;
    res.json(rows);
  }catch(error){next(error);}
});
