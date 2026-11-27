import {sha256,MalwareScanResult} from './dms-providers.js';

export type DmsLifecycleState='quarantined'|'scanning'|'available'|'rejected'|'deleted';

function contentMatchesType(content:Buffer,contentType:string){
  if(contentType==='application/pdf')return content.subarray(0,5).toString('latin1')==='%PDF-';
  if(contentType==='image/jpeg')return content[0]===0xff&&content[1]===0xd8&&content[2]===0xff;
  if(contentType==='image/png')return content.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
  if(contentType==='text/plain')return !content.some(byte=>byte===0||(byte<0x20&&![0x09,0x0a,0x0c,0x0d].includes(byte)));
  // Unbekannte, aber ausdrücklich zugelassene Typen werden nicht geraten.
  return true;
}

export function validateDmsUpload(content:Buffer,contentType:string,maxBytes:number,allowedTypes:Set<string>){
  if(!allowedTypes.has(contentType))throw Object.assign(new Error('Content-Type ist nicht erlaubt'),{status:415});
  if(content.length===0)throw Object.assign(new Error('Dokumentinhalt darf nicht leer sein'),{status:400});
  if(content.length>maxBytes)throw Object.assign(new Error('Dokument überschreitet die konfigurierte Größenbegrenzung'),{status:413});
  // Der Dateityp wird nicht allein aus Name/Endung oder dem Client-Header
  // abgeleitet: die Magic Bytes müssen zum deklarierten Typ passen.
  if(!contentMatchesType(content,contentType))throw Object.assign(new Error('Dateiinhalt entspricht nicht dem angegebenen Dateityp'),{status:415});
  return {sizeBytes:content.length,sha256:sha256(content)};
}

export function scanLifecycle(result:MalwareScanResult):{state:'available'|'rejected';rejectionReason?:string}{
  return result.clean?{state:'available'}:{state:'rejected',rejectionReason:result.signature??'malware_detected'};
}

export function nextDmsVersion(current:number|undefined){return (current??0)+1;}
export function canDownloadDmsVersion(documentStatus:string,state:DmsLifecycleState){return documentStatus==='active'&&state==='available';}
export function retentionDue(retentionUntil:string|Date|null,now=new Date()){
  return retentionUntil!==null&&retentionUntil!==undefined&&new Date(retentionUntil).getTime()<=now.getTime();
}
