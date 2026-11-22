import {Role} from '../types/models.js';
export interface Tenant {id:string;name:string;created_at:string}
export interface User {id:string;tenant_id:string;email:string;role:Role;created_at:string}
export interface Employee {id:string;tenant_id:string;name:string;email:string;title?:string;created_at:string}
export interface Customer {id:string;tenant_id:string;name:string;email?:string;created_at:string}
export interface Site {
  id:string;tenant_id:string;name:string;address?:string;site_number?:string;alias?:string;site_type?:string;
  description?:string;status:'planning'|'setup'|'active'|'restricted'|'temporarily_closed'|'decommissioned'|'archived';
  security_classification:'unknown'|'low'|'medium'|'high'|'critical';latitude?:number;longitude?:number;
  opening_hours?:Record<string,string>;access_information?:string;special_notes?:string;hazard_notes?:string;
  object_manager_employee_id?:string;operations_manager_employee_id?:string;created_at:string
}
export interface Device {id:string;tenant_id:string;site_id?:string;name:string;status:string;last_seen_at?:string;created_at:string}
