import {FormEvent,useEffect,useState} from 'react';
import {api} from '../lib/api';
import {isUuid} from '../lib/validation';
import {uuid} from "../lib/uuid";

type Period={id:string;name:string;site_id:string;site_name:string;starts_at:string;ends_at:string;status:string;rule_profile_name:string;rule_profile_version:number};
type Conflict={id:string;conflict_type:string;severity:string;period_name:string;role_code?:string;employee_name?:string;details:Record<string,unknown>};
type Profile={id:string;name:string;version:number;parameters:Record<string,unknown>};

export function Scheduling(){
  const [periods,setPeriods]=useState<Period[]>([]);
  const [profiles,setProfiles]=useState<Profile[]>([]);
  const [sites,setSites]=useState<{id:string;name:string}[]>([]);
  const [conflicts,setConflicts]=useState<Conflict[]>([]);
  const [error,setError]=useState('');
  const [form,setForm]=useState({name:'',site_id:'',rule_profile_id:'',starts_at:'',ends_at:'',client_mutation_id:uuid()});
  const load=async()=>{try{const [nextPeriods,nextProfiles,nextConflicts,nextSites]=await Promise.all([api<Period[]>('/scheduling/periods'),api<Profile[]>('/scheduling/rule-profiles'),api<Conflict[]>('/scheduling/conflicts'),api<{id:string;name:string}[]>('/sites')]);setPeriods(nextPeriods??[]);setProfiles(nextProfiles??[]);setConflicts(nextConflicts??[]);setSites(nextSites??[]);setError('');if(!form.rule_profile_id&&nextProfiles?.[0])setForm(current=>({...current,rule_profile_id:nextProfiles[0].id}));}catch(e){setError((e as Error).message);}};
  useEffect(()=>{void load();},[]);
  const create=async(event:FormEvent)=>{event.preventDefault();if(!isUuid(form.site_id)||!isUuid(form.rule_profile_id)){setError('Bitte gültige Objekt- und Regelprofil-IDs wählen.');return;}try{const payload={...form,starts_at:new Date(form.starts_at).toISOString(),ends_at:new Date(form.ends_at).toISOString()};await api('/scheduling/periods',{method:'POST',body:JSON.stringify(payload)});setForm(current=>({...current,name:'',client_mutation_id:uuid()}));await load();}catch(e){setError((e as Error).message);}};
  return <section><h1>Dienstplanung</h1><p>Regelprofile sind tenant-konfigurierbare Parameter. Konflikte werden als nachvollziehbare Befunde gespeichert; eine rechtliche oder tarifliche Bewertung ist nicht enthalten.</p>{error&&<p role="alert">{error}</p>}<form onSubmit={create}><label>Name<input required value={form.name} onChange={e=>setForm({...form,name:e.target.value})}/></label><label>Standort<select required value={form.site_id} onChange={e=>setForm({...form,site_id:e.target.value})}><option value="">Objekt wählen</option>{sites.map(site=><option key={site.id} value={site.id}>{site.name}</option>)}</select></label><label>Regelprofil<select required value={form.rule_profile_id} onChange={e=>setForm({...form,rule_profile_id:e.target.value})}>{profiles.map(profile=><option key={profile.id} value={profile.id}>{profile.name} v{profile.version}</option>)}</select></label><label>Beginn<input required type="datetime-local" value={form.starts_at} onChange={e=>setForm({...form,starts_at:e.target.value})}/></label><label>Ende<input required type="datetime-local" value={form.ends_at} onChange={e=>setForm({...form,ends_at:e.target.value})}/></label><button>Periode speichern</button></form><h2>Perioden</h2><table><thead><tr><th>Name</th><th>Standort</th><th>Zeitraum</th><th>Status</th><th>Regelprofil</th></tr></thead><tbody>{periods.map(period=><tr key={period.id}><td>{period.name}</td><td>{period.site_name}</td><td>{new Date(period.starts_at).toLocaleString()} – {new Date(period.ends_at).toLocaleString()}</td><td>{period.status}</td><td>{period.rule_profile_name} v{period.rule_profile_version}</td></tr>)}</tbody></table><h2>Offene Konfliktbefunde</h2>{conflicts.length===0?<p>Keine offenen Befunde.</p>:<ul>{conflicts.map(conflict=><li key={conflict.id}><strong>{conflict.severity}</strong> {conflict.conflict_type} – {conflict.period_name}{conflict.employee_name?` (${conflict.employee_name})`:''}</li>)}</ul>}</section>;
}
