import {Request,Response,NextFunction} from 'express'; import pino from 'pino'; import {ZodError} from 'zod';
export const logger=pino({level:process.env.LOG_LEVEL||'info'});
export function notFound(_req:Request,res:Response){res.status(404).json({error:'Nicht gefunden'});}
export function errorHandler(err:Error,_req:Request,res:Response,_next:NextFunction){
  if(err instanceof ZodError){
    logger.error({type:'ZodError',issues:err.issues.map(issue=>({code:issue.code,path:issue.path}))},'Invalid request');
    return res.status(400).json({error:'Ungültige Anfrage'});
  }
  const status=(err as Error&{status?:number}).status;
  logger.error({type:err.name,message:err.message,status:status??500},'Request failed');
  res.status(status&&status>=400&&status<500?status:500).json({error:status?'Ungültige Anfrage':'Interner Serverfehler'});
}
