import {Router} from 'express';
import type {RequestHandler,Response} from 'express';
import {z} from 'zod';
import {requireAuth,requireCsrf,requirePermission} from '../middleware/auth.js';
import {incidentAuthUser} from '../services/incident-access.js';
import {
  assignIncidentEmployee,changeIncidentStatus,createIncident,escalateIncident,getEscalationLog,
  getIncidentDetail,getIncidentNotifications,getIncidentReport,getIncidentStats,listIncidentDocuments,
  listIncidents,linkIncidentDocument,unlinkIncidentDocument,updateIncident,upsertIncidentReport,
} from '../services/incident-management.js';
import {
  acknowledgeIncidentAlarm,createIncidentAlarm,getAlarmHistory,listAlarms,listEscalationRules,
  listMeasures,patchEscalationRule,resolveIncidentAlarm,toggleEscalationRule,
} from '../services/incident-alarms.js';

const uuid=z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const nonempty=z.string().trim().min(1);
const pageFields={page:z.coerce.number().int().min(1).optional(),pageSize:z.coerce.number().int().min(1).max(200).optional(),page_size:z.coerce.number().int().min(1).max(200).optional()};
const paging=(input:{page?:number;pageSize?:number;page_size?:number})=>({
  page:input.page??1,pageSize:input.pageSize??input.page_size??25,
});
const setPaging=(res:Response,total:number,pageSize:number)=>{
  res.setHeader('X-Total-Count',String(total));
  res.setHeader('X-Page-Count',String(Math.max(1,Math.ceil(total/pageSize))));
};
const readScopes=['tenant','site','system'] as const;
const writeScopes=['tenant','site','system'] as const;

export const incidentManagementRouter=Router();
// Nur eigene Pfade authentifizieren; sonst würde jede /api/v1-Anfrage die
// Session mehrfach laden, weil dieser Router global montiert ist.
incidentManagementRouter.use((req,res,next)=>/^\/einsatz(?:\/|$)/.test(req.path)
  ?requireAuth(req,res,()=>['POST','PUT','PATCH','DELETE'].includes(req.method)?requireCsrf(req,res,next):next())
  :next());

const incidentListQuery=z.object({
  q:z.string().trim().max(200).optional(),incident_type:z.string().trim().max(120).optional(),
  priority_code:z.enum(['critical','high','medium','low']).optional(),
  status:z.enum(['initiated','en_route','on_site','completed','cancelled']).optional(),
  site_id:uuid.optional(),customer_id:uuid.optional(),employee_id:uuid.optional(),
  from:z.coerce.date().optional(),to:z.coerce.date().optional(),
  sort:z.enum(['created_at','updated_at','incident_number','status','priority','type']).optional(),
  dir:z.enum(['asc','desc']).optional(),...pageFields,
}).strict();

incidentManagementRouter.get('/einsatz/incidents',requirePermission('incidents:read',{allowedScopes:[...readScopes]}),async(req,res,next)=>{
  try{
    const input=incidentListQuery.parse(req.query);
    const page=paging(input);
    const result=await listIncidents(incidentAuthUser(req),{
      q:input.q,incidentType:input.incident_type,priorityCode:input.priority_code,status:input.status,
      siteId:input.site_id,customerId:input.customer_id,employeeId:input.employee_id,
      from:input.from,to:input.to,sort:input.sort,dir:input.dir,...page,
    });
    setPaging(res,result.total,page.pageSize);
    res.setHeader('Cache-Control','no-store');
    res.json(result.rows);
  }catch(error){next(error);}
});

const createIncidentSchema=z.object({
  incident_type_code:nonempty.max(120),priority_id:uuid,description:nonempty.max(5000),
  customer_id:uuid.nullable().optional(),site_id:uuid.nullable().optional(),employee_id:uuid.nullable().optional(),
  alarm_id:uuid.nullable().optional(),source:z.string().trim().max(120).optional(),
  source_key:z.string().trim().min(1).max(240).optional(),client_mutation_id:uuid.optional(),
  reason:z.string().trim().max(1000).optional(),
}).strict();

incidentManagementRouter.post('/einsatz/incidents',requirePermission('incidents:write',{allowedScopes:[...writeScopes]}),async(req,res,next)=>{
  try{
    const body=createIncidentSchema.parse(req.body);
    const result=await createIncident(incidentAuthUser(req),body);
    res.status(result.replayed?200:201).json(result.row);
  }catch(error){next(error);}
});

incidentManagementRouter.get('/einsatz/incidents/:id',requirePermission('incidents:read',{allowedScopes:[...readScopes]}),async(req,res,next)=>{
  try{res.setHeader('Cache-Control','no-store');res.json(await getIncidentDetail(incidentAuthUser(req),String(req.params.id)));}catch(error){next(error);}
});

