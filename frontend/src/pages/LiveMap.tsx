import {useEffect,useState} from 'react';
import {MapContainer,Marker,Popup,TileLayer} from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import {api} from '../lib/api';
import {formatDateTime} from '../lib/format';
import {statusLabel} from '../lib/status';

type Position={id:string;device_id:string;device_name:string;latitude:number;longitude:number;accuracy_m:number|null};
type Alarm={id:string;device_id:string|null;description:string;status:string;priority_name:string;color:string};
type MapData={positions:Position[];alarms:Alarm[]};

export function LiveMap(){
  const [data,setData]=useState<MapData>({positions:[],alarms:[]});
  const [error,setError]=useState('');
  const [lastUpdated,setLastUpdated]=useState('');

  const load=()=>api<MapData>('/map-data')
    .then(value=>{
      setData(value||{positions:[],alarms:[]});
      setLastUpdated(new Date().toISOString());
    })
    .catch(cause=>setError((cause as Error).message));

  useEffect(()=>{
    void load();
    const socket=new WebSocket(`${location.protocol==='https:'?'wss':'ws:'}//${location.host}/ws`);
    socket.onmessage=event=>{
      const message=JSON.parse(event.data) as {type?:string};
      if(['position.updated','alarm.created','alarm.acknowledged','alarm.escalated','alarm.resolved'].includes(message.type??''))void load();
    };
    return ()=>socket.close();
  },[]);

  const center:[number,number]=data.positions.length
    ?[data.positions[0].latitude,data.positions[0].longitude]
    :[51.1657,10.4515];

  return <section>
    <h2>Live-Karte</h2>
    <p>Zeigen Sie die aktuellen Gerätepositionen und offenen Alarme im Lagebild.</p>
    {error&&<p role="alert">{error}</p>}
    <MapContainer center={center} zoom={data.positions.length?15:6} style={{height:500}}>
      <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"/>
      {data.positions.map(position=><Marker key={position.id} position={[position.latitude,position.longitude]}>
        <Popup>
          {position.device_name}
          <br/>
          Genauigkeit: {position.accuracy_m??'Nicht verfügbar'}Meter
        </Popup>
      </Marker>)}
    </MapContainer>
    {data.positions.length===0&&<p>Keine Positionen vorhanden.</p>}
    <h3>Offene Alarme</h3>
    <ul>{data.alarms.map(alarm=><li key={alarm.id} style={{borderLeft:`6px solid ${alarm.color||'#dc2626'}`}}>
      {alarm.priority_name||'Priorität nicht angegeben'}: {alarm.description} · {statusLabel(alarm.status,'alarm')}
    </li>)}</ul>
    {data.alarms.length===0&&<p>Keine offenen Alarme vorhanden.</p>}
    <p className="muted">Letzte Aktualisierung: {formatDateTime(lastUpdated)}</p>
  </section>;
}
