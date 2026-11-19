import {useEffect,useState} from 'react';
import {api} from '../lib/api';
type Dashboard={alarms:Record<string,unknown>[];incidents:Record<string,unknown>[];positions:Record<string,unknown>[];patrols:Record<string,unknown>[]};
export function NslDashboard(){
  const [data,setData]=useState<Dashboard>({alarms:[],incidents:[],positions:[],patrols:[]});const [error,setError]=useState('');
  const load=()=>api<Dashboard>('/nsl/dashboard').then(value=>setData(value||{alarms:[],incidents:[],positions:[],patrols:[]})).catch(e=>setError(e.message));
  useEffect(()=>{load();const ws=new WebSocket(`${location.protocol==='https:'?'wss':'ws:'}//${location.host}/ws`);ws.onmessage=event=>{const type=JSON.parse(event.data).type;if(type.startsWith('alarm.')||type.startsWith('incident.')||type.startsWith('position.')||type.startsWith('handover.'))load();};return()=>ws.close();},[]);
  return <section><h1>NSL-Leitstelle</h1>{error&&<p role="alert">{error}</p>}<div className="dashboard-grid">
    <article><h2>Offene Alarme ({data.alarms.length})</h2><ul>{data.alarms.map(a=><li key={String(a.id)}><strong>{String(a.priority_name||a.priority_code)}</strong> {String(a.description)}<br/><small>{String(a.site_name||'Kein Objekt')} · {String(a.status)} · {String(a.age_seconds)} s</small></li>)}</ul></article>
    <article><h2>Aktive Einsätze ({data.incidents.length})</h2><ul>{data.incidents.map(i=><li key={String(i.id)}><strong>{String(i.priority_name)}</strong> {String(i.description)}<br/><small>{String(i.site_name||'Kein Objekt')} · {String(i.status)}</small></li>)}</ul></article>
    <article><h2>Positionen ({data.positions.length})</h2><ul>{data.positions.map(p=><li key={String(p.id)}>{String(p.device_name)}: {String(p.latitude)}, {String(p.longitude)}<br/><small>{String(p.device_status)} · {String(p.recorded_at)}</small></li>)}</ul></article>
    <article><h2>Kontrollgänge ({data.patrols.length})</h2><ul>{data.patrols.map(p=><li key={String(p.id)}>{String(p.name)} · {String(p.site_name)}<br/><small>{String(p.employee_name||'Nicht zugewiesen')} · {String(p.scan_count)} Scans</small></li>)}</ul></article>
  </div><p><a href="/api/v1/reports/alarms?format=csv" target="_blank" rel="noreferrer">Alarmbericht CSV exportieren</a> · <a href="/api/v1/reports/alarms?format=pdf" target="_blank" rel="noreferrer">PDF exportieren</a></p></section>;
}
