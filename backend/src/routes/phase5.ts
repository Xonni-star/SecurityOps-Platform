import {Router,Request} from 'express';
import {promises as fs} from 'node:fs';
import {z} from 'zod';
import {query} from '../db/pool.js';
import {requireAuth,requireCsrf,requirePermission} from '../middleware/auth.js';
import {createTimeScanAdapter} from '../services/timescan.js';
import {env} from '../config/env.js';
import {checkSmsStatus,checkSmtpStatus,checkTimeScanStatus} from '../services/provider-status.js';
import {resolveSecret} from '../services/secrets.js';
import {pdfReportLines} from '../services/pdf.js';
import {recordAudit} from '../services/audit.js';
import {
  REPORTING_MODULES,parseReportingFilters,reportingDayRange,reportingFilterResponse,reportingModule,reportingQuery,reportingSiteScope,
  reportCsv,reportHeaders,reportPdfLines,safeReportFilename,
  type ReportingRow,
} from '../services/reporting-domain.js';
import {xlsxWorkbook} from '../services/xlsx.js';

const uuid=z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const nonempty=z.string().trim().min(1);
/** Einheitlicher Berliner Kalendertag für alle Gültigkeitsvergleiche. */
const berlinDate=`(now() AT TIME ZONE 'Europe/Berlin')::date`;
export const phase5Router=Router();
phase5Router.use((req,res,next)=>/^\/(reports|admin|timescan|audit|privacy|retention|backups)/.test(req.path)
  ? requireAuth(req,res,()=>['POST','PATCH','PUT','DELETE'].includes(req.method)?requireCsrf(req,res,next):next())
  : next());

async function audit(req:Request,eventType:string,entityType?:string,entityId?:string,details:Record<string,unknown>={}){
  await recordAudit(req.user!.tenantId,req.user!.id,eventType,entityType,entityId,details);
}

function range(req:Request){
  const {from,to}=reportingDayRange(req.query as Record<string,unknown>);
  return {from,to};
}

async function reportRows(kind:string,tenantId:string,from:Date,to:Date,siteId?:string,employeeId?:string){
  const scope=`tenant_id=$1 AND created_at BETWEEN $2 AND $3`;
  switch(kind){
    case 'employees':return (await query(`SELECT id,employee_number,name,email,title,department,position,employment_status,employment_type,hire_date,termination_date,weekly_hours,created_at FROM employees WHERE tenant_id=$1 AND created_at BETWEEN $2 AND $3 ORDER BY name`,[tenantId,from,to])).rows;
    case 'sites':return (await query(`SELECT id,name,address,created_at FROM sites WHERE ${scope} ORDER BY name`,[tenantId,from,to])).rows;
    case 'patrols':return (await query(`SELECT ps.id,ps.route_id,r.name route_name,ps.control_point_id,cp.name control_point_name,ps.employee_id,e.name employee_name,ps.scanned_at,ps.deviation
      FROM patrol_scans ps
      JOIN patrol_routes r ON r.tenant_id=ps.tenant_id AND r.id=ps.route_id
      JOIN control_points cp ON cp.tenant_id=ps.tenant_id AND cp.id=ps.control_point_id
      JOIN employees e ON e.tenant_id=ps.tenant_id AND e.id=ps.employee_id
      WHERE ps.tenant_id=$1 AND ps.scanned_at BETWEEN $2 AND $3
      AND ($4::uuid IS NULL OR r.site_id=$4) AND ($5::uuid IS NULL OR ps.employee_id=$5) ORDER BY ps.scanned_at DESC`,[tenantId,from,to,siteId??null,employeeId??null])).rows;
    case 'alarms':return (await query(`SELECT a.id,a.type,a.status,a.source,a.description,a.triggered_at,a.acknowledged_at,a.resolved_at,p.code priority,s.name site_name,e.name employee_name
      FROM alarms a
      LEFT JOIN alarm_priorities p ON p.tenant_id=a.tenant_id AND p.id=a.priority_id
      LEFT JOIN sites s ON s.tenant_id=a.tenant_id AND s.id=a.site_id
      LEFT JOIN employees e ON e.tenant_id=a.tenant_id AND e.id=a.employee_id
      WHERE a.tenant_id=$1 AND a.triggered_at BETWEEN $2 AND $3 AND ($4::uuid IS NULL OR a.site_id=$4) AND ($5::uuid IS NULL OR a.employee_id=$5)
      ORDER BY a.triggered_at DESC`,[tenantId,from,to,siteId??null,employeeId??null])).rows;
    case 'incidents':return (await query(`SELECT i.id,i.description,i.status,i.created_at,i.updated_at,p.code priority,s.name site_name,e.name employee_name
      FROM incidents i
      LEFT JOIN alarm_priorities p ON p.tenant_id=i.tenant_id AND p.id=i.priority_id
      LEFT JOIN sites s ON s.tenant_id=i.tenant_id AND s.id=i.site_id
      LEFT JOIN employees e ON e.tenant_id=i.tenant_id AND e.id=i.employee_id
      WHERE i.tenant_id=$1 AND i.created_at BETWEEN $2 AND $3 AND ($4::uuid IS NULL OR i.site_id=$4) AND ($5::uuid IS NULL OR i.employee_id=$5)
      ORDER BY i.created_at DESC`,[tenantId,from,to,siteId??null,employeeId??null])).rows;
    case 'work-time':return (await query(`SELECT w.id,w.external_id,w.started_at,w.ended_at,w.minutes,w.status,e.name employee_name
      FROM work_time_entries w LEFT JOIN employees e ON e.tenant_id=w.tenant_id AND e.id=w.employee_id WHERE w.tenant_id=$1 AND w.started_at BETWEEN $2 AND $3
      AND ($4::uuid IS NULL OR w.employee_id=$4) ORDER BY w.started_at DESC`,[tenantId,from,to,employeeId??null])).rows;
    default:throw Object.assign(new Error('Unbekannter Bericht'),{status:400});
  }
}

