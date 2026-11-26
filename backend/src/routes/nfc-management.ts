import {Router} from 'express';
import {z} from 'zod';
import type {PoolClient} from 'pg';
import {query,withTransaction} from '../db/pool.js';
import {requireAuth,requireCsrf,requirePermission} from '../middleware/auth.js';
import {recordAudit} from '../services/audit.js';
import {effectivePermissionScope,normalizePermissionGrants} from '../types/authorization.js';

type Row=Record<string,unknown>;
const uuid=z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const nonempty=z.string().trim().min(1).max(200);
const reason=z.string().trim().min(3).max(2000);
const deviceType=z.enum(['tag','reader']);
const deviceStatus=z.enum(['active','lost','blocked','replaced']);
type TargetKey='employee_id'|'site_id'|'control_point_id';

const read=requirePermission('nfc_devices:read');
const write=requirePermission('nfc_devices:write');
const security=requirePermission('nfc_devices:security');

export const nfcManagementRouter=Router();
nfcManagementRouter.use((req,res,next)=>/^\/nfc-devices/.test(req.path)
  ? requireAuth(req,res,()=>['POST','PATCH','PUT','DELETE'].includes(req.method)?requireCsrf(req,res,next):next())
  : next());

function fail(status:number,message:string,code?:string):never{
  throw Object.assign(new Error(message),{status,...(code?{code}:{})});
}

function deviceId(req:{params:Record<string,string|string[]>}):string{
  const parsed=uuid.safeParse(String(req.params.id));
  if(!parsed.success)fail(400,'Ungültige NFC-Gerätekennung');
  return parsed.data;
}

function assignmentOf(row:Row):{employee_id:string|null;site_id:string|null;control_point_id:string|null}{
  return {
    employee_id:(row.employee_id as string|null)??null,
    site_id:(row.site_id as string|null)??null,
    control_point_id:(row.control_point_id as string|null)??null,
  };
}

function dateBoundary(value:unknown,endOfDay=false):string|null{
  if(typeof value!=='string'||!value.trim())return null;
  const input=value.trim();
  if(/^\d{4}-\d{2}-\d{2}$/.test(input))return `${input}T${endOfDay?'23:59:59.999':'00:00:00.000'}Z`;
  const parsed=new Date(input);
  return Number.isNaN(parsed.getTime())?null:parsed.toISOString();
}

function hasAssignment(value:Record<string,string|null>):boolean{
  return Boolean(value.employee_id||value.site_id||value.control_point_id);
}

const targetTables:Record<TargetKey,string>={
  employee_id:'employees',site_id:'sites',control_point_id:'control_points',
};

function assertNotArchived(device:Row):void{
  if(device.archived_at)fail(409,'NFC-Gerät ist archiviert und kann nicht verändert werden');
}

async function assertControlPointAvailable(client:PoolClient,tenantId:string,controlPointId:string,excludeDeviceId?:string):Promise<void>{
  const occupied=(await client.query<Row>(`SELECT id FROM nfc_devices
    WHERE tenant_id=$1 AND control_point_id=$2 AND status='active' AND archived_at IS NULL AND id<>$3 LIMIT 1`,
    [tenantId,controlPointId,excludeDeviceId??''])).rows[0];
  if(occupied)fail(409,'Dieser Kontrollpunkt ist bereits einem aktiven NFC-Tag zugeordnet');
}

async function targetInfo(client:PoolClient|null,tenantId:string,key:TargetKey,id:string):Promise<Row>{
  const run=client?client.query.bind(client):query;
  const column=key==='control_point_id'?'cp.site_id':key==='site_id'?'t.id':'NULL';
  const join=key==='control_point_id'?'JOIN control_points cp ON cp.id=t.id AND cp.tenant_id=t.tenant_id':'';
  const result=await run(`SELECT t.id,${column} AS site_id FROM ${targetTables[key]} t ${join} WHERE t.tenant_id=$1 AND t.id=$2`,[tenantId,id]);
  const row=(result as {rows:Row[]}).rows[0];
  if(!row)fail(404,'Zuordnungsziel nicht gefunden');
  return row;
}

const deviceSelect=`SELECT n.*,e.name employee_name,COALESCE(s.name,cp_site.name) site_name,cp.name control_point_name,cp.site_id control_point_site_id,
  (SELECT MAX(ps.server_received_at) FROM patrol_scans ps WHERE ps.tenant_id=n.tenant_id AND ps.nfc_device_id=n.id) last_used_at
  FROM nfc_devices n
  LEFT JOIN employees e ON e.tenant_id=n.tenant_id AND e.id=n.employee_id
  LEFT JOIN sites s ON s.tenant_id=n.tenant_id AND s.id=n.site_id
  LEFT JOIN control_points cp ON cp.tenant_id=n.tenant_id AND cp.id=n.control_point_id
  LEFT JOIN sites cp_site ON cp_site.tenant_id=n.tenant_id AND cp_site.id=cp.site_id`;

