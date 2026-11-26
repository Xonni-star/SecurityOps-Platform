import {Router} from 'express';
import {z} from 'zod';
import {query,withTransaction} from '../db/pool.js';
import {requireAuth,requireCsrf,requirePermission} from '../middleware/auth.js';
import {recordAudit} from '../services/audit.js';

type Row=Record<string,unknown>;
const uuid=z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const nonempty=z.string().trim().min(1).max(200);
const status=z.enum(['active','lost','blocked','replaced']);
const deviceType=z.enum(['tag','reader']);
export const phase6Router=Router();
phase6Router.use((req,res,next)=>/^\/nfc-devices/.test(req.path)
  ? requireAuth(req,res,()=>['POST','PATCH','PUT','DELETE'].includes(req.method)?requireCsrf(req,res,next):next())
  : next());

function validId(value:string):string{
  const parsed=uuid.safeParse(value);
  if(!parsed.success){throw Object.assign(new Error('Ungültige NFC-Gerätekennung'),{status:400});}
  return parsed.data;
}

function fail(status:number,message:string):never{
  throw Object.assign(new Error(message),{status});
}

function duplicateError():Error&{status:number;fields:Record<string,string>}{
  return Object.assign(new Error('Diese NFC-Kennung ist bereits vergeben'),{
    status:409,fields:{identifier:'Diese NFC-Kennung ist bereits vergeben'},
  });
}

async function targetExists(runner:{query:(sql:string,values:unknown[])=>Promise<{rows:Row[]}>},tenantId:string,key:'employee_id'|'site_id'|'control_point_id',id:string){
  const table={employee_id:'employees',site_id:'sites',control_point_id:'control_points'}[key];
  return (await runner.query(`SELECT id FROM ${table} WHERE id=$1 AND tenant_id=$2`,[id,tenantId])).rows[0];
}

async function targetSiteId(tenantId:string,controlPointId:string):Promise<string|null>{
  const row=(await query('SELECT site_id FROM control_points WHERE tenant_id=$1 AND id=$2',[tenantId,controlPointId])).rows[0];
  return (row?.site_id as string|null)??null;
}

function assignmentOf(row:Row):Record<string,string|null>{
  return {employee_id:(row.employee_id as string|null)??null,site_id:(row.site_id as string|null)??null,control_point_id:(row.control_point_id as string|null)??null};
}

phase6Router.get('/nfc-devices',requirePermission('nfc_devices:read'),async(req,res,next)=>{
  try{
    const rows=await query(`SELECT n.*,e.name employee_name,s.name site_name,cp.name control_point_name
      FROM nfc_devices n LEFT JOIN employees e ON e.tenant_id=n.tenant_id AND e.id=n.employee_id
      LEFT JOIN sites s ON s.tenant_id=n.tenant_id AND s.id=n.site_id
      LEFT JOIN control_points cp ON cp.tenant_id=n.tenant_id AND cp.id=n.control_point_id
      WHERE n.tenant_id=$1 ORDER BY n.updated_at DESC`,[req.user!.tenantId]);
    res.json(rows.rows);
  }catch(error){next(error);}
});

