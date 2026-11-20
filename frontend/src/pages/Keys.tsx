import {useEffect,useState} from 'react';
import {api} from '../lib/api';
import {uuid} from "../lib/uuid";

type KeyRecord={id:string;key_code:string;label:string;key_type:string;status:string;site_id:string|null;holder_user_id:string|null;holder_employee_id:string|null;created_at:string};

export function Keys(){
  const [keys,setKeys]=useState<KeyRecord[]>([]);const [label,setLabel]=useState('');const [keyCode,setKeyCode]=useState('');const [siteId,setSiteId]=useState('');const [holder,setHolder]=useState('');const [error,setError]=useState('');
  const load=async()=>{try{setKeys((await api<KeyRecord[]>('/keys'))??[]);}catch(e){setError((e as Error).message);}};
  useEffect(()=>{void load();},[]);
  const create=async(event:React.FormEvent)=>{event.preventDefault();try{await api('/keys',{method:'POST',body:JSON.stringify({label,key_code:keyCode,site_id:siteId||null,key_type:'physical',client_mutation_id:uuid()})});setLabel('');setKeyCode('');setSiteId('');await load();}catch(e){setError((e as Error).message);}};
  const mutate=async(id:string,action:string,body:Record<string,unknown>={})=>{try{await api(`/keys/${id}/${action}`,{method:'POST',body:JSON.stringify({...body,client_mutation_id:uuid()})});setHolder('');await load();}catch(e){setError((e as Error).message);}};
  return <section><h1>Schlüsselverwaltung</h1><p>Ausgabe, Rückgabe, Verlust und Deaktivierung werden tenant-/standortbezogen und revisionssicher protokolliert.</p>{error&&<p role="alert">{error}</p>}<form onSubmit={create}><label>Kennziffer<input required value={keyCode} onChange={event=>setKeyCode(event.target.value)}/></label><label>Bezeichnung<input required value={label} onChange={event=>setLabel(event.target.value)}/></label><label>Standort-ID<input value={siteId} onChange={event=>setSiteId(event.target.value)}/></label><button>Anlegen</button></form><label>Halter-UUID für Ausgabe<input value={holder} onChange={event=>setHolder(event.target.value)}/></label><ul>{keys.map(key=><li key={key.id}><strong>{key.label}</strong> ({key.key_code}) – {key.status}{key.status==='available'&&<button onClick={()=>void mutate(key.id,'issue',{holder_user_id:holder||null,holder_employee_id:holder?null:null})}>Ausgeben</button>}{key.status==='issued'&&<button onClick={()=>void mutate(key.id,'return')}>Rückgabe</button>}{key.status==='issued'&&<button onClick={()=>void mutate(key.id,'lost')}>Verlust</button>}{key.status!=='deactivated'&&<button onClick={()=>void mutate(key.id,'deactivate')}>Deaktivieren</button>}</li>)}</ul></section>;
}
