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
    '/auth/login':{post:{summary:'Create session',description:'Verifies an Argon2id password and sets an opaque securityops_session httpOnly cookie plus a readable securityops_csrf cookie.',responses:{'200':{description:'Session created'},'401':{description:'Invalid credentials'}}}},
    '/auth/logout':{post:{summary:'Destroy session',security:[{sessionCookie:[],csrfToken:[]}],responses:{'204':{description:'Logged out'},'403':{description:'Invalid CSRF token'}}}},
    '/auth/me':{get:{summary:'Get current user and permissions',security:[{sessionCookie:[]}],responses:{'200':{description:'Authenticated user'}}}},
    '/employees':crudPath('employees'),'/employees/{id}':itemPath('employees'),
    '/customers':crudPath('customers'),'/customers/{id}':itemPath('customers'),
    '/sites':crudPath('sites'),'/sites/{id}':itemPath('sites'),
    '/devices':crudPath('devices'),'/devices/{id}':itemPath('devices'),
    '/alarms':crudPath('alarms'),'/alarms/{id}':itemPath('alarms'),
    '/ws':{get:{summary:'Authenticated WebSocket heartbeat',description:'Upgrade to WebSocket using the securityops_session cookie. URL tokens are not accepted; the server emits heartbeat messages every 30 seconds.',security:[{sessionCookie:[]}],responses:{'101':{description:'Switching protocols'},'1008':{description:'Unauthorized'}}}}
  },
  components:{securitySchemes:{sessionCookie:{type:'apiKey',in:'cookie',name:'securityops_session'},csrfToken:{type:'apiKey',in:'header',name:'x-csrf-token'}},schemas:{Error:{type:'object',properties:{error:{type:'string'}}}}}
};
