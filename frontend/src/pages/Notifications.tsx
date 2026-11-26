import {useEffect,useState} from 'react';
import {api} from '../lib/api';
import {formatDateTime} from '../lib/format';

type Notification={id:string;title:string;body:string;read_at:string|null;created_at:string};

export function Notifications(){
  const [items,setItems]=useState<Notification[]>([]);
  const [error,setError]=useState('');

  const load=()=>api<Notification[]>('/notifications')
    .then(value=>setItems(value||[]))
    .catch(cause=>setError((cause as Error).message));

  useEffect(()=>{
    void load();
    const socket=new WebSocket(`${location.protocol==='https:'?'wss':'ws:'}//${location.host}/ws`);
    socket.onmessage=event=>{
      const message=JSON.parse(event.data) as {type?:string};
      if(message.type==='notification.created')void load();
    };
    return ()=>socket.close();
  },[]);

  const mark=(id:string)=>api(`/notifications/${id}/read`,{method:'POST'})
    .then(load)
    .catch(cause=>setError((cause as Error).message));

  return <section>
    <h2>Benachrichtigungen</h2>
    <p>Sehen Sie alle persönlichen Hinweise und Zustellungen an und markieren Sie gelesene Meldungen.</p>
    {error&&<p role="alert">{error}</p>}
    {items.length===0&&<p>Keine Benachrichtigungen vorhanden.</p>}
    <ul>{items.map(item=><li key={item.id}>
      <strong>{item.title}</strong>
      <p>{item.body}</p>
      <small>{formatDateTime(item.created_at)} · {item.read_at?'Gelesen':'Ungelesen'}</small>
      {!item.read_at&&<button onClick={()=>void mark(item.id)}>Als gelesen markieren</button>}
    </li>)}</ul>
  </section>;
}