function csv(rows:Record<string,unknown>[]){
  const headers=rows.length?Object.keys(rows[0]):['result'];
  return [headers.join(','),...rows.map(row=>headers.map(key=>`"${String(row[key]??'').replaceAll('"','""')}"`).join(','))].join('\n');
}

phase5Router.get('/reports/statistics',requirePermission('reports:read'),async(req,res,next)=>{
  try{
    const {from,to}=range(req);const tenant=req.user!.tenantId;
    const [alarms,incidents,patrols,work,employees,qualifications,absences]=await Promise.all([
      query(`SELECT COUNT(*)::integer total,COUNT(*) FILTER(WHERE status='resolved')::integer resolved,COUNT(*) FILTER(WHERE status IN('open','escalated'))::integer open FROM alarms WHERE tenant_id=$1 AND triggered_at BETWEEN $2 AND $3`,[tenant,from,to]),
      query(`SELECT COUNT(*)::integer total,COUNT(*) FILTER(WHERE status='completed')::integer completed FROM incidents WHERE tenant_id=$1 AND created_at BETWEEN $2 AND $3`,[tenant,from,to]),
      query(`SELECT COUNT(*)::integer total,COUNT(*) FILTER(WHERE deviation<>'none')::integer deviations FROM patrol_scans WHERE tenant_id=$1 AND scanned_at BETWEEN $2 AND $3`,[tenant,from,to]),
      query(`SELECT COALESCE(SUM(minutes),0)::integer minutes,COUNT(*)::integer entries FROM work_time_entries WHERE tenant_id=$1 AND started_at BETWEEN $2 AND $3`,[tenant,from,to]),
      query(`SELECT COUNT(*)::integer total,COUNT(*) FILTER(WHERE employment_status IN ('active','probation'))::integer active,COUNT(*) FILTER(WHERE employment_status IN ('terminated','archived'))::integer inactive FROM employees WHERE tenant_id=$1`,[tenant]),
      query(`SELECT COUNT(*)::integer total,
        COUNT(*) FILTER(WHERE q.status IN ('expired','revoked','invalid') OR q.revoked_at IS NOT NULL
          OR (q.valid_until IS NOT NULL AND q.valid_until<${berlinDate})
          OR (q.valid_from IS NOT NULL AND q.valid_from>${berlinDate}))::integer expired,
        COUNT(*) FILTER(WHERE q.status='valid' AND q.revoked_at IS NULL
          AND (q.valid_from IS NULL OR q.valid_from<=${berlinDate})
          AND q.valid_until IS NOT NULL
          AND q.valid_until BETWEEN ${berlinDate} AND ${berlinDate}+INTERVAL '90 days'
          AND (NOT (c.required_document_type IS NOT NULL OR COALESCE(jsonb_array_length(c.required_documents),0)>0)
            OR (d.document_status='active' AND d.approval_status='approved' AND dv.lifecycle_state='available'
              AND (d.valid_from IS NULL OR d.valid_from<=${berlinDate})
              AND (d.valid_until IS NULL OR d.valid_until>=${berlinDate}))))::integer expiring,
        COUNT(*) FILTER(WHERE q.status IN ('revoked','invalid') OR q.revoked_at IS NOT NULL)::integer invalid_revoked,
        COUNT(*) FILTER(WHERE (c.required_document_type IS NOT NULL OR COALESCE(jsonb_array_length(c.required_documents),0)>0)
          AND (q.document_id IS NULL OR d.document_status<>'active' OR d.approval_status IS DISTINCT FROM 'approved'
            OR dv.lifecycle_state IS DISTINCT FROM 'available'
            OR (d.valid_until IS NOT NULL AND d.valid_until<${berlinDate})
            OR (d.valid_from IS NOT NULL AND d.valid_from>${berlinDate})))::integer evidence_problems
        FROM employee_qualifications q
        LEFT JOIN qualification_catalog c ON c.tenant_id=q.tenant_id
          AND (c.id=q.catalog_id OR (q.catalog_id IS NULL AND c.code=q.code))
        LEFT JOIN dms_documents d ON d.tenant_id=q.tenant_id AND d.id=q.document_id
        LEFT JOIN LATERAL (
          SELECT v.lifecycle_state FROM dms_versions v
          WHERE v.tenant_id=d.tenant_id AND v.document_id=d.id AND v.lifecycle_state='available'
          ORDER BY v.version_no DESC LIMIT 1
        ) dv ON TRUE
        WHERE q.tenant_id=$1`,[tenant]),
      query(`SELECT COUNT(*)::integer total,COUNT(*) FILTER(WHERE starts_at<=now() AND ends_at>=now())::integer current FROM employee_absences WHERE tenant_id=$1 AND status IN ('requested','approved')`,[tenant]),
    ]);
    res.json({from,to,alarms:alarms.rows[0],incidents:incidents.rows[0],patrols:patrols.rows[0],work_time:work.rows[0],employees:employees.rows[0],qualifications:qualifications.rows[0],absences:absences.rows[0]});
  }catch(error){next(error);}
});

