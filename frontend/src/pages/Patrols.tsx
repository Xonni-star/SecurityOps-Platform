import {FormEvent,useEffect,useState} from 'react';
import {api} from '../lib/api';
import {isUuid} from '../lib/validation';
import {requiredUuidMessage} from '../lib/text';

type Point={id:string;site_id:string;name:string;nfc_uid:string;sequence:number};
type SiteOption={id:string;name:string};

export function Patrols(){
  const [points,setPoints]=useState<Point[]>([]);
  const [sites,setSites]=useState<SiteOption[]>([]);
  const [name,setName]=useState('');
  const [nfc,setNfc]=useState('');
  const [site,setSite]=useState('');
  const [error,setError]=useState('');
  const [success,setSuccess]=useState('');

  const load=async()=>{
    try{
      const [controlPoints,availableSites]=await Promise.all([
        api<Point[]>('/control-points'),
        api<SiteOption[]>('/sites'),
      ]);
      setPoints(controlPoints||[]);
      setSites(availableSites||[]);
    }catch(cause){setError((cause as Error).message);}
  };

  useEffect(()=>{void load();},[]);

  const add=async(event:FormEvent)=>{
    event.preventDefault();
    if(!isUuid(site)){
      setError(requiredUuidMessage('Objekt','neutral'));
      return;
    }
    const sequence=Math.max(0,...points.filter(point=>point.site_id===site).map(point=>Number(point.sequence)||0))+1;
    try{
      await api('/control-points',{method:'POST',body:JSON.stringify({site_id:site,name,nfc_uid:nfc,sequence})});
      setError('');
      setSuccess('Die Kontrollstelle wurde angelegt.');
      setName('');
      setNfc('');
      await load();
    }catch(cause){setError((cause as Error).message);}
  };

  return <section>
    <h2>Kontrollgänge</h2>
    <p>Legen Sie Kontrollstellen mit ihrer Reihenfolge und NFC-Kennung für die Kontrollgänge an.</p>
    {error&&<p role="alert">{error}</p>}
    {success&&<p role="status">{success}</p>}
    <form onSubmit={add}>
      <label>Objekt
        <select value={site} onChange={event=>setSite(event.target.value)} required>
          <option value="">Objekt auswählen</option>
          {sites.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>
      <label>Bezeichnung der Kontrollstelle
        <input required placeholder="z. B. Haupteingang" value={name} onChange={event=>setName(event.target.value)}/>
      </label>
      <label>NFC-Kennung
        <input required placeholder="Kennung des NFC-Tags" value={nfc} onChange={event=>setNfc(event.target.value)}/>
      </label>
      <button type="submit">Kontrollstelle anlegen</button>
    </form>
    <table>
      <thead><tr><th>Reihenfolge</th><th>Kontrollstelle</th><th>NFC-Kennung</th><th>Objekt</th></tr></thead>
      <tbody>{points.map(point=><tr key={point.id}>
        <td>{point.sequence}</td>
        <td>{point.name}</td>
        <td>{point.nfc_uid}</td>
        <td>{sites.find(item=>item.id===point.site_id)?.name||'Nicht verfügbar'}</td>
      </tr>)}</tbody>
    </table>
    {points.length===0&&<p>Keine Kontrollstellen erfasst.</p>}
  </section>;
}
