import {FormEvent,useEffect,useState} from 'react';
import {api} from '../lib/api';
import {statusLabel} from '../lib/status';

type Device={
  id:string;
  identifier:string;
  device_type:string;
  manufacturer:string;
  status:string;
  employee_name?:string;
  site_name?:string;
  control_point_name?:string;
};

export function NfcDevices(){
  const [items,setItems]=useState<Device[]>([]);
  const [form,setForm]=useState({identifier:'',device_type:'tag',manufacturer:'',status:'active'});
  const [error,setError]=useState('');
  const [success,setSuccess]=useState('');

  const load=()=>api<Device[]>('/nfc-devices')
    .then(value=>setItems(value||[]))
    .catch(cause=>setError((cause as Error).message));

  useEffect(()=>{void load();},[]);

  const create=async(event:FormEvent)=>{
    event.preventDefault();
    try{
      await api('/nfc-devices',{method:'POST',body:JSON.stringify(form)});
      setForm({identifier:'',device_type:'tag',manufacturer:'',status:'active'});
      setError('');
      setSuccess('Das NFC-Gerät wurde registriert.');
      await load();
    }catch(cause){setError((cause as Error).message);}
  };

  const changeStatus=async(device:Device,status:string)=>{
    try{
      await api(`/nfc-devices/${device.id}`,{method:'PATCH',body:JSON.stringify({status})});
      await load();
    }catch(cause){setError((cause as Error).message);}
  };

  const deviceType=(value:string)=>{
    if(value==='tag')return 'NFC-Tag';
    if(value==='reader')return 'Lesegerät';
    return value;
  };

  return <section>
    <h2>NFC-Geräte</h2>
    <p>Registrieren Sie NFC-Geräte, prüfen Sie ihre Zuordnung und sperren Sie verlorene Geräte.</p>
    {error&&<p role="alert">{error}</p>}
    {success&&<p role="status">{success}</p>}
    <form onSubmit={create}>
      <label>Kennung
        <input required placeholder="Kennung des NFC-Geräts" value={form.identifier} onChange={event=>setForm({...form,identifier:event.target.value})}/>
      </label>
      <label>Gerätetyp
        <select value={form.device_type} onChange={event=>setForm({...form,device_type:event.target.value})}>
          <option value="tag">NFC-Tag</option>
          <option value="reader">Lesegerät</option>
        </select>
      </label>
      <label>Hersteller
        <input required placeholder="Herstellername" value={form.manufacturer} onChange={event=>setForm({...form,manufacturer:event.target.value})}/>
      </label>
      <button type="submit">Gerät registrieren</button>
    </form>
    <table>
      <thead><tr><th>Kennung</th><th>Gerätetyp</th><th>Hersteller</th><th>Status</th><th>Zuordnung</th><th>Aktion</th></tr></thead>
      <tbody>{items.map(device=><tr key={device.id}>
        <td>{device.identifier}</td>
        <td>{deviceType(device.device_type)}</td>
        <td>{device.manufacturer}</td>
        <td>{statusLabel(device.status,'nfc')}</td>
        <td>{device.employee_name||device.site_name||device.control_point_name||'Nicht zugewiesen'}</td>
        <td>
          {device.status!=='active'&&<button onClick={()=>void changeStatus(device,'active')}>Aktivieren</button>}
          {device.status==='active'&&<button onClick={()=>void changeStatus(device,'blocked')}>Sperren</button>}
        </td>
      </tr>)}</tbody>
    </table>
    {items.length===0&&<p>Keine NFC-Geräte registriert.</p>}
  </section>;
}
