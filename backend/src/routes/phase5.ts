import {Router,Request} from 'express';
import {promises as fs} from 'node:fs';
import {z} from 'zod';
import {query} from '../db/pool.js';
import {requireAuth,requireCsrf,requirePermission} from '../middleware/auth.js';
import {createTimeScanAdapter} from '../services/timescan.js';
import {env} from '../config/env.js';

const uuid=z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const nonempty=z.string().trim().min(1);
export const phase5Router=Router();
phase5Router.use((req,res,next)=>/^\/(reports|timescan|audit|privacy|retention|backups)/.test(req.path)
  ? requireAuth(req,res,()=>['POST','PATCH','PUT','DELETE'].includes(req.method)?requireCsrf(req,res,next):next())
  : next());

async function audit(req:Request,eventType:string,entityType?:string,entityId?:string,details:Record<string,unknown>={}){
  await query('INSERT INTO audit_events(tenant_id,actor_user_id,event_type,entity_type,entity_id,details) VALUES($1,$2,$3,$4,$5,$6)',[req.user!.tenantId,req.user!.id,eventType,entityType??null,entityId??null,details]);
}

function range(req:Request){
  const from=typeof req.query.from==='string'?new Date(req.query.from):new Date(Date.now()-30*86400000);
  const to=typeof req.query.to==='string'?new Date(req.query.to):new Date();
  if(Number.isNaN(from.valueOf())||Number.isNaN(to.valueOf())||from>to)throw Object.assign(new Error('Invalid date range'),{status:400});
  return {from,to};
}

async function reportRows(kind:string,tenantId:string,from:Date,to:Date,siteId?:string,employeeId?:string){
  const scope=`tenant_id=$1 AND created_at BETWEEN $2 AND $3`;
  switch(kind){
    case 'employees':return (await query(`SELECT id,name,email,title,created_at FROM employees WHERE ${scope} ORDER BY name`,[tenantId,from,to])).rows;
    case 'sites':return (await query(`SELECT id,name,address,created_at FROM sites WHERE ${scope} ORDER BY name`,[tenantId,from,to])).rows;
    case 'patrols':return (await query(`SELECT ps.id,ps.route_id,r.name route_name,ps.control_point_id,cp.name control_point_name,ps.employee_id,e.name employee_name,ps.scanned_at,ps.deviation
      FROM patrol_scans ps JOIN patrol_routes r ON r.id=ps.route_id JOIN control_points cp ON cp.id=ps.control_point_id
      JOIN employees e ON e.id=ps.employee_id WHERE ps.tenant_id=$1 AND ps.scanned_at BETWEEN $2 AND $3
      AND ($4::uuid IS NULL OR r.site_id=$4) AND ($5::uuid IS NULL OR ps.employee_id=$5) ORDER BY ps.scanned_at DESC`,[tenantId,from,to,siteId??null,employeeId??null])).rows;
    case 'alarms':return (await query(`SELECT a.id,a.type,a.status,a.source,a.description,a.triggered_at,a.acknowledged_at,a.resolved_at,p.code priority,s.name site_name,e.name employee_name
      FROM alarms a LEFT JOIN alarm_priorities p ON p.id=a.priority_id LEFT JOIN sites s ON s.id=a.site_id LEFT JOIN employees e ON e.id=a.employee_id
      WHERE a.tenant_id=$1 AND a.triggered_at BETWEEN $2 AND $3 AND ($4::uuid IS NULL OR a.site_id=$4) AND ($5::uuid IS NULL OR a.employee_id=$5)
      ORDER BY a.triggered_at DESC`,[tenantId,from,to,siteId??null,employeeId??null])).rows;
    case 'incidents':return (await query(`SELECT i.id,i.description,i.status,i.created_at,i.updated_at,p.code priority,s.name site_name,e.name employee_name
      FROM incidents i LEFT JOIN alarm_priorities p ON p.id=i.priority_id LEFT JOIN sites s ON s.id=i.site_id LEFT JOIN employees e ON e.id=i.employee_id
      WHERE i.tenant_id=$1 AND i.created_at BETWEEN $2 AND $3 AND ($4::uuid IS NULL OR i.site_id=$4) AND ($5::uuid IS NULL OR i.employee_id=$5)
      ORDER BY i.created_at DESC`,[tenantId,from,to,siteId??null,employeeId??null])).rows;
    case 'work-time':return (await query(`SELECT w.id,w.external_id,w.started_at,w.ended_at,w.minutes,w.status,e.name employee_name
      FROM work_time_entries w LEFT JOIN employees e ON e.id=w.employee_id WHERE w.tenant_id=$1 AND w.started_at BETWEEN $2 AND $3
      AND ($4::uuid IS NULL OR w.employee_id=$4) ORDER BY w.started_at DESC`,[tenantId,from,to,employeeId??null])).rows;
    default:throw Object.assign(new Error('Unknown report'),{status:400});
  }
}

