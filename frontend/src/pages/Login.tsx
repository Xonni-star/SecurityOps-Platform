/* eslint-disable @typescript-eslint/no-unused-vars -- Die Einrichtung der Zwei-Faktor-Authentifizierung bleibt für den Selbstbedienungsablauf erhalten. */
import {FormEvent,useEffect,useState} from 'react';
import {useNavigate} from 'react-router-dom';
import {enrollMfa,login,mfaChallenge} from '../lib/api';
import '../mfa.css';

type Setup={uri:string;codes:string[]};

export function Login(){
  const [email,setEmail]=useState('');
  const [password,setPassword]=useState('');
  const [code,setCode]=useState('');
  const [recoveryCode,setRecoveryCode]=useState('');
  const [setup,setSetup]=useState<Setup|null>(null);
  const [pending,setPending]=useState(false);
  const [error,setError]=useState('');
  const nav=useNavigate();

  async function submit(event:FormEvent){
    event.preventDefault();
    setError('');
    try{
      const result=await login(email,password);
      if(result.mfa_required||result.mfa_pending){
        setPending(true);
        return;
      }
      localStorage.setItem('securityops_user',JSON.stringify(result.user));
      localStorage.setItem('securityops_authenticated','true');
      nav('/');
    }catch(cause){setError((cause as Error).message);}
  }

  async function setupMfa(){
    try{
      const result=await enrollMfa();
      if(!result)throw new Error('Die Einrichtung der Zwei-Faktor-Authentifizierung konnte nicht gestartet werden.');
      setSetup({uri:result.otpauthUri,codes:result.recoveryCodes});
    }catch(cause){setError((cause as Error).message);}
  }

  async function verify(event:FormEvent){
    event.preventDefault();
    setError('');
    try{
      const result=await mfaChallenge(code,recoveryCode||undefined);
      if(!result?.user)throw new Error('Die Bestätigung des Codes ist fehlgeschlagen.');
      localStorage.setItem('securityops_user',JSON.stringify(result.user));
      localStorage.setItem('securityops_authenticated','true');
      nav('/');
    }catch(cause){setError((cause as Error).message);}
  }

  if(pending){
    return <MfaChallenge
      error={error}
      code={code}
      recoveryCode={recoveryCode}
      onCode={setCode}
      onRecoveryCode={setRecoveryCode}
      onVerify={verify}
    />;
  }

  return <main className="auth-shell">
    <section className="auth-card login-card">
      <div className="auth-brand">SECURITY<span>OPS</span></div>
      <p className="eyebrow">Sicherer Arbeitsbereich</p>
      <h1>Willkommen zurück</h1>
      <p className="muted">Melden Sie sich an, um Leitstelle, Wachbuch und operative Daten sicher zu verwalten.</p>
      <form className="login-form" onSubmit={submit}>
        <label>E-Mail-Adresse
          <input required value={email} onChange={event=>setEmail(event.target.value)} type="email" autoComplete="username" placeholder="name@unternehmen.de"/>
        </label>
        <label>Passwort
          <input required value={password} onChange={event=>setPassword(event.target.value)} type="password" autoComplete="current-password" placeholder="Passwort eingeben"/>
        </label>
        {error&&<p className="error" role="alert">{error}</p>}
        <button className="primary full">Anmelden</button>
      </form>
      <p className="security-note">Geschützte Verbindung · SecurityOps Plattform</p>
    </section>
  </main>;
}

function MfaChallenge({error,code,recoveryCode,onCode,onRecoveryCode,onVerify}:{
  error:string;
  code:string;
  recoveryCode:string;
  onCode:(value:string)=>void;
  onRecoveryCode:(value:string)=>void;
  onVerify:(event:FormEvent)=>void;
}){
  return <main className="auth-shell">
    <section className="auth-card">
      <div className="auth-brand">SECURITY<span>OPS</span></div>
      <p className="eyebrow">Sicherheitsprüfung · Schritt 2 von 2</p>
      <h1>Code der Zwei-Faktor-Authentifizierung bestätigen</h1>
      <p className="muted">Ihre Authenticator-App ist bereits eingerichtet. Geben Sie den aktuellen sechsstelligen Code aus Ihrer App ein.</p>
      <form className="mfa-form" onSubmit={onVerify}>
        <label>Sechsstelliger Code
          <input className="otp-input" required value={code} onChange={event=>onCode(event.target.value.replace(/\D/g,'').slice(0,6))} inputMode="numeric" autoComplete="one-time-code" placeholder="000000" autoFocus/>
        </label>
        <label className="recovery-input">Oder Wiederherstellungscode
          <input value={recoveryCode} onChange={event=>onRecoveryCode(event.target.value)} autoComplete="off" placeholder="XXXX-XXXX"/>
        </label>
        {error&&<p className="error" role="alert">{error}</p>}
        <button className="primary full" disabled={!code&&!recoveryCode}>Anmelden</button>
      </form>
      <p className="security-note">Zwei-Faktor-Authentifizierung ist bereits aktiviert · SecurityOps Plattform</p>
    </section>
  </main>;
}