phase6Router.post('/nfc-devices',requirePermission('nfc_devices:write'),async(req,res,next)=>{
  try{
    const body=z.object({identifier:nonempty,device_type:deviceType,manufacturer:nonempty,status:status.optional(),employee_id:uuid.nullable().optional(),site_id:uuid.nullable().optional(),control_point_id:uuid.nullable().optional(),notes:z.string().max(2000).optional()}).strict().parse(req.body);
    const queryRunner={query:(sql:string,values:unknown[])=>query(sql,values)};
    const targets=Object.entries({employee_id:body.employee_id,site_id:body.site_id,control_point_id:body.control_point_id}).filter(([,value])=>value);
    if(targets.length>1)return res.status(400).json({error:'Es ist nur ein NFC-Zuordnungsziel erlaubt'});
    if(body.control_point_id&&body.device_type!=='tag')return res.status(400).json({error:'Nur NFC-Tags können einem Kontrollpunkt zugeordnet werden'});
    if(targets[0]&&!(await targetExists(queryRunner,req.user!.tenantId,targets[0][0] as 'employee_id'|'site_id'|'control_point_id',String(targets[0][1]))))return res.status(404).json({error:'Zuordnungsziel nicht gefunden'});
    const duplicate=(await query('SELECT id FROM nfc_devices WHERE tenant_id=$1 AND identifier=$2',[req.user!.tenantId,body.identifier])).rows[0];
    if(duplicate)throw duplicateError();
    const siteId=body.control_point_id?await targetSiteId(req.user!.tenantId,body.control_point_id):null;
    const device=(await query(`INSERT INTO nfc_devices(tenant_id,identifier,device_type,manufacturer,status,employee_id,site_id,control_point_id,notes)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[req.user!.tenantId,body.identifier,body.device_type,body.manufacturer,body.status??'active',body.employee_id??null,body.site_id??null,body.control_point_id??null,body.notes??''])).rows[0];
    await recordAudit(req.user!.tenantId,req.user!.id,'nfc_device.created','nfc_device',String(device.id),{identifier:body.identifier,device_type:body.device_type,assignment:assignmentOf(device as Row),site_id:siteId});
    res.status(201).json(device);
  }catch(error){next(error);}
});

phase6Router.patch('/nfc-devices/:id',requirePermission('nfc_devices:write'),async(req,res,next)=>{
  try{
    const id=validId(String(req.params.id));
    if('status' in (req.body??{}))return res.status(400).json({error:'Statusänderungen erfolgen ausschließlich über die dafür vorgesehenen Workflow-Endpunkte'});
    const {reason,...body}=z.object({identifier:nonempty.optional(),device_type:deviceType.optional(),manufacturer:nonempty.optional(),employee_id:uuid.nullable().optional(),site_id:uuid.nullable().optional(),control_point_id:uuid.nullable().optional(),notes:z.string().max(2000).optional(),reason:z.string().trim().max(2000).optional()}).strict().parse(req.body);
    const device=await withTransaction(async client=>{
      const current=(await client.query<Row>('SELECT * FROM nfc_devices WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[req.user!.tenantId,id])).rows[0];
      if(!current)fail(404,'NFC-Gerät nicht gefunden');
      const assignment={employee_id:body.employee_id===undefined?current.employee_id:body.employee_id,site_id:body.site_id===undefined?current.site_id:body.site_id,control_point_id:body.control_point_id===undefined?current.control_point_id:body.control_point_id};
      const targets=Object.entries(assignment).filter(([,value])=>value);
      if(targets.length>1)fail(400,'Es ist nur ein NFC-Zuordnungsziel erlaubt');
      if(assignment.control_point_id&&(body.device_type??current.device_type)!=='tag')fail(400,'Nur NFC-Tags können einem Kontrollpunkt zugeordnet werden');
      if(targets[0]&&!(await targetExists({query:(sql,values)=>client.query(sql,values)},req.user!.tenantId,targets[0][0] as 'employee_id'|'site_id'|'control_point_id',String(targets[0][1]))))fail(404,'Zuordnungsziel nicht gefunden');
      if(body.identifier&&body.identifier!==current.identifier){
        const duplicate=(await client.query('SELECT id FROM nfc_devices WHERE tenant_id=$1 AND identifier=$2',[req.user!.tenantId,body.identifier])).rows[0];
        if(duplicate)throw duplicateError();
      }
      const fields={...body,...assignment};const keys=Object.keys(fields).filter(key=>fields[key as keyof typeof fields]!==undefined) as (keyof typeof fields)[];
      if(!keys.length)fail(400,'Keine Änderungen angegeben');
      const values=keys.map(key=>fields[key]);const set=keys.map((key,index)=>`${key}=$${index+1}`).join(',');
      const previous=assignmentOf(current);
      const row=(await client.query<Row>(`UPDATE nfc_devices SET ${set},updated_at=now() WHERE tenant_id=$${keys.length+1} AND id=$${keys.length+2} RETURNING *`,[...values,req.user!.tenantId,id])).rows[0];
      const next=assignmentOf(row);
      if(JSON.stringify(previous)!==JSON.stringify(next)){
        await client.query(`INSERT INTO nfc_device_assignment_history(tenant_id,device_id,previous_assignment,assignment,actor_user_id,reason)
          VALUES($1,$2,$3,$4,$5,$6)`,[req.user!.tenantId,id,JSON.stringify(previous),JSON.stringify(next),req.user!.id,reason??null]);
      }
      await recordAudit(req.user!.tenantId,req.user!.id,'nfc_device.updated','nfc_device',id,
        {changed_fields:keys,previous_assignment:previous,assignment:next,reason:reason??null},client);
      return row;
    });
    res.json(device);
  }catch(error){next(error);}
});

phase6Router.delete('/nfc-devices/:id',requirePermission('nfc_devices:write'),async(req,res,next)=>{
  try{
    const id=validId(String(req.params.id));
    const tenantId=req.user!.tenantId;
    const current=(await query<Row>('SELECT identifier FROM nfc_devices WHERE tenant_id=$1 AND id=$2',[tenantId,id])).rows[0];
    if(!current)return res.status(404).json({error:'NFC-Gerät nicht gefunden'});
    const history=(await query<Row>(`SELECT (SELECT count(*)::int FROM patrol_scans WHERE tenant_id=$1 AND nfc_device_id=$2) scans,
      (SELECT count(*)::int FROM nfc_device_replacements WHERE tenant_id=$1 AND (old_device_id=$2 OR new_device_id=$2)) replacements`,[tenantId,id])).rows[0];
    if(Number(history?.scans??0)>0||Number(history?.replacements??0)>0)return res.status(409).json({error:'NFC-Gerät mit Scan- oder Ersatzhistorie kann nicht gelöscht werden'});
    await withTransaction(async client=>{
      await client.query('DELETE FROM nfc_devices WHERE tenant_id=$1 AND id=$2',[tenantId,id]);
      await recordAudit(tenantId,req.user!.id,'nfc_device.deleted','nfc_device',id,{identifier:current.identifier},client);
    });
    res.status(204).send();
  }catch(error){next(error);}
});
