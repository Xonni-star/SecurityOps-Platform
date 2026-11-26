import {Router,Request} from 'express';
import {z} from 'zod';
import {query} from '../db/pool.js';
import {requireAuth,requireCsrf,requirePermission} from '../middleware/auth.js';
import {createAlarm} from './phase2.js';
import {publish} from '../services/realtime.js';
import {queueNotificationEvent} from '../services/notifications.js';

const uuid=z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const nonempty=z.string().trim().min(1);
const sensorType=z.enum(['fall','posture','inactivity','battery']);
const status=z.enum(['initiated','en_route','on_site','completed']);
export const phase3Router=Router();
phase3Router.use((req,res,next)=>/^\/(sensor-thresholds|sensor-events|telemetry|positions|map-data|incidents)/.test(req.path)
  ? requireAuth(req,res,()=>['POST','PATCH','PUT','DELETE'].includes(req.method)?requireCsrf(req,res,next):next())
  : next());

async function deviceBelongsToTenant(deviceId:string,tenantId:string){
  return (await query<{id:string}>('SELECT id FROM devices WHERE id=$1 AND tenant_id=$2',[deviceId,tenantId])).rows[0];
}

async function priorityFor(tenantId:string,code:string){
  return (await query<{id:string}>('SELECT id FROM alarm_priorities WHERE tenant_id=$1 AND code=$2',[tenantId,code])).rows[0];
}

async function evaluateSensor(req:Request,event:{device_id:string;sensor_type:string;value:number;recorded_at:Date}){
  const rule=(await query<{threshold:number;priority_code:string;enabled:boolean}>(
    'SELECT threshold,priority_code,enabled FROM sensor_thresholds WHERE tenant_id=$1 AND sensor_type=$2',
    [req.user!.tenantId,event.sensor_type],
  )).rows[0];
  if(!rule?.enabled)return;
  const triggered=event.sensor_type==='battery'?event.value<=rule.threshold:event.value>=rule.threshold;
  if(!triggered)return;
  const alarmType=`sensor_${event.sensor_type}`;
  const existing=(await query<{id:string}>(
    `SELECT id FROM alarms WHERE tenant_id=$1 AND device_id=$2 AND type=$3 AND status IN ('open','acknowledged','escalated') LIMIT 1`,
    [req.user!.tenantId,event.device_id,alarmType],
  )).rows[0];
  if(existing)return;
  const priority=await priorityFor(req.user!.tenantId,rule.priority_code);
  if(!priority)return;
  const descriptions:{[key:string]:string}={
    fall:'Bestätigter Sturz',
    posture:'Kritische Lage erkannt',
    inactivity:'Bewegungslosigkeit über dem konfigurierten Zeitfenster',
    battery:'Batteriestand unter dem konfigurierten Schwellwert',
  };
  await createAlarm(req,{
    type:alarmType,
    priority_id:priority.id,
    source:'sensor',
    device_id:event.device_id,
    description:descriptions[event.sensor_type],
  });
}