const updateIncidentSchema=z.object({
  description:nonempty.max(5000).optional(),priority_id:uuid.optional(),incident_type_code:nonempty.max(120).optional(),
  customer_id:uuid.nullable().optional(),site_id:uuid.nullable().optional(),employee_id:uuid.nullable().optional(),
  source:z.string().trim().max(120).optional(),reason:z.string().trim().max(1000).optional(),
}).strict().refine(value=>Object.keys(value).some(key=>key!=='reason'),{message:'Keine Änderung angegeben'});

incidentManagementRouter.patch('/einsatz/incidents/:id',requirePermission('incidents:write',{allowedScopes:[...writeScopes]}),async(req,res,next)=>{
  try{res.json(await updateIncident(incidentAuthUser(req),String(req.params.id),updateIncidentSchema.parse(req.body)));}catch(error){next(error);}
});

const statusSchema=z.object({
  status:z.enum(['en_route','on_site','completed','cancelled']),
  note:z.string().trim().max(2000).optional(),force:z.boolean().optional(),
  reason:z.string().trim().max(2000).optional(),
}).strict();

incidentManagementRouter.post('/einsatz/incidents/:id/status',requirePermission('incidents:write',{allowedScopes:[...writeScopes]}),async(req,res,next)=>{
  try{res.json(await changeIncidentStatus(incidentAuthUser(req),String(req.params.id),statusSchema.parse(req.body)));}catch(error){next(error);}
});

incidentManagementRouter.post('/einsatz/incidents/:id/assignments',requirePermission('incidents:write',{allowedScopes:[...writeScopes]}),async(req,res,next)=>{
  try{
    const {employee_id}=z.object({employee_id:uuid}).strict().parse(req.body);
    res.status(201).json(await assignIncidentEmployee(incidentAuthUser(req),String(req.params.id),employee_id));
  }catch(error){next(error);}
});

incidentManagementRouter.get('/einsatz/incidents/:id/documents',requirePermission('incident_documents:read',{allowedScopes:[...readScopes]}),async(req,res,next)=>{
  try{res.json(await listIncidentDocuments(incidentAuthUser(req),String(req.params.id)));}catch(error){next(error);}
});

const documentSchema=z.object({
  document_id:uuid,category:z.enum(['attachment','report','evidence']).optional(),
  note:z.string().trim().max(2000).nullable().optional(),
}).strict();

incidentManagementRouter.post('/einsatz/incidents/:id/documents',requirePermission('incident_documents:write',{allowedScopes:[...writeScopes]}),async(req,res,next)=>{
  try{
    const body=documentSchema.parse(req.body);
    res.status(201).json(await linkIncidentDocument(incidentAuthUser(req),String(req.params.id),body));
  }catch(error){next(error);}
});

const unlinkSchema=z.object({
  link_id:uuid.optional(),document_id:uuid.optional(),category:z.enum(['attachment','report','evidence']).optional(),
}).strict().refine(value=>Boolean(value.link_id||value.document_id),{message:'Dokumentverknüpfung nicht angegeben'});

incidentManagementRouter.delete('/einsatz/incidents/:id/documents',requirePermission('incident_documents:write',{allowedScopes:[...writeScopes]}),async(req,res,next)=>{
  try{
    const body=unlinkSchema.parse({...req.query,...req.body});
    res.json(await unlinkIncidentDocument(incidentAuthUser(req),String(req.params.id),body));
  }catch(error){next(error);}
});

incidentManagementRouter.delete('/einsatz/incidents/:id/documents/:linkId',requirePermission('incident_documents:write',{allowedScopes:[...writeScopes]}),async(req,res,next)=>{
  try{res.json(await unlinkIncidentDocument(incidentAuthUser(req),String(req.params.id),{link_id:String(req.params.linkId)}));}catch(error){next(error);}
});

incidentManagementRouter.get('/einsatz/incidents/:id/report',requirePermission('incident_reports:read',{allowedScopes:[...readScopes]}),async(req,res,next)=>{
  try{res.json(await getIncidentReport(incidentAuthUser(req),String(req.params.id)));}catch(error){next(error);}
});

const reportSchema=z.object({
  summary:z.string().trim().max(5000).optional(),cause:z.string().trim().max(5000).optional(),
  actions:z.string().trim().max(5000).optional(),result:z.string().trim().max(5000).optional(),
  document_id:uuid.optional(),
}).strict().refine(value=>Object.keys(value).length>0,{message:'Keine Änderung angegeben'});

