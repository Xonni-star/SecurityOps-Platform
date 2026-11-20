import {FormEvent,useEffect,useState} from 'react';
import {api} from '../lib/api';

type Catalog={id:string;code:string;name:string;default_validity_days:number|null;active:boolean};
type Qualification={id:string;code:string;name?:string;valid_from:string|null;valid_until:string|null;status:string};
const today=()=>new Date().toISOString().slice(0,10);

export function Qualifications(){
  const [catalog,setCatalog]=useState<Catalog[]>([]);
  const [items,setItems]=useState<Qualification[]>([]);
  const [employeeId,setEmployeeId]=useState('');
  const [reminders,setReminders]=useState('90,60,30,7');
  const [form,setForm]=useState({code:'',valid_from:today(),valid_until:'',reason:''});
  const [error,setError]=useState('');
  const loadCatalog=async()=>setCatalog((await api<Catalog[]>('/qualifications/catalog'))??[]);
  const loadEmployee=async()=>{if(employeeId.trim())setItems((await api<Qualification[]>(`/employees/${employeeId.trim()}/qualifications`))??[]);};
  useEffect(()=>{void loadCatalog();void api<{reminder_days:number[]}>('/qualifications/reminders').then(v=>{if(v)setReminders(v.reminder_days.join(','));}).catch(()=>undefined);},[]);
  const save=async(e:FormEvent)=>{e.preventDefault();try{await api(`/employees/${employeeId}/qualifications`,{method:'POST',body:JSON.stringify({...form,valid_until:form.valid_until||null,reason:form.reason})});setForm(v=>({...v,reason:''}));await loadEmployee();}catch(e){setError((e as Error).message);}};
  const saveReminders=async()=>{try{await api('/qualifications/reminders',{method:'PUT',body:JSON.stringify({reminder_days:reminders.split(',').map(v=>Number(v.trim())).filter(Number.isFinite),reason:'Reminder-Konfiguration aktualisiert'})});}catch(e){setError((e as Error).message);}};
  return <section><h1>Qualifikationen</h1>{error&&<p role="alert">{error}</p>}
    <h2>Mitarbeiter-Qualifikationen</h2><label>Mitarbeiter-ID<input value={employeeId} onChange={e=>setEmployeeId(e.target.value)} onBlur={()=>void loadEmployee()}/></label>
    <form onSubmit={save}><label>Qualifikation<select required value={form.code} onChange={e=>setForm({...form,code:e.target.value})}><option value="">Bitte wählen</option>{catalog.filter(c=>c.active).map(c=><option key={c.code} value={c.code}>{c.name} ({c.code})</option>)}</select></label><label>Gültig ab<input type="date" value={form.valid_from} onChange={e=>setForm({...form,valid_from:e.target.value})}/></label><label>Gültig bis<input type="date" value={form.valid_until} onChange={e=>setForm({...form,valid_until:e.target.value})}/></label><label>Begründung<input required value={form.reason} onChange={e=>setForm({...form,reason:e.target.value})}/></label><button>Speichern</button></form>
    <table><thead><tr><th>Qualifikation</th><th>Gültig bis</th><th>Status</th></tr></thead><tbody>{items.map(item=><tr key={item.id}><td>{item.name??item.code}</td><td>{item.valid_until??'unbegrenzt'}</td><td>{item.status}</td></tr>)}</tbody></table>
    <h2>Ablauf-Erinnerungen</h2><label>Tage vor Ablauf (Komma-getrennt)<input value={reminders} onChange={e=>setReminders(e.target.value)}/></label><button onClick={()=>void saveReminders()}>Erinnerungen speichern</button>
  </section>;
}