nfcManagementRouter.get('/nfc-devices/overview',read,async(req,res,next)=>{
  try{
    const days=Math.min(Math.max(Number.parseInt(String(req.query.days??'30'),10)||30,1),365);
    const tenantId=req.user!.tenantId;
    const [totals,scans,recent]=await Promise.all([
      query<Row>(`SELECT count(*)::int total,
        count(*) FILTER (WHERE status='active' AND device_type='tag' AND archived_at IS NULL)::int active_tags,
        count(*) FILTER (WHERE status='active' AND device_type='reader' AND archived_at IS NULL)::int active_readers,
        count(*) FILTER (WHERE status='blocked')::int blocked,
        count(*) FILTER (WHERE status='lost')::int lost,
        count(*) FILTER (WHERE status='replaced')::int replaced,
        count(*) FILTER (WHERE archived_at IS NOT NULL)::int archived,
        count(*) FILTER (WHERE employee_id IS NULL AND site_id IS NULL AND control_point_id IS NULL)::int unassigned
        FROM nfc_devices WHERE tenant_id=$1`,[tenantId]),
      query<Row>(`SELECT count(*)::int scans, count(DISTINCT nfc_device_id)::int devices FROM patrol_scans
        WHERE tenant_id=$1 AND nfc_device_id IS NOT NULL AND server_received_at >= now()-($2::int * interval '1 day')`,[tenantId,days]),
      query<Row>(`SELECT n.id,n.identifier,n.device_type,n.status,n.updated_at,MAX(ps.server_received_at) last_used_at
        FROM nfc_devices n JOIN patrol_scans ps ON ps.tenant_id=n.tenant_id AND ps.nfc_device_id=n.id
        WHERE n.tenant_id=$1 GROUP BY n.id ORDER BY last_used_at DESC LIMIT 5`,[tenantId]),
    ]);
    res.json({
      ...totals.rows[0],...scans.rows[0],recent_devices:Number(scans.rows[0]?.devices??0),days,recent:recent.rows,
    });
  }catch(error){next(error);}
});

nfcManagementRouter.get('/nfc-devices/filter-options',read,async(req,res,next)=>{
  try{
    const tenantId=req.user!.tenantId;
    const [sites,controlPoints,employees,devices]=await Promise.all([
      query<Row>('SELECT id,name FROM sites WHERE tenant_id=$1 ORDER BY name',[tenantId]),
      query<Row>(`SELECT cp.id,cp.site_id,cp.name,s.name site_name FROM control_points cp
        JOIN sites s ON s.tenant_id=cp.tenant_id AND s.id=cp.site_id
        WHERE cp.tenant_id=$1 ORDER BY s.name,cp.sequence,cp.name`,[tenantId]),
      query<Row>('SELECT id,name FROM employees WHERE tenant_id=$1 ORDER BY name',[tenantId]),
      query<Row>(`SELECT n.id,n.identifier,n.device_type,n.manufacturer,n.status,
        n.employee_id,n.site_id,n.control_point_id,
        e.name employee_name,COALESCE(s.name,cp_site.name) site_name,cp.name control_point_name
        FROM nfc_devices n
        LEFT JOIN employees e ON e.tenant_id=n.tenant_id AND e.id=n.employee_id
        LEFT JOIN sites s ON s.tenant_id=n.tenant_id AND s.id=n.site_id
        LEFT JOIN control_points cp ON cp.tenant_id=n.tenant_id AND cp.id=n.control_point_id
        LEFT JOIN sites cp_site ON cp_site.tenant_id=n.tenant_id AND cp_site.id=cp.site_id
        WHERE n.tenant_id=$1 AND n.archived_at IS NULL AND n.status<>'replaced' ORDER BY n.identifier`,[tenantId]),
    ]);
    res.json({sites:sites.rows,control_points:controlPoints.rows,employees:employees.rows,devices:devices.rows});
  }catch(error){next(error);}
});

