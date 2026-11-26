import {ChangeEvent,useEffect,useState} from 'react';
import {useSearchParams} from 'react-router-dom';
import {api,csrf,hasPermission} from '../lib/api';
import {uuid} from "../lib/uuid";
import {isUuid} from '../lib/validation';

type Version={id:string;version_no:number;size_bytes:number;content_type:string;lifecycle_state:string;created_at:string;retention_until:string|null};
type Document={id:string;title:string;description:string|null;site_id:string|null;document_status:string;created_at:string;versions:Version[]};

function toBase64(file:File){
  return file.arrayBuffer().then(bytes=>{
    let binary='';const values=new Uint8Array(bytes);
    for(let index=0;index<values.length;index+=0x8000)binary+=String.fromCharCode(...values.subarray(index,index+0x8000));
    return btoa(binary);
  });
}

export function Dms(){
  const [searchParams,setSearchParams]=useSearchParams();
  const [documents,setDocuments]=useState<Document[]>([]);const [title,setTitle]=useState('');const [siteId,setSiteId]=useState('');const [employeeId,setEmployeeId]=useState('');const [category,setCategory]=useState('other');const [file,setFile]=useState<File|null>(null);const [error,setError]=useState('');
  const load=async()=>{try{setDocuments((await api<Document[]>('/dms/documents'))??[]);}catch(e){setError((e as Error).message);}};
  useEffect(()=>{void load();},[]);
  const upload=async(event:React.FormEvent)=>{event.preventDefault();if(!file)return;if((siteId&&!isUuid(siteId))||(employeeId&&!isUuid(employeeId))){setError('Bitte gültige Objekt- und Mitarbeiter-IDs angeben.');return;}try{await api('/dms/documents',{method:'POST',body:JSON.stringify({title,site_id:siteId?siteId.trim():null,employee_id:employeeId?employeeId.trim():null,employee_document_category:employeeId?category:null,content_type:file.type,content_base64:await toBase64(file),client_mutation_id:uuid()})});setError('');setTitle('');setSiteId('');setEmployeeId('');setCategory('other');setFile(null);await load();}catch(e){setError((e as Error).message);}};
  const download=async(documentId:string,version:Version)=>{try{const response=await fetch(`/api/v1/dms/documents/${documentId}/versions/${version.id}/download`,{credentials:'include',headers:{'x-csrf-token':csrf()}});if(!response.ok)throw new Error((await response.json()).error||'Download fehlgeschlagen');const blob=await response.blob();const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=`document-v${version.version_no}`;link.click();URL.revokeObjectURL(url);}catch(e){setError((e as Error).message);}};
  return <section><h1>Dokumentenmanagement</h1><p>Uploads werden in Quarantäne gespeichert, durch ClamAV geprüft und erst danach zum Download freigegeben. Binärdaten werden nicht offline synchronisiert.</p>{error&&<p role="alert">{error}</p>}{searchParams.get('document')&&<section className="object-record-focus" aria-label="Geöffnetes Dokument"><div><span className="object-record-focus-label">Geöffnetes Dokument</span>{documents.find(document=>document.id===searchParams.get('document'))?<><h3>{documents.find(document=>document.id===searchParams.get('document'))!.title}</h3><p>{documents.find(document=>document.id===searchParams.get('document'))!.document_status} · {documents.find(document=>document.id===searchParams.get('document'))!.versions.length} Version(en)</p></>:<h3>{hasPermission('dms:read')?'Dokument nicht verfügbar':'Keine Berechtigung für Dokumente'}</h3>}</div><button type="button" onClick={()=>{const next=new URLSearchParams(searchParams);next.delete('document');setSearchParams(next,{replace:true});}}>Fokus schließen</button></section>}<form onSubmit={upload}><label>Titel<input required value={title} onChange={event=>setTitle(event.target.value)}/></label><label>Standort-ID (optional)<input value={siteId} onChange={event=>setSiteId(event.target.value)}/></label><label>Mitarbeiter-ID (optional)<input value={employeeId} onChange={event=>setEmployeeId(event.target.value)}/></label><label>Mitarbeiter-Dokumentkategorie<select value={category} onChange={event=>setCategory(event.target.value)}><option value="contract">Arbeitsvertrag</option><option value="qualification">Qualifikationsnachweis</option><option value="training">Schulung</option><option value="instruction">Unterweisung/Belehrung</option><option value="personal">Personalunterlage</option><option value="other">Sonstiges</option></select></label><label>Datei<input required type="file" onChange={(event:ChangeEvent<HTMLInputElement>)=>setFile(event.target.files?.[0]??null)}/></label><button>Hochladen und prüfen</button></form><h2>Dokumente</h2>{documents.length===0?<p>Keine Dokumente.</p>:<ul>{documents.map(document=><li key={document.id} className={searchParams.get('document')===document.id?'object-record-highlight':''}><strong>{document.title}</strong> ({document.document_status})<ul>{document.versions.map(version=><li key={version.id}>Version {version.version_no}: {version.lifecycle_state} – {version.size_bytes} Bytes {version.lifecycle_state==='available'&&<button onClick={()=>void download(document.id,version)}>Download</button>}</li>)}</ul></li>)}</ul>}</section>;
}
