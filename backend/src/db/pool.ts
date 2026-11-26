import pg from 'pg'; import {AsyncLocalStorage} from 'node:async_hooks'; import {env} from '../config/env.js';
export const pool=new pg.Pool({connectionString:env.DATABASE_URL,max:10,allowExitOnIdle:true});

type DbContext={tenantId?:string;loginEmail?:string;sessionTokenHash?:string};
const dbContext=new AsyncLocalStorage<DbContext>();

export function withTenantContext<T>(tenantId:string,work:()=>Promise<T>){return dbContext.run({...dbContext.getStore(),tenantId},work);}
export function withLoginContext<T>(loginEmail:string,work:()=>Promise<T>){return dbContext.run({...dbContext.getStore(),loginEmail},work);}
export function withSessionContext<T>(sessionTokenHash:string,work:()=>Promise<T>){return dbContext.run({...dbContext.getStore(),sessionTokenHash},work);}

export async function withTransaction<T>(work:(client:pg.PoolClient)=>Promise<T>){
  const context=dbContext.getStore();
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    if(context?.tenantId)await client.query('SELECT set_config($1,$2,true)',['app.tenant_id',context.tenantId]);
    if(context?.loginEmail)await client.query('SELECT set_config($1,$2,true)',['app.login_email',context.loginEmail]);
    if(context?.sessionTokenHash)await client.query('SELECT set_config($1,$2,true)',['app.session_token_hash',context.sessionTokenHash]);
    const result=await work(client);
    await client.query('COMMIT');
    return result;
  }catch(error){
    await client.query('ROLLBACK');
    throw error;
  }finally{client.release();}
}

export async function query<T extends pg.QueryResultRow=pg.QueryResultRow>(text:string,values:unknown[]=[]){
  const context=dbContext.getStore();
  if(!context)return pool.query<T>(text,values);
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    if(context.tenantId)await client.query('SELECT set_config($1,$2,true)',['app.tenant_id',context.tenantId]);
    if(context.loginEmail)await client.query('SELECT set_config($1,$2,true)',['app.login_email',context.loginEmail]);
    if(context.sessionTokenHash)await client.query('SELECT set_config($1,$2,true)',['app.session_token_hash',context.sessionTokenHash]);
    const result=await client.query<T>(text,values);
    await client.query('COMMIT');
    return result;
  }catch(error){
    await client.query('ROLLBACK');
    throw error;
  }finally{client.release();}
}
