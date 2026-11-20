import nodemailer from 'nodemailer';
import {env} from '../config/env.js';
import {createTimeScanAdapter} from './timescan.js';

export type ProviderStatusValue='not_configured'|'configured'|'verified'|'failed';
export type ProviderStatus={
  provider:'smtp'|'sms'|'timescan';
  status:ProviderStatusValue;
  message:string;
  checked_at:string;
};

function result(provider:ProviderStatus['provider'],status:ProviderStatusValue,message:string):ProviderStatus{
  return {provider,status,message,checked_at:new Date().toISOString()};
}

export async function checkSmtpStatus():Promise<ProviderStatus>{
  if(!env.SMTP_HOST)return result('smtp','not_configured','SMTP host is not configured');
  if(Boolean(env.SMTP_USER)!==Boolean(env.SMTP_PASSWORD))return result('smtp','failed','SMTP credentials are incomplete');
  const transport=nodemailer.createTransport({
    host:env.SMTP_HOST,port:env.SMTP_PORT,secure:env.SMTP_PORT===465,
    auth:env.SMTP_USER?{user:env.SMTP_USER,password:env.SMTP_PASSWORD}:undefined,
  });
  try{
    await transport.verify();
    return result('smtp','verified','SMTP connection verified');
  }catch{
    return result('smtp','failed','SMTP verification failed');
  }finally{transport.close();}
}

export async function checkSmsStatus():Promise<ProviderStatus>{
  if(!env.SMS_GATEWAY_URL)return result('sms','not_configured','SMS gateway is not configured');
  if(!env.SMS_GATEWAY_HEALTH_URL)return result('sms','configured','SMS gateway configured; no safe health endpoint provided');
  try{
    const response=await fetch(env.SMS_GATEWAY_HEALTH_URL,{
      method:'HEAD',
      headers:env.SMS_GATEWAY_TOKEN?{authorization:`Bearer ${env.SMS_GATEWAY_TOKEN}`}:{},
      signal:AbortSignal.timeout(5000),
    });
    return response.ok
      ? result('sms','verified','SMS gateway health endpoint verified')
      : result('sms','failed','SMS gateway health check failed');
  }catch{return result('sms','failed','SMS gateway health check failed');}
}

export async function checkTimeScanStatus(connection?:{base_url:string;account_ref:string;secret_ref:string;enabled:boolean}):Promise<ProviderStatus>{
  if(!connection||!connection.enabled)return result('timescan','not_configured','TimeScan is not configured or disabled');
  const secret=process.env[connection.secret_ref];
  if(!secret)return result('timescan','configured','TimeScan configured; referenced secret is unavailable');
  try{
    await createTimeScanAdapter(connection.base_url,connection.account_ref,secret).verify();
    return result('timescan','verified','TimeScan connection verified');
  }catch{return result('timescan','failed','TimeScan verification failed');}
}
