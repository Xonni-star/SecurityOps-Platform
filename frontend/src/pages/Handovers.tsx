import {FormEvent,useEffect,useState} from 'react';
import {api} from '../lib/api';
import {uuid} from "../lib/uuid";
import {isUuid} from '../lib/validation';

type Handover={id:string;site_id:string;shift_id:string|null;title:string;status:string;created_at:string;participant_count:number;confirmation_count:number};
type Participant={id:string;participant_role:string;user_id:string|null;employee_id:string|null;state:string};
type Detail=Handover&{participants:Participant[]};

export function Handovers(){
  const [handovers,setHandovers]=useState<Handover[]>([]);
  const [selected,setSelected]=useState<Detail|null>(null);
  const [error,setError]=useState('');
  const [createForm,setCreateForm]=useState({site_id:'',shift_id:'',title:''});
  const [participantForm,setParticipantForm]=useState({participant_role:'outgoing',user_id:'',employee_id:''});
  const [confirmationParticipant,setConfirmationParticipant]=useState('');
  const load=async()=>{
    try{setHandovers((await api<Handover[]>('/handover-protocols'))??[]);}
    catch(e){setError((e as Error).message);}
  };
  useEffect(()=>{void load();},[]);
  const create=async(event:FormEvent)=>{
    event.preventDefault();
    if(!isUuid(createForm.site_id)||(createForm.shift_id&&!isUuid(createForm.shift_id))){setError('Bitte gültige Objekt- und Schicht-IDs angeben.');return;}
    try{
      await api('/handover-protocols',{method:'POST',body:JSON.stringify({...createForm,shift_id:createForm.shift_id||null,client_mutation_id:uuid()})});
      setCreateForm({site_id:'',shift_id:'',title:''});await load();
    }catch(e){setError((e as Error).message);}
  };
  const open=async(id:string)=>{
    try{const detail=await api<Detail>(`/handover-protocols/${id}`);if(detail)setSelected(detail);}
    catch(e){setError((e as Error).message);}
  };
  const addParticipant=async(event:FormEvent)=>{
    event.preventDefault();
    if(!selected)return;
    const userId=participantForm.user_id.trim();const employeeId=participantForm.employee_id.trim();
    if(Boolean(userId)===Boolean(employeeId)){setError('Bitte genau eine Identität (Benutzer oder Mitarbeiter) angeben.');return;}
    if((userId&&!isUuid(userId))||(employeeId&&!isUuid(employeeId))){setError('Die Identität muss eine gültige UUID sein.');return;}
    try{
      await api(`/handover-protocols/${selected.id}/participants`,{method:'POST',body:JSON.stringify({
        participant_role:participantForm.participant_role,user_id:userId||null,employee_id:employeeId||null,client_mutation_id:uuid(),
      })});
      setParticipantForm({participant_role:'outgoing',user_id:'',employee_id:''});await open(selected.id);await load();
    }catch(e){setError((e as Error).message);}
  };
  const confirm=async()=>{
    if(!selected||!confirmationParticipant)return;
    try{
      await api(`/handover-protocols/${selected.id}/confirmations`,{method:'POST',body:JSON.stringify({participant_id:confirmationParticipant,client_mutation_id:uuid()})});
      setConfirmationParticipant('');await open(selected.id);await load();
    }catch(e){setError((e as Error).message);}
  };
  return <section><h1>Schichtübergaben</h1><p>Teilnehmerbindungen, Bestätigungen und Korrekturen werden mit Session-/Gerätenachweis append-only protokolliert.</p>{error&&<p role="alert">{error}</p>}
    <form onSubmit={create}><label>Standort-ID<input required value={createForm.site_id} onChange={e=>setCreateForm({...createForm,site_id:e.target.value})}/></label><label>Schicht-ID (optional)<input value={createForm.shift_id} onChange={e=>setCreateForm({...createForm,shift_id:e.target.value})}/></label><label>Titel<input required value={createForm.title} onChange={e=>setCreateForm({...createForm,title:e.target.value})}/></label><button>Übergabe anlegen</button></form>
    <table><thead><tr><th>Titel</th><th>Standort</th><th>Status</th><th>Teilnehmer</th><th>Bestätigungen</th><th></th></tr></thead><tbody>{handovers.map(item=><tr key={item.id}><td>{item.title}</td><td>{item.site_id}</td><td>{item.status}</td><td>{item.participant_count}</td><td>{item.confirmation_count}</td><td><button onClick={()=>void open(item.id)}>Details</button></td></tr>)}</tbody></table>
    {selected&&<article><h2>{selected.title}</h2><form onSubmit={addParticipant}><label>Rolle<select value={participantForm.participant_role} onChange={e=>setParticipantForm({...participantForm,participant_role:e.target.value})}><option value="outgoing">Abgebend</option><option value="incoming">Übernehmend</option><option value="witness">Zeuge</option></select></label><label>User-UUID<input value={participantForm.user_id} onChange={e=>setParticipantForm({...participantForm,user_id:e.target.value})}/></label><label>Mitarbeiter-UUID<input value={participantForm.employee_id} onChange={e=>setParticipantForm({...participantForm,employee_id:e.target.value})}/></label><button>Teilnehmer binden</button></form><ul>{selected.participants.map(participant=><li key={participant.id}>{participant.participant_role}: {participant.user_id??participant.employee_id} ({participant.state})</li>)}</ul><label>Teilnehmer für Bestätigung<select value={confirmationParticipant} onChange={e=>setConfirmationParticipant(e.target.value)}><option value="">Auswählen</option>{selected.participants.filter(item=>item.state==='active').map(item=><option key={item.id} value={item.id}>{item.participant_role} – {item.user_id??item.employee_id}</option>)}</select></label><button onClick={()=>void confirm()} disabled={!confirmationParticipant}>Bestätigung protokollieren</button></article>}
  </section>;
}
