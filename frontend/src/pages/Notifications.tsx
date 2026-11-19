import {useEffect,useState} from 'react';
import {api} from '../lib/api';
type Notification={id:string;title:string;body:string;read_at:string|null;created_at:string};
export function Notifications(){
  const [items,setItems]=useState<Notification[]>([]);const [error,setError]=useState('');
  const load=()=>api<Notification[]>('/notifications').then(v=>setItems(v||[])).catch(e=>setError(e.message));
  useEffect(()=>{load();const ws=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/ws`);ws.onmessage=e=>{if(JSON.parse(e.data).type==='notification.created')load();};return()=>ws.close();},[]);
  const mark=(id:string)=>api(`/notifications/${id}/read`,{method:'POST'}).then(load).catch(e=>setError(e.message));
  return <section><h1>Benachrichtigungen</h1>{error&&<p role="alert">{error}</p>}<ul>{items.map(n=><li key={n.id}><strong>{n.title}</strong>: {n.body}<br/><small>{n.created_at} · {n.read_at?'Gelesen':'Ungelesen'}</small>{!n.read_at&&<button onClick={()=>mark(n.id)}>Als gelesen markieren</button>}</li>)}</ul></section>;
}