function csv(rows:Record<string,unknown>[]){
  const headers=rows.length?Object.keys(rows[0]):['result'];
  return [headers.join(','),...rows.map(row=>headers.map(key=>`"${String(row[key]??'').replaceAll('"','""')}"`).join(','))].join('\n');
}

phase5Router.get('/reports/statistics',requirePermission('reports:read'),async(req,res,next)=>{
  try{
    const {from,to}=range(req);const tenant=req.user!.tenantId;
    const [alarms,incidents,patrols,work]=await Promise.all([
      query(`SELECT COUNT(*)::integer total,COUNT(*) FILTER(WHERE status='resolved')::integer resolved,COUNT(*) FILTER(WHERE status IN('open','escalated'))::integer open FROM alarms WHERE tenant_id=$1 AND triggered_at BETWEEN $2 AND $3`,[tenant,from,to]),
      query(`SELECT COUNT(*)::integer total,COUNT(*) FILTER(WHERE status='completed')::integer completed FROM incidents WHERE tenant_id=$1 AND created_at BETWEEN $2 AND $3`,[tenant,from,to]),
      query(`SELECT COUNT(*)::integer total,COUNT(*) FILTER(WHERE deviation<>'none')::integer deviations FROM patrol_scans WHERE tenant_id=$1 AND scanned_at BETWEEN $2 AND $3`,[tenant,from,to]),
      query(`SELECT COALESCE(SUM(minutes),0)::integer minutes,COUNT(*)::integer entries FROM work_time_entries WHERE tenant_id=$1 AND started_at BETWEEN $2 AND $3`,[tenant,from,to]),
    ]);
    res.json({from,to,alarms:alarms.rows[0],incidents:incidents.rows[0],patrols:patrols.rows[0],work_time:work.rows[0]});
  }catch(error){next(error);}
});

phase5Router.get('/reports/:kind',requirePermission('reports:read'),async(req,res,next)=>{
  try{
    const kind=String(req.params.kind);const {from,to}=range(req);const rows=await reportRows(kind,req.user!.tenantId,from,to,typeof req.query.site_id==='string'?req.query.site_id:undefined,typeof req.query.employee_id==='string'?req.query.employee_id:undefined) as Record<string,unknown>[];
    const format=req.query.format==='pdf'?'pdf':'csv';await audit(req,'report.exported',kind,undefined,{format,count:rows.length});
    const output=csv(rows);
    if(format==='csv')return res.type('text/csv').set('content-disposition',`attachment; filename="${kind}-report.csv"`).send(output);
    const text=(`${kind} report\n\n${rows.map(row=>Object.entries(row).map(([key,value])=>`${key}: ${String(value??'')}`).join(' | ')).join('\n')}`).replace(/[()\\]/g,'\\$&').replace(/\n/g,') Tj 0 -14 Td (');
    const pdf=`%PDF-1.4
1 0 obj<< /Type /Catalog /Pages 2 0 R>>endobj
2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1>>endobj
3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources<< /Font<< /F1 5 0 R>>>>>>endobj
4 0 obj<< /Length ${text.length+35}>>stream
BT /F1 9 Tf 36 756 Td (${text}) Tj ET
endstream endobj
5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica>>endobj
xref
0 6
0000000000 65535 f 
trailer<< /Size 6 /Root 1 0 R>>
startxref
0
%%EOF`;
    return res.type('application/pdf').set('content-disposition',`attachment; filename="${kind}-report.pdf"`).send(Buffer.from(pdf));
  }catch(error){next(error);}
});