function MfaSetup({setup,error,code,recoveryCode,onSetup,onCode,onRecoveryCode,onVerify}:{
  setup:Setup|null;
  error:string;
  code:string;
  recoveryCode:string;
  onSetup:()=>void;
  onCode:(value:string)=>void;
  onRecoveryCode:(value:string)=>void;
  onVerify:(event:FormEvent)=>void;
}){
  const [copied,setCopied]=useState('');
  const [qr,setQr]=useState('');
  useEffect(()=>{
    if(!setup)return;
    import('qrcode').then(({toDataURL})=>toDataURL(setup.uri,{width:220,margin:1,errorCorrectionLevel:'M'})).then(setQr).catch(()=>setQr(''));
  },[setup]);

  const copy=async(label:string,value:string)=>{
    try{
      await navigator.clipboard.writeText(value);
      setCopied(label);
      setTimeout(()=>setCopied(''),1800);
    }catch{setCopied('Kopieren nicht möglich');}
  };

  if(!setup){
    return <main className="auth-shell">
      <section className="auth-card">
        <div className="auth-brand">SECURITY<span>OPS</span></div>
        <p className="eyebrow">Sicherheitsprüfung · Schritt 1 von 2</p>
        <h1>Zwei-Faktor-Authentifizierung einrichten</h1>
        <p className="muted">Für dieses Konto ist eine zusätzliche Anmeldung erforderlich. Richten Sie jetzt eine Authenticator-App ein.</p>
        <div className="step-list">
          <div className="step active"><b>1</b><span>Authenticator-App verbinden</span></div>
          <div className="step"><b>2</b><span>Code bestätigen</span></div>
        </div>
        <button className="primary full" type="button" onClick={onSetup}>Einrichtung starten</button>
        {error&&<p className="error" role="alert">{error}</p>}
      </section>
    </main>;
  }

  return <main className="auth-shell">
    <section className="auth-card auth-card-wide">
      <div className="auth-brand">SECURITY<span>OPS</span></div>
      <p className="eyebrow">Sicherheitsprüfung · Schritt 2 von 2</p>
      <h1>Authenticator-App verbinden</h1>
      <p className="muted">Scannen Sie den QR-Code mit Ihrer Authenticator-App. Alternativ können Sie den Einrichtungsschlüssel manuell eingeben.</p>
      <div className="mfa-grid">
        <div className="qr-panel">
          {qr?<img src={qr} alt="QR-Code für die Einrichtung der Zwei-Faktor-Authentifizierung"/>:<div className="qr-fallback">QR-Code wird geladen …</div>}
          <strong>Mit der Authenticator-App scannen</strong>
          <span className="muted small">Zum Beispiel Google Authenticator, 1Password oder Authy.</span>
        </div>
        <div className="manual-panel">
          <label>Einrichtungsschlüssel</label>
          <div className="secret-row">
            <code>{setup.uri.split('secret=')[1]?.split('&')[0]??'–'}</code>
            <button type="button" className="secondary" onClick={()=>void copy('Schlüssel',setup.uri)}>{copied==='Schlüssel'?'Kopiert':'Kopieren'}</button>
          </div>
          <details><summary>Manuelle URI anzeigen</summary><code className="uri">{setup.uri}</code></details>
          <div className="recovery-box">
            <div>
              <strong>Wiederherstellungscodes sichern</strong>
              <span className="muted small">Jeder Code ist nur einmal verwendbar.</span>
            </div>
            <button type="button" className="secondary" onClick={()=>void copy('Wiederherstellungscodes',setup.codes.join('\n'))}>{copied==='Wiederherstellungscodes'?'Kopiert':'Alle kopieren'}</button>
            <div className="recovery-codes">{setup.codes.map((item,index)=><code key={index}>{item}</code>)}</div>
          </div>
        </div>
      </div>
      <form className="mfa-form" onSubmit={onVerify}>
        <label>Sechsstelliger Code aus der App
          <input className="otp-input" value={code} onChange={event=>onCode(event.target.value.replace(/\D/g,'').slice(0,6))} inputMode="numeric" autoComplete="one-time-code" placeholder="000000" autoFocus/>
        </label>
        <label className="recovery-input">Oder Wiederherstellungscode
          <input value={recoveryCode} onChange={event=>onRecoveryCode(event.target.value)} autoComplete="off" placeholder="XXXX-XXXX"/>
        </label>
        {error&&<p className="error" role="alert">{error}</p>}
        <button className="primary full" disabled={!code&&!recoveryCode}>Zwei-Faktor-Authentifizierung bestätigen</button>
      </form>
      <p className="security-note">Bewahren Sie die Wiederherstellungscodes offline auf. Sie werden nach dieser Ansicht nicht erneut angezeigt.</p>
    </section>
  </main>;
}