phase3Router.get('/sensor-thresholds',requirePermission('telemetry:read'),async(req,res,next)=>{
  try{res.json((await query('SELECT * FROM sensor_thresholds WHERE tenant_id=$1 ORDER BY sensor_type',[req.user!.tenantId])).rows);}catch(error){next(error);}
});
phase3Router.post('/sensor-thresholds',requirePermission('telemetry:write'),async(req,res,next)=>{
  try{
    const body=z.object({sensor_type:sensorType,threshold:z.number(),duration_seconds:z.number().int().nonnegative().optional(),priority_code:z.enum(['critical','high','medium','low']),enabled:z.boolean().optional()}).strict().parse(req.body);
    res.status(201).json((await query(
      `INSERT INTO sensor_thresholds(tenant_id,sensor_type,threshold,duration_seconds,priority_code,enabled)
       VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,sensor_type) DO UPDATE SET threshold=EXCLUDED.threshold,duration_seconds=EXCLUDED.duration_seconds,priority_code=EXCLUDED.priority_code,enabled=EXCLUDED.enabled,updated_at=now() RETURNING *`,
      [req.user!.tenantId,body.sensor_type,body.threshold,body.duration_seconds??0,body.priority_code,body.enabled??true],
    )).rows[0]);
  }catch(error){next(error);}
});
phase3Router.get('/sensor-events',requirePermission('telemetry:read'),async(req,res,next)=>{
  try{
    const deviceId=req.query.device_id;
    const params=[req.user!.tenantId];
    const filter=typeof deviceId==='string'?(params.push(deviceId),' AND device_id=$2'):'';
    res.json((await query(`SELECT * FROM sensor_events WHERE tenant_id=$1${filter} ORDER BY recorded_at DESC LIMIT 200`,params)).rows);
  }catch(error){next(error);}
});
phase3Router.post('/telemetry',requirePermission('telemetry:write'),async(req,res,next)=>{
  try{
    const body=z.object({device_id:uuid,sensor_type:sensorType,value:z.number(),recorded_at:z.coerce.date().optional(),metadata:z.record(z.string(),z.unknown()).optional()}).strict().parse(req.body);
    if(!await deviceBelongsToTenant(body.device_id,req.user!.tenantId))return res.status(404).json({error:'Gerät nicht gefunden'});
    const recordedAt=body.recorded_at??new Date();
    const event=(await query(
      `INSERT INTO sensor_events(tenant_id,device_id,sensor_type,value,recorded_at,metadata) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.user!.tenantId,body.device_id,body.sensor_type,body.value,recordedAt,body.metadata??{}],
    )).rows[0];
    await evaluateSensor(req,{device_id:body.device_id,sensor_type:body.sensor_type,value:body.value,recorded_at:recordedAt});
    publish(req.user!.tenantId,'sensor.updated',event,'telemetry:read');
    res.status(201).json(event);
  }catch(error){next(error);}
});

phase3Router.get('/positions',requirePermission('positions:read'),async(req,res,next)=>{
  try{
    const deviceId=req.query.device_id;
    const params=[req.user!.tenantId];
    const filter=typeof deviceId==='string'?(params.push(deviceId),' AND p.device_id=$2'):'';
    res.json((await query(`SELECT p.*,d.name device_name FROM device_positions p JOIN devices d ON d.id=p.device_id WHERE p.tenant_id=$1${filter} ORDER BY p.recorded_at DESC LIMIT 500`,params)).rows);
  }catch(error){next(error);}
});
phase3Router.post('/positions',requirePermission('positions:write'),async(req,res,next)=>{
  try{
    const body=z.object({device_id:uuid,latitude:z.number().min(-90).max(90),longitude:z.number().min(-180).max(180),accuracy_m:z.number().nonnegative().optional(),recorded_at:z.coerce.date().optional()}).strict().parse(req.body);
    if(!await deviceBelongsToTenant(body.device_id,req.user!.tenantId))return res.status(404).json({error:'Gerät nicht gefunden'});
    const position=(await query(
      `INSERT INTO device_positions(tenant_id,device_id,latitude,longitude,accuracy_m,recorded_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.user!.tenantId,body.device_id,body.latitude,body.longitude,body.accuracy_m??null,body.recorded_at??new Date()],
    )).rows[0];
    publish(req.user!.tenantId,'position.updated',position,'positions:read');
    res.status(201).json(position);
  }catch(error){next(error);}
});
phase3Router.get('/map-data',requirePermission('positions:read'),async(req,res,next)=>{
  try{
    const positions=(await query(`SELECT DISTINCT ON (p.device_id) p.*,d.name device_name FROM device_positions p JOIN devices d ON d.id=p.device_id WHERE p.tenant_id=$1 ORDER BY p.device_id,p.recorded_at DESC`,[req.user!.tenantId])).rows;
    const alarms=(await query(`SELECT a.id,a.device_id,a.site_id,a.description,a.status,p.name priority_name,p.color FROM alarms a LEFT JOIN alarm_priorities p ON p.id=a.priority_id WHERE a.tenant_id=$1 AND a.status IN ('open','acknowledged','escalated') ORDER BY a.triggered_at DESC`,[req.user!.tenantId])).rows;
    res.json({positions,alarms});
  }catch(error){next(error);}
});

