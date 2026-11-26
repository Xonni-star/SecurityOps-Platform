import nodemailer from 'nodemailer';
import {env} from '../config/env.js';
import {createTimeScanAdapter} from './timescan.js';
import {resolveSecret} from './secrets.js';

export type ProviderStatusValue='not_configured'|'configured'|'verified'|'failed';
export type ProviderStatus={
  provider:'smtp'|'sms'|'timescan';
  status:ProviderStatusValue;
  message:string;
  checked_at:string;
};
export type PersistedProviderConfig={provider:'smtp'|'sms';config:Record<string,unknown>;secret_ref:string|null;enabled:boolean};

function result(provider:ProviderStatus['provider'],status:ProviderStatusValue,message:string):ProviderStatus{
  return {provider,status,message,checked_at:new Date().toISOString()};
}

export async function checkSmtpStatus():Promise<ProviderStatus>{
  if(!env.SMTP_HOST)return result('smtp','not_configured','SMTP-Host ist nicht konfiguriert');
  if(Boolean(env.SMTP_USER)!==Boolean(env.SMTP_PASSWORD))return result('smtp','failed','SMTP-Zugangsdaten sind unvollständig');
  const transport=nodemailer.createTransport({
    host:env.SMTP_HOST,port:env.SMTP_PORT,secure:env.SMTP_PORT===465,
    auth:env.SMTP_USER?{user:env.SMTP_USER,password:env.SMTP_PASSWORD}:undefined,
  });
  try{
    await transport.verify();
    return result('smtp','verified','SMTP-Verbindung erfolgreich überprüft');
  }catch{
    return result('smtp','failed','SMTP-Überprüfung fehlgeschlagen');
  }finally{transport.close();}
}

export async function checkSmsStatus():Promise<ProviderStatus>{
  if(!env.SMS_GATEWAY_URL)return result('sms','not_configured','SMS-Gateway ist nicht konfiguriert');
  if(!env.SMS_GATEWAY_HEALTH_URL)return result('sms','configured','SMS-Gateway konfiguriert; kein sicherer Health-Check-Endpunkt angegeben');
  try{
    const response=await fetch(env.SMS_GATEWAY_HEALTH_URL,{
      method:'HEAD',
      headers:env.SMS_GATEWAY_TOKEN?{authorization:`Bearer ${env.SMS_GATEWAY_TOKEN}`}:{},
      signal:AbortSignal.timeout(5000),
    });
    return response.ok
      ? result('sms','verified','Health-Check-Endpunkt des SMS-Gateways erfolgreich überprüft')
      : result('sms','failed','Health-Check des SMS-Gateways fehlgeschlagen');
  }catch{return result('sms','failed','Health-Check des SMS-Gateways fehlgeschlagen');}
}

export async function checkPersistedProviderStatus(config:PersistedProviderConfig|undefined):Promise<ProviderStatus>{
  if(!config||!config.enabled)return result(config?.provider??'sms','not_configured',`${config?.provider??'Anbieter'} ist nicht konfiguriert oder deaktiviert`);
  if(config.provider==='smtp'){
    const host=typeof config.config.host==='string'?config.config.host:'';
    const port=typeof config.config.port==='number'?config.config.port:587;
    if(!host)return result('smtp','not_configured','SMTP-Host ist nicht konfiguriert');
    if(!config.secret_ref && !env.SMTP_PASSWORD)return result('smtp','configured','SMTP konfiguriert; Zugangsdaten sind nicht referenziert');
    const transport=nodemailer.createTransport({host,port,secure:port===465});
    try{await transport.verify();return result('smtp','verified','SMTP-Verbindung erfolgreich überprüft');}
    catch{return result('smtp','failed','SMTP-Überprüfung fehlgeschlagen');}
    finally{transport.close();}
  }
  const url=typeof config.config.url==='string'?config.config.url:'';
  if(!url)return result('sms','not_configured','SMS-Gateway-URL ist nicht konfiguriert');
  return result('sms','configured','SMS-Gateway konfiguriert; für die Überprüfung ist ein sicherer Health-Check-Endpunkt erforderlich');
}

export async function checkTimeScanStatus(connection?:{base_url:string;account_ref:string;secret_ref:string;enabled:boolean}):Promise<ProviderStatus>{
  if(!connection||!connection.enabled)return result('timescan','not_configured','TimeScan ist nicht konfiguriert oder deaktiviert');
  let secret:string|undefined;
  try{secret=await resolveSecret(connection.secret_ref);}catch{return result('timescan','failed','TimeScan-Secret ist nicht verfügbar');}
  if(!secret)return result('timescan','configured','TimeScan konfiguriert; kein Secret-Verweis angegeben');
  try{
    await createTimeScanAdapter(connection.base_url,connection.account_ref,secret).verify();
    return result('timescan','verified','TimeScan-Verbindung erfolgreich überprüft');
  }catch{return result('timescan','failed','TimeScan-Überprüfung fehlgeschlagen');}
}
