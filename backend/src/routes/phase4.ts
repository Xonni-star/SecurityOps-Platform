import {Router,Request} from 'express';
import {z} from 'zod';
import {query} from '../db/pool.js';
import {requireAuth,requireCsrf,requirePermission} from '../middleware/auth.js';
import {publish} from '../services/realtime.js';
import {queueNotificationEvent} from '../services/notifications.js';

const uuid=z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const nonempty=z.string().trim().min(1);
export const phase4Router=Router();
phase4Router.use((req,res,next)=>/^\/(nsl|reports|handovers|messages|notifications|notification-)/.test(req.path)
  ? requireAuth(req,res,()=>['POST','PATCH','PUT','DELETE'].includes(req.method)?requireCsrf(req,res,next):next())
  : next());

async function audit(req:Request,eventType:string,entityType:string|undefined,entityId:string|undefined,details:Record<string,unknown>={}){
  await query('INSERT INTO audit_events(tenant_id,actor_user_id,event_type,entity_type,entity_id,details) VALUES($1,$2,$3,$4,$5,$6)',[req.user!.tenantId,req.user!.id,eventType,entityType??null,entityId??null,details]);
}

phase4Router.get('/nsl/dashboard',requirePermission('nsl:read'),async(req,res,next)=>{
  try{
    const [alarms,incidents,positions,patrols,summary]=await Promise.all([
      query(`SELECT a.*,p.name priority_name,p.code priority_code,p.color,s.name site_name,e.name employee_name,
        EXTRACT(EPOCH FROM (now()-a.triggered_at))::integer age_seconds
        FROM alarms a LEFT JOIN alarm_priorities p ON p.id=a.priority_id LEFT JOIN sites s ON s.id=a.site_id
        LEFT JOIN employees e ON e.id=a.employee_id WHERE a.tenant_id=$1 AND a.status<>'resolved'
        ORDER BY COALESCE(p.rank,99),a.triggered_at`,[req.user!.tenantId]),
      query(`SELECT i.*,p.name priority_name,s.name site_name,
        COALESCE(json_agg(json_build_object('id',e.id,'name',e.name)) FILTER(WHERE e.id IS NOT NULL),'[]') assignees
        FROM incidents i LEFT JOIN alarm_priorities p ON p.id=i.priority_id LEFT JOIN sites s ON s.id=i.site_id
        LEFT JOIN incident_assignments ia ON ia.incident_id=i.id LEFT JOIN employees e ON e.id=ia.employee_id
        WHERE i.tenant_id=$1 AND i.status<>'completed' GROUP BY i.id,p.name,s.name ORDER BY i.created_at`,[req.user!.tenantId]),
      query(`SELECT DISTINCT ON (p.device_id) p.*,d.name device_name,d.status device_status FROM device_positions p
        JOIN devices d ON d.id=p.device_id WHERE p.tenant_id=$1 ORDER BY p.device_id,p.recorded_at DESC`,[req.user!.tenantId]),
      query(`SELECT r.id,r.name,r.site_id,s.name site_name,pa.employee_id,e.name employee_name,
        MAX(ps.scanned_at) last_scan,COUNT(ps.id)::integer scan_count
        FROM patrol_routes r JOIN sites s ON s.id=r.site_id LEFT JOIN patrol_assignments pa ON pa.route_id=r.id
        LEFT JOIN employees e ON e.id=pa.employee_id LEFT JOIN patrol_scans ps ON ps.route_id=r.id
        WHERE r.tenant_id=$1 GROUP BY r.id,r.name,r.site_id,s.name,pa.employee_id,e.name ORDER BY r.name`,[req.user!.tenantId]),
      query(`SELECT
        COUNT(*) FILTER (WHERE a.status='open')::integer unacknowledged_alarms,
        COUNT(*) FILTER (WHERE a.status='open' AND p.code='critical')::integer critical_alarms,
        COUNT(*) FILTER (WHERE a.status='acknowledged')::integer acknowledged_alarms,
        COUNT(*) FILTER (WHERE a.status='escalated')::integer escalated_alarms,
        COUNT(*) FILTER (WHERE a.status<>'resolved')::integer open_alarms,
        (SELECT COUNT(*)::integer FROM incidents i WHERE i.tenant_id=$1 AND i.status<>'completed') active_incidents,
        (SELECT COUNT(DISTINCT sa.employee_id)::integer
          FROM schedule_assignments sa
          JOIN schedule_shifts ss ON ss.tenant_id=sa.tenant_id AND ss.id=sa.shift_id
          JOIN schedule_periods sp ON sp.tenant_id=ss.tenant_id AND sp.id=ss.period_id
          WHERE sa.tenant_id=$1 AND sa.status='assigned' AND sp.status='published'
            AND ss.starts_at<=now() AND ss.ends_at>now()) on_duty_resources,
        (SELECT COUNT(*)::integer FROM schedule_assignments sa
          JOIN schedule_shifts ss ON ss.tenant_id=sa.tenant_id AND ss.id=sa.shift_id
          JOIN schedule_periods sp ON sp.tenant_id=ss.tenant_id AND sp.id=ss.period_id
          WHERE sa.tenant_id=$1 AND sa.status='assigned' AND sp.status='published'
            AND ss.starts_at<=now() AND ss.ends_at>now()
            AND EXISTS (SELECT 1 FROM incident_assignments ia
              JOIN incidents i ON i.tenant_id=ia.tenant_id AND i.id=ia.incident_id
              WHERE ia.tenant_id=sa.tenant_id AND ia.employee_id=sa.employee_id AND i.status<>'completed')) assigned_resources,
        (SELECT COUNT(*)::integer FROM shift_handovers h WHERE h.tenant_id=$1 AND h.status='open')
          + (SELECT COUNT(*)::integer FROM handover_records h WHERE h.tenant_id=$1 AND h.status='open') open_handovers,
        (SELECT COUNT(*)::integer FROM devices d WHERE d.tenant_id=$1 AND d.status<>'active') technical_issues
       FROM alarms a
       LEFT JOIN alarm_priorities p ON p.tenant_id=a.tenant_id AND p.id=a.priority_id
       WHERE a.tenant_id=$1`,[req.user!.tenantId]),
    ]);
    res.json({
      alarms:alarms.rows,
      incidents:incidents.rows,
      positions:positions.rows,
      patrols:patrols.rows,
      summary:summary.rows[0]??{
        unacknowledged_alarms:0,critical_alarms:0,acknowledged_alarms:0,escalated_alarms:0,
        open_alarms:0,active_incidents:0,on_duty_resources:0,assigned_resources:0,
        open_handovers:0,technical_issues:0,
      },
      last_updated_at:new Date().toISOString(),
    });
  }catch(error){next(error);}
});

