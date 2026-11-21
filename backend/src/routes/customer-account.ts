import {Router} from 'express';
import {z} from 'zod';
import {query} from '../db/pool.js';
import {requireAuth,requirePermission} from '../middleware/auth.js';
import {recordAudit} from '../services/audit.js';

const uuid=z.string().uuid();

export const customerAccountRouter=Router();

customerAccountRouter.get(
  '/customers/:id/360',
  requireAuth,
  requirePermission('customers:read',{allowedScopes:['tenant','system']}),
  async(req,res,next)=>{
    try{
      const customerId=uuid.parse(String(req.params.id));
      const tenantId=req.user!.tenantId;
      const customer=(await query(
        `SELECT c.*,e.name AS account_manager_name
         FROM customers c
         LEFT JOIN employees e ON e.tenant_id=c.tenant_id AND e.id=c.account_manager_employee_id
         WHERE c.tenant_id=$1 AND c.id=$2`,
        [tenantId,customerId],
      )).rows[0];
      if(!customer)return res.status(404).json({error:'Customer not found'});
      const [contacts,sites,contracts,services,timeline]=await Promise.all([
        query(
          `SELECT id,first_name,last_name,job_title,department,email,phone,mobile_phone,
                  preferred_contact_method,notes,status,is_primary,is_decision_maker,
                  is_security_contact,is_billing_contact,is_emergency_contact
           FROM customer_contacts
           WHERE tenant_id=$1 AND customer_id=$2 AND status<>'archived'
           ORDER BY is_primary DESC,last_name NULLS LAST,first_name NULLS LAST`,
          [tenantId,customerId],
        ),
        query(
          `SELECT cs.id AS relationship_id,cs.relationship_type,cs.relationship_status,cs.is_primary,
                  s.id,s.site_number,s.name,s.alias,s.status,s.security_classification,s.address
           FROM customer_sites cs
           JOIN sites s ON s.tenant_id=cs.tenant_id AND s.id=cs.site_id
           WHERE cs.tenant_id=$1 AND cs.customer_id=$2 AND cs.relationship_status<>'archived'
           ORDER BY cs.is_primary DESC,s.name`,
          [tenantId,customerId],
        ),
        query(
          `SELECT id,contract_number,contract_type,scope,starts_on,ends_on,renewal_type,
                  notice_period_days,next_termination_date,status,total_value,monthly_value,
                  billing_model,sla,internal_notes
           FROM contracts
           WHERE tenant_id=$1 AND customer_id=$2 AND status<>'archived'
           ORDER BY starts_on DESC,contract_number`,
          [tenantId,customerId],
        ),
        query(
          `SELECT cs.contract_id,cs.service_id,cs.quantity,cs.unit,cs.unit_price,cs.starts_on,cs.ends_on,
                  s.service_code,s.name,s.description
           FROM contract_services cs
           JOIN contracts c ON c.tenant_id=cs.tenant_id AND c.id=cs.contract_id
           JOIN services s ON s.tenant_id=cs.tenant_id AND s.id=cs.service_id
           WHERE cs.tenant_id=$1 AND c.customer_id=$2 AND c.status<>'archived'
           ORDER BY c.starts_on DESC,s.name`,
          [tenantId,customerId],
        ),
        query(
          `SELECT ae.id,ae.event_type,ae.entity_type,ae.entity_id,ae.details,ae.created_at,
                  u.email AS actor_email
           FROM audit_events ae
           LEFT JOIN users u ON u.tenant_id=ae.tenant_id AND u.id=ae.actor_user_id
           WHERE ae.tenant_id=$1
             AND ((ae.entity_type='customer' AND ae.entity_id=$2)
                  OR ae.details->>'customer_id'=$2)
           ORDER BY ae.created_at DESC
           LIMIT 100`,
          [tenantId,customerId],
        ),
      ]);
      await recordAudit(tenantId,req.user!.id,'customer.account.viewed','customer',customerId,{});
      res.json({
        customer,
        contacts:contacts.rows,
        sites:sites.rows,
        contracts:contracts.rows,
        services:services.rows,
        timeline:timeline.rows,
      });
    }catch(error){
      if(error instanceof z.ZodError)return res.status(400).json({error:'Invalid customer id'});
      next(error);
    }
  },
);
