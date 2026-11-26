import {FormEvent,useEffect,useState} from 'react';
import {api,hasPermission} from '../lib/api';
import {priorityLabel,statusLabel} from '../lib/status';
import {commonText,requiredUuidMessage} from '../lib/text';
import {isUuid} from '../lib/validation';

type Destination={
  id:string;
  name:string;
  channel:string;
  endpoint:string|null;
  recipient:string|null;
  secret_ref:string|null;
  enabled:boolean;
};
type Rule={
  id:string;
  name:string;
  alarm_type:string|null;
  priority_code:string|null;
  destination_id:string;
  destination_name:string;
  channel:string;
  enabled:boolean;
  max_attempts:number;
};
type Delivery={
  id:string;
  alarm_id:string;
  destination_name:string;
  status:string;
  attempts:number;
  last_error:string|null;
  forwarded_at:string|null;
  acknowledged_at:string|null;
};

export function AlarmForwarding(){
  const [destinations,setDestinations]=useState<Destination[]>([]);
  const [rules,setRules]=useState<Rule[]>([]);
  const [deliveries,setDeliveries]=useState<Delivery[]>([]);
  const [error,setError]=useState('');

  const load=async()=>{
    try{
      const [destinationRows,ruleRows,deliveryRows]=await Promise.all([
        api<Destination[]>('/alarm-forwarding/destinations'),
        api<Rule[]>('/alarm-forwarding/rules'),
        api<Delivery[]>('/alarm-forwarding/deliveries'),
      ]);
      setDestinations(destinationRows||[]);
      setRules(ruleRows||[]);
      setDeliveries(deliveryRows||[]);
    }catch(cause){setError((cause as Error).message);}
  };

  useEffect(()=>{void load();},[]);

  async function addDestination(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    setError('');
    const fields=new FormData(event.currentTarget);
    const channel=String(fields.get('channel'));
    const endpoint=String(fields.get('endpoint')||'').trim();
    const recipient=String(fields.get('recipient')||'').trim();
    const secretRef=String(fields.get('secret_ref')||'').trim();
    const reason=String(fields.get('reason')||'').trim();
    if(reason.length<3){setError(commonText.reasonRequired);return;}
    if(channel==='webhook'&&!endpoint){setError('Für einen Webhook ist eine Zieladresse erforderlich.');return;}
    if(channel!=='webhook'&&!recipient){setError('Für E-Mail oder SMS ist ein Empfänger erforderlich.');return;}
    if(channel==='webhook'&&!secretRef){setError('Für einen Webhook ist eine Schlüsselreferenz erforderlich.');return;}
    try{
      await api('/alarm-forwarding/destinations',{method:'POST',body:JSON.stringify({
        name:fields.get('name'),
        channel,
        ...(endpoint?{endpoint}:{}),
        ...(recipient?{recipient}:{}),
        ...(secretRef?{secret_ref:secretRef}:{}),
        reason,
      })});
      event.currentTarget.reset();
      await load();
    }catch(cause){setError((cause as Error).message);}
  }

  async function addRule(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    setError('');
    const fields=new FormData(event.currentTarget);
    const alarmType=String(fields.get('alarm_type')||'').trim();
    const priorityCode=String(fields.get('priority_code')||'').trim();
    const destinationId=String(fields.get('destination_id')||'');
    const reason=String(fields.get('reason')||'').trim();
    if(!alarmType&&!priorityCode){setError('Bitte einen Alarmtyp oder eine Priorität angeben.');return;}
    if(!isUuid(destinationId)){setError(requiredUuidMessage('Ziel','neutral'));return;}
    if(reason.length<3){setError(commonText.reasonRequired);return;}
    try{
      await api('/alarm-forwarding/rules',{method:'POST',body:JSON.stringify({
        name:fields.get('name'),
        ...(alarmType?{alarm_type:alarmType}:{}),
        ...(priorityCode?{priority_code:priorityCode}:{}),
        destination_id:destinationId,
        max_attempts:Number(fields.get('max_attempts')),
        reason,
      })});
      event.currentTarget.reset();
      await load();
    }catch(cause){setError((cause as Error).message);}
  }

  async function acknowledge(id:string){
    try{
      await api(`/alarm-forwarding/deliveries/${id}/acknowledge`,{method:'POST'});
      await load();
    }catch(cause){setError((cause as Error).message);}
  }

  async function toggleDestination(item:Destination){
    const reason=window.prompt(commonText.changeReason);
    if(!reason||reason.trim().length<3){setError(commonText.reasonRequired);return;}
    try{
      await api(`/alarm-forwarding/destinations/${item.id}`,{method:'PATCH',body:JSON.stringify({enabled:!item.enabled,reason})});
      await load();
    }catch(cause){setError((cause as Error).message);}
  }

  async function deleteDestination(id:string){
    const reason=window.prompt('Grund für das Löschen');
    if(!reason||reason.trim().length<3){setError(commonText.reasonRequired);return;}
    try{
      await api(`/alarm-forwarding/destinations/${id}`,{method:'DELETE',body:JSON.stringify({reason})});
      await load();
    }catch(cause){setError((cause as Error).message);}
  }

  async function deleteRule(id:string){
    const reason=window.prompt('Grund für das Löschen');
    if(!reason||reason.trim().length<3){setError(commonText.reasonRequired);return;}
    try{
      await api(`/alarm-forwarding/rules/${id}`,{method:'DELETE',body:JSON.stringify({reason})});
      await load();
    }catch(cause){setError((cause as Error).message);}
  }

  if(!hasPermission('alarm_forwarding:read')){
    return <section><h2>Alarmweiterleitung</h2><p>{commonText.noPermission}</p></section>;
  }

  const canWrite=hasPermission('alarm_forwarding:write');

  return <section>
    <h2>Externe Alarmweiterleitung</h2>
    <p>Legen Sie Ziele und Regeln für die Weiterleitung von Alarmen fest und prüfen Sie den Zustellverlauf.</p>
    {error&&<p role="alert">{error}</p>}
    {canWrite&&<>
      <h3>Ziel anlegen</h3>
      <form onSubmit={addDestination}>
        <label>Bezeichnung<input name="name" required placeholder="Name des Ziels"/></label>
        <label>Kanal
          <select name="channel">
            <option value="webhook">Webhook</option>
            <option value="email">E-Mail</option>
            <option value="sms">SMS</option>
          </select>
        </label>
        <label>Zieladresse<input name="endpoint" placeholder="Webhook-Adresse" type="url"/></label>
        <label>Empfänger<input name="recipient" placeholder="E-Mail-Adresse oder Telefonnummer"/></label>
        <label>Schlüsselreferenz<input name="secret_ref" placeholder="Referenz auf den Zugriffsschlüssel"/></label>
        <label>{commonText.changeReason}<input name="reason" required minLength={3} placeholder="Grund für die Änderung"/></label>
        <button type="submit">Ziel anlegen</button>
      </form>
    </>}
    <h3>Ziele</h3>
    {destinations.length===0?<p>Keine Ziele konfiguriert.</p>:<ul>{destinations.map(item=><li key={item.id}>
      <strong>{item.name}</strong> · {statusLabel(item.channel,'channel')} · {statusLabel(item.enabled?'active':'inactive')} · {item.secret_ref?'Schlüsselreferenz hinterlegt':'Keine Schlüsselreferenz'}
      {canWrite&&<>
        <button onClick={()=>void toggleDestination(item)}>{item.enabled?'Deaktivieren':'Aktivieren'}</button>
        <button onClick={()=>void deleteDestination(item.id)}>Löschen</button>
      </>}
    </li>)}</ul>}
    {canWrite&&<>
      <h3>Regel anlegen</h3>
      <form onSubmit={addRule}>
        <label>Bezeichnung<input name="name" required placeholder="Name der Regel"/></label>
        <label>Alarmtyp<input name="alarm_type" placeholder="z. B. Einbruch"/></label>
        <label>Priorität
          <select name="priority_code">
            <option value="">Keine Prioritätsauswahl</option>
            <option value="critical">Kritisch</option>
            <option value="high">Hoch</option>
            <option value="medium">Mittel</option>
            <option value="low">Niedrig</option>
          </select>
        </label>
        <label>Ziel
          <select name="destination_id" required>
            <option value="">Ziel auswählen</option>
            {destinations.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <label>Maximale Versuche<input name="max_attempts" type="number" min="1" max="10" defaultValue="5"/></label>
        <label>{commonText.changeReason}<input name="reason" required minLength={3} placeholder="Grund für die Änderung"/></label>
        <button type="submit">Regel anlegen</button>
      </form>
    </>}
    <h3>Regeln</h3>
    {rules.length===0?<p>Keine Regeln konfiguriert.</p>:<ul>{rules.map(item=><li key={item.id}>
      <strong>{item.name}</strong> · {priorityLabel(item.priority_code)||item.alarm_type||'Alle Alarme'} → {item.destination_name} · maximal {item.max_attempts} Versuche
      {canWrite&&<button onClick={()=>void deleteRule(item.id)}>Löschen</button>}
    </li>)}</ul>}
    <h3>Zustellverlauf</h3>
    {deliveries.length===0?<p>Keine Zustellungen erfasst.</p>:<ul>{deliveries.map(item=><li key={item.id}>
      {item.destination_name} · {item.alarm_id} · {statusLabel(item.status,'delivery')} · Versuche: {item.attempts}
      {item.last_error&&` · Letzter Fehler: ${item.last_error}`}
      {item.status==='forwarded'&&canWrite&&<button onClick={()=>void acknowledge(item.id)}>Quittieren</button>}
    </li>)}</ul>}
  </section>;
}