phase3Router.get('/incidents',requirePermission('incidents:read'),async(req,res,next)=>{
  try{res.json((await query(`SELECT i.*,p.name priority_name,s.name site_name,e.name employee_name,COALESCE(json_agg(json_build_object('id',ae.id,'name',ae.name)) FILTER (WHERE ae.id IS NOT NULL),'[]') assignees FROM incidents i LEFT JOIN alarm_priorities p ON p.id=i.priority_id LEFT JOIN sites s ON s.id=i.site_id LEFT JOIN employees e ON e.id=i.employee_id LEFT JOIN incident_assignments ia ON ia.incident_id=i.id LEFT JOIN employees ae ON ae.id=ia.employee_id WHERE i.tenant_id=$1 GROUP BY i.id,p.name,s.name,e.name ORDER BY i.created_at DESC`,[req.user!.tenantId])).rows);}catch(error){next(error);}
});
phase3Router.post('/incidents',requirePermission('incidents:write'),async(req,res,next)=>{
  try{
    const body=z.object({alarm_id:uuid.nullable().optional(),site_id:uuid.nullable().optional(),employee_id:uuid.nullable().optional(),priority_id:uuid,description:nonempty}).strict().parse(req.body);
    const priority=(await query('SELECT id FROM alarm_priorities WHERE id=$1 AND tenant_id=$2',[body.priority_id,req.user!.tenantId])).rows[0];
    if(!priority)return res.status(404).json({error:'Priorität nicht gefunden'});
    if(body.alarm_id&&!(await query('SELECT id FROM alarms WHERE id=$1 AND tenant_id=$2',[body.alarm_id,req.user!.tenantId])).rows[0])return res.status(404).json({error:'Alarm nicht gefunden'});
    if(body.site_id&&!(await query('SELECT id FROM sites WHERE id=$1 AND tenant_id=$2',[body.site_id,req.user!.tenantId])).rows[0])return res.status(404).json({error:'Objekt nicht gefunden'});
    if(body.employee_id&&!(await query('SELECT id FROM employees WHERE id=$1 AND tenant_id=$2',[body.employee_id,req.user!.tenantId])).rows[0])return res.status(404).json({error:'Mitarbeiter nicht gefunden'});
    const incident=(await query(`INSERT INTO incidents(tenant_id,alarm_id,site_id,employee_id,priority_id,description,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[req.user!.tenantId,body.alarm_id??null,body.site_id??null,body.employee_id??null,body.priority_id,body.description,req.user!.id])).rows[0];
    await query(`INSERT INTO incident_history(incident_id,tenant_id,to_status,changed_by) VALUES($1,$2,'initiated',$3)`,[incident.id,req.user!.tenantId,req.user!.id]);
    publish(req.user!.tenantId,'incident.created',incident,'incidents:read');
    void queueNotificationEvent(req.user!.tenantId,'incident.created',`incident:${incident.id}`,'Neuer Einsatz',body.description,'incident',incident.id).catch(()=>undefined);
    res.status(201).json(incident);
  }catch(error){next(error);}
});
phase3Router.post('/incidents/:id/assignments',requirePermission('incidents:write'),async(req,res,next)=>{
  try{
    const body=z.object({employee_id:uuid}).strict().parse(req.body);
    const employee=(await query<{id:string}>('SELECT id FROM employees WHERE id=$1 AND tenant_id=$2',[body.employee_id,req.user!.tenantId])).rows[0];
    if(!employee)return res.status(404).json({error:'Mitarbeiter nicht gefunden'});
    const assignment=(await query(`INSERT INTO incident_assignments(incident_id,employee_id,assigned_by) SELECT $1,$2,$3 WHERE EXISTS(SELECT 1 FROM incidents WHERE id=$1 AND tenant_id=$4) RETURNING *`,[req.params.id,body.employee_id,req.user!.id,req.user!.tenantId])).rows[0];
    if(!assignment)return res.status(404).json({error:'Vorfall nicht gefunden'});
    publish(req.user!.tenantId,'incident.assigned',assignment,'incidents:read');
    res.status(201).json(assignment);
  }catch(error){next(error);}
});
phase3Router.post('/incidents/:id/status',requirePermission('incidents:write'),async(req,res,next)=>{
  try{
    const body=z.object({status}).strict().parse(req.body);
    const current=(await query<{status:string}>('SELECT status FROM incidents WHERE id=$1 AND tenant_id=$2',[req.params.id,req.user!.tenantId])).rows[0];
    if(!current)return res.status(404).json({error:'Vorfall nicht gefunden'});
    const allowed:{[key:string]:string[]}={initiated:['en_route'],en_route:['on_site'],on_site:['completed'],completed:[]};
    if(!allowed[current.status]?.includes(body.status))return res.status(409).json({error:'Ungültiger Statuswechsel des Vorfalls'});
    const incident=(await query('UPDATE incidents SET status=$1,updated_at=now() WHERE id=$2 AND tenant_id=$3 RETURNING *',[body.status,req.params.id,req.user!.tenantId])).rows[0];
    await query(`INSERT INTO incident_history(incident_id,tenant_id,from_status,to_status,changed_by) VALUES($1,$2,$3,$4,$5)`,[req.params.id,req.user!.tenantId,current.status,body.status,req.user!.id]);
    publish(req.user!.tenantId,'incident.status_changed',incident,'incidents:read');
    void queueNotificationEvent(req.user!.tenantId,'incident.status_changed',`incident:${incident.id}:${body.status}`,'Einsatzstatus geändert',`Status: ${body.status}`,'incident',incident.id).catch(()=>undefined);
    res.json(incident);
  }catch(error){next(error);}
});
phase3Router.get('/incidents/:id/history',requirePermission('incidents:read'),async(req,res,next)=>{
  try{res.json((await query('SELECT h.* FROM incident_history h JOIN incidents i ON i.id=h.incident_id WHERE h.incident_id=$1 AND h.tenant_id=$2 ORDER BY h.created_at',[req.params.id,req.user!.tenantId])).rows);}catch(error){next(error);}
});
