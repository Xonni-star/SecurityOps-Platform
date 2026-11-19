export type Role='admin'|'operator'|'viewer';
export interface AuthUser {id:string;tenantId:string;email:string;role:Role}
export interface Entity {id:string;tenant_id:string;created_at:string;[key:string]:unknown}
