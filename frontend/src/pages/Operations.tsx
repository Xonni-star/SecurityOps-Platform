import {useEffect,useState} from 'react';
import {api} from '../lib/api';
import {statusLabel} from '../lib/status';

type Alarm={
  id:string;
  description:string;
  status:string;
  priority_name:string;
  priority_code:string;
  source:string;
  triggered_at:string;
};

export function Operations(){
  const [alarms,setAlarms]=useState<Alarm[]>([]);
  const [error,setError]=useState('');

  const load=()=>api<Alarm[]>('/alarms')
    .then(value=>setAlarms(value||[]))
    .catch(cause=>setError((cause as Error).message));

  useEffect(()=>{
    void load();
    const socket=new WebSocket(`${location.protocol==='https:'?'wss':'ws:'}//${location.host}/ws`);
    socket.onmessage=event=>{
      const message=JSON.parse(event.data) as {type?:string};
      if(message.type?.startsWith('alarm.'))void load();
    };
    return ()=>socket.close();
  },[]);

  const act=(id:string,status:'acknowledge'|'resolve')=>api(`/alarms/${id}/${status}`,{method:'POST'})
    .then(load)
    .catch(cause=>setError((cause as Error).message));

  return <section>
    <h2>Alarme</h2>
    <p>Prüfen Sie eingehende Alarme, übernehmen Sie die Bearbeitung und schließen Sie Vorgänge nachvollziehbar ab.</p>
    {error&&<p role="alert">{error}</p>}
    <table>
      <thead><tr><th>Priorität</th><th>Beschreibung</th><th>Quelle</th><th>Status</th><th>Aktion</th></tr></thead>
      <tbody>{alarms.map(alarm=><tr key={alarm.id}>
        <td>{alarm.priority_name||alarm.priority_code}</td>
        <td>{alarm.description}</td>
        <td>{alarm.source}</td>
        <td>{statusLabel(alarm.status,'alarm')}</td>
        <td>
          {alarm.status==='open'&&<button onClick={()=>void act(alarm.id,'acknowledge')}>Quittieren</button>}
          {['acknowledged','escalated'].includes(alarm.status)&&<button onClick={()=>void act(alarm.id,'resolve')}>Als erledigt markieren</button>}
        </td>
      </tr>)}</tbody>
    </table>
    {alarms.length===0&&<p>Keine Alarme vorhanden.</p>}
  </section>;
}
