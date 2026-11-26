import {FormEvent,useEffect,useState} from 'react';
import {api,AuthenticatedDevice,AuthenticatedSession,hasPermission,storedUser} from '../lib/api';
import {formatDateTime} from '../lib/format';
import {roleLabel,statusLabel} from '../lib/status';
import {auditEventLabel,commonText} from '../lib/text';
import {isReason} from '../lib/validation';

type Audit={id:string;event_type:string;actor_email:string|null;created_at:string;details:Record<string,unknown>};
type Provider={provider:'smtp'|'sms'|'timescan';status:'not_configured'|'configured'|'verified'|'failed';message:string;checked_at:string};
type Target={id:string;name:string;target_kind:string;config:Record<string,unknown>;secret_ref:string|null;enabled:boolean;last_status:string;created_at:string;updated_at:string};
type BackupStatus={
  worker:{running:boolean};
  settings:{enabled:boolean;schedule_kind:string;schedule_time:string;schedule_timezone:string;retention_count:number|null;retention_days:number|null;last_status:string;last_run_at:string|null;last_success_at:string|null}|null;
  runs:{id:string;started_at:string;completed_at:string|null;status:string;error_message:string|null;successful_targets:number}[];
  targets:Target[];
};
type NotificationRule={id:string;role:string|null;user_id:string|null;event_type:string;channel:string;recipient:string|null;enabled:boolean};
type ProviderSettings={
  providers:Array<{provider:'smtp'|'sms';config:Record<string,unknown>;secret_ref:string|null;enabled:boolean}>;
  timescan:{base_url:string;account_ref:string;secret_ref:string;enabled:boolean}|null;
};

const initialSchedule={
  enabled:false,
  schedule_kind:'daily',
  schedule_time:'02:00',
  schedule_weekday:null as number|null,
  schedule_timezone:'UTC',
  retention_count:null as number|null,
  retention_days:null as number|null,
};
const inputStyle={minWidth:'12rem'};

const providerNames:Record<string,string>={smtp:'E-Mail (SMTP)',sms:'SMS-Gateway',timescan:'TimeScan'};
const targetKinds:Record<string,string>={local:'Lokales Verzeichnis',smb:'SMB/CIFS',sftp:'SFTP',s3:'S3/MinIO'};
const eventNames:Record<string,string>={'backup.failed':'Fehlgeschlagene Sicherung','backup.succeeded':'Erfolgreiche Sicherung'};

