import {Request,Response,NextFunction} from 'express'; import pino from 'pino';
export const logger=pino({level:process.env.LOG_LEVEL||'info'});
export function notFound(_req:Request,res:Response){res.status(404).json({error:'Not found'});}
export function errorHandler(err:Error,_req:Request,res:Response,_next:NextFunction){logger.error(err); res.status(500).json({error:'Internal server error'});}
