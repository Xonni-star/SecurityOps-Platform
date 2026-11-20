import {Request,Response,NextFunction} from 'express';
import crypto from 'node:crypto';
import {query,withSessionContext,withTenantContext} from '../db/pool.js';
import {AuthUser} from '../types/models.js';

declare global {namespace Express {interface Request {user?:AuthUser; sessionId?:string; csrfToken?:string}}}
const SESSION_COOKIE='securityops_session';
const CSRF_COOKIE='securityops_csrf';
export function readCookie(req:Request,name:string){const value=req.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith(`${name}=`));return value?decodeURIComponent(value.slice(name.length+1)):undefined;}
export function sessionHash(value:string){return crypto.createHash('sha256').update(value).digest('hex');}
export async function getSessionUser(sessionId:string|undefined){if(!sessionId)return null;const result=await withSessionContext(sessionHash(sessionId),()=>query<AuthUser & {session_id:string;csrf_token:string;expires_at:string}>(`SELECT s.id AS session_id,s.csrf_token,s.expires_at,u.id,u.tenant_id AS "tenantId",u.email,u.role,COALESCE(array_agg(p.key) FILTER (WHERE p.key IS NOT NULL),'{}') AS permissions FROM sessions s JOIN users u ON u.id=s.user_id LEFT JOIN role_permissions rp ON rp.role=u.role LEFT JOIN permissions p ON p.id=rp.permission_id WHERE s.token_hash=$1 AND s.expires_at>now() GROUP BY s.id,u.id`,[sessionHash(sessionId)]));return result.rows[0]||null;}
export async function requireAuth(req:Request,res:Response,next:NextFunction){try{const sessionId=readCookie(req,SESSION_COOKIE);const user=await getSessionUser(sessionId);if(!user)return res.status(401).json({error:'Authentication required'});req.sessionId=sessionId;req.csrfToken=user.csrf_token;req.user={id:user.id,tenantId:user.tenantId,email:user.email,role:user.role,permissions:user.permissions};withTenantContext(user.tenantId,()=>Promise.resolve(next()));}catch(error){next(error);}}
export function requirePermission(permission:string){return (req:Request,res:Response,next:NextFunction)=>req.user?.permissions.includes(permission)?next():res.status(403).json({error:'Insufficient permissions'});}
export function requireCsrf(req:Request,res:Response,next:NextFunction){if(!['POST','PUT','PATCH','DELETE'].includes(req.method))return next();const cookie=readCookie(req,CSRF_COOKIE);const header=req.headers['x-csrf-token'];if(!cookie||cookie!==req.csrfToken||typeof header!=='string'||cookie.length!==header.length||!crypto.timingSafeEqual(Buffer.from(cookie),Buffer.from(header)))return res.status(403).json({error:'CSRF token required'});next();}
export {SESSION_COOKIE,CSRF_COOKIE};
