import {useEffect,useState} from 'react';
import {MapContainer,Marker,Popup,TileLayer} from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import {api} from '../lib/api';
type Position={id:string;device_id:string;device_name:string;latitude:number;longitude:number;accuracy_m:number|null};
type Alarm={id:string;device_id:string|null;description:string;status:string;priority_name:string;color:string};
export function LiveMap(){
  const [data,setData]=useState<{positions:Position[];alarms:Alarm[]}>({positions:[],alarms:[]});
  const [error,setError]=useState('');
  const load=()=>api<typeof data>('/map-data').then(value=>setData(value||{positions:[],alarms:[]})).catch(e=>setError(e.message));
  useEffect(()=>{load();const ws=new WebSocket(`${location.protocol==='https:'?'wss':'ws:'}//${location.host}/ws`);ws.onmessage=e=>{const message=JSON.parse(e.data);if(['position.updated','alarm.created','alarm.acknowledged','alarm.escalated','alarm.resolved'].includes(message.type))load();};return()=>ws.close();},[]);
  const center: [number,number]=data.positions.length?[data.positions[0].latitude,data.positions[0].longitude]:[51.1657,10.4515];
  return <section><h1>Live-Karte</h1>{error&&<p role="alert">{error}</p>}<MapContainer center={center} zoom={data.positions.length?15:6} style={{height:500}}><TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"/>{data.positions.map(position=><Marker key={position.id} position={[position.latitude,position.longitude]}><Popup>{position.device_name}<br/>Genauigkeit: {position.accuracy_m??'n/a'} m</Popup></Marker>)}</MapContainer><h2>Offene Alarme</h2><ul>{data.alarms.map(alarm=><li key={alarm.id} style={{borderLeft:`6px solid ${alarm.color||'#dc2626'}`}}>{alarm.priority_name}: {alarm.description} ({alarm.status})</li>)}</ul></section>;
}