phase5Router.get('/timescan/config',requirePermission('timescan:read'),async(req,res,next)=>{
  try{const row=(await query('SELECT id,base_url,account_ref,secret_ref,enabled,last_sync_at FROM timescan_connections WHERE tenant_id=$1',[req.user!.tenantId])).rows[0];res.json(row||null);}catch(error){next(error);}
});
phase5Router.post('/timescan/config',requirePermission('timescan:write'),async(req,res,next)=>{
  try{
    const body=z.object({base_url:z.string().url(),account_ref:nonempty,secret_ref:z.string().regex(/^[A-Z0-9_]+$/),enabled:z.boolean().default(true)}).strict().parse(req.body);
    const row=(await query(`INSERT INTO timescan_connections(tenant_id,base_url,account_ref,secret_ref,enabled)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id) DO UPDATE SET base_url=EXCLUDED.base_url,account_ref=EXCLUDED.account_ref,secret_ref=EXCLUDED.secret_ref,enabled=EXCLUDED.enabled,updated_at=now() RETURNING id,base_url,account_ref,secret_ref,enabled,last_sync_at`,[req.user!.tenantId,body.base_url,body.account_ref,body.secret_ref,body.enabled])).rows[0];
    await audit(req,'timescan.configured','timescan',row.id,{account_ref:body.account_ref});res.status(201).json(row);
  }catch(error){next(error);}
});
phase5Router.get('/timescan/runs',requirePermission('timescan:read'),async(req,res,next)=>{
  try{res.json((await query('SELECT * FROM timescan_sync_runs WHERE tenant_id=$1 ORDER BY started_at DESC LIMIT 50',[req.user!.tenantId])).rows);}catch(error){next(error);}
});
phase5Router.post('/timescan/sync',requirePermission('timescan:write'),async(req,res,next)=>{
  try{
    const {from,to}=range(req);const config=(await query('SELECT * FROM timescan_connections WHERE tenant_id=$1 AND enabled=true',[req.user!.tenantId])).rows[0];
    if(!config)return res.status(409).json({error:'TimeScan is not configured'});
    const secret=process.env[config.secret_ref];if(!secret)return res.status(500).json({error:'Referenced TimeScan secret is unavailable'});
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
      await query(`UPDATE timescan_sync_runs SET status='failed',error_message=$1,completed_at=now() WHERE id=$2`,[error instanceof Error?error.message:'TimeScan sync failed',run.id]);throw error;
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
  try{const body=z.object({retention_days:z.number().int().min(30),purpose:nonempty,enabled:z.boolean().optional()}).strict().parse(req.body);const dataType=String(req.params.dataType);const row=(await query(`UPDATE retention_policies SET retention_days=$1,purpose=$2,enabled=COALESCE($3,enabled),updated_at=now() WHERE tenant_id=$4 AND data_type=$5 RETURNING *`,[body.retention_days,body.purpose,body.enabled??null,req.user!.tenantId,dataType])).rows[0];if(!row)return res.status(404).json({error:'Retention policy not found'});await audit(req,'retention.updated','retention',String(row.id),{retention_days:body.retention_days});res.json(row);}catch(error){next(error);}
});
phase5Router.post('/privacy/export',requirePermission('privacy:write'),async(req,res,next)=>{
  try{
    const body=z.object({user_id:uuid}).strict().parse(req.body);const user=(await query('SELECT id,email,role,created_at FROM users WHERE id=$1 AND tenant_id=$2',[body.user_id,req.user!.tenantId])).rows[0];if(!user)return res.status(404).json({error:'User not found'});
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
    const body=z.object({user_id:uuid,confirm:z.literal(true)}).strict().parse(req.body);const user=(await query('SELECT id FROM users WHERE id=$1 AND tenant_id=$2',[body.user_id,req.user!.tenantId])).rows[0];if(!user)return res.status(404).json({error:'User not found'});
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
