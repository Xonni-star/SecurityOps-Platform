import {useEffect,useState} from 'react';
import {api} from '../lib/api';
type Audit={id:string;event_type:string;actor_email:string|null;created_at:string;details:Record<string,unknown>};
export function Admin(){
  const [items,setItems]=useState<Audit[]>([]);const [backups,setBackups]=useState<string[]>([]);const [error,setError]=useState('');
  useEffect(()=>{Promise.all([api<Audit[]>('/audit'),api<{files:string[]}>('/backups/status')]).then(([audit,backup])=>{setItems(audit||[]);setBackups(backup?.files||[])}).catch(e=>setError(e.message));},[]);
  return <section><h1>Administration & Datenschutz</h1>{error&&<p role="alert">{error}</p>}<p><a href="/api/v1/audit/export" target="_blank" rel="noreferrer">Audit-Log als CSV exportieren</a></p><h2>Backups</h2>{backups.length?<ul>{backups.map(file=><li key={file}>{file}</li>)}</ul>:<p>Keine Backup-Artefakte im konfigurierten Verzeichnis.</p>}<h2>Audit-Log</h2><ul>{items.map(item=><li key={item.id}><strong>{item.event_type}</strong> · {item.actor_email||'System'} · {item.created_at}</li>)}</ul></section>;
}