nfcManagementRouter.get('/nfc-devices/inventory',read,async(req,res,next)=>{
  try{
    const tenantId=req.user!.tenantId;
    const values:unknown[]=[tenantId];
    const conditions:string[]=['n.tenant_id=$1'];
    const add=(condition:string,value:unknown)=>{values.push(value);conditions.push(condition.replace('__P__',`$${values.length}`));};
    const q=typeof req.query.q==='string'?req.query.q.trim():'';
    if(q)add('n.identifier ILIKE __P__',`%${q}%`);
    const type=deviceType.safeParse(req.query.device_type);
    if(type.success)add('n.device_type=__P__',type.data);
    const status=deviceStatus.safeParse(req.query.status);
    if(status.success)add('n.status=__P__',status.data);
    const siteId=uuid.safeParse(req.query.site_id);
    if(siteId.success){values.push(siteId.data);conditions.push(`(n.site_id=$${values.length} OR cp.site_id=$${values.length})`);}
    const controlPointId=uuid.safeParse(req.query.control_point_id);
    if(controlPointId.success)add('n.control_point_id=__P__',controlPointId.data);
    const employeeId=uuid.safeParse(req.query.employee_id);
    if(employeeId.success)add('n.employee_id=__P__',employeeId.data);
    const assignment=req.query.assignment;
    if(assignment==='assigned')conditions.push('num_nonnulls(n.employee_id,n.site_id,n.control_point_id)>0');
    if(assignment==='unassigned')conditions.push('num_nonnulls(n.employee_id,n.site_id,n.control_point_id)=0');
    if(req.query.archived==='true')conditions.push('n.archived_at IS NOT NULL');
    if(req.query.archived==='false')conditions.push('n.archived_at IS NULL');
    if(req.query.recent==='true')conditions.push(`EXISTS (SELECT 1 FROM patrol_scans ps WHERE ps.tenant_id=$1
      AND ps.nfc_device_id=n.id AND ps.server_received_at >= now() - interval '30 days')`);
    const where=`WHERE ${conditions.join(' AND ')}`;
    const sortMap:Record<string,string>={
      identifier:'n.identifier',device_type:'n.device_type',manufacturer:'n.manufacturer',status:'n.status',
      site_name:'s.name',control_point_name:'cp.name',employee_name:'e.name',registered_at:'n.registered_at',
      updated_at:'n.updated_at',
      last_used_at:'(SELECT MAX(ps.server_received_at) FROM patrol_scans ps WHERE ps.tenant_id=n.tenant_id AND ps.nfc_device_id=n.id)',
    };
    const sort=sortMap[String(req.query.sort??'updated_at')]??sortMap.updated_at;
    const direction=req.query.dir==='asc'?'ASC':'DESC';
    const page=Math.max(Number.parseInt(String(req.query.page??'1'),10)||1,1);
    const pageSize=Math.min(Math.max(Number.parseInt(String(req.query.pageSize??'25'),10)||25,5),100);
    const count=(await query<Row>(`SELECT count(*)::int total FROM nfc_devices n
      LEFT JOIN sites s ON s.tenant_id=n.tenant_id AND s.id=n.site_id
      LEFT JOIN control_points cp ON cp.tenant_id=n.tenant_id AND cp.id=n.control_point_id ${where}`,values)).rows[0];
    const rows=(await query<Row>(`${deviceSelect} ${where}
      ORDER BY ${sort} ${direction}, n.identifier ASC LIMIT $${values.length+1} OFFSET $${values.length+2}`,
      [...values,pageSize,(page-1)*pageSize])).rows;
    const total=Number(count?.total??0);
    res.set('X-Total-Count',String(total));
    res.json({rows,total,page,pageSize,totalPages:Math.max(1,Math.ceil(total/pageSize))});
  }catch(error){next(error);}
});

/**
 * Vollständige, filter- und seitenweise Scan-Historie eines Geräts.
 * Erfolgreiche Scans kommen aus patrol_scans, abgelehnte Scans aus den
 * revisionssicheren patrol.scan.rejected-Auditereignissen. Es werden keine
 * Ereignisse künstlich erzeugt.
 */
