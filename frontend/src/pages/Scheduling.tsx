import {FormEvent,useEffect,useState} from 'react';
import {api} from '../lib/api';
import {berlinDateTimeToIso,formatDateTime} from '../lib/format';
import {statusLabel} from '../lib/status';
import {isUuid} from '../lib/validation';
import {requiredUuidMessage} from '../lib/text';
import {uuid} from '../lib/uuid';

type Period={id:string;name:string;site_id:string;site_name:string;starts_at:string;ends_at:string;status:string;rule_profile_name:string;rule_profile_version:number};
type Conflict={id:string;conflict_type:string;severity:string;period_name:string;role_code?:string;employee_name?:string;details:Record<string,unknown>};
type Profile={id:string;name:string;version:number;parameters:Record<string,unknown>};
type SiteOption={id:string;name:string};

export function Scheduling(){
  const [periods,setPeriods]=useState<Period[]>([]);
  const [profiles,setProfiles]=useState<Profile[]>([]);
  const [sites,setSites]=useState<SiteOption[]>([]);
  const [conflicts,setConflicts]=useState<Conflict[]>([]);
  const [error,setError]=useState('');
  const [success,setSuccess]=useState('');
  const [saving,setSaving]=useState(false);
  const [form,setForm]=useState({name:'',site_id:'',rule_profile_id:'',starts_at:'',ends_at:'',client_mutation_id:uuid()});

  const load=async()=>{
    try{
      const [nextPeriods,nextProfiles,nextConflicts,nextSites]=await Promise.all([
        api<Period[]>('/scheduling/periods'),
        api<Profile[]>('/scheduling/rule-profiles'),
        api<Conflict[]>('/scheduling/conflicts'),
        api<SiteOption[]>('/sites'),
      ]);
      setPeriods(nextPeriods??[]);
      setProfiles(nextProfiles??[]);
      setConflicts(nextConflicts??[]);
      setSites(nextSites??[]);
      setError('');
      if(!form.rule_profile_id&&nextProfiles?.[0])setForm(current=>({...current,rule_profile_id:nextProfiles[0].id}));
    }catch(cause){setError((cause as Error).message);}
  };

  useEffect(()=>{void load();},[]);

  const create=async(event:FormEvent)=>{
    event.preventDefault();
    if(!isUuid(form.site_id)){setError(requiredUuidMessage('Objekt','neutral'));return;}
    if(!isUuid(form.rule_profile_id)){setError(requiredUuidMessage('Regelprofil','neutral'));return;}
    if(saving)return;
    setSaving(true);
    try{
      const payload={
        ...form,
        starts_at:berlinDateTimeToIso(form.starts_at),
        ends_at:berlinDateTimeToIso(form.ends_at),
      };
      await api('/scheduling/periods',{method:'POST',body:JSON.stringify(payload)});
      setForm(current=>({...current,name:'',client_mutation_id:uuid()}));
      setError('');
      setSuccess('Der Planungszeitraum wurde gespeichert.');
      await load();
    }catch(cause){setError((cause as Error).message);}
    finally{setSaving(false);}
  };


  return <section>
    <h2>Dienstplanung</h2>
    <p>Planen Sie Zeiträume und Schichten. Regelprofile enthalten die Einstellungen je Kunde und Objekt; Konflikte werden als nachvollziehbare Befunde gespeichert.</p>
    {error&&<p role="alert">{error}</p>}
    {success&&<p role="status">{success}</p>}
    <form onSubmit={create}>
      <label>Bezeichnung
        <input required placeholder="z. B. Nachtdienst KW 45" value={form.name} onChange={event=>setForm({...form,name:event.target.value})}/>
      </label>
      <label>Objekt
        <select required value={form.site_id} onChange={event=>setForm({...form,site_id:event.target.value})}>
          <option value="">Objekt auswählen</option>
          {sites.map(site=><option key={site.id} value={site.id}>{site.name}</option>)}
        </select>
      </label>
      <label>Regelprofil
        <select required value={form.rule_profile_id} onChange={event=>setForm({...form,rule_profile_id:event.target.value})}>
          <option value="">Regelprofil auswählen</option>
          {profiles.map(profile=><option key={profile.id} value={profile.id}>{profile.name} · Fassung {profile.version}</option>)}
        </select>
      </label>
      <label>Beginn
        <input required type="datetime-local" value={form.starts_at} onChange={event=>setForm({...form,starts_at:event.target.value})}/>
      </label>
      <label>Ende
        <input required type="datetime-local" value={form.ends_at} onChange={event=>setForm({...form,ends_at:event.target.value})}/>
      </label>
      <button disabled={saving}>{saving?'Speichern …':'Planungszeitraum speichern'}</button>
    </form>
    <h3>Planungszeiträume</h3>
    <table>
      <thead><tr><th>Bezeichnung</th><th>Objekt</th><th>Zeitraum</th><th>Status</th><th>Regelprofil</th></tr></thead>
      <tbody>{periods.map(period=><tr key={period.id}>
        <td>{period.name}</td>
        <td>{period.site_name||'Nicht verfügbar'}</td>
        <td>{formatDateTime(period.starts_at)} – {formatDateTime(period.ends_at)}</td>
        <td>{statusLabel(period.status,'scheduling')}</td>
        <td>{period.rule_profile_name||'Nicht verfügbar'} · Fassung {period.rule_profile_version}</td>
      </tr>)}</tbody>
    </table>
    {periods.length===0&&<p>Keine Planungszeiträume erfasst.</p>}
    <h3>Offene Konfliktbefunde</h3>
    {conflicts.length===0?<p>Keine offenen Befunde.</p>:<ul>{conflicts.map(conflict=><li key={conflict.id}>
      <strong>{statusLabel(conflict.severity,'conflict')}</strong> · {statusLabel(conflict.conflict_type,'conflict')} – {conflict.period_name}
      {conflict.role_code&&` · Funktion: ${statusLabel(conflict.role_code,'shiftRole')}`}
      {conflict.employee_name&&` · ${conflict.employee_name}`}
    </li>)}</ul>}
  </section>;
}
