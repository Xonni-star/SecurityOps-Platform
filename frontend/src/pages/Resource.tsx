import {FormEvent,useEffect,useState} from 'react';
import {api} from '../lib/api';

type Row=Record<string,string>;

const fieldLabels:Record<string,string>={
  name:'Bezeichnung',
  status:'Status',
  email:'E-Mail-Adresse',
};

const resourceLabels:Record<string,string>={
  employees:'Mitarbeiter',
  customers:'Kunden',
  sites:'Objekte',
  devices:'Geräte',
};

function titleFor(name:string):string{
  return resourceLabels[name]??name.charAt(0).toUpperCase()+name.slice(1);
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
  return <GenericResource name={name} fields={fields}/>;
}
