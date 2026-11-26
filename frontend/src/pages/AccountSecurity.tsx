import {FormEvent,useEffect,useState} from 'react';
import {api,hasPermission} from '../lib/api';
import {formatDateTime} from '../lib/format';
import {roleLabel} from '../lib/status';
import {commonText} from '../lib/text';

type Account={
  id:string;
  email:string;
  failed_login_attempts:number;
  locked_until:string|null;
  locked_permanently:boolean;
  last_failed_login_at:string|null;
};
type User={id:string;email:string;role:string;mfa_enrolled_at:string|null;locked_permanently:boolean;created_at:string};

export function AccountSecurity(){
  const [accounts,setAccounts]=useState<Account[]>([]);
  const [users,setUsers]=useState<User[]>([]);
  const [error,setError]=useState('');
  const [email,setEmail]=useState('');
  const [password,setPassword]=useState('');
  const [role,setRole]=useState('operator');

  const load=async()=>{
    try{
      if(hasPermission('account_security:read'))setAccounts(await api<Account[]>('/auth/lockout/accounts')||[]);
      if(hasPermission('account_security:manage'))setUsers(await api<User[]>('/auth/accounts')||[]);
    }catch(cause){setError((cause as Error).message);}
  };

  useEffect(()=>{void load();},[]);

  async function create(event:FormEvent){
    event.preventDefault();
    setError('');
    try{
      await api('/auth/accounts',{method:'POST',body:JSON.stringify({email,password,role})});
      setEmail('');
      setPassword('');
      setRole('operator');
      await load();
    }catch(cause){setError((cause as Error).message);}
  }

  async function unlock(id:string){
    const reason=window.prompt('Begründung für die Entsperrung');
    if(!reason||reason.trim().length<3){setError(commonText.reasonRequired);return;}
    try{
      await api(`/auth/lockout/accounts/${id}/unlock`,{method:'POST',body:JSON.stringify({reason})});
      await load();
    }catch(cause){setError((cause as Error).message);}
  }

  async function lock(id:string){
    const reason=window.prompt('Begründung für die dauerhafte Sperre');
    if(!reason||reason.trim().length<3){setError(commonText.reasonRequired);return;}
    try{
      await api(`/auth/lockout/accounts/${id}/lock`,{method:'POST',body:JSON.stringify({reason})});
      await load();
    }catch(cause){setError((cause as Error).message);}
  }

  if(!hasPermission('account_security:read')){
    return <section><h2>Kontosicherheit</h2><p>{commonText.noPermission}</p></section>;
  }

  return <section>
    <h2>Kontosicherheit</h2>
    <p>Verwalten Sie Benutzerkonten, Anmeldesperren und die Zwei-Faktor-Authentifizierung.</p>
    {error&&<p role="alert">{error}</p>}
    {hasPermission('account_security:manage')&&<>
      <h3>Neues Benutzerkonto</h3>
      <p>Das Startpasswort muss Groß- und Kleinbuchstaben, eine Zahl und ein Sonderzeichen enthalten.</p>
      <form onSubmit={create}>
        <label>E-Mail-Adresse
          <input required type="email" placeholder="name@unternehmen.de" value={email} onChange={event=>setEmail(event.target.value)}/>
        </label>
        <label>Startpasswort
          <input required minLength={12} type="password" placeholder="Startpasswort eingeben" value={password} onChange={event=>setPassword(event.target.value)}/>
        </label>
        <label>Rolle
          <select value={role} onChange={event=>setRole(event.target.value)}>
            <option value="operator">Disponent</option>
            <option value="viewer">Betrachter</option>
            <option value="admin">Administrator</option>
            <option value="superadmin">Systemadministrator</option>
          </select>
        </label>
        <button type="submit">Konto anlegen</button>
      </form>
      <h3>Benutzerkonten</h3>
      <ul>{users.map(user=><li key={user.id}>
        <strong>{user.email}</strong> · {roleLabel(user.role)} · Zwei-Faktor-Authentifizierung: {user.mfa_enrolled_at?'eingerichtet':'nicht eingerichtet'} · {user.locked_permanently?'dauerhaft gesperrt':'aktiv'}
      </li>)}</ul>
    </>}
    <h3>Anmeldesicherheit</h3>
    <p>Fehlgeschlagene Anmeldungen werden je Konto gezählt. Passwörter und Zugriffsschlüssel werden nicht angezeigt.</p>
    <ul>{accounts.map(account=><li key={account.id}>
      <strong>{account.email}</strong> · Fehlversuche: {account.failed_login_attempts} · {account.locked_permanently?'dauerhaft gesperrt':account.locked_until?`gesperrt bis ${formatDateTime(account.locked_until)}`:'nicht gesperrt'}
      {account.last_failed_login_at&&` · letzter Fehlversuch: ${formatDateTime(account.last_failed_login_at)}`}
      {hasPermission('account_security:manage')&&(account.locked_until||account.locked_permanently)&&<button onClick={()=>void unlock(account.id)}>Entsperren</button>}
      {hasPermission('account_security:manage')&&!account.locked_permanently&&<button onClick={()=>void lock(account.id)}>Dauerhaft sperren</button>}
    </li>)}</ul>
    {accounts.length===0&&<p>Keine Konten mit Anmeldesperre vorhanden.</p>}
  </section>;
}
