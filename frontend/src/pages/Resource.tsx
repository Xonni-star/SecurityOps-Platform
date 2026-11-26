import {FormEvent,useEffect,useState} from 'react';
import {api} from '../lib/api';

type Row=Record<string,string>;

function DeviceResource(){
  const [rows,setRows]=useState<Row[]>([]);
  const [sites,setSites]=useState<{id:string;name:string}[]>([]);
  const [form,setForm]=useState({name:'',status:'',site_id:''});
  const [error,setError]=useState('');
  const [success,setSuccess]=useState('');
  const [saving,setSaving]=useState(false);
  const load=async()=>{
    try{
      const [devices,availableSites]=await Promise.all([api<Row[]>('/devices'),api<{id:string;name:string}[]>('/sites')]);
      setRows(devices||[]);setSites(availableSites||[]);
    }catch(e){setError((e as Error).message);}
  };
  useEffect(()=>{void load();},[]);
  async function submit(event:FormEvent){
    event.preventDefault();setError('');setSuccess('');
    if(saving)return;
    setSaving(true);
    try{
      // The devices schema is strict: status is an enum and site_id is a UUID or null.
      // Never send the empty strings produced by selects/inputs as raw values.
      const payload={name:form.name.trim(),...(form.status?{status:form.status}:{}),site_id:form.site_id||null};
      await api('/devices',{method:'POST',body:JSON.stringify(payload)});
      setForm({name:'',status:'',site_id:''});setSuccess('Gerät wurde angelegt.');await load();
    }catch(e){setError((e as Error).message);}
    finally{setSaving(false);}
  }
  return <section><h2>Devices</h2>
    {error&&<p role="alert">{error}</p>}{success&&<p role="status">{success}</p>}
    <form onSubmit={submit}>
      <input required placeholder="name" value={form.name} onChange={e=>setForm({...form,name:e.target.value})}/>
      <select aria-label="Status" value={form.status} onChange={e=>setForm({...form,status:e.target.value})}>
        <option value="">Status wählen</option><option value="online">online</option><option value="offline">offline</option><option value="maintenance">maintenance</option>
      </select>
      <select aria-label="Objekt" value={form.site_id} onChange={e=>setForm({...form,site_id:e.target.value})}>
        <option value="">Kein Objekt</option>{sites.map(site=><option key={site.id} value={site.id}>{site.name}</option>)}
      </select>
      <button disabled={saving}>{saving?'Speichern …':'Add'}</button>
    </form>
    <ul>{rows.map(row=><li key={row.id}>{row.name} {row.email&&`— ${row.email}`}</li>)}</ul>
  </section>;
}

function GenericResource({name,fields}:{name:string;fields:string[]}){
  const [rows,setRows]=useState<Row[]>([]),[form,setForm]=useState<Row>({}),[error,setError]=useState('');
  const load=()=>api<Row[]>(`/${name}`).then(data=>{setRows(data||[]);setError('');}).catch(e=>setError((e as Error).message));
  useEffect(()=>{void load()},[]);
  async function submit(e:FormEvent){
    e.preventDefault();
    try{await api(`/${name}`,{method:'POST',body:JSON.stringify(form)});setForm({});await load();}
    catch(e){setError((e as Error).message);}
  }
  return <section><h2>{name[0].toUpperCase()+name.slice(1)}</h2>{error&&<p role="alert">{error}</p>}<form onSubmit={submit}>{fields.map(f=><input key={f} placeholder={f} value={form[f]||''} onChange={e=>setForm({...form,[f]:e.target.value})} required={f==='name'}/>) }<button>Add</button></form><ul>{rows.map(r=><li key={r.id}>{r.name} {r.email&&`— ${r.email}`}</li>)}</ul></section>
}

export function Resource({name,fields}:{name:string;fields:string[]}){
  return name==='devices'?<DeviceResource/>:<GenericResource name={name} fields={fields}/>;
}
