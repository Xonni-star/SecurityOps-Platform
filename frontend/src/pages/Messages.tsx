import {FormEvent,useEffect,useState} from 'react';
import {api} from '../lib/api';
import {isUuid} from '../lib/validation';
type Message={id:string;body:string;sender_email:string;recipient_email:string|null;read_at:string|null;created_at:string};
export function Messages(){
  const [items,setItems]=useState<Message[]>([]);const [recipient,setRecipient]=useState('');const [body,setBody]=useState('');const [error,setError]=useState('');
  const load=()=>api<Message[]>('/messages').then(v=>setItems(v||[])).catch(e=>setError(e.message));
  useEffect(()=>{load();const ws=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/ws`);ws.onmessage=e=>{if(JSON.parse(e.data).type.startsWith('message.'))load();};return()=>ws.close();},[]);
  const send=async(event:FormEvent)=>{event.preventDefault();if(!isUuid(recipient)){setError('Bitte eine gültige Empfänger-UUID angeben.');return;}try{await api('/messages',{method:'POST',body:JSON.stringify({recipient_user_id:recipient.trim(),body})});setError('');setBody('');load();}catch(e){setError((e as Error).message);}};
  return <section><h1>Direktnachrichten</h1>{error&&<p role="alert">{error}</p>}<form onSubmit={send}><label>Empfänger Nutzer-ID<input value={recipient} onChange={e=>setRecipient(e.target.value)} required/></label><label>Nachricht<input value={body} onChange={e=>setBody(e.target.value)} required/></label><button>Senden</button></form><ul>{items.map(m=><li key={m.id}><strong>{m.sender_email}</strong> → {m.recipient_email||'Mitarbeiter'}: {m.body}<br/><small>{m.created_at} · {m.read_at?'Gelesen':'Ungelesen'}</small></li>)}</ul></section>;
}
