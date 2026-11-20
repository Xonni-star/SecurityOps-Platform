import {sha256,MalwareScanResult} from './dms-providers.js';

export type DmsLifecycleState='quarantined'|'scanning'|'available'|'rejected'|'deleted';

export function validateDmsUpload(content:Buffer,contentType:string,maxBytes:number,allowedTypes:Set<string>){
  if(!allowedTypes.has(contentType))throw Object.assign(new Error('Content-Type is not allowed'),{status:415});
  if(content.length===0)throw Object.assign(new Error('Document content must not be empty'),{status:400});
  if(content.length>maxBytes)throw Object.assign(new Error('Document exceeds configured size limit'),{status:413});
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