export function Admin(){
  const user=storedUser();
  const admin=Boolean(user&&(user.role==='admin'||user.role==='superadmin'));
  const [items,setItems]=useState<Audit[]>([]);
  const [backupStatus,setBackupStatus]=useState<BackupStatus|null>(null);
  const [providers,setProviders]=useState<Provider[]>([]);
  const [devices,setDevices]=useState<AuthenticatedDevice[]>([]);
  const [sessions,setSessions]=useState<AuthenticatedSession[]>([]);
  const [schedule,setSchedule]=useState(initialSchedule);
  const [targets,setTargets]=useState<Target[]>([]);
  const [reason,setReason]=useState('');
  const [targetReason,setTargetReason]=useState('');
  const [ruleReason,setRuleReason]=useState('');
  const [smtpReason,setSmtpReason]=useState('');
  const [smsReason,setSmsReason]=useState('');
  const [timescanReason,setTimescanReason]=useState('');
  const [smtp,setSmtp]=useState({host:'',port:'587',user:'',from:'',tls:true,secret_ref:''});
  const [sms,setSms]=useState({url:'',secret_ref:''});
  const [timescan,setTimescan]=useState({base_url:'',account_ref:'',secret_ref:'',enabled:true});
  const [target,setTarget]=useState({name:'',target_kind:'local',root:'',endpoint:'',bucket:'',prefix:'',host:'',port:'22',remotePath:'',secret_ref:''});
  const [rules,setRules]=useState<NotificationRule[]>([]);
  const [error,setError]=useState('');

  const load=async()=>{
    try{
      const [audit,status,providerStatus,providerSettings,notificationRules,deviceList,sessionList]=await Promise.all([
        api<Audit[]>('/audit'),
        hasPermission('backup:read')?api<BackupStatus>('/backups/status'):Promise.resolve(null),
        hasPermission('settings:read')?api<{providers:Provider[]}>('/settings/providers/status'):Promise.resolve({providers:[]}),
        hasPermission('settings:read')?api<ProviderSettings>('/settings/providers'):Promise.resolve({providers:[],timescan:null} as ProviderSettings),
        hasPermission('settings:read')?api<NotificationRule[]>('/settings/backup-notifications'):Promise.resolve([]),
        hasPermission('authenticated_devices:read')?api<AuthenticatedDevice[]>('/auth/devices'):Promise.resolve([]),
        hasPermission('authenticated_sessions:read')?api<AuthenticatedSession[]>('/auth/sessions'):Promise.resolve([]),
      ]);
      const safeStatus=status&&typeof status==='object'?status:null;
      const safeProviderSettings=providerSettings&&typeof providerSettings==='object'?providerSettings:{providers:[],timescan:null};
      setItems(Array.isArray(audit)?audit:[]);
      setBackupStatus(safeStatus);
      setTargets(Array.isArray(safeStatus?.targets)?safeStatus.targets:[]);
      setProviders(Array.isArray(providerStatus?.providers)?providerStatus.providers:[]);
      setRules(Array.isArray(notificationRules)?notificationRules:[]);
      setDevices(Array.isArray(deviceList)?deviceList:[]);
      setSessions(Array.isArray(sessionList)?sessionList:[]);
      const persisted=safeProviderSettings.providers||[];
      const smtpConfig=persisted.find(item=>item.provider==='smtp');
      const smsConfig=persisted.find(item=>item.provider==='sms');
      if(smtpConfig)setSmtp({
        host:String(smtpConfig.config.host||''),
        port:String(smtpConfig.config.port||587),
        user:String(smtpConfig.config.user||''),
        from:String(smtpConfig.config.from||''),
        tls:Boolean(smtpConfig.config.tls??true),
        secret_ref:smtpConfig.secret_ref||'',
      });
      if(smsConfig)setSms({url:String(smsConfig.config.url||''),secret_ref:smsConfig.secret_ref||''});
      if(safeProviderSettings.timescan)setTimescan(safeProviderSettings.timescan);
      if(safeStatus?.settings)setSchedule({
        enabled:Boolean(safeStatus.settings.enabled),
        schedule_kind:safeStatus.settings.schedule_kind==='weekly'?'weekly':'daily',
        schedule_time:String(safeStatus.settings.schedule_time||'02:00').slice(0,5),
        schedule_weekday:(safeStatus.settings as BackupStatus['settings'] & {schedule_weekday?:number|null}).schedule_weekday??null,
        schedule_timezone:String(safeStatus.settings.schedule_timezone||'UTC'),
        retention_count:safeStatus.settings.retention_count??null,
        retention_days:safeStatus.settings.retention_days??null,
      });
    }catch(cause){setError((cause as Error).message);}
  };

  useEffect(()=>{void load();},[]);

  async function saveSchedule(event:FormEvent){
    event.preventDefault();
    if(!isReason(reason)){setError(commonText.reasonRequired);return;}
    try{
      await api('/settings/backups',{method:'PUT',body:JSON.stringify({...schedule,reason})});
      setError('');
      setReason('');
      await load();
    }catch(cause){setError((cause as Error).message);}
  }

  async function saveProvider(provider:'smtp'|'sms'){
    const currentReason=provider==='smtp'?smtpReason:smsReason;
    const secretRef=(provider==='smtp'?smtp.secret_ref:sms.secret_ref).trim();
    if(!isReason(currentReason)){setError(commonText.reasonRequired);return;}
    if(provider==='sms'&&!secretRef){setError('Für den SMS-Versand ist eine Schlüsselreferenz erforderlich.');return;}
    try{
      const config=provider==='smtp'
        ?{host:smtp.host,port:Number(smtp.port),user:smtp.user,from:smtp.from,tls:smtp.tls}
        :{url:sms.url};
      await api(`/settings/providers/${provider}`,{method:'PUT',body:JSON.stringify({
        config,...(secretRef?{secret_ref:secretRef}:{}),enabled:true,reason:currentReason,
      })});
      setError('');
      if(provider==='smtp')setSmtpReason('');else setSmsReason('');
      await load();
    }catch(cause){setError((cause as Error).message);}
  }

  async function saveTimescan(){
    if(!/^[A-Z0-9_]+$/.test(timescan.secret_ref.trim())){
      setError('Die TimeScan-Schlüsselreferenz darf nur Großbuchstaben, Ziffern und Unterstriche enthalten.');
      return;
    }
    if(!isReason(timescanReason)){setError(commonText.reasonRequired);return;}
    try{
      await api('/timescan/config',{method:'POST',body:JSON.stringify({...timescan,reason:timescanReason})});
      setError('');
      setTimescanReason('');
      await load();
    }catch(cause){setError((cause as Error).message);}
  }

  async function addTarget(event:FormEvent){
    event.preventDefault();
    if(!isReason(targetReason)){setError(commonText.reasonRequired);return;}
    const secretRef=target.secret_ref.trim();
    if(target.target_kind!=='local'&&!secretRef){setError('Für dieses Sicherungsziel ist eine Schlüsselreferenz erforderlich.');return;}
    try{
      const {name,target_kind,secret_ref:_secretRef,...config}=target;
      await api('/backups/targets',{method:'POST',body:JSON.stringify({
        name,target_kind,config,secret_ref:secretRef||undefined,enabled:true,reason:targetReason,
      })});
      setTarget({...target,name:'',root:'',endpoint:'',bucket:'',prefix:'',host:'',port:'22',remotePath:'',secret_ref:''});
      setError('');
      setTargetReason('');
      await load();
    }catch(cause){setError((cause as Error).message);}
  }

  async function addRule(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(!isReason(ruleReason)){setError(commonText.reasonRequired);return;}
    const form=new FormData(event.currentTarget);
    try{
      await api('/settings/backup-notifications',{method:'PUT',body:JSON.stringify({
        event_type:String(form.get('event_type')),
        role:String(form.get('role')),
        channel:String(form.get('channel')),
        recipient:String(form.get('recipient')||'')||undefined,
        enabled:true,
        reason:ruleReason,
      })});
      event.currentTarget.reset();
      setError('');
      setRuleReason('');
      await load();
    }catch(cause){setError((cause as Error).message);}
  }

  async function revoke(id:string){
    if(!window.confirm('Dieses Vertrauensgerät und alle zugehörigen Sitzungen widerrufen?'))return;
    try{await api(`/auth/devices/${id}/revoke`,{method:'POST'});await load();}
    catch(cause){setError((cause as Error).message);}
  }

  async function revokeSession(id:string){
    if(!window.confirm('Diese Sitzung widerrufen?'))return;
    try{await api(`/auth/sessions/${id}/revoke`,{method:'POST'});await load();}
    catch(cause){setError((cause as Error).message);}
  }

  if(!admin){
    return <section><h1>Administration</h1><p>Diese Seite ist nur für Administratoren verfügbar.</p></section>;
  }

  const settings=backupStatus?.settings;

  return <section>
    <h1>Administration und Einstellungen</h1>
    <p>Systemweite Einstellungen, Sicherungen, Schnittstellen und Audit-Nachweise verwalten.</p>
    {error&&<p role="alert">{error}</p>}
    <p><a href="/api/v1/audit/export" target="_blank" rel="noreferrer">Auditprotokoll als CSV-Datei exportieren</a></p>

    <h2>Sicherungszeitplan</h2>
    <p>Legen Sie fest, wann Sicherungen erstellt werden und wie lange sie aufbewahrt werden.</p>
    {hasPermission('settings:write')&&<form onSubmit={saveSchedule}>
      <label><input type="checkbox" checked={schedule.enabled} onChange={event=>setSchedule({...schedule,enabled:event.target.checked})}/> Zeitplan aktiviert</label>
      <label>Rhythmus
        <select value={schedule.schedule_kind} onChange={event=>setSchedule({
          ...schedule,
          schedule_kind:event.target.value,
          schedule_weekday:event.target.value==='weekly'?schedule.schedule_weekday:null,
        })}>
          <option value="daily">Täglich</option>
          <option value="weekly">Wöchentlich</option>
        </select>
      </label>
      {schedule.schedule_kind==='weekly'&&<label>Wochentag
        <select required value={schedule.schedule_weekday??''} onChange={event=>setSchedule({
          ...schedule,
          schedule_weekday:event.target.value===''?null:Number(event.target.value),
        })}>
          <option value="" disabled>Bitte wählen</option>
          <option value="1">Montag</option><option value="2">Dienstag</option>
          <option value="3">Mittwoch</option><option value="4">Donnerstag</option>
          <option value="5">Freitag</option><option value="6">Samstag</option>
          <option value="0">Sonntag</option>
        </select>
      </label>}
      <label>Uhrzeit
        <input required type="time" value={schedule.schedule_time} onChange={event=>setSchedule({...schedule,schedule_time:event.target.value})}/>
      </label>
      <label>Zeitzone
        <input required style={inputStyle} value={schedule.schedule_timezone} onChange={event=>setSchedule({...schedule,schedule_timezone:event.target.value})}/>
      </label>
      <label>Anzahl aufzubewahrender Sicherungen
        <input type="number" min="1" value={schedule.retention_count??''} onChange={event=>setSchedule({...schedule,retention_count:event.target.value?Number(event.target.value):null})}/>
      </label>
      <label>Aufbewahrungsdauer in Tagen
        <input type="number" min="1" value={schedule.retention_days??''} onChange={event=>setSchedule({...schedule,retention_days:event.target.value?Number(event.target.value):null})}/>
      </label>
      <label>{commonText.changeReason}
        <input required minLength={3} value={reason} onChange={event=>setReason(event.target.value)} placeholder="Grund für die Änderung"/>
      </label>
      <button type="submit">Zeitplan speichern</button>
    </form>}

    {backupStatus&&<>
      <p>
        Sicherungsdienst: {statusLabel(backupStatus.worker?.running?'running':'inactive')}
        {' · '}Letzter Lauf: {formatDateTime(settings?.last_run_at)}
        {' · '}Ergebnis: {statusLabel(settings?.last_status)}
      </p>
      <h3>Sicherungsziele</h3>
      {hasPermission('backup:manage')&&<form onSubmit={addTarget}>
        <label>Bezeichnung
          <input required placeholder="Name des Ziels" value={target.name} onChange={event=>setTarget({...target,name:event.target.value})}/>
        </label>
        <label>Zieltyp
          <select value={target.target_kind} onChange={event=>setTarget({...target,target_kind:event.target.value})}>
            {Object.entries(targetKinds).map(([value,label])=><option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        {target.target_kind==='local'
          ? <label>Lokales Verzeichnis
              <input placeholder="Pfad zum Sicherungsverzeichnis" value={target.root} onChange={event=>setTarget({...target,root:event.target.value})}/>
            </label>
          : <label>Zieladresse
              <input placeholder="Adresse des Sicherungsziels" value={target.endpoint} onChange={event=>setTarget({...target,endpoint:event.target.value})}/>
            </label>}
        {target.target_kind==='s3'&&<label>Bucketname
          <input placeholder="Name des Buckets" value={target.bucket} onChange={event=>setTarget({...target,bucket:event.target.value})}/>
        </label>}
        <label>Hostname
          <input placeholder="Hostname oder IP-Adresse" value={target.host} onChange={event=>setTarget({...target,host:event.target.value})}/>
        </label>
        <label>Portnummer
          <input placeholder="Portnummer" value={target.port} onChange={event=>setTarget({...target,port:event.target.value})}/>
        </label>
        <label>Schlüsselreferenz
          <input placeholder="Referenz auf den Zugriffsschlüssel" required={target.target_kind!=='local'} value={target.secret_ref} onChange={event=>setTarget({...target,secret_ref:event.target.value})}/>
        </label>
        <label>{commonText.changeReason}
          <input required minLength={3} value={targetReason} onChange={event=>setTargetReason(event.target.value)} placeholder="Grund für die Änderung"/>
        </label>
        <button type="submit">Sicherungsziel hinzufügen</button>
      </form>}
      {targets.length===0
        ? <p>Keine Sicherungsziele konfiguriert.</p>
        : <ul>{targets.map(item=><li key={item.id}>
            <strong>{item.name}</strong> · {targetKinds[item.target_kind]??item.target_kind}
            {' · '}{statusLabel(item.enabled?'enabled':'disabled')}
            {' · '}Letzter Zielstatus: {statusLabel(item.last_status)}
            {' · '}{item.secret_ref?'Schlüsselreferenz hinterlegt':'Keine Schlüsselreferenz hinterlegt'}
          </li>)}</ul>}
      <h3>Verlauf</h3>
      {(backupStatus.runs||[]).length===0
        ? <p>Noch keine Sicherungen durchgeführt.</p>
        : <ul>{(backupStatus.runs||[]).map(run=><li key={run.id}>
            {formatDateTime(run.started_at)} · {statusLabel(run.status)}
            {' · '}Erfolgreiche Ziele: {run.successful_targets}
            {run.error_message&&` · Fehler: ${run.error_message}`}
          </li>)}</ul>}
    </>}

    <h2>Benachrichtigungsanbieter</h2>
    <p>Verbindungsstatus der externen Dienste für Benachrichtigungen und Zeitdaten.</p>
    {providers.length===0
      ? <p>Keine Anbieter konfiguriert.</p>
      : <ul>{providers.map(provider=><li key={provider.provider}>
          <strong>{providerNames[provider.provider]??provider.provider}</strong>:
          {' '}<span data-testid={`provider-${provider.provider}`}>{statusLabel(provider.status)}</span>
          {' — '}{provider.message}
          {' · '}Geprüft am {formatDateTime(provider.checked_at)}
        </li>)}</ul>}

    {hasPermission('settings:write')&&<>
      <h3>E-Mail-Versand (SMTP)</h3>
      <form onSubmit={event=>{event.preventDefault();void saveProvider('smtp');}}>
        <label>Hostname<input placeholder="Hostname des SMTP-Servers" value={smtp.host} onChange={event=>setSmtp({...smtp,host:event.target.value})}/></label>
        <label>Portnummer<input type="number" placeholder="Portnummer" value={smtp.port} onChange={event=>setSmtp({...smtp,port:event.target.value})}/></label>
        <label>Benutzername<input placeholder="Benutzername für den SMTP-Server" value={smtp.user} onChange={event=>setSmtp({...smtp,user:event.target.value})}/></label>
        <label>Absenderadresse<input placeholder="absender@unternehmen.de" value={smtp.from} onChange={event=>setSmtp({...smtp,from:event.target.value})}/></label>
        <label>Schlüsselreferenz<input placeholder="Referenz auf den Zugriffsschlüssel" value={smtp.secret_ref} onChange={event=>setSmtp({...smtp,secret_ref:event.target.value})}/></label>
        <label>{commonText.changeReason}
          <input required minLength={3} value={smtpReason} onChange={event=>setSmtpReason(event.target.value)} placeholder="Grund für die Änderung"/>
        </label>
        <button type="submit">E-Mail-Einstellungen speichern</button>
      </form>
      <h3>SMS-Gateway</h3>
      <form onSubmit={event=>{event.preventDefault();void saveProvider('sms');}}>
        <label>Adresse der Schnittstelle<input placeholder="URL des SMS-Gateways" value={sms.url} onChange={event=>setSms({...sms,url:event.target.value})}/></label>
        <label>Schlüsselreferenz<input placeholder="Referenz auf den Zugriffsschlüssel" required value={sms.secret_ref} onChange={event=>setSms({...sms,secret_ref:event.target.value})}/></label>
        <label>{commonText.changeReason}
          <input required minLength={3} value={smsReason} onChange={event=>setSmsReason(event.target.value)} placeholder="Grund für die Änderung"/>
        </label>
        <button type="submit">SMS-Einstellungen speichern</button>
      </form>

      <h2>TimeScan-Integration</h2>
      <p>TimeScan ist Bestandteil der SecurityOps-Plattform. Hier wird ausschließlich die Verbindung zur vorhandenen TimeScan-Quelle konfiguriert; Arbeitszeiten werden anschließend über die integrierte Synchronisation übernommen.</p>
      {providers.find(provider=>provider.provider==='timescan')&&<p>
        Status: <strong>{statusLabel(providers.find(provider=>provider.provider==='timescan')?.status)}</strong>
        {' — '}{providers.find(provider=>provider.provider==='timescan')?.message}
      </p>}
      <h3>Verbindung</h3>
      <form onSubmit={event=>{event.preventDefault();void saveTimescan();}}>
        <label>Basisadresse<input placeholder="URL der TimeScan-Installation" value={timescan.base_url} onChange={event=>setTimescan({...timescan,base_url:event.target.value})}/></label>
        <label>Konto<input placeholder="Kontoreferenz bei TimeScan" value={timescan.account_ref} onChange={event=>setTimescan({...timescan,account_ref:event.target.value})}/></label>
        <label>Schlüsselreferenz<input placeholder="Referenz auf den Zugriffsschlüssel" value={timescan.secret_ref} onChange={event=>setTimescan({...timescan,secret_ref:event.target.value})}/></label>
        <label>{commonText.changeReason}
          <input required minLength={3} value={timescanReason} onChange={event=>setTimescanReason(event.target.value)} placeholder="Grund für die Änderung"/>
        </label>
        <button type="submit">TimeScan-Verbindung speichern</button>
      </form>

      <h2>Benachrichtigungen zu Sicherungen</h2>
      <p>Legen Sie fest, welche Ereignisse an welche Empfänger gemeldet werden.</p>
      <form onSubmit={addRule}>
        <label>Ereignis
          <select name="event_type">
            {Object.entries(eventNames).map(([value,label])=><option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label>Rolle
          <select name="role">
            <option value="admin">Administratoren</option>
            <option value="operator">Disponenten</option>
            <option value="viewer">Betrachter</option>
          </select>
        </label>
        <label>Kanal
          <select name="channel">
            <option value="in_app">In-App</option>
            <option value="email">E-Mail</option>
            <option value="sms">SMS</option>
          </select>
        </label>
        <label>Empfänger<input name="recipient" placeholder="E-Mail-Adresse oder Telefonnummer"/></label>
        <label>{commonText.changeReason}
          <input required minLength={3} value={ruleReason} onChange={event=>setRuleReason(event.target.value)} placeholder="Grund für die Änderung"/>
        </label>
        <button type="submit">Benachrichtigungsregel hinzufügen</button>
      </form>
      {rules.length===0
        ? <p>Keine Benachrichtigungsregeln konfiguriert.</p>
        : <ul>{rules.map(rule=><li key={rule.id}>
            {eventNames[rule.event_type]??rule.event_type} · {rule.role?roleLabel(rule.role):rule.user_id??'Einzelner Benutzer'}
            {' · '}{statusLabel(rule.channel,'channel')} · {rule.recipient??'Alle Empfänger der Rolle'}
          </li>)}</ul>}
    </>}

    {devices.length>0&&<>
      <h2>Vertrauensgeräte</h2>
      <ul>{devices.map(device=><li key={device.id}>
        <strong>{device.name}</strong> · {device.revoked_at?'Widerrufen':'Aktiv'}
        {!device.revoked_at&&hasPermission('authenticated_devices:write')&&<button onClick={()=>revoke(device.id)}>Widerrufen</button>}
      </li>)}</ul>
    </>}

    {hasPermission('authenticated_sessions:read')&&<>
      <h2>Aktive Sitzungen</h2>
      {sessions.length===0
        ? <p>Keine Sitzungen vorhanden.</p>
        : <ul>{sessions.map(session=><li key={session.id}>
            <strong>{session.email}</strong> · {roleLabel(session.role)} · {session.device_name}
            {' · '}{String(session.metadata.platform||'Unbekannte Plattform')}
            {' · '}Erstellt am {formatDateTime(session.created_at)}
            {' · '}{session.revoked_at?'Widerrufen':session.expires_at&&new Date(session.expires_at).getTime()<Date.now()?'Abgelaufen':'Aktiv'}
            {!session.revoked_at&&hasPermission('authenticated_sessions:write')&&<button onClick={()=>revokeSession(session.id)}>Sitzung widerrufen</button>}
          </li>)}</ul>}
    </>}

    <h2>Auditprotokoll</h2>
    {items.length===0
      ? <p>Keine Audit-Einträge vorhanden.</p>
      : <ul>{items.slice(0,20).map(item=><li key={item.id}>
          {formatDateTime(item.created_at)} · {auditEventLabel(item.event_type)}
        </li>)}</ul>}
  </section>;
}
