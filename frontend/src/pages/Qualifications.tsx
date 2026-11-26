import {FormEvent,useEffect,useState} from 'react';
import {api} from '../lib/api';
import {formatDate} from '../lib/format';
import {statusLabel} from '../lib/status';
import {isUuid} from '../lib/validation';
import {requiredUuidMessage} from '../lib/text';

type Catalog={id:string;code:string;name:string;default_validity_days:number|null;active:boolean};
type Qualification={id:string;code:string;name?:string;valid_from:string|null;valid_until:string|null;status:string};
type EmployeeOption={id:string;name:string};

const today=()=>new Date().toISOString().slice(0,10);

export function Qualifications(){
  const [catalog,setCatalog]=useState<Catalog[]>([]);
  const [items,setItems]=useState<Qualification[]>([]);
  const [employees,setEmployees]=useState<EmployeeOption[]>([]);
  const [employeeId,setEmployeeId]=useState('');
  const [reminders,setReminders]=useState('90,60,30,7');
  const [form,setForm]=useState({code:'',valid_from:today(),valid_until:'',reason:''});
  const [error,setError]=useState('');
  const [success,setSuccess]=useState('');

  const loadCatalog=async()=>{
    try{setCatalog((await api<Catalog[]>('/qualifications/catalog'))??[]);}
    catch(cause){setError((cause as Error).message);}
  };

  const loadEmployee=async()=>{
    if(!isUuid(employeeId)){
      setItems([]);
      if(employeeId.trim())setError(requiredUuidMessage('Mitarbeiter','maskulin'));
      return;
    }
    try{setItems((await api<Qualification[]>(`/employees/${employeeId.trim()}/qualifications`))??[]);}
    catch(cause){setError((cause as Error).message);}
  };

  useEffect(()=>{
    void loadCatalog();
    void api<{reminder_days:number[]}>('/qualifications/reminders')
      .then(value=>{if(value)setReminders(value.reminder_days.join(','));})
      .catch(()=>undefined);
    void api<EmployeeOption[]>('/employees').then(value=>setEmployees(value||[])).catch(()=>undefined);
  },[]);

  const save=async(event:FormEvent)=>{
    event.preventDefault();
    if(!isUuid(employeeId)){setError(requiredUuidMessage('Mitarbeiter','maskulin'));return;}
    try{
      await api(`/employees/${employeeId}/qualifications`,{method:'POST',body:JSON.stringify({
        ...form,
        valid_from:form.valid_from||null,
        valid_until:form.valid_until||null,
        reason:form.reason,
      })});
      setError('');
      setSuccess('Die Qualifikation wurde erfasst.');
      setForm(value=>({...value,reason:''}));
      await loadEmployee();
    }catch(cause){setError((cause as Error).message);}
  };

  const saveReminders=async()=>{
    try{
      await api('/qualifications/reminders',{method:'PUT',body:JSON.stringify({
        reminder_days:reminders.split(',').map(value=>Number(value.trim())).filter(Number.isFinite),
        reason:'Erinnerungseinstellungen aktualisiert',
      })});
      setError('');
      setSuccess('Die Erinnerungseinstellungen wurden gespeichert.');
    }catch(cause){setError((cause as Error).message);}
  };

  return <section>
    <h2>Qualifikationen</h2>
    <p>Erfassen Sie Qualifikationen, prüfen Sie Gültigkeiten und steuern Sie Erinnerungen vor Ablauf.</p>
    {error&&<p role="alert">{error}</p>}
    {success&&<p role="status">{success}</p>}
    <h3>Qualifikationen eines Mitarbeiters</h3>
    <label>Mitarbeiter
      <select value={employeeId} onChange={event=>{setEmployeeId(event.target.value);setItems([]);}} onBlur={()=>void loadEmployee()}>
        <option value="">Mitarbeiter auswählen</option>
        {employees.map(employee=><option key={employee.id} value={employee.id}>{employee.name}</option>)}
      </select>
    </label>
    <form onSubmit={save}>
      <label>Qualifikation
        <select required value={form.code} onChange={event=>setForm({...form,code:event.target.value})}>
          <option value="">Bitte wählen</option>
          {catalog.filter(item=>item.active).map(item=><option key={item.code} value={item.code}>{item.name} ({item.code})</option>)}
        </select>
      </label>
      <label>Gültig ab
        <input type="date" value={form.valid_from} onChange={event=>setForm({...form,valid_from:event.target.value})}/>
      </label>
      <label>Gültig bis
        <input type="date" value={form.valid_until} onChange={event=>setForm({...form,valid_until:event.target.value})}/>
      </label>
      <label>Begründung
        <input required placeholder="Grund für die Erfassung" value={form.reason} onChange={event=>setForm({...form,reason:event.target.value})}/>
      </label>
      <button type="submit">Qualifikation speichern</button>
    </form>
    <table>
      <thead><tr><th>Qualifikation</th><th>Gültig ab</th><th>Gültig bis</th><th>Status</th></tr></thead>
      <tbody>{items.map(item=><tr key={item.id}>
        <td>{item.name??item.code}</td>
        <td>{formatDate(item.valid_from)}</td>
        <td>{item.valid_until?formatDate(item.valid_until):'Unbefristet'}</td>
        <td>{statusLabel(item.status,'document')}</td>
      </tr>)}</tbody>
    </table>
    {items.length===0&&<p>Keine Qualifikationen erfasst.</p>}
    <h3>Erinnerungen vor Ablauf</h3>
    <p>Legen Sie fest, wie viele Tage vor Ablauf eine Erinnerung ausgegeben wird. Trennen Sie mehrere Werte mit Kommas.</p>
    <label>Tage vor Ablauf
      <input value={reminders} onChange={event=>setReminders(event.target.value)} placeholder="z. B. 90,60,30,7"/>
    </label>
    <button onClick={()=>void saveReminders()}>Erinnerungen speichern</button>
  </section>;
}
