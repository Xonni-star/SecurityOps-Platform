export type Role='admin'|'operator'|'viewer'|'superadmin';
import type {PermissionGrant} from './authorization.js';
export interface AuthUser {id:string;tenantId:string;email:string;role:Role|string;permissions:string[];permissionGrants?:PermissionGrant[];siteIds?:string[];isSystemAdmin?:boolean}
export interface Entity {id:string;tenant_id:string;created_at:string;updated_at:string;[key:string]:unknown}
