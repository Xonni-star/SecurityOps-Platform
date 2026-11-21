import {FormEvent,useEffect,useState} from 'react';
import {api} from '../lib/api';
import {uuid} from "../lib/uuid";

type Option={id:string;code:string;name:string};
type Entry={id:string;revision_id:string;revision_no:number;content:string;status:'open'|'closed';category_name:string;priority_name:string;author_email:string;created_at:string;correction_reason:string|null;corrected_at:string|null};
type Integrity={valid:boolean;checked_entries:number;checked_revisions:number;invalid:string[]};

export function Watchbook(){
  const [entries,setEntries]=useState<Entry[]>([]);
  const [categories,setCategories]=useState<Option[]>([]);
  const [priorities,setPriorities]=useState<Option[]>([]);
  const [form,setForm]=useState({category_id:'',priority_code:'',content:'',client_entry_id:uuid()});
  const [error,setError]=useState('');
  const [integrity,setIntegrity]=useState<Integrity|null>(null);
  const load=async()=>{try{const [nextEntries,nextCategories,nextPriorities,nextIntegrity]=await Promise.all([api<Entry[]>('/watchbook/entries'),api<Option[]>('/watchbook/categories'),api<Option[]>('/watchbook/priorities'),api<Integrity>('/watchbook/integrity')]);const safeEntries=nextEntries??[];const safeCategories=nextCategories??[];const safePriorities=nextPriorities??[];setEntries(safeEntries);setCategories(safeCategories);setPriorities(safePriorities);if(nextIntegrity)setIntegrity(nextIntegrity);if(!form.category_id&&safeCategories[0])setForm(current=>({...current,category_id:safeCategories[0].id}));if(!form.priority_code&&safePriorities[0])setForm(current=>({...current,priority_code:safePriorities[0].code}));}catch(e){setError((e as Error).message);}};
  useEffect(()=>{void load();},[]);
  const create=async(event:FormEvent)=>{event.preventDefault();try{await api('/watchbook/entries',{method:'POST',body:JSON.stringify(form)});setForm(current=>({...current,content:'',client_entry_id:uuid()}));await load();}catch(e){setError((e as Error).message);}};
  const close=async(entry:Entry)=>{const reason=window.prompt('Begründung der Korrektur / Schließung');if(!reason)return;try{await api(`/watchbook/entries/${entry.id}/corrections`,{method:'POST',body:JSON.stringify({status:'closed',reason})});await load();}catch(e){setError((e as Error).message);}};
  return <section><h1>Digitales Wachbuch</h1>{error&&<p role="alert">{error}</p>}{integrity&&<p role={integrity.valid?'status':'alert'}>Integritätsprüfung: {integrity.valid?'gültig':'FEHLER'} ({integrity.checked_entries} Einträge, {integrity.checked_revisions} Revisionen)</p>}<form onSubmit={create}><label>Kategorie<select value={form.category_id} onChange={e=>setForm({...form,category_id:e.target.value})}>{categories.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>Priorität<select value={form.priority_code} onChange={e=>setForm({...form,priority_code:e.target.value})}>{priorities.map(item=><option key={item.code} value={item.code}>{item.name}</option>)}</select></label><label>Eintrag<textarea required maxLength={10000} value={form.content} onChange={e=>setForm({...form,content:e.target.value})}/></label><button>Eintrag append-only speichern</button></form><table><thead><tr><th>Zeit</th><th>Kategorie</th><th>Priorität</th><th>Eintrag</th><th>Status</th><th>Grund der Korrektur / Schließung</th><th>Autor</th><th>Aktion</th></tr></thead><tbody>{entries.map(entry=><tr key={entry.id}><td>{new Date(entry.created_at).toLocaleString()}</td><td>{entry.category_name}</td><td>{entry.priority_name}</td><td>{entry.content}</td><td>{entry.status}</td><td>{entry.correction_reason||'—'}</td><td>{entry.author_email}</td><td>{entry.status==='open'&&<button onClick={()=>void close(entry)}>Korrigieren / schließen</button>}</td></tr>)}</tbody></table></section>;
}
