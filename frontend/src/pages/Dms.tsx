import {ChangeEvent,FormEvent,useEffect,useState} from 'react';
import {useSearchParams} from 'react-router-dom';
import {api,csrf,hasPermission} from '../lib/api';
import {formatDateTime,formatNumber} from '../lib/format';
import {statusLabel} from '../lib/status';
import {isUuid} from '../lib/validation';
import {requiredUuidMessage} from '../lib/text';
import {uuid} from '../lib/uuid';

type Version={
  id:string;
  version_no:number;
  size_bytes:number;
  content_type:string;
  lifecycle_state:string;
  created_at:string;
  retention_until:string|null;
};
type Document={
  id:string;
  title:string;
  description:string|null;
  site_id:string|null;
  document_status:string;
  created_at:string;
  versions:Version[];
};
type Option={id:string;name:string};

function toBase64(file:File){
  return file.arrayBuffer().then(bytes=>{
    let binary='';
    const values=new Uint8Array(bytes);
    for(let index=0;index<values.length;index+=0x8000)binary+=String.fromCharCode(...values.subarray(index,index+0x8000));
    return btoa(binary);
  });
}

export function Dms(){
  const [searchParams,setSearchParams]=useSearchParams();
  const [documents,setDocuments]=useState<Document[]>([]);
  const [sites,setSites]=useState<Option[]>([]);
  const [employees,setEmployees]=useState<Option[]>([]);
  const [title,setTitle]=useState('');
  const [siteId,setSiteId]=useState('');
  const [employeeId,setEmployeeId]=useState('');
  const [category,setCategory]=useState('other');
  const [file,setFile]=useState<File|null>(null);
  const [error,setError]=useState('');
  const [success,setSuccess]=useState('');

  const load=async()=>{
    try{
      const [documentRows,siteRows,employeeRows]=await Promise.all([
        api<Document[]>('/dms/documents'),
        hasPermission('sites:read')?api<Option[]>('/sites'):Promise.resolve([]),
        hasPermission('employees:read')?api<Option[]>('/employees'):Promise.resolve([]),
      ]);
      setDocuments(documentRows??[]);
      setSites(siteRows??[]);
      setEmployees(employeeRows??[]);
    }catch(cause){setError((cause as Error).message);}
  };

  useEffect(()=>{void load();},[]);

  const upload=async(event:FormEvent)=>{
    event.preventDefault();
    if(!file)return;
    if(siteId&&!isUuid(siteId)){setError(requiredUuidMessage('Objekt','neutral'));return;}
    if(employeeId&&!isUuid(employeeId)){setError(requiredUuidMessage('Mitarbeiter','maskulin'));return;}
    try{
      await api('/dms/documents',{method:'POST',body:JSON.stringify({
        title,
        site_id:siteId?siteId.trim():null,
        employee_id:employeeId?employeeId.trim():null,
        employee_document_category:employeeId?category:null,
        content_type:file.type,
        content_base64:await toBase64(file),
        client_mutation_id:uuid(),
      })});
      setError('');
      setSuccess('Das Dokument wurde zur Prüfung übergeben.');
      setTitle('');
      setSiteId('');
      setEmployeeId('');
      setCategory('other');
      setFile(null);
      await load();
    }catch(cause){setError((cause as Error).message);}
  };

  const download=async(documentId:string,version:Version)=>{
    try{
      const response=await fetch(`/api/v1/dms/documents/${documentId}/versions/${version.id}/download`,{
        credentials:'include',
        headers:{'x-csrf-token':csrf()},
      });
      if(!response.ok)throw new Error((await response.json()).error||'Der Download ist fehlgeschlagen.');
      const blob=await response.blob();
      const url=URL.createObjectURL(blob);
      const link=window.document.createElement('a');
      link.href=url;
      link.download=`dokument-version-${version.version_no}`;
      link.click();
      URL.revokeObjectURL(url);
    }catch(cause){setError((cause as Error).message);}
  };

  const focusedId=searchParams.get('document');
  const focusedDocument=documents.find(document=>document.id===focusedId);

  return <section>
    <h2>Dokumentenmanagement</h2>
    <p>Verwalten Sie sicherheitsrelevante Dokumente in Fassungen und revisionssicher. Hochgeladene Dateien werden in Quarantäne geprüft und erst danach freigegeben.</p>
    {error&&<p role="alert">{error}</p>}
    {success&&<p role="status">{success}</p>}
    {focusedId&&<section className="object-record-focus" aria-label="Geöffnetes Dokument">
      <div>
        <span className="object-record-focus-label">Geöffnetes Dokument</span>
        {focusedDocument?<>
          <h3>{focusedDocument.title}</h3>
          <p>{statusLabel(focusedDocument.document_status,'document')} · {formatNumber(focusedDocument.versions.length)} Fassungen</p>
        </>:<h3>{hasPermission('dms:read')?'Dokument nicht verfügbar':'Keine Berechtigung für Dokumente'}</h3>}
      </div>
      <button type="button" onClick={()=>{
        const next=new URLSearchParams(searchParams);
        next.delete('document');
        setSearchParams(next,{replace:true});
      }}>{'Fokus schließen'}</button>
    </section>}
    <form onSubmit={upload}>
      <label>Titel
        <input required placeholder="Titel des Dokuments" value={title} onChange={event=>setTitle(event.target.value)}/>
      </label>
      <label>Objekt (optional)
        <select value={siteId} onChange={event=>setSiteId(event.target.value)}>
          <option value="">Kein Objekt</option>
          {sites.map(site=><option key={site.id} value={site.id}>{site.name}</option>)}
        </select>
      </label>
      <label>Mitarbeiter (optional)
        <select value={employeeId} onChange={event=>setEmployeeId(event.target.value)}>
          <option value="">Kein Mitarbeiter</option>
          {employees.map(employee=><option key={employee.id} value={employee.id}>{employee.name}</option>)}
        </select>
      </label>
      <label>Dokumentkategorie
        <select value={category} onChange={event=>setCategory(event.target.value)}>
          <option value="contract">Arbeitsvertrag</option>
          <option value="qualification">Qualifikationsnachweis</option>
          <option value="training">Schulung</option>
          <option value="instruction">Unterweisung oder Belehrung</option>
          <option value="personal">Personalunterlage</option>
          <option value="other">Sonstiges</option>
        </select>
      </label>
      <label>Datei
        <input required type="file" onChange={(event:ChangeEvent<HTMLInputElement>)=>setFile(event.target.files?.[0]??null)}/>
      </label>
      <button type="submit">Hochladen und prüfen</button>
    </form>
    <h3>Dokumente</h3>
    {documents.length===0?<p>Keine Dokumente erfasst.</p>:<ul>{documents.map(document=><li key={document.id} className={focusedId===document.id?'object-record-highlight':''}>
      <strong>{document.title}</strong> · {statusLabel(document.document_status,'document')}
      <ul>{document.versions.map(version=><li key={version.id}>
        Fassung {version.version_no}: {statusLabel(version.lifecycle_state,'document')} · {formatNumber(version.size_bytes)} Byte · {formatDateTime(version.created_at)}
        {version.lifecycle_state==='available'&&<button onClick={()=>void download(document.id,version)}>Herunterladen</button>}
      </li>)}</ul>
    </li>)}</ul>}
  </section>;
}
