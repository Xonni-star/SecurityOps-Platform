import {useEffect,useState} from 'react';
import {api} from '../lib/api';
import {statusLabel} from '../lib/status';

type Incident={
  id:string;
  description:string;
  status:string;
  priority_name:string;
  site_name:string|null;
  assignees:{id:string;name:string}[];
};

const columns=['initiated','en_route','on_site','completed'] as const;
const nextStatus:Record<string,string>={initiated:'en_route',en_route:'on_site',on_site:'completed'};

export function Incidents(){
  const [items,setItems]=useState<Incident[]>([]);
  const [error,setError]=useState('');

  const load=()=>api<Incident[]>('/incidents')
    .then(value=>setItems(value||[]))
    .catch(cause=>setError((cause as Error).message));

  useEffect(()=>{
    void load();
    const socket=new WebSocket(`${location.protocol==='https:'?'wss':'ws:'}//${location.host}/ws`);
    socket.onmessage=event=>{
      const message=JSON.parse(event.data) as {type?:string};
      if(message.type?.startsWith('incident.'))void load();
    };
    return ()=>socket.close();
  },[]);

  const advance=(incident:Incident)=>{
    const status=nextStatus[incident.status];
    if(!status)return;
    api(`/incidents/${incident.id}/status`,{method:'POST',body:JSON.stringify({status})})
      .then(load)
      .catch(cause=>setError((cause as Error).message));
  };

  return <section>
    <h2>Einsätze</h2>
    <p>Verfolgen Sie Einsätze von der Einleitung bis zum Abschluss in der Übersicht.</p>
    {error&&<p role="alert">{error}</p>}
    <div className="board">{columns.map(column=><div key={column}>
      <h3>{statusLabel(column,'incident')}</h3>
      {items.filter(incident=>incident.status===column).map(incident=><article key={incident.id}>
        <strong>{incident.priority_name||'Priorität nicht angegeben'}</strong>
        <p>{incident.description}</p>
        <small>{incident.site_name||'Kein Objekt'} · {incident.assignees?.map(assignee=>assignee.name).join(', ')||'Nicht zugewiesen'}</small>
        {column!=='completed'&&<button onClick={()=>advance(incident)}>Nächster Status</button>}
      </article>)}
    </div>)}</div>
    {items.length===0&&<p>Keine Einsätze erfasst.</p>}
  </section>;
}