phase5Router.get('/admin/provider-status',requirePermission('providers:read'),async(req,res,next)=>{
  try{
    const connection=(await query<{base_url:string;account_ref:string;secret_ref:string;enabled:boolean}>(
      'SELECT base_url,account_ref,secret_ref,enabled FROM timescan_connections WHERE tenant_id=$1',[req.user!.tenantId],
    )).rows[0];
    const providers=await Promise.all([checkSmtpStatus(),checkSmsStatus(),checkTimeScanStatus(connection)]);
    res.json({providers});
  }catch(error){next(error);}
});

// Reporting-Zentrum: ein zentraler Filter- und Exportvertrag für alle
// Fachmodule A–M. Die Routen liegen vor /reports/:kind, damit sie nicht als
// unbekannter Report-Kind-Wert interpretiert werden.
const reportingPermission=requirePermission('reports:read',{allowedScopes:['tenant','site','system']});

phase5Router.get('/reports/center/modules',reportingPermission,async(_req,res)=>{
  res.json({modules:REPORTING_MODULES,timezone:'Europe/Berlin'});
});

phase5Router.get('/reports/center/overview',reportingPermission,async(req,res,next)=>{
  try{
    const filters=parseReportingFilters(req.query as Record<string,unknown>);
    const siteScope=reportingSiteScope(req.user!);
    const modules=await Promise.all(REPORTING_MODULES.map(async module=>{
      const {text,values}=reportingQuery(module.slug,req.user!.tenantId,filters,siteScope,1);
      const result=await query<{total:number}>(text,values);
      return {key:module.key,slug:module.slug,title:module.title,description:module.description,
        filters:module.filters,total:Number(result.rows[0]?.total??0)};
    }));
    res.json({generated_at:new Date().toISOString(),timezone:'Europe/Berlin',filters:reportingFilterResponse(filters),scope:siteScope?'site':'tenant',modules});
  }catch(error){next(error);}
});

