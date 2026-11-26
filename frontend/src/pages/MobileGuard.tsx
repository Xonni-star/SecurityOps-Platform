import {useEffect,useState} from 'react';
import {uuid} from "../lib/uuid";
import {api} from '../lib/api';
import {isUuid} from '../lib/validation';
import {enqueue,listOutbox,syncOutbox,watchConnection,type MobileOutboxItem} from '../lib/offline';

export function MobileGuard(){
  const [routeId,setRouteId]=useState('');
  const [employeeId,setEmployeeId]=useState('');
  const [nfcUid,setNfcUid]=useState('');
  const [description,setDescription]=useState('');
  const [outbox,setOutbox]=useState<MobileOutboxItem[]>([]);
  const [message,setMessage]=useState('Bereit');
  const [online,setOnline]=useState(navigator.onLine);
  const refresh=async()=>setOutbox(await listOutbox());
  useEffect(()=>{void refresh();const stop=watchConnection(()=>{setOnline(navigator.onLine);if(navigator.onLine)void sync().then(refresh);});return stop;},[]);
  async function sync(){const result=await syncOutbox();setMessage(`${result.synced} synchronisiert, ${result.conflicts} Konflikt(e), ${result.remaining} ausstehend`);return result;}
  async function scan(){
    if(!routeId||!employeeId||!nfcUid){setMessage('Route, Mitarbeiter und NFC-Kennung sind erforderlich.');return;}
    if(!isUuid(routeId)||!isUuid(employeeId)){setMessage('Route und Mitarbeiter müssen gültige UUIDs sein.');return;}
    const body={nfc_uid:nfcUid,employee_id:employeeId,scanned_at:new Date().toISOString(),client_event_id:uuid()};
    if(!navigator.onLine){await enqueue({kind:'patrol_scan',path:`/api/v1/patrol-routes/${routeId}/scans`,body});setMessage('Offline gespeichert; wird nach Verbindung synchronisiert.');await refresh();return;}
    try{await api(`/patrol-routes/${routeId}/scans`,{method:'POST',body:JSON.stringify(body)});setMessage('Scan serverseitig bestätigt.');}
    catch(error){await enqueue({kind:'patrol_scan',path:`/api/v1/patrol-routes/${routeId}/scans`,body});setMessage(`${error instanceof Error?error.message:'Netzwerkfehler'} Offline-Outbox verwendet.`);await refresh();}
  }
  async function panic(){
    const body={description:description||'Mobiler Panik-Alarm',position:'mobile device',client_event_id:uuid()};
    if(!navigator.onLine){await enqueue({kind:'panic',path:'/api/v1/alarms/panic',body});setMessage('Panik offline gespeichert; keine Serverbestätigung liegt vor.');await refresh();return;}
    try{await api('/alarms/panic',{method:'POST',body:JSON.stringify(body)});setMessage('Panik-Alarm serverseitig bestätigt.');}
    catch(error){await enqueue({kind:'panic',path:'/api/v1/alarms/panic',body});setMessage(`${error instanceof Error?error.message:'Netzwerkfehler'} Offline-Outbox verwendet.`);await refresh();}
  }
  async function enablePush(){
    try{
      const registration=await navigator.serviceWorker?.ready;
      const key=(window as Window & {__SECURITYOPS_VAPID_PUBLIC_KEY?:string}).__SECURITYOPS_VAPID_PUBLIC_KEY;
      if(!registration||!key){setMessage('Push ist für diese Umgebung nicht konfiguriert.');return;}
      const permission=await Notification.requestPermission();
      if(permission!=='granted'){setMessage('Push-Berechtigung wurde nicht erteilt.');return;}
      const subscription=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key});
      const json=subscription.toJSON();
      if(!json.endpoint||!json.keys?.p256dh||!json.keys?.auth){setMessage('Die Push-Subscription ist unvollständig.');return;}
      await api('/push-subscriptions',{method:'POST',body:JSON.stringify({endpoint:json.endpoint,keys:{p256dh:json.keys.p256dh,auth:json.keys.auth}})});
      setMessage('Push-Benachrichtigungen aktiviert.');
    }catch(error){setMessage(error instanceof Error?error.message:'Push-Aktivierung fehlgeschlagen.');}
  }
  return <section className="mobile-guard">
    <h1>Wächter-App</h1><p className={online?'online':'offline'}>{online?'Online':'Offline'} · {message}</p>
    <div className="mobile-actions"><button className="panic-button" onClick={()=>void panic()}>PANIK</button><button onClick={()=>void enablePush()}>Push aktivieren</button><button onClick={()=>void sync()}>Jetzt synchronisieren</button></div>
    <form onSubmit={event=>{event.preventDefault();void scan();}}>
      <label>Route<input value={routeId} onChange={event=>setRouteId(event.target.value)} placeholder="Route-ID"/></label>
      <label>Mitarbeiter-ID<input value={employeeId} onChange={event=>setEmployeeId(event.target.value)} placeholder="Mitarbeiter-ID"/></label>
      <label>NFC-/Barcode-Kennung<input autoFocus value={nfcUid} onChange={event=>setNfcUid(event.target.value)} placeholder="Kennung scannen oder eingeben"/></label>
      <button type="submit">Kontrollpunkt bestätigen</button>
    </form>
    <label>Meldung zum Panik-Alarm<textarea value={description} onChange={event=>setDescription(event.target.value)} placeholder="Optional"/></label>
    <h2>Offline-Outbox ({outbox.length})</h2>
    {outbox.length===0?<p>Keine ausstehenden Vorgänge.</p>:<ul>{outbox.map(item=><li key={item.id}>{item.kind} · {item.status} · {item.error||'wartet auf Synchronisation'}</li>)}</ul>}
  </section>;
}
