import {Request,Response,NextFunction} from 'express';
import crypto from 'node:crypto';
import {query,withSessionContext,withTenantContext} from '../db/pool.js';
import {AuthUser} from '../types/models.js';
import {canUsePermission,normalizePermissionGrants,PermissionScope} from '../types/authorization.js';

declare global {namespace Express {interface Request {user?:AuthUser; sessionId?:string; csrfToken?:string}}}
const SESSION_COOKIE='securityops_session';
const CSRF_COOKIE='securityops_csrf';
const STATE_CHANGING_METHODS=new Set(['POST','PUT','PATCH','DELETE']);
export function readCookie(req:Request,name:string){
  return readCookieHeader(req.headers.cookie,name);
}
export function readCookieHeader(cookieHeader:string|undefined,name:string){
  const value=cookieHeader?.split(';').map(v=>v.trim()).find(v=>v.startsWith(`${name}=`));
  if(!value)return undefined;
  try{return decodeURIComponent(value.slice(name.length+1));}catch{return undefined;}
}
export function sessionHash(value:string){return crypto.createHash('sha256').update(value).digest('hex');}
type SessionRow=AuthUser & {session_id:string;csrf_token:string;expires_at:string;permission_grants:unknown;site_ids:string[]|null;is_system_admin:boolean};
export function isAllowedOrigin(origin:string|undefined,allowedOrigins:string[]){return !origin||allowedOrigins.includes(origin);}
export function requireAllowedOrigin(allowedOrigins:string[]){return (req:Request,res:Response,next:NextFunction)=>{
  if(!STATE_CHANGING_METHODS.has(req.method)||isAllowedOrigin(req.headers.origin,allowedOrigins))return next();
  return res.status(403).json({error:'Origin not allowed'});
};}
export async function getSessionUser(sessionId:string|undefined){if(!sessionId)return null;const result=await withSessionContext(sessionHash(sessionId),()=>query<SessionRow>(`SELECT s.id AS session_id,s.csrf_token,s.expires_at,u.id,u.tenant_id AS "tenantId",u.email,u.role,u.is_system_admin,COALESCE(array_agg(p.key) FILTER (WHERE p.key IS NOT NULL),'{}') AS permissions,COALESCE((SELECT jsonb_agg(jsonb_build_object('code',p2.key,'scope',rp2.scope)) FROM role_permissions rp2 JOIN permissions p2 ON p2.id=rp2.permission_id WHERE rp2.role=u.role),'[]'::jsonb) AS permission_grants,COALESCE((SELECT array_agg(us.site_id) FROM user_sites us WHERE us.tenant_id=u.tenant_id AND us.user_id=u.id),'{}') AS site_ids FROM sessions s JOIN users u ON u.id=s.user_id LEFT JOIN role_permissions rp ON rp.role=u.role LEFT JOIN permissions p ON p.id=rp.permission_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() GROUP BY s.id,u.id`,[sessionHash(sessionId)]));return result.rows[0]||null;}
export async function requireAuth(req:Request,res:Response,next:NextFunction){try{const sessionId=readCookie(req,SESSION_COOKIE);const user=await getSessionUser(sessionId);if(!user)return res.status(401).json({error:'Authentication required'});const grants=normalizePermissionGrants(user.permission_grants,user.permissions);req.sessionId=sessionId;req.csrfToken=user.csrf_token;req.user={id:user.id,tenantId:user.tenantId,email:user.email,role:user.role,permissions:user.permissions,permissionGrants:grants,siteIds:user.site_ids??[],isSystemAdmin:user.is_system_admin===true};withTenantContext(user.tenantId,()=>Promise.resolve(next()));}catch(error){next(error);}}
export function requirePermission(permission:string,options:{allowedScopes?:PermissionScope[]}={}){return (req:Request,res:Response,next:NextFunction)=>{const user=req.user;if(!user)return res.status(401).json({error:'Authentication required'});const grants=normalizePermissionGrants(user.permissionGrants,user.permissions);const allowedScopes=options.allowedScopes??['tenant','system'];const allowed=canUsePermission({userId:user.id,tenantId:user.tenantId,role:user.role,isSystemAdmin:user.isSystemAdmin===true,siteIds:user.siteIds??[],grants},permission,allowedScopes);return allowed?next():res.status(403).json({error:'Insufficient permissions'});};}
export function requireCsrf(req:Request,res:Response,next:NextFunction){if(!STATE_CHANGING_METHODS.has(req.method))return next();const cookie=readCookie(req,CSRF_COOKIE);const header=req.headers['x-csrf-token'];if(!cookie||!req.csrfToken||typeof header!=='string'||cookie.length!==req.csrfToken.length||header.length!==cookie.length||!crypto.timingSafeEqual(Buffer.from(cookie),Buffer.from(req.csrfToken))||!crypto.timingSafeEqual(Buffer.from(cookie),Buffer.from(header)))return res.status(403).json({error:'CSRF token required'});next();}
export {SESSION_COOKIE,CSRF_COOKIE};