phase5Router.get('/reports/center/modules/:slug',reportingPermission,async(req,res,next)=>{
  try{
    const slug=String(req.params.slug);
    const module=reportingModule(slug);
    const filters=parseReportingFilters(req.query as Record<string,unknown>);
    const {text,values}=reportingQuery(slug,req.user!.tenantId,filters,reportingSiteScope(req.user!));
    const result=await query<ReportingRow>(text,values);
    const total=Number(result.rows[0]?.total??0);
    res.json({module,filters:reportingFilterResponse(filters),total,page:filters.page,page_size:filters.pageSize,
      page_count:Math.max(1,Math.ceil(total/filters.pageSize)),rows:result.rows});
  }catch(error){next(error);}
});

phase5Router.get('/reports/center/export',reportingPermission,async(req,res,next)=>{
  try{
    const slug=String(req.query.module??'');
    const module=reportingModule(slug);
    const format=String(req.query.format??'csv');
    if(!['csv','pdf','xlsx'].includes(format))throw Object.assign(new Error('Ungültiges Exportformat'),{status:400});
    const filters=parseReportingFilters(req.query as Record<string,unknown>);
    const {text,values}=reportingQuery(slug,req.user!.tenantId,filters,reportingSiteScope(req.user!),5000);
    const result=await query<ReportingRow>(text,values);
    const rows=result.rows;
    const total=Number(rows[0]?.total??0);
    const truncated=total>rows.length;
    await audit(req,'reporting.center.exported','reporting_module',undefined,{
      module:slug,module_key:module.key,format,count:rows.length,total,truncated,
      from:filters.from,to:filters.to,site_id:filters.siteId,customer_id:filters.customerId,
      employee_id:filters.employeeId,search:filters.search,scope:reportingSiteScope(req.user!)?'site':'tenant',
    });
    const filename=safeReportFilename(slug,filters,format);
    if(format==='csv'){
      return res.set('content-type','text/csv; charset=utf-8').set({
        'content-disposition':`attachment; filename="${filename}"`,
        'x-report-row-count':String(rows.length),'x-report-truncated':String(truncated),
      }).send(reportCsv(rows));
    }
    if(format==='pdf'){
      return res.type('application/pdf').set({
        'content-disposition':`attachment; filename="${filename}"`,
        'x-report-row-count':String(rows.length),'x-report-truncated':String(truncated),
      }).send(pdfReportLines(reportPdfLines(module.title,filters,rows)));
    }
    const table=[reportHeaders(rows),...rows.map(row=>[
      row.occurred_at,row.label,row.status,row.site_name??row.site_id??'',
      row.customer_name??row.customer_id??'',row.employee_name??row.employee_id??'',
      row.metric??'',row.metric_label??'',JSON.stringify(row.details??{}),
    ])];
    return res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').set({
      'content-disposition':`attachment; filename="${filename}"`,
      'x-report-row-count':String(rows.length),'x-report-truncated':String(truncated),
    }).send(xlsxWorkbook(table));
  }catch(error){next(error);}
});

phase5Router.get('/reports/:kind',requirePermission('reports:read'),async(req,res,next)=>{
  try{
    const kind=String(req.params.kind);const {from,to}=range(req);
    const filters=z.object({site_id:uuid.optional(),employee_id:uuid.optional()}).safeParse(req.query);
    if(!filters.success)return res.status(400).json({error:'Ungültiger Berichtsfilter'});
    const rows=await reportRows(kind,req.user!.tenantId,from,to,filters.data.site_id,filters.data.employee_id) as Record<string,unknown>[];
    const format=req.query.format==='pdf'?'pdf':req.query.format==='json'?'json':'csv';await audit(req,'report.exported',kind,undefined,{format,count:rows.length});
    if(format==='json')return res.json(rows);
    const output=csv(rows);
    if(format==='csv')return res.type('text/csv').set('content-disposition',`attachment; filename="${kind}-bericht.csv"`).send(output);
    const lines=[`${kind}-Bericht`,'',...rows.map(row=>Object.entries(row).map(([key,value])=>`${key}: ${String(value??'')}`).join(' | '))];
    return res.type('application/pdf').set('content-disposition',`attachment; filename="${kind}-bericht.pdf"`).send(pdfReportLines(lines));
  }catch(error){next(error);}
});

