import {FormEvent,useEffect,useState} from 'react';
import {api} from '../lib/api';
import {statusLabel} from '../lib/status';

type Row=Record<string,string>;

const fieldLabels:Record<string,string>={
  name:'Bezeichnung',
  status:'Status',
  site_id:'Objekt',
  email:'E-Mail-Adresse',
};

const resourceLabels:Record<string,string>={
  devices:'Geräte',
};

function titleFor(name:string):string{
  return resourceLabels[name]??name.charAt(0).toUpperCase()+name.slice(1);
}

function DeviceResource(){
  const [rows,setRows]=useState<Row[]>([]);
  const [sites,setSites]=useState<{id:string;name:string}[]>([]);
  const [form,setForm]=useState({name:'',status:'',site_id:''});
  const [error,setError]=useState('');
  const [success,setSuccess]=useState('');
  const [saving,setSaving]=useState(false);

  const load=async()=>{
    try{
      const [devices,availableSites]=await Promise.all([
        api<Row[]>('/devices'),
        api<{id:string;name:string}[]>('/sites'),
      ]);
      setRows(devices||[]);
      setSites(availableSites||[]);
    }catch(cause){setError((cause as Error).message);}
  };

  useEffect(()=>{void load();},[]);

  async function submit(event:FormEvent){
    event.preventDefault();
    setError('');
    setSuccess('');
    if(saving)return;
    setSaving(true);
    try{
      // Das Geräteschema erwartet einen Status aus der Enumeration und eine
      // Objekt-ID als UUID oder null. Leere Auswahlwerte dürfen nicht gesendet werden.
      const payload={name:form.name.trim(),...(form.status?{status:form.status}:{}),site_id:form.site_id||null};
      await api('/devices',{method:'POST',body:JSON.stringify(payload)});
      setForm({name:'',status:'',site_id:''});
      setSuccess('Das Gerät wurde angelegt.');
      await load();
    }catch(cause){setError((cause as Error).message);}
    finally{setSaving(false);}
  }

  const siteName=(row:Row)=>sites.find(site=>site.id===row.site_id)?.name??row.site_name??'Kein Objekt';

  return <section>
    <h2>Geräte verwalten</h2>
    {error&&<p role="alert">{error}</p>}
    {success&&<p role="status">{success}</p>}
    <form onSubmit={submit}>
      <label>Bezeichnung
        <input required placeholder="z. B. Handfunkgerät 01" value={form.name} onChange={event=>setForm({...form,name:event.target.value})}/>
      </label>
      <label>Status
        <select value={form.status} onChange={event=>setForm({...form,status:event.target.value})}>
          <option value="">Status auswählen</option>
          <option value="online">Online</option>
          <option value="offline">Offline</option>
          <option value="maintenance">In Wartung</option>
        </select>
      </label>
      <label>Objekt
        <select value={form.site_id} onChange={event=>setForm({...form,site_id:event.target.value})}>
          <option value="">Kein Objekt</option>
          {sites.map(site=><option key={site.id} value={site.id}>{site.name}</option>)}
        </select>
      </label>
      <button disabled={saving}>{saving?'Speichern …':'Gerät anlegen'}</button>
    </form>
    <table>
      <thead><tr><th>Bezeichnung</th><th>Status</th><th>Objekt</th></tr></thead>
      <tbody>{rows.map(row=><tr key={row.id}>
        <td>{row.name}</td>
        <td>{statusLabel(row.status,'device')}</td>
        <td>{siteName(row)}</td>
      </tr>)}</tbody>
    </table>
    {rows.length===0&&<p>Keine Geräte erfasst.</p>}
  </section>;
}

function GenericResource({name,fields}:{name:string;fields:string[]}){
  const [rows,setRows]=useState<Row[]>([]);
  const [form,setForm]=useState<Row>({});
  const [error,setError]=useState('');
  const label=(field:string)=>fieldLabels[field]??field;
  const load=()=>api<Row[]>(`/${name}`)
    .then(data=>{setRows(data||[]);setError('');})
    .catch(cause=>setError((cause as Error).message));

  useEffect(()=>{void load();},[]);

  async function submit(event:FormEvent){
    event.preventDefault();
    try{
      await api(`/${name}`,{method:'POST',body:JSON.stringify(form)});
      setForm({});
      await load();
    }catch(cause){setError((cause as Error).message);}
  }

  return <section>
    <h2>{titleFor(name)} verwalten</h2>
    {error&&<p role="alert">{error}</p>}
    <form onSubmit={submit}>
      {fields.map(field=><label key={field}>{label(field)}
        <input required={field==='name'} placeholder={label(field)} value={form[field]||''} onChange={event=>setForm({...form,[field]:event.target.value})}/>
      </label>)}
      <button>Eintrag anlegen</button>
    </form>
    <ul>{rows.map(row=><li key={row.id}>{row.name}{row.email&&` — ${row.email}`}</li>)}</ul>
    {rows.length===0&&<p>Keine Einträge erfasst.</p>}
  </section>;
}

export function Resource({name,fields}:{name:string;fields:string[]}){
  return name==='devices'?<DeviceResource/>:<GenericResource name={name} fields={fields}/>;
}
