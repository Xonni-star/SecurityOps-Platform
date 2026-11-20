import {useEffect,useState} from 'react';
import {api,AuthenticatedDevice,hasPermission} from '../lib/api';
type Audit={id:string;event_type:string;actor_email:string|null;created_at:string;details:Record<string,unknown>};
export function Admin(){
  const [items,setItems]=useState<Audit[]>([]);const [backups,setBackups]=useState<string[]>([]);const [devices,setDevices]=useState<AuthenticatedDevice[]>([]);const [error,setError]=useState('');
  const loadDevices=()=>hasPermission('authenticated_devices:read')?api<AuthenticatedDevice[]>('/auth/devices').then(value=>setDevices(value||[])):Promise.resolve();
  useEffect(()=>{Promise.all([api<Audit[]>('/audit'),api<{files:string[]}>('/backups/status'),loadDevices()]).then(([audit,backup])=>{setItems(audit||[]);setBackups(backup?.files||[])}).catch(e=>setError(e.message));},[]);
  async function revoke(id:string){try{await api(`/auth/devices/${id}/revoke`,{method:'POST'});await loadDevices();}catch(e){setError((e as Error).message);}}
  return <section><h1>Administration & Datenschutz</h1>{error&&<p role="alert">{error}</p>}<p><a href="/api/v1/audit/export" target="_blank" rel="noreferrer">Audit-Log als CSV exportieren</a></p>{devices.length>0&&<><h2>Vertrauensgeräte</h2><ul>{devices.map(device=><li key={device.id}><strong>{device.name}</strong> · zuletzt aktiv: {device.last_seen_at||'unbekannt'} · {device.revoked_at?'widerrufen':'aktiv'} {!device.revoked_at&&hasPermission('authenticated_devices:write')&&<button onClick={()=>revoke(device.id)}>Widerrufen</button>}</li>)}</ul></>}<h2>Backups</h2>{backups.length?<ul>{backups.map(file=><li key={file}>{file}</li>)}</ul>:<p>Keine Backup-Artefakte im konfigurierten Verzeichnis.</p>}<h2>Audit-Log</h2><ul>{items.map(item=><li key={item.id}><strong>{item.event_type}</strong> · {item.actor_email||'System'} · {item.created_at}</li>)}</ul></section>;
}