phase5Router.get('/timescan/config',requirePermission('timescan:read'),async(req,res,next)=>{
  try{const row=(await query('SELECT id,base_url,account_ref,secret_ref,enabled,last_sync_at FROM timescan_connections WHERE tenant_id=$1',[req.user!.tenantId])).rows[0];res.json(row||null);}catch(error){next(error);}
});
phase5Router.post('/timescan/config',requirePermission('timescan:write'),async(req,res,next)=>{
  try{
    const body=z.object({base_url:z.string().url(),account_ref:nonempty,secret_ref:z.string().regex(/^[A-Z0-9_]+$/),enabled:z.boolean().default(true),reason:nonempty.max(500)}).strict().parse(req.body);
    const row=(await query(`INSERT INTO timescan_connections(tenant_id,base_url,account_ref,secret_ref,enabled)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id) DO UPDATE SET base_url=EXCLUDED.base_url,account_ref=EXCLUDED.account_ref,secret_ref=EXCLUDED.secret_ref,enabled=EXCLUDED.enabled,updated_at=now() RETURNING id,base_url,account_ref,secret_ref,enabled,last_sync_at`,[req.user!.tenantId,body.base_url,body.account_ref,body.secret_ref,body.enabled])).rows[0];
    await audit(req,'timescan.configured','timescan',row.id,{reason:body.reason,account_ref:body.account_ref});res.status(201).json(row);
  }catch(error){next(error);}
});
phase5Router.get('/timescan/runs',requirePermission('timescan:read'),async(req,res,next)=>{
  try{res.json((await query('SELECT * FROM timescan_sync_runs WHERE tenant_id=$1 ORDER BY started_at DESC LIMIT 50',[req.user!.tenantId])).rows);}catch(error){next(error);}
});
phase5Router.post('/timescan/sync',requirePermission('timescan:write'),async(req,res,next)=>{
  try{
    const {from,to}=range(req);const config=(await query('SELECT * FROM timescan_connections WHERE tenant_id=$1 AND enabled=true',[req.user!.tenantId])).rows[0];
    if(!config)return res.status(409).json({error:'TimeScan ist nicht konfiguriert'});
    let secret:string|undefined;try{secret=await resolveSecret(config.secret_ref);}catch{return res.status(502).json({error:'Referenziertes TimeScan-Geheimnis ist nicht verfügbar'});}if(!secret)return res.status(502).json({error:'Referenziertes TimeScan-Geheimnis ist nicht verfügbar'});
    const run=(await query(`INSERT INTO timescan_sync_runs(tenant_id,status) VALUES($1,'running') RETURNING id`,[req.user!.tenantId])).rows[0];
    try{
      const entries=await createTimeScanAdapter(config.base_url,config.account_ref,secret).listWorkTimes(from,to);
      let imported=0;
      for(const entry of entries){
        const employee=(await query<{id:string}>('SELECT id FROM employees WHERE tenant_id=$1 AND lower(email)=lower($2)',[req.user!.tenantId,entry.employeeEmail])).rows[0];
        const result=await query(`INSERT INTO work_time_entries(tenant_id,employee_id,external_id,started_at,ended_at,minutes,metadata)
          VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(tenant_id,provider,external_id) DO UPDATE SET employee_id=EXCLUDED.employee_id,started_at=EXCLUDED.started_at,ended_at=EXCLUDED.ended_at,minutes=EXCLUDED.minutes,metadata=EXCLUDED.metadata,updated_at=now() RETURNING id`,
          [req.user!.tenantId,employee?.id??null,entry.externalId,entry.startedAt,entry.endedAt??null,entry.minutes,entry.metadata??{}]);
        if(result.rowCount)imported++;
      }
      await query(`UPDATE timescan_sync_runs SET status='completed',imported_count=$1,completed_at=now() WHERE id=$2`,[imported,run.id]);
      await query('UPDATE timescan_connections SET last_sync_at=now() WHERE tenant_id=$1',[req.user!.tenantId]);
      await audit(req,'timescan.sync_completed','timescan',run.id,{imported});res.json({run_id:run.id,status:'completed',imported_count:imported});
    }catch(error){
      await query(`UPDATE timescan_sync_runs SET status='failed',error_message=$1,completed_at=now() WHERE id=$2`,[error instanceof Error?error.message:'TimeScan-Synchronisierung fehlgeschlagen',run.id]);throw error;
    }
  }catch(error){next(error);}
});

