import {FormEvent,useEffect,useState} from 'react';
import {api} from '../lib/api';
import {formatDateTime} from '../lib/format';
import {isUuid} from '../lib/validation';
import {requiredUuidMessage} from '../lib/text';

type Message={id:string;body:string;sender_email:string;recipient_email:string|null;read_at:string|null;created_at:string};

export function Messages(){
  const [items,setItems]=useState<Message[]>([]);
  const [recipient,setRecipient]=useState('');
  const [body,setBody]=useState('');
  const [error,setError]=useState('');
  const [success,setSuccess]=useState('');

  const load=()=>api<Message[]>('/messages')
    .then(value=>setItems(value||[]))
    .catch(cause=>setError((cause as Error).message));

  useEffect(()=>{
    void load();
    const socket=new WebSocket(`${location.protocol==='https:'?'wss':'ws:'}//${location.host}/ws`);
    socket.onmessage=event=>{
      const message=JSON.parse(event.data) as {type?:string};
      if(message.type?.startsWith('message.'))void load();
    };
    return ()=>socket.close();
  },[]);

  const send=async(event:FormEvent)=>{
    event.preventDefault();
    if(!isUuid(recipient)){
      setError(requiredUuidMessage('Benutzerkennung des Empfängers'));
      return;
    }
    try{
      await api('/messages',{method:'POST',body:JSON.stringify({recipient_user_id:recipient.trim(),body})});
      setError('');
      setSuccess('Die Nachricht wurde gesendet.');
      setBody('');
      await load();
    }catch(cause){setError((cause as Error).message);}
  };

  return <section>
    <h2>Nachrichten</h2>
    <p>Tauschen Sie interne Nachrichten aus und behalten Sie den Überblick über Zustellung und Lesestatus.</p>
    {error&&<p role="alert">{error}</p>}
    {success&&<p role="status">{success}</p>}
    <form onSubmit={send}>
      <label>Empfänger
        <input required placeholder="Benutzerkennung des Empfängers" value={recipient} onChange={event=>setRecipient(event.target.value)}/>
      </label>
      <label>Nachricht
        <textarea required placeholder="Ihre Nachricht" value={body} onChange={event=>setBody(event.target.value)}/>
      </label>
      <button type="submit">Nachricht senden</button>
    </form>
    <ul>{items.map(item=><li key={item.id}>
      <strong>{item.sender_email}</strong> → {item.recipient_email||'Empfänger nicht verfügbar'}: {item.body}
      <br/>
      <small>{formatDateTime(item.created_at)} · {item.read_at?'Gelesen':'Ungelesen'}</small>
    </li>)}</ul>
    {items.length===0&&<p>Keine Nachrichten vorhanden.</p>}
  </section>;
}
