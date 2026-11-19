import {Request,Response,NextFunction} from 'express'; import pino from 'pino'; import {ZodError} from 'zod';
export const logger=pino({level:process.env.LOG_LEVEL||'info'});
export function notFound(_req:Request,res:Response){res.status(404).json({error:'Not found'});}
export function errorHandler(err:Error,_req:Request,res:Response,_next:NextFunction){logger.error(err);if(err instanceof ZodError)return res.status(400).json({error:'Invalid request'});const status=(err as Error&{status?:number}).status;res.status(status&&status>=400&&status<500?status:500).json({error:status?'Invalid request':'Internal server error'});}
