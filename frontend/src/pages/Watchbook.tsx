import {FormEvent,useEffect,useState} from 'react';
import {api} from '../lib/api';
import {formatDateTime,formatNumber} from '../lib/format';
import {statusLabel} from '../lib/status';
import {commonText} from '../lib/text';
import {uuid} from '../lib/uuid';

type Option={id:string;code:string;name:string};
type Entry={
  id:string;
  revision_id:string;
  revision_no:number;
  content:string;
  status:'open'|'closed';
  category_name:string;
  priority_name:string;
  author_email:string;
  created_at:string;
  correction_reason:string|null;
  corrected_at:string|null;
};
type Integrity={valid:boolean;checked_entries:number;checked_revisions:number;invalid:string[]};

export function Watchbook(){
  const [entries,setEntries]=useState<Entry[]>([]);
  const [categories,setCategories]=useState<Option[]>([]);
  const [priorities,setPriorities]=useState<Option[]>([]);
  const [form,setForm]=useState({category_id:'',priority_code:'',content:'',client_entry_id:uuid()});
  const [error,setError]=useState('');
  const [success,setSuccess]=useState('');
  const [integrity,setIntegrity]=useState<Integrity|null>(null);

  const load=async()=>{
    try{
      const [nextEntries,nextCategories,nextPriorities,nextIntegrity]=await Promise.all([
        api<Entry[]>('/watchbook/entries'),
        api<Option[]>('/watchbook/categories'),
        api<Option[]>('/watchbook/priorities'),
        api<Integrity>('/watchbook/integrity'),
      ]);
      const safeEntries=nextEntries??[];
      const safeCategories=nextCategories??[];
      const safePriorities=nextPriorities??[];
      setEntries(safeEntries);
      setCategories(safeCategories);
      setPriorities(safePriorities);
      if(nextIntegrity)setIntegrity(nextIntegrity);
      if(!form.category_id&&safeCategories[0])setForm(current=>({...current,category_id:safeCategories[0].id}));
      if(!form.priority_code&&safePriorities[0])setForm(current=>({...current,priority_code:safePriorities[0].code}));
    }catch(cause){setError((cause as Error).message);}
  };

  useEffect(()=>{void load();},[]);

  const create=async(event:FormEvent)=>{
    event.preventDefault();
    try{
      await api('/watchbook/entries',{method:'POST',body:JSON.stringify(form)});
      setForm(current=>({...current,content:'',client_entry_id:uuid()}));
      setError('');
      setSuccess('Der Eintrag wurde revisionssicher gespeichert.');
      await load();
    }catch(cause){setError((cause as Error).message);}
  };

  const close=async(entry:Entry)=>{
    const reason=window.prompt('Grund für Korrektur oder Abschluss');
    if(!reason?.trim())return;
    try{
      await api(`/watchbook/entries/${entry.id}/corrections`,{method:'POST',body:JSON.stringify({status:'closed',reason})});
      await load();
    }catch(cause){setError((cause as Error).message);}
  };

  return <section>
    <h2>Digitales Wachbuch</h2>
    <p>Erfassen Sie Wachbucheinträge nachvollziehbar. Korrekturen werden als neue Revision dokumentiert.</p>
    {error&&<p role="alert">{error}</p>}
    {success&&<p role="status">{success}</p>}
    {integrity&&<p role={integrity.valid?'status':'alert'}>
      Integritätsprüfung: {integrity.valid?'Gültig':'Fehlerhaft'} · {formatNumber(integrity.checked_entries)} Einträge · {formatNumber(integrity.checked_revisions)} Revisionen
    </p>}
    <form onSubmit={create}>
      <label>Kategorie
        <select value={form.category_id} onChange={event=>setForm({...form,category_id:event.target.value})}>
          {categories.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>
      <label>Priorität
        <select value={form.priority_code} onChange={event=>setForm({...form,priority_code:event.target.value})}>
          {priorities.map(item=><option key={item.code} value={item.code}>{item.name}</option>)}
        </select>
      </label>
      <label>Eintrag
        <textarea required maxLength={10000} placeholder="Vorfall, Beobachtung oder Maßnahme beschreiben" value={form.content} onChange={event=>setForm({...form,content:event.target.value})}/>
      </label>
      <button type="submit">Eintrag revisionssicher speichern</button>
    </form>
    <table>
      <thead><tr>
        <th>Zeitpunkt</th><th>Kategorie</th><th>Priorität</th><th>Eintrag</th><th>Status</th>
        <th>Grund für Korrektur oder Abschluss</th><th>Autor</th><th>Aktion</th>
      </tr></thead>
      <tbody>{entries.map(entry=><tr key={entry.id}>
        <td>{formatDateTime(entry.created_at)}</td>
        <td>{entry.category_name}</td>
        <td>{entry.priority_name}</td>
        <td>{entry.content}</td>
        <td>{statusLabel(entry.status)}</td>
        <td>{entry.correction_reason||'–'}</td>
        <td>{entry.author_email}</td>
        <td>{entry.status==='open'&&<button onClick={()=>void close(entry)}>{'Korrigieren oder abschließen'}</button>}</td>
      </tr>)}</tbody>
    </table>
    {entries.length===0&&<p>{commonText.noData}</p>}
  </section>;
}