nfcManagementRouter.get('/nfc-devices/:id/scan-history',read,async(req,res,next)=>{
  try{
    const tenantId=req.user!.tenantId;
    const id=deviceId(req);
    if(!(await query<Row>('SELECT id FROM nfc_devices WHERE tenant_id=$1 AND id=$2',[tenantId,id])).rows[0]){
      fail(404,'NFC-Gerät nicht gefunden');
    }
    const timestamp=(key:string)=>`CASE WHEN a.details->>'${key}' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
      THEN (a.details->>'${key}')::timestamptz ELSE NULL END`;
    const eventsCte=`WITH events AS (
      SELECT 'accepted'::text outcome,ps.id::text id,n.identifier nfc_uid,n.id::text nfc_device_id,
        ps.control_point_id::text control_point_id,cp.name control_point_name,
        cp.site_id::text site_id,s.name site_name,
        ps.route_id::text route_id,r.name route_name,
        ps.employee_id::text employee_id,e.name employee_name,
        ps.scanned_at,ps.server_received_at,ps.scan_authentication,ps.deviation,
        NULL::text rejection_reason,NULL::text rejection_code,NULL::text actor_email,
        COALESCE(ps.scanned_at,ps.server_received_at) effective_at
      FROM patrol_scans ps
      JOIN nfc_devices n ON n.tenant_id=ps.tenant_id AND n.id=ps.nfc_device_id
      LEFT JOIN control_points cp ON cp.tenant_id=ps.tenant_id AND cp.id=ps.control_point_id
      LEFT JOIN sites s ON s.tenant_id=ps.tenant_id AND s.id=cp.site_id
      LEFT JOIN patrol_routes r ON r.tenant_id=ps.tenant_id AND r.id=ps.route_id
      LEFT JOIN employees e ON e.tenant_id=ps.tenant_id AND e.id=ps.employee_id
      WHERE ps.tenant_id=$1 AND ps.nfc_device_id=$2
      UNION ALL
      SELECT 'rejected'::text,a.id::text,
        COALESCE(NULLIF(a.details->>'nfc_uid',''),n.identifier),
        COALESCE(NULLIF(a.details->>'nfc_device_id',''),n.id::text),
        NULLIF(a.details->>'control_point_id',''),cp.name,
        NULLIF(a.details->>'site_id',''),s.name,
        NULLIF(a.details->>'route_id',''),r.name,
        NULLIF(a.details->>'employee_id',''),e.name,
        ${timestamp('scanned_at')},
        COALESCE(${timestamp('server_received_at')},a.created_at),
        NULL::text,NULL::text,
        NULLIF(a.details->>'reason',''),NULLIF(a.details->>'code',''),
        u.email,
        COALESCE(${timestamp('scanned_at')},${timestamp('server_received_at')},a.created_at)
      FROM audit_events a
      LEFT JOIN nfc_devices n ON n.tenant_id=a.tenant_id AND n.id=$2 AND (
        NULLIF(a.details->>'nfc_device_id','')=$2::text
        OR NULLIF(a.details->>'nfc_uid','') IN (
          SELECT identifier FROM nfc_devices WHERE tenant_id=$1 AND id=$2
          UNION SELECT NULLIF(details->>'previous_identifier','') FROM audit_events
            WHERE tenant_id=$1 AND entity_type='nfc_device' AND entity_id=$2))
      LEFT JOIN control_points cp ON cp.tenant_id=a.tenant_id AND cp.id::text=NULLIF(a.details->>'control_point_id','')
      LEFT JOIN sites s ON s.tenant_id=a.tenant_id AND s.id::text=NULLIF(a.details->>'site_id','')
      LEFT JOIN patrol_routes r ON r.tenant_id=a.tenant_id AND r.id::text=NULLIF(a.details->>'route_id','')
      LEFT JOIN employees e ON e.tenant_id=a.tenant_id AND e.id::text=NULLIF(a.details->>'employee_id','')
      LEFT JOIN users u ON u.tenant_id=a.tenant_id AND u.id=a.actor_user_id
      WHERE a.tenant_id=$1 AND a.event_type='patrol.scan.rejected'
        AND (NULLIF(a.details->>'nfc_device_id','')=$2::text
          OR NULLIF(a.details->>'nfc_uid','') IN (
            SELECT identifier FROM nfc_devices WHERE tenant_id=$1 AND id=$2
            UNION SELECT NULLIF(details->>'previous_identifier','') FROM audit_events
              WHERE tenant_id=$1 AND entity_type='nfc_device' AND entity_id=$2))
    )`;
    const values:unknown[]=[tenantId,id];
    const conditions:string[]=[];
    const add=(condition:string,value:unknown)=>{values.push(value);conditions.push(condition.replace('__P__',`$${values.length}`));};
    const from=dateBoundary(req.query.from,false);
    const to=dateBoundary(req.query.to,true);
    if(from)add('effective_at >= __P__::timestamptz',from);
    if(to)add('effective_at <= __P__::timestamptz',to);
    const controlPointId=uuid.safeParse(req.query.control_point_id);
    if(controlPointId.success)add('control_point_id=__P__',controlPointId.data);
    const siteId=uuid.safeParse(req.query.site_id);
    if(siteId.success)add('site_id=__P__',siteId.data);
    const employeeId=uuid.safeParse(req.query.employee_id);
    if(employeeId.success)add('employee_id=__P__',employeeId.data);
    const outcome=z.enum(['accepted','rejected']).safeParse(req.query.outcome);
    if(outcome.success)add('outcome=__P__',outcome.data);
    const where=conditions.length?`WHERE ${conditions.join(' AND ')}`:'';
    const page=Math.max(Number.parseInt(String(req.query.page??'1'),10)||1,1);
    const pageSize=Math.min(Math.max(Number.parseInt(String(req.query.pageSize??'25'),10)||25,5),100);
    const count=(await query<Row>(`${eventsCte} SELECT count(*)::int total FROM events ${where}`,values)).rows[0];
    const rows=(await query<Row>(`${eventsCte} SELECT * FROM events ${where}
      ORDER BY effective_at DESC, id DESC LIMIT $${values.length+1} OFFSET $${values.length+2}`,
      [...values,pageSize,(page-1)*pageSize])).rows;
    const total=Number(count?.total??0);
    res.set('X-Total-Count',String(total));
    res.json({rows,total,page,pageSize,totalPages:Math.max(1,Math.ceil(total/pageSize))});
  }catch(error){next(error);}
});