incidentManagementRouter.patch('/einsatz/incidents/:id/report',requirePermission('incident_reports:write',{allowedScopes:[...writeScopes]}),async(req,res,next)=>{
  try{res.json(await upsertIncidentReport(incidentAuthUser(req),String(req.params.id),reportSchema.parse(req.body)));}catch(error){next(error);}
});

incidentManagementRouter.get('/einsatz/incidents/:id/escalations',requirePermission('escalation_log:read',{allowedScopes:[...readScopes]}),async(req,res,next)=>{
  try{res.json(await getEscalationLog(incidentAuthUser(req),String(req.params.id)));}catch(error){next(error);}
});

const escalateSchema=z.object({
  rule_id:uuid.optional(),target_status:z.enum(['escalated','acknowledged']).optional(),
  target_user_id:uuid.nullable().optional(),reason:z.string().trim().max(2000).optional(),
}).strict();

incidentManagementRouter.post('/einsatz/incidents/:id/escalations',requirePermission('incidents:escalate',{allowedScopes:[...writeScopes]}),async(req,res,next)=>{
  try{res.status(201).json(await escalateIncident(incidentAuthUser(req),String(req.params.id),escalateSchema.parse(req.body)));}catch(error){next(error);}
});

const alarmListQuery=z.object({
  q:z.string().trim().max(200).optional(),status:z.enum(['open','acknowledged','escalated','resolved']).optional(),
  severity:z.enum(['critical','high','medium','low']).optional(),site_id:uuid.optional(),
  priority_code:z.enum(['critical','high','medium','low']).optional(),
  from:z.coerce.date().optional(),to:z.coerce.date().optional(),
  sort:z.enum(['triggered_at','created_at','status','severity','site']).optional(),
  dir:z.enum(['asc','desc']).optional(),...pageFields,
}).strict();

incidentManagementRouter.get('/einsatz/alarms',requirePermission('alarms:read',{allowedScopes:[...readScopes]}),async(req,res,next)=>{
  try{
    const input=alarmListQuery.parse(req.query);
    const page=paging(input);
    const result=await listAlarms(incidentAuthUser(req),{
      q:input.q,status:input.status,severity:input.severity,siteId:input.site_id,priorityCode:input.priority_code,
      from:input.from,to:input.to,sort:input.sort,dir:input.dir,...page,
    });
    setPaging(res,result.total,page.pageSize);
    res.setHeader('Cache-Control','no-store');
    res.json(result.rows);
  }catch(error){next(error);}
});

const createAlarmSchema=z.object({
  type:nonempty.max(120).optional(),priority_id:uuid.optional(),
  priority_code:z.enum(['critical','high','medium','low']).optional(),
  source:z.string().trim().max(120).optional(),description:nonempty.max(5000),
  site_id:uuid.nullable().optional(),employee_id:uuid.nullable().optional(),device_id:uuid.nullable().optional(),
  source_key:z.string().trim().min(1).max(240).optional(),client_mutation_id:uuid.optional(),
  reason:z.string().trim().max(1000).optional(),
}).strict();

incidentManagementRouter.post('/einsatz/alarms',requirePermission('alarms:write',{allowedScopes:[...writeScopes]}),async(req,res,next)=>{
  try{
    const result=await createIncidentAlarm(incidentAuthUser(req),createAlarmSchema.parse(req.body));
    res.status(result.replayed?200:201).json(result.row);
  }catch(error){next(error);}
});

incidentManagementRouter.post('/einsatz/alarms/:id/acknowledge',requirePermission('alarms:write',{allowedScopes:[...writeScopes]}),async(req,res,next)=>{
  try{res.json(await acknowledgeIncidentAlarm(incidentAuthUser(req),String(req.params.id)));}catch(error){next(error);}
});

incidentManagementRouter.post('/einsatz/alarms/:id/resolve',requirePermission('alarms:write',{allowedScopes:[...writeScopes]}),async(req,res,next)=>{
  try{
    const {reason}=z.object({reason:nonempty.max(2000)}).strict().parse(req.body);
    res.json(await resolveIncidentAlarm(incidentAuthUser(req),String(req.params.id),reason));
  }catch(error){next(error);}
});

incidentManagementRouter.get('/einsatz/alarms/:id/history',requirePermission('alarms:read',{allowedScopes:[...readScopes]}),async(req,res,next)=>{
  try{res.json(await getAlarmHistory(incidentAuthUser(req),String(req.params.id)));}catch(error){next(error);}
});

const measureListQuery=z.object({
  q:z.string().trim().max(200).optional(),
  status:z.enum(['open','in_progress','on_hold','done','cancelled']).optional(),
  module:z.enum(['leitstelle','einsatz','schicht','objekt','mitarbeiter','qualifikation','dokument','nfc','schluessel','kunde','system']).optional(),
  site_id:uuid.optional(),incident_id:uuid.optional(),overdue:z.coerce.boolean().optional(),...pageFields,
}).strict();

