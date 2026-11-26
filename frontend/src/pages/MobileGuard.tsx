import {useEffect,useState} from 'react';
import {uuid} from '../lib/uuid';
import {api} from '../lib/api';
import {isUuid} from '../lib/validation';
import {enqueue,listOutbox,syncOutbox,watchConnection,type MobileOutboxItem} from '../lib/offline';
import {formatDateTime} from '../lib/format';
import {requiredUuidMessage} from '../lib/text';

const kindLabels:Record<string,string>={patrol_scan:'Kontrollgang',panic:'Panik-Alarm'};

export function MobileGuard(){
  const [routeId,setRouteId]=useState('');
  const [employeeId,setEmployeeId]=useState('');
  const [nfcUid,setNfcUid]=useState('');
  const [description,setDescription]=useState('');
  const [outbox,setOutbox]=useState<MobileOutboxItem[]>([]);
  const [message,setMessage]=useState('Bereit für Eingaben.');
  const [online,setOnline]=useState(navigator.onLine);
  const refresh=async()=>setOutbox(await listOutbox());

  useEffect(()=>{void refresh();const stop=watchConnection(()=>{setOnline(navigator.onLine);if(navigator.onLine)void sync().then(refresh);});return stop;},[]);

  async function sync(){
    const result=await syncOutbox();
    setMessage(`${result.synced} übermittelt, ${result.conflicts} Konflikt(e), ${result.remaining} ausstehend.`);
    return result;
  }

  async function scan(){
    if(!routeId||!employeeId||!nfcUid){setMessage('Bitte Route, Mitarbeiter und NFC-Kennung angeben.');return;}
    if(!isUuid(routeId)){setMessage(requiredUuidMessage('Routenkennung'));return;}
    if(!isUuid(employeeId)){setMessage(requiredUuidMessage('Mitarbeiterkennung'));return;}
    const body={nfc_uid:nfcUid,employee_id:employeeId,scanned_at:new Date().toISOString(),client_event_id:uuid()};
    if(!navigator.onLine){
      await enqueue({kind:'patrol_scan',path:`/api/v1/patrol-routes/${routeId}/scans`,body});
      setMessage('Die Kontrolle wurde offline gespeichert und wird nach Wiederherstellung der Verbindung übermittelt.');
      await refresh();
      return;
    }
    try{
      await api(`/patrol-routes/${routeId}/scans`,{method:'POST',body:JSON.stringify(body)});
      setMessage('Die Kontrolle wurde vom Server bestätigt.');
    }catch(error){
      await enqueue({kind:'patrol_scan',path:`/api/v1/patrol-routes/${routeId}/scans`,body});
      setMessage(`${error instanceof Error?error.message:'Netzwerkfehler'} · Die Kontrolle wurde in der Offline-Warteschlange gespeichert.`);
      await refresh();
    }
  }

  async function panic(){
    const body={description:description||'Mobiler Panik-Alarm',position:'mobiles Gerät',client_event_id:uuid()};
    if(!navigator.onLine){
      await enqueue({kind:'panic',path:'/api/v1/alarms/panic',body});
      setMessage('Der Panik-Alarm wurde offline gespeichert. Eine Serverbestätigung liegt nicht vor.');
      await refresh();
      return;
    }
    try{
      await api('/alarms/panic',{method:'POST',body:JSON.stringify(body)});
      setMessage('Der Panik-Alarm wurde vom Server bestätigt.');
    }catch(error){
      await enqueue({kind:'panic',path:'/api/v1/alarms/panic',body});
      setMessage(`${error instanceof Error?error.message:'Netzwerkfehler'} · Der Panik-Alarm wurde in der Offline-Warteschlange gespeichert.`);
      await refresh();
    }
  }

  async function enablePush(){
    try{
      const registration=await navigator.serviceWorker?.ready;
      const key=(window as Window & {__SECURITYOPS_VAPID_PUBLIC_KEY?:string}).__SECURITYOPS_VAPID_PUBLIC_KEY;
      if(!registration||!key){setMessage('Push-Benachrichtigungen sind für diese Umgebung nicht konfiguriert.');return;}
      const permission=await Notification.requestPermission();
      if(permission!=='granted'){setMessage('Die Berechtigung für Push-Benachrichtigungen wurde nicht erteilt.');return;}
      const subscription=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key});
      const json=subscription.toJSON();
      if(!json.endpoint||!json.keys?.p256dh||!json.keys?.auth){setMessage('Die Push-Anmeldung ist unvollständig.');return;}
      await api('/push-subscriptions',{method:'POST',body:JSON.stringify({endpoint:json.endpoint,keys:{p256dh:json.keys.p256dh,auth:json.keys.auth}})});
      setMessage('Push-Benachrichtigungen wurden aktiviert.');
    }catch(error){setMessage(error instanceof Error?error.message:'Die Aktivierung der Push-Benachrichtigungen ist fehlgeschlagen.');}
  }

  return <section className="mobile-guard">
    <h1>Mobile Einsatz-App</h1>
    <p className={online?'online':'offline'}>{online?'Verbunden':'Offline'} · {message}</p>
    <div className="mobile-actions">
      <button className="panic-button" onClick={()=>void panic()}>Panik-Alarm auslösen</button>
      <button onClick={()=>void enablePush()}>Push-Benachrichtigungen aktivieren</button>
      <button onClick={()=>void sync()}>Jetzt synchronisieren</button>
    </div>
    <form onSubmit={event=>{event.preventDefault();void scan();}}>
      <label>Route
        <input value={routeId} onChange={event=>setRouteId(event.target.value)} placeholder="Kennung der Route"/>
      </label>
      <label>Mitarbeiter
        <input value={employeeId} onChange={event=>setEmployeeId(event.target.value)} placeholder="Kennung des Mitarbeiters"/>
      </label>
      <label>NFC- oder Barcode-Kennung
        <input autoFocus value={nfcUid} onChange={event=>setNfcUid(event.target.value)} placeholder="Kennung scannen oder eingeben"/>
      </label>
      <button type="submit">Kontrollpunkt bestätigen</button>
    </form>
    <label>Meldung zum Panik-Alarm
      <textarea value={description} onChange={event=>setDescription(event.target.value)} placeholder="Optional – zusätzliche Angaben zum Alarm"/>
    </label>
    <h2>Offline-Warteschlange ({outbox.length})</h2>
    {outbox.length===0
      ? <p>Keine ausstehenden Vorgänge.</p>
      : <ul>{outbox.map(item=><li key={item.id}>
          {kindLabels[item.kind]??'Vorgang'} · {item.status==='conflict'?'Konflikt':'Ausstehend'}
          {' · '}{formatDateTime(item.createdAt)}
          {item.error&&` · ${item.error}`}
        </li>)}</ul>}
  </section>;
}
