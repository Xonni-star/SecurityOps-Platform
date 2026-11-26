import {useEffect,useState} from 'react';
import {api} from '../lib/api';
import {formatDateTime,formatNumber} from '../lib/format';
import {priorityLabel,statusLabel} from '../lib/status';

type Event={id:string;device_id:string;sensor_type:string;value:number;recorded_at:string};
type Threshold={id:string;sensor_type:string;threshold:number;duration_seconds:number;priority_code:string;enabled:boolean};

export function Telemetry(){
  const [events,setEvents]=useState<Event[]>([]);
  const [thresholds,setThresholds]=useState<Threshold[]>([]);
  const [error,setError]=useState('');

  const load=()=>Promise.all([
    api<Event[]>('/sensor-events'),
    api<Threshold[]>('/sensor-thresholds'),
  ]).then(([sensorEvents,sensorThresholds])=>{
    setEvents(sensorEvents||[]);
    setThresholds(sensorThresholds||[]);
  }).catch(cause=>setError((cause as Error).message));

  useEffect(()=>{
    void load();
    const socket=new WebSocket(`${location.protocol==='https:'?'wss':'ws:'}//${location.host}/ws`);
    socket.onmessage=event=>{
      const message=JSON.parse(event.data) as {type?:string};
      if(message.type==='sensor.updated')void load();
    };
    return ()=>socket.close();
  },[]);

  return <section>
    <h2>Sensoren</h2>
    <p>Überwachen Sie Sensorwerte und die konfigurierten Schwellenwerte der technischen Ausstattung.</p>
    {error&&<p role="alert">{error}</p>}
    <h3>Schwellenwerte</h3>
    <table>
      <thead><tr><th>Sensortyp</th><th>Grenzwert</th><th>Dauer</th><th>Priorität</th><th>Status</th></tr></thead>
      <tbody>{thresholds.map(threshold=><tr key={threshold.id}>
        <td>{statusLabel(threshold.sensor_type,'sensor')}</td>
        <td>{formatNumber(threshold.threshold)}</td>
        <td>{formatNumber(threshold.duration_seconds)} Sekunden</td>
        <td>{priorityLabel(threshold.priority_code)}</td>
        <td>{statusLabel(threshold.enabled?'active':'inactive')}</td>
      </tr>)}</tbody>
    </table>
    {thresholds.length===0&&<p>Keine Schwellenwerte konfiguriert.</p>}
    <h3>Letzte Ereignisse</h3>
    <table>
      <thead><tr><th>Sensortyp</th><th>Messwert</th><th>Zeitpunkt</th></tr></thead>
      <tbody>{events.map(event=><tr key={event.id}>
        <td>{statusLabel(event.sensor_type,'sensor')}</td>
        <td>{formatNumber(event.value)}</td>
        <td>{formatDateTime(event.recorded_at)}</td>
      </tr>)}</tbody>
    </table>
    {events.length===0&&<p>Keine Sensormeldungen erfasst.</p>}
  </section>;
}