phase4Router.get('/nsl/alarms/:id',requirePermission('nsl:read'),async(req,res,next)=>{
  try{
    const alarm=(await query(`SELECT a.*,p.name priority_name,s.name site_name,s.address site_address,e.name employee_name,e.email employee_email
      FROM alarms a LEFT JOIN alarm_priorities p ON p.id=a.priority_id LEFT JOIN sites s ON s.id=a.site_id
      LEFT JOIN employees e ON e.id=a.employee_id WHERE a.tenant_id=$1 AND a.id=$2`,[req.user!.tenantId,req.params.id])).rows[0];
    if(!alarm)return res.status(404).json({error:'Alarm not found'});
    const history=await query(`SELECT h.*,u.email changed_by_email FROM alarm_history h LEFT JOIN users u ON u.id=h.changed_by
      WHERE h.tenant_id=$1 AND h.alarm_id=$2 ORDER BY h.created_at`,[req.user!.tenantId,req.params.id]);
    res.json({alarm,history:history.rows});
  }catch(error){next(error);}
});

phase4Router.get('/reports/alarms',requirePermission('reports:read'),async(req,res,next)=>{
  try{
    const format=req.query.format==='pdf'?'pdf':'csv';
    const rows=(await query(`SELECT a.id,a.type,a.status,a.source,a.description,a.triggered_at,a.acknowledged_at,a.resolved_at,
      p.code priority,s.name site,e.name employee FROM alarms a LEFT JOIN alarm_priorities p ON p.id=a.priority_id
      LEFT JOIN sites s ON s.id=a.site_id LEFT JOIN employees e ON e.id=a.employee_id
      WHERE a.tenant_id=$1 ORDER BY a.triggered_at DESC LIMIT 5000`,[req.user!.tenantId])).rows as Record<string,unknown>[];
    await audit(req,'report.exported','alarm',undefined,{format,count:rows.length});
    const headers=['id','type','status','source','description','triggered_at','acknowledged_at','resolved_at','priority','site','employee'];
    const csv=[headers.join(','),...rows.map(row=>headers.map(key=>`"${String(row[key]??'').replaceAll('"','""')}"`).join(','))].join('\n');
    if(format==='csv'){res.type('text/csv').set('content-disposition','attachment; filename="alarm-report.csv"').send(csv);return;}
    const lines=['SecurityOps Alarm Report','',...rows.map(row=>headers.map(key=>`${key}: ${String(row[key]??'')}`).join(' | '))];
    const content=lines.join('\n').replace(/[()\\]/g,'\\$&').replace(/\n/g,') Tj 0 -14 Td (');
    const pdf=`%PDF-1.4
1 0 obj<< /Type /Catalog /Pages 2 0 R>>endobj
2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1>>endobj
3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources<< /Font<< /F1 5 0 R>>>>>>endobj
4 0 obj<< /Length ${content.length+35}>>stream
BT /F1 9 Tf 36 756 Td (${content}) Tj ET
endstream endobj
5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica>>endobj
xref
0 6
0000000000 65535 f 
trailer<< /Size 6 /Root 1 0 R>>
startxref
0
%%EOF`;
    res.type('application/pdf').set('content-disposition','attachment; filename="alarm-report.pdf"').send(Buffer.from(pdf));
  }catch(error){next(error);}
});

