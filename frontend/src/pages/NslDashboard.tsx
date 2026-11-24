import {useEffect,useState} from 'react';
import {api} from '../lib/api';
type DashboardSummary={unacknowledged_alarms:number;critical_alarms:number;acknowledged_alarms:number;escalated_alarms:number;open_alarms:number;active_incidents:number;on_duty_resources:number;assigned_resources:number;open_handovers:number;technical_issues:number};
type Dashboard={alarms:Record<string,unknown>[];incidents:Record<string,unknown>[];positions:Record<string,unknown>[];patrols:Record<string,unknown>[];summary:DashboardSummary;last_updated_at:string};
const emptySummary:DashboardSummary={unacknowledged_alarms:0,critical_alarms:0,acknowledged_alarms:0,escalated_alarms:0,open_alarms:0,active_incidents:0,on_duty_resources:0,assigned_resources:0,open_handovers:0,technical_issues:0};
export function NslDashboard(){
  const [data,setData]=useState<Dashboard>({alarms:[],incidents:[],positions:[],patrols:[],summary:emptySummary,last_updated_at:''});const [error,setError]=useState('');
  const load=()=>api<Dashboard>('/nsl/dashboard').then(value=>setData(value||{alarms:[],incidents:[],positions:[],patrols:[],summary:emptySummary,last_updated_at:''})).catch(e=>setError(e.message));
  useEffect(()=>{load();const ws=new WebSocket(`${location.protocol==='https:'?'wss':'ws:'}//${location.host}/ws`);ws.onmessage=event=>{const type=JSON.parse(event.data).type;if(type.startsWith('alarm.')||type.startsWith('incident.')||type.startsWith('position.')||type.startsWith('handover.'))load();};return()=>ws.close();},[]);
  const s=data.summary;
  return <section><h1>NSL-Leitstelle</h1>{error&&<p role="alert">{error}</p>}<div className="dashboard-grid">
    <article><h2>Alarmstatus</h2><dl><dt>Unbestätigt</dt><dd>{s.unacknowledged_alarms}</dd><dt>Kritisch</dt><dd>{s.critical_alarms}</dd><dt>In Bearbeitung</dt><dd>{s.acknowledged_alarms}</dd><dt>Eskaliert</dt><dd>{s.escalated_alarms}</dd></dl></article>
    <article><h2>Operative Lage</h2><dl><dt>Offene Alarme</dt><dd>{s.open_alarms}</dd><dt>Aktive Einsätze</dt><dd>{s.active_incidents}</dd><dt>Offene Übergaben</dt><dd>{s.open_handovers}</dd></dl></article>
    <article><h2>Ressourcen</h2><dl><dt>Im Dienst</dt><dd>{s.on_duty_resources}</dd><dt>Gebunden</dt><dd>{s.assigned_resources}</dd><dt>Technische Störungen</dt><dd>{s.technical_issues}</dd></dl></article>
    <article><h2>Offene Alarme ({data.alarms.length})</h2><ul>{data.alarms.map(a=><li key={String(a.id)}><strong>{String(a.priority_name||a.priority_code)}</strong> {String(a.description)}<br/><small>{String(a.site_name||'Kein Objekt')} · {String(a.status)} · {String(a.age_seconds)} s</small></li>)}</ul></article>
    <article><h2>Aktive Einsätze ({data.incidents.length})</h2><ul>{data.incidents.map(i=><li key={String(i.id)}><strong>{String(i.priority_name)}</strong> {String(i.description)}<br/><small>{String(i.site_name||'Kein Objekt')} · {String(i.status)}</small></li>)}</ul></article>
    <article><h2>Positionen ({data.positions.length})</h2><ul>{data.positions.map(p=><li key={String(p.id)}>{String(p.device_name)}: {String(p.latitude)}, {String(p.longitude)}<br/><small>{String(p.device_status)} · {String(p.recorded_at)}</small></li>)}</ul></article>
    <article><h2>Kontrollgänge ({data.patrols.length})</h2><ul>{data.patrols.map(p=><li key={String(p.id)}>{String(p.name)} · {String(p.site_name)}<br/><small>{String(p.employee_name||'Nicht zugewiesen')} · {String(p.scan_count)} Scans</small></li>)}</ul></article>
  </div><p>Zuletzt aktualisiert: {data.last_updated_at?new Date(data.last_updated_at).toLocaleString():'-'}</p><p><a href="/api/v1/reports/alarms?format=csv" target="_blank" rel="noreferrer">Alarmbericht CSV exportieren</a> · <a href="/api/v1/reports/alarms?format=pdf" target="_blank" rel="noreferrer">PDF exportieren</a></p></section>;
}
