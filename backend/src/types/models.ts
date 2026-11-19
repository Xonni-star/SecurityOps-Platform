export type Role='admin'|'operator'|'viewer';
export interface AuthUser {id:string;tenantId:string;email:string;role:Role;permissions:string[]}
export interface Entity {id:string;tenant_id:string;created_at:string;updated_at:string;[key:string]:unknown}