phase4Router.get('/handovers',requirePermission('nsl:read'),async(req,res,next)=>{
  try{res.json((await query(`SELECT h.*,u.email created_by_email,a.email acknowledged_by_email FROM shift_handovers h
    JOIN users u ON u.id=h.created_by LEFT JOIN users a ON a.id=h.acknowledged_by
    WHERE h.tenant_id=$1 ORDER BY h.created_at DESC LIMIT 100`,[req.user!.tenantId])).rows);}catch(error){next(error);}
});
phase4Router.post('/handovers',requirePermission('nsl:write'),async(req,res,next)=>{
  try{
    const body=z.object({notes:z.string().max(5000).default('')}).strict().parse(req.body);
    const openAlarms=(await query(`SELECT id,description,status FROM alarms WHERE tenant_id=$1 AND status<>'resolved'`,[req.user!.tenantId])).rows;
    const incidents=(await query(`SELECT id,description,status FROM incidents WHERE tenant_id=$1 AND status<>'completed'`,[req.user!.tenantId])).rows;
    const handover=(await query(`INSERT INTO shift_handovers(tenant_id,created_by,notes,open_alarms,active_incidents)
      VALUES($1,$2,$3,$4,$5) RETURNING *`,[req.user!.tenantId,req.user!.id,body.notes,JSON.stringify(openAlarms),JSON.stringify(incidents)])).rows[0];
    await audit(req,'handover.created','handover',handover.id,{});
    publish(req.user!.tenantId,'handover.created',handover,'nsl:read');
    res.status(201).json(handover);
  }catch(error){next(error);}
});
phase4Router.post('/handovers/:id/acknowledge',requirePermission('nsl:write'),async(req,res,next)=>{
  try{
    const handover=(await query(`UPDATE shift_handovers SET status='acknowledged',acknowledged_by=$1,acknowledged_at=now()
      WHERE tenant_id=$2 AND id=$3 AND status='open' RETURNING *`,[req.user!.id,req.user!.tenantId,req.params.id])).rows[0];
    if(!handover)return res.status(404).json({error:'Open handover not found'});
    await audit(req,'handover.acknowledged','handover',handover.id,{});
    publish(req.user!.tenantId,'handover.acknowledged',handover,'nsl:read');
    res.json(handover);
  }catch(error){next(error);}
});

