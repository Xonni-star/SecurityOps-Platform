import {Request,Response,NextFunction} from 'express'; import pino from 'pino'; import {ZodError} from 'zod';
export const logger=pino({level:process.env.LOG_LEVEL||'info'});
export function notFound(_req:Request,res:Response){res.status(404).json({error:'Nicht gefunden'});}
export function errorHandler(err:Error,_req:Request,res:Response,_next:NextFunction){
  const fields=(err as Error&{fields?:Record<string,string>}).fields;
  if(err instanceof ZodError){
    logger.error({type:'ZodError',issues:err.issues.map(issue=>({code:issue.code,path:issue.path}))},'Invalid request');
    return res.status(400).json({error:'Ungültige Anfrage',...(fields?{fields}:{})});
  }
  const status=(err as Error&{status?:number}).status;
  const expose=(err as Error&{expose?:boolean}).expose===true;
  const reasonCode=(err as Error&{reason_code?:string}).reason_code;
  const reasonDetails=(err as Error&{details?:Record<string,unknown>}).details;
  // Explizit freigegebene 5xx-Fehler (z. B. ein nicht erreichbarer
  // Virenscanner) erhalten eine verständliche deutsche Meldung, ohne dass
  // interne Fehlerdetails oder Zugangsdaten nach außen gelangen.
  const clientError=status!==undefined&&((status>=400&&status<500)||expose);
  logger.error({type:err.name,message:err.message,status:status??500},'Request failed');
  res.status(clientError?status:500).json({
    error:clientError?(err.message||'Ungültige Anfrage'):'Interner Serverfehler',
    ...(fields?{fields}:{}),
    ...(clientError&&reasonCode?{reason_code:reasonCode}:{}),
    ...(clientError&&reasonDetails?{details:reasonDetails}:{}),
  });
}
