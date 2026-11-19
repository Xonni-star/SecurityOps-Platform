import {FormEvent,useEffect,useState} from 'react';
import {api} from '../lib/api';
type Device={id:string;identifier:string;device_type:string;manufacturer:string;status:string;employee_name?:string;site_name?:string;control_point_name?:string};
export function NfcDevices(){
  const [items,setItems]=useState<Device[]>([]);const [form,setForm]=useState({identifier:'',device_type:'tag',manufacturer:'',status:'active'});const [error,setError]=useState('');
  const load=()=>api<Device[]>('/nfc-devices').then(value=>setItems(value||[])).catch(e=>setError(e.message));
  useEffect(()=>{load();},[]);
  const create=async(event:FormEvent)=>{event.preventDefault();try{await api('/nfc-devices',{method:'POST',body:JSON.stringify(form)});setForm({identifier:'',device_type:'tag',manufacturer:'',status:'active'});load();}catch(e){setError((e as Error).message);}};
  const changeStatus=async(device:Device,status:string)=>{try{await api(`/nfc-devices/${device.id}`,{method:'PATCH',body:JSON.stringify({status})});load();}catch(e){setError((e as Error).message);}};
  return <section><h1>NFC-Geräteverwaltung</h1>{error&&<p role="alert">{error}</p>}<form onSubmit={create}><label>Kennung<input value={form.identifier} onChange={e=>setForm({...form,identifier:e.target.value})} required/></label><label>Typ<input value={form.device_type} onChange={e=>setForm({...form,device_type:e.target.value})} required/></label><label>Hersteller<input value={form.manufacturer} onChange={e=>setForm({...form,manufacturer:e.target.value})} required/></label><button>Registrieren</button></form><table><thead><tr><th>Kennung</th><th>Typ</th><th>Hersteller</th><th>Status</th><th>Zuordnung</th><th>Aktion</th></tr></thead><tbody>{items.map(device=><tr key={device.id}><td>{device.identifier}</td><td>{device.device_type}</td><td>{device.manufacturer}</td><td>{device.status}</td><td>{device.employee_name||device.site_name||device.control_point_name||'Nicht zugeordnet'}</td><td>{device.status!=='active'&&<button onClick={()=>changeStatus(device,'active')}>Aktivieren</button>}{device.status==='active'&&<button onClick={()=>changeStatus(device,'blocked')}>Sperren</button>}</td></tr>)}</tbody></table></section>;
}
