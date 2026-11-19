import {Role} from '../types/models.js';
export interface Tenant {id:string;name:string;created_at:string}
export interface User {id:string;tenant_id:string;email:string;role:Role;created_at:string}
export interface Employee {id:string;tenant_id:string;name:string;email:string;title?:string;created_at:string}
export interface Customer {id:string;tenant_id:string;name:string;email?:string;created_at:string}
export interface Site {id:string;tenant_id:string;name:string;address?:string;created_at:string}
export interface Device {id:string;tenant_id:string;site_id?:string;name:string;status:string;last_seen_at?:string;created_at:string}