incidentManagementRouter.get('/einsatz/measures',requirePermission('operations_measures:read',{allowedScopes:[...readScopes]}),async(req,res,next)=>{
  try{
    const input=measureListQuery.parse(req.query);
    const page=paging(input);
    const result=await listMeasures(incidentAuthUser(req),{q:input.q,status:input.status,module:input.module,
      siteId:input.site_id,incidentId:input.incident_id,overdue:input.overdue,...page});
    setPaging(res,result.total,page.pageSize);
    res.json(result.rows);
  }catch(error){next(error);}
});

incidentManagementRouter.get('/einsatz/escalation-rules',requirePermission('escalation_rules:read',{allowedScopes:[...readScopes]}),async(req,res,next)=>{
  try{res.json(await listEscalationRules(incidentAuthUser(req)));}catch(error){next(error);}
});

const ruleSchema=z.object({
  enabled:z.boolean().optional(),target_status:z.enum(['escalated','acknowledged']).optional(),
  notify_enabled:z.boolean().optional(),target_user_id:uuid.nullable().optional(),
  reason:z.string().trim().max(1000).optional(),
}).strict();

incidentManagementRouter.patch('/einsatz/escalation-rules/:id',requirePermission('escalation_rules:write',{allowedScopes:[...writeScopes]}),async(req,res,next)=>{
  try{res.json(await patchEscalationRule(incidentAuthUser(req),String(req.params.id),ruleSchema.parse(req.body)));}catch(error){next(error);}
});

const toggleRuleHandler:RequestHandler=async(req,res,next)=>{
  try{
    const body=z.object({reason:z.string().trim().max(1000).optional()}).strict().parse(req.body??{});
    res.json(await toggleEscalationRule(incidentAuthUser(req),String(req.params.id),body));
  }catch(error){next(error);}
};
incidentManagementRouter.post('/einsatz/escalation-rules/:id/toggle',
  requirePermission('escalation_rules:write',{allowedScopes:[...writeScopes]}),toggleRuleHandler);
incidentManagementRouter.patch('/einsatz/escalation-rules/:id/toggle',
  requirePermission('escalation_rules:write',{allowedScopes:[...writeScopes]}),toggleRuleHandler);

incidentManagementRouter.get('/einsatz/notifications/:incidentId',requirePermission('notifications:read',{allowedScopes:[...readScopes]}),async(req,res,next)=>{
  try{res.json(await getIncidentNotifications(incidentAuthUser(req),String(req.params.incidentId)));}catch(error){next(error);}
});

const reportQuery=z.object({
  from:z.coerce.date().optional(),to:z.coerce.date().optional(),site_id:uuid.optional(),
  incident_type:z.string().trim().max(120).optional(),format:z.enum(['json','csv']).optional(),
}).strict();

function csvCell(value:unknown){
  const text=value===null||value===undefined?'':String(value);
  return /[",\n;]/.test(text)?`"${text.replace(/"/g,'""')}"`:text;
}

incidentManagementRouter.get('/einsatz/reports',requirePermission('einsatz:reports:read',{allowedScopes:[...readScopes]}),async(req,res,next)=>{
  try{
    const input=reportQuery.parse(req.query);
    const data=await getIncidentStats(incidentAuthUser(req),{
      from:input.from,to:input.to,siteId:input.site_id,incidentType:input.incident_type,
    });
    const wantsCsv=input.format==='csv'||String(req.headers.accept??'').includes('text/csv');
    if(!wantsCsv){res.setHeader('Cache-Control','no-store');return res.json(data);}
    const header=['objekt_id','objekt','vorfaelle','alarme','eskalationen','offene_massnahmen',
      'durchschnitt_bestaetigung_min','durchschnitt_loesung_min'];
    const lines=data.by_site.map(row=>[row.site_id,row.site_name,row.incidents,row.alarms,row.escalations,
      row.open_measures,row.avg_minutes_to_acknowledge??'',row.avg_minutes_to_resolve??''].map(csvCell).join(';'));
    const totals=data.totals;
    lines.push(['GESAMT','',totals.incidents,totals.alarms,totals.escalations,totals.open_measures,
      totals.avg_minutes_to_acknowledge??'',totals.avg_minutes_to_resolve??''].map(csvCell).join(';'));
    res.setHeader('Content-Type','text/csv; charset=utf-8');
    res.setHeader('Content-Disposition','attachment; filename="einsatzbericht.csv"');
    res.send([header.join(';'),...lines].join('\n'));
  }catch(error){next(error);}
});