nfcManagementRouter.get('/nfc-devices/:id/file',read,async(req,res,next)=>{
  try{
    const tenantId=req.user!.tenantId;
    const id=deviceId(req);
    const device=(await query<Row>(`${deviceSelect} WHERE n.tenant_id=$1 AND n.id=$2`,[tenantId,id])).rows[0];
    if(!device)fail(404,'NFC-Gerät nicht gefunden');
    const user=req.user!;
    const grants=normalizePermissionGrants(user.permissionGrants,user.permissions);
    const context={role:user.role,isSystemAdmin:user.isSystemAdmin===true};
    const dmsScope=effectivePermissionScope(grants,'dms:read',context);
    const auditScope=effectivePermissionScope(grants,'audit:read',context);
    // Scan-Nachweise werden ausschließlich über /scan-history mit Filtern und
    // Pagination ausgeliefert. Die Geräteakte enthält nur Stammdaten und
    // Historien; dadurch können keine Ereignisse durch ein LIMIT verloren gehen.
    const [assignments,replacements,documents,audit]=await Promise.all([
      query<Row>(`SELECT h.*,u.email actor_email FROM nfc_device_assignment_history h
        LEFT JOIN users u ON u.tenant_id=h.tenant_id AND u.id=h.actor_user_id
        WHERE h.tenant_id=$1 AND h.device_id=$2 ORDER BY h.assigned_at DESC LIMIT 100`,[tenantId,id]),
      query<Row>(`SELECT r.*,u.email actor_email FROM nfc_device_replacements r
        LEFT JOIN users u ON u.tenant_id=r.tenant_id AND u.id=r.actor_user_id
        WHERE r.tenant_id=$1 AND (r.old_device_id=$2 OR r.new_device_id=$2) ORDER BY r.replaced_at DESC LIMIT 100`,[tenantId,id]),
      query<Row>(`SELECT d.id,d.title,d.document_type,d.document_number,d.approval_status,d.created_at,d.created_by,
        COALESCE(json_agg(json_build_object('id',v.id,'version_no',v.version_no,'lifecycle_state',v.lifecycle_state) ORDER BY v.version_no DESC)
          FILTER (WHERE v.id IS NOT NULL),'[]') versions
        FROM dms_documents d LEFT JOIN dms_versions v ON v.tenant_id=d.tenant_id AND v.document_id=d.id
          AND v.lifecycle_state='available'
        WHERE d.tenant_id=$1 AND d.nfc_device_id=$2
          AND d.document_status='active' AND d.deleted_at IS NULL AND d.approval_status='approved'
          ${dmsScope==='site'?' AND d.site_id = ANY($3::uuid[])':dmsScope==='own'?' AND d.created_by=$3':''}
        GROUP BY d.id ORDER BY d.created_at DESC`,
        dmsScope==='site'?[tenantId,id,user.siteIds??[]]:dmsScope==='own'?[tenantId,id,user.id]:[tenantId,id]),
      query<Row>(`SELECT a.id,a.event_type,a.entity_type,a.details,a.created_at,a.actor_user_id,u.email actor_email
        FROM audit_events a LEFT JOIN users u ON u.tenant_id=a.tenant_id AND u.id=a.actor_user_id
        WHERE a.tenant_id=$1 AND a.entity_type='nfc_device' AND a.entity_id=$2 ORDER BY a.created_at DESC`,[tenantId,id]),
    ]);
    const availableDocuments=dmsScope?documents.rows.map(row=>({
      ...row,
      versions:((row.versions as Row[])??[]).filter(version=>version.lifecycle_state==='available'),
    })).filter(row=>(row.versions as Row[]).length>0):[];
    const history=audit.rows.filter(row=>{
      if(!auditScope)return false;
      if(auditScope==='own')return row.actor_user_id===user.id;
      if(auditScope==='site'){
        const siteId=((row.details??{}) as Row).site_id;
        return typeof siteId==='string'&&(user.siteIds??[]).includes(siteId);
      }
      return true;
    }).map(row=>auditScope==='site'?{...row,actor_user_id:null,actor_email:null}:row);
    res.json({
      device,
      assignment_history:assignments.rows,
      replacements:replacements.rows,
      documents:availableDocuments,
      history,
    });
  }catch(error){next(error);}
});