phase5Router.get('/audit',requirePermission('audit:read'),async(req,res,next)=>{
  try{const limit=Math.min(Number(req.query.limit)||200,1000);res.json((await query(`SELECT a.*,u.email actor_email FROM audit_events a LEFT JOIN users u ON u.id=a.actor_user_id WHERE a.tenant_id=$1 ORDER BY a.created_at DESC LIMIT $2`,[req.user!.tenantId,limit])).rows);}catch(error){next(error);}
});
phase5Router.get('/audit/export',requirePermission('audit:read'),async(req,res,next)=>{
  try{const rows=(await query('SELECT id,event_type,entity_type,entity_id,details,created_at FROM audit_events WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 10000',[req.user!.tenantId])).rows as Record<string,unknown>[];await audit(req,'audit.exported','audit',undefined,{count:rows.length});res.type('text/csv').set('content-disposition','attachment; filename="audit-log.csv"').send(csv(rows));}catch(error){next(error);}
});
phase5Router.get('/retention',requirePermission('privacy:write'),async(req,res,next)=>{
  try{res.json((await query('SELECT * FROM retention_policies WHERE tenant_id=$1 ORDER BY data_type',[req.user!.tenantId])).rows);}catch(error){next(error);}
});
phase5Router.patch('/retention/:dataType',requirePermission('privacy:write'),async(req,res,next)=>{
  try{const body=z.object({retention_days:z.number().int().min(30),purpose:nonempty,enabled:z.boolean().optional()}).strict().parse(req.body);const dataType=String(req.params.dataType);const row=(await query(`UPDATE retention_policies SET retention_days=$1,purpose=$2,enabled=COALESCE($3,enabled),updated_at=now() WHERE tenant_id=$4 AND data_type=$5 RETURNING *`,[body.retention_days,body.purpose,body.enabled??null,req.user!.tenantId,dataType])).rows[0];if(!row)return res.status(404).json({error:'Aufbewahrungsrichtlinie nicht gefunden'});await audit(req,'retention.updated','retention',String(row.id),{retention_days:body.retention_days});res.json(row);}catch(error){next(error);}
});
phase5Router.post('/privacy/export',requirePermission('privacy:write'),async(req,res,next)=>{
  try{
    const body=z.object({user_id:uuid}).strict().parse(req.body);const user=(await query('SELECT id,email,role,created_at FROM users WHERE id=$1 AND tenant_id=$2',[body.user_id,req.user!.tenantId])).rows[0];if(!user)return res.status(404).json({error:'Benutzer nicht gefunden'});
    const [messages,notifications,auditEvents]=await Promise.all([
      query('SELECT id,body,read_at,created_at FROM direct_messages WHERE tenant_id=$1 AND (sender_user_id=$2 OR recipient_user_id=$2)',[req.user!.tenantId,body.user_id]),
      query('SELECT id,event_type,title,body,read_at,created_at FROM notifications WHERE tenant_id=$1 AND user_id=$2',[req.user!.tenantId,body.user_id]),
      query('SELECT id,event_type,entity_type,entity_id,details,created_at FROM audit_events WHERE tenant_id=$1 AND actor_user_id=$2',[req.user!.tenantId,body.user_id]),
    ]);
    await audit(req,'privacy.exported','user',body.user_id,{});res.json({user,messages:messages.rows,notifications:notifications.rows,audit:auditEvents.rows});
  }catch(error){next(error);}
});
phase5Router.post('/privacy/delete',requirePermission('privacy:write'),async(req,res,next)=>{
  try{
    const body=z.object({user_id:uuid,confirm:z.literal(true)}).strict().parse(req.body);const user=(await query('SELECT id FROM users WHERE id=$1 AND tenant_id=$2',[body.user_id,req.user!.tenantId])).rows[0];if(!user)return res.status(404).json({error:'Benutzer nicht gefunden'});
    await query('DELETE FROM direct_messages WHERE tenant_id=$1 AND (sender_user_id=$2 OR recipient_user_id=$2)',[req.user!.tenantId,body.user_id]);
    await query(`UPDATE users SET email=$1,password_hash=$2,updated_at=now() WHERE id=$3 AND tenant_id=$4`,[`deleted-${body.user_id}@invalid.local`,'DELETED',body.user_id,req.user!.tenantId]);
    await audit(req,'privacy.deleted','user',body.user_id,{anonymized:true});res.json({anonymized:true,user_id:body.user_id});
  }catch(error){next(error);}
});
phase5Router.get('/backups/status',requirePermission('backup:read'),async(req,res,next)=>{
  try{
    let files:string[]=[];try{files=await fs.readdir(env.BACKUP_DIRECTORY);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    res.json({directory:env.BACKUP_DIRECTORY,files:files.filter(file=>file.endsWith('.dump')||file.endsWith('.sql.gz')).sort().reverse()});
  }catch(error){next(error);}
});
