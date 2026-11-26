import {FormEvent,useEffect,useState} from 'react';
import {api} from '../lib/api';
import {formatDateTime,formatNumber} from '../lib/format';
import {statusLabel} from '../lib/status';
import {requiredUuidMessage} from '../lib/text';
import {uuid} from '../lib/uuid';
import {isUuid} from '../lib/validation';

type Handover={id:string;site_id:string;shift_id:string|null;title:string;status:string;created_at:string;participant_count:number;confirmation_count:number};
type Participant={id:string;participant_role:string;user_id:string|null;employee_id:string|null;state:string};
type Detail=Handover&{participants:Participant[]};
type SiteOption={id:string;name:string};

const identityLabel=(participant:Participant)=>{
  if(participant.user_id||participant.employee_id)return statusLabel(participant.participant_role);
  return 'Nicht zugeordnet';
};

export function Handovers(){
  const [handovers,setHandovers]=useState<Handover[]>([]);
  const [sites,setSites]=useState<SiteOption[]>([]);
  const [selected,setSelected]=useState<Detail|null>(null);
  const [error,setError]=useState('');
  const [createForm,setCreateForm]=useState({site_id:'',shift_id:'',title:''});
  const [participantForm,setParticipantForm]=useState({participant_role:'outgoing',user_id:'',employee_id:''});
  const [confirmationParticipant,setConfirmationParticipant]=useState('');

  const load=async()=>{
    try{
      const [rows,siteRows]=await Promise.all([
        api<Handover[]>('/handover-protocols'),
        api<SiteOption[]>('/sites'),
      ]);
      setHandovers(rows??[]);
      setSites(siteRows??[]);
    }catch(cause){setError((cause as Error).message);}
  };

  useEffect(()=>{void load();},[]);

  const create=async(event:FormEvent)=>{
    event.preventDefault();
    if(!isUuid(createForm.site_id)){setError(requiredUuidMessage('Objekt','neutral'));return;}
    if(createForm.shift_id&&!isUuid(createForm.shift_id)){setError(requiredUuidMessage('Schicht'));return;}
    try{
      await api('/handover-protocols',{method:'POST',body:JSON.stringify({
        ...createForm,shift_id:createForm.shift_id||null,client_mutation_id:uuid(),
      })});
      setCreateForm({site_id:'',shift_id:'',title:''});
      await load();
    }catch(cause){setError((cause as Error).message);}
  };

  const open=async(id:string)=>{
    try{
      const detail=await api<Detail>(`/handover-protocols/${id}`);
      if(detail)setSelected(detail);
    }catch(cause){setError((cause as Error).message);}
  };

  const addParticipant=async(event:FormEvent)=>{
    event.preventDefault();
    if(!selected)return;
    const userId=participantForm.user_id.trim();
    const employeeId=participantForm.employee_id.trim();
    if(Boolean(userId)===Boolean(employeeId)){
      setError('Bitte genau eine Zuordnung angeben: entweder ein Benutzerkonto oder ein Mitarbeiter.');
      return;
    }
    if((userId&&!isUuid(userId))||(employeeId&&!isUuid(employeeId))){
      setError('Die Kennung muss eine gültige UUID sein.');
      return;
    }
    try{
      await api(`/handover-protocols/${selected.id}/participants`,{method:'POST',body:JSON.stringify({
        participant_role:participantForm.participant_role,
        user_id:userId||null,
        employee_id:employeeId||null,
        client_mutation_id:uuid(),
      })});
      setParticipantForm({participant_role:'outgoing',user_id:'',employee_id:''});
      await open(selected.id);
      await load();
    }catch(cause){setError((cause as Error).message);}
  };

  const confirm=async()=>{
    if(!selected||!confirmationParticipant)return;
    try{
      await api(`/handover-protocols/${selected.id}/confirmations`,{method:'POST',body:JSON.stringify({
        participant_id:confirmationParticipant,client_mutation_id:uuid(),
      })});
      setConfirmationParticipant('');
      await open(selected.id);
      await load();
    }catch(cause){setError((cause as Error).message);}
  };

  const siteName=(id:string)=>sites.find(site=>site.id===id)?.name??'Nicht verfügbar';

  return <section>
    <h1>Schichtübergaben</h1>
    <p>Teilnehmerzuordnungen, Bestätigungen und Korrekturen werden revisionssicher mit Sitzungs- und Gerätenachweis protokolliert.</p>
    {error&&<p role="alert">{error}</p>}
    <form onSubmit={create}>
      <label>Objekt
        <select required value={createForm.site_id} onChange={event=>setCreateForm({...createForm,site_id:event.target.value})}>
          <option value="">Objekt auswählen</option>
          {sites.map(site=><option key={site.id} value={site.id}>{site.name}</option>)}
        </select>
      </label>
      <label>Schicht (optional)
        <input value={createForm.shift_id} onChange={event=>setCreateForm({...createForm,shift_id:event.target.value})} placeholder="Kennung der Schicht"/>
      </label>
      <label>Titel
        <input required value={createForm.title} onChange={event=>setCreateForm({...createForm,title:event.target.value})} placeholder="z. B. Übergabe Frühschicht"/>
      </label>
      <button type="submit">Übergabe anlegen</button>
    </form>
    <table>
      <thead><tr><th>Titel</th><th>Objekt</th><th>Status</th><th>Teilnehmer</th><th>Bestätigungen</th><th>Aktion</th></tr></thead>
      <tbody>{handovers.map(item=><tr key={item.id}>
        <td>{item.title}</td>
        <td>{siteName(item.site_id)}</td>
        <td>{statusLabel(item.status)}</td>
        <td>{formatNumber(item.participant_count)}</td>
        <td>{formatNumber(item.confirmation_count)}</td>
        <td><button onClick={()=>void open(item.id)}>Details anzeigen</button></td>
      </tr>)}</tbody>
    </table>
    {handovers.length===0&&<p>Keine Schichtübergaben erfasst.</p>}
    {selected&&<article>
      <h2>{selected.title}</h2>
      <p>{siteName(selected.site_id)} · {statusLabel(selected.status)} · Erstellt am {formatDateTime(selected.created_at)}</p>
      <form onSubmit={addParticipant}>
        <label>Rolle
          <select value={participantForm.participant_role} onChange={event=>setParticipantForm({...participantForm,participant_role:event.target.value})}>
            <option value="outgoing">Abgebend</option>
            <option value="incoming">Übernehmend</option>
            <option value="witness">Zeuge</option>
          </select>
        </label>
        <label>Benutzerkonto
          <input value={participantForm.user_id} onChange={event=>setParticipantForm({...participantForm,user_id:event.target.value,employee_id:''})} placeholder="Kennung des Benutzerkontos"/>
        </label>
        <label>Mitarbeiter
          <input value={participantForm.employee_id} onChange={event=>setParticipantForm({...participantForm,employee_id:event.target.value,user_id:''})} placeholder="Kennung des Mitarbeiters"/>
        </label>
        <button type="submit">Teilnehmer zuordnen</button>
      </form>
      <ul>{selected.participants.map(participant=><li key={participant.id}>
        {identityLabel(participant)} · {statusLabel(participant.state)}
        {(participant.user_id||participant.employee_id)&&` · ${participant.user_id??participant.employee_id}`}
      </li>)}</ul>
      <label>Teilnehmer für die Bestätigung
        <select value={confirmationParticipant} onChange={event=>setConfirmationParticipant(event.target.value)}>
          <option value="">Bitte wählen</option>
          {selected.participants.filter(item=>item.state==='active').map(item=><option key={item.id} value={item.id}>
            {identityLabel(item)} · {item.user_id??item.employee_id}
          </option>)}
        </select>
      </label>
      <button onClick={()=>void confirm()} disabled={!confirmationParticipant}>Bestätigung protokollieren</button>
    </article>}
  </section>;
}