nfcManagementRouter.post('/nfc-devices/:id/assign',write,async(req,res,next)=>{
  try{
    const tenantId=req.user!.tenantId;
    const id=deviceId(req);
    const body=z.object({
      employee_id:uuid.nullable().optional(),site_id:uuid.nullable().optional(),control_point_id:uuid.nullable().optional(),
      reason:z.string().trim().max(2000).optional(),
    }).strict().parse(req.body);
    const provided=Object.entries({employee_id:body.employee_id,site_id:body.site_id,control_point_id:body.control_point_id})
      .filter(([,value])=>value!==undefined) as [TargetKey,string|null][];
    if(provided.length>1)fail(400,'Es ist nur ein NFC-Zuordnungsziel erlaubt');
    if(!provided.length)fail(400,'Bitte ein Zuordnungsziel oder die Aufhebung der Zuordnung angeben');
    const [key,value]=provided[0];
    const device=await withTransaction(async client=>{
      const current=(await client.query<Row>('SELECT * FROM nfc_devices WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[tenantId,id])).rows[0];
      if(!current)fail(404,'NFC-Gerät nicht gefunden');
      assertNotArchived(current);
      let target:Row|null=null;
      if(value)target=await targetInfo(client,tenantId,key,value);
      const previous=assignmentOf(current);
      const next={employee_id:null as string|null,site_id:null as string|null,control_point_id:null as string|null};
      if(value){
        if(key==='control_point_id'){
          if(current.device_type!=='tag')fail(400,'Nur NFC-Tags können einem Kontrollpunkt zugeordnet werden');
          if(value!==current.control_point_id)await assertControlPointAvailable(client,tenantId,value,id);
          next.control_point_id=value;
          // Die Objektzuordnung wird immer aus dem Kontrollpunkt abgeleitet.
          const cp=await client.query<Row>('SELECT site_id FROM control_points WHERE tenant_id=$1 AND id=$2',[tenantId,value]);
          next.site_id=null;
          if(!cp.rows[0])fail(404,'Kontrollpunkt nicht gefunden');
        }else if(key==='site_id')next.site_id=value;
        else next.employee_id=value;
      }
      const updated=(await client.query<Row>(`UPDATE nfc_devices SET employee_id=$1,site_id=$2,control_point_id=$3,updated_at=now()
        WHERE tenant_id=$4 AND id=$5 RETURNING *`,[next.employee_id,next.site_id,next.control_point_id,tenantId,id])).rows[0];
      await client.query(`INSERT INTO nfc_device_assignment_history(tenant_id,device_id,previous_assignment,assignment,actor_user_id,reason)
        VALUES($1,$2,$3,$4,$5,$6)`,[tenantId,id,JSON.stringify(previous),JSON.stringify(next),req.user!.id,body.reason??null]);
      await recordAudit(tenantId,req.user!.id,'nfc_device.assigned','nfc_device',id,
        {previous_assignment:previous,assignment:next,reason:body.reason??null,site_id:target?.site_id??next.site_id},client);
      return updated;
    });
    res.json(device);
  }catch(error){next(error);}
});

nfcManagementRouter.post('/nfc-devices/:id/report-lost',security,async(req,res,next)=>{
  try{
    const tenantId=req.user!.tenantId;
    const id=deviceId(req);
    const body=z.object({lost_at:z.string().date(),reason,notes:z.string().trim().max(2000).optional()}).strict().parse(req.body);
    const device=await withTransaction(async client=>{
      const current=(await client.query<Row>('SELECT * FROM nfc_devices WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[tenantId,id])).rows[0];
      if(!current)fail(404,'NFC-Gerät nicht gefunden');
      assertNotArchived(current);
      if(current.status==='lost'||current.status==='replaced')fail(409,'NFC-Gerät ist bereits als verloren oder ersetzt erfasst');
      const updated=(await client.query<Row>(`UPDATE nfc_devices SET status='lost',lost_at=$1,event_reason=$2,reported_by=$3,notes=$4,updated_at=now()
        WHERE tenant_id=$5 AND id=$6 RETURNING *`,[body.lost_at,body.reason,req.user!.id,body.notes??current.notes,tenantId,id])).rows[0];
      await recordAudit(tenantId,req.user!.id,'nfc_device.lost.reported','nfc_device',id,
        {previous_status:current.status,lost_at:body.lost_at,reason:body.reason,notes:body.notes??null},client);
      return updated;
    });
    res.json(device);
  }catch(error){next(error);}
});

nfcManagementRouter.post('/nfc-devices/:id/block',security,async(req,res,next)=>{
  try{
    const tenantId=req.user!.tenantId;
    const id=deviceId(req);
    const body=z.object({reason}).strict().parse(req.body);
    const device=await withTransaction(async client=>{
      const current=(await client.query<Row>('SELECT * FROM nfc_devices WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[tenantId,id])).rows[0];
      if(!current)fail(404,'NFC-Gerät nicht gefunden');
      assertNotArchived(current);
      if(!['active','lost'].includes(String(current.status)))fail(409,'NFC-Gerät kann in diesem Status nicht gesperrt werden');
      const updated=(await client.query<Row>(`UPDATE nfc_devices SET status='blocked',blocked_at=now(),event_reason=$1,reported_by=$2,updated_at=now()
        WHERE tenant_id=$3 AND id=$4 RETURNING *`,[body.reason,req.user!.id,tenantId,id])).rows[0];
      await recordAudit(tenantId,req.user!.id,'nfc_device.blocked','nfc_device',id,
        {previous_status:current.status,reason:body.reason},client);
      return updated;
    });
    res.json(device);
  }catch(error){next(error);}
});

nfcManagementRouter.post('/nfc-devices/:id/reactivate',security,async(req,res,next)=>{
  try{
    const tenantId=req.user!.tenantId;
    const id=deviceId(req);
    const body=z.object({reason}).strict().parse(req.body);
    const device=await withTransaction(async client=>{
      const current=(await client.query<Row>('SELECT * FROM nfc_devices WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[tenantId,id])).rows[0];
      if(!current)fail(404,'NFC-Gerät nicht gefunden');
      assertNotArchived(current);
      if(current.status!=='blocked')fail(409,'Nur gesperrte NFC-Geräte können reaktiviert werden');
      const updated=(await client.query<Row>(`UPDATE nfc_devices SET status='active',event_reason=$1,reported_by=$2,updated_at=now()
        WHERE tenant_id=$3 AND id=$4 RETURNING *`,[body.reason,req.user!.id,tenantId,id])).rows[0];
      await recordAudit(tenantId,req.user!.id,'nfc_device.reactivated','nfc_device',id,
        {previous_status:current.status,reason:body.reason},client);
      return updated;
    });
    res.json(device);
  }catch(error){next(error);}
});

// Wiederauffinden führt bewusst nur in die Quarantäne (blocked). Die
// Reaktivierung bleibt ein separater, begründungspflichtiger Schritt.
nfcManagementRouter.post('/nfc-devices/:id/recover',security,async(req,res,next)=>{
  try{
    const tenantId=req.user!.tenantId;
    const id=deviceId(req);
    const body=z.object({
      found_at:z.string().date(),reason,
      identifier_confirmation:nonempty,
      assignment_confirmed:z.literal(true),
    }).strict().parse(req.body);
    const device=await withTransaction(async client=>{
      const current=(await client.query<Row>('SELECT * FROM nfc_devices WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[tenantId,id])).rows[0];
      if(!current)fail(404,'NFC-Gerät nicht gefunden');
      // Ein ersetztes Gerät bleibt dauerhaft außer Betrieb – auch wenn es
      // zusätzlich archiviert wurde. Der Umweg über recover darf es nicht
      // wieder in die Quarantäne und anschließend nach active bringen.
      if(current.status==='replaced'||current.replaced_at)fail(409,'Ersetzte NFC-Geräte können nicht wieder in Betrieb genommen werden');
      if(current.status!=='lost'&&!current.archived_at)fail(409,'Nur verlorene oder archivierte NFC-Geräte können wieder in Betrieb genommen werden');
      if(body.identifier_confirmation!==current.identifier)fail(409,'Die bestätigte NFC-Kennung stimmt nicht mit dem Gerät überein');
      const updated=(await client.query<Row>(`UPDATE nfc_devices
        SET status='blocked',blocked_at=now(),recovered_at=$1,recovered_reason=$2,archived_at=NULL,archived_reason=NULL,
          event_reason=$2,reported_by=$3,updated_at=now()
        WHERE tenant_id=$4 AND id=$5 RETURNING *`,[body.found_at,body.reason,req.user!.id,tenantId,id])).rows[0];
      await recordAudit(tenantId,req.user!.id,'nfc_device.recovered','nfc_device',id,
        {previous_status:current.status,previous_archived:Boolean(current.archived_at),found_at:body.found_at,
          reason:body.reason,assignment:assignmentOf(current)},client);
      return updated;
    });
    res.json(device);
  }catch(error){next(error);}
});

nfcManagementRouter.post('/nfc-devices/:id/archive',security,async(req,res,next)=>{
  try{
    const tenantId=req.user!.tenantId;
    const id=deviceId(req);
    const body=z.object({reason}).strict().parse(req.body);
    const device=await withTransaction(async client=>{
      const current=(await client.query<Row>('SELECT * FROM nfc_devices WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[tenantId,id])).rows[0];
      if(!current)fail(404,'NFC-Gerät nicht gefunden');
      if(current.archived_at)fail(409,'NFC-Gerät ist bereits archiviert');
      const updated=(await client.query<Row>(`UPDATE nfc_devices
        SET archived_at=now(),archived_reason=$1,event_reason=$1,reported_by=$2,updated_at=now()
        WHERE tenant_id=$3 AND id=$4 RETURNING *`,[body.reason,req.user!.id,tenantId,id])).rows[0];
      await recordAudit(tenantId,req.user!.id,'nfc_device.archived','nfc_device',id,
        {previous_status:current.status,reason:body.reason,assignment:assignmentOf(current)},client);
      return updated;
    });
    res.json(device);
  }catch(error){next(error);}
});

nfcManagementRouter.post('/nfc-devices/:id/replace',security,async(req,res,next)=>{
  try{
    const tenantId=req.user!.tenantId;
    const id=deviceId(req);
    // copy_assignment ist bewusst verpflichtend: die Übernahme darf nie eine
    // stillschweigende Voreinstellung sein.
    const body=z.object({
      identifier:nonempty.optional(),new_device_id:uuid.optional(),
      device_type:deviceType.optional(),manufacturer:nonempty.optional(),
      model:z.string().trim().max(200).optional(),serial_number:z.string().trim().max(200).optional(),
      description:z.string().trim().max(2000).optional(),
      reason,notes:z.string().trim().max(2000).optional(),copy_assignment:z.boolean(),
      acknowledge_existing_assignment:z.literal(true).optional(),
      acknowledge_restricted:z.literal(true).optional(),
    }).strict().parse(req.body);
    if(body.new_device_id&&body.new_device_id===id)fail(400,'Ein Gerät kann nicht durch sich selbst ersetzt werden');
    if(body.new_device_id&&body.identifier)fail(400,'Bitte nur einen Ersatzgerät-Modus angeben');
    if(!body.new_device_id&&(!body.identifier||!body.device_type||!body.manufacturer)){
      fail(400,'Bitte Kennung, Gerätetyp und Hersteller des Ersatzgeräts angeben');
    }
    const result=await withTransaction(async client=>{
      const old=(await client.query<Row>('SELECT * FROM nfc_devices WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[tenantId,id])).rows[0];
      if(!old)fail(404,'NFC-Gerät nicht gefunden');
      if(old.status==='replaced'||old.replaced_at)fail(409,'NFC-Gerät ist bereits ersetzt');
      assertNotArchived(old);

      const empty={employee_id:null as string|null,site_id:null as string|null,control_point_id:null as string|null};
      let replacement:Row;
      let replacementAssignment=empty;
      let newlyCreated=false;
      let previousReplacementStatus='active';
      if(body.new_device_id){
        const existing=(await client.query<Row>('SELECT * FROM nfc_devices WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[tenantId,body.new_device_id])).rows[0];
        if(!existing)fail(404,'Ausgewähltes Ersatzgerät nicht gefunden');
        if(existing.status==='replaced'||existing.replaced_at||existing.archived_at){
          fail(409,'Das ausgewählte Ersatzgerät ist bereits ersetzt oder archiviert');
        }
        const alreadyUsed=(await client.query<Row>(
          'SELECT id FROM nfc_device_replacements WHERE tenant_id=$1 AND new_device_id=$2',
          [tenantId,String(existing.id)])).rows[0];
        if(alreadyUsed)fail(409,'Dieses Gerät wurde bereits als Ersatzgerät verwendet');
        replacementAssignment=assignmentOf(existing);
        previousReplacementStatus=String(existing.status);
        // Bestehende Zuordnungen dürfen nie unbemerkt überschrieben werden.
        if(hasAssignment(replacementAssignment)&&!body.acknowledge_existing_assignment){
          fail(409,'Das Ersatzgerät ist bereits zugeordnet. Bitte die bestehende Zuordnung bestätigen und über die Übernahme entscheiden.');
        }
        // Gesperrte/verlorene Kandidaten benötigen eine ausdrückliche Freigabe.
        if(['lost','blocked'].includes(String(existing.status))&&!body.acknowledge_restricted){
          fail(409,'Das Ersatzgerät ist gesperrt oder verloren. Bitte Status, Kennung und Zuordnung ausdrücklich prüfen und freigeben.');
        }
        replacement=existing;
      }else{
        const duplicate=(await client.query<Row>('SELECT id FROM nfc_devices WHERE tenant_id=$1 AND identifier=$2',[tenantId,body.identifier])).rows[0];
        if(duplicate)fail(409,'Diese NFC-Kennung ist bereits vergeben');
        replacement=(await client.query<Row>(`INSERT INTO nfc_devices
          (tenant_id,identifier,device_type,manufacturer,model,serial_number,description,notes,status)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,'active') RETURNING *`,
          [tenantId,body.identifier,body.device_type,body.manufacturer,body.model??null,body.serial_number??null,
            body.description??null,body.notes??''])).rows[0];
        newlyCreated=true;
      }

      const oldAssignment=assignmentOf(old);
      const takeOver=body.copy_assignment&&hasAssignment(oldAssignment);
      const next=takeOver?oldAssignment:(newlyCreated?empty:replacementAssignment);
      if(next.control_point_id&&String(replacement.device_type)!=='tag'){
        fail(400,'Nur NFC-Tags können einem Kontrollpunkt zugeordnet werden');
      }
      // Erst das alte Gerät außer Betrieb nehmen, dann die Zuordnung
      // übertragen. So bleibt der Kontrollpunkt eindeutig belegt.
      // Das alte Gerät verlässt die Zuordnung immer; die letzte Zuordnung bleibt
      // ausschließlich in der Historie und im Ersatzvorgang dokumentiert.
      const oldAfter=empty;
      await client.query<Row>(`UPDATE nfc_devices
        SET status='replaced',replaced_at=now(),event_reason=$1,reported_by=$2,updated_at=now(),
          employee_id=NULL,site_id=NULL,control_point_id=NULL
        WHERE tenant_id=$3 AND id=$4`,[body.reason,req.user!.id,tenantId,id]);
      // Erst nach dem Freigeben des alten Kontrollpunkts darf die Eindeutigkeit
      // für das Ersatzgerät geprüft werden.
      if(next.control_point_id){
        await assertControlPointAvailable(client,tenantId,next.control_point_id,String(replacement.id));
      }
      // Die Zuordnung des alten Geräts wird in jedem Fall historisch geschlossen.
      await client.query(`INSERT INTO nfc_device_assignment_history(tenant_id,device_id,previous_assignment,assignment,actor_user_id,reason)
        VALUES($1,$2,$3,$4,$5,$6)`,[tenantId,id,JSON.stringify(oldAssignment),JSON.stringify(oldAfter),
          req.user!.id,`Ersatz durch ${replacement.identifier}`]);

      if(takeOver){
        await client.query(`INSERT INTO nfc_device_assignment_history(tenant_id,device_id,previous_assignment,assignment,actor_user_id,reason)
          VALUES($1,$2,$3,$4,$5,$6)`,[tenantId,replacement.id,JSON.stringify(replacementAssignment),JSON.stringify(next),
            req.user!.id,`Ersatz für ${old.identifier}`]);
      }
      // Nur wenn alle Voraussetzungen erfüllt sind, wird das Ersatzgerät aktiv.
      const activated=(await client.query<Row>(`UPDATE nfc_devices
        SET status='active',employee_id=$1,site_id=$2,control_point_id=$3,
          lost_at=NULL,blocked_at=NULL,updated_at=now()
        WHERE tenant_id=$4 AND id=$5 RETURNING *`,
        [next.employee_id,next.site_id,next.control_point_id,tenantId,replacement.id])).rows[0];

      await client.query(`INSERT INTO nfc_device_replacements
        (tenant_id,old_device_id,new_device_id,reason,notes,old_assignment,new_assignment,actor_user_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [tenantId,id,replacement.id,body.reason,body.notes??null,JSON.stringify(oldAssignment),JSON.stringify(next),req.user!.id]);
      await recordAudit(tenantId,req.user!.id,'nfc_device.replaced','nfc_device',id,{
        old_device_id:id,new_device_id:String(replacement.id),previous_status:old.status,
        previous_replacement_status:previousReplacementStatus,reason:body.reason,
        copy_assignment:body.copy_assignment,
        acknowledge_existing_assignment:body.acknowledge_existing_assignment===true,
        acknowledge_restricted:body.acknowledge_restricted===true,
        old_assignment:oldAssignment,replacement_previous_assignment:replacementAssignment,new_assignment:next,
      },client);
      if(newlyCreated)await recordAudit(tenantId,req.user!.id,'nfc_device.created','nfc_device',String(replacement.id),
        {identifier:replacement.identifier,replaces:id,reason:body.reason},client);
      return {device:{...activated,...next},replacement_reason:body.reason};
    });
    res.status(201).json(result);
  }catch(error){next(error);}
});
