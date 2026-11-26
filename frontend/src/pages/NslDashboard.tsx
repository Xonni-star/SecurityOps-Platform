import {useEffect,useState} from 'react';
import {api} from '../lib/api';
import {formatDateTime,formatNumber} from '../lib/format';
import {statusLabel} from '../lib/status';

type DashboardSummary={
  unacknowledged_alarms:number;
  critical_alarms:number;
  acknowledged_alarms:number;
  escalated_alarms:number;
  open_alarms:number;
  active_incidents:number;
  on_duty_resources:number;
  assigned_resources:number;
  open_handovers:number;
  technical_issues:number;
};
type Dashboard={
  alarms:Record<string,unknown>[];
  incidents:Record<string,unknown>[];
  positions:Record<string,unknown>[];
  patrols:Record<string,unknown>[];
  summary:DashboardSummary;
  last_updated_at:string;
};

const emptySummary:DashboardSummary={
  unacknowledged_alarms:0,
  critical_alarms:0,
  acknowledged_alarms:0,
  escalated_alarms:0,
  open_alarms:0,
  active_incidents:0,
  on_duty_resources:0,
  assigned_resources:0,
  open_handovers:0,
  technical_issues:0,
};

export function NslDashboard(){
  const [data,setData]=useState<Dashboard>({
    alarms:[],incidents:[],positions:[],patrols:[],summary:emptySummary,last_updated_at:'',
  });
  const [error,setError]=useState('');

  const load=()=>api<Dashboard>('/nsl/dashboard')
    .then(value=>setData(value||{
      alarms:[],incidents:[],positions:[],patrols:[],summary:emptySummary,last_updated_at:'',
    }))
    .catch(cause=>setError((cause as Error).message));

  useEffect(()=>{
    void load();
    const socket=new WebSocket(`${location.protocol==='https:'?'wss':'ws:'}//${location.host}/ws`);
    socket.onmessage=event=>{
      const type=(JSON.parse(event.data) as {type?:string}).type??'';
      if(type.startsWith('alarm.')||type.startsWith('incident.')||type.startsWith('position.')||type.startsWith('handover.'))void load();
    };
    return ()=>socket.close();
  },[]);

  const summary=data.summary;
  const text=(value:unknown)=>value===null||value===undefined||value===''?'Nicht verfügbar':String(value);

  return <section>
    <h2>Leitstelle</h2>
    <p>Behalten Sie Alarme, Einsätze, Positionen und Ressourcen der laufenden Schicht im Blick.</p>
    {error&&<p role="alert">{error}</p>}
    <div className="dashboard-grid">
      <article><h3>Alarmstatus</h3><dl>
        <dt>Unbestätigt</dt><dd>{formatNumber(summary.unacknowledged_alarms)}</dd>
        <dt>Kritisch</dt><dd>{formatNumber(summary.critical_alarms)}</dd>
        <dt>In Bearbeitung</dt><dd>{formatNumber(summary.acknowledged_alarms)}</dd>
        <dt>Eskaliert</dt><dd>{formatNumber(summary.escalated_alarms)}</dd>
      </dl></article>
      <article><h3>Operative Lage</h3><dl>
        <dt>Offene Alarme</dt><dd>{formatNumber(summary.open_alarms)}</dd>
        <dt>Aktive Einsätze</dt><dd>{formatNumber(summary.active_incidents)}</dd>
        <dt>Offene Übergaben</dt><dd>{formatNumber(summary.open_handovers)}</dd>
      </dl></article>
      <article><h3>Ressourcen</h3><dl>
        <dt>Im Dienst</dt><dd>{formatNumber(summary.on_duty_resources)}</dd>
        <dt>Zugewiesen</dt><dd>{formatNumber(summary.assigned_resources)}</dd>
        <dt>Technische Störungen</dt><dd>{formatNumber(summary.technical_issues)}</dd>
      </dl></article>
      <article><h3>Offene Alarme ({formatNumber(data.alarms.length)})</h3>
        <ul>{data.alarms.map(alarm=><li key={String(alarm.id)}>
          <strong>{text(alarm.priority_name||alarm.priority_code)}</strong> {text(alarm.description)}
          <br/>
          <small>{text(alarm.site_name||'Kein Objekt')} · {statusLabel(String(alarm.status),'alarm')} · {formatNumber(Number(alarm.age_seconds))} Sekunden</small>
        </li>)}</ul>
        {data.alarms.length===0&&<p>Keine offenen Alarme.</p>}
      </article>
      <article><h3>Aktive Einsätze ({formatNumber(data.incidents.length)})</h3>
        <ul>{data.incidents.map(incident=><li key={String(incident.id)}>
          <strong>{text(incident.priority_name)}</strong> {text(incident.description)}
          <br/>
          <small>{text(incident.site_name||'Kein Objekt')} · {statusLabel(String(incident.status),'incident')}</small>
        </li>)}</ul>
        {data.incidents.length===0&&<p>Keine aktiven Einsätze.</p>}
      </article>
      <article><h3>Positionen ({formatNumber(data.positions.length)})</h3>
        <ul>{data.positions.map(position=><li key={String(position.id)}>
          {text(position.device_name)}: {text(position.latitude)}, {text(position.longitude)}
          <br/>
          <small>{statusLabel(String(position.device_status),'device')} · {formatDateTime(String(position.recorded_at))}</small>
        </li>)}</ul>
        {data.positions.length===0&&<p>Keine Positionen vorhanden.</p>}
      </article>
      <article><h3>Kontrollgänge ({formatNumber(data.patrols.length)})</h3>
        <ul>{data.patrols.map(patrol=><li key={String(patrol.id)}>
          {text(patrol.name)} · {text(patrol.site_name)}
          <br/>
          <small>{text(patrol.employee_name||'Nicht zugewiesen')} · {formatNumber(Number(patrol.scan_count))} Kontrollpunkte</small>
        </li>)}</ul>
        {data.patrols.length===0&&<p>Keine Kontrollgänge erfasst.</p>}
      </article>
    </div>
    <p>Zuletzt aktualisiert: {formatDateTime(data.last_updated_at)}</p>
    <p>
      <a href="/api/v1/reports/alarms?format=csv" target="_blank" rel="noreferrer">Alarmbericht als CSV exportieren</a>
      {' · '}
      <a href="/api/v1/reports/alarms?format=pdf" target="_blank" rel="noreferrer">Alarmbericht als PDF exportieren</a>
    </p>
  </section>;
}