phase4Router.get('/messages',requirePermission('messages:read'),async(req,res,next)=>{
  try{res.json((await query(`SELECT m.*,s.email sender_email,r.email recipient_email,e.name recipient_employee_name
    FROM direct_messages m JOIN users s ON s.id=m.sender_user_id LEFT JOIN users r ON r.id=m.recipient_user_id
    LEFT JOIN employees e ON e.id=m.recipient_employee_id WHERE m.tenant_id=$1
      AND (m.sender_user_id=$2 OR m.recipient_user_id=$2) ORDER BY m.created_at DESC LIMIT 200`,[req.user!.tenantId,req.user!.id])).rows);}catch(error){next(error);}
});
phase4Router.post('/messages',requirePermission('messages:write'),async(req,res,next)=>{
  try{
    const body=z.object({recipient_user_id:uuid.optional(),recipient_employee_id:uuid.optional(),body:nonempty.max(4000)}).strict().refine(value=>Boolean(value.recipient_user_id||value.recipient_employee_id),{message:'Recipient required'}).parse(req.body);
    if(body.recipient_user_id&&!(await query('SELECT id FROM users WHERE id=$1 AND tenant_id=$2',[body.recipient_user_id,req.user!.tenantId])).rows[0])return res.status(404).json({error:'Recipient not found'});
    if(body.recipient_employee_id&&!(await query('SELECT id FROM employees WHERE id=$1 AND tenant_id=$2',[body.recipient_employee_id,req.user!.tenantId])).rows[0])return res.status(404).json({error:'Employee not found'});
    const message=(await query(`INSERT INTO direct_messages(tenant_id,sender_user_id,recipient_user_id,recipient_employee_id,body)
      VALUES($1,$2,$3,$4,$5) RETURNING *`,[req.user!.tenantId,req.user!.id,body.recipient_user_id??null,body.recipient_employee_id??null,body.body])).rows[0];
    await audit(req,'message.sent','message',message.id,{});
    publish(req.user!.tenantId,'message.created',message,'messages:read');
    res.status(201).json(message);
  }catch(error){next(error);}
});
phase4Router.post('/messages/:id/read',requirePermission('messages:write'),async(req,res,next)=>{
  try{
    const message=(await query(`UPDATE direct_messages SET read_at=COALESCE(read_at,now())
      WHERE tenant_id=$1 AND id=$2 AND recipient_user_id=$3 RETURNING *`,[req.user!.tenantId,req.params.id,req.user!.id])).rows[0];
    if(!message)return res.status(404).json({error:'Message not found'});
    publish(req.user!.tenantId,'message.read',message,'messages:read');res.json(message);
  }catch(error){next(error);}
});

phase4Router.get('/notifications',requirePermission('notifications:read'),async(req,res,next)=>{
  try{res.json((await query(`SELECT * FROM notifications WHERE tenant_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 200`,[req.user!.tenantId,req.user!.id])).rows);}catch(error){next(error);}
});
phase4Router.post('/notifications/:id/read',requirePermission('notifications:read'),async(req,res,next)=>{
  try{const notification=(await query(`UPDATE notifications SET read_at=COALESCE(read_at,now()) WHERE tenant_id=$1 AND user_id=$2 AND id=$3 RETURNING *`,[req.user!.tenantId,req.user!.id,req.params.id])).rows[0];if(!notification)return res.status(404).json({error:'Notification not found'});res.json(notification);}catch(error){next(error);}
});
phase4Router.get('/notification-subscriptions',requirePermission('notifications:read'),async(req,res,next)=>{
  try{res.json((await query('SELECT * FROM notification_subscriptions WHERE tenant_id=$1 AND (user_id=$2 OR role=$3) ORDER BY event_type,channel',[req.user!.tenantId,req.user!.id,req.user!.role])).rows);}catch(error){next(error);}
});
phase4Router.post('/notification-subscriptions',requirePermission('notifications:write'),async(req,res,next)=>{
  try{
    const body=z.object({role:z.enum(['admin','operator','viewer']).optional(),user_id:uuid.optional(),event_type:nonempty,channel:z.enum(['email','sms','in_app']),recipient:z.string().trim().optional(),enabled:z.boolean().default(true)}).strict().refine(value=>Boolean(value.role||value.user_id),{message:'Role or user required'}).refine(value=>value.channel==='in_app'||Boolean(value.recipient),{message:'Recipient required'}).parse(req.body);
    const subscription=(await query(`INSERT INTO notification_subscriptions(tenant_id,user_id,role,event_type,channel,recipient,enabled)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[req.user!.tenantId,body.user_id??null,body.role??null,body.event_type,body.channel,body.recipient??null,body.enabled])).rows[0];
    await audit(req,'notification.subscription_created','subscription',subscription.id,{});
    res.status(201).json(subscription);
  }catch(error){next(error);}
});
phase4Router.post('/notification-events',requirePermission('notifications:write'),async(req,res,next)=>{
  try{
    const body=z.object({event_type:nonempty,event_key:nonempty,title:nonempty,body:nonempty,entity_type:nonempty.optional(),entity_id:uuid.optional()}).strict().parse(req.body);
    await queueNotificationEvent(req.user!.tenantId,body.event_type,body.event_key,body.title,body.body,body.entity_type,body.entity_id);
    res.status(202).json({queued:true,event_key:body.event_key});
  }catch(error){next(error);}
});
