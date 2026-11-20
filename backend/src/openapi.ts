const crudPath=(name:string)=>({
  get:{summary:`List ${name}`,security:[{sessionCookie:[]}],responses:{'200':{description:`Tenant-scoped ${name}`},'401':{description:'Unauthenticated'},'403':{description:'Missing read permission'}}},
  post:{summary:`Create ${name.slice(0,-1)}`,security:[{sessionCookie:[],csrfToken:[]}],requestBody:{required:true,content:{'application/json':{schema:{type:'object'}}}},responses:{'201':{description:'Created'},'400':{description:'Invalid input'},'403':{description:'Missing write permission or CSRF token'}}}
});
const itemPath=(name:string)=>({
  patch:{summary:`Update ${name.slice(0,-1)}`,security:[{sessionCookie:[],csrfToken:[]}],responses:{'200':{description:'Updated'},'403':{description:'Missing write permission or CSRF token'},'404':{description:'Not found'}}},
  delete:{summary:`Delete ${name.slice(0,-1)}`,security:[{sessionCookie:[],csrfToken:[]}],responses:{'204':{description:'Deleted'},'403':{description:'Missing delete permission or CSRF token'},'404':{description:'Not found'}}}
});
export const openapi={
  openapi:'3.0.3',info:{title:'SecurityOps Platform API',version:'1.0.0'},servers:[{url:'/api/v1'}],
  paths:{
    '/auth/login':{post:{summary:'Create device-bound session',description:'Verifies an Argon2id password, registers the client-generated UUID as a tenant device, and binds the opaque session to it. Client tenant values are never trusted.',requestBody:{required:true,content:{'application/json':{schema:{type:'object',required:['email','password','device_id'],properties:{email:{type:'string',format:'email'},password:{type:'string'},device_id:{type:'string',format:'uuid'},metadata:{type:'object',properties:{platform:{type:'string',maxLength:64},app_version:{type:'string',maxLength:32}},additionalProperties:false}}}}}},responses:{'200':{description:'Device-bound session created'},'401':{description:'Invalid credentials'},'403':{description:'Origin not allowed or device revoked'},'409':{description:'Device identity conflict'},'429':{description:'Too many login attempts'}}}},
    '/auth/logout':{post:{summary:'Revoke session',security:[{sessionCookie:[],csrfToken:[]}],responses:{'204':{description:'Logged out and revoked'},'403':{description:'Invalid CSRF token or Origin'}}}},
    '/auth/me':{get:{summary:'Get current user and permissions',security:[{sessionCookie:[]}],responses:{'200':{description:'Authenticated user'}}}},
    '/auth/devices':{get:{summary:'List authenticated tenant devices',security:[{sessionCookie:[]}] }},
    '/auth/devices/{id}/revoke':{post:{summary:'Revoke a device and all bound sessions atomically',security:[{sessionCookie:[],csrfToken:[]}] }},
    '/employees':crudPath('employees'),'/employees/{id}':itemPath('employees'),
    '/customers':crudPath('customers'),'/customers/{id}':itemPath('customers'),
    '/sites':crudPath('sites'),'/sites/{id}':itemPath('sites'),
    '/devices':crudPath('devices'),'/devices/{id}':itemPath('devices'),
    '/alarms':crudPath('alarms'),'/alarms/{id}':itemPath('alarms'),
    '/alarms/panic':{post:{summary:'Create a critical panic alarm',description:'Supports Idempotency-Key and canonical payload hash receipts. Replays return the stored response; hash/action mismatches are rejected.',security:[{sessionCookie:[],csrfToken:[]}],responses:{'201':{description:'Created and published in real time'},'200':{description:'Idempotent replay'},'409':{description:'Mutation conflict or hash mismatch'},'429':{description:'Rate limited'}}}},
    '/alarms/{id}/acknowledge':{post:{summary:'Acknowledge an alarm',security:[{sessionCookie:[],csrfToken:[]}] }},
    '/alarms/{id}/resolve':{post:{summary:'Resolve an acknowledged or escalated alarm',security:[{sessionCookie:[],csrfToken:[]}] }},
    '/alarms/{id}/history':{get:{summary:'List alarm lifecycle history',security:[{sessionCookie:[]}] }},
    '/alarm-priorities':crudPath('alarm-priorities'),'/alarm-priorities/{id}':itemPath('alarm-priorities'),
    '/escalation-rules':crudPath('escalation-rules'),
    '/control-points':crudPath('control-points'),'/patrol-routes':crudPath('patrol-routes'),
    '/patrol-routes/{routeId}/scans':{post:{summary:'Record an NFC patrol scan and detect deviations',description:'Supports Idempotency-Key and conflict_strategy USE_LOCAL, USE_SERVER or RECORD_AS_EXCEPTION.',security:[{sessionCookie:[],csrfToken:[]}] }},
    '/sensor-thresholds':crudPath('sensor-thresholds'),'/sensor-events':{get:{summary:'List tenant sensor events',security:[{sessionCookie:[]}] }},
    '/telemetry':{post:{summary:'Ingest authenticated device sensor telemetry',security:[{sessionCookie:[],csrfToken:[]}] }},
    '/positions':crudPath('positions'),'/map-data':{get:{summary:'Get latest positions and active alarms for the live map',security:[{sessionCookie:[]}] }},
    '/incidents':crudPath('incidents'),'/incidents/{id}/assignments':{post:{summary:'Assign an employee to an incident',security:[{sessionCookie:[],csrfToken:[]}] }},
    '/incidents/{id}/status':{post:{summary:'Advance an incident lifecycle status',security:[{sessionCookie:[],csrfToken:[]}] }},
    '/incidents/{id}/history':{get:{summary:'List incident status history',security:[{sessionCookie:[]}] }},
    '/nsl/dashboard':{get:{summary:'Consolidated NSL dashboard with alarms, incidents, positions and patrols',security:[{sessionCookie:[]}]}},
    '/nsl/alarms/{id}':{get:{summary:'Alarm detail with audit history',security:[{sessionCookie:[]}]}},
    '/reports/alarms':{get:{summary:'Export alarm report as CSV or PDF',security:[{sessionCookie:[]}]}},
    '/handovers':crudPath('handovers'),'/handovers/{id}/acknowledge':{post:{summary:'Acknowledge shift handover',security:[{sessionCookie:[],csrfToken:[]}] }},
    '/messages':crudPath('messages'),'/messages/{id}/read':{post:{summary:'Mark direct message read',security:[{sessionCookie:[],csrfToken:[]}] }},
    '/notifications':{get:{summary:'List in-app notifications',security:[{sessionCookie:[]}] }},
    '/notifications/{id}/read':{post:{summary:'Mark notification read',security:[{sessionCookie:[],csrfToken:[]}] }},
    '/notification-subscriptions':crudPath('notification-subscriptions'),
    '/notification-events':{post:{summary:'Queue a notification event',security:[{sessionCookie:[],csrfToken:[]}] }},
    '/reports/statistics':{get:{summary:'Get filtered management statistics',security:[{sessionCookie:[]}]}},
    '/reports/{kind}':{get:{summary:'Export employee, site, patrol, alarm, incident or work-time report',security:[{sessionCookie:[]}]}},
    '/timescan/config':crudPath('timescan-config'),'/timescan/runs':{get:{summary:'List TimeScan sync runs',security:[{sessionCookie:[]}]}},'/timescan/sync':{post:{summary:'Synchronize TimeScan work times idempotently',security:[{sessionCookie:[],csrfToken:[]}] }},
    '/audit':{get:{summary:'List tenant audit events',security:[{sessionCookie:[]}]}},'/audit/export':{get:{summary:'Export tenant audit events as CSV',security:[{sessionCookie:[]}] }},
    '/retention':{get:{summary:'List data retention policies',security:[{sessionCookie:[]}]}},'/retention/{dataType}':{patch:{summary:'Update a retention policy',security:[{sessionCookie:[],csrfToken:[]}] }},
    '/privacy/export':{post:{summary:'Export data subject records',security:[{sessionCookie:[],csrfToken:[]}] }},'/privacy/delete':{post:{summary:'Anonymize a data subject',security:[{sessionCookie:[],csrfToken:[]}] }},
    '/backups/status':{get:{summary:'List local backup artifacts',security:[{sessionCookie:[]}] }},
    '/nfc-devices':crudPath('nfc-devices'),'/nfc-devices/{id}':itemPath('nfc-devices'),
    '/ws':{get:{summary:'Authenticated WebSocket heartbeat',description:'Upgrade to WebSocket using the securityops_session cookie. URL tokens are not accepted; the server emits heartbeat messages every 30 seconds.',security:[{sessionCookie:[]}],responses:{'101':{description:'Switching protocols'},'1008':{description:'Unauthorized'}}}}
  },
  components:{securitySchemes:{sessionCookie:{type:'apiKey',in:'cookie',name:'securityops_session'},csrfToken:{type:'apiKey',in:'header',name:'x-csrf-token'}},schemas:{Error:{type:'object',properties:{error:{type:'string'}}}}}
};
